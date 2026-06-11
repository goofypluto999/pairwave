import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, MessageKind } from "@pairwave/protocol";
import { deriveGitState, ownerOfPath, canEdit, claimConflicts, pathsOverlap } from "../src/gitcoord.js";

let TAG = 0;
type Spec = { kind?: MessageKind; peerId?: string; ts?: string; body?: unknown };

function chain(specs: Spec[]): Message[] {
  const tag = `G${TAG++}`;
  return specs.map(
    (sp, i) =>
      ({
        v: 1,
        msgId: sp.peerId ? `${tag}-${sp.peerId}-${i}` : `${tag}-${String(i).padStart(4, "0")}`,
        roomId: "room-git-1",
        sender: { peerId: sp.peerId ?? "A", name: sp.peerId ?? "A", pubKey: "AA==" },
        origin: "agent",
        ts: sp.ts ?? `2026-06-11T10:00:${String(i).padStart(2, "0")}.000Z`,
        parents: i ? [`${tag}-h${i - 1}`] : [],
        hash: `${tag}-h${i}`,
        sig: "AA==",
        turn: { floor: "none", turnId: "t0", hop: 0 },
        kind: sp.kind ?? "git.claim",
        body: sp.body ?? {},
      }) as Message,
  );
}
const ctx = (peerId: string, repo: string, branch: string): Spec => ({ kind: "git.context", peerId, body: { repo, branch, strategy: "shared-branch" } });
const claim = (peerId: string, paths: string[], ts?: string): Spec => ({ kind: "git.claim", peerId, ts, body: { paths } });
const release = (peerId: string, paths: string[] = []): Spec => ({ kind: "git.release", peerId, body: { paths } });
const commit = (peerId: string, sha: string, msg: string): Spec => ({ kind: "git.commit", peerId, body: { sha, branch: "main", message: msg, paths: [] } });

test("path overlap detection (prefix containment, both directions)", () => {
  assert.ok(pathsOverlap("src/auth", "src/auth/login.ts"));
  assert.ok(pathsOverlap("src/auth/**", "src/auth"));
  assert.ok(pathsOverlap("README.md", "README.md"));
  assert.equal(pathsOverlap("src/auth", "src/ui"), false);
  assert.equal(pathsOverlap("src/a", "src/ab"), false); // not a path boundary
});

test("context + non-overlapping claims = clean split ownership", () => {
  const g = deriveGitState(chain([ctx("A", "git@x:repo", "main"), claim("A", ["src/auth/**"]), claim("B", ["src/ui/**"])]));
  assert.equal(g.repo, "git@x:repo");
  assert.equal(g.branch, "main");
  assert.deepEqual(g.claimsByOwner.A, ["src/auth"]);
  assert.deepEqual(g.claimsByOwner.B, ["src/ui"]);
  assert.equal(g.conflicts.length, 0);
});

test("overlapping claims: earlier (ts) wins, later is contested — deterministic on both sides", () => {
  const msgs = chain([
    claim("A", ["src/auth"], "2026-06-11T10:00:01.000Z"),
    claim("B", ["src/auth/login.ts"], "2026-06-11T10:00:02.000Z"),
  ]);
  const g1 = deriveGitState(msgs);
  const g2 = deriveGitState([...msgs].reverse()); // input order must not matter
  for (const g of [g1, g2]) {
    assert.equal(ownerOfPath(g, "src/auth/login.ts"), "A");
    assert.equal(g.conflicts.length, 1);
    assert.equal(g.conflicts[0]!.deniedTo, "B");
    assert.equal(g.conflicts[0]!.ownedBy, "A");
  }
});

test("ownerOfPath covers nested files; canEdit gates the peer's area", () => {
  const g = deriveGitState(chain([claim("A", ["src/auth/**"])]));
  assert.equal(ownerOfPath(g, "src/auth/session/token.ts"), "A");
  assert.equal(ownerOfPath(g, "src/ui/button.ts"), null);
  assert.deepEqual(canEdit(g, "A", "src/auth/x.ts"), { ok: true });
  assert.equal(canEdit(g, "B", "src/auth/x.ts").ok, false);
  assert.equal(canEdit(g, "B", "src/ui/x.ts").ok, true); // unclaimed = free
});

test("claimConflicts surfaces peer-owned overlaps BEFORE claiming (proactive no-overlap)", () => {
  const g = deriveGitState(chain([claim("A", ["src/auth/**"])]));
  const c = claimConflicts(g, "B", ["src/auth/login.ts", "src/ui/x.ts"]);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.ownedBy, "A");
  assert.equal(claimConflicts(g, "A", ["src/auth/more.ts"]).length, 0); // my own area never conflicts
});

test("release frees the area; commits are tracked", () => {
  const g = deriveGitState(chain([claim("A", ["src/auth/**"]), release("A", ["src/auth/**"]), commit("A", "abc123", "wire auth")]));
  assert.equal(ownerOfPath(g, "src/auth/x.ts"), null);
  assert.equal(g.recentCommits.length, 1);
  assert.equal(g.recentCommits[0]!.sha, "abc123");
});

test("release-all drops every claim by that owner only", () => {
  const g = deriveGitState(chain([claim("A", ["src/a", "src/b"]), claim("B", ["src/c"]), release("A")]));
  assert.equal(g.claimsByOwner.A, undefined);
  assert.deepEqual(g.claimsByOwner.B, ["src/c"]);
});
