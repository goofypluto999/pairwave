/**
 * libsodium singleton.  (SPEC §15.3)
 *
 * We deliberately load the **CommonJS** build via createRequire: libsodium-wrappers-sumo@0.7.16
 * ships a broken ESM entry (its `.mjs` imports a sibling `libsodium-sumo.mjs` that isn't published),
 * so a direct `import` fails with ERR_MODULE_NOT_FOUND. The CJS build is complete and identical in
 * API. Trade-off: this pins the protocol's crypto to a Node runtime for now; the browser UI (Phase 5)
 * does not import crypto (the Companion holds the key), so this is fine for v1. Revisit if/when the
 * upstream ESM build is fixed.
 *
 * The sumo build includes Argon2id (`crypto_pwhash`), BLAKE2b (`crypto_generichash`),
 * XChaCha20-Poly1305 AEAD, and Ed25519. Call `sodium()` and await it before using any primitive.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const _sodium = require("libsodium-wrappers-sumo") as typeof import("libsodium-wrappers-sumo");

let readyPromise: Promise<void> | null = null;

export async function sodium(): Promise<typeof _sodium> {
  if (!readyPromise) readyPromise = _sodium.ready;
  await readyPromise;
  return _sodium;
}

/** Base64 helpers pinned to the ORIGINAL variant (standard alphabet + `=` padding). */
export async function toB64(bytes: Uint8Array): Promise<string> {
  const s = await sodium();
  return s.to_base64(bytes, s.base64_variants.ORIGINAL);
}

export async function fromB64(text: string): Promise<Uint8Array> {
  const s = await sodium();
  return s.from_base64(text, s.base64_variants.ORIGINAL);
}
