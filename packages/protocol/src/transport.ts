/**
 * Client ↔ relay transport frames.  (SPEC §3.1, §5.5)
 *
 * Lives in the protocol package so the Companion (client) and the relay agree on the wire. The
 * relay only ever handles these frames + the opaque envelope — it never sees a decrypted Message.
 *
 * Note: a client publishes a `PublishEnvelope` (no seq/tsRelay); the relay assigns `seq` + `tsRelay`
 * and fans out a complete `RelayEnvelope`. That keeps ordering authority with the relay while the
 * content stays end-to-end encrypted.
 */
import { z } from "zod";
import { Base64, RelayEnvelope, ControlFrame } from "./envelope.js";

/** What a client sends to publish — the relay completes it with seq + tsRelay. */
export const PublishEnvelope = z.object({
  v: z.literal(1),
  roomId: z.string().min(8),
  /** Which key sealed this (0 = room/handshake key, 1 = ephemeral content key). (SPEC §10.1) */
  keyEpoch: z.number().int().nonnegative().default(0),
  nonce: Base64,
  ciphertext: Base64,
});
export type PublishEnvelope = z.infer<typeof PublishEnvelope>;

/** client → relay */
export const ClientFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("join"),
    roomId: z.string().min(8),
    peerId: z.string().min(1),
    /** If present, replay stored envelopes with seq greater than this. */
    sinceSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ t: z.literal("publish"), env: PublishEnvelope }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("burn"), roomId: z.string().min(8) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** relay → client */
export const ServerFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    roomId: z.string(),
    lastSeq: z.number().int().nonnegative(),
    peerCount: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal("envelope"), env: RelayEnvelope }),
  z.object({ t: z.literal("control"), frame: ControlFrame }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
