import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function resolveRsyncTlsPort(
  env: Partial<Pick<NodeJS.ProcessEnv, "RSYNC_PORT" | "RSYNC_SSL_PORT">> = process.env,
): number {
  const portValue =
    env.RSYNC_PORT && env.RSYNC_PORT !== "0" ? env.RSYNC_PORT : env.RSYNC_SSL_PORT || "874";
  const port = Number(portValue);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Invalid rsync TLS port.");
  }

  return port;
}

export async function createTlsHelper(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "rsync-action-tls-"));
  const helper = path.join(tempDir, "rsync-tls-helper");
  const script =
    `#!${process.execPath}
const fs = require("node:fs");
const tls = require("node:tls");

let args = process.argv.slice(2);

if (args[0] === "-l") {
  args = args.slice(2);
}

const [hostname, command, serverFlag, daemonFlag] = args;

if (!hostname || command !== "rsync" || serverFlag !== "--server" || daemonFlag !== "--daemon") {
  console.error("Usage: rsync-tls-helper HOSTNAME rsync --server --daemon .");
  process.exit(1);
}

const rsyncPort = process.env.RSYNC_PORT;
const portValue = rsyncPort && rsyncPort !== "0" ? rsyncPort : process.env.RSYNC_SSL_PORT || "874";
const port = Number(portValue);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("Invalid rsync TLS port.");
  process.exit(1);
}

const options = {
  host: hostname,
  port,
  servername: hostname,
};

if (process.env.RSYNC_SSL_CA_CERT === "") {
  options.rejectUnauthorized = false;
} else if (process.env.RSYNC_SSL_CA_CERT) {
  options.ca = fs.readFileSync(process.env.RSYNC_SSL_CA_CERT);
}

if (process.env.RSYNC_SSL_CERT) {
  options.cert = fs.readFileSync(process.env.RSYNC_SSL_CERT);
}

if (process.env.RSYNC_SSL_KEY) {
  options.key = fs.readFileSync(process.env.RSYNC_SSL_KEY);
}

const socket = tls.connect(options, () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("error", (error) => {
  console.error(` +
    "`rsync TLS connection failed: ${error.message}`" +
    `);
  process.exitCode = 1;
});

socket.on("close", () => {
  process.exit(process.exitCode ?? 0);
});
`;

  await writeFile(helper, script);
  await chmod(helper, 0o755);

  return helper;
}
