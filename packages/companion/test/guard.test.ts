import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDanger, isDangerous } from "../src/guard.js";

test("destructive commands are flagged: deletions, terraform, git nukes, db wipes", () => {
  assert.ok(isDangerous("run_command", "rm -rf ./build && rm -rf /"));
  assert.ok(isDangerous("run_command", "Remove-Item C:\\projects -Recurse -Force"));
  assert.ok(isDangerous("run_command", "terraform destroy -auto-approve"));
  assert.ok(isDangerous("run_command", "git push origin main --force"));
  assert.ok(isDangerous("run_command", "DROP TABLE users;"));
  assert.ok(isDangerous("run_command", "npm publish"));
});

test("creation and production stay friction-free", () => {
  assert.equal(isDangerous("run_command", "npm test"), false);
  assert.equal(isDangerous("run_command", "mkdir src && node build.js"), false);
  assert.equal(isDangerous("write_file", "export const x = 1;", "src/lib/feature.ts"), false);
  assert.equal(isDangerous("apply_patch", "--- a\n+++ b\n", "components/Button.tsx"), false);
});

test("protected paths are flagged for writes/patches", () => {
  assert.ok(isDangerous("write_file", "anything", ".env"));
  assert.ok(isDangerous("write_file", "anything", ".git/config"));
  assert.ok(isDangerous("apply_patch", "diff", "C:/Windows/system32/drivers/etc/hosts"));
  assert.ok(isDangerous("write_file", "key", "/home/u/.ssh/id_rsa"));
});

test("flags carry a rule and a plain-English detail for the popup", () => {
  const flags = scanDanger("run_command", "rm -rf node_modules dist");
  assert.ok(flags.length >= 1);
  assert.ok(flags[0]!.rule.length > 0 && flags[0]!.detail.length > 5);
});
