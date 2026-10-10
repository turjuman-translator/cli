import { describe, expect, it } from "vitest";
import { LatencyMatcher, latencyStats, percentile } from "../../src/shared/latency-match.js";

describe("percentile", () => {
  it("is null for no samples", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("uses the nearest rank and clamps to the first and last sample", () => {
    const xs = [10, 20, 30, 40];
    expect(percentile(xs, 50)).toBe(20);
    expect(percentile(xs, 51)).toBe(30);
    expect(percentile(xs, 95)).toBe(40);
    expect(percentile(xs, 100)).toBe(40);
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, -5)).toBe(10);
    expect(percentile(xs, 250)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("latencyStats", () => {
  it("sorts a copy, rounds p50 and p95 and counts the samples", () => {
    const samples = [300.4, 100.6, 200, 900.5];
    expect(latencyStats(samples)).toEqual({ p50Ms: 200, p95Ms: 901, n: 4 });
    expect(samples).toEqual([300.4, 100.6, 200, 900.5]);
  });

  it("reports nulls for no samples", () => {
    expect(latencyStats([])).toEqual({ p50Ms: null, p95Ms: null, n: 0 });
  });
});

describe("LatencyMatcher", () => {
  it("matches a final to the latest speech end before it", () => {
    const m = new LatencyMatcher();
    m.speechEnd(1000);
    m.speechEnd(2000);
    expect(m.final(2600)).toBe(600);
    expect(m.stats()).toEqual({ p50Ms: 600, p95Ms: 600, n: 1 });
  });

  it("is null when no speech end was recorded", () => {
    const m = new LatencyMatcher();
    expect(m.final(5000)).toBeNull();
    expect(m.stats().n).toBe(0);
  });

  it("uses each speech end once and drops the older ones with it", () => {
    const m = new LatencyMatcher();
    m.speechEnd(1000);
    m.speechEnd(2000);
    expect(m.final(2500)).toBe(500);
    // 2000 is used and 1000 belonged to earlier speech: a second final finds nothing.
    expect(m.final(3000)).toBeNull();
    m.speechEnd(3500);
    expect(m.final(3700)).toBe(200);
    expect(m.stats()).toEqual({ p50Ms: 200, p95Ms: 500, n: 2 });
  });

  it("skips speech ends that are too recent (minGapMs) and keeps them for the next final", () => {
    const m = new LatencyMatcher({ minGapMs: 500 });
    m.speechEnd(1000);
    m.speechEnd(2900);
    expect(m.final(3000)).toBe(2000);
    expect(m.final(3500)).toBe(600);
  });

  it("ignores and forgets speech ends older than the window", () => {
    const m = new LatencyMatcher({ windowMs: 3000 });
    m.speechEnd(1000);
    expect(m.final(4001)).toBeNull();
    // Gone for good, even for a final that would otherwise accept it.
    const wide = new LatencyMatcher({ windowMs: 3000, minGapMs: 0 });
    wide.speechEnd(1000);
    expect(wide.final(4000)).toBe(3000);
    expect(m.final(4000)).toBeNull();
  });

  it("never matches an out-of-order speech end that lies outside the window", () => {
    const m = new LatencyMatcher();
    m.speechEnd(3000);
    m.speechEnd(1000);
    // 1000 is the newest entry but older than the window; 3000 matches instead.
    expect(m.final(6500)).toBe(3500);
  });

  it("accepts a speech end exactly at the final and exactly at the window edge", () => {
    const m = new LatencyMatcher();
    m.speechEnd(1000);
    expect(m.final(1000)).toBe(0);
    m.speechEnd(2000);
    expect(m.final(7000)).toBe(5000);
  });

  it("keeps only the newest maxSamples latencies for the stats", () => {
    const m = new LatencyMatcher({ maxSamples: 3 });
    let t = 0;
    for (const latency of [100, 200, 300, 400]) {
      t += 10_000;
      m.speechEnd(t);
      expect(m.final(t + latency)).toBe(latency);
    }
    expect(m.stats()).toEqual({ p50Ms: 300, p95Ms: 400, n: 3 });
  });

  it("keeps at most 1000 unmatched speech ends, dropping the oldest", () => {
    const m = new LatencyMatcher({ minGapMs: 1005 });
    for (let t = 0; t <= 1004; t++) m.speechEnd(t);
    // Only 0–4 ms would be old enough for this final, and those five were dropped.
    expect(m.final(1009)).toBeNull();
    const kept = new LatencyMatcher({ minGapMs: 1004 });
    for (let t = 0; t <= 1004; t++) kept.speechEnd(t);
    expect(kept.final(1009)).toBe(1004);
  });

  it("forgets speech ends and samples on reset", () => {
    const m = new LatencyMatcher();
    m.speechEnd(1000);
    expect(m.final(1300)).toBe(300);
    m.speechEnd(2000);
    m.reset();
    expect(m.stats()).toEqual({ p50Ms: null, p95Ms: null, n: 0 });
    expect(m.final(2100)).toBeNull();
  });
});
