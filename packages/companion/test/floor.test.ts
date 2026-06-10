import { test } from "node:test";
import assert from "node:assert/strict";
import { FloorPolicy } from "@pairwave/protocol";
import type { Message, MessageKind, Origin } from "@pairwave/protocol";
import { deriveFloor, evaluateSend, isHopCounting } from "../src/floor.js";

let TAG = 0;
type Spec = { kind?: MessageKind; origin?: Origin; peerId?: string; body?: unknown };

/** Build a linked chain of messages (real crypto not needed — floor logic reads kind/origin/body). */
function chain(specs: Spec[]): Message[] {
  const tag = `c${TAG++}`;
  return specs.map(
    (sp, i) =>
      ({
        v: 1,
        msgId: `${tag}-${String(i).padStart(4, "0")}`,
        roomId: "room-floor-1",
        sender: { peerId: sp.peerId ?? "A", name: sp.peerId ?? "A", pubKey: "AA==" },
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

const POLICY = FloorPolicy.parse({ maxHops: 3 });
const claim = (peerId: string): Spec => ({ kind: "turn.claim", peerId, body: {} });
const yieldTo = (peerId: string, to: string): Spec => ({ kind: "turn.yield", peerId, body: { to } });
const chat = (peerId: string, origin: Origin = "agent"): Spec => ({ kind: "chat", peerId, origin });

test("control frames don't count toward hops; chats do", () => {
  assert.equal(isHopCounting("turn.claim"), false);
  assert.equal(isHopCounting("system.charter"), false);
  assert.equal(isHopCounting("chat"), true);
  assert.equal(isHopCounting("context"), true);
});

test("action.result is a receipt — never hop-counted, never hop-blocked (no receipt deadlock)", () => {
  assert.equal(isHopCounting("action.result"), false);
  const v = deriveFloor(chain([claim("A"), chat("A"), chat("B"), chat("A")])); // at the cap (hop 3)
  assert.equal(evaluateSend(v, { kind: "action.result", origin: "agent", senderPeerId: "B" }, POLICY).allowed, true);
});

test("claiming a free floor takes it", () => {
  assert.equal(deriveFloor(chain([claim("A")])).floor, "A");
});

test("the holder yields the floor to its peer", () => {
  assert.equal(deriveFloor(chain([claim("A"), yieldTo("A", "B")])).floor, "B");
});

test("only the floor-holder may push floor-only kinds", () => {
  const v = deriveFloor(chain([claim("A")]));
  assert.equal(evaluateSend(v, { kind: "context", origin: "agent", senderPeerId: "B" }, POLICY).allowed, false);
  assert.equal(evaluateSend(v, { kind: "context", origin: "agent", senderPeerId: "A" }, POLICY).allowed, true);
});

test("maxHops blocks agents; humans are never hop-blocked; a human message resets", () => {
  const v = deriveFloor(chain([claim("A"), chat("A"), chat("B"), chat("A")])); // 3 agent chats
  assert.equal(v.hop, 3);
  assert.equal(evaluateSend(v, { kind: "chat", origin: "agent", senderPeerId: "A" }, POLICY).allowed, false);
  assert.equal(evaluateSend(v, { kind: "chat", origin: "human", senderPeerId: "A" }, POLICY).allowed, true);

  const v2 = deriveFloor(chain([claim("A"), chat("A"), chat("B"), chat("A"), chat("A", "human")]));
  assert.equal(v2.hop, 0);
  assert.equal(evaluateSend(v2, { kind: "chat", origin: "agent", senderPeerId: "A" }, POLICY).allowed, true);
});

test("a yield from a non-holder is rejected and does not move the floor", () => {
  assert.equal(deriveFloor(chain([claim("A"), yieldTo("B", "none")])).floor, "A");
  const live = deriveFloor(chain([claim("A")]));
  assert.equal(evaluateSend(live, { kind: "turn.yield", origin: "agent", senderPeerId: "B" }, POLICY).allowed, false);
});

test("claiming an occupied floor records a pending claim", () => {
  const v = deriveFloor(chain([claim("A"), claim("B")]));
  assert.equal(v.floor, "A");
  assert.equal(v.pendingClaim, "B");
});

test("claiming a floor you already hold is rejected", () => {
  const v = deriveFloor(chain([claim("A")]));
  assert.equal(evaluateSend(v, { kind: "turn.claim", origin: "agent", senderPeerId: "A" }, POLICY).allowed, false);
});

// ── claim-timeout auto-grant (SPEC §7.2) ──
// chain() stamps ts at 1-second steps; with claimTimeoutSec=2 the deadline is small enough to test.
const FAST = FloorPolicy.parse({ claimTimeoutSec: 2 });

test("a pending claim does NOT transfer before the timeout", () => {
  const msgs = chain([claim("A"), claim("B")]); // B claims at t=1s
  const v = deriveFloor(msgs, FAST, "2026-06-04T10:00:02.500Z"); // 1.5s after the claim
  assert.equal(v.floor, "A");
  assert.equal(v.pendingClaim, "B");
});

test("a pending claim auto-grants once 'now' passes the deadline (send-side view)", () => {
  const msgs = chain([claim("A"), claim("B")]); // B claims at t=1s, deadline t=3s
  const v = deriveFloor(msgs, FAST, "2026-06-04T10:00:03.100Z");
  assert.equal(v.floor, "B");
  assert.equal(v.pendingClaim, undefined);
});

test("a later signed message past the deadline grants the claim for BOTH sides (log-driven)", () => {
  // B claims at t=1s; A chats at t=5s (past deadline) → the transfer happens before that chat folds.
  const msgs = chain([claim("A"), claim("B"), {}, {}, chat("A")]); // chat("A") lands at t=4s... use explicit 5th index = t=4s; deadline=3s ✓
  const v = deriveFloor(msgs, FAST);
  assert.equal(v.floor, "B");
});

test("yielding to none while a claim is pending grants the claimant immediately", () => {
  const msgs = chain([claim("A"), claim("B"), yieldTo("A", "none")]);
  const v = deriveFloor(msgs, FAST, "2026-06-04T10:00:02.200Z"); // before the timeout — yield does it
  assert.equal(v.floor, "B");
});
