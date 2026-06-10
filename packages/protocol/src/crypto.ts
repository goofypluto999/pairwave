/**
 * Crypto core — concrete implementation.  (SPEC §10, §15.3)
 *
 * Primitives (libsodium sumo): Argon2id KDF, XChaCha20-Poly1305 AEAD, Ed25519 signatures, BLAKE2b
 * hashing, and the SAS word list. Pure (no filesystem) so the relay and a future browser build can
 * import it; the Companion adds key persistence on top.
 *
 *   build → hash(core) → sign(hash) → attach hash+sig → seal(AEAD over the whole message)
 *   open  → AEAD decrypt → recompute hash over the RAW core → compare → verify sig → Zod-validate
 *
 * `open` fails closed on every error path. roomId is bound as AEAD associated data, so ciphertext
 * cannot be replayed into a different room.
 */
import { sodium, toB64, fromB64 } from "./sodium.js";
import { canonicalBytes } from "./canonical.js";
import { Message } from "./messages.js";
import type { RelayEnvelope } from "./envelope.js";

/** Distributive Omit so the discriminated union keeps each variant's kind↔body correlation. */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
/** A message with everything except its own integrity fields — what gets hashed. */
export type MessageCore = DistributiveOmit<Message, "hash" | "sig">;

export type Identity = { publicKey: Uint8Array; secretKey: Uint8Array };
export type Sealed = Pick<RelayEnvelope, "nonce" | "ciphertext">;

export type CryptoErrorCode =
  | "decrypt_failed"
  | "malformed"
  | "missing_hash_sig"
  | "hash_mismatch"
  | "room_mismatch"
  | "bad_signature";

export class PairwaveCryptoError extends Error {
  constructor(public code: CryptoErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PairwaveCryptoError";
  }
}

// ───────────────────────── primitives ─────────────────────────

/** Argon2id(passphrase, roomSalt) -> 32-byte session key. roomSalt must be SALTBYTES. */
export async function deriveSessionKey(passphrase: string, roomSalt: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  if (roomSalt.length !== s.crypto_pwhash_SALTBYTES) {
    throw new PairwaveCryptoError("malformed", `roomSalt must be ${s.crypto_pwhash_SALTBYTES} bytes`);
  }
  return s.crypto_pwhash(
    32,
    passphrase,
    roomSalt,
    s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Generate a long-lived Ed25519 identity keypair (SPEC §10). Pure — persistence is the Companion's job. */
export async function generateIdentity(): Promise<Identity> {
  const s = await sodium();
  const kp = s.crypto_sign_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** BLAKE2b-256. */
export async function blake2b(data: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_generichash(32, data);
}

/** Canonical BLAKE2b hash of any value, base64. */
export async function hashCanonical(value: unknown): Promise<string> {
  return toB64(await blake2b(canonicalBytes(value)));
}

/** Sign a base64 hash with an Ed25519 secret key -> base64 detached signature. */
export async function sign(hashB64: string, secretKey: Uint8Array): Promise<string> {
  const s = await sodium();
  return toB64(s.crypto_sign_detached(await fromB64(hashB64), secretKey));
}

/** Verify a detached signature over a base64 hash. Never throws — returns false on any error. */
export async function verifySig(sigB64: string, hashB64: string, pubKey: Uint8Array): Promise<boolean> {
  const s = await sodium();
  try {
    return s.crypto_sign_verify_detached(await fromB64(sigB64), await fromB64(hashB64), pubKey);
  } catch {
    return false;
  }
}

// ───────────────────────── message build / seal / open ─────────────────────────

/** Attach integrity fields: hash over the core, signature over the hash. */
export async function buildMessage(core: MessageCore, secretKey: Uint8Array): Promise<Message> {
  const hash = await hashCanonical(core);
  const sig = await sign(hash, secretKey);
  return { ...(core as object), hash, sig } as Message;
}

/** AEAD-encrypt a fully-built message. roomId is bound as associated data. */
export async function seal(message: Message, sessionKey: Uint8Array): Promise<Sealed> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(message));
  const ad = new TextEncoder().encode(message.roomId);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, sessionKey);
  return { nonce: await toB64(nonce), ciphertext: await toB64(ct) };
}

