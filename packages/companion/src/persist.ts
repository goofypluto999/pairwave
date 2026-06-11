/**
 * Local persistence — the Companion's only filesystem footprint.  (SPEC §3.2, §10, §11)
 *
 * Everything lives under two roots, and NOTHING else is ever touched:
 *   ~/.pairwave/identity.json              — long-lived Ed25519 identity (per user, 0600)
 *   <project>/.pairwave/                   — per-project state (git-ignored):
 *     config.json                          — room config (relay URL, room id, salt, passphrase, peer)
 *     <roomId>/log.jsonl                   — the durable verified message log (append-only)
 *     <roomId>/state.json                  — lastSeq, SAS verification, pinned peer keys
 *     <roomId>/outbox.json                 — sealed-but-unconfirmed publishes (crash-safe resend)
 *     <roomId>/quarantine/...              — inert shared-code artifacts
 *     <roomId>/handoff-*.md                — session handoffs
 *
 * JSON writes go through `safeWriteJson` (tmp + rename) so a crash mid-write can't corrupt state.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  generateIdentity,
  toB64,
  fromB64,
  Message as MessageSchema,
  type Message,
  type PublishEnvelope,
} from "@pairwave/protocol";

// ───────────────────────── crash-safe JSON ─────────────────────────

export function safeWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined; // corrupt file → treated as absent, never crashes the boot
  }
}

// ───────────────────────── identity (SPEC §10) ─────────────────────────

export type IdentityRecord = { v: 1; pubKeyB64: string; secretKeyB64: string; createdAt: string };

export function identityPath(): string {
  return join(homedir(), ".pairwave", "identity.json");
}

/** Load the per-user identity keypair, generating + persisting one on first use (TOFU root). */
export async function loadOrCreateIdentity(
  path = identityPath(),
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const existing = readJson<IdentityRecord>(path);
  if (existing && existing.v === 1 && existing.pubKeyB64 && existing.secretKeyB64) {
    return { publicKey: await fromB64(existing.pubKeyB64), secretKey: await fromB64(existing.secretKeyB64) };
  }
  const id = await generateIdentity();
  const rec: IdentityRecord = {
    v: 1,
    pubKeyB64: await toB64(id.publicKey),
    secretKeyB64: await toB64(id.secretKey),
    createdAt: new Date().toISOString(),
  };
  safeWriteJson(path, rec);
  return id;
}

// ───────────────────────── room config ─────────────────────────

export type RoomConfig = {
  v: 1;
  roomId: string;
  relayUrl: string;
  saltB64: string;
  /** Room passphrase — key material; the config file is 0600 + git-ignored. */
  passphrase: string;
  peerId: string;
  name: string;
  uiPort?: number;
};

export function configPath(pairwaveDir: string): string {
  return join(pairwaveDir, "config.json");
}

export function loadConfig(pairwaveDir: string): RoomConfig | undefined {
  const cfg = readJson<RoomConfig>(configPath(pairwaveDir));
  if (!cfg || cfg.v !== 1 || !cfg.roomId || !cfg.relayUrl || !cfg.saltB64 || !cfg.passphrase || !cfg.peerId) {
    return undefined;
  }
  return cfg;
}

export function saveConfig(pairwaveDir: string, cfg: RoomConfig): void {
  safeWriteJson(configPath(pairwaveDir), cfg);
}

// ───────────────────────── room state ─────────────────────────

export type RoomState = {
  v: 1;
  lastSeq: number;
  sasVerified: boolean;
  /** peerId -> pinned pubKey (TOFU; a change flips verification to "changed"). */
  pinnedPeers: Record<string, string>;
};

const EMPTY_STATE: RoomState = { v: 1, lastSeq: 0, sasVerified: false, pinnedPeers: {} };

export class RoomStore {
  readonly roomDir: string;

  constructor(
    readonly pairwaveDir: string,
    readonly roomId: string,
  ) {
    this.roomDir = join(pairwaveDir, roomId.replace(/[^A-Za-z0-9._-]/g, "_"));
    mkdirSync(this.roomDir, { recursive: true });
  }

  // state.json
  loadState(): RoomState {
    return readJson<RoomState>(join(this.roomDir, "state.json")) ?? { ...EMPTY_STATE, pinnedPeers: {} };
  }

  saveState(state: RoomState): void {
    safeWriteJson(join(this.roomDir, "state.json"), state);
  }

  // log.jsonl — the durable verified message log
  appendMessage(m: Message): void {
    appendFileSync(join(this.roomDir, "log.jsonl"), JSON.stringify(m) + "\n", "utf8");
  }

  loadMessages(): Message[] {
    const path = join(this.roomDir, "log.jsonl");
    if (!existsSync(path)) return [];
    const out: Message[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = MessageSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // a torn/corrupt line is skipped, never fatal — the relay can replay anything missing
      }
    }
    return out;
  }

  // outbox.json — sealed publishes not yet confirmed by a relay echo
  loadOutbox(): Record<string, PublishEnvelope> {
    return readJson<Record<string, PublishEnvelope>>(join(this.roomDir, "outbox.json")) ?? {};
  }

  saveOutbox(outbox: Record<string, PublishEnvelope>): void {
    safeWriteJson(join(this.roomDir, "outbox.json"), outbox);
  }

  // ephemeral.json — this room's forward-secrecy X25519 keypair (SPEC §10.1). Persists across
  // restarts so replay still decrypts; DELETED on burn so recorded ciphertext becomes unreadable.
  loadEphemeral(): { pubKeyB64: string; secretKeyB64: string } | undefined {
    return readJson<{ pubKeyB64: string; secretKeyB64: string }>(join(this.roomDir, "ephemeral.json"));
  }

  saveEphemeral(rec: { pubKeyB64: string; secretKeyB64: string }): void {
    safeWriteJson(join(this.roomDir, "ephemeral.json"), rec);
  }

  deleteEphemeral(): void {
    try {
      rmSync(join(this.roomDir, "ephemeral.json"), { force: true });
    } catch {
      /* already gone */
    }
  }
}
