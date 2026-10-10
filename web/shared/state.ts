// Client-side caption state: segments per track, replaced by `snapshot`, upserted by
// `segment`, wiped by `clear`. Shared by the overlay and the caption page.
import type {
  Segment,
  ServerMessage,
  SessionInfo,
  Status,
  TrackId,
} from "../../src/shared/protocol.js";

/** Segments kept per track (the server keeps the last 50). */
const MAX_SEGMENTS = 80;

export type StateChange =
  | { kind: "segments"; track: TrackId }
  | { kind: "snapshot"; track: TrackId }
  | { kind: "clear"; track: TrackId | "all" }
  | { kind: "status" }
  | { kind: "hello" }
  | { kind: "none" };

export class CaptionState {
  private readonly tracks = new Map<TrackId, Map<string, Segment>>();
  private readonly sessionOrder = new Map<string, number>();
  status: Status | null = null;
  session: SessionInfo | null = null;
  primary: TrackId | null = null;
  langs: { source: string; targets: string[] } | null = null;
  serverSkewMs = 0;

  apply(msg: ServerMessage): StateChange {
    switch (msg.type) {
      case "hello":
        this.primary = msg.primary;
        this.langs = msg.langs;
        this.serverSkewMs = msg.serverTime - Date.now();
        return { kind: "hello" };
      case "snapshot":
        this.replace(msg.track, msg.segments);
        this.session = msg.session;
        this.status = msg.status;
        this.primary = msg.status.primary;
        return { kind: "snapshot", track: msg.track };
      case "segment":
        this.upsert(msg.segment);
        return { kind: "segments", track: msg.segment.track };
      case "clear":
        this.clear(msg.track);
        return { kind: "clear", track: msg.track };
      case "status":
        this.status = msg.status;
        this.primary = msg.status.primary;
        if (msg.status.session) this.session = msg.status.session;
        return { kind: "status" };
      default:
        return { kind: "none" };
    }
  }

  replace(track: TrackId, segments: readonly Segment[]): void {
    const map = new Map<string, Segment>();
    for (const s of segments) {
      this.order(s.sessionId);
      map.set(s.id, s);
    }
    this.tracks.set(track, map);
    this.bound(map);
  }

  upsert(segment: Segment): void {
    this.order(segment.sessionId);
    let map = this.tracks.get(segment.track);
    if (!map) {
      map = new Map();
      this.tracks.set(segment.track, map);
    }
    map.set(segment.id, segment);
    this.bound(map);
  }

  clear(track: TrackId | "all"): void {
    if (track === "all") this.tracks.clear();
    else this.tracks.delete(track);
  }

  /** Segments of `track` in display order (session order, then seq). */
  segments(track: TrackId): Segment[] {
    const map = this.tracks.get(track);
    if (!map) return [];
    return [...map.values()].sort((a, b) => this.compare(a, b));
  }

  trackIds(): TrackId[] {
    return [...this.tracks.keys()];
  }

  private compare(a: Segment, b: Segment): number {
    const sa = this.sessionOrder.get(a.sessionId) ?? 0;
    const sb = this.sessionOrder.get(b.sessionId) ?? 0;
    return sa !== sb ? sa - sb : a.seq - b.seq;
  }

  private order(sessionId: string): void {
    if (!this.sessionOrder.has(sessionId)) {
      this.sessionOrder.set(sessionId, this.sessionOrder.size + 1);
    }
  }

  private bound(map: Map<string, Segment>): void {
    if (map.size <= MAX_SEGMENTS) return;
    const sorted = [...map.values()].sort((a, b) => this.compare(a, b));
    for (const s of sorted.slice(0, map.size - MAX_SEGMENTS)) map.delete(s.id);
  }
}
