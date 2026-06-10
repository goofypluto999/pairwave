import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sodium,
  toB64,
  generateIdentity,
  buildMessage,
  verify,
  topoOrder,
  type Message,
  type MessageCore,
} from "../src/index.js";

const ROOM = "room-dag-1";

async function id() {
  await sodium();
  const kp = await generateIdentity();
  return { kp, pub: await toB64(kp.publicKey) };
}

function core(pub: string, parents: string[], ts: string): MessageCore {
  return {
    v: 1,
    msgId: randomUUID(),
    roomId: ROOM,
    sender: { peerId: "A", name: "Alice", pubKey: pub },
    ts,
    parents,
    turn: { floor: "A", turnId: "t1", hop: 0 },
    origin: "agent",
    kind: "chat",
    body: { text: "n" },
  } as MessageCore;
}

// Build: genesis g → fork (m1, m2 share g) → merge (m3 has both)
async function buildDag() {
  const { kp, pub } = await id();
  const g = await buildMessage(core(pub, [], "2026-06-04T10:00:00.000Z"), kp.secretKey);
  const m1 = await buildMessage(core(pub, [g.hash], "2026-06-04T10:00:01.000Z"), kp.secretKey);
  const m2 = await buildMessage(core(pub, [g.hash], "2026-06-04T10:00:02.000Z"), kp.secretKey);
  const m3 = await buildMessage(core(pub, [m1.hash, m2.hash], "2026-06-04T10:00:03.000Z"), kp.secretKey);
  return { g, m1, m2, m3 };
}

test("verify accepts a well-formed DAG (any input order)", async () => {
  const { g, m1, m2, m3 } = await buildDag();
  const v = await verify([m3, m1, g, m2]);
  assert.equal(v.ok, true);
  assert.equal(v.bad.length, 0);
  assert.equal(v.missingParents.length, 0);
});

test("topoOrder is deterministic: genesis first, merge last, fork by (ts,msgId)", async () => {
  const { g, m1, m2, m3 } = await buildDag();
  const ordered = topoOrder([m3, m2, g, m1]);
  const hashes = ordered.map((m: Message) => m.hash);
  assert.equal(hashes[0], g.hash);
  assert.equal(hashes[hashes.length - 1], m3.hash);
  assert.ok(hashes.indexOf(m1.hash) < hashes.indexOf(m2.hash)); // m1.ts < m2.ts
});

test("verify flags a tampered message (stale hash)", async () => {
  const { g, m1, m2, m3 } = await buildDag();
  const tampered = { ...m1, body: { text: "EVIL" } } as Message;
  const v = await verify([g, tampered, m2, m3]);
  assert.equal(v.ok, false);
  assert.ok(v.bad.includes(tampered.msgId));
});

test("verify reports a missing parent (gap)", async () => {
  const { g, m1 } = await buildDag();
  const v = await verify([m1]); // parent g absent
  assert.equal(v.ok, false);
  assert.ok(v.missingParents.includes(g.hash));
});
