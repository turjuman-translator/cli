// Level metering for server-side inputs. The per-frame math
// lives in the browser-safe src/shared/vad.ts so the caption page can reuse it.
import { FLOOR_DBFS, type Level } from "../shared/vad.js";

export { FLOOR_DBFS, frameLevel, type Level, samplesLevel } from "../shared/vad.js";

export interface LevelMeterOptions {
  /** "No signal" threshold (audio.silenceWarnDbfs). */
  silenceWarnDbfs: number;
  /** Minimum wall time between published levels (default 200 ms → at most 5 per second). */
  publishIntervalMs?: number;
  /** Audio time the level must stay below the threshold before `noSignal` is set (default 10 s). */
  noSignalAfterMs?: number;
}

function dbToPower(dbfs: number): number {
  return 10 ** (dbfs / 10);
}

function powerToDb(power: number): number {
  return power > 0 ? Math.max(FLOOR_DBFS, 10 * Math.log10(power)) : FLOOR_DBFS;
}

/**
 * Aggregates per-frame levels: publishes at most once per `publishIntervalMs` with the
 * maximum peak and the energy-averaged RMS of the frames since the last publish, and flags
 * `noSignal` once the frame RMS has stayed below `silenceWarnDbfs` for `noSignalAfterMs` of audio.
 */
export class LevelMeter {
  private readonly intervalMs: number;
  private readonly noSignalAfterMs: number;
  private powerSum = 0;
  private count = 0;
  private peak = FLOOR_DBFS;
  private lastPublishAt: number | null = null;
  private quietMs = 0;
  private latest: Level | null = null;

  constructor(private readonly opts: LevelMeterOptions) {
    this.intervalMs = opts.publishIntervalMs ?? 200;
    this.noSignalAfterMs = opts.noSignalAfterMs ?? 10_000;
  }

  /**
   * Feed one frame's level (`durationMs` of audio, arriving at wall time `nowMs`). Returns the
   * aggregated level when one is due, else null.
   */
  push(level: Level, nowMs: number, durationMs = 100): Level | null {
    this.powerSum += dbToPower(level.rmsDbfs);
    this.count++;
    if (level.peakDbfs > this.peak) this.peak = level.peakDbfs;
    this.quietMs = level.rmsDbfs < this.opts.silenceWarnDbfs ? this.quietMs + durationMs : 0;

    if (this.lastPublishAt !== null && nowMs - this.lastPublishAt < this.intervalMs) return null;
    const out: Level = { rmsDbfs: powerToDb(this.powerSum / this.count), peakDbfs: this.peak };
    this.lastPublishAt = nowMs;
    this.powerSum = 0;
    this.count = 0;
    this.peak = FLOOR_DBFS;
    this.latest = out;
    return out;
  }

  /** The level has stayed below silenceWarnDbfs for noSignalAfterMs of audio. */
  get noSignal(): boolean {
    return this.quietMs >= this.noSignalAfterMs;
  }

  /** The most recently published level, or null before the first one. */
  get last(): Level | null {
    return this.latest;
  }

  reset(): void {
    this.powerSum = 0;
    this.count = 0;
    this.peak = FLOOR_DBFS;
    this.lastPublishAt = null;
    this.quietMs = 0;
    this.latest = null;
  }
}
