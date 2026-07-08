import { chmod } from "node:fs/promises";
import path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";

import { createTlsHelper } from "./tls.ts";

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

interface ToolPaths {
  rsync: string;
  tlsHelper?: string;
}
type StaticRsyncAsset = "aarch64-unknown-linux-musl" | "x86_64-unknown-linux-musl";

interface StaticRsyncRelease {
  cacheName: string;
  owner: string;
  repo: string;
  version: string;
}

export const STATIC_RSYNC_RELEASE = {
  cacheName: "static-rsync",
  owner: "spotdemo4",
  repo: "rsync-action",
  // renovate: datasource=github-releases depName=rsync packageName=spotdemo4/rsync-action
  version: "3.4.4",
} satisfies StaticRsyncRelease;

export function staticRsyncReleaseTag(version = STATIC_RSYNC_RELEASE.version): string {
  return `rsync-v${version}`;
}

export function staticRsyncAssetForNodeArch(
  nodeArch: NodeJS.Architecture,
): StaticRsyncAsset | undefined {
  if (nodeArch === "arm64") {
    return "aarch64-unknown-linux-musl";
  }

  if (nodeArch === "x64") {
    return "x86_64-unknown-linux-musl";
  }
}

export function staticRsyncUrl(
  asset: StaticRsyncAsset,
  version = STATIC_RSYNC_RELEASE.version,
): string {
  const { owner, repo } = STATIC_RSYNC_RELEASE;

  return `https://github.com/${owner}/${repo}/releases/download/${staticRsyncReleaseTag(version)}/${asset}`;
}

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
  tlsHelper?: string,
): string[] {
  const remote = buildRemoteSpec({ ...inputs, username: auth.username });
  const endpoints = direction === "pull" ? [remote, inputs.localPath] : [inputs.localPath, remote];
  const args = [...inputs.rsyncArgs, ...endpoints];

  if (!inputs.tls) {
    return args;
  }

  if (!tlsHelper) {
    throw new Error("TLS sync requires an rsync remote-shell helper.");
  }

  return [`--rsh=${tlsHelper}`, ...args];
}

export function expandHomePath(localPath: string, home = process.env.HOME): string {
  if (localPath !== "~" && !localPath.startsWith("~/")) {
    return localPath;
  }

  if (!home) {
    throw new Error("Cannot expand input 'local-path' because HOME is not set.");
  }

  return `${home}${localPath.slice(1)}`;
}

function getInputs(): ActionInputs {
  return {
    server: core.getInput("server", { required: true }),
    module: core.getInput("module", { required: true }),
    remotePath: core.getInput("remote-path"),
    localPath: expandHomePath(core.getInput("local-path", { required: true })),
    secret: core.getInput("secret", { required: true }),
    tls: core.getBooleanInput("tls"),
    rsyncArgs: core.getMultilineInput("rsync-args"),
  };
}

async function ensureRsync(): Promise<string> {
  const fromPath = await io.which("rsync", false);

  if (fromPath) {
    core.info(`Found rsync at ${fromPath}`);
    return fromPath;
  }

  const cachedDir = tc.find(
    STATIC_RSYNC_RELEASE.cacheName,
    STATIC_RSYNC_RELEASE.version,
    process.arch,
  );

  if (cachedDir) {
    core.addPath(cachedDir);

    const fromCache = await io.which("rsync", false);
    if (fromCache) {
      core.info("Found rsync in the Actions tool cache");
      return fromCache;
    }
  }

  const staticRsyncAsset = staticRsyncAssetForNodeArch(process.arch);

  if (process.platform !== "linux" || !staticRsyncAsset) {
    throw new Error(
      "Could not find rsync in PATH or the Actions tool cache. Built-in static rsync downloads support Linux x64 and Linux arm64 runners only.",
    );
  }

  const staticRsyncDownloadUrl = staticRsyncUrl(staticRsyncAsset);
  core.info(`Downloading rsync from ${staticRsyncDownloadUrl}`);
  const downloaded = await tc.downloadTool(staticRsyncDownloadUrl);
  await chmod(downloaded, 0o755);

  const cacheDir = await tc.cacheFile(
    downloaded,
    "rsync",
    STATIC_RSYNC_RELEASE.cacheName,
    STATIC_RSYNC_RELEASE.version,
    process.arch,
  );
  const cachedTool = path.join(cacheDir, "rsync");
  await chmod(cachedTool, 0o755);
  core.addPath(cacheDir);

  return cachedTool;
}

async function ensureTools(inputs: ActionInputs): Promise<ToolPaths> {
  const tools: ToolPaths = {
    rsync: await ensureRsync(),
  };

  if (inputs.tls) {
    tools.tlsHelper = await createTlsHelper();
  }

  return tools;
}

async function mkdirLocalParent(localPath: string): Promise<void> {
  const parent = path.dirname(path.resolve(localPath));

  if (parent !== path.resolve(".")) {
    await io.mkdirP(parent);
  }
}

function rsyncEnv(auth: Auth): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.RSYNC_PASSWORD = auth.password;

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

  const exitCode = await exec.exec(
    tools.rsync,
    buildRsyncArgs(inputs, auth, direction, tools.tlsHelper),
    {
      env: rsyncEnv(auth),
    },
  );

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
  core.info("Removing local path");
  await io.rmRF(inputs.localPath);
}
