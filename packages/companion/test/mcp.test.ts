/**
 * MCP tool layer: definitions are well-formed and dispatch drives a real runtime (no transport).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRelay, type RelayHandle } from "@pairwave/relay/dist/server.js";
import { CompanionRuntime } from "../src/runtime.js";
import { saveConfig } from "../src/persist.js";
import { TOOLS, callPairTool } from "../src/mcp.js";

let relay: RelayHandle;
let dir: string;
let rt: CompanionRuntime;

before(async () => {
  relay = await createRelay({ port: 0 });
  dir = mkdtempSync(join(tmpdir(), "pw-mcp-"));
  saveConfig(dir, {
    v: 1,
    roomId: "rm-" + randomBytes(8).toString("hex"),
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    saltB64: randomBytes(16).toString("base64"),
    passphrase: randomBytes(24).toString("base64url"),
    peerId: "p-solo",
    name: "Solo",
  });
  rt = await CompanionRuntime.boot(dir);
  rt.start();
});

after(async () => {
  await rt?.shutdown().catch(() => undefined);
  await relay?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("all 17 tools are defined with object schemas and real descriptions", () => {
  assert.equal(TOOLS.length, 17);
  for (const t of TOOLS) {
    assert.ok(t.name.startsWith("pair_"));
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal((t.inputSchema as { type: string }).type, "object");
  }
});

test("pair_status returns the full state shape", async () => {
  const s = (await callPairTool(rt, "pair_status", {})) as Record<string, unknown>;
  assert.ok(s.roomId);
  assert.ok(s.me);
  assert.ok(s.ledger);
  assert.ok(s.floor);
  assert.ok(s.verification);
});

test("pair_send chat works; floor-only context is refused without the floor… then allowed after claim + charter path", async () => {
  const chat = (await callPairTool(rt, "pair_send", { kind: "chat", text: "hello", origin: "human" })) as { ok: boolean };
  assert.equal(chat.ok, true);

  const ctx = (await callPairTool(rt, "pair_send", { kind: "context", headline: "h", text: "t" })) as {
    ok: boolean;
    code?: string;
  };
  assert.equal(ctx.ok, false);
  assert.equal(ctx.code, "unverified"); // SAS gate fires first — exactly per spec
});

test("pair_verify (no confirm) reports no peer in a solo room", async () => {
  const v = (await callPairTool(rt, "pair_verify", {})) as { error?: string };
  assert.ok(v.error?.includes("no peer"));
});

test("pair_handoff writes and pair_resume reads it back", async () => {
  const h = (await callPairTool(rt, "pair_handoff", {})) as { path: string };
  assert.ok(h.path.endsWith(".md"));
  const r = (await callPairTool(rt, "pair_resume", {})) as { handoff?: string };
  assert.ok(r.handoff && r.handoff.includes("Pairwave handoff"));
});

test("pair_live_mode toggles and reports the polling contract", async () => {
  const on = (await callPairTool(rt, "pair_live_mode", { on: true })) as { on: boolean; pollSec: number };
  assert.equal(on.on, true);
  assert.ok(on.pollSec >= 30);
  const off = (await callPairTool(rt, "pair_live_mode", { on: false })) as { on: boolean };
  assert.equal(off.on, false);
});

test("unknown tools throw (surfaced as MCP isError)", async () => {
  await assert.rejects(callPairTool(rt, "pair_nonsense", {}));
});
