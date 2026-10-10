// Latency metrics.
//
// Per done segment, with segment times in session ms and sessionStartWall the session's
// wall-clock start:
//   source latency      = sourceFinalAt − (sessionStartWall + endMs)
//   translation latency = translationFinalAt[to] − (sessionStartWall + endMs)
// Both are null for arrival-timed tracks (their endMs IS an arrival time) and for segments cut
// by a clear. Empty translations are excluded. Rolling p50/p95 use the nearest-rank method over
// the last 50 values.

import type { LatencyStats, Segment } from "../shared/protocol.js";

export const ROLLING_WINDOW = 50;

/** Nearest-rank percentile of an ascending array (null when empty). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export function statsOf(values: readonly number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), n: sorted.length };
}

export const EMPTY_STATS: LatencyStats = { p50Ms: null, p95Ms: null, n: 0 };

/** Rolling window of latency samples. */
export class RollingLatency {
  private readonly values: number[] = [];

  constructor(private readonly size: number = ROLLING_WINDOW) {}

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.values.push(Math.round(ms));
    if (this.values.length > this.size) this.values.shift();
  }

  stats(): LatencyStats {
    return statsOf(this.values);
  }

  reset(): void {
    this.values.length = 0;
  }
}

export interface SegmentLatency {
  source: number | null;
  translation: number | null;
}

/** Source and translation latency of one done segment (see the header for the null cases). */
export function segmentLatency(
  seg: Segment,
  sessionStartWall: number,
  lang: string,
): SegmentLatency {
  if (seg.timing.source !== "provider" || seg.endMs === null || seg.meta?.cut === true) {
    return { source: null, translation: null };
  }
  const spokenEnd = sessionStartWall + seg.endMs;
  const sourceFinalAt = seg.timing.sourceFinalAt;
  const source = sourceFinalAt === undefined ? null : sourceFinalAt - spokenEnd;
  const tr = seg.translations[lang];
  const trAt = seg.timing.translationFinalAt?.[lang];
  const translation =
    tr === undefined || tr.text.trim() === "" || trAt === undefined ? null : trAt - spokenEnd;
  return { source, translation };
}

function words(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/u).length;
}

/** Per-track latency: rolling stats for status, all-time samples for the session.log summary. */
export class TrackLatency {
  readonly source = new RollingLatency();
  readonly translation = new RollingLatency();
  private readonly allSource: number[] = [];
  private readonly allTranslation: number[] = [];
  /** Segments with ≥2 source words, and how many of them got a non-empty translation. */
  private eligible = 0;
  private translated = 0;

  constructor(
    private readonly sessionStartWall: number,
    private readonly lang: string,
  ) {}

  addDone(seg: Segment): void {
    if (words(seg.source.text) >= 2) {
      this.eligible++;
      if ((seg.translations[this.lang]?.text.trim() ?? "") !== "") this.translated++;
    }
    const lat = segmentLatency(seg, this.sessionStartWall, this.lang);
    if (lat.source !== null) {
      this.source.add(lat.source);
      pushCapped(this.allSource, lat.source);
    }
    if (lat.translation !== null) {
      this.translation.add(lat.translation);
      pushCapped(this.allTranslation, lat.translation);
    }
  }

  /** One line for session.log at stop. */
  summary(): string {
    const fmt = (s: LatencyStats): string =>
      s.n === 0 ? "n/a" : `p50=${s.p50Ms} ms p95=${s.p95Ms} ms (n=${s.n})`;
    return (
      `source ${fmt(statsOf(this.allSource))}; translation ${fmt(statsOf(this.allTranslation))}; ` +
      `translated ${this.translated}/${this.eligible} segments (≥2 words)`
    );
  }
}

const MAX_SAMPLES = 10_000;

function pushCapped(list: number[], value: number): void {
  list.push(Math.round(value));
  if (list.length > MAX_SAMPLES) list.shift();
}
