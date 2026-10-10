// Provider-independent latency: match each final arrival F
// to the latest local VAD speech end E with F − window ≤ E ≤ F − minGap, one-to-one.
// Browser-safe: no Node or DOM imports.
import type { LatencyStats } from "./protocol.js";

export interface LatencyMatchOptions {
  /** How far back a speech end may lie before the final (default 5,000 ms). */
  windowMs?: number;
  /** Minimum distance between E and F (default 0; the server uses 500 for arrival-timed tracks). */
  minGapMs?: number;
  /** Samples kept for the percentiles (default 500). */
  maxSamples?: number;
}

/** Nearest-rank percentile of an ascending array (null when empty). */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? null;
}

export function latencyStats(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  return {
    p50Ms: p50 === null ? null : Math.round(p50),
    p95Ms: p95 === null ? null : Math.round(p95),
    n: sorted.length,
  };
}

export class LatencyMatcher {
  private readonly windowMs: number;
  private readonly minGapMs: number;
  private readonly maxSamples: number;
  /** Unmatched speech ends, ascending. */
  private ends: number[] = [];
  private samples: number[] = [];

  constructor(opts: LatencyMatchOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000;
    this.minGapMs = opts.minGapMs ?? 0;
    this.maxSamples = opts.maxSamples ?? 500;
  }

  /** Record a local VAD speech end E (same clock as `final`). */
  speechEnd(atMs: number): void {
    this.ends.push(atMs);
    if (this.ends.length > 1000) this.ends.splice(0, this.ends.length - 1000);
  }

  /** A final arrived at F: returns the matched latency in ms, or null when no E qualifies. */
  final(atMs: number): number | null {
    const earliest = atMs - this.windowMs;
    const latest = atMs - this.minGapMs;
    // Ends older than the window can never match a later final either.
    while (this.ends.length > 0 && (this.ends[0] ?? 0) < earliest) this.ends.shift();
    for (let i = this.ends.length - 1; i >= 0; i--) {
      const e = this.ends[i] ?? 0;
      if (e <= latest && e >= earliest) {
        // One-to-one: E and every older E are consumed (later finals belong to later speech).
        this.ends.splice(0, i + 1);
        const latency = atMs - e;
        this.samples.push(latency);
        if (this.samples.length > this.maxSamples) this.samples.shift();
        return latency;
      }
    }
    return null;
  }

  stats(): LatencyStats {
    return latencyStats(this.samples);
  }

  reset(): void {
    this.ends = [];
    this.samples = [];
  }
}
