/**
 * CompanionRuntime — the live composition.  (SPEC §3.2, §4)
 *
 * Boots from `.pairwave/` (config + identity + durable log), connects the reconnecting relay
 * client, and wraps CompanionCore with all real-world side effects:
 *   - durable log append + lastSeq tracking + crash-safe outbox (publish-until-echoed)
 *   - TOFU peer pinning + key-change detection + SAS verification state
 *   - quarantine of inbound `code`, permission queue for inbound `action.request` (Gate 1)
 *   - charter capture (applies the agreed floor policy), inbox derivation, live-mode state
 *   - handoff write on shutdown, change events for the local UI (SSE)
 *
 * It still NEVER touches the project tree or shell — apply tasks are descriptors for the user's
 * own Claude (Gate 2).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  deriveSessionKey,
  fromB64,
  toB64,
  sas,
  verify as verifyDag,
  topoOrder,
  FloorPolicy as FloorPolicySchema,
  LiveModePolicy as LiveModePolicySchema,
  type Message,
  type RelayEnvelope,
  type Charter,
  type Origin,
  type MessageKind,
  type ControlFrame,
} from "@pairwave/protocol";
import { CompanionCore, type SendResult } from "./engine.js";
import { computeCharterHash } from "./bootstrap.js";
import { RelayClient } from "./relayclient.js";
import { loadConfig, loadOrCreateIdentity, RoomStore, type RoomConfig, type RoomState } from "./persist.js";
import { PermissionQueue, normalizeRisk, gate1Decision, type ApplyTask, type PendingPermission } from "./permissions.js";
import { quarantineCode, readQuarantined, type QuarantinedArtifact } from "./quarantine.js";
import { scanDanger } from "./guard.js";
import { deriveLedger, type ActivityLedger } from "./ledger.js";
import { deriveBrain, recallBrain, type BrainView, type RecallHit, type BrainEntry } from "./brain.js";
import { writeHandoff, readLatestHandoff } from "./handoff.js";

export type RuntimeStatus = {
  roomId: string;
  me: { peerId: string; name: string };
  relay: { url: string; connected: boolean; peerCount?: number | undefined };
  peers: { peerId: string; name: string }[];
  verification: { verified: boolean; changed: boolean; sasWords?: string[] | undefined };
  charter: { agreed: boolean; hash?: string | undefined; title?: string | undefined; autoApprove?: string | undefined };
  floor: { holder: string | "none"; turnId: string; hop: number; pendingClaim?: string | undefined };
  ledger: ActivityLedger;
  brain: { total: number; recent: { headline: string; peerId: string; ts: string; entryKind: string }[] };
  pendingPermissions: PendingPermission[];
  approvedTasks: { permissionId: string; requestMsgId: string; action: string; targetPath?: string | undefined }[];
  liveMode: { on: boolean; pollSec: number; maxMinutes: number };
  lastSeq: number;
  uiUrl?: string | undefined;
};

export type InboxView = {
  questionsForMe: { msgId: string; from: string; text: string; ts: string }[];
  pendingPermissions: PendingPermission[];
  approvedTasks: ApplyTask[];
  unresolvedMyRequests: { msgId: string; summary: string; ts: string }[];
};

const MAX_TOOL_TEXT = 4000;

function clip(s: string): string {
  return s.length > MAX_TOOL_TEXT ? s.slice(0, MAX_TOOL_TEXT) + `\n…[clipped ${s.length - MAX_TOOL_TEXT} chars]` : s;
}

/** Recursively clip long string fields so tool output stays bounded without corrupting structure. */
function clipValue(v: unknown): unknown {
  if (typeof v === "string") return clip(v);
  if (Array.isArray(v)) return v.map(clipValue);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipValue(x)]));
  }
  return v;
}

export class CompanionRuntime {
  readonly core: CompanionCore;
  readonly store: RoomStore;
  readonly queue = new PermissionQueue();
  readonly cfg: RoomConfig;
  uiUrl?: string;

