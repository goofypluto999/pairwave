/**
 * Git coordination — the shared-repo workspace layer.  (SPEC §9.7)
 *
 * Two people working one git repo, with NO overlaps. Pairwave doesn't run git (the companion has no
 * shell — each side's Claude runs git via its own tools, under Claude Code's permissions). Instead
 * it provides the coordination brain: a PATH-OWNERSHIP LEDGER folded purely from the message log
 * (identical on both sides, like the floor and the brain). Before editing a file, a Claude must hold
 * a claim on it. Overlapping claims are refused proactively (the requester sees the peer already owns
 * it) and, for a genuine race, resolved deterministically — earlier (ts, msgId) wins on both sides,
 * the loser's claim is marked contested. Commits are announced so the peer knows to pull.
 */
import { topoOrder } from "@pairwave/protocol";
import type { Message } from "@pairwave/protocol";

/** Normalize a path/glob to a comparable prefix: strip ./, trailing /, /** and /* */
export function normPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+(\*\*|\*)$/, "")
    .replace(/\/+$/, "");
}

/** Do two claimed paths cover any common file? (prefix containment in either direction) */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normPath(a);
  const nb = normPath(b);
  if (na === nb) return true;
  if (na === "" || nb === "") return true; // a root claim covers everything
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export type GitClaim = { owner: string; path: string; ts: string; msgId: string };
export type GitCommit = { peerId: string; sha: string; branch: string; message: string; paths: string[]; ts: string };

export type GitState = {
  repo?: string | undefined;
  branch?: string | undefined;
  baseCommit?: string | undefined;
  strategy?: string | undefined;
  /** peerId -> the paths they currently own (conflict-resolved, deduped). */
  claimsByOwner: Record<string, string[]>;
  /** Claims that lost a race / overlapped a peer's claim. */
  conflicts: { path: string; ownedBy: string; deniedTo: string }[];
  recentCommits: GitCommit[];
  lastContextTs?: string | undefined;
};

export function deriveGitState(messages: Message[]): GitState {
  let repo: string | undefined;
  let branch: string | undefined;
  let baseCommit: string | undefined;
  let strategy: string | undefined;
  let lastContextTs: string | undefined;
  const commits: GitCommit[] = [];
  let active: GitClaim[] = [];

  for (const m of topoOrder(messages)) {
    if (m.kind === "git.context") {
      repo = m.body.repo;
      branch = m.body.branch;
      baseCommit = m.body.baseCommit;
      strategy = m.body.strategy;
      lastContextTs = m.ts;
    } else if (m.kind === "git.claim") {
      for (const p of m.body.paths) active.push({ owner: m.sender.peerId, path: normPath(p), ts: m.ts, msgId: m.msgId });
    } else if (m.kind === "git.release") {
      if (m.body.paths.length === 0) {
        active = active.filter((c) => c.owner !== m.sender.peerId);
      } else {
        const rel = m.body.paths.map(normPath);
        active = active.filter((c) => !(c.owner === m.sender.peerId && rel.some((r) => pathsOverlap(c.path, r))));
      }
    } else if (m.kind === "git.commit") {
      commits.push({
        peerId: m.sender.peerId,
        sha: m.body.sha,
        branch: m.body.branch,
        message: m.body.message,
        paths: m.body.paths,
        ts: m.ts,
      });
    }
  }

  // Deterministic conflict resolution: process claims in (ts, msgId) order; a claim that overlaps an
  // already-accepted claim from a DIFFERENT owner is contested. Same-owner overlaps just dedupe.
  active.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));
  const accepted: GitClaim[] = [];
  const conflicts: GitState["conflicts"] = [];
  for (const c of active) {
    const clash = accepted.find((a) => a.owner !== c.owner && pathsOverlap(a.path, c.path));
    if (clash) {
      conflicts.push({ path: c.path, ownedBy: clash.owner, deniedTo: c.owner });
    } else if (!accepted.some((a) => a.owner === c.owner && a.path === c.path)) {
      accepted.push(c);
    }
  }

  const claimsByOwner: Record<string, string[]> = {};
  for (const c of accepted) (claimsByOwner[c.owner] ??= []).push(c.path);

  return { repo, branch, baseCommit, strategy, claimsByOwner, conflicts, recentCommits: commits.slice(-20), lastContextTs };
}

/** Who currently owns the claim covering this path? (null = unclaimed) */
export function ownerOfPath(state: GitState, path: string): string | null {
  const n = normPath(path);
  for (const [owner, paths] of Object.entries(state.claimsByOwner)) {
    if (paths.some((p) => pathsOverlap(p, n))) return owner;
  }
  return null;
}

/** Can `me` safely edit `path`? */
export function canEdit(state: GitState, me: string, path: string): { ok: boolean; ownedBy?: string } {
  const owner = ownerOfPath(state, path);
  return owner === null || owner === me ? { ok: true } : { ok: false, ownedBy: owner };
}

/** Which of the requested paths are already owned by someone else? */
export function claimConflicts(state: GitState, me: string, paths: string[]): { path: string; ownedBy: string }[] {
  const out: { path: string; ownedBy: string }[] = [];
  for (const p of paths) {
    const owner = ownerOfPath(state, p);
    if (owner !== null && owner !== me) out.push({ path: normPath(p), ownedBy: owner });
  }
  return out;
}
