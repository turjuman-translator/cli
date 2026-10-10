// Browser-safe audio level math and energy VAD (no Node imports): used by the server
// pipeline, the long-utterance guard and the caption page.

/** Level floor for digital silence. */
export const FLOOR_DBFS = -100;

export interface Level {
  rmsDbfs: number;
  peakDbfs: number;
}

function toDbfs(ratio: number): number {
  return ratio > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(ratio)) : FLOOR_DBFS;
}

/** RMS and peak level of signed 16-bit samples, in dBFS (full scale = 32768). */
export function samplesLevel(samples: Int16Array): Level {
  if (samples.length === 0) return { rmsDbfs: FLOOR_DBFS, peakDbfs: FLOOR_DBFS };
  let sumSquares = 0;
  let peak = 0;
  for (const s of samples) {
    sumSquares += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  return {
    rmsDbfs: toDbfs(Math.sqrt(sumSquares / samples.length) / 32768),
    peakDbfs: toDbfs(peak / 32768),
  };
}

/** Little-endian s16 bytes → samples (always a copy, so byte alignment never matters). */
export function pcmBytesToSamples(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 !== 0) throw new Error(`PCM byte length is odd (${bytes.byteLength})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Level of one s16le PCM frame. */
export function frameLevel(bytes: Uint8Array): Level {
  return samplesLevel(pcmBytesToSamples(bytes));
}

export interface VadConfig {
  thresholdDbfs: number;
  minSpeechMs: number;
  minSilenceMs: number;
  sampleRate?: number;
  windowMs?: number;
}

export type VadEvent = { type: "speechStart"; atMs: number } | { type: "speechEnd"; atMs: number };

/**
 * Energy VAD: speech starts when the window RMS stays above the threshold for
 * ≥ minSpeechMs, and ends after ≥ minSilenceMs below it. Event times are the start of the
 * qualifying run (first voiced window / first silent window), in the caller's time base.
 */
export class EnergyVad {
  private readonly sampleRate: number;
  private readonly windowSamples: number;
  private isSpeaking = false;
  private runStartMs: number | null = null;
  private runMs = 0;

  constructor(private readonly cfg: VadConfig) {
    this.sampleRate = cfg.sampleRate ?? 16_000;
    this.windowSamples = Math.round((this.sampleRate * (cfg.windowMs ?? 20)) / 1000);
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  /** Feed samples that start at `startMs`; returns the transitions they caused. */
  push(samples: Int16Array, startMs: number): VadEvent[] {
    const events: VadEvent[] = [];
    for (let i = 0; i < samples.length; i += this.windowSamples) {
      const window = samples.subarray(i, Math.min(i + this.windowSamples, samples.length));
      const atMs = startMs + (i / this.sampleRate) * 1000;
      const durMs = (window.length / this.sampleRate) * 1000;
      const voiced = samplesLevel(window).rmsDbfs > this.cfg.thresholdDbfs;
      // A run counts windows that would flip the state: voiced while silent, silent while speaking.
      if (voiced !== this.isSpeaking) {
        if (this.runStartMs === null) this.runStartMs = atMs;
        this.runMs += durMs;
        const needed = this.isSpeaking ? this.cfg.minSilenceMs : this.cfg.minSpeechMs;
        if (this.runMs >= needed) {
          this.isSpeaking = !this.isSpeaking;
          events.push({
            type: this.isSpeaking ? "speechStart" : "speechEnd",
            atMs: this.runStartMs,
          });
          this.runStartMs = null;
          this.runMs = 0;
        }
      } else {
        this.runStartMs = null;
        this.runMs = 0;
      }
    }
    return events;
  }

  reset(): void {
    this.isSpeaking = false;
    this.runStartMs = null;
    this.runMs = 0;
  }
}