  private client?: RelayClient;
  private state: RoomState;
  private outbox: Record<string, import("@pairwave/protocol").PublishEnvelope>;
  private artifacts = new Map<string, QuarantinedArtifact>();
  private approvedTasks = new Map<string, { task: ApplyTask; requestMsgId: string }>();
  private sessionAllow = new Set<string>();
  private keyChanged = false;
  private connected = false;
  private peerCount: number | undefined;
  private live = { on: false, startedAt: 0 };
  private listeners = new Set<() => void>();
  private chainOk = true;
  private myPubB64 = "";
  /** Envelopes that failed decrypt/verify — surfaced, never silent. (SPEC §12) */
  droppedCount = 0;

  private constructor(
    readonly pairwaveDir: string,
    cfg: RoomConfig,
    core: CompanionCore,
    store: RoomStore,
  ) {
    this.cfg = cfg;
    this.core = core;
    this.store = store;
    this.state = store.loadState();
    this.outbox = store.loadOutbox();
  }

  /** Boot: load config + identity + durable log, verify the DAG, rebuild local state. */
  static async boot(pairwaveDir: string): Promise<CompanionRuntime> {
    const cfg = loadConfig(pairwaveDir);
    if (!cfg) {
      throw new Error(
        `No Pairwave room configured under ${pairwaveDir}. Run \`pairwave init\` (or \`pairwave join <invite>\`) first.`,
      );
    }
    const identity = await loadOrCreateIdentity();
    const sessionKey = await deriveSessionKey(cfg.passphrase, await fromB64(cfg.saltB64));
    const core = new CompanionCore({
      roomId: cfg.roomId,
      peer: { peerId: cfg.peerId, name: cfg.name },
      identity,
      sessionKey,
    });
    const store = new RoomStore(pairwaveDir, cfg.roomId);
    const rt = new CompanionRuntime(pairwaveDir, cfg, core, store);
    rt.myPubB64 = await toB64(identity.publicKey);

    // Reload the durable log, verify integrity, and replay local side effects (quarantine, perms).
    const persisted = store.loadMessages();
    if (persisted.length) {
      const v = await verifyDag(persisted);
      rt.chainOk = v.bad.length === 0; // missing parents can be legitimate (pre-history horizon)
      core.seedVerified(persisted);
      for (const m of persisted) rt.applySideEffects(m, { replay: true });
    }
    core.verifyPeer(rt.state.sasVerified);
    rt.applyAgreedCharterPolicy();
    return rt;
  }

  // ───────────────────────── relay wiring ─────────────────────────

  start(): void {
    this.client = new RelayClient({
      url: this.cfg.relayUrl,
      roomId: this.cfg.roomId,
      peerId: this.cfg.peerId,
      sinceSeq: () => this.state.lastSeq,
      onEnvelope: (env) => void this.ingestEnvelope(env),
      onControl: (frame) => this.onControl(frame),
      onStatus: (s) => {
        this.connected = s.connected;
        if (s.peerCount !== undefined) this.peerCount = s.peerCount;
        this.emit();
      },
      onJoined: () => this.flushOutbox(),
    });
    this.client.connect();
    void this.announceHello();
  }

  private onControl(frame: ControlFrame): void {
    if (frame.type === "presence") {
      this.peerCount = frame.peerCount;
      this.emit();
    }
  }

  private flushOutbox(): void {
    for (const env of Object.values(this.outbox)) this.client?.publish(env);
  }

  private async announceHello(): Promise<void> {
    const haveMyHello = this.core
      .messages()
      .some((m) => m.kind === "system.hello" && m.sender.peerId === this.cfg.peerId && m.sender.pubKey === this.myPubB64);
    if (!haveMyHello) {
      await this.send("system.hello", {
        peer: { peerId: this.cfg.peerId, name: this.cfg.name, pubKey: this.myPubB64 },
        capabilities: { tool: "pairwave-companion", v: 1 },
      }, "agent");
    }
  }

