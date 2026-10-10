import { describe, expect, it } from "vitest";
import { formatSrtTime, segmentsToSrt, toSrt } from "../../src/core/srt.js";
import type { Segment } from "../../src/shared/protocol.js";

describe("formatSrtTime", () => {
  it("formats HH:MM:SS,mmm, rounding and clamping negatives to zero", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(3_723_456)).toBe("01:02:03,456");
    expect(formatSrtTime(1999.6)).toBe("00:00:02,000");
    expect(formatSrtTime(-5)).toBe("00:00:00,000");
    expect(formatSrtTime(100 * 3_600_000)).toBe("100:00:00,000");
  });
});

describe("toSrt", () => {
  it("numbers blocks in order and skips empty text or missing times", () => {
    const out = toSrt([
      { startMs: 0, endMs: 1500, text: "Eerste" },
      { startMs: null, endMs: 2000, text: "geen begin" },
      { startMs: 2000, endMs: null, text: "geen eind" },
      { startMs: 2000, endMs: 3000, text: "   " },
      { startMs: 3000, endMs: 4000, text: "Tweede" },
    ]);
    expect(out).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nEerste\n\n2\n00:00:03,000 --> 00:00:04,000\nTweede\n",
    );
  });

  it("clamps times (never negative, never ending before the start)", () => {
    expect(toSrt([{ startMs: -100, endMs: -50, text: "x" }])).toBe(
      "1\n00:00:00,000 --> 00:00:00,000\nx\n",
    );
    expect(toSrt([{ startMs: 5000, endMs: 4000, text: "x" }])).toBe(
      "1\n00:00:05,000 --> 00:00:05,000\nx\n",
    );
  });

  it("never lets caption text contain a blank line and leaves RTL text untouched", () => {
    expect(toSrt([{ startMs: 0, endMs: 1, text: "  a\r\n\r\n\nb\rc  " }])).toBe(
      "1\n00:00:00,000 --> 00:00:00,001\na\nb\nc\n",
    );
    expect(toSrt([{ startMs: 0, endMs: 1, text: "بسم الله" }])).toContain("\nبسم الله\n");
  });

  it("is empty without entries", () => {
    expect(toSrt([])).toBe("");
  });
});

describe("segmentsToSrt", () => {
  const seg = (seq: number, src: string, nl?: string): Segment => ({
    id: `s:soniox:${seq}`,
    sessionId: "s",
    track: "soniox",
    seq,
    kind: "speech",
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    source: { lang: "ar", text: src, finalLen: src.length, final: true },
    translations: nl === undefined ? {} : { nl: { text: nl, finalLen: nl.length, final: true } },
    closed: true,
    timing: { source: "provider", firstTokenAt: 0 },
  });

  it("writes the source text, or a translation with the source timing", () => {
    const segments = [seg(1, "الحمد لله", "Alle lof"), seg(2, "آمين")];
    expect(segmentsToSrt(segments)).toBe(
      "1\n00:00:01,000 --> 00:00:01,900\nالحمد لله\n\n2\n00:00:02,000 --> 00:00:02,900\nآمين\n",
    );
    expect(segmentsToSrt(segments, "nl")).toBe("1\n00:00:01,000 --> 00:00:01,900\nAlle lof\n");
  });
});
