/**
 * Tamper-evident hash-DAG — concrete implementation.  (SPEC §5.4)
 *
 * Each message commits to its `parents` (hashes its sender had at send time). One parent => a chain;
 * a shared parent => a fork; listing both => a merge. `verify` checks every hash + signature +
 * parent presence; `topoOrder` produces a deterministic display order that does not trust the relay
 * (topological over parents, ties broken by (ts, msgId)).
 */
import type { Message } from "./messages.js";
import { hashCanonical, verifySig } from "./crypto.js";
import { fromB64 } from "./sodium.js";

export interface DagVerification {
  ok: boolean;
  /** msgIds whose hash recomputation or signature failed. */
  bad: string[];
  /** Parent hashes referenced but not present in the supplied set (gaps). */
  missingParents: string[];
}

/** Canonical hash of a message excluding its own `hash`/`sig`. */
export async function hashOf(core: Omit<Message, "hash" | "sig">): Promise<string> {
  return hashCanonical(core);
}

/**
 * Verify a set of messages. Expects the full known set; for a partial window, referenced parents
 * outside the window will (correctly) show up in `missingParents` — the Companion tracks a known
 * horizon to interpret that (Phase 3).
 */
export async function verify(messages: Message[]): Promise<DagVerification> {
  const present = new Set(messages.map((m) => m.hash));
  const bad: string[] = [];
  const missing = new Set<string>();

  for (const m of messages) {
    const { hash, sig, ...core } = m;
    let good = (await hashCanonical(core)) === hash;
    if (good) good = await verifySig(sig, hash, await fromB64(m.sender.pubKey));
    if (!good) bad.push(m.msgId);
    for (const p of m.parents) if (!present.has(p)) missing.add(p);
  }

  return { ok: bad.length === 0 && missing.size === 0, bad, missingParents: [...missing] };
}

/** Deterministic display order: topological over `parents`, ties broken by (ts, msgId). */
export function topoOrder(messages: Message[]): Message[] {
  const byHash = new Map<string, Message>(messages.map((m) => [m.hash, m]));
  const indeg = new Map<string, number>(messages.map((m) => [m.hash, 0]));
  const children = new Map<string, string[]>();

  for (const m of messages) {
    for (const p of m.parents) {
      if (!byHash.has(p)) continue; // parent outside the set => treat as an already-emitted root
      indeg.set(m.hash, (indeg.get(m.hash) ?? 0) + 1);
      const arr = children.get(p) ?? [];
      arr.push(m.hash);
      children.set(p, arr);
    }
  }

  const cmp = (h1: string, h2: string): number => {
    const a = byHash.get(h1)!;
    const b = byHash.get(h2)!;
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0;
  };

  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([h]) => h);
  const out: Message[] = [];
  while (ready.length) {
    ready.sort(cmp);
    const h = ready.shift()!;
    out.push(byHash.get(h)!);
    for (const c of children.get(h) ?? []) {
      const d = (indeg.get(c) ?? 1) - 1;
      indeg.set(c, d);
      if (d === 0) ready.push(c);
    }
  }

  // Leftovers (a cycle, which signed history cannot legitimately contain) appended deterministically.
  if (out.length < messages.length) {
    const seen = new Set(out.map((m) => m.hash));
    for (const m of [...messages].sort((a, b) => cmp(a.hash, b.hash))) {
      if (!seen.has(m.hash)) out.push(m);
    }
  }
  return out;
}
