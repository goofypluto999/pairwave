/**
 * Danger guard — the filter every inbound action is checked against.  (SPEC §9.6)
 *
 * Catches destructive intent BEFORE Gate 1: mass deletions, terraform/infra ops, force-pushes,
 * disk/database wipes, writes into protected paths. A flagged action is forced to HIGH risk and
 * can NEVER be auto-approved — no charter posture, no session allow-list, no exception: a human
 * must read the flags and approve explicitly. Creation/production stays friction-free.
 */
import type { ActionKind } from "@pairwave/protocol";

export type DangerFlag = { rule: string; detail: string };

const COMMAND_RULES: { rule: string; re: RegExp; detail: string }[] = [
  { rule: "recursive_delete", re: /\b(rm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)[a-z]*|rimraf|del\s+\/[sq]|rmdir\s+\/s|Remove-Item\b[^\n]*(-Recurse|-Force))/i, detail: "recursive/forced deletion" },
  { rule: "wildcard_delete", re: /\b(rm|del|Remove-Item)\b[^\n&|;]*\s(\*|\/|~|\$HOME|%USERPROFILE%)(\s|$|[\\/]\*)/i, detail: "wildcard / root / home deletion" },
  { rule: "terraform_infra", re: /\b(terraform\s+(destroy|apply)|pulumi\s+(destroy|up)|aws\s+\w+\s+delete|gcloud\s+\w+\s+delete|az\s+\w+\s+delete|kubectl\s+delete)\b/i, detail: "infrastructure mutation/teardown" },
  { rule: "git_history_destruction", re: /\bgit\s+(push\s+[^\n]*--force|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s)/i, detail: "git history/work destruction" },
  { rule: "disk_or_db_wipe", re: /\b(mkfs|dd\s+[^\n]*of=\/dev|format\s+[a-z]:|diskpart|drop\s+(table|database|schema)|truncate\s+table|db\.dropDatabase)\b/i, detail: "disk or database wipe" },
  { rule: "system_control", re: /\b(shutdown|reboot|halt\b|systemctl\s+(stop|disable|mask)|taskkill\s+\/f|Stop-Computer|Restart-Computer)\b/i, detail: "system power/service control" },
  { rule: "broad_permissions", re: /\b(chmod\s+-R\s*777|icacls\b[^\n]*\/grant\s+everyone|chown\s+-R)\b/i, detail: "mass permission change" },
  { rule: "package_publish", re: /\b(npm\s+publish|pypi|twine\s+upload|cargo\s+publish|gem\s+push|docker\s+push)\b/i, detail: "publishing artifacts publicly" },
  { rule: "billing_or_deploy", re: /\b(vercel\s+--prod|railway\s+up|eas\s+build|fly\s+deploy|stripe\b)\b/i, detail: "billed deploy / payment surface" },
];

/** Paths an exchanged write/patch may never touch without explicit human approval. */
const PROTECTED_PATH = /(^|[\\/])(\.env[^\\/]*|\.git|\.ssh|\.aws|\.gnupg|\.pairwave|id_rsa[^\\/]*|.*\.pem|.*\.key|node_modules)([\\/]|$)|^([a-z]:[\\/])?(windows|users|system32|etc|usr|boot|opt)([\\/]|$)/i;

export function scanDanger(action: ActionKind, payload: string, targetPath?: string): DangerFlag[] {
  const flags: DangerFlag[] = [];
  if (action === "run_command") {
    for (const { rule, re, detail } of COMMAND_RULES) {
      if (re.test(payload)) flags.push({ rule, detail });
    }
  }
  if ((action === "write_file" || action === "apply_patch") && targetPath && PROTECTED_PATH.test(targetPath)) {
    flags.push({ rule: "protected_path", detail: `writes into a protected location: ${targetPath}` });
  }
  if (action === "fetch_url" && /\b(169\.254\.169\.254|metadata\.google|localhost:?\d*\/(admin|api\/keys))/i.test(payload)) {
    flags.push({ rule: "suspicious_fetch", detail: "fetch targets an internal/metadata endpoint" });
  }
  return flags;
}

export function isDangerous(action: ActionKind, payload: string, targetPath?: string): boolean {
  return scanDanger(action, payload, targetPath).length > 0;
}
