import { chmod } from "node:fs/promises";
import path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";

const READY_STATE = "rsync-action-ready";
const POST_STATE = "rsync-action-post";

type SyncDirection = "pull" | "push";

export interface ActionInputs {
  server: string;
  module: string;
  remotePath: string;
  localPath: string;
  secret: string;
  tls: boolean;
  rsyncArgs: string[];
  toolVersion: string;
  downloadUrls: Record<string, string>;
}

interface Auth {
  username: string;
  password: string;
}

type ToolPaths = Record<string, string>;

export function parseSecret(secret: string): Auth {
  const separator = secret.indexOf(":");

  if (separator <= 0 || separator === secret.length - 1) {
    throw new Error("Input 'secret' must use the username:password format.");
  }

  return {
    username: secret.slice(0, separator),
    password: secret.slice(separator + 1),
  };
}

export function buildRemoteSpec(
  input: Pick<ActionInputs, "server" | "module" | "remotePath"> & Pick<Auth, "username">,
): string {
  const server = input.server.trim();
  const module = input.module.trim().replace(/^\/+|\/+$/g, "");
  const remotePath = input.remotePath.replace(/^\/+/, "");

  if (!server) {
    throw new Error("Input 'server' is required.");
  }

  if (server.includes("://") || server.includes("/")) {
    throw new Error("Input 'server' must be a daemon host or host:port, not a URL.");
  }

  if (!module || module.includes("/")) {
    throw new Error("Input 'module' must be a single rsync daemon module name.");
  }

  return `rsync://${input.username}@${server}/${module}/${remotePath}`;
}

export function buildRsyncArgs(
  inputs: ActionInputs,
  auth: Auth,
  direction: SyncDirection,
): string[] {
  const remote = buildRemoteSpec({ ...inputs, username: auth.username });
  const endpoints = direction === "pull" ? [remote, inputs.localPath] : [inputs.localPath, remote];
  const args = [...inputs.rsyncArgs, ...endpoints];

  return inputs.tls ? ["--type=openssl", ...args] : args;
}

export function requiredTools(tls: boolean): string[] {
  return tls ? ["rsync", "rsync-ssl", "openssl"] : ["rsync"];
}

function getInputs(): ActionInputs {
  const downloadUrls: Record<string, string> = {};

  for (const tool of ["rsync", "rsync-ssl", "openssl"]) {
    downloadUrls[tool] = core.getInput(`${tool}-download-url`);
  }

  return {
    server: core.getInput("server", { required: true }),
    module: core.getInput("module", { required: true }),
    remotePath: core.getInput("remote-path"),
    localPath: core.getInput("local-path", { required: true }),
    secret: core.getInput("secret", { required: true }),
    tls: core.getBooleanInput("tls"),
    rsyncArgs: core.getMultilineInput("rsync-args"),
    toolVersion: core.getInput("tool-version") || "1.0.0",
    downloadUrls,
  };
}

function executableName(tool: string): string {
  return process.platform === "win32" ? `${tool}.exe` : tool;
}

async function ensureTool(tool: string, version: string, downloadUrl: string): Promise<string> {
  const fromPath = await io.which(tool, false);

  if (fromPath) {
    core.info(`Found ${tool} at ${fromPath}`);
    return fromPath;
  }

  const cachedDir = tc.find(tool, version);

  if (cachedDir) {
    core.addPath(cachedDir);

    const fromCache = await io.which(tool, false);
    if (fromCache) {
      core.info(`Found ${tool} in the Actions tool cache`);
      return fromCache;
    }
  }

  if (!downloadUrl) {
    throw new Error(
      `Could not find ${tool} in PATH or the Actions tool cache. Set '${tool}-download-url' to a directly downloadable executable.`,
    );
  }

  core.info(`Downloading ${tool}`);
  const downloaded = await tc.downloadTool(downloadUrl);
  await chmod(downloaded, 0o755);

  const cacheDir = await tc.cacheFile(downloaded, executableName(tool), tool, version);
  const cachedTool = path.join(cacheDir, executableName(tool));
  await chmod(cachedTool, 0o755);
  core.addPath(cacheDir);

  return cachedTool;
}

async function ensureTools(inputs: ActionInputs): Promise<ToolPaths> {
  const tools: ToolPaths = {};

  for (const tool of requiredTools(inputs.tls)) {
    tools[tool] = await ensureTool(tool, inputs.toolVersion, inputs.downloadUrls[tool] ?? "");
  }

  return tools;
}

async function mkdirLocalParent(localPath: string): Promise<void> {
  const parent = path.dirname(path.resolve(localPath));

  if (parent !== path.resolve(".")) {
    await io.mkdirP(parent);
  }
}

function rsyncEnv(auth: Auth, tools: ToolPaths): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.RSYNC_PASSWORD = auth.password;

  if (tools.openssl) {
    env.RSYNC_SSL_OPENSSL = tools.openssl;
  }

  return env;
}

async function sync(
  direction: SyncDirection,
  inputs: ActionInputs,
  auth: Auth,
  tools: ToolPaths,
): Promise<void> {
  if (direction === "pull") {
    await mkdirLocalParent(inputs.localPath);
  }

  const command = inputs.tls ? tools["rsync-ssl"] : tools.rsync;
  const exitCode = await exec.exec(command, buildRsyncArgs(inputs, auth, direction), {
    env: rsyncEnv(auth, tools),
  });

  if (exitCode !== 0) {
    throw new Error(`${direction} rsync exited with code ${exitCode}.`);
  }
}

export async function runAction(): Promise<void> {
  if (core.getState(POST_STATE) !== "true") {
    core.saveState(POST_STATE, "true");

    const inputs = getInputs();
    const auth = parseSecret(inputs.secret);
    core.setSecret(inputs.secret);
    core.setSecret(auth.username);
    core.setSecret(auth.password);

    const tools = await ensureTools(inputs);
    core.info("Pulling from the rsync daemon");
    await sync("pull", inputs, auth, tools);
    core.saveState(READY_STATE, "true");
    return;
  }

  if (core.getState(READY_STATE) !== "true") {
    core.info("Skipping push because the pull did not complete.");
    return;
  }

  const inputs = getInputs();
  const auth = parseSecret(inputs.secret);
  core.setSecret(inputs.secret);
  core.setSecret(auth.username);
  core.setSecret(auth.password);

  const tools = await ensureTools(inputs);
  core.info("Pushing to the rsync daemon");
  await sync("push", inputs, auth, tools);
}
