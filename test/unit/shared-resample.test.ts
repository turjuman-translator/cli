import { describe, expect, it } from "vitest";
import { Resampler } from "../../src/shared/resample.js";

function sine(n: number, rate: number, freq: number, amplitude = 1): Float32Array {
  return Float32Array.from(
    { length: n },
    (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / rate),
  );
}

/** Deterministic white noise in [-1, 1] (mulberry32). */
function noise(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  return Float32Array.from({ length: n }, () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  });
}

/** Outputs that have a full filter window on both sides (the first ones see the zero history). */
function settled(r: Resampler): number {
  return Math.ceil(((r.taps / 2) * r.outRate) / r.inRate) + 1;
}

/** Largest deviation from an ideal sine of `freq` at the output rate, after the warm-up. */
function sineError(out: Float32Array, r: Resampler, freq: number, amplitude = 1): number {
  let worst = 0;
  for (let k = settled(r); k < out.length; k++) {
    const ideal = amplitude * Math.sin((2 * Math.PI * freq * k) / r.outRate);
    worst = Math.max(worst, Math.abs((out[k] ?? Number.NaN) - ideal));
  }
  return worst;
}

function peak(out: Float32Array, from: number): number {
  let p = 0;
  for (let k = from; k < out.length; k++) p = Math.max(p, Math.abs(out[k] ?? Number.NaN));
  return p;
}

/** Outputs produced for `n` input samples: one per output instant whose look-ahead is complete. */
function expectedCount(r: Resampler, n: number): number {
  return Math.max(0, Math.ceil(((n - r.taps / 2) * r.outRate) / r.inRate));
}

function inBlocks(r: Resampler, input: Float32Array, sizes: () => number): Float32Array {
  const parts: number[] = [];
  for (let i = 0; i < input.length; ) {
    const n = sizes();
    parts.push(...r.process(input.subarray(i, i + n)));
    i += n;
  }
  return Float32Array.from(parts);
}

describe("Resampler setup", () => {
  it("refuses sample rates that are not positive", () => {
    expect(() => new Resampler(0, 16_000)).toThrow(RangeError);
    expect(() => new Resampler(48_000, -16_000)).toThrow("invalid sample rates 48000 → -16000");
    expect(() => new Resampler(Number.NaN, 16_000)).toThrow(RangeError);
    expect(() => new Resampler(0.4, 16_000)).toThrow(RangeError);
  });

  it("rounds fractional rates to whole hertz", () => {
    const r = new Resampler(47_999.6, 16_000.2);
    expect([r.inRate, r.outRate]).toEqual([48_000, 16_000]);
  });

  it("uses 96 taps up to 48 kHz and scales the filter up for higher input rates", () => {
    expect(new Resampler(44_100, 16_000).taps).toBe(96);
    expect(new Resampler(48_000, 16_000).taps).toBe(96);
    expect(new Resampler(96_000, 16_000).taps).toBe(192);
    expect(new Resampler(192_000, 16_000).taps).toBe(384);
  });

  it("keeps a requested filter length even and at least 8 taps", () => {
    expect(new Resampler(48_000, 16_000, { taps: 33 }).taps).toBe(34);
    expect(new Resampler(48_000, 16_000, { taps: 64.4 }).taps).toBe(64);
    expect(new Resampler(48_000, 16_000, { taps: 2 }).taps).toBe(8);
  });
});

describe("Resampler output", () => {
  it("passes audio through as a copy when the rates match", () => {
    const r = new Resampler(16_000, 16_000);
    const input = sine(320, 16_000, 440);
    const out = r.process(input);
    expect(Array.from(out)).toEqual(Array.from(input));
    out[0] = 5;
    expect(input[0]).toBe(0);
  });

  it("converts a 1 kHz sine from 48 kHz to 16 kHz with its frequency, level and timing", () => {
    const r = new Resampler(48_000, 16_000);
    const input = sine(48_000, 48_000, 1000);
    const out = r.process(input);
    expect(out.length).toBe(expectedCount(r, input.length));
    expect(out.length).toBe(15_984); // 1 s minus the 48-sample look-ahead, at a third of the rate
    // Output k is input time 3k: the samples sit on the ideal 16 kHz sine, not just near it.
    expect(sineError(out, r, 1000)).toBeLessThan(1e-4);
  });

  it("converts 44.1 kHz to 16 kHz exactly per phase (160 coefficient rows)", () => {
    const r = new Resampler(44_100, 16_000);
    const out = r.process(sine(44_100, 44_100, 1000, 0.5));
    expect(out.length).toBe(expectedCount(r, 44_100));
    expect(sineError(out, r, 1000, 0.5)).toBeLessThan(1e-4);
  });

  it("falls back to 1,024 quantized phases for rates without a usable common factor", () => {
    const r = new Resampler(47_999, 16_000);
    const out = r.process(sine(47_999, 47_999, 1000));
    expect(out.length).toBe(expectedCount(r, 47_999));
    expect(sineError(out, r, 1000)).toBeLessThan(1e-3);
  });

  it("upsamples 8 kHz to 16 kHz", () => {
    const r = new Resampler(8000, 16_000);
    const out = r.process(sine(8000, 8000, 1000));
    expect(out.length).toBe(expectedCount(r, 8000));
    expect(out.length).toBeGreaterThan(15_800);
    expect(sineError(out, r, 1000)).toBeLessThan(1e-4);
  });

  it("filters instead of dropping samples: a 10 kHz tone does not fold back into 16 kHz", () => {
    const input = sine(48_000, 48_000, 10_000);
    // Plain decimation would keep it as a full-level 6 kHz alias.
    const dropped = input.filter((_, i) => i % 3 === 0);
    expect(peak(dropped, 0)).toBeGreaterThan(0.8);
    const r = new Resampler(48_000, 16_000);
    expect(peak(r.process(input), settled(r))).toBeLessThan(1e-3);
  });

  it("has unity gain at DC on every phase", () => {
    for (const [inRate, outRate] of [
      [44_100, 16_000],
      [47_999, 16_000],
      [8000, 16_000],
    ] as const) {
      const r = new Resampler(inRate, outRate);
      const out = r.process(new Float32Array(inRate).fill(0.5));
      for (let k = settled(r); k < out.length; k++) expect(out[k]).toBeCloseTo(0.5, 6);
    }
  });

  it("returns nothing until half the filter of look-ahead has arrived", () => {
    const r = new Resampler(48_000, 16_000);
    expect(r.process(new Float32Array(0)).length).toBe(0);
    expect(r.process(new Float32Array(47).fill(1)).length).toBe(0);
    expect(r.process(new Float32Array(1).fill(1)).length).toBe(0);
    expect(r.process(new Float32Array(1).fill(1)).length).toBe(1);
  });
});

