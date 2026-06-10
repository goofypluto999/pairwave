import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionKey, generateIdentity, type RelayEnvelope, type PublishEnvelope, type Charter } from "@pairwave/protocol";
import { CompanionCore } from "../src/engine.js";

const SALT = new Uint8Array(16);
const ROOM = "room-engine-1";
let seq = 0;

/** Simulate the relay: wrap a PublishEnvelope into a delivered RelayEnvelope. */
function deliver(publish: PublishEnvelope): RelayEnvelope {
  return { v: 1, roomId: publish.roomId, seq: ++seq, tsRelay: "2026-06-04T10:00:00.000Z", nonce: publish.nonce, ciphertext: publish.ciphertext };
}

async function setup() {
  const sessionKey = await deriveSessionKey("a shared room passphrase", SALT);
  const A = new CompanionCore({ roomId: ROOM, peer: { peerId: "A", name: "Alice" }, identity: await generateIdentity(), sessionKey });
  const B = new CompanionCore({ roomId: ROOM, peer: { peerId: "B", name: "Bob" }, identity: await generateIdentity(), sessionKey });
  return { A, B };
}

function charterObj(): Charter {
  return {
    charterId: "00000000-0000-0000-0000-0000000000aa",
    title: "wire the relay together",
    purpose: "build pairwave",
    scope: ["relay"],
    outOfScope: ["prod"],
    mustNots: ["no secrets"],
    responseContract: ["timestamp everything"],
    autoApprove: "none",
    floorPolicy: {},
    liveModePolicy: {},
    participants: [{ peerId: "A", name: "Alice" }, { peerId: "B", name: "Bob" }],
    createdAt: "2026-06-04T10:00:00.000Z",
    charterHash: "",
  } as unknown as Charter;
}

test("a chat round-trips end-to-end and the echo is deduped", async () => {
  const { A, B } = await setup();
  A.verifyPeer();
  B.verifyPeer();
  const r = await A.send("chat", { text: "hi Bob" }, "human");
  assert.ok(r.ok);
  if (!r.ok) return;
  const ing = await B.ingest(deliver(r.publish));
  assert.ok(ing.ok);
  if (ing.ok) assert.equal((ing.message.body as { text: string }).text, "hi Bob");
  const dup = await A.ingest(deliver(r.publish)); // relay echoes to sender too
  assert.ok(!dup.ok && dup.code === "duplicate");
});

test("substantive sends are blocked until a charter is agreed", async () => {
  const { A } = await setup();
  A.verifyPeer();
  const r = await A.send("context", { headline: "x", text: "y" }, "agent");
  assert.ok(!r.ok && r.code === "no_charter");
});

test("two companions agree a charter, then exchange a floor-gated artifact", async () => {
  const { A, B } = await setup();
  A.verifyPeer();
  B.verifyPeer();

  const prop = await A.proposeCharter(charterObj());
  assert.ok(prop.ok);
  if (!prop.ok) return;
  await B.ingest(deliver(prop.publish));

  const charterHash = Object.keys(B.bootstrap().acceptedBy)[0]!;
  const acc = await B.acceptCharter(charterHash);
  assert.ok(acc.ok);
  if (!acc.ok) return;
  await A.ingest(deliver(acc.publish));

  assert.equal(A.bootstrap().charterAgreed, true);
  assert.equal(B.bootstrap().charterAgreed, true);

  const claim = await A.send("turn.claim", {}, "human");
  assert.ok(claim.ok);
  if (!claim.ok) return;
  await B.ingest(deliver(claim.publish));
  assert.equal(A.floor().floor, "A");
  assert.equal(B.floor().floor, "A"); // both sides converge on the same floor

  const ctx = await A.send("context", { headline: "schema locked", text: "the design" }, "agent");
  assert.ok(ctx.ok);
  if (!ctx.ok) return;
  await B.ingest(deliver(ctx.publish));
  assert.ok(B.ledger().headlines.some((h) => h.headline === "schema locked"));

  const bad = await B.send("context", { headline: "nope", text: "..." }, "agent");
  assert.ok(!bad.ok && bad.code === "not_your_turn");
});

test("outbound secrets are blocked before they leave the machine", async () => {
  const { A } = await setup();
  A.verifyPeer();
  const r = await A.send("chat", { text: "my key AKIAIOSFODNN7EXAMPLE oops" }, "human");
  assert.ok(!r.ok && r.code === "secret_blocked");
  if (!r.ok) assert.ok(r.secrets && r.secrets.length > 0);
});

test("a tampered envelope fails to ingest", async () => {
  const { A, B } = await setup();
  A.verifyPeer();
  B.verifyPeer();
  const r = await A.send("chat", { text: "legit" }, "human");
  assert.ok(r.ok);
  if (!r.ok) return;
  const env = deliver(r.publish);
  const flipped = { ...env, ciphertext: (env.ciphertext[0] === "A" ? "B" : "A") + env.ciphertext.slice(1) };
  const ing = await B.ingest(flipped);
  assert.ok(!ing.ok);
});