  async ingestEnvelope(env: RelayEnvelope): Promise<void> {
    if (env.seq > this.state.lastSeq) {
      this.state.lastSeq = env.seq;
      this.store.saveState(this.state);
    }
    const result = await this.core.ingest(env);
    if (!result.ok) {
      if (result.code === "duplicate" && result.msgId) this.confirmOutbox(result.msgId);
      else {
        // Never silent (SPEC §12): a dropped envelope is surfaced, counted, and shown in the UI.
        this.droppedCount += 1;
        process.stderr.write(`[pairwave] dropped envelope seq=${env.seq}: ${result.code}\n`);
        this.emit();
      }
      return;
    }
    this.store.appendMessage(result.message);
    this.confirmOutbox(result.message.msgId);
    this.applySideEffects(result.message, { replay: false });
    this.emit();
  }

  private confirmOutbox(msgId: string): void {
    if (this.outbox[msgId]) {
      delete this.outbox[msgId];
      this.store.saveOutbox(this.outbox);
    }
  }

  // ───────────────────────── side effects on verified messages ─────────────────────────

  private applySideEffects(m: Message, opts: { replay: boolean }): void {
    // TOFU pinning + key-change detection (SPEC §10)
    if (m.sender.peerId !== this.cfg.peerId) {
      const pinned = this.state.pinnedPeers[m.sender.peerId];
      if (!pinned) {
        this.state.pinnedPeers[m.sender.peerId] = m.sender.pubKey;
        if (!opts.replay) this.store.saveState(this.state);
      } else if (pinned !== m.sender.pubKey) {
        this.keyChanged = true;
        if (this.state.sasVerified) {
          this.state.sasVerified = false;
          this.core.verifyPeer(false);
          if (!opts.replay) this.store.saveState(this.state);
        }
      }
    }

    // Inbound code → inert quarantine (idempotent on replay)
    if (m.kind === "code") {
      const art = quarantineCode(this.pairwaveDir, this.cfg.roomId, m.msgId, {
        content: m.body.content,
        language: m.body.language,
        isPatch: m.body.isPatch,
        ...(m.body.pathHint !== undefined ? { pathHint: m.body.pathHint } : {}),
      });
      this.artifacts.set(m.msgId, art);
    }

    // Inbound action.request addressed to me → Gate 1
    if (m.kind === "action.request" && m.sender.peerId !== this.cfg.peerId) {
      const resolved = this.core
        .messages()
        .some((x) => x.kind === "action.result" && x.body.requestMsgId === m.msgId);
      const alreadyQueued = [...this.queue.pending()].some((p) => p.requestMsgId === m.msgId);
      if (!resolved && !alreadyQueued) {
        // Danger guard (SPEC §9.6): flagged actions are forced HIGH and can never auto-approve.
        const dangerFlags = scanDanger(m.body.action, m.body.payload, m.body.targetPath);
        const risk = dangerFlags.length ? "high" : normalizeRisk(m.body.action, m.body.risk);
        const pending = this.queue.enqueue({
          requestMsgId: m.msgId,
          fromPeerId: m.sender.peerId,
          action: m.body.action,
          risk,
          summary: m.body.summary,
          payload: m.body.payload,
          targetPath: m.body.targetPath,
          fromCodeMsgId: m.body.fromCodeMsgId,
          dangerFlags: dangerFlags.length ? dangerFlags : undefined,
        });
        const posture = this.agreedCharter()?.autoApprove ?? "none";
        const auto =
          dangerFlags.length === 0 &&
          (this.sessionAllow.has(m.body.action) || gate1Decision(risk, posture) === "approve");
        if (auto) this.decidePermission(pending.id, "approve");
      }
    }

    // Charter agreement → adopt its floor policy
    if (m.kind === "system.charter") this.applyAgreedCharterPolicy();
  }