describe("Resampler options", () => {
  it("removes tones above a lower cutoffHz that the default passes", () => {
    const input = sine(48_000, 48_000, 5000);
    const plain = new Resampler(48_000, 16_000);
    expect(peak(plain.process(input), settled(plain))).toBeGreaterThan(0.99);
    const low = new Resampler(48_000, 16_000, { cutoffHz: 3000 });
    expect(peak(low.process(input), settled(low))).toBeLessThan(1e-3);
  });

  it("caps cutoffHz at 0.45 × the lower rate", () => {
    const input = noise(4800, 7);
    const capped = new Resampler(48_000, 16_000, { cutoffHz: 20_000 }).process(input);
    const plain = new Resampler(48_000, 16_000, { cutoffHz: 7200 }).process(input);
    expect(Array.from(capped)).toEqual(Array.from(plain));
  });

  it("rejects less of the stopband with a smaller Kaiser β", () => {
    const input = sine(48_000, 48_000, 10_000);
    const soft = new Resampler(48_000, 16_000, { beta: 2 });
    const sharp = new Resampler(48_000, 16_000);
    const softPeak = peak(soft.process(input), settled(soft));
    const sharpPeak = peak(sharp.process(input), settled(sharp));
    expect(softPeak).toBeGreaterThan(sharpPeak * 5);
    expect(softPeak).toBeLessThan(0.01);
  });

  it("narrows the transition band with a longer filter", () => {
    const input = sine(48_000, 48_000, 7900);
    const short = new Resampler(48_000, 16_000);
    const long = new Resampler(48_000, 16_000, { taps: 256 });
    expect(peak(short.process(input), settled(short))).toBeGreaterThan(0.01);
    expect(peak(long.process(input), settled(long))).toBeLessThan(1e-3);
  });
});

describe("Resampler streaming", () => {
  const pairs = [
    [48_000, 16_000],
    [44_100, 16_000],
    [47_999, 16_000],
    [8000, 16_000],
    [96_000, 16_000],
    // Decimating far more than the filter is long: whole blocks fall behind the read position.
    [48_000, 100],
  ] as const;

  it("gives bit-identical output whatever the block sizes", () => {
    for (const [inRate, outRate] of pairs) {
      const input = noise(inRate, inRate + outRate);
      const whole = new Resampler(inRate, outRate).process(input);
      expect(whole.length).toBe(expectedCount(new Resampler(inRate, outRate), inRate));
      const sizes = noise(2000, outRate);
      let s = 0;
      // 0–5,000 samples per block: empty blocks, single samples and blocks larger than the buffer.
      const chunked = inBlocks(new Resampler(inRate, outRate), input, () =>
        Math.floor(Math.abs(sizes[s++ % sizes.length] ?? 0) ** 3 * 5000),
      );
      expect(chunked.length).toBe(whole.length);
      expect(Array.from(chunked)).toEqual(Array.from(whole));
      const tiny = inBlocks(new Resampler(inRate, outRate), input.subarray(0, 3000), () => 7);
      expect(Array.from(tiny)).toEqual(Array.from(whole.subarray(0, tiny.length)));
    }
  });

  it("starts over after reset() as if it were new", () => {
    const r = new Resampler(44_100, 16_000);
    r.process(noise(10_000, 1));
    r.reset();
    const again = r.process(sine(4410, 44_100, 440));
    const fresh = new Resampler(44_100, 16_000).process(sine(4410, 44_100, 440));
    expect(Array.from(again)).toEqual(Array.from(fresh));
  });
});
