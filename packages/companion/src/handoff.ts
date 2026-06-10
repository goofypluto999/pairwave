/**
 * Handoff writer + resume loader.  (SPEC §11)
 *
 * On session end / disconnect / demand, each side independently writes a markdown snapshot of the
 * collaboration to its own `.pairwave/<room>/` (never the relay): charter, ledger, open threads,
 * decisions, artifact index, floor + verification state, and the full timestamped transcript.
 * Next session, `pair_resume` hands this back to the Claude so both sides continue with full
 * awareness. Handoffs are local plaintext — the directory is git-ignored.
 */
import { writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { topoOrder, type Message, type Charter } from "@pairwave/protocol";
import type { ActivityLedger } from "./ledger.js";
import type { BrainView } from "./brain.js";

export type HandoffInput = {
  roomId: string;
  me: { peerId: string; name: string };
  charter?: Charter | undefined;
  ledger: ActivityLedger;
  brain?: BrainView | undefined;
  messages: Message[];
  sasVerified: boolean;
  nowIso: string;
};

function gist(m: Message): string {
  const b = m.body as Record<string, unknown>;
  const text =
    (typeof b.headline === "string" && b.headline) ||
    (typeof b.text === "string" && b.text) ||
    (typeof b.summary === "string" && b.summary) ||
    (typeof b.decision === "string" && b.decision) ||
    (m.kind === "turn.yield" && `yield → ${String(b.to)}`) ||
    (m.kind === "turn.claim" && "claims the floor") ||
    (m.kind.startsWith("system.") && m.kind) ||
    JSON.stringify(b).slice(0, 80);
  return String(text).replace(/\r?\n/g, " ").slice(0, 120);
}

export function buildHandoffMarkdown(input: HandoffInput): string {
  const { charter, ledger } = input;
  const lines: string[] = [];
  lines.push(`# Pairwave handoff — ${input.roomId}`);
  lines.push("");
  lines.push(`- **Written:** ${input.nowIso} (UTC) by **${input.me.name}** (\`${input.me.peerId}\`)`);
  lines.push(`- **Peer verification (SAS):** ${input.sasVerified ? "verified" : "NOT verified"}`);
  lines.push(`- **Floor at handoff:** ${ledger.floor}`);
  lines.push(`- **Messages:** ${ledger.counts.messages} · last activity ${ledger.lastActivityTs ?? "n/a"}`);
  lines.push("");

  lines.push(`## Charter`);
  if (charter) {
    lines.push(`- **Title:** ${charter.title}`);
    lines.push(`- **Purpose:** ${charter.purpose}`);
    if (charter.scope.length) lines.push(`- **Scope:** ${charter.scope.join("; ")}`);
    if (charter.outOfScope.length) lines.push(`- **Out of scope:** ${charter.outOfScope.join("; ")}`);
    if (charter.mustNots.length) lines.push(`- **MUST NOTs:** ${charter.mustNots.join("; ")}`);
    if (charter.responseContract.length) lines.push(`- **Response contract:** ${charter.responseContract.join("; ")}`);
    lines.push(`- **Auto-approve posture:** ${charter.autoApprove}`);
    lines.push(`- **Charter hash:** \`${charter.charterHash}\``);
  } else {
    lines.push(`_No charter was agreed in this session._`);
  }
  lines.push("");

  lines.push(`## Open questions (${ledger.openQuestions.length})`);
  for (const q of ledger.openQuestions) lines.push(`- [ ] (${q.peerId}, ${q.ts}) ${q.text}`);
  if (!ledger.openQuestions.length) lines.push(`_None._`);
  lines.push("");

  lines.push(`## Decisions (${ledger.decisions.length})`);
  for (const d of ledger.decisions) lines.push(`- (${d.peerId}, ${d.ts}) **${d.headline}** — ${d.decision}`);
  if (!ledger.decisions.length) lines.push(`_None._`);
  lines.push("");

  lines.push(`## Shared artifacts (${ledger.sharedArtifacts.length})`);
  for (const a of ledger.sharedArtifacts) {
    lines.push(
      `- (${a.peerId}, ${a.ts}) **${a.headline}** — ${a.language}${a.isPatch ? " patch" : ""}${a.pathHint ? `, hint: \`${a.pathHint}\`` : ""} · msgId \`${a.msgId}\` (inert in quarantine)`,
    );
  }
  if (!ledger.sharedArtifacts.length) lines.push(`_None._`);
  lines.push("");

  if (input.brain && input.brain.counts.total > 0) {
    lines.push(`## Shared brain (${input.brain.counts.total} entries)`);
    for (const e of input.brain.entries) {
      lines.push(
        `- [${e.entryKind}] **${e.headline}** (${e.author}, ${e.ts})${e.tags.length ? ` · tags: ${e.tags.join(", ")}` : ""}`,
      );
      lines.push(`  ${e.content.replace(/\r?\n/g, " ").slice(0, 200)}`);
    }
    lines.push("");
  }

  lines.push(`## Unresolved action requests (${ledger.pendingActions.length})`);
  for (const p of ledger.pendingActions) lines.push(`- (${p.peerId}, ${p.ts}) [${p.risk}] ${p.action}: ${p.summary}`);
  if (!ledger.pendingActions.length) lines.push(`_None._`);
  lines.push("");

  lines.push(`## Transcript (${input.messages.length} messages, DAG order)`);
  lines.push("");
  lines.push(`| time (UTC) | from | origin | kind | gist |`);
  lines.push(`|---|---|---|---|---|`);
  for (const m of topoOrder(input.messages)) {
    lines.push(`| ${m.ts} | ${m.sender.name} | ${m.origin} | ${m.kind} | ${gist(m).replace(/\|/g, "\\|")} |`);
  }
  lines.push("");

  lines.push(`## How to resume`);
  lines.push(`1. Start the companion (it reloads the durable log automatically).`);
  lines.push(`2. In Claude Code, run \`/pairwave\` — the skill calls \`pair_resume\`, which returns this`);
  lines.push(`   handoff so the session continues with full context.`);
  lines.push(`3. Check the decisions above against the current project state and report any drift.`);
  lines.push("");
  return lines.join("\n");
}

/** Write handoff-<ts>.md plus the stable handoff-latest.md copy. Returns the timestamped path. */
export function writeHandoff(roomDir: string, input: HandoffInput): string {
  const md = buildHandoffMarkdown(input);
  const stamp = input.nowIso.replace(/[:.]/g, "-");
  const path = join(roomDir, `handoff-${stamp}.md`);
  writeFileSync(path, md, "utf8");
  copyFileSync(path, join(roomDir, "handoff-latest.md"));
  return path;
}

export function readLatestHandoff(roomDir: string): string | undefined {
  const path = join(roomDir, "handoff-latest.md");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
