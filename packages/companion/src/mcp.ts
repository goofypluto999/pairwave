/**
 * MCP server — the pair_* tools Claude Code calls.  (SPEC §14)
 *
 * Layered for testability: TOOLS (definitions) + callPairTool (pure dispatch on a runtime) are
 * unit-testable without any transport; startMcpServer wires them to stdio. Every tool routes
 * through the runtime, so floor rules, the SAS/charter gate, the secret scan, and Gate 1 are all
 * inherited — a tool call cannot bypass them.
 *
 * stdio rule: NEVER write to stdout here (it would corrupt the MCP protocol). Logs go to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CompanionRuntime } from "./runtime.js";

type Json = Record<string, unknown>;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Json;
};

const obj = (properties: Json, required: string[] = []): Json => ({
  type: "object",
  properties,
  required,
});
const str = (description: string): Json => ({ type: "string", description });
const bool = (description: string): Json => ({ type: "boolean", description });
const num = (description: string): Json => ({ type: "number", description });
const arr = (description: string): Json => ({ type: "array", items: { type: "string" }, description });

export const TOOLS: ToolDef[] = [
  {
    name: "pair_status",
    description:
      "Current room state: peers, SAS verification, charter, who holds the floor, pending permissions, " +
      "the activity ledger, live-mode state, and the local dashboard URL. Call this before sending anything.",
    inputSchema: obj({}),
  },
  {
    name: "pair_verify",
    description:
      "SAS verification. Without `confirm`: returns the fingerprint words — show them to your human, who " +
      "compares them with the other person out-of-band. With `confirm: true`: records that the humans " +
      "confirmed a match. Substantive exchange stays blocked until verified.",
    inputSchema: obj({ confirm: bool("Set true only after the humans confirmed the words match") }),
  },
  {
    name: "pair_charter",
    description:
      "Read, propose, or accept the shared Charter (task, purpose, scope, MUST-NOTs, autoApprove posture). " +
      "Substantive exchange is blocked until both sides accept the same charter.",
    inputSchema: obj(
      {
        op: { type: "string", enum: ["read", "propose", "accept"], description: "What to do" },
        title: str("Charter title (propose)"),
        purpose: str("Why this collaboration exists (propose)"),
        scope: arr("What IS in scope (propose)"),
        outOfScope: arr("What is NOT in scope (propose)"),
        mustNots: arr("Hard rules both Claudes must obey (propose)"),
        autoApprove: { type: "string", enum: ["none", "low", "all"], description: "Permission posture (propose); default none" },
        charterHash: str("Hash to accept (accept); defaults to the latest proposal"),
      },
      ["op"],
    ),
  },
  {
    name: "pair_send",
    description:
      "Send a message to the peer. Kinds: chat (anytime), question/answer (anytime), context/decision " +
      "(floor-only, need headline). Runs the secret scan; respects the floor and hop limits.",
    inputSchema: obj(
      {
        kind: { type: "string", enum: ["chat", "context", "decision", "question", "answer"], description: "Message kind" },
        text: str("Main text (chat/context/question/answer)"),
        headline: str("≤80-char one-liner for the activity rail (context/decision)"),
        decision: str("The decision statement (decision)"),
        rationale: str("Why (decision)"),
        claim: { type: "string", enum: ["fact", "inference", "assumption"], description: "Grounding label (context)" },
        answersMsgId: str("msgId of the question being answered (answer)"),
        origin: { type: "string", enum: ["human", "agent"], description: "Who authored this — 'human' only if your human dictated it" },
      },
      ["kind"],
    ),
  },
  {
    name: "pair_share_code",
    description:
      "Share code or a patch as an INERT artifact (floor-only). It lands in the peer's quarantine and does " +
      "nothing until they approve an action.request to apply it. Safe by construction.",
    inputSchema: obj(
      {
        headline: str("≤80-char description"),
        language: str("Language, e.g. typescript"),
        content: str("The code or unified diff"),
        isPatch: bool("True if content is a unified diff"),
        pathHint: str("Suggested target path (hint only)"),
      },
      ["headline", "content"],
    ),
  },
  {
    name: "pair_request_action",
    description:
      "Ask the OTHER side to apply a patch, write a file, run a command, or fetch a URL (floor-only). Raises " +
      "a permission popup on their side; nothing happens unless their human (or charter posture) approves.",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["apply_patch", "write_file", "run_command", "fetch_url"], description: "Action type" },
        risk: { type: "string", enum: ["low", "medium", "high"], description: "Your honest risk estimate (receiver re-normalizes)" },
        summary: str("Human-readable summary shown in their permission popup"),
        payload: str("Exact diff / file content / command / URL"),
        targetPath: str("Target path if applicable"),
        fromCodeMsgId: str("msgId of a previously shared code artifact this applies"),
      },
      ["action", "risk", "summary", "payload"],
    ),
  },
  {
    name: "pair_read",
    description: "Read recent verified messages in deterministic order (default last 30).",
    inputSchema: obj({ limit: num("How many recent messages (default 30)") }),
  },
  {
    name: "pair_inbox",
    description:
      "Items needing attention: questions addressed to me, permission requests awaiting my human's decision, " +
      "approved tasks ready to apply, and my own requests the peer hasn't resolved.",
    inputSchema: obj({}),
  },
  {
    name: "pair_respond_permission",
    description:
      "Approve or deny a pending permission (Gate 1) AFTER surfacing it to your human (unless the charter " +
      "posture covers it). Approval returns an apply task for pair_apply.",
    inputSchema: obj(
      {
        permissionId: str("The pending permission id"),
        decision: { type: "string", enum: ["approve", "deny"], description: "Your human's decision" },
        alwaysAllowKind: bool("Also auto-approve this action kind for the rest of the session"),
      },
      ["permissionId", "decision"],
    ),
  },
  {
    name: "pair_apply",
    description:
      "Fetch an approved task's exact payload (from quarantine if it references a shared artifact). Apply it " +
      "yourself with your OWN Edit/Write/Bash tools — Claude Code's permission prompt is Gate 2. The companion " +
      "never touches the project. Then report via pair_complete_action.",
    inputSchema: obj({ permissionId: str("The approved permission id") }, ["permissionId"]),
  },
  {
    name: "pair_complete_action",
    description: "Report the outcome of an applied action back to the requesting peer (sends action.result).",
    inputSchema: obj(
      {
        requestMsgId: str("The original action.request msgId"),
        ok: bool("Whether it succeeded"),
        detail: str("Short outcome note (e.g. test results)"),
      },
      ["requestMsgId", "ok"],
    ),
  },
  {
    name: "pair_claim",
    description: "Request the conversational floor (needed before context/code/decision/action.request).",
    inputSchema: obj({ reason: str("Why you need the floor") }),
  },
  {
    name: "pair_yield",
    description: "Give up the floor so the other side can push. Do this after a bounded exchange.",
    inputSchema: obj({ to: str("peerId to hand the floor to, or 'none'") }),
  },
  {
    name: "pair_live_mode",
    description:
      "Toggle live mode. When on, YOU should poll pair_inbox every pollSec seconds (it costs your side tokens " +
      "per poll and should auto-stop after maxMinutes). Tell your human it is on.",
    inputSchema: obj({ on: bool("true to enable, false to disable") }, ["on"]),
  },
  {
    name: "pair_summarize",
    description:
      "Send a narrative summary you wrote (floor-only). The cheap structured ledger is always in pair_status — " +
      "use this only at milestones or before a handoff.",
    inputSchema: obj(
      {
        text: str("Your prose recap"),
        headlines: arr("Key topic one-liners"),
        decisions: arr("Decision one-liners"),
        openQuestions: arr("Still-open questions"),
      },
      ["text"],
    ),
  },
  {
    name: "pair_remember",
    description:
      "Save knowledge into the SHARED BRAIN both Claudes recall from — facts, decisions, snippets, " +
      "links, insights. Not floor-gated (either side may contribute anytime). Use supersedes to " +
      "replace an outdated entry instead of duplicating. Requires SAS + charter.",
    inputSchema: obj(
      {
        headline: str("<=80-char title for the entry"),
        content: str("The knowledge itself — keep it self-contained"),
        tags: arr("Lowercase tags for filtering, e.g. ['api','auth']"),
        entryKind: { type: "string", enum: ["fact", "decision", "snippet", "link", "insight"], description: "What kind of knowledge (default fact)" },
        supersedes: str("msgId of an earlier brain entry this replaces"),
      },
      ["headline", "content"],
    ),
  },
  {
    name: "pair_recall",
    description:
      "Search the shared brain (local, instant, free — no network, no tokens beyond this call). " +
      "Returns ranked entries with msgIds (usable as supersedes targets). Empty query lists recent entries.",
    inputSchema: obj({
      query: str("Keywords to search for"),
      tags: arr("Restrict to entries carrying any of these tags"),
      kind: { type: "string", enum: ["fact", "decision", "snippet", "link", "insight"], description: "Restrict to one entry kind" },
      limit: num("Max results (default 8)"),
    }),
  },
  {
    name: "pair_handoff",
    description: "Write the per-side handoff markdown now (also happens automatically on shutdown).",
    inputSchema: obj({}),
  },
  {
    name: "pair_resume",
    description:
      "Load the latest handoff and re-establish full context (charter, ledger, open threads). Use at the start " +
      "of a session for an existing room. Report drift between recorded decisions and the project.",
    inputSchema: obj({}),
  },
];

/** Pure dispatch — unit-testable without any MCP transport. Throws on unknown tool. */
export async function callPairTool(rt: CompanionRuntime, name: string, args: Json): Promise<unknown> {
  switch (name) {
    case "pair_status":
      return rt.status();

    case "pair_verify": {
      if (args.confirm === true) {
        rt.confirmVerification();
        return { verified: true, note: "Peer verified. Substantive exchange is now unblocked (charter still required)." };
      }
      const words = await rt.sasWords();
      return words
        ? {
            verified: (await rt.status()).verification.verified,
            sasWords: words,
            note: "Show these words to your human; the other person must see the SAME words. Only call with confirm:true after the humans confirm a match out-of-band.",
          }
        : { error: "no peer present yet — wait for the other side to join" };
    }

    case "pair_charter": {
      const op = String(args.op);
      if (op === "read") {
        const charter = rt.agreedCharter();
        return charter ? { agreed: true, charter } : { agreed: false, note: "No charter agreed yet. Propose one." };
      }
      if (op === "propose") {
        if (!args.title || !args.purpose) return { error: "title and purpose are required to propose" };
        return rt.proposeCharter({
          title: String(args.title),
          purpose: String(args.purpose),
          scope: (args.scope as string[]) ?? [],
          outOfScope: (args.outOfScope as string[]) ?? [],
          mustNots: (args.mustNots as string[]) ?? [],
          autoApprove: (args.autoApprove as "none" | "low" | "all") ?? "none",
        });
      }
      if (op === "accept") return rt.acceptCharter(args.charterHash ? String(args.charterHash) : undefined);
      return { error: `unknown op ${op}` };
    }

    case "pair_send": {
      const kind = String(args.kind);
      const origin = (args.origin as "human" | "agent") ?? "agent";
      const bodies: Record<string, unknown> = {
        chat: { text: String(args.text ?? "") },
        question: { text: String(args.text ?? "") },
        answer: { text: String(args.text ?? ""), answersMsgId: String(args.answersMsgId ?? "") },
        context: {
          headline: String(args.headline ?? "").slice(0, 80),
          text: String(args.text ?? ""),
          claim: (args.claim as string) ?? "inference",
        },
        decision: {
          headline: String(args.headline ?? "").slice(0, 80),
          decision: String(args.decision ?? args.text ?? ""),
          ...(args.rationale !== undefined ? { rationale: String(args.rationale) } : {}),
        },
      };
      const body = bodies[kind];
      if (!body) return { error: `pair_send does not handle kind '${kind}'` };
      return rt.send(kind as never, body, origin);
    }

    case "pair_share_code":
      return rt.send(
        "code",
        {
          headline: String(args.headline ?? "").slice(0, 80),
          language: String(args.language ?? "text"),
          content: String(args.content ?? ""),
          isPatch: args.isPatch === true,
          ...(args.pathHint !== undefined ? { pathHint: String(args.pathHint) } : {}),
        },
        "agent",
      );

    case "pair_request_action":
      return rt.send(
        "action.request",
        {
          action: String(args.action),
          risk: String(args.risk),
          summary: String(args.summary ?? ""),
          payload: String(args.payload ?? ""),
          ...(args.targetPath !== undefined ? { targetPath: String(args.targetPath) } : {}),
          ...(args.fromCodeMsgId !== undefined ? { fromCodeMsgId: String(args.fromCodeMsgId) } : {}),
        },
        "agent",
      );

    case "pair_read":
      return rt.read({ limit: typeof args.limit === "number" ? args.limit : 30 });

    case "pair_inbox":
      return rt.inbox();

    case "pair_respond_permission":
      return rt.decidePermission(String(args.permissionId), args.decision === "approve" ? "approve" : "deny", {
        alwaysAllowKind: args.alwaysAllowKind === true,
      });

    case "pair_apply": {
      const task = rt.getApplyTask(String(args.permissionId));
      return task ?? { error: "no approved task with that permissionId (approve it first via pair_respond_permission)" };
    }

    case "pair_complete_action":
      return rt.completeAction(String(args.requestMsgId), args.ok === true, args.detail ? String(args.detail) : undefined);

    case "pair_claim":
      return rt.send("turn.claim", { ...(args.reason !== undefined ? { reason: String(args.reason) } : {}) }, "agent");

    case "pair_yield":
      return rt.send("turn.yield", { to: String(args.to ?? "none") }, "agent");

    case "pair_live_mode":
      return rt.setLiveMode(args.on === true);

    case "pair_summarize":
      return rt.send(
        "summary",
        {
          mode: "narrative",
          text: String(args.text ?? ""),
          headlines: (args.headlines as string[]) ?? [],
          decisions: (args.decisions as string[]) ?? [],
          openQuestions: (args.openQuestions as string[]) ?? [],
        },
        "agent",
      );

    case "pair_remember":
      return rt.remember({
        headline: String(args.headline ?? ""),
        content: String(args.content ?? ""),
        tags: (args.tags as string[]) ?? [],
        ...(args.entryKind !== undefined ? { entryKind: args.entryKind as never } : {}),
        ...(args.supersedes !== undefined ? { supersedes: String(args.supersedes) } : {}),
      });

    case "pair_recall":
      return rt.recall(String(args.query ?? ""), {
        ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as never } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });

    case "pair_handoff":
      return { path: rt.writeHandoffNow() };

    case "pair_resume":
      return rt.resume();

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Wire the tools to stdio for Claude Code. Resolves when the transport closes. */
export async function startMcpServer(rt: CompanionRuntime): Promise<void> {
  const server = new Server({ name: "pairwave", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await callPairTool(rt, req.params.name, (req.params.arguments ?? {}) as Json);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
