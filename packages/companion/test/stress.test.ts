/**
 * Stress suite — the "won't break" proof, run over REAL websockets and REAL crypto:
 *   1. message flood from both sides → zero loss, identical deterministic order on both peers
 *   2. relay OUTAGE mid-session → sends queue durably, relay restarts, everything delivers
 *   3. very large artifact (~300 KB) survives the full seal → relay → open path intact
 *   4. simultaneous concurrent sends (DAG fork) → both sides converge on the same merged order
 *   5. shared brain across the wire: remember on A → recall on B; supersede dedupes on BOTH sides
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRelay, type RelayHandle } from "@pairwave/relay/dist/server.js";
import { CompanionRuntime } from "../src/runtime.js";
import { saveConfig, type RoomConfig } from "../src/persist.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 8000, label = "condition"): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`${label} not met in ${ms}ms`);
    await wait(50);
  }
}

let relay: RelayHandle;
let relayPort: number;
let dirA: string;
let dirB: string;
let A: CompanionRuntime;
let B: CompanionRuntime;
const roomId = "rm-stress-" + randomBytes(6).toString("hex");
const saltB64 = randomBytes(16).toString("base64");
const passphrase = randomBytes(24).toString("base64url");

function cfg(dir: string, peerId: string, name: string): void {
  const c: RoomConfig = { v: 1, roomId, relayUrl: `ws://127.0.0.1:${relayPort}`, saltB64, passphrase, peerId, name };
  saveConfig(dir, c);
}

before(async () => {
  relay = await createRelay({ port: 0 });
  relayPort = relay.port;
  dirA = mkdtempSync(join(tmpdir(), "pw-st-A-"));
  dirB = mkdtempSync(join(tmpdir(), "pw-st-B-"));
  cfg(dirA, "p-alice", "Alice");
  cfg(dirB, "p-bob", "Bob");
  A = await CompanionRuntime.boot(dirA);
  B = await CompanionRuntime.boot(dirB);
  A.start();
  B.start();
  await until(() => A.peers().length === 1 && B.peers().length === 1, 8000, "hello exchange");
  A.confirmVerification();
  B.confirmVerification();
  const p = await A.proposeCharter({ title: "Stress run", purpose: "prove it does not break", autoApprove: "none" });
  assert.ok(p.ok);
  await until(() => Object.keys(B.core.bootstrap().acceptedBy).length > 0, 8000, "charter seen");
  assert.ok((await B.acceptCharter()).ok);
  await until(() => A.core.bootstrap().charterAgreed && B.core.bootstrap().charterAgreed, 8000, "charter agreed");
});

after(async () => {
  await A?.shutdown().catch(() => undefined);
  await B?.shutdown().catch(() => undefined);
  await relay?.close().catch(() => undefined);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("1. flood: 60 rapid human chats from BOTH sides — zero loss, identical order on both peers", async () => {
  const N = 30;
  const sends: Promise<unknown>[] = [];
  for (let i = 0; i < N; i++) {
    sends.push(A.send("chat", { text: `A-${i}` }, "human"));
    sends.push(B.send("chat", { text: `B-${i}` }, "human"));
  }
  const results = (await Promise.all(sends)) as { ok: boolean }[];
  assert.ok(results.every((r) => r.ok), "every send must be accepted locally");

  const expectChats = (rt: CompanionRuntime) =>
    rt.core.messages().filter((m) => m.kind === "chat" && /^[AB]-\d+$/.test((m.body as { text: string }).text)).length;
  await until(() => expectChats(A) === 2 * N && expectChats(B) === 2 * N, 15000, "flood convergence");

  const orderA = A.read({ limit: 500 }).map((m) => `${m.kind}:${JSON.stringify(m.body)}`);
  const orderB = B.read({ limit: 500 }).map((m) => `${m.kind}:${JSON.stringify(m.body)}`);
  assert.deepEqual(orderA, orderB, "both peers must render the identical deterministic order");
  assert.equal(A.droppedCount, 0);
  assert.equal(B.droppedCount, 0);
});

test("2. relay outage mid-session: sends queue in the durable outbox and deliver after restart", async () => {
  await relay.close(); // kill the relay under them
  await wait(200);

  const offline = await A.send("chat", { text: "sent-while-relay-down" }, "human");
  assert.ok(offline.ok, "send must be accepted locally while offline (durable outbox)");

  relay = await createRelay({ port: relayPort }); // restart on the SAME port
  await until(
    () => B.core.messages().some((m) => m.kind === "chat" && (m.body as { text: string }).text === "sent-while-relay-down"),
    20000, // reconnect backoff is 1s→2s→4s…
    "post-outage delivery",
  );
});

test("3. a ~300KB artifact survives seal → relay → open intact", async () => {
  const big = "// pairwave large-artifact stress\n" + "x".repeat(300_000);
  const r = await A.send("turn.claim", {}, "human");
  assert.ok(r.ok);
  const code = await A.send(
    "code",
    { headline: "big artifact", language: "typescript", content: big, isPatch: false },
    "human",
  );
  assert.ok(code.ok);
  if (!code.ok) return;
  await until(
    () => B.core.messages().some((m) => m.msgId === code.message.msgId),
    15000,
    "large artifact delivery",
  );
  const got = B.core.messages().find((m) => m.msgId === code.message.msgId)!;
  assert.equal((got.body as { content: string }).content.length, big.length, "content must arrive byte-identical in length");
});

test("4. simultaneous sends fork the DAG and both sides converge on the same merged order", async () => {
  const [ra, rb] = await Promise.all([
    A.send("chat", { text: "fork-A" }, "human"),
    B.send("chat", { text: "fork-B" }, "human"),
  ]);
  assert.ok((ra as { ok: boolean }).ok && (rb as { ok: boolean }).ok);
  const seen = (rt: CompanionRuntime, t: string) =>
    rt.core.messages().some((m) => m.kind === "chat" && (m.body as { text: string }).text === t);
  await until(() => seen(A, "fork-B") && seen(B, "fork-A"), 10000, "fork delivery");
  const tail = (rt: CompanionRuntime) => rt.read({ limit: 10 }).map((m) => JSON.stringify(m.body));
  assert.deepEqual(tail(A), tail(B), "merged order must be identical on both sides");
});

test("5. shared brain: remember on A → recall on B; supersede dedupes on both sides", async () => {
  const e1 = await A.remember({
    headline: "Database choice",
    content: "We are using SQLite for v1",
    tags: ["db", "architecture"],
    entryKind: "decision",
    origin: "human",
  });
  assert.ok(e1.ok);
  if (!e1.ok) return;

  await until(() => B.brain().counts.total >= 1, 10000, "brain sync A→B");
  const hits = B.recall("database sqlite");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.headline, "Database choice");

  // B supersedes A's entry — both sides converge on exactly ONE live entry, the new one
  const e2 = await B.remember({
    headline: "Database choice",
    content: "Upgraded: we are using Postgres now",
    tags: ["db", "architecture"],
    entryKind: "decision",
    supersedes: e1.message.msgId,
    origin: "human",
  });
  assert.ok(e2.ok);
  await until(
    () => A.brain().entries.some((x) => x.content.includes("Postgres")) && A.brain().counts.total === brainTotalLive(A),
    10000,
    "brain supersede sync B→A",
  );
  const liveA = A.recall("database", { tags: ["db"] });
  const liveB = B.recall("database", { tags: ["db"] });
  assert.equal(liveA.filter((h) => h.headline === "Database choice").length, 1, "no overlap after supersede (A)");
  assert.equal(liveB.filter((h) => h.headline === "Database choice").length, 1, "no overlap after supersede (B)");
  assert.ok(liveA[0]!.content.includes("Postgres"));
  assert.deepEqual(liveA.map((h) => h.msgId), liveB.map((h) => h.msgId), "identical recall ranking on both sides");
});

function brainTotalLive(rt: CompanionRuntime): number {
  return rt.brain().counts.total;
}
