/**
 * RelayEnvelope — the ONLY message content the relay can see.  (SPEC §5.1)
 * ControlFrame — relay-level connection metadata (presence), never message content.  (SPEC §5.5)
 *
 * The relay routes by `roomId`, assigns `seq`, stamps `tsRelay`, and stores the opaque
 * `ciphertext`. It can read none of the message content and cannot forge a valid message
 * (signatures live inside the ciphertext). This file has no crypto — it only describes the wire.
 */
import { z } from "zod";

export const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "expected base64");

export const RelayEnvelope = z.object({
  /** Protocol version. Bump on any breaking wire change. */
  v: z.literal(1),
  /** Routing key. Plaintext — the relay needs it to fan out. Not secret, but unguessable. */
  roomId: z.string().min(8),
  /** Relay-assigned monotonic sequence per room. Transport/display hint only. (SPEC §5.4) */
  seq: z.number().int().nonnegative(),
  /** Relay receive time, ISO-8601 UTC. UNTRUSTED — ordering aid only, never for security. */
  tsRelay: z.string().datetime(),
  /** AEAD nonce (XChaCha20-Poly1305, 24 bytes). Unique per message. (SPEC §15.3) */
  nonce: Base64,
  /** AEAD-encrypted, signed `Message`. The relay treats this as opaque bytes. */
  ciphertext: Base64,
});
export type RelayEnvelope = z.infer<typeof RelayEnvelope>;

/**
 * Relay-level control frame. Carries connection metadata only (presence, pong) — no message
 * content. This is metadata the relay inherently has; it is not E2E-encrypted. (SPEC §5.5)
 */
export const ControlFrame = z.object({
  v: z.literal(1),
  roomId: z.string().min(8),
  type: z.enum(["presence", "pong"]),
  /** How many peers are currently connected to the room (0, 1, or 2 in v1). */
  peerCount: z.number().int().nonnegative(),
  /** Highest seq the relay has stored for the room (lets a client detect it is behind). */
  lastSeq: z.number().int().nonnegative(),
  tsRelay: z.string().datetime(),
});
export type ControlFrame = z.infer<typeof ControlFrame>;

/** What a client asks the relay for when replaying history. (SPEC §3.1, §4.5) */
export const HistoryQuery = z.object({
  roomId: z.string().min(8),
  /** Return envelopes with seq strictly greater than this. */
  sinceSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1000).default(200),
});
export type HistoryQuery = z.infer<typeof HistoryQuery>;
