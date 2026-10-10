// Quick self-check of the capture resampler (src/shared/resample.ts), not a vitest test:
//   pnpm exec tsx scripts/check-resample.ts
// Targets: passband flat within 0.5 dB up to 6 kHz, ≥ 40 dB attenuation above 8 kHz
// (measured at the alias frequencies after 48 k / 44.1 k → 16 k), and block-size independence.
import { Resampler } from "../src/shared/resample.js";

const OUT_RATE = 16000;
const AMP = 0.5;
const SECONDS = 2;
const SKIP_S = 0.1;

interface Row {
  check: string;
  value: string;
  limit: string;
  pass: boolean;
}

function sine(rate: number, freq: number): Float32Array {
  const n = Math.round(rate * SECONDS);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = AMP * Math.sin((2 * Math.PI * freq * i) / rate);
  return x;
}

/** Deterministic PRNG (mulberry32), so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stream(r: Resampler, input: Float32Array, blockSize: () => number): Float32Array {
  const parts: Float32Array[] = [];
  let total = 0;
  for (let i = 0; i < input.length; ) {
    const end = Math.min(input.length, i + Math.max(1, blockSize()));
    const out = r.process(input.subarray(i, end));
    parts.push(out);
    total += out.length;
    i = end;
  }
  const joined = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  return joined;
}

function rms(x: Float32Array, from: number): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < x.length; i++) {
    const v = x[i] ?? 0;
    sum += v * v;
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

function gainDb(inRate: number, freq: number): number {
  const y = stream(new Resampler(inRate, OUT_RATE), sine(inRate, freq), () => 128);
  const out = rms(y, Math.round(SKIP_S * OUT_RATE));
  const ref = AMP / Math.SQRT2;
  return out > 0 ? 20 * Math.log10(out / ref) : -Infinity;
}

const rows: Row[] = [];
for (const inRate of [48000, 44100]) {
  for (const freq of [1000, 6000]) {
    const g = gainDb(inRate, freq);
    rows.push({
      check: `${inRate} → 16000, ${freq / 1000} kHz`,
      value: `${g.toFixed(3)} dB`,
      limit: "±0.5 dB",
      pass: Math.abs(g) <= 0.5,
    });
  }
  for (const freq of [8500, 9000]) {
    const g = gainDb(inRate, freq);
    rows.push({
      check: `${inRate} → 16000, ${freq / 1000} kHz (alias ${(OUT_RATE - freq) / 1000} kHz)`,
      value: `${g.toFixed(1)} dB`,
      limit: "≤ −40 dB",
      pass: g <= -40,
    });
  }
  // Streaming must equal one-shot output exactly, whatever the block sizes.
  const x = sine(inRate, 1234.5);
  const oneShot = new Resampler(inRate, OUT_RATE).process(x);
  const rand = rng(inRate);
  const streamed = stream(new Resampler(inRate, OUT_RATE), x, () => 1 + Math.floor(rand() * 700));
  let mismatches = oneShot.length === streamed.length ? 0 : 1;
  for (let i = 0; i < Math.min(oneShot.length, streamed.length); i++) {
    if (oneShot[i] !== streamed[i]) mismatches++;
  }
  rows.push({
    check: `${inRate} → 16000, random blocks = one-shot`,
    value: `${streamed.length}/${oneShot.length} samples, ${mismatches} diff`,
    limit: "identical",
    pass: mismatches === 0,
  });
}

const w0 = Math.max(...rows.map((r) => r.check.length));
const w1 = Math.max(...rows.map((r) => r.value.length));
const w2 = Math.max(...rows.map((r) => r.limit.length));
for (const r of rows) {
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.check.padEnd(w0)}  ${r.value.padStart(w1)}  ${r.limit.padEnd(w2)}`,
  );
}
const failed = rows.filter((r) => !r.pass).length;
console.log(failed === 0 ? "resampler: all checks passed" : `resampler: ${failed} check(s) FAILED`);
if (failed > 0) process.exitCode = 1;
