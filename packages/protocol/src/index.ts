/**
 * @pairwave/protocol — the single source of truth for the wire.
 * Imported by the relay, the companion, and the UI so all three agree on the bytes.
 * See ../../../docs/SPEC.md.
 */
export * from "./envelope.js";
export * from "./messages.js";
export * from "./turn.js";
export * from "./sodium.js";
export * from "./canonical.js";
export * from "./crypto.js";
export * from "./dag.js";
export * from "./transport.js";

export const PROTOCOL_VERSION = 1 as const;
