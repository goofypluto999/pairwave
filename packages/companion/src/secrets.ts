/**
 * Outbound secret scan.  (SPEC §9.4)
 *
 * Runs on every message body BEFORE it is sealed and sent. On a hit the Companion blocks the send
 * and warns the human. This enforces the standing key-hygiene rule at the protocol layer — pure +
 * deterministic so it's fully testable. Findings are previews only (masked), never the raw secret.
 */
export type SecretFinding = { rule: string; index: number; preview: string };

const RULES: { rule: string; re: RegExp }[] = [
  { rule: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { rule: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "google_api_key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { rule: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { rule: "github_token", re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
  { rule: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { rule: "slack_token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    rule: "secret_assignment",
    re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|aws_secret_access_key)\b\s*[:=]\s*["']?([^\s"']{8,})/gi,
  },
];

function mask(s: string): string {
  return s.length <= 4 ? "****" : `${s.slice(0, 3)}***(len ${s.length})`;
}

export function scanForSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { rule, re } of RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const val = m[1] ?? m[0];
      out.push({ rule, index: m.index, preview: `${rule}:${mask(val)}` });
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width matches
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function hasSecrets(text: string): boolean {
  return scanForSecrets(text).length > 0;
}
