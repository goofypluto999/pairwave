/**
 * Full-stack end-to-end: two real CompanionRuntimes ⇄ one real relay over WebSockets.
 * Exercises the complete protocol: hello → SAS verify → charter → floor → context → inert code →
 * action.request → Gate-1 approve → apply task (quarantined payload) → action.result → handoff →
 * resume from disk. This is the test that proves the tool actually works as a system.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRelay, type RelayHandle } from "@pairwave/relay/dist/server.js";
import { CompanionRuntime } from "../src/runtime.js";
import { saveConfig, type RoomConfig } from "../src/persist.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until a condition holds — network fan-out is fast locally but not instant. */
async function until(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await wait(40);
  }
}

let relay: RelayHandle;
let dirA: string;
let dirB: string;
let A: CompanionRuntime;
let B: CompanionRuntime;
const roomId = "rm-" + randomBytes(8).toString("hex");
const saltB64 = randomBytes(16).toString("base64");
const passphrase = randomBytes(24).toString("base64url");

function makeConfig(dir: string, peerId: string, name: string, relayUrl: string): void {
  const cfg: RoomConfig = { v: 1, roomId, relayUrl, saltB64, passphrase, peerId, name };
  saveConfig(dir, cfg);
}

before(async () => {
  relay = await createRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  dirA = mkdtempSync(join(tmpdir(), "pw-A-"));
  dirB = mkdtempSync(join(tmpdir(), "pw-B-"));
  makeConfig(dirA, "p-alice", "Alice", url);
  makeConfig(dirB, "p-bob", "Bob", url);
  A = await CompanionRuntime.boot(dirA);
  B = await CompanionRuntime.boot(dirB);
  A.start();
  B.start();
});

after(async () => {
  await A?.shutdown().catch(() => undefined);
  await B?.shutdown().catch(() => undefined);
  await relay?.close();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("hellos propagate; both sides see each other and the same SAS words", async () => {
  await until(() => A.peers().length === 1 && B.peers().length === 1);
  assert.equal(A.peers()[0]!.peerId, "p-bob");
  assert.equal(B.peers()[0]!.peerId, "p-alice");
  const wordsA = await A.sasWords();
  const wordsB = await B.sasWords();
  assert.ok(wordsA && wordsB);
  assert.deepEqual(wordsA, wordsB); // identical fingerprint on both screens
});

test("substantive exchange is blocked until SAS + charter; then it flows", async () => {
  // blocked: unverified
  const early = await A.send("context", { headline: "x", text: "y" }, "agent");
  assert.ok(!early.ok && early.code === "unverified");

  A.confirmVerification();
  B.confirmVerification();

  // blocked: no charter
  const noCharter = await A.send("context", { headline: "x", text: "y" }, "agent");
  assert.ok(!noCharter.ok && noCharter.code === "no_charter");

  // charter: A proposes, B accepts
  const prop = await A.proposeCharter({
    title: "Build the widget together",
    purpose: "ship the widget",
    mustNots: ["no secrets", "no prod"],
    autoApprove: "none",
  });
  assert.ok(prop.ok);
  await until(() => Object.keys(B.core.bootstrap().acceptedBy).length > 0);
  const acc = await B.acceptCharter();
  assert.ok(acc.ok);
  await until(() => A.core.bootstrap().charterAgreed && B.core.bootstrap().charterAgreed);
  assert.equal((await A.status()).charter.title, "Build the widget together");
});

test("floor: claim, push context, peer blocked out-of-turn; ledger converges", async () => {
  const claim = await A.send("turn.claim", {}, "human");
  assert.ok(claim.ok);
  await until(() => B.core.floor().floor === "p-alice");

  const ctx = await A.send("context", { headline: "schema locked", text: "users(id, email)" }, "agent");
  assert.ok(ctx.ok);
  await until(() => B.ledger().headlines.some((h) => h.headline === "schema locked"));

  const blocked = await B.send("context", { headline: "nope", text: "…" }, "agent");
  assert.ok(!blocked.ok && blocked.code === "not_your_turn");
});

test("code → inert quarantine on B; action.request → Gate-1 → apply task carries the artifact; result flows back", async () => {
  const code = await A.send(
    "code",
    { headline: "widget.ts", language: "typescript", content: "export const widget = 42;", isPatch: false },
    "agent",
  );
  assert.ok(code.ok);
  if (!code.ok) return;
  const codeMsgId = code.message.msgId;

  // B's quarantine holds the artifact, inert
  await until(() => existsSync(join(B.store.roomDir, "quarantine", codeMsgId, "artifact.ts")));
  assert.equal(readFileSync(join(B.store.roomDir, "quarantine", codeMsgId, "artifact.ts"), "utf8"), "export const widget = 42;");

  // A asks B to write it
  const req = await A.send(
    "action.request",
    {
      action: "write_file",
      risk: "low",
      summary: "create widget.ts with the shared artifact",
      payload: "export const widget = 42;",
      targetPath: "src/widget.ts",
      fromCodeMsgId: codeMsgId,
    },
    "agent",
  );
  assert.ok(req.ok);
  if (!req.ok) return;

  // Gate 1 on B: queued (posture none), risk re-normalized write_file low→medium
  await until(() => B.queue.pending().length === 1);
  const perm = B.queue.pending()[0]!;
  assert.equal(perm.risk, "medium");

  const decided = B.decidePermission(perm.id, "approve");
  assert.ok(decided.ok && decided.task);
  const task = B.getApplyTask(perm.id)!;
  assert.equal(task.payload, "export const widget = 42;"); // exact quarantined content
  assert.ok(task.note.includes("Gate 2")); // B's Claude applies it itself

  const done = await B.completeAction(perm.requestMsgId, true, "wrote src/widget.ts");
  assert.ok(done.ok);
  await until(() => A.ledger().pendingActions.length === 0); // A sees it resolved
  assert.equal(B.inbox().approvedTasks.length, 0);
});

test("anti-loop: agent hop cap engages across the wire", async () => {
  // hops reset by the last human message; A (floor-holder) pushes agent messages until blocked
  let blocked = false;
  for (let i = 0; i < 6; i++) {
    const r = await A.send("chat", { text: `agent ping ${i}` }, "agent");
    if (!r.ok) {
      assert.equal(r.code, "max_hops");
      blocked = true;
      break;
    }
  }
  assert.ok(blocked, "the hop cap must engage");
  const human = await A.send("chat", { text: "human steps in" }, "human");
  assert.ok(human.ok); // humans are never hop-blocked
});

test("secrets are blocked at the runtime boundary too", async () => {
  const r = await A.send("chat", { text: "token sk_live_abcdef0123456789ABCDEF" }, "human");
  assert.ok(!r.ok && r.code === "secret_blocked");
});

test("handoff writes; a fresh runtime resumes the full session from disk", async () => {
  const path = A.writeHandoffNow();
  const md = readFileSync(path, "utf8");
  assert.ok(md.includes("Build the widget together")); // charter
  assert.ok(md.includes("schema locked")); // ledger headline
  assert.ok(md.includes("| time (UTC) |")); // transcript table

  // Fresh process simulation: boot a NEW runtime over A's directory (no relay needed to read state)
  const A2 = await CompanionRuntime.boot(dirA);
  assert.equal(A2.core.bootstrap().charterAgreed, true); // charter restored from durable log
  assert.ok(A2.ledger().headlines.some((h) => h.headline === "schema locked"));
  assert.ok((await A2.status()).verification.verified); // SAS persisted
  const resume = A2.resume();
  assert.ok(resume.handoff && resume.handoff.includes("Build the widget together"));
});
