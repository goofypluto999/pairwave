/**
 * Floor state machine + hard enforcement.  (SPEC §7, §8)
 *
 * Design commitments:
 *  1. Floor state is a PURE FUNCTION of the message log (§7.4) — replay `turn.*` in DAG order and
 *     both peers converge on the same floor without a central authority.
 *  2. Structural rules are HARD-enforced here (§8): out-of-turn pushes, the anti-loop hop cap, and
 *     invalid yields/claims are rejected — not merely discouraged by the skill.
 *  3. Claim timeout (§7.2) is ALSO deterministic: a pending claim auto-grants once any later
 *     timestamp (a subsequent message's `ts`, or the caller-supplied `nowIso` when evaluating a
 *     send) passes claimTs + claimTimeoutSec. Both sides converge because the granting timestamp
 *     is in the signed log itself.
 */
import { topoOrder, FLOOR_ONLY_KINDS, FloorPolicy as FloorPolicySchema } from "@pairwave/protocol";
import type { Message, MessageKind, FloorPolicy, Origin } from "@pairwave/protocol";

/**
 * Kinds that do NOT count toward the agent→agent hop streak: control + session frames, plus
 * `action.result` — a receipt for a human-approved action, not autonomous chatter. Blocking the
 * receipt would deadlock the requester (the e2e proved it); loops stay impossible because the
 * `action.request` side still counts toward the cap.
 */
const NON_HOP_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  "turn.yield",
  "turn.claim",
  "system.hello",
  "system.charter",
  "system.bye",
  "action.result",
  // git coordination is logistics, not conversation — it must not burn the agent hop budget.
  "git.context",
  "git.claim",
  "git.release",
  "git.commit",
]);

export function isHopCounting(kind: MessageKind): boolean {
  return !NON_HOP_KINDS.has(kind);
}

export type FloorView = {
  floor: string | "none";
  turnId: string;
  /** Consecutive agent-authored (hop-counting) messages since the last human one. */
  hop: number;
  /** A peer waiting for the floor while another holds it (auto-grants after claimTimeoutSec). */
  pendingClaim?: string | undefined;
  /** ISO ts of the pending claim, if any. */
  pendingClaimTs?: string | undefined;
  lastSenderPeerId?: string | undefined;
};

const DEFAULT_POLICY = FloorPolicySchema.parse({});

/**
 * Replay the log (DAG order) into the current floor view. Pure + deterministic.
 * `nowIso` (optional) lets a send-side caller apply claim-timeout expiry "as of now" — the result
 * still converges across peers because the message that gets emitted carries that timestamp.
 */
export function deriveFloor(messages: Message[], policy: FloorPolicy = DEFAULT_POLICY, nowIso?: string): FloorView {
  let floor: string | "none" = "none";
  let turnSeq = 0;
  let turnId = "t0";
  let hop = 0;
  let pendingClaim: string | undefined;
  let pendingClaimAtMs = 0;
  let lastSenderPeerId: string | undefined;

  const timeoutMs = policy.claimTimeoutSec * 1000;

  const expireClaim = (atMs: number): void => {
    if (pendingClaim !== undefined && atMs >= pendingClaimAtMs + timeoutMs) {
      floor = pendingClaim;
      pendingClaim = undefined;
      turnId = `t${++turnSeq}`;
    }
  };

  for (const m of topoOrder(messages)) {
    // A pending claim expires the moment any later signed timestamp passes the deadline.
    expireClaim(Date.parse(m.ts));

    if (isHopCounting(m.kind)) hop = m.origin === "human" ? 0 : hop + 1;

    if (m.kind === "turn.yield") {
      if (floor === m.sender.peerId) {
        floor = m.body.to;
        turnId = `t${++turnSeq}`;
        // Yielding to nobody while someone is waiting → the waiter gets it immediately.
        if (floor === "none" && pendingClaim !== undefined) {
          floor = pendingClaim;
          pendingClaim = undefined;
          turnId = `t${++turnSeq}`;
        } else if (floor === pendingClaim) {
          pendingClaim = undefined;
        }
      }
      // a yield from a non-holder is invalid → ignored
    } else if (m.kind === "turn.claim") {
      if (floor === "none") {
        floor = m.sender.peerId; // claim a free floor
        pendingClaim = undefined;
        turnId = `t${++turnSeq}`;
      } else if (floor !== m.sender.peerId) {
        pendingClaim = m.sender.peerId; // contested → wait for yield or timeout
        pendingClaimAtMs = Date.parse(m.ts);
      }
      // claim by the current holder → no-op
    }

    lastSenderPeerId = m.sender.peerId;
  }

  if (nowIso !== undefined) expireClaim(Date.parse(nowIso));

  return {
    floor,
    turnId,
    hop,
    pendingClaim,
    pendingClaimTs: pendingClaim !== undefined ? new Date(pendingClaimAtMs).toISOString() : undefined,
    lastSenderPeerId,
  };
}

export type Prospective = {
  kind: MessageKind;
  origin: Origin;
  senderPeerId: string;
};

export type SendDecision = { allowed: boolean; code?: string; reason?: string };

/**
 * Decide whether a prospective outbound message is allowed RIGHT NOW. The Companion calls this
 * before sealing/sending; a denial returns an error to the tool caller instead of emitting anything.
 */
export function evaluateSend(view: FloorView, p: Prospective, policy: FloorPolicy): SendDecision {
  // Anti-loop: agents may not keep talking once the hop cap is hit — a human must intervene or yield.
  if (p.origin === "agent" && isHopCounting(p.kind) && view.hop >= policy.maxHops) {
    return {
      allowed: false,
      code: "max_hops",
      reason: `hop limit ${policy.maxHops} reached — a human must send a message, or yield the floor`,
    };
  }
  // Floor-only kinds require holding the floor.
  if (FLOOR_ONLY_KINDS.includes(p.kind) && view.floor !== p.senderPeerId) {
    return { allowed: false, code: "not_your_turn", reason: "only the floor-holder may send this kind" };
  }
  // You can only yield a floor you hold.
  if (p.kind === "turn.yield" && view.floor !== p.senderPeerId) {
    return { allowed: false, code: "not_holder", reason: "cannot yield a floor you don't hold" };
  }
  // No point claiming a floor you already hold.
  if (p.kind === "turn.claim" && view.floor === p.senderPeerId) {
    return { allowed: false, code: "already_holder", reason: "you already hold the floor" };
  }
  return { allowed: true };
}
