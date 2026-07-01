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
}

interface Auth {
  username: string;
  password: string;
}

type ToolPaths = Record<string, string>;
type AlpineArch = "aarch64" | "x86_64";

interface AlpinePackage {
  cacheName: string;
  version: string;
  urls: Record<AlpineArch, string>;
}

export const ALPINE_PACKAGES = {
  openssl: {
    cacheName: "alpine-openssl",
    version: "3.5.7",
    urls: {
      aarch64: "https://dl-cdn.alpinelinux.org/alpine/edge/main/aarch64/openssl-3.5.7-r0.apk",
      x86_64: "https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64/openssl-3.5.7-r0.apk",
    },
  },
  rsync: {
    cacheName: "alpine-rsync",
    version: "3.4.4",
    urls: {
      aarch64: "https://dl-cdn.alpinelinux.org/alpine/edge/main/aarch64/rsync-3.4.4-r0.apk",
      x86_64: "https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64/rsync-3.4.4-r0.apk",
    },
  },
} satisfies Record<string, AlpinePackage>;

export function alpineArchForNodeArch(nodeArch: NodeJS.Architecture): AlpineArch | undefined {
  if (nodeArch === "arm64") {
    return "aarch64";
  }

  if (nodeArch === "x64") {
    return "x86_64";
  }
}

const TOOL_PACKAGES: Record<string, keyof typeof ALPINE_PACKAGES> = {
  openssl: "openssl",
  rsync: "rsync",
  "rsync-ssl": "rsync",
};

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
  return {
    server: core.getInput("server", { required: true }),
    module: core.getInput("module", { required: true }),
    remotePath: core.getInput("remote-path"),
    localPath: core.getInput("local-path", { required: true }),
    secret: core.getInput("secret", { required: true }),
    tls: core.getBooleanInput("tls"),
    rsyncArgs: core.getMultilineInput("rsync-args"),
  };
}

async function ensureTool(tool: string): Promise<string> {
  const fromPath = await io.which(tool, false);

  if (fromPath) {
    core.info(`Found ${tool} at ${fromPath}`);
    return fromPath;
  }

  const alpinePackage = ALPINE_PACKAGES[TOOL_PACKAGES[tool]];
  const cachedDir = tc.find(alpinePackage.cacheName, alpinePackage.version, process.arch);

  if (cachedDir) {
    core.addPath(path.join(cachedDir, "usr/bin"));

    const fromCache = await io.which(tool, false);
    if (fromCache) {
      core.info(`Found ${tool} in the Actions tool cache`);
      return fromCache;
    }
  }

  const alpineArch = alpineArchForNodeArch(process.arch);

  if (process.platform !== "linux" || !alpineArch) {
    throw new Error(
      `Could not find ${tool} in PATH or the Actions tool cache. Built-in Alpine downloads support Linux x64 and Linux arm64 runners only.`,
    );
  }

  const packageUrl = alpinePackage.urls[alpineArch];
  core.info(`Downloading ${tool} from ${packageUrl}`);
  const downloaded = await tc.downloadTool(packageUrl);
  const extracted = await tc.extractTar(downloaded);
  const binDir = path.join(extracted, "usr/bin");

  for (const executable of ["rsync", "rsync-ssl", "openssl"]) {
    if (TOOL_PACKAGES[executable] === TOOL_PACKAGES[tool]) {
      await chmod(path.join(binDir, executable), 0o755);
    }
  }

  const cacheDir = await tc.cacheDir(
    extracted,
    alpinePackage.cacheName,
    alpinePackage.version,
    process.arch,
  );
  const cachedTool = path.join(cacheDir, "usr/bin", tool);
  await chmod(cachedTool, 0o755);
  core.addPath(path.join(cacheDir, "usr/bin"));

  return cachedTool;
}

async function ensureTools(inputs: ActionInputs): Promise<ToolPaths> {
  const tools: ToolPaths = {};

  for (const tool of requiredTools(inputs.tls)) {
    tools[tool] = await ensureTool(tool);
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
