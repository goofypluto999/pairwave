import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, MessageKind, Origin } from "@pairwave/protocol";
import { deriveBrain, recallBrain } from "../src/brain.js";

let TAG = 0;
type Spec = { kind?: MessageKind; peerId?: string; origin?: Origin; msgId?: string; body?: unknown };

function chain(specs: Spec[]): Message[] {
  const tag = `BR${TAG++}`;
  return specs.map(
    (sp, i) =>
      ({
        v: 1,
        msgId: sp.msgId ?? `${tag}-${String(i).padStart(4, "0")}`,
        roomId: "room-brain-1",
        sender: { peerId: sp.peerId ?? "A", name: sp.peerId === "B" ? "Bob" : "Alice", pubKey: "AA==" },
        origin: sp.origin ?? "agent",
        ts: `2026-06-10T10:00:${String(i).padStart(2, "0")}.000Z`,
        parents: i ? [`${tag}-h${i - 1}`] : [],
        hash: `${tag}-h${i}`,
        sig: "AA==",
        turn: { floor: "none", turnId: "t0", hop: 0 },
        kind: sp.kind ?? "chat",
        body: sp.body ?? { text: "x" },
      }) as Message,
  );
}

const entry = (peerId: string, msgId: string, headline: string, content: string, tags: string[] = [], extra: object = {}): Spec => ({
  kind: "brain.entry",
  peerId,
  msgId,
  body: { headline, content, tags, entryKind: "fact", ...extra },
});

test("brain folds entries from both peers; counts are right", () => {
  const b = deriveBrain(
    chain([
      entry("A", "00000000-0000-0000-0000-00000000000a", "API base url", "https://api.example.com/v2", ["api"]),
      entry("B", "00000000-0000-0000-0000-00000000000b", "Auth header", "Use X-Api-Key, not Bearer", ["api", "auth"]),
      { kind: "chat" },
    ]),
  );
  assert.equal(b.counts.total, 2);
  assert.equal(b.counts.byPeer.A, 1);
  assert.equal(b.counts.byPeer.B, 1);
});

test("supersedes replaces the old entry — overlap-free by construction", () => {
  const oldId = "00000000-0000-0000-0000-00000000000a";
  const b = deriveBrain(
    chain([
      entry("A", oldId, "DB choice", "We use SQLite"),
      entry("B", "00000000-0000-0000-0000-00000000000b", "DB choice", "We use Postgres now", [], { supersedes: oldId }),
    ]),
  );
  assert.equal(b.counts.total, 1);
  assert.equal(b.entries[0]!.content, "We use Postgres now");
});

test("recall ranks headline > tags > content and respects filters + limit", () => {
  const view = deriveBrain(
    chain([
      entry("A", "00000000-0000-0000-0000-000000000001", "postgres connection string", "lives in env", ["db"]),
      entry("A", "00000000-0000-0000-0000-000000000002", "Deploy steps", "first migrate postgres then restart", ["ops"]),
      entry("B", "00000000-0000-0000-0000-000000000003", "Frontend theme", "dark only", ["ui"]),
    ]),
  );
  const hits = recallBrain(view, "postgres");
  assert.equal(hits[0]!.msgId, "00000000-0000-0000-0000-000000000001"); // headline match outranks content match
  assert.equal(hits.length, 2); // theme entry doesn't match at all
  assert.equal(recallBrain(view, "postgres", { tags: ["ops"] }).length, 1);
  assert.equal(recallBrain(view, "", { limit: 2 }).length, 2); // empty query lists entries
});

test("recall is deterministic regardless of input order", () => {
  const msgs = chain([
    entry("A", "00000000-0000-0000-0000-000000000001", "alpha fact", "shared token alpha"),
    entry("B", "00000000-0000-0000-0000-000000000002", "beta fact", "shared token beta"),
    entry("A", "00000000-0000-0000-0000-000000000003", "gamma fact", "shared token gamma"),
  ]);
  const a = recallBrain(deriveBrain(msgs), "shared token").map((h) => h.msgId);
  const b = recallBrain(deriveBrain([...msgs].reverse()), "shared token").map((h) => h.msgId);
  assert.deepEqual(a, b);
});
