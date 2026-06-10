/**
 * Message — the encrypted, signed payload inside a RelayEnvelope.  (SPEC §5.2–§5.3)
 *
 * Decrypted AND verified (signature + DAG link) by the receiving Companion before the UI or Claude
 * ever sees it. Every message is timestamped (UTC), attributed (Ed25519 pubKey), labelled by
 * `origin` (human vs agent), and linked to its `parents` (the hash-DAG, SPEC §5.4). These Zod
 * schemas are the runtime gate: anything that fails to parse is rejected as malformed or forged.
 */
import { z } from "zod";
import { Base64 } from "./envelope.js";
import { TurnMeta, FloorPolicy, LiveModePolicy } from "./turn.js";

export const PeerRef = z.object({
  peerId: z.string().min(1),
  name: z.string().min(1),
  /** Long-lived Ed25519 identity public key, pinned for the peer after SAS verification. (SPEC §10) */
  pubKey: Base64,
});
export type PeerRef = z.infer<typeof PeerRef>;

/** Who authored a message on the sending side. Drives the anti-loop hop counter. (SPEC §7.3) */
export const Origin = z.enum(["human", "agent"]);
export type Origin = z.infer<typeof Origin>;

/** How a claim is tagged in curated context/code. (SPEC §6.2 response contract) */
export const Claimedness = z.enum(["fact", "inference", "assumption"]);

/** Provenance for curated artifacts — name the source. (SPEC §6.2) */
export const Provenance = z.object({
  file: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  note: z.string().optional(),
});

/** Sender-written one-liner so the free Activity Ledger has real topic lines at no extra cost. (§9.3) */
const Headline = z.string().max(80);

// ───────────────────────── Charter (SPEC §6) ─────────────────────────

export const AutoApprove = z.enum(["none", "low", "all"]);

export const Charter = z.object({
  charterId: z.string().uuid(),
  title: z.string().min(1),
  purpose: z.string().min(1),
  scope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  /** Hard rules / limits both Claudes must obey (skill-enforced, soft — SPEC §8). */
  mustNots: z.array(z.string()).default([]),
  /** The response-format rules loaded into both Claudes. */
  responseContract: z.array(z.string()).default([]),
  autoApprove: AutoApprove.default("none"),
  floorPolicy: FloorPolicy.default({}),
  liveModePolicy: LiveModePolicy.default({}),
  participants: z.array(z.object({ peerId: z.string(), name: z.string() })),
  createdAt: z.string().datetime(),
  /** Hash of the canonicalized charter; both sides MUST match before substantive messaging. */
  charterHash: Base64,
});
export type Charter = z.infer<typeof Charter>;

// ───────────────────────── Action requests (SPEC §9.1–§9.2) ─────────────────────────

/** Every action.request maps to one of these; each is gated by the permission popup (Gate 1). */
export const ActionKind = z.enum([
  "apply_patch", // apply a unified diff to the working tree (via the RECEIVER's Claude — Gate 2)
  "write_file", // create/overwrite a file with given content (via the receiver's Claude — Gate 2)
  "run_command", // suggested command; never run by the Companion — surfaced to the receiver
  "fetch_url", // network fetch
]);

export const RiskLevel = z.enum(["low", "medium", "high"]);

/** Inferred types for cross-package use. */
export type ActionKind = z.infer<typeof ActionKind>;
export type RiskLevel = z.infer<typeof RiskLevel>;
export type AutoApprove = z.infer<typeof AutoApprove>;

// ───────────────────────── Message bodies, per kind ─────────────────────────

const ChatBody = z.object({ text: z.string() });

const ContextBody = z.object({
  headline: Headline,
  text: z.string(),
  claim: Claimedness.default("inference"),
  provenance: z.array(Provenance).default([]),
});

/** Inert code artifact. Stored in quarantine on receipt; NEVER auto-applied. (SPEC §9.2) */
const CodeBody = z.object({
  headline: Headline,
  language: z.string().default("text"),
  /** Optional hint only — applying still requires an action.request + both gates. */
  pathHint: z.string().optional(),
  content: z.string(),
  /** If true, `content` is a unified diff rather than a whole file. */
  isPatch: z.boolean().default(false),
  provenance: z.array(Provenance).default([]),
});

const DecisionBody = z.object({
  headline: Headline,
  decision: z.string(),
  rationale: z.string().optional(),
  /** msgIds this decision supersedes, if any. */
  supersedes: z.array(z.string().uuid()).default([]),
});

