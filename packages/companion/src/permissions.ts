/**
 * Permission queue + the two-gate apply model.  (SPEC §7.2, §9.1, §9.2)
 *
 * Gate 1 (here): "do I accept this REQUEST from my peer into my workspace?" — governed by the
 * Charter's autoApprove posture. Gate 2 (NOT here): the receiver's own Claude applies the artifact
 * via its normal Edit/Write/Bash tools, which trigger Claude Code's own permission prompt. The
 * Companion never writes the project tree and never runs commands — approval only ever yields an
 * `ApplyTask` *descriptor* for the receiver's Claude to act on.
 */
import type { ActionKind, RiskLevel, AutoApprove } from "@pairwave/protocol";

export type PermissionRequest = {
  requestMsgId: string;
  fromPeerId: string;
  action: ActionKind;
  /** Normalized risk — we never trust the sender's claimed label. */
  risk: RiskLevel;
  summary: string;
  payload: string;
  targetPath?: string | undefined;
  /** The quarantined code artifact this action would apply, if any. */
  fromCodeMsgId?: string | undefined;
  /** Danger-guard hits (SPEC §9.6). Non-empty ⇒ high risk and NEVER auto-approvable. */
  dangerFlags?: { rule: string; detail: string }[] | undefined;
};

export type PermissionStatus = "pending" | "approved" | "denied";
export type PendingPermission = PermissionRequest & { id: string; createdAt: string; status: PermissionStatus };

export type ApplyTask = {
  permissionId: string;
  action: ActionKind;
  payload: string;
  targetPath?: string | undefined;
  note: string;
};

/** Receiver-side re-evaluation of risk — least privilege, never trust the sender's label. */
export function normalizeRisk(action: ActionKind, claimed: RiskLevel): RiskLevel {
  if (action === "run_command") return "high"; // executing anything is always high
  if (action === "write_file") return claimed === "low" ? "medium" : claimed; // overwrite ≥ medium
  return claimed; // apply_patch (previewable diff) and fetch_url keep their claim
}

/** Gate-1 posture decision: auto-approve, or surface a popup for the human? (SPEC §9.1) */
export function gate1Decision(risk: RiskLevel, posture: AutoApprove): "approve" | "prompt" {
  if (posture === "all") return "approve";
  if (posture === "low") return risk === "low" ? "approve" : "prompt";
  return "prompt"; // "none" — every action prompts
}

export type DecideResult =
  | { ok: true; status: PermissionStatus; task?: ApplyTask }
  | { ok: false; error: string };

export class PermissionQueue {
  private items = new Map<string, PendingPermission>();
  private seq = 0;
  constructor(private clock: () => number = () => Date.now()) {}

  enqueue(req: PermissionRequest): PendingPermission {
    const id = `perm-${++this.seq}`;
    const p: PendingPermission = { ...req, id, createdAt: new Date(this.clock()).toISOString(), status: "pending" };
    this.items.set(id, p);
    return p;
  }

  pending(): PendingPermission[] {
    return [...this.items.values()].filter((p) => p.status === "pending");
  }

  get(id: string): PendingPermission | undefined {
    return this.items.get(id);
  }

  decide(id: string, decision: "approve" | "deny"): DecideResult {
    const p = this.items.get(id);
    if (!p) return { ok: false, error: "unknown_permission" };
    if (p.status !== "pending") return { ok: false, error: `already_${p.status}` };
    p.status = decision === "approve" ? "approved" : "denied";
    if (decision === "deny") return { ok: true, status: "denied" };
    const task: ApplyTask = {
      permissionId: p.id,
      action: p.action,
      payload: p.payload,
      targetPath: p.targetPath,
      note: "Apply with your OWN Edit/Write/Bash tools — Claude Code's permission prompt is Gate 2. The Companion does not touch the project or shell.",
    };
    return { ok: true, status: "approved", task };
  }
}
