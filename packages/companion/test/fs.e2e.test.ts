/**
 * Forward secrecy, end to end over a real relay: two runtimes do the ephemeral key exchange, content
 * rides the ephemeral key (epoch 1), and the relay's stored ciphertext CANNOT be opened with the
 * room/passphrase key — only with the ephemeral content key. That's the property "if the passphrase
 * leaks later, recorded traffic stays unreadable".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveSessionKey, open, PairwaveCryptoError } from "@pairwave/protocol";
import { createRelay, type RelayHandle } from "@pairwave/relay/dist/server.js";
import { CompanionRuntime } from "../src/runtime.js";
import { saveConfig, type RoomConfig } from "../src/persist.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000, label = "cond") {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`${label} not met`);
    await wait(40);
  }
}

let relay: RelayHandle;
let dirA: string;
let dirB: string;
let A: CompanionRuntime;
let B: CompanionRuntime;
const roomId = "rm-fs-" + randomBytes(5).toString("hex");
const saltB64 = randomBytes(16).toString("base64");
const passphrase = randomBytes(24).toString("base64url");

before(async () => {
  relay = await createRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  dirA = mkdtempSync(join(tmpdir(), "pw-fs-A-"));
  dirB = mkdtempSync(join(tmpdir(), "pw-fs-B-"));
  const cfg = (peerId: string, name: string): RoomConfig => ({ v: 1, roomId, relayUrl: url, saltB64, passphrase, peerId, name });
  saveConfig(dirA, cfg("p-a", "Alice"));
  saveConfig(dirB, cfg("p-b", "Bob"));
  A = await CompanionRuntime.boot(dirA);
  B = await CompanionRuntime.boot(dirB);
  A.start();
  B.start();
});

after(async () => {
  await A?.shutdown().catch(() => {});
  await B?.shutdown().catch(() => {});
  await relay?.close();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("ephemeral keypair is created and persisted per room", () => {
  assert.ok(existsSync(join(A.store.roomDir, "ephemeral.json")));
  assert.ok(existsSync(join(B.store.roomDir, "ephemeral.json")));
});

test("the key exchange completes over the wire — both sides go forward-secret", async () => {
  await until(() => A.fsActive() && B.fsActive(), 9000, "content key derived on both sides");
  assert.equal(A.fsActive(), true);
  assert.equal(B.fsActive(), true);
});

test("content is sealed with the ephemeral key (epoch 1), unreadable by the passphrase key", async () => {
  await until(() => A.fsActive() && B.fsActive(), 9000, "fs ready");
  const r = await A.send("chat", { text: "this must be forward-secret" }, "human");
  assert.ok(r.ok);

  // It crosses to B (proves the content key works end to end)...
  await until(() => B.core.messages().some((m) => m.kind === "chat" && (m.body).text === "this must be forward-secret"), 9000, "B received");

  // ...and the relay's stored ciphertext for it is epoch 1 and CANNOT be opened with the room key.
  const stored = relay.store.since(roomId, 0, 200).filter((e) => e.keyEpoch === 1);
  assert.ok(stored.length >= 1, "there must be at least one epoch-1 (content) envelope");
  const roomKey = await deriveSessionKey(passphrase, Buffer.from(saltB64, "base64"));
  await assert.rejects(
    open(stored[stored.length - 1], roomKey),
    (e) => e instanceof PairwaveCryptoError && e.code === "decrypt_failed",
    "passphrase key must NOT open forward-secret content",
  );
});

test("the handshake (system.hello) stays on the room key (epoch 0)", () => {
  const epoch0 = relay.store.since(roomId, 0, 200).filter((e) => e.keyEpoch === 0);
  assert.ok(epoch0.length >= 1, "hellos/handshake ride epoch 0");
});
