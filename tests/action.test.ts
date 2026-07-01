import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRemoteSpec,
  buildRsyncArgs,
  DEBIAN_PACKAGES,
  debianArchForNodeArch,
  debianPackageUrl,
  debianToolCacheVersion,
  expandHomePath,
  parseSecret,
  requiredTools,
  type ActionInputs,
} from "../src/action.ts";

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

await test("forces openssl as the first TLS argument", () => {
  const auth = parseSecret("alice:password");

  assert.deepEqual(buildRsyncArgs(inputs({ tls: true }), auth, "pull"), [
    "--type=openssl",
    "--archive",
    "--delete",
    "rsync://alice@example.com:873/backups/project/",
    "project/",
  ]);
});

await test("requires TLS helpers only when TLS is enabled", () => {
  assert.deepEqual(requiredTools(false), ["rsync"]);
  assert.deepEqual(requiredTools(true), ["rsync", "rsync-ssl", "openssl"]);
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

await test("uses hardcoded Debian package versions for missing tools", () => {
  assert.equal(DEBIAN_PACKAGES.rsync.debVersion, "3.4.4+ds1-1");
  assert.equal(DEBIAN_PACKAGES.openssl.debVersion, "4.0.1-1");
  assert.equal(debianToolCacheVersion("rsync"), "3.4.4-ds1-1");
  assert.equal(debianToolCacheVersion("openssl"), "4.0.1-1");
});

await test("builds Debian package URLs for supported architectures", () => {
  assert.equal(
    debianPackageUrl("rsync", "amd64"),
    "https://deb.debian.org/debian/pool/main/r/rsync/rsync_3.4.4+ds1-1_amd64.deb",
  );
  assert.equal(
    debianPackageUrl("openssl", "amd64"),
    "https://deb.debian.org/debian/pool/main/o/openssl/openssl_4.0.1-1_amd64.deb",
  );
  assert.equal(
    debianPackageUrl("rsync", "arm64"),
    "https://deb.debian.org/debian/pool/main/r/rsync/rsync_3.4.4+ds1-1_arm64.deb",
  );
  assert.equal(
    debianPackageUrl("openssl", "arm64"),
    "https://deb.debian.org/debian/pool/main/o/openssl/openssl_4.0.1-1_arm64.deb",
  );
});

await test("maps Node architectures to Debian package architectures", () => {
  assert.equal(debianArchForNodeArch("x64"), "amd64");
  assert.equal(debianArchForNodeArch("arm64"), "arm64");
  assert.equal(debianArchForNodeArch("arm"), undefined);
});
