import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRemoteSpec,
  buildRsyncArgs,
  expandHomePath,
  parseSecret,
  STATIC_RSYNC_RELEASE,
  staticRsyncAssetForNodeArch,
  staticRsyncReleaseTag,
  staticRsyncUrl,
  type ActionInputs,
} from "../src/action.ts";
import { resolveRsyncTlsPort } from "../src/tls.ts";

function inputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    server: "example.com:873",
    module: "backups",
    remotePath: "project/",
    localPath: "project/",
    secret: "alice:correct-horse:battery-staple",
    tls: false,
    rsyncArgs: ["--archive", "--delete"],
    ...overrides,
  };
}

await test("parses username and password from the first colon", () => {
  assert.deepEqual(parseSecret("alice:correct-horse:battery-staple"), {
    username: "alice",
    password: "correct-horse:battery-staple",
  });
});

await test("rejects malformed secrets", () => {
  assert.throws(() => parseSecret("alice"), /username:password/);
  assert.throws(() => parseSecret(":password"), /username:password/);
  assert.throws(() => parseSecret("alice:"), /username:password/);
});

await test("builds an rsync daemon URL and preserves trailing slashes", () => {
  assert.equal(
    buildRemoteSpec({
      server: "example.com:873",
      module: "/backups/",
      remotePath: "/project/",
      username: "alice",
    }),
    "rsync://alice@example.com:873/backups/project/",
  );
});

await test("builds pull and push argument order", () => {
  const auth = parseSecret("alice:password");

  assert.deepEqual(buildRsyncArgs(inputs(), auth, "pull"), [
    "--archive",
    "--delete",
    "rsync://alice@example.com:873/backups/project/",
    "project/",
  ]);

  assert.deepEqual(buildRsyncArgs(inputs(), auth, "push"), [
    "--archive",
    "--delete",
    "project/",
    "rsync://alice@example.com:873/backups/project/",
  ]);
});

await test("uses the TLS helper as rsync's remote shell", () => {
  const auth = parseSecret("alice:password");

  assert.deepEqual(buildRsyncArgs(inputs({ tls: true }), auth, "pull", "/tmp/rsync-tls-helper"), [
    "--rsh=/tmp/rsync-tls-helper",
    "--archive",
    "--delete",
    "rsync://alice@example.com:873/backups/project/",
    "project/",
  ]);
  assert.throws(() => buildRsyncArgs(inputs({ tls: true }), auth, "pull"), /TLS sync/);
});

await test("resolves rsync TLS ports like rsync-ssl", () => {
  assert.equal(resolveRsyncTlsPort({}), 874);
  assert.equal(resolveRsyncTlsPort({ RSYNC_PORT: "0" }), 874);
  assert.equal(resolveRsyncTlsPort({ RSYNC_PORT: "0", RSYNC_SSL_PORT: "9443" }), 9443);
  assert.equal(resolveRsyncTlsPort({ RSYNC_PORT: "1873", RSYNC_SSL_PORT: "9443" }), 1873);
  assert.throws(() => resolveRsyncTlsPort({ RSYNC_PORT: "invalid" }), /Invalid rsync TLS port/);
});

await test("expands leading tilde local paths", () => {
  assert.equal(expandHomePath("~", "/home/runner"), "/home/runner");
  assert.equal(
    expandHomePath("~/.codex/auth.json", "/home/runner"),
    "/home/runner/.codex/auth.json",
  );
  assert.equal(expandHomePath("project/~file", "/home/runner"), "project/~file");
  assert.throws(() => expandHomePath("~/project", ""), /HOME is not set/);
});

await test("uses the configured static rsync release", () => {
  assert.equal(STATIC_RSYNC_RELEASE.owner, "spotdemo4");
  assert.equal(STATIC_RSYNC_RELEASE.repo, "rsync-action");
  assert.equal(STATIC_RSYNC_RELEASE.version, "3.4.4");
  assert.equal(staticRsyncReleaseTag(), "rsync-v3.4.4");
});

await test("builds GitHub release URLs for static rsync assets", () => {
  assert.equal(
    staticRsyncUrl("x86_64-unknown-linux-musl"),
    "https://github.com/spotdemo4/rsync-action/releases/download/rsync-v3.4.4/x86_64-unknown-linux-musl",
  );
  assert.equal(
    staticRsyncUrl("aarch64-unknown-linux-musl"),
    "https://github.com/spotdemo4/rsync-action/releases/download/rsync-v3.4.4/aarch64-unknown-linux-musl",
  );
});

await test("maps Node architectures to static rsync release assets", () => {
  assert.equal(staticRsyncAssetForNodeArch("x64"), "x86_64-unknown-linux-musl");
  assert.equal(staticRsyncAssetForNodeArch("arm64"), "aarch64-unknown-linux-musl");
  assert.equal(staticRsyncAssetForNodeArch("arm"), undefined);
});
