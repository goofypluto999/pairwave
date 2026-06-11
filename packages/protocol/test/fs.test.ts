import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sodium,
  toB64,
  generateEphemeral,
  deriveContentKey,
  deriveSessionKey,
  buildMessage,
  seal,
  open,
  PairwaveCryptoError,
  type MessageCore,
  type RelayEnvelope,
} from "../src/index.js";

const SALT = new Uint8Array(16);
const ROOM = "room-fs-01";

function chatCore(pub: string): MessageCore {
  return {
    v: 1,
    msgId: "00000000-0000-0000-0000-0000000000fs".replace("fs", "01"),
    roomId: ROOM,
    sender: { peerId: "A", name: "Alice", pubKey: pub },
    origin: "agent",
    ts: "2026-06-11T10:00:00.000Z",
    parents: [],
    turn: { floor: "A", turnId: "t1", hop: 0 },
    kind: "chat",
    body: { text: "forward-secret hello" },
  } as MessageCore;
}

test("ECDH content key is symmetric — both peers derive the identical key", async () => {
  const a = await generateEphemeral();
  const b = await generateEphemeral();
  const ka = await deriveContentKey(a.secretKey, b.publicKey, SALT);
  const kb = await deriveContentKey(b.secretKey, a.publicKey, SALT);
  assert.deepEqual([...ka], [...kb]);
  assert.equal(ka.length, 32);
});

test("content key is NOT derivable from the passphrase (the forward-secrecy property)", async () => {
  const a = await generateEphemeral();
  const b = await generateEphemeral();
  const content = await deriveContentKey(a.secretKey, b.publicKey, SALT);
  const room = await deriveSessionKey("the room passphrase", SALT);
  assert.notDeepEqual([...content], [...room]);
});

test("a different peer ephemeral yields a different content key", async () => {
  const a = await generateEphemeral();
  const b = await generateEphemeral();
  const evil = await generateEphemeral();
  const real = await deriveContentKey(a.secretKey, b.publicKey, SALT);
  const wrong = await deriveContentKey(a.secretKey, evil.publicKey, SALT);
  assert.notDeepEqual([...real], [...wrong]);
});

test("content sealed with the ephemeral key cannot be opened with the passphrase key (key separation)", async () => {
  const s = await sodium();
  const idA = s.crypto_sign_keypair();
  const a = await generateEphemeral();
  const b = await generateEphemeral();
  const contentKey = await deriveContentKey(a.secretKey, b.publicKey, SALT);
  const roomKey = await deriveSessionKey("the room passphrase", SALT);

  const msg = await buildMessage(chatCore(await toB64(idA.publicKey)), idA.privateKey);
  const sealed = await seal(msg, contentKey);
  const env: RelayEnvelope = { v: 1, roomId: ROOM, seq: 1, keyEpoch: 1, tsRelay: "2026-06-11T10:00:00.000Z", ...sealed };

  // wrong key (passphrase/room key) must fail closed...
  await assert.rejects(open(env, roomKey), (e: unknown) => e instanceof PairwaveCryptoError && (e as PairwaveCryptoError).code === "decrypt_failed");
  // ...the correct content key opens it.
  const got = await open(env, contentKey);
  assert.equal((got.body as { text: string }).text, "forward-secret hello");
});

test("envelope keyEpoch defaults to 0 (backward compatible)", async () => {
  const s = await sodium();
  const idA = s.crypto_sign_keypair();
  const key = await deriveSessionKey("pw", SALT);
  const msg = await buildMessage(chatCore(await toB64(idA.publicKey)), idA.privateKey);
  const sealed = await seal(msg, key);
  // no keyEpoch supplied → parses to 0 and opens fine
  const got = await open({ v: 1, roomId: ROOM, seq: 1, tsRelay: "2026-06-11T10:00:00.000Z", ...sealed } as RelayEnvelope, key);
  assert.equal(got.roomId, ROOM);
});
