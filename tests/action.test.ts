import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRemoteSpec,
  buildRsyncArgs,
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
    toolVersion: "1.0.0",
    downloadUrls: {},
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
