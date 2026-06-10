/**
 * Envelope store for the relay.  (SPEC §3.1, §13.3)
 *
 * Holds CIPHERTEXT ONLY — the relay has no keys and cannot read content. Append-only per room,
 * monotonic `seq`, with a per-room TTL prune. v1 ships an in-memory store (most privacy-friendly:
 * history evaporates on restart). A durable JSONL/SQLite store can implement the same interface
 * later without touching the server.
 */
import type { RelayEnvelope } from "@pairwave/protocol";

export interface Store {
  /** Increment and return the room's next sequence number. */
  nextSeq(roomId: string): number;
  /** Append a fully-formed (seq-stamped) envelope. */
  append(env: RelayEnvelope): void;
  /** Envelopes with seq strictly greater than `sinceSeq`, up to `limit`. */
  since(roomId: string, sinceSeq: number, limit: number): RelayEnvelope[];
  /** Highest seq assigned for the room (retained even if old envelopes are pruned). */
  lastSeq(roomId: string): number;
  /** Best-effort purge of a room's stored envelopes. */
  burn(roomId: string): void;
  /** Drop envelopes older than the TTL. */
  prune(nowMs: number): void;
}

interface RoomState {
  seq: number;
  envelopes: RelayEnvelope[];
}

export class MemoryStore implements Store {
  private rooms = new Map<string, RoomState>();
  constructor(private ttlMs: number) {}

  private room(id: string): RoomState {
    let r = this.rooms.get(id);
    if (!r) {
      r = { seq: 0, envelopes: [] };
      this.rooms.set(id, r);
    }
    return r;
  }

  nextSeq(id: string): number {
    const r = this.room(id);
    r.seq += 1;
    return r.seq;
  }

  append(env: RelayEnvelope): void {
    this.room(env.roomId).envelopes.push(env);
  }

  since(id: string, sinceSeq: number, limit: number): RelayEnvelope[] {
    return this.room(id).envelopes.filter((e) => e.seq > sinceSeq).slice(0, limit);
  }

  lastSeq(id: string): number {
    return this.room(id).seq;
  }

  burn(id: string): void {
    this.rooms.delete(id);
  }

  prune(nowMs: number): void {
    for (const r of this.rooms.values()) {
      r.envelopes = r.envelopes.filter((e) => nowMs - Date.parse(e.tsRelay) <= this.ttlMs);
    }
  }
}