  private applyAgreedCharterPolicy(): void {
    const charter = this.agreedCharter();
    if (charter) this.core.setPolicy(FloorPolicySchema.parse(charter.floorPolicy ?? {}));
  }

  // ───────────────────────── sending ─────────────────────────

  async send(kind: MessageKind, body: unknown, origin: Origin): Promise<SendResult> {
    const result = await this.core.send(kind, body, origin);
    if (result.ok) {
      this.store.appendMessage(result.message);
      this.outbox[result.message.msgId] = result.publish;
      this.store.saveOutbox(this.outbox);
      this.client?.publish(result.publish);
      this.applySideEffects(result.message, { replay: false });
      this.emit();
    }
    return result;
  }

  // ───────────────────────── verification (SAS) ─────────────────────────

  peers(): { peerId: string; name: string; pubKey: string }[] {
    const map = new Map<string, { peerId: string; name: string; pubKey: string }>();
    for (const m of this.core.messages()) {
      if (m.sender.peerId !== this.cfg.peerId) map.set(m.sender.peerId, { ...m.sender });
    }
    return [...map.values()];
  }

  async sasWords(): Promise<string[] | undefined> {
    const peer = this.peers()[0];
    if (!peer) return undefined;
    return sas(await fromB64(this.myPubB64), await fromB64(peer.pubKey), await fromB64(this.cfg.saltB64));
  }

  confirmVerification(): void {
    this.state.sasVerified = true;
    this.keyChanged = false;
    this.core.verifyPeer(true);
    this.store.saveState(this.state);
    this.emit();
  }

  // ───────────────────────── charter ─────────────────────────

  agreedCharter(): Charter | undefined {
    const hash = this.core.bootstrap().agreedCharterHash;
    if (!hash) return undefined;
    for (const m of this.core.messages()) {
      if (m.kind === "system.charter" && m.body.proposal.charterHash === hash) return m.body.proposal;
    }
    return undefined;
  }

  async proposeCharter(meta: {
    title: string;
    purpose: string;
    scope?: string[];
    outOfScope?: string[];
    mustNots?: string[];
    responseContract?: string[];
    autoApprove?: "none" | "low" | "all";
  }): Promise<SendResult> {
    const charter: Charter = {
      charterId: randomUUID(),
      title: meta.title,
      purpose: meta.purpose,
      scope: meta.scope ?? [],
      outOfScope: meta.outOfScope ?? [],
      mustNots: meta.mustNots ?? [],
      responseContract: meta.responseContract ?? [
        "Timestamp matters: state dates for any time-sensitive fact.",
        "Label claims as fact, inference, or assumption.",
        "Cite provenance (file + lines, or URL) for context and code.",
        "Curate: minimum payload plus a one-line rationale and a headline.",
      ],
      autoApprove: meta.autoApprove ?? "none",
      floorPolicy: FloorPolicySchema.parse({}),
      liveModePolicy: LiveModePolicySchema.parse({}),
      participants: [
        { peerId: this.cfg.peerId, name: this.cfg.name },
        ...this.peers().map((p) => ({ peerId: p.peerId, name: p.name })),
      ],
      createdAt: new Date().toISOString(),
      charterHash: "",
    };
    // Route through THIS runtime's send (publish + persist + outbox) — the core's own helper only
    // appends locally, which is exactly the bug the e2e caught.
    const charterHash = await computeCharterHash(charter);
    return this.send("system.charter", { proposal: { ...charter, charterHash }, state: "propose" }, "human");
  }

  async acceptCharter(charterHash?: string): Promise<SendResult> {
    const hash = charterHash ?? Object.keys(this.core.bootstrap().acceptedBy)[0];
    if (!hash) return { ok: false, code: "no_proposal", reason: "no charter proposal found" };
    const proposal = this.core
      .messages()
      .find((m) => m.kind === "system.charter" && m.body.proposal.charterHash === hash);
    if (!proposal || proposal.kind !== "system.charter") {
      return { ok: false, code: "no_proposal", reason: "no such charter proposal in the log" };
    }
    return this.send("system.charter", { proposal: proposal.body.proposal, state: "accept" }, "human");
  }