const QuestionBody = z.object({ text: z.string(), toPeerId: z.string().optional() });
const AnswerBody = z.object({ text: z.string(), answersMsgId: z.string().uuid() });

const ActionRequestBody = z.object({
  action: ActionKind,
  risk: RiskLevel,
  /** Human-readable summary shown in the permission popup. */
  summary: z.string(),
  /** The exact payload to be approved (diff text, file content, command string, or URL). */
  payload: z.string(),
  targetPath: z.string().optional(),
  /** References a quarantined code artifact this action would apply, if any. */
  fromCodeMsgId: z.string().uuid().optional(),
});

const ActionResultBody = z.object({
  requestMsgId: z.string().uuid(),
  ok: z.boolean(),
  detail: z.string().optional(),
});

const TurnYieldBody = z.object({ to: z.union([z.string(), z.literal("none")]) });
const TurnClaimBody = z.object({ reason: z.string().optional() });

const SummaryBody = z.object({
  /** "ledger" = the cheap structured snapshot; "narrative" = a Claude-written prose recap. (§9.3) */
  mode: z.enum(["ledger", "narrative"]),
  headlines: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  text: z.string().optional(),
});

const HelloBody = z.object({
  peer: PeerRef,
  /** Free-form capability/agent info (model, project name, etc.). */
  capabilities: z.record(z.string(), z.unknown()).default({}),
});

const CharterBody = z.object({
  proposal: Charter,
  /** "propose" | "accept" | "reject" with optional edits described in `note`. */
  state: z.enum(["propose", "accept", "reject"]),
  note: z.string().optional(),
});

const ByeBody = z.object({ reason: z.string().optional() });

/**
 * Shared-brain entry — durable knowledge BOTH Claudes write into and recall from.  (SPEC §9.5)
 * Not floor-gated (either side may contribute anytime) but requires SAS + charter, and counts
 * toward the agent hop cap so it cannot fuel runaway loops. Supersession keeps it overlap-free.
 */
const BrainEntryBody = z.object({
  headline: Headline,
  content: z.string(),
  tags: z.array(z.string()).default([]),
  entryKind: z.enum(["fact", "decision", "snippet", "link", "insight"]).default("fact"),
  /** msgId of an earlier brain.entry this one replaces (keeps the brain deduplicated). */
  supersedes: z.string().uuid().optional(),
});

// ───────────────────────── Discriminated union of all kinds ─────────────────────────

/** Common header on every message. (SPEC §5.2) */
const Header = {
  v: z.literal(1),
  msgId: z.string().uuid(),
  roomId: z.string().min(8),
  sender: PeerRef,
  /** Who authored this on the sending side — drives the anti-loop hop counter. (SPEC §7.3) */
  origin: Origin,
  /** ISO-8601 UTC — REQUIRED on every message. (the "always attach time and dates" rule) */
  ts: z.string().datetime(),
  tsMono: z.number().int().nonnegative().optional(),
  /** Hashes of the message(s) this one builds on. Usually one; >1 merges a fork. (SPEC §5.4) */
  parents: z.array(Base64),
  /** H(canonical(message without `hash` and `sig`)). */
  hash: Base64,
  /** Ed25519 signature over `hash` by the sender. */
  sig: Base64,
  turn: TurnMeta,
};

function msg<K extends string, B extends z.ZodTypeAny>(kind: K, body: B) {
  return z.object({ ...Header, kind: z.literal(kind), body });
}

export const Message = z.discriminatedUnion("kind", [
  msg("system.hello", HelloBody),
  msg("system.charter", CharterBody),
  msg("system.bye", ByeBody),
  msg("chat", ChatBody),
  msg("context", ContextBody),
  msg("code", CodeBody),
  msg("decision", DecisionBody),
  msg("question", QuestionBody),
  msg("answer", AnswerBody),
  msg("action.request", ActionRequestBody),
  msg("action.result", ActionResultBody),
  msg("turn.yield", TurnYieldBody),
  msg("turn.claim", TurnClaimBody),
  msg("summary", SummaryBody),
  msg("brain.entry", BrainEntryBody),
]);
export type Message = z.infer<typeof Message>;
export type MessageKind = Message["kind"];

/** Kinds only the floor-holder may emit autonomously — hard-enforced by the Companion. (SPEC §7.1, §8) */
export const FLOOR_ONLY_KINDS: MessageKind[] = [
  "context",
  "code",
  "decision",
  "action.request",
  "summary",
];
