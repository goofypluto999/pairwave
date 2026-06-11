import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  deriveSessionKey,
  generateIdentity,
  buildMessage,
  seal,
  open,
  toB64,
  type MessageCore,
} from "@pairwave/protocol";
import { createRelay, type RelayHandle, type RelayOptions } from "../src/server.js";

const SALT = new Uint8Array(16);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal WS test client that buffers server frames and lets tests await ones it cares about. */
class TestClient {
  frames: any[] = [];
  private listeners = new Set<() => void>();
  private constructor(public ws: WebSocket) {}

  static open(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new TestClient(ws);
      ws.on("message", (d) => {
        try {
          c.frames.push(JSON.parse(d.toString()));
        } catch {
          return;
        }
        for (const l of [...c.listeners]) l();
      });
      ws.on("open", () => resolve(c));
      ws.on("error", reject);
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  wait(pred: (f: any) => boolean, ms = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const tryIt = () => {
        const f = this.frames.find(pred);
        if (f) {
          cleanup();
          resolve(f);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for frame"));
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(tryIt);
      };
      this.listeners.add(tryIt);
      tryIt();
    });
  }

  waitN(pred: (f: any) => boolean, n: number, ms = 3000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const matched = this.frames.filter(pred);
        if (matched.length >= n) {
          cleanup();
          resolve(matched.slice(0, n));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout: got ${this.frames.filter(pred).length}/${n}`));
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function withRelay(fn: (relay: RelayHandle, url: string) => Promise<void>, opts: RelayOptions = {}) {
  const relay = await createRelay(opts);
  try {
    await fn(relay, `ws://127.0.0.1:${relay.port}`);
  } finally {
    await relay.close();
  }
}

function chatCore(roomId: string, pub: string, text: string): MessageCore {
  return {
    v: 1,
    msgId: randomUUID(),
    roomId,
    sender: { peerId: "A", name: "Alice", pubKey: pub },
    ts: "2026-06-04T10:00:00.000Z",
    parents: [],
    turn: { floor: "A", turnId: "t1", hop: 0 },
    origin: "agent",
    kind: "chat",
    body: { text },
  } as MessageCore;
}

test("E2E survives a round-trip through the relay, and the relay holds only ciphertext", async () => {
  await withRelay(async (relay, url) => {
    const roomId = "room-e2e-01";
    const a = await TestClient.open(url);
    const b = await TestClient.open(url);
    a.send({ t: "join", roomId, peerId: "A" });
    b.send({ t: "join", roomId, peerId: "B" });
    await a.wait((f) => f.t === "welcome");
    await b.wait((f) => f.t === "welcome");

    const key = await deriveSessionKey("shared room passphrase", SALT);
    const id = await generateIdentity();
    const pub = await toB64(id.publicKey);
    const msg = await buildMessage(chatCore(roomId, pub, "hello via relay"), id.secretKey);
    const sealed = await seal(msg, key);

    a.send({ t: "publish", env: { v: 1, roomId, nonce: sealed.nonce, ciphertext: sealed.ciphertext } });

    const got = await b.wait((f) => f.t === "envelope");
    assert.equal(got.env.seq, 1);
    assert.ok(typeof got.env.tsRelay === "string");
    assert.equal(got.env.ciphertext, sealed.ciphertext); // relay passed it through untouched

    // The receiver can decrypt with the key — proving E2E is intact through a real relay.
    const opened = await open(got.env, key);
    assert.equal(opened.msgId, msg.msgId);
    assert.equal((opened.body as { text: string }).text, "hello via relay");

    // The relay's store has ONLY envelope fields — no plaintext, and the key never reached it.
    const stored = relay.store.since(roomId, 0, 10);
    assert.equal(stored.length, 1);
    assert.deepEqual(Object.keys(stored[0]!).sort(), [
      "ciphertext",
      "keyEpoch",
      "nonce",
      "roomId",
      "seq",
      "tsRelay",
      "v",
    ]);
    const decoded = Buffer.from(stored[0]!.ciphertext, "base64").toString("utf8");
    assert.ok(!decoded.includes("hello via relay"), "plaintext must not be recoverable from the relay");

    a.close();
    b.close();
  });
});

test("relay assigns monotonic seq and replays history over REST", async () => {
  await withRelay(async (relay, url) => {
    const roomId = "room-seq-01";
    const a = await TestClient.open(url);
    a.send({ t: "join", roomId, peerId: "A" });
    await a.wait((f) => f.t === "welcome");

    const key = await deriveSessionKey("pw", SALT);
    const id = await generateIdentity();
    const pub = await toB64(id.publicKey);
    for (let i = 0; i < 3; i++) {
      const m = await buildMessage(chatCore(roomId, pub, `m${i}`), id.secretKey);
      const s = await seal(m, key);
      a.send({ t: "publish", env: { v: 1, roomId, nonce: s.nonce, ciphertext: s.ciphertext } });
    }

    const envs = await a.waitN((f) => f.t === "envelope", 3);
    assert.deepEqual(envs.map((f) => f.env.seq), [1, 2, 3]);

    const res = await fetch(`http://127.0.0.1:${relay.port}/rooms/${roomId}/messages?sinceSeq=1`);
    const arr = (await res.json()) as Array<{ seq: number }>;
    assert.deepEqual(arr.map((e) => e.seq), [2, 3]); // sinceSeq is exclusive

    a.close();
  });
});

test("presence flips on join and disconnect (1 → 2 → 1)", async () => {
  await withRelay(async (_relay, url) => {
    const roomId = "room-pres-1";
    const a = await TestClient.open(url);
    a.send({ t: "join", roomId, peerId: "A" });
    await a.wait((f) => f.t === "welcome");

    const b = await TestClient.open(url);
    b.send({ t: "join", roomId, peerId: "B" });
    await b.wait((f) => f.t === "welcome");

    b.close();

    const presences = await a.waitN((f) => f.t === "control" && f.frame.type === "presence", 3, 4000);
    assert.deepEqual(presences.map((f) => f.frame.peerCount), [1, 2, 1]);

    a.close();
  });
});

test("burn purges a room's history", async () => {
  await withRelay(async (relay, url) => {
    const roomId = "room-burn-1";
    const a = await TestClient.open(url);
    a.send({ t: "join", roomId, peerId: "A" });
    await a.wait((f) => f.t === "welcome");

    const key = await deriveSessionKey("pw", SALT);
    const id = await generateIdentity();
    const pub = await toB64(id.publicKey);
    const m = await buildMessage(chatCore(roomId, pub, "x"), id.secretKey);
    const s = await seal(m, key);
    a.send({ t: "publish", env: { v: 1, roomId, nonce: s.nonce, ciphertext: s.ciphertext } });
    await a.wait((f) => f.t === "envelope");

    a.send({ t: "burn", roomId });
    a.send({ t: "ping" }); // same-socket ordering: pong implies burn was processed first
    await a.wait((f) => f.t === "control" && f.frame.type === "pong");

    const res = await fetch(`http://127.0.0.1:${relay.port}/rooms/${roomId}/messages?sinceSeq=0`);
    const arr = (await res.json()) as unknown[];
    assert.equal(arr.length, 0);

    a.close();
  });
});

test("malformed input is rejected with an error frame", async () => {
  await withRelay(async (_relay, url) => {
    const a = await TestClient.open(url);
    a.sendRaw("this is not json");
    await a.wait((f) => f.t === "error" && f.code === "bad_json");
    a.send({ t: "totally-unknown-frame" });
    await a.wait((f) => f.t === "error" && f.code === "bad_frame");
    a.close();
  });
});

test("a third peer is refused (v1 rooms are 2-party)", async () => {
  await withRelay(async (_relay, url) => {
    const roomId = "room-cap-01";
    const a = await TestClient.open(url);
    const b = await TestClient.open(url);
    const c = await TestClient.open(url);
    a.send({ t: "join", roomId, peerId: "A" });
    await a.wait((f) => f.t === "welcome");
    b.send({ t: "join", roomId, peerId: "B" });
    await b.wait((f) => f.t === "welcome");
    c.send({ t: "join", roomId, peerId: "C" });
    const err = await c.wait((f) => f.t === "error");
    assert.equal(err.code, "room_full");
    a.close();
    b.close();
    c.close();
  });
});