  // ───────────────────────── permissions (Gate 1) ─────────────────────────

  decidePermission(
    id: string,
    decision: "approve" | "deny",
    opts?: { alwaysAllowKind?: boolean },
  ): { ok: boolean; status?: string; task?: ApplyTask; error?: string } {
    const perm = this.queue.get(id);
    const result = this.queue.decide(id, decision);
    if (!result.ok) return { ok: false, error: result.error };
    if (decision === "approve" && result.task && perm) {
      // If the request applies a quarantined artifact, hand Claude the inert content from disk.
      if (perm.fromCodeMsgId) {
        const art = this.artifacts.get(perm.fromCodeMsgId);
        if (art) result.task.payload = readQuarantined(art);
      }
      this.approvedTasks.set(id, { task: result.task, requestMsgId: perm.requestMsgId });
      if (opts?.alwaysAllowKind) this.sessionAllow.add(perm.action);
    }
    this.emit();
    return { ok: true, status: result.status, ...(result.task ? { task: result.task } : {}) };
  }

  getApplyTask(permissionId: string): (ApplyTask & { requestMsgId: string }) | undefined {
    const entry = this.approvedTasks.get(permissionId);
    return entry ? { ...entry.task, requestMsgId: entry.requestMsgId } : undefined;
  }

  async completeAction(requestMsgId: string, ok: boolean, detail?: string): Promise<SendResult> {
    for (const [pid, entry] of this.approvedTasks) {
      if (entry.requestMsgId === requestMsgId) this.approvedTasks.delete(pid);
    }
    return this.send("action.result", { requestMsgId, ok, ...(detail !== undefined ? { detail } : {}) }, "agent");
  }

  // ───────────────────────── views ─────────────────────────

  ledger(): ActivityLedger {
    return deriveLedger(this.core.messages());
  }

  // ───────────────────────── shared brain (SPEC §9.5) ─────────────────────────

  brain(): BrainView {
    return deriveBrain(this.core.messages());
  }

  recall(query: string, opts?: { tags?: string[]; limit?: number; kind?: BrainEntry["entryKind"] }): RecallHit[] {
    return recallBrain(this.brain(), query, opts);
  }

  async remember(entry: {
    headline: string;
    content: string;
    tags?: string[];
    entryKind?: BrainEntry["entryKind"];
    supersedes?: string;
    origin?: "human" | "agent";
  }): Promise<SendResult> {
    return this.send(
      "brain.entry",
      {
        headline: entry.headline.slice(0, 80),
        content: entry.content,
        tags: entry.tags ?? [],
        entryKind: entry.entryKind ?? "fact",
        ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
      },
      entry.origin ?? "agent",
    );
  }

  async status(): Promise<RuntimeStatus> {
    const ledger = this.ledger();
    const brainView = this.brain();
    const floor = this.core.floor();
    const charter = this.agreedCharter();
    const liveModePolicy = LiveModePolicySchema.parse(charter?.liveModePolicy ?? {});
    return {
      roomId: this.cfg.roomId,
      me: { peerId: this.cfg.peerId, name: this.cfg.name },
      relay: { url: this.cfg.relayUrl, connected: this.connected, peerCount: this.peerCount },
      peers: this.peers().map(({ peerId, name }) => ({ peerId, name })),
      verification: {
        verified: this.state.sasVerified,
        changed: this.keyChanged,
        sasWords: await this.sasWords(),
      },
      charter: { agreed: !!charter, hash: charter?.charterHash, title: charter?.title, autoApprove: charter?.autoApprove },
      floor: { holder: floor.floor, turnId: floor.turnId, hop: floor.hop, pendingClaim: floor.pendingClaim },
      ledger,
      brain: {
        total: brainView.counts.total,
        recent: brainView.entries.slice(-5).map((e) => ({
          headline: e.headline,
          peerId: e.peerId,
          ts: e.ts,
          entryKind: e.entryKind,
        })),
      },
      pendingPermissions: this.queue.pending(),
      approvedTasks: [...this.approvedTasks.entries()].map(([permissionId, e]) => ({
        permissionId,
        requestMsgId: e.requestMsgId,
        action: e.task.action,
        targetPath: e.task.targetPath,
      })),
      liveMode: { on: this.live.on, pollSec: liveModePolicy.pollSec, maxMinutes: liveModePolicy.liveModeMaxMinutes },
      lastSeq: this.state.lastSeq,
      uiUrl: this.uiUrl,
    };
  }

