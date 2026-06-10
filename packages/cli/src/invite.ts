/**
 * Invite code codec.  (SPEC §13.1)
 *
 * One code carries everything the second machine needs: relay URL, room id, salt, passphrase.
 * Format: `pw1.<base64url(JSON)>` — versioned, validated on decode, never executed as anything.
 * Share it over a trusted out-of-band channel (Signal, in person); it IS the room key material.
 */
export type Invite = {
  v: 1;
  roomId: string;
  relayUrl: string;
  saltB64: string;
  passphrase: string;
};

export function encodeInvite(invite: Invite): string {
  return "pw1." + Buffer.from(JSON.stringify(invite), "utf8").toString("base64url");
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (!trimmed.startsWith("pw1.")) throw new Error("not a Pairwave invite (expected it to start with pw1.)");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(4), "base64url").toString("utf8"));
  } catch {
    throw new Error("invite code is corrupted — ask your peer to copy it again, whole");
  }
  const inv = parsed as Invite;
  if (
    !inv ||
    inv.v !== 1 ||
    typeof inv.roomId !== "string" ||
    inv.roomId.length < 8 ||
    typeof inv.relayUrl !== "string" ||
    typeof inv.saltB64 !== "string" ||
    typeof inv.passphrase !== "string" ||
    inv.passphrase.length < 16
  ) {
    throw new Error("invite code is malformed or from an incompatible Pairwave version");
  }
  return inv;
}
