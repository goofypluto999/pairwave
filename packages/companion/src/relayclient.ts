/**
 * Reconnecting relay WebSocket client.  (SPEC §4.5)
 *
 * Joins the room with `sinceSeq` so the relay replays anything missed; reconnects with exponential
 * backoff; sends app-level pings to keep NAT mappings alive; queues publishes while offline and
 * flushes them on (re)join. The caller (runtime) handles envelope ingestion + dedupe, so replay
 * overlaps are harmless.
 */
import WebSocket from "ws";
import { ClientFrame, ServerFrame, type PublishEnvelope, type RelayEnvelope, type ControlFrame } from "@pairwave/protocol";

export type RelayClientOptions = {
  url: string;
  roomId: string;
  peerId: string;
  /** Called on (re)connect to learn where replay should start. */
  sinceSeq: () => number;
  onEnvelope: (env: RelayEnvelope) => void;
  onControl?: (frame: ControlFrame) => void;
  onStatus?: (s: { connected: boolean; lastSeq?: number; peerCount?: number }) => void;
  /** Called on (re)join so the runtime can flush its outbox. */
  onJoined?: () => void;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
};

export class RelayClient {
  private ws?: WebSocket | undefined;
  private closed = false;
  private backoffMs = 1000;
  private joined = false;
  private pingTimer?: NodeJS.Timeout | undefined;
  private reconnectTimer?: NodeJS.Timeout | undefined;

  constructor(private readonly opts: RelayClientOptions) {}

  get isConnected(): boolean {
    return this.joined && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
      this.sendFrame({
        t: "join",
        roomId: this.opts.roomId,
        peerId: this.opts.peerId,
        sinceSeq: this.opts.sinceSeq(),
      });
    });

    ws.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = ServerFrame.safeParse(frame);
      if (!parsed.success) return;
      const f = parsed.data;
      if (f.t === "welcome") {
        this.joined = true;
        this.opts.onStatus?.({ connected: true, lastSeq: f.lastSeq, peerCount: f.peerCount });
        this.opts.onJoined?.(); // the caller's durable outbox is the single resend mechanism
      } else if (f.t === "envelope") {
        this.opts.onEnvelope(f.env);
      } else if (f.t === "control") {
        this.opts.onControl?.(f.frame);
      } else if (f.t === "error") {
        // Never silent: a relay rejection is a real event the user must be able to see.
        process.stderr.write(`[pairwave] relay error: ${f.code} — ${f.message}\n`);
      }
    });

    const onDown = (): void => {
      if (this.joined) this.opts.onStatus?.({ connected: false });
      this.joined = false;
      this.stopPing();
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.reconnectTimer.unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
    };
    ws.on("close", onDown);
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    });

    this.startPing();
  }

  /**
   * Publish now if joined. If offline, this is a no-op BY DESIGN: every unconfirmed publish lives
   * in the runtime's durable outbox, which re-publishes on (re)join — one resend path, no doubles.
   */
  publish(env: PublishEnvelope): void {
    if (this.isConnected) this.sendFrame({ t: "publish", env });
  }

  burn(): void {
    this.sendFrame({ t: "burn", roomId: this.opts.roomId });
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* fine */
    }
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isConnected) this.sendFrame({ t: "ping" });
    }, this.opts.pingIntervalMs ?? 25_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