/**
 * Decrypt + fully verify an envelope. Order matters: AEAD (incl. roomId binding) → hash recompute
 * over the raw wire core → roomId field check → signature by the claimed sender → Zod shape.
 */
export async function open(envelope: RelayEnvelope, sessionKey: Uint8Array): Promise<Message> {
  const s = await sodium();
  const ad = new TextEncoder().encode(envelope.roomId);

  let plain: Uint8Array;
  try {
    plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      await fromB64(envelope.ciphertext),
      ad,
      await fromB64(envelope.nonce),
      sessionKey,
    );
  } catch {
    throw new PairwaveCryptoError("decrypt_failed");
  }

  let raw: any;
  try {
    raw = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new PairwaveCryptoError("malformed");
  }
  if (!raw || typeof raw !== "object") throw new PairwaveCryptoError("malformed");

  const { hash, sig, ...core } = raw;
  if (typeof hash !== "string" || typeof sig !== "string") {
    throw new PairwaveCryptoError("missing_hash_sig");
  }
  if ((await hashCanonical(core)) !== hash) throw new PairwaveCryptoError("hash_mismatch");
  if (core.roomId !== envelope.roomId) throw new PairwaveCryptoError("room_mismatch");

  const pub = core.sender?.pubKey;
  if (typeof pub !== "string" || !(await verifySig(sig, hash, await fromB64(pub)))) {
    throw new PairwaveCryptoError("bad_signature");
  }

  const parsed = Message.safeParse(raw);
  if (!parsed.success) throw new PairwaveCryptoError("malformed", parsed.error.message);
  return parsed.data;
}

// ───────────────────────── SAS (out-of-band MITM defense, SPEC §10) ─────────────────────────

/**
 * 64-word list (unique, phonetically distinct). 6 words ≈ 36 bits — adequate for an interactive
 * fingerprint humans compare live. The list/length are intentionally tunable (Phase 7 can swap in a
 * larger list); both peers share this exact mapping, so SAS correctness does not depend on the size.
 */
const SAS_WORDS = [
  "apple", "anchor", "amber", "arrow", "basil", "bison", "brick", "bloom",
  "cable", "cedar", "cobra", "coral", "delta", "diary", "dover", "drum",
  "eagle", "ember", "envoy", "ether", "falcon", "fern", "flint", "frost",
  "glade", "glove", "grape", "gulf", "harbor", "hazel", "hippo", "hotel",
  "indigo", "ivory", "ionic", "igloo", "jade", "jolt", "juno", "jumbo",
  "kayak", "kiosk", "koala", "krill", "lemon", "lilac", "lotus", "lunar",
  "mango", "maple", "micro", "mocha", "nectar", "nimbus", "noble", "nylon",
  "oasis", "ocean", "olive", "onyx", "panda", "pearl", "pixel", "prism",
] as const;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (ai !== bi) return ai - bi;
  }
  return a.length - b.length;
}

/** Order-independent SAS: identical words for both peers regardless of who computes it. */
export async function sas(
  myPubKey: Uint8Array,
  peerPubKey: Uint8Array,
  roomSalt: Uint8Array,
  words = 6,
): Promise<string[]> {
  const [lo, hi] = compareBytes(myPubKey, peerPubKey) <= 0 ? [myPubKey, peerPubKey] : [peerPubKey, myPubKey];
  const input = new Uint8Array(lo.length + hi.length + roomSalt.length);
  input.set(lo, 0);
  input.set(hi, lo.length);
  input.set(roomSalt, lo.length + hi.length);
  const digest = await blake2b(input);
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(SAS_WORDS[(digest[i] as number) % SAS_WORDS.length]!);
  }
  return out;
}
