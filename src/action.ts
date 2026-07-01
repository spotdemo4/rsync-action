import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
type DebianArch = "amd64" | "arm64";

interface DebianPackage {
  binaryPackage: string;
  cacheName: string;
  debVersion: string;
  poolPath: string;
}

const DEBIAN_REPOSITORY_URL = "https://deb.debian.org/debian/pool/main";

export const DEBIAN_PACKAGES = {
  openssl: {
    binaryPackage: "openssl",
    cacheName: "debian-openssl",
    // renovate: datasource=custom.debian-pool depName=openssl packageName=o/openssl
    debVersion: "4.0.1-1",
    poolPath: "o/openssl",
  },
  rsync: {
    binaryPackage: "rsync",
    cacheName: "debian-rsync",
    // renovate: datasource=custom.debian-pool depName=rsync packageName=r/rsync
    debVersion: "3.4.4+ds1-1",
    poolPath: "r/rsync",
  },
} satisfies Record<string, DebianPackage>;

export function debianPackageUrl(
  packageName: keyof typeof DEBIAN_PACKAGES,
  debianArch: DebianArch,
): string {
  const debianPackage = DEBIAN_PACKAGES[packageName];

  return `${DEBIAN_REPOSITORY_URL}/${debianPackage.poolPath}/${debianPackage.binaryPackage}_${debianPackage.debVersion}_${debianArch}.deb`;
}

export function debianArchForNodeArch(nodeArch: NodeJS.Architecture): DebianArch | undefined {
  if (nodeArch === "arm64") {
    return "arm64";
  }

  if (nodeArch === "x64") {
    return "amd64";
  }
}

export function debianToolCacheVersion(packageName: keyof typeof DEBIAN_PACKAGES): string {
  return DEBIAN_PACKAGES[packageName].debVersion.replace(/[+~]/g, "-");
}

const TOOL_PACKAGES: Record<string, keyof typeof DEBIAN_PACKAGES> = {
  openssl: "openssl",
  rsync: "rsync",
  "rsync-ssl": "rsync",
};

function tarFlagsForArchive(name: string): string | string[] {
  if (name.endsWith(".tar.gz")) {
    return "xz";
  }

  if (name.endsWith(".tar.xz")) {
    return "xJ";
  }

  if (name.endsWith(".tar.zst")) {
    return ["--zstd", "-x"];
  }

  throw new Error(`Unsupported Debian package data archive: ${name}`);
}

async function extractDebianPackage(debPath: string): Promise<string> {
  const archive = await readFile(debPath);

  if (archive.subarray(0, 8).toString("utf8") !== "!<arch>\n") {
    throw new Error("Downloaded Debian package is not an ar archive.");
  }

  let offset = 8;

  while (offset + 60 <= archive.length) {
    const header = archive.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString("utf8").trim().replace(/\/$/, "");
    const size = Number.parseInt(header.subarray(48, 58).toString("utf8").trim(), 10);

    if (header.subarray(58, 60).toString("utf8") !== "`\n" || !Number.isFinite(size)) {
      throw new Error("Downloaded Debian package has an invalid ar member header.");
    }

    const dataStart = offset + 60;
    const dataEnd = dataStart + size;

    if (dataEnd > archive.length) {
      throw new Error("Downloaded Debian package has a truncated ar member.");
    }

    if (name.startsWith("data.tar")) {
      const tempDir = await mkdtemp(path.join(tmpdir(), "rsync-action-deb-"));
      const dataArchive = path.join(tempDir, name);
      await writeFile(dataArchive, archive.subarray(dataStart, dataEnd));

      return tc.extractTar(dataArchive, path.join(tempDir, "data"), tarFlagsForArchive(name));
    }

    offset = dataEnd + (size % 2);
  }

  throw new Error("Downloaded Debian package does not contain a data.tar archive.");
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
): string[] {
  const remote = buildRemoteSpec({ ...inputs, username: auth.username });
  const endpoints = direction === "pull" ? [remote, inputs.localPath] : [inputs.localPath, remote];
  const args = [...inputs.rsyncArgs, ...endpoints];

  return inputs.tls ? ["--type=openssl", ...args] : args;
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

export function requiredTools(tls: boolean): string[] {
  return tls ? ["rsync", "rsync-ssl", "openssl"] : ["rsync"];
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

async function ensureTool(tool: string): Promise<string> {
  const fromPath = await io.which(tool, false);

  if (fromPath) {
    core.info(`Found ${tool} at ${fromPath}`);
    return fromPath;
  }

  const debianPackage = DEBIAN_PACKAGES[TOOL_PACKAGES[tool]];
  const cacheVersion = debianToolCacheVersion(TOOL_PACKAGES[tool]);
  const cachedDir = tc.find(debianPackage.cacheName, cacheVersion, process.arch);

  if (cachedDir) {
    core.addPath(path.join(cachedDir, "usr/bin"));

    const fromCache = await io.which(tool, false);
    if (fromCache) {
      core.info(`Found ${tool} in the Actions tool cache`);
      return fromCache;
    }
  }

  const debianArch = debianArchForNodeArch(process.arch);

  if (process.platform !== "linux" || !debianArch) {
    throw new Error(
      `Could not find ${tool} in PATH or the Actions tool cache. Built-in Debian downloads support Linux x64 and Linux arm64 runners only.`,
    );
  }

  const packageName = TOOL_PACKAGES[tool];
  const packageUrl = debianPackageUrl(packageName, debianArch);
  core.info(`Downloading ${tool} from ${packageUrl}`);
  const downloaded = await tc.downloadTool(packageUrl);
  const extracted = await extractDebianPackage(downloaded);
  const binDir = path.join(extracted, "usr/bin");

  for (const executable of ["rsync", "rsync-ssl", "openssl"]) {
    if (TOOL_PACKAGES[executable] === TOOL_PACKAGES[tool]) {
      await chmod(path.join(binDir, executable), 0o755);
    }
  }

  const cacheDir = await tc.cacheDir(
    extracted,
    debianPackage.cacheName,
    cacheVersion,
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
