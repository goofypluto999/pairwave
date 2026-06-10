/**
 * @pairwave/relay — the untrusted message bus.  (SPEC §3.1, §5.5, §11, §13.3)
 *
 * Routes encrypted envelopes by roomId, assigns a monotonic seq, fans out to room peers, reports
 * presence, and serves history for replay. It validates frame STRUCTURE (so it rejects junk) but
 * never imports a key and never calls `open` — by construction it cannot read message content. The
 * only thing it persists is ciphertext.
 */
import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  ClientFrame,
  type ServerFrame,
  type RelayEnvelope,
  type ControlFrame,
} from "@pairwave/protocol";
import { MemoryStore, type Store } from "./store.js";

export interface RelayOptions {
  /** 0 (default) binds an ephemeral port — read `handle.port` after creation. */
  port?: number;
  store?: Store;
  /** History retention. Default 7 days (SPEC §13.3). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  clock?: () => number;
  /** v1 = 2 peers per room (SPEC §1.2). */
  maxPeersPerRoom?: number;
  maxCiphertextBytes?: number;
  pruneIntervalMs?: number;
  heartbeatMs?: number;
}

export interface RelayHandle {
  httpServer: http.Server;
  wss: WebSocketServer;
  port: number;
  store: Store;
  close(): Promise<void>;
}

interface Conn {
  roomId?: string;
  peerId?: string;
  isAlive: boolean;
}

export async function createRelay(opts: RelayOptions = {}): Promise<RelayHandle> {
  const clock = opts.clock ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  const store = opts.store ?? new MemoryStore(ttlMs);
  const maxPeers = opts.maxPeersPerRoom ?? 2;
  const maxCiphertextBytes = opts.maxCiphertextBytes ?? 1_000_000;

  const conns = new Map<WebSocket, Conn>();
  const rooms = new Map<string, Set<WebSocket>>();

  const now = () => new Date(clock()).toISOString();

  const send = (ws: WebSocket, frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };

  const broadcast = (roomId: string, frame: ServerFrame): void => {
    for (const ws of rooms.get(roomId) ?? []) send(ws, frame);
  };

  const broadcastPresence = (roomId: string): void => {
    const set = rooms.get(roomId);
    if (!set || set.size === 0) return;
    const frame: ControlFrame = {
      v: 1,
      roomId,
      type: "presence",
      peerCount: set.size,
      lastSeq: store.lastSeq(roomId),
      tsRelay: now(),
    };
    broadcast(roomId, { t: "control", frame });
  };

  const onMessage = (ws: WebSocket, data: RawData): void => {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return send(ws, { t: "error", code: "bad_json", message: "invalid JSON" });
    }
    const parsed = ClientFrame.safeParse(json);
    if (!parsed.success) {
      return send(ws, { t: "error", code: "bad_frame", message: parsed.error.message });
    }
    const f = parsed.data;
    const c = conns.get(ws);
    if (!c) return;

    switch (f.t) {
      case "join": {
        const set = rooms.get(f.roomId) ?? new Set<WebSocket>();
        if (!set.has(ws) && set.size >= maxPeers) {
          return send(ws, { t: "error", code: "room_full", message: `room limited to ${maxPeers} peers` });
        }
        c.roomId = f.roomId;
        c.peerId = f.peerId;
        set.add(ws);
        rooms.set(f.roomId, set);
        send(ws, { t: "welcome", roomId: f.roomId, lastSeq: store.lastSeq(f.roomId), peerCount: set.size });
        if (f.sinceSeq !== undefined) {
          for (const env of store.since(f.roomId, f.sinceSeq, 500)) send(ws, { t: "envelope", env });
        }
        broadcastPresence(f.roomId);
        return;
      }
      case "publish": {
        if (!c.roomId || c.roomId !== f.env.roomId) {
          return send(ws, { t: "error", code: "not_joined", message: "join the room before publishing" });
        }
        if (f.env.ciphertext.length > maxCiphertextBytes) {
          return send(ws, { t: "error", code: "too_large", message: "ciphertext exceeds limit" });
        }
        const full: RelayEnvelope = {
          v: 1,
          roomId: f.env.roomId,
          seq: store.nextSeq(f.env.roomId),
          tsRelay: now(),
          nonce: f.env.nonce,
          ciphertext: f.env.ciphertext,
        };
        store.append(full);
        broadcast(f.env.roomId, { t: "envelope", env: full }); // echo to all incl sender (learns its seq)
        return;
      }
      case "ping": {
        if (!c.roomId) return send(ws, { t: "error", code: "not_joined", message: "join first" });
        const set = rooms.get(c.roomId);
        const frame: ControlFrame = {
          v: 1,
          roomId: c.roomId,
          type: "pong",
          peerCount: set?.size ?? 0,
          lastSeq: store.lastSeq(c.roomId),
          tsRelay: now(),
        };
        return send(ws, { t: "control", frame });
      }
      case "burn": {
        store.burn(f.roomId);
        return;
      }
    }
  };

  const onClose = (ws: WebSocket): void => {
    const c = conns.get(ws);
    conns.delete(ws);
    if (!c?.roomId) return;
    const set = rooms.get(c.roomId);
    set?.delete(ws);
    if (set && set.size === 0) rooms.delete(c.roomId);
    else broadcastPresence(c.roomId);
  };

  const handleRest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && u.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    const m = u.pathname.match(/^\/rooms\/([^/]+)\/messages$/);
    if (req.method === "GET" && m) {
      const roomId = decodeURIComponent(m[1] ?? "");
      const sinceSeq = Number(u.searchParams.get("sinceSeq") ?? "0") || 0;
      const limit = Math.min(Number(u.searchParams.get("limit") ?? "200") || 200, 1000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(store.since(roomId, sinceSeq, limit)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };

  const httpServer = http.createServer(handleRest);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    conns.set(ws, { isAlive: true });
    ws.on("message", (data) => onMessage(ws, data));
    ws.on("pong", () => {
      const c = conns.get(ws);
      if (c) c.isAlive = true;
    });
    ws.on("close", () => onClose(ws));
    ws.on("error", () => {
      /* ignore transport errors; close handler cleans up */
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, c] of conns) {
      if (!c.isAlive) {
        ws.terminate();
        continue;
      }
      c.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket going away */
      }
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  const pruner = setInterval(() => store.prune(clock()), opts.pruneIntervalMs ?? 60_000);
  pruner.unref();

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    clearInterval(pruner);
    for (const ws of conns.keys()) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
  };

  return { httpServer, wss, port, store, close };
}
