/**
 * Canonical JSON serialization — used for hashing/signing.  (SPEC §5.2, §5.4)
 *
 * Both peers must produce byte-identical output for the same logical value, so we sort object keys,
 * emit no insignificant whitespace, and omit `undefined`. Hashing is always done over the WIRE
 * object (the exact thing serialized into the ciphertext), excluding `hash` and `sig` — never over a
 * Zod-coerced object, so default-filling on the receiver can't change the digest.
 */
export function canonicalString(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalString(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalString(obj[k])).join(",") + "}";
  }
  throw new Error("cannot canonicalize value of type " + t);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalString(value));
}