  inbox(): InboxView {
    const ledger = this.ledger();
    return {
      questionsForMe: ledger.openQuestions
        .filter((q) => q.peerId !== this.cfg.peerId)
        .map((q) => ({ msgId: q.msgId, from: q.peerId, text: q.text, ts: q.ts })),
      pendingPermissions: this.queue.pending(),
      approvedTasks: [...this.approvedTasks.values()].map((e) => e.task),
      unresolvedMyRequests: ledger.pendingActions
        .filter((a) => a.peerId === this.cfg.peerId)
        .map((a) => ({ msgId: a.msgId, summary: a.summary, ts: a.ts })),
    };
  }

  read(opts?: { limit?: number }): { ts: string; from: string; origin: string; kind: string; body: unknown }[] {
    const limit = opts?.limit ?? 30;
    return topoOrder(this.core.messages())
      .slice(-limit)
      .map((m) => ({
        ts: m.ts,
        from: `${m.sender.name} (${m.sender.peerId})`,
        origin: m.origin,
        kind: m.kind,
        // Clip long STRINGS field-by-field — never truncate serialized JSON and re-parse it
        // (the stress suite proved a large artifact would corrupt the parse and break read()).
        body: clipValue(m.body),
      }));
  }

  chainVerified(): boolean {
    return this.chainOk;
  }

  // ───────────────────────── live mode ─────────────────────────

  setLiveMode(on: boolean): { on: boolean; pollSec: number; maxMinutes: number } {
    this.live = { on, startedAt: on ? Date.now() : 0 };
    const policy = LiveModePolicySchema.parse(this.agreedCharter()?.liveModePolicy ?? {});
    this.emit();
    return { on, pollSec: policy.pollSec, maxMinutes: policy.liveModeMaxMinutes };
  }

  // ───────────────────────── handoff / resume / shutdown ─────────────────────────

  writeHandoffNow(): string {
    return writeHandoff(this.store.roomDir, {
      roomId: this.cfg.roomId,
      me: { peerId: this.cfg.peerId, name: this.cfg.name },
      charter: this.agreedCharter(),
      ledger: this.ledger(),
      brain: this.brain(),
      messages: this.core.messages(),
      sasVerified: this.state.sasVerified,
      nowIso: new Date().toISOString(),
    });
  }

  resume(): { handoff?: string | undefined; charterAgreed: boolean; note: string } {
    return {
      handoff: readLatestHandoff(this.store.roomDir),
      charterAgreed: !!this.agreedCharter(),
      note:
        "The durable log is already reloaded. Re-read the charter and ledger via pair_status; check the " +
        "decisions in the handoff against the current project state and report any drift to your human.",
    };
  }

  async shutdown(): Promise<void> {
    try {
      await Promise.race([
        this.send("system.bye", { reason: "companion shutting down" }, "agent"),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    } catch {
      /* best effort */
    }
    try {
      this.writeHandoffNow();
    } catch {
      /* never block shutdown */
    }
    this.client?.close();
    this.store.saveState(this.state);
  }

  // ───────────────────────── change events (UI/SSE) ─────────────────────────

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        /* a bad listener never breaks the runtime */
      }
    }
  }
}
