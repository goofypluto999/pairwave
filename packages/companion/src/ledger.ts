/**
 * Activity Ledger — the free, deterministic state behind the UI's left rail.  (SPEC §9.3)
 *
 * NOT an LLM summary. It is folded purely from typed messages, so it is always current at zero cost:
 * recent headlines, still-open questions, decisions, shared artifacts, and unresolved action
 * requests, plus floor/turn and counts. (The narrative summary — `pair_summarize` — is the separate,
 * on-demand LLM recap.)
 */
import { topoOrder } from "@pairwave/protocol";
import type { Message } from "@pairwave/protocol";
import { deriveFloor } from "./floor.js";

export type LedgerHeadline = { msgId: string; peerId: string; kind: string; headline: string; ts: string };
export type LedgerQuestion = { msgId: string; peerId: string; text: string; ts: string };
export type LedgerDecision = { msgId: string; peerId: string; decision: string; headline: string; ts: string };
export type LedgerArtifact = {
  msgId: string;
  peerId: string;
  headline: string;
  language: string;
  isPatch: boolean;
  pathHint?: string | undefined;
  ts: string;
};
export type LedgerActionReq = { msgId: string; peerId: string; action: string; summary: string; risk: string; ts: string };

export type ActivityLedger = {
  participants: { peerId: string; name: string }[];
  floor: string | "none";
  turnId: string;
  headlines: LedgerHeadline[];
  openQuestions: LedgerQuestion[];
  decisions: LedgerDecision[];
  sharedArtifacts: LedgerArtifact[];
  pendingActions: LedgerActionReq[];
  counts: { messages: number; byKind: Record<string, number> };
  lastActivityTs?: string | undefined;
};

export function deriveLedger(messages: Message[], opts?: { maxHeadlines?: number }): ActivityLedger {
  const ordered = topoOrder(messages);
  const maxHeadlines = opts?.maxHeadlines ?? 10;
  const floorView = deriveFloor(messages);

  const participants = new Map<string, string>();
  const headlines: LedgerHeadline[] = [];
  const decisions: LedgerDecision[] = [];
  const artifacts: LedgerArtifact[] = [];
  const questions = new Map<string, LedgerQuestion>();
  const answered = new Set<string>();
  const actionReqs = new Map<string, LedgerActionReq>();
  const resolved = new Set<string>();
  const byKind: Record<string, number> = {};
  let lastActivityTs: string | undefined;

  for (const m of ordered) {
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    lastActivityTs = m.ts;
    if (!participants.has(m.sender.peerId)) participants.set(m.sender.peerId, m.sender.name);

    switch (m.kind) {
      case "context":
        headlines.push({ msgId: m.msgId, peerId: m.sender.peerId, kind: m.kind, headline: m.body.headline, ts: m.ts });
        break;
      case "decision":
        headlines.push({ msgId: m.msgId, peerId: m.sender.peerId, kind: m.kind, headline: m.body.headline, ts: m.ts });
        decisions.push({
          msgId: m.msgId,
          peerId: m.sender.peerId,
          decision: m.body.decision,
          headline: m.body.headline,
          ts: m.ts,
        });
        break;
      case "code":
        headlines.push({ msgId: m.msgId, peerId: m.sender.peerId, kind: m.kind, headline: m.body.headline, ts: m.ts });
        artifacts.push({
          msgId: m.msgId,
          peerId: m.sender.peerId,
          headline: m.body.headline,
          language: m.body.language,
          isPatch: m.body.isPatch,
          pathHint: m.body.pathHint,
          ts: m.ts,
        });
        break;
      case "question":
        questions.set(m.msgId, { msgId: m.msgId, peerId: m.sender.peerId, text: m.body.text, ts: m.ts });
        break;
      case "answer":
        answered.add(m.body.answersMsgId);
        break;
      case "action.request":
        actionReqs.set(m.msgId, {
          msgId: m.msgId,
          peerId: m.sender.peerId,
          action: m.body.action,
          summary: m.body.summary,
          risk: m.body.risk,
          ts: m.ts,
        });
        break;
      case "action.result":
        resolved.add(m.body.requestMsgId);
        break;
    }
  }

  return {
    participants: [...participants.entries()].map(([peerId, name]) => ({ peerId, name })),
    floor: floorView.floor,
    turnId: floorView.turnId,
    headlines: headlines.slice(-maxHeadlines),
    openQuestions: [...questions.values()].filter((q) => !answered.has(q.msgId)),
    decisions,
    sharedArtifacts: artifacts,
    pendingActions: [...actionReqs.values()].filter((a) => !resolved.has(a.msgId)),
    counts: { messages: ordered.length, byKind },
    lastActivityTs,
  };
}
