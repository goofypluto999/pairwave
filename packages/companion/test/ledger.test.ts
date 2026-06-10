import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, MessageKind, Origin } from "@pairwave/protocol";
import { deriveLedger } from "../src/ledger.js";

let TAG = 0;
type Spec = { kind?: MessageKind; peerId?: string; origin?: Origin; msgId?: string; body?: unknown };

function chain(specs: Spec[]): Message[] {
  const tag = `L${TAG++}`;
  return specs.map(
    (sp, i) =>
      ({
        v: 1,
        msgId: sp.msgId ?? `${tag}-${String(i).padStart(4, "0")}`,
        roomId: "room-ledger-1",
        sender: { peerId: sp.peerId ?? "A", name: sp.peerId === "B" ? "Bob" : "Alice", pubKey: "AA==" },
        origin: sp.origin ?? "agent",
        ts: `2026-06-04T10:00:${String(i).padStart(2, "0")}.000Z`,
        parents: i ? [`${tag}-h${i - 1}`] : [],
        hash: `${tag}-h${i}`,
        sig: "AA==",
        turn: { floor: "none", turnId: "t0", hop: 0 },
        kind: sp.kind ?? "chat",
        body: sp.body ?? { text: "x" },
      }) as Message,
  );
}

const SESSION: Spec[] = [
  { kind: "turn.claim", peerId: "A", body: {} },
  { kind: "context", peerId: "A", body: { headline: "design locked", text: "decided the schema" } },
  { kind: "decision", peerId: "A", body: { headline: "use Postgres", decision: "use Postgres for storage" } },
  { kind: "question", peerId: "B", msgId: "Q1", body: { text: "why Postgres over SQLite?" } },
  { kind: "code", peerId: "A", body: { headline: "schema.sql", language: "sql", isPatch: false, content: "create table..." } },
  { kind: "action.request", peerId: "B", msgId: "R1", body: { action: "apply_patch", summary: "apply schema", risk: "low", payload: "diff" } },
];

test("ledger reflects floor, headlines, decisions, artifacts, participants, and counts", () => {
  const l = deriveLedger(chain(SESSION));
  assert.equal(l.floor, "A");
  assert.equal(l.headlines.length, 3); // context + decision + code
  assert.equal(l.decisions.length, 1);
  assert.equal(l.decisions[0]!.decision, "use Postgres for storage");
  assert.equal(l.sharedArtifacts.length, 1);
  assert.equal(l.sharedArtifacts[0]!.language, "sql");
  assert.equal(l.participants.length, 2); // A and B
  assert.equal(l.counts.messages, 6);
  assert.equal(l.lastActivityTs, "2026-06-04T10:00:05.000Z");
});

test("open questions and pending actions clear when answered/resolved", () => {
  const open = deriveLedger(chain(SESSION));
  assert.equal(open.openQuestions.length, 1);
  assert.equal(open.pendingActions.length, 1);

  const resolved = deriveLedger(
    chain([
      ...SESSION,
      { kind: "answer", peerId: "A", body: { answersMsgId: "Q1", text: "better concurrency" } },
      { kind: "action.result", peerId: "A", body: { requestMsgId: "R1", ok: true } },
    ]),
  );
  assert.equal(resolved.openQuestions.length, 0);
  assert.equal(resolved.pendingActions.length, 0);
});
