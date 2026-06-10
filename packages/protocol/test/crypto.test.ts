import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sodium,
  toB64,
  deriveSessionKey,
  generateIdentity,
  buildMessage,
  seal,
  open,
  sign,
  hashCanonical,
  sas,
  PairwaveCryptoError,
  type MessageCore,
  type RelayEnvelope,
} from "../src/index.js";

const ROOM = "room-0001";
const SALT = new Uint8Array(16); // fixed for deterministic tests

async function setup() {
  const s = await sodium();
  const id = await generateIdentity();
  const pub = await toB64(id.publicKey);
  const key = await deriveSessionKey("correct horse battery staple", SALT);
  return { s, id, pub, key };
}

function chatCore(pub: string, over: Partial<MessageCore> = {}): MessageCore {
  return {
    v: 1,
    msgId: randomUUID(),
    roomId: ROOM,
    sender: { peerId: "A", name: "Alice", pubKey: pub },
    ts: "2026-06-04T10:00:00.000Z",
    parents: [],
    turn: { floor: "A", turnId: "t1", hop: 0 },
    origin: "agent",
    kind: "chat",
    body: { text: "hello peer" },
    ...over,
  } as MessageCore;
}

function envelope(sealed: { nonce: string; ciphertext: string }, over: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return { v: 1, roomId: ROOM, seq: 1, tsRelay: "2026-06-04T10:00:00.000Z", ...sealed, ...over };
}

test("seal → open round-trips and preserves content", async () => {
  const { id, pub, key } = await setup();
  const msg = await buildMessage(chatCore(pub), id.secretKey);
  const got = await open(envelope(await seal(msg, key)), key);
  assert.equal(got.msgId, msg.msgId);
  assert.equal(got.kind, "chat");
  assert.equal((got.body as { text: string }).text, "hello peer");
  assert.equal(got.hash, msg.hash);
  assert.equal(got.sig, msg.sig);
});

test("tampered ciphertext fails closed", async () => {
  const { id, pub, key } = await setup();
  const msg = await buildMessage(chatCore(pub), id.secretKey);
  const env = envelope(await seal(msg, key));
  const flipped = (env.ciphertext[0] === "A" ? "B" : "A") + env.ciphertext.slice(1);
  await assert.rejects(open({ ...env, ciphertext: flipped }, key), (e: unknown) => {
    assert.ok(e instanceof PairwaveCryptoError);
    assert.equal((e as PairwaveCryptoError).code, "decrypt_failed");
    return true;
  });
});

test("wrong session key fails closed", async () => {
  const { id, pub, key } = await setup();
  const msg = await buildMessage(chatCore(pub), id.secretKey);
  const env = envelope(await seal(msg, key));
  const wrongKey = await deriveSessionKey("a different passphrase", SALT);
  await assert.rejects(open(env, wrongKey), (e: unknown) => {
    return e instanceof PairwaveCryptoError && (e as PairwaveCryptoError).code === "decrypt_failed";
  });
});

test("cross-room replay fails (roomId is AEAD associated data)", async () => {
  const { id, pub, key } = await setup();
  const msg = await buildMessage(chatCore(pub), id.secretKey);
  const env = envelope(await seal(msg, key));
  await assert.rejects(open({ ...env, roomId: "room-9999" }, key), (e: unknown) => {
    return e instanceof PairwaveCryptoError && (e as PairwaveCryptoError).code === "decrypt_failed";
  });
});

test("signature by the wrong key is rejected", async () => {
  const { id, pub, key } = await setup();
  const attacker = await generateIdentity();
  const core = chatCore(pub); // claims Alice's pubKey...
  const hash = await hashCanonical(core);
  const forgedSig = await sign(hash, attacker.secretKey); // ...but signed by someone else
  const forged = { ...(core as object), hash, sig: forgedSig } as typeof core & { hash: string; sig: string };
  const env = envelope(await seal(forged as never, key));
  await assert.rejects(open(env, key), (e: unknown) => {
    assert.ok(e instanceof PairwaveCryptoError);
    assert.equal((e as PairwaveCryptoError).code, "bad_signature");
    return true;
  });
});

test("content tamper (stale hash) is rejected", async () => {
  const { id, pub, key } = await setup();
  const msg = await buildMessage(chatCore(pub), id.secretKey);
  const mutated = { ...msg, body: { text: "EVIL injected text" } } as typeof msg;
  const env = envelope(await seal(mutated, key));
  await assert.rejects(open(env, key), (e: unknown) => {
    return e instanceof PairwaveCryptoError && (e as PairwaveCryptoError).code === "hash_mismatch";
  });
});

test("SAS is order-independent and stable", async () => {
  const a = (await generateIdentity()).publicKey;
  const b = (await generateIdentity()).publicKey;
  const w1 = await sas(a, b, SALT);
  const w2 = await sas(b, a, SALT);
  assert.deepEqual(w1, w2);
  assert.equal(w1.length, 6);
  assert.ok(w1.every((w) => typeof w === "string" && w.length > 0));
});

test("SAS differs for a different peer (MITM would show different words)", async () => {
  const me = (await generateIdentity()).publicKey;
  const real = (await generateIdentity()).publicKey;
  const mitm = (await generateIdentity()).publicKey;
  const wReal = await sas(me, real, SALT);
  const wMitm = await sas(me, mitm, SALT);
  assert.notDeepEqual(wReal, wMitm);
});
