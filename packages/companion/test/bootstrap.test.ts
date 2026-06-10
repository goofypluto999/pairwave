import { test } from "node:test";
import assert from "node:assert/strict";
import { FloorPolicy } from "@pairwave/protocol";
import type { Message, MessageKind, Origin, Charter } from "@pairwave/protocol";
import { deriveBootstrap, gateSend, computeCharterHash, validateCharterHash } from "../src/bootstrap.js";

let TAG = 0;
type Spec = { kind?: MessageKind; peerId?: string; origin?: Origin; body?: unknown };

function chain(specs: Spec[]): Message[] {
  const tag = `B${TAG++}`;
  return specs.map(
    (sp, i) =>
      ({
        v: 1,
        msgId: `${tag}-${String(i).padStart(4, "0")}`,
        roomId: "room-boot-1",
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

const POLICY = FloorPolicy.parse({});
const charter = (peerId: string, hash: string, state: "propose" | "accept" | "reject"): Spec => ({
  kind: "system.charter",
  peerId,
  body: { proposal: { charterHash: hash }, state },
});
const claim = (peerId: string): Spec => ({ kind: "turn.claim", peerId, body: {} });

test("charter is agreed when both peers accept the same hash", () => {
  const b = deriveBootstrap(chain([charter("A", "H1", "propose"), charter("B", "H1", "accept")]));
  assert.equal(b.charterAgreed, true);
  assert.equal(b.agreedCharterHash, "H1");
});

test("a single proposal is not agreement", () => {
  assert.equal(deriveBootstrap(chain([charter("A", "H1", "propose")])).charterAgreed, false);
});

test("a later reject withdraws agreement", () => {
  const b = deriveBootstrap(
    chain([charter("A", "H1", "propose"), charter("B", "H1", "accept"), charter("B", "H1", "reject")]),
  );
  assert.equal(b.charterAgreed, false);
});

test("substantive sends are gated on SAS + charter, then on the floor", () => {
  const agreed = chain([charter("A", "H1", "propose"), charter("B", "H1", "accept"), claim("A")]);

  assert.equal(
    gateSend(agreed, { sasVerified: false }, { kind: "context", origin: "agent", senderPeerId: "A" }, POLICY).code,
    "unverified",
  );
  assert.equal(
    gateSend(agreed, { sasVerified: true }, { kind: "context", origin: "agent", senderPeerId: "A" }, POLICY).allowed,
    true,
  );
  assert.equal(
    gateSend(agreed, { sasVerified: true }, { kind: "context", origin: "agent", senderPeerId: "B" }, POLICY).code,
    "not_your_turn",
  );

  const noCharter = chain([claim("A")]);
  assert.equal(
    gateSend(noCharter, { sasVerified: true }, { kind: "context", origin: "agent", senderPeerId: "A" }, POLICY).code,
    "no_charter",
  );
  // chat is allowed during negotiation, even unverified
  assert.equal(
    gateSend(noCharter, { sasVerified: false }, { kind: "chat", origin: "agent", senderPeerId: "A" }, POLICY).allowed,
    true,
  );
});

test("computeCharterHash round-trips and detects tampering", async () => {
  const base = {
    charterId: "00000000-0000-0000-0000-000000000000",
    title: "wire the relay",
    purpose: "build pairwave together",
    scope: ["relay"],
    outOfScope: ["prod"],
    mustNots: ["no secrets"],
    responseContract: ["timestamp everything"],
    autoApprove: "none",
    floorPolicy: {},
    liveModePolicy: {},
    participants: [{ peerId: "A", name: "Alice" }],
    createdAt: "2026-06-04T10:00:00.000Z",
  };
  const hash = await computeCharterHash({ ...base, charterHash: "" } as unknown as Charter);
  const good = { ...base, charterHash: hash } as unknown as Charter;
  assert.equal(await validateCharterHash(good), true);
  assert.equal(await validateCharterHash({ ...good, title: "tampered" } as unknown as Charter), false);
});
