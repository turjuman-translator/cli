import { describe, expect, it } from "vitest";
import { CostCounter } from "../../src/core/cost.js";
import {
  EMPTY_STATS,
  percentile,
  ROLLING_WINDOW,
  RollingLatency,
  segmentLatency,
  statsOf,
  TrackLatency,
} from "../../src/core/metrics.js";
import type { Segment } from "../../src/shared/protocol.js";

const PRICING = { sonioxSttPerHour: 0.12, sonioxTranslationPerHour: 0.06 };

describe("CostCounter", () => {
  it("bills stream minutes for speech recognition plus translation", () => {
    const cost = new CostCounter(PRICING);
    expect(cost.usd()).toBe(0);
    cost.addPeriod({ streamMs: 30 * 60_000 });
    cost.addPeriod({ streamMs: 30 * 60_000 });
    // One hour at 0.12 + 0.06 per hour.
    expect(cost.usd()).toBeCloseTo(0.18, 10);
  });

  it("includes running periods in the live estimate and the summary", () => {
    const cost = new CostCounter(PRICING);
    cost.addPeriod({ streamMs: 60_000 });
    const open = [{ streamMs: 60_000 }, { streamMs: 30_000 }];
    expect(cost.usd(open)).toBeCloseTo((2.5 / 60) * 0.18, 10);
    expect(cost.breakdown(open)).toBe("stream 2.50 min, $0.0075");
    expect(cost.breakdown()).toBe("stream 1.00 min, $0.0030");
  });
});

function seg(over: Partial<Segment> = {}): Segment {
  return {
    id: "s:soniox:1",
    sessionId: "s",
    track: "soniox",
    seq: 1,
    kind: "speech",
    startMs: 0,
    endMs: 2000,
    source: { lang: "ar", text: "بسم الله الرحمن", finalLen: 13, final: true },
    translations: { nl: { text: "In de naam", finalLen: 10, final: true } },
    closed: true,
    timing: {
      source: "provider",
      firstTokenAt: 1000,
      sourceFinalAt: 10_000 + 2000 + 400,
      translationFinalAt: { nl: 10_000 + 2000 + 900 },
    },
    ...over,
  };
}

describe("percentile and statsOf", () => {
  it("uses the nearest-rank method and null for no values", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(statsOf([300, 100, 200])).toEqual({ p50Ms: 200, p95Ms: 300, n: 3 });
    expect(statsOf([])).toEqual(EMPTY_STATS);
  });
});

describe("RollingLatency", () => {
  it("keeps the last 50 rounded samples and skips values that are not finite", () => {
    const r = new RollingLatency();
    r.add(Number.NaN);
    r.add(Number.POSITIVE_INFINITY);
    expect(r.stats()).toEqual(EMPTY_STATS);
    for (let i = 1; i <= ROLLING_WINDOW + 10; i++) r.add(i + 0.4);
    const s = r.stats();
    expect(s.n).toBe(50);
    // 11..60 kept: p50 = 35, p95 = 58.
    expect(s.p50Ms).toBe(35);
    expect(s.p95Ms).toBe(58);
    r.reset();
    expect(r.stats()).toEqual(EMPTY_STATS);
  });

  it("honours a custom window", () => {
    const r = new RollingLatency(2);
    r.add(5);
    r.add(7);
    r.add(9);
    expect(r.stats()).toEqual({ p50Ms: 7, p95Ms: 9, n: 2 });
  });
});

describe("segmentLatency", () => {
  it("measures source and translation latency from the spoken end", () => {
    expect(segmentLatency(seg(), 10_000, "nl")).toEqual({ source: 400, translation: 900 });
  });

  it("is null for arrival-timed segments, segments without an end and cut segments", () => {
    const none = { source: null, translation: null };
    expect(
      segmentLatency(seg({ timing: { source: "arrival", firstTokenAt: 0 } }), 0, "nl"),
    ).toEqual(none);
    expect(segmentLatency(seg({ endMs: null }), 0, "nl")).toEqual(none);
    expect(segmentLatency(seg({ meta: { cut: true } }), 0, "nl")).toEqual(none);
  });

  it("leaves out a missing source time and missing, empty or untimed translations", () => {
    expect(
      segmentLatency(seg({ timing: { source: "provider", firstTokenAt: 0 } }), 10_000, "nl"),
    ).toEqual({ source: null, translation: null });
    expect(segmentLatency(seg(), 10_000, "en").translation).toBeNull();
    expect(
      segmentLatency(
        seg({ translations: { nl: { text: "  ", finalLen: 2, final: true } } }),
        10_000,
        "nl",
      ).translation,
    ).toBeNull();
  });
});

describe("TrackLatency", () => {
  it("summarises latencies and how many segments of two words or more were translated", () => {
    const t = new TrackLatency(10_000, "nl");
    expect(t.summary()).toBe("source n/a; translation n/a; translated 0/0 segments (≥2 words)");
    t.addDone(seg());
    // Two words, no translation.
    t.addDone(seg({ translations: { nl: { text: "", finalLen: 0, final: true } } }));
    // One word: not counted for the translated share.
    t.addDone(seg({ source: { lang: "ar", text: "آمين", finalLen: 4, final: true } }));
    // Arrival timing: no latency samples.
    t.addDone(seg({ timing: { source: "arrival", firstTokenAt: 0 } }));
    t.addDone(seg({ translations: {} }));
    // No words at all (an empty source): not counted either.
    t.addDone(seg({ source: { lang: "ar", text: " ", finalLen: 1, final: true }, endMs: null }));
    expect(t.source.stats().n).toBe(4);
    expect(t.translation.stats().n).toBe(2);
    expect(t.summary()).toBe(
      "source p50=400 ms p95=400 ms (n=4); translation p50=900 ms p95=900 ms (n=2); " +
        "translated 2/4 segments (≥2 words)",
    );
  });

  it("caps the all-time samples at 10,000", () => {
    const t = new TrackLatency(10_000, "nl");
    t.addDone(
      seg({
        timing: {
          source: "provider",
          firstTokenAt: 0,
          sourceFinalAt: 10_000 + 2000 + 99_999,
          translationFinalAt: { nl: 10_000 + 2000 + 99_999 },
        },
      }),
    );
    for (let i = 0; i < 10_000; i++) t.addDone(seg());
    // The one slow sample was pushed out: every kept sample is 400 / 900 ms.
    expect(t.summary()).toContain("source p50=400 ms p95=400 ms (n=10000)");
    expect(t.summary()).toContain("translation p50=900 ms p95=900 ms (n=10000)");
  });
});
