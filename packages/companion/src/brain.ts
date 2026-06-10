/**
 * Shared brain — the durable knowledge layer both Claudes write into and recall from.  (SPEC §9.5)
 *
 * Like the ledger, it is a PURE FOLD of the verified message log: every `brain.entry` becomes a
 * knowledge item; `supersedes` replaces an earlier item (overlap-free by construction); both sides
 * converge on the identical brain because they fold the identical signed log. Recall is local,
 * deterministic, and free — token-overlap scoring (headline > tags > content), no embeddings, no
 * API calls, no network. It is honest RAG-lite: real retrieval, zero cost, zero new trust surface.
 */
import { topoOrder } from "@pairwave/protocol";
import type { Message } from "@pairwave/protocol";

export type BrainEntry = {
  msgId: string;
  peerId: string;
  author: string;
  ts: string;
  headline: string;
  content: string;
  tags: string[];
  entryKind: "fact" | "decision" | "snippet" | "link" | "insight";
  /** Set when a later entry replaced this one's predecessor chain root. */
  supersedes?: string | undefined;
};

export type BrainView = {
  entries: BrainEntry[]; // live entries only (superseded ones removed), DAG order
  counts: { total: number; byKind: Record<string, number>; byPeer: Record<string, number> };
  lastUpdatedTs?: string | undefined;
};

/** Fold the log into the current shared brain. Pure + deterministic on both sides. */
export function deriveBrain(messages: Message[]): BrainView {
  const live = new Map<string, BrainEntry>();
  let lastUpdatedTs: string | undefined;

  for (const m of topoOrder(messages)) {
    if (m.kind !== "brain.entry") continue;
    lastUpdatedTs = m.ts;
    if (m.body.supersedes) live.delete(m.body.supersedes);
    live.set(m.msgId, {
      msgId: m.msgId,
      peerId: m.sender.peerId,
      author: m.sender.name,
      ts: m.ts,
      headline: m.body.headline,
      content: m.body.content,
      tags: m.body.tags,
      entryKind: m.body.entryKind,
      supersedes: m.body.supersedes,
    });
  }

  const entries = [...live.values()];
  const byKind: Record<string, number> = {};
  const byPeer: Record<string, number> = {};
  for (const e of entries) {
    byKind[e.entryKind] = (byKind[e.entryKind] ?? 0) + 1;
    byPeer[e.peerId] = (byPeer[e.peerId] ?? 0) + 1;
  }
  return { entries, counts: { total: entries.length, byKind, byPeer }, lastUpdatedTs };
}

export type RecallHit = BrainEntry & { score: number };

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

/**
 * Deterministic keyword recall: headline matches weigh 3, tag matches 2, content matches 1; exact
 * tag filter narrows first. Ties break by recency then msgId so both sides rank identically.
 */
export function recallBrain(
  view: BrainView,
  query: string,
  opts?: { tags?: string[]; limit?: number; kind?: BrainEntry["entryKind"] },
): RecallHit[] {
  const qTokens = [...new Set(tokens(query))];
  const limit = opts?.limit ?? 8;

  let pool = view.entries;
  if (opts?.tags?.length) {
    const want = new Set(opts.tags.map((t) => t.toLowerCase()));
    pool = pool.filter((e) => e.tags.some((t) => want.has(t.toLowerCase())));
  }
  if (opts?.kind) pool = pool.filter((e) => e.entryKind === opts.kind);

  const hits: RecallHit[] = [];
  for (const e of pool) {
    const inHeadline = new Set(tokens(e.headline));
    const inTags = new Set(e.tags.flatMap(tokens));
    const inContent = new Set(tokens(e.content));
    let score = 0;
    for (const q of qTokens) {
      if (inHeadline.has(q)) score += 3;
      if (inTags.has(q)) score += 2;
      if (inContent.has(q)) score += 1;
    }
    if (score > 0 || qTokens.length === 0) hits.push({ ...e, score });
  }

  return hits
    .sort((a, b) => b.score - a.score || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.msgId < b.msgId ? -1 : 1))
    .slice(0, limit);
}
