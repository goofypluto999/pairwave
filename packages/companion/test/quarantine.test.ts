import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantineCode, readQuarantined, quarantineDir } from "../src/quarantine.js";

test("a shared code artifact lands inert under quarantine — never the project tree", () => {
  const base = mkdtempSync(join(tmpdir(), "pairwave-q-"));
  try {
    const content = "export const danger = () => { /* would do nothing on its own */ };";
    const art = quarantineCode(base, "room-q-01", "11111111-1111-1111-1111-111111111111", {
      content,
      language: "typescript",
    });

    assert.ok(existsSync(art.path), "artifact file should exist");
    assert.ok(art.path.startsWith(quarantineDir(base, "room-q-01")), "must be inside the quarantine dir");
    assert.ok(art.path.endsWith(".ts"));
    assert.equal(readQuarantined(art), content); // stored verbatim, as data
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("patches are stored with a .patch extension", () => {
  const base = mkdtempSync(join(tmpdir(), "pairwave-q-"));
  try {
    const art = quarantineCode(base, "room-q-02", "22222222-2222-2222-2222-222222222222", {
      content: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
      isPatch: true,
    });
    assert.ok(art.isPatch);
    assert.ok(art.path.endsWith(".patch"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
