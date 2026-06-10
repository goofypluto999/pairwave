/**
 * CompanionCore — the in-memory brain that composes every module.  (SPEC §3.2)
 *
 * It is deliberately I/O-free: no sockets, no filesystem. It holds the verified message log and:
 *   - `send(kind, body, origin)` → runs the full gate (bootstrap → secret scan → floor), then
 *      builds + signs + seals an outbound message and appends it to our own log.
 *   - `ingest(envelope)` → decrypts + verifies + dedupes + appends an inbound message.
 *   - derives `floor()`, `ledger()`, `bootstrap()` views on demand.
 * The relay client, MCP server, and UI bridge (later chunks) are thin I/O wrappers around this.
 */
import { randomUUID } from "node:crypto";
import {
  buildMessage,
  seal,
  open,
  toB64,
  FloorPolicy as FloorPolicySchema,
  type Message,
  type RelayEnvelope,
  type PublishEnvelope,
  type FloorPolicy,
  type Origin,
  type MessageKind,
  type Charter,
} from "@pairwave/protocol";
import { deriveFloor, type FloorView } from "./floor.js";
import { deriveLedger, type ActivityLedger } from "./ledger.js";
import { gateSend, deriveBootstrap, computeCharterHash, type BootstrapState } from "./bootstrap.js";
import { scanForSecrets, type SecretFinding } from "./secrets.js";

export type CompanionConfig = {
  roomId: string;
  peer: { peerId: string; name: string };
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  sessionKey: Uint8Array;
  policy?: FloorPolicy;
  clock?: () => number;
  idgen?: () => string;
};

export type SendResult =
  | { ok: true; message: Message; publish: PublishEnvelope }
  | { ok: false; code: string; reason: string; secrets?: SecretFinding[] };

export type IngestResult =
  | { ok: true; message: Message }
  | { ok: false; code: "duplicate"; msgId: string }
  | { ok: false; code: string; msgId?: undefined };

export class CompanionCore {
  private log: Message[] = [];
  private seen = new Set<string>();
  private sasVerified = false;
  private pubB64?: string;
  private policy: FloorPolicy;
  private readonly clock: () => number;
  private readonly idgen: () => string;

  constructor(private readonly cfg: CompanionConfig) {
    this.policy = cfg.policy ?? FloorPolicySchema.parse({});
    this.clock = cfg.clock ?? (() => Date.now());
    this.idgen = cfg.idgen ?? (() => randomUUID());
  }

  /** Adopt the floor policy agreed in the charter. (SPEC §6) */
  setPolicy(policy: FloorPolicy): void {
    this.policy = policy;
  }

  getPolicy(): FloorPolicy {
    return this.policy;
  }

  /** Local SAS confirmation (the humans compared fingerprints out of band). */
  verifyPeer(verified = true): void {
    this.sasVerified = verified;
  }

  get isVerified(): boolean {
    return this.sasVerified;
  }

  messages(): Message[] {
    return [...this.log];
  }

  /** Seed the log with messages already verified by the caller (boot-time reload from disk). */
  seedVerified(messages: Message[]): void {
    for (const m of messages) {
      if (this.seen.has(m.msgId)) continue;
      this.log.push(m);
      this.seen.add(m.msgId);
    }
  }

  floor(): FloorView {
    return deriveFloor(this.log, this.policy, new Date(this.clock()).toISOString());
  }

  ledger(): ActivityLedger {
    return deriveLedger(this.log);
  }

  bootstrap(): BootstrapState {
    return deriveBootstrap(this.log);
  }

  /** Current DAG heads — new messages parent on these (merging any fork). */
  private heads(): string[] {
    const parented = new Set<string>();
    for (const m of this.log) for (const p of m.parents) parented.add(p);
    return this.log.filter((m) => !parented.has(m.hash)).map((m) => m.hash);
  }

  private appendVerified(m: Message): void {
    this.log.push(m);
    this.seen.add(m.msgId);
  }

  /** Build → gate → secret-scan → sign → seal an outbound message. */
  async send(kind: MessageKind, body: unknown, origin: Origin): Promise<SendResult> {
    const nowIso = new Date(this.clock()).toISOString();
    const prospective = { kind, origin, senderPeerId: this.cfg.peer.peerId };
    const gate = gateSend(this.log, { sasVerified: this.sasVerified }, prospective, this.policy, nowIso);
    if (!gate.allowed) {
      return { ok: false, code: gate.code ?? "blocked", reason: gate.reason ?? "send not allowed" };
    }

    const secrets = scanForSecrets(JSON.stringify(body));
    if (secrets.length > 0) {
      return { ok: false, code: "secret_blocked", reason: "outbound secret detected — send blocked", secrets };
    }

    const view = deriveFloor(this.log, this.policy, nowIso);
    const pubKey = (this.pubB64 ??= await toB64(this.cfg.identity.publicKey));
    const core = {
      v: 1,
      msgId: this.idgen(),
      roomId: this.cfg.roomId,
      sender: { peerId: this.cfg.peer.peerId, name: this.cfg.peer.name, pubKey },
      origin,
      ts: nowIso,
      parents: this.heads(),
      turn: { floor: view.floor, turnId: view.turnId, hop: view.hop },
      kind,
      body,
    };
    const message = await buildMessage(core as unknown as Parameters<typeof buildMessage>[0], this.cfg.identity.secretKey);
    this.appendVerified(message);
    const sealed = await seal(message, this.cfg.sessionKey);
    return {
      ok: true,
      message,
      publish: { v: 1, roomId: this.cfg.roomId, nonce: sealed.nonce, ciphertext: sealed.ciphertext },
    };
  }

  /** Decrypt + verify + dedupe an inbound envelope, appending it to the verified log. */
  async ingest(env: RelayEnvelope): Promise<IngestResult> {
    if (env.roomId !== this.cfg.roomId) return { ok: false, code: "wrong_room" };
    let message: Message;
    try {
      message = await open(env, this.cfg.sessionKey);
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? "open_failed" };
    }
    if (this.seen.has(message.msgId)) return { ok: false, code: "duplicate", msgId: message.msgId };
    this.appendVerified(message);
    return { ok: true, message };
  }

  // ── charter convenience ──

  async proposeCharter(charter: Charter): Promise<SendResult> {
    const charterHash = await computeCharterHash(charter);
    return this.send("system.charter", { proposal: { ...charter, charterHash }, state: "propose" }, "human");
  }

  async acceptCharter(charterHash: string): Promise<SendResult> {
    const proposal = this.log.find(
      (m) => m.kind === "system.charter" && m.body.proposal.charterHash === charterHash,
    );
    if (!proposal || proposal.kind !== "system.charter") {
      return { ok: false, code: "no_proposal", reason: "no such charter proposal in the log" };
    }
    return this.send("system.charter", { proposal: proposal.body.proposal, state: "accept" }, "human");
  }
}
