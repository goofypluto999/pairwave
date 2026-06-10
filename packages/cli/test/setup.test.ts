import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireProject, newInvite } from "../src/setup.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "pw-setup-"));
}

test("wireProject creates config, merges .mcp.json, installs the skill, protects .gitignore", () => {
  const dir = freshDir();
  try {
    // pre-existing .mcp.json with another server must survive untouched
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");

    const invite = newInvite("ws://127.0.0.1:8787");
    const result = wireProject(dir, invite, "Alice");

    const cfg = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.equal(cfg.roomId, invite.roomId);
    assert.equal(cfg.name, "Alice");
    assert.ok(cfg.peerId.startsWith("p-"));

    const mcp = JSON.parse(readFileSync(result.mcpJsonPath, "utf8"));
    assert.ok(mcp.mcpServers.other, "existing servers must be preserved");
    assert.equal(mcp.mcpServers.pairwave.command, "node");
    assert.ok(existsSync(mcp.mcpServers.pairwave.args[0]), "companion entry must exist on disk");
    assert.equal(mcp.mcpServers.pairwave.env.PAIRWAVE_DIR, join(dir, ".pairwave"));

    const skill = readFileSync(result.skillPath, "utf8");
    assert.ok(skill.includes("name: pairwave"));
    assert.ok(skill.includes("pair_apply")); // the shipped skill matches the real tool surface

    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(ignore.split(/\r?\n/).includes(".pairwave/"));

    // idempotent: wiring again must not duplicate the gitignore line or break the json
    wireProject(dir, invite, "Alice");
    const lines = readFileSync(join(dir, ".gitignore"), "utf8").split(/\r?\n/).filter((l) => l.trim() === ".pairwave/");
    assert.equal(lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireProject refuses to clobber a malformed .mcp.json", () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, ".mcp.json"), "{ this is not json", "utf8");
    assert.throws(() => wireProject(dir, newInvite("ws://x:1"), "A"), /not valid JSON/);
    assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), "{ this is not json"); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invites are unique per init", () => {
  const a = newInvite("ws://r:1");
  const b = newInvite("ws://r:1");
  assert.notEqual(a.roomId, b.roomId);
  assert.notEqual(a.passphrase, b.passphrase);
  assert.notEqual(a.saltB64, b.saltB64);
});
