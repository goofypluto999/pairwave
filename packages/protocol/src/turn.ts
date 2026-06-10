/**
 * Turn-taking (the floor) + live-mode policy.  (SPEC §7, §4.3)
 *
 * The floor is *authority to push substantive artifacts*, independent of the execution model
 * (async by default, optional bounded live polling). Only the floor-holder's Claude may emit
 * context/code/decision/action.request/summary. Anti-loop guardrails bound agent↔agent exchange.
 */
import { z } from "zod";

/** Carried on every Message so any peer can recompute floor state locally. (SPEC §7.1, §7.4) */
export const TurnMeta = z.object({
  /** Who holds the floor at the moment this message was authored. */
  floor: z.union([z.string(), z.literal("none")]),
  /** Identifies the current turn (changes on each yield/grant). */
  turnId: z.string(),
  /**
   * Consecutive agent→agent hops since the last human message. On reaching FloorPolicy.maxHops the
   * holder MUST yield + request a human ack. Hard-enforced by the Companion. (SPEC §7.3, §8)
   */
  hop: z.number().int().nonnegative(),
});
export type TurnMeta = z.infer<typeof TurnMeta>;

/** Floor guardrails, agreed via the Charter. Defaults chosen to be safe + cheap. (SPEC §7.3) */
export const FloorPolicy = z.object({
  /** Max consecutive agent→agent messages with no human in between. */
  maxHops: z.number().int().positive().default(3),
  /** Soft cap on turns per task before the skill summarizes + asks the humans. */
  maxTurnsPerTask: z.number().int().positive().default(20),
  /** Seconds before an unanswered claim — or an absent holder — auto-yields the floor. */
  claimTimeoutSec: z.number().int().positive().default(60),
  /** Minimum seconds between substantive messages from one peer (flood control). */
  minIntervalSec: z.number().nonnegative().default(2),
});
export type FloorPolicy = z.infer<typeof FloorPolicy>;

/** Opt-in real-time polling, bounded so cost stays visible + capped. (SPEC §4.3) */
export const LiveModePolicy = z.object({
  /** Poll interval in seconds; floored to keep token cost sane. */
  pollSec: z.number().int().min(30).default(30),
  /** Auto-stop live mode after this many minutes. */
  liveModeMaxMinutes: z.number().int().positive().default(20),
  /** Auto-stop after this many consecutive empty polls. */
  idleStopPolls: z.number().int().positive().default(4),
});
export type LiveModePolicy = z.infer<typeof LiveModePolicy>;

/** Local-only runtime state the Companion keeps + exposes to the UI/`pair_status`. Not on the wire. */
export type FloorState = {
  floor: string | "none";
  turnId: string;
  hop: number;
  /** Set when the human is typing on this side → this side's Claude is paused. (SPEC §7.2) */
  localHumanActive: boolean;
  pendingClaimFrom?: string;
  pendingClaimDeadline?: string; // ISO-8601 UTC
};

/** Local-only peer verification state (SAS). Substantive exchange is blocked until "verified". */
export type VerificationState = {
  status: "unverified" | "verified" | "changed";
  /** The SAS words both humans compare out-of-band. (SPEC §10) */
  sasWords: string[];
};
