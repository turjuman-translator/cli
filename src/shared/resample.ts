// Streaming sample-rate converter for the caption page's capture worklet:
// when the browser can't capture at 16 kHz (Firefox), the worklet runs at the native rate and
// converts here with a proper low-pass, never by dropping samples.
// Browser-safe: no Node or DOM imports.
//
// Design: Kaiser-windowed sinc, polyphase. The read position is tracked exactly as a rational
// (integer input index + fraction numerator over outRate/gcd), so the output is bit-identical
// whatever the block sizes are. With a denominator ≤ 1,024 every fraction has its own exact
// coefficient row (48 k → 16 k: 1 row; 44.1 k → 16 k: 160 rows); otherwise the fraction is
// quantized to 1,024 phases. Each row is normalized to unity DC gain.

export interface ResamplerOptions {
  /**
   * Filter length in input samples (default 96; scaled up proportionally for input rates
   * above 48 kHz so the transition band stays the same width in Hz).
   */
  taps?: number;
  /** Low-pass cutoff in Hz (default 7,200), capped at 0.45 × min(inRate, outRate). */
  cutoffHz?: number;
  /** Kaiser window β (default 7 ≈ 70 dB stopband). */
  beta?: number;
}

const DEFAULT_TAPS = 96;
const DEFAULT_CUTOFF_HZ = 7200;
const DEFAULT_BETA = 7;
const MAX_EXACT_PHASES = 1024;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Modified Bessel function of the first kind, order 0 (power series). */
function besselI0(x: number): number {
  const half = x / 2;
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 100; k++) {
    term *= half / k;
    const t2 = term * term;
    sum += t2;
    if (t2 < sum * 1e-17) break;
  }
  return sum;
}

export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  /** Filter length in input samples (even). */
  readonly taps: number;

  private readonly identity: boolean;
  private readonly half: number;
  /** Input samples advanced per output = num / den (exact). */
  private readonly num: number;
  private readonly den: number;
  private readonly exact: boolean;
  private readonly phases: number;
  /** Coefficient rows, `taps` each: exact → one per fraction numerator; else phases + 1. */
  private readonly table: Float64Array;

  private buf: Float32Array;
  /** Valid samples in `buf`. */
  private len = 0;
  /** Index in `buf` of the integer part of the next output position. */
  private pos = 0;
  /** Fraction numerator of the next output position, in [0, den). */
  private fnum = 0;
  private scratch: Float32Array;

  constructor(inRate: number, outRate: number, opts: ResamplerOptions = {}) {
    const fi = Math.round(inRate);
    const fo = Math.round(outRate);
    if (!(fi > 0) || !(fo > 0)) throw new RangeError(`invalid sample rates ${inRate} → ${outRate}`);
    this.inRate = fi;
    this.outRate = fo;
    this.identity = fi === fo;

    const g = gcd(fi, fo);
    this.num = fi / g;
    this.den = fo / g;

    const scaled = Math.round((DEFAULT_TAPS * Math.max(1, fi / 48000)) / 2) * 2;
    let taps = Math.round(opts.taps ?? scaled);
    if (taps % 2 !== 0) taps++;
    this.taps = Math.max(8, taps);
    this.half = this.taps / 2;

    this.exact = this.den <= MAX_EXACT_PHASES;
    this.phases = this.exact ? this.den : MAX_EXACT_PHASES;
    const rows = this.exact ? this.den : this.phases + 1;

    const cutoff = Math.min(opts.cutoffHz ?? DEFAULT_CUTOFF_HZ, 0.45 * Math.min(fi, fo));
    const wc = cutoff / fi; // cycles per input sample
    const beta = opts.beta ?? DEFAULT_BETA;
    const i0Beta = besselI0(beta);
    this.table = new Float64Array(this.identity ? 0 : rows * this.taps);
    if (!this.identity) {
      for (let r = 0; r < rows; r++) {
        const frac = r / this.phases;
        const base = r * this.taps;
        let sum = 0;
        for (let j = 0; j < this.taps; j++) {
          // Tap j reads input index (pos - half + 1 + j); its distance to the output time:
          const t = frac + this.half - 1 - j;
          const ratio = t / this.half;
          const w =
            Math.abs(ratio) < 1 ? besselI0(beta * Math.sqrt(1 - ratio * ratio)) / i0Beta : 0;
          const x = 2 * wc * t;
          const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          const c = 2 * wc * sinc * w;
          this.table[base + j] = c;
          sum += c;
        }
        for (let j = 0; j < this.taps; j++)
          this.table[base + j] = (this.table[base + j] ?? 0) / sum;
      }
    }

    this.buf = new Float32Array(Math.max(4096, this.taps * 4));
    this.scratch = new Float32Array(2048);
    this.reset();
  }

  /** Clear the history (primed with zeros, so the first output aligns with input sample 0). */
  reset(): void {
    this.buf.fill(0);
    this.len = this.half - 1;
    this.pos = this.half - 1;
    this.fnum = 0;
  }

  /**
   * Feed any number of input samples (Float32, [-1, 1]); returns the output samples produced
   * so far (possibly empty). State persists across calls.
   */
  process(input: Float32Array): Float32Array {
    if (this.identity) return input.slice();
    this.append(input);

    const { taps, half, num, den, table } = this;
    const bound = Math.ceil(((this.len - this.pos) * den) / num) + 2;
    if (bound > this.scratch.length) this.scratch = new Float32Array(bound * 2);
    const out = this.scratch;
    const buf = this.buf;

    let n = 0;
    let pos = this.pos;
    let fnum = this.fnum;
    while (pos + half < this.len) {
      const row = this.exact ? fnum : Math.round((fnum * this.phases) / den);
      const base = row * taps;
      const start = pos - half + 1;
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += (buf[start + j] ?? 0) * (table[base + j] ?? 0);
      out[n++] = acc;
      fnum += num;
      const adv = Math.floor(fnum / den);
      pos += adv;
      fnum -= adv * den;
    }
    this.fnum = fnum;

    // Drop history no future output needs (index mapping stays consistent).
    const keepFrom = Math.min(pos - half + 1, this.len);
    if (keepFrom > 0) {
      buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      pos -= keepFrom;
    }
    this.pos = pos;
    return out.slice(0, n);
  }

  private append(input: Float32Array): void {
    const need = this.len + input.length;
    if (need > this.buf.length) {
      const next = new Float32Array(Math.max(need, this.buf.length * 2));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(input, this.len);
    this.len = need;
  }
}
