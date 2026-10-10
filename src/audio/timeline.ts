// Capture-time mapping for one engine instance's input audio.
//
// A provider's token times are positions in the audio it was sent (frame i covers input ms
// [i*100, (i+1)*100)). Session time is wall-clock time, so every frame's arrival time is pushed
// here and `wallAt()` turns an input position back into the wall time the audio was captured.
//
// Model: wallAt(ms) = ms + offset, where offset is the running MINIMUM of (arrival − frame end)
// within an epoch. The minimum discards delivery jitter: frames read several at a time (ffmpeg
// pipe reads, a page's pre-roll burst) arrive late relative to their capture, never early.
// Consecutive arrivals more than `epochGapMs` apart start a new epoch (ffmpeg restart, bridge
// drop, a VAD-gated page resuming after silence), because the wall clock moved while the input
// position did not.

/** Duration of one frame (100 ms of 16 kHz mono s16le = 3,200 bytes). */
export const FRAME_MS = 100;
/** Arrival gap that starts a new epoch. */
export const EPOCH_GAP_MS = 500;

interface Epoch {
  /** Input position (ms) of the epoch's first frame. */
  startInputMs: number;
  /** Running minimum of (arrival − frame end) over the epoch's frames. */
  offset: number;
}

export interface FrameTimelineOptions {
  /** Default frame duration (ms) for `push()`. */
  frameMs?: number;
  /** Gap between consecutive arrivals that starts a new epoch (ms). */
  epochGapMs?: number;
  /** Wall time used by `wallAt()` before any frame was pushed (e.g. the engine's start time). */
  originWallMs?: number;
}

export class FrameTimeline {
  private readonly frameMs: number;
  private readonly epochGapMs: number;
  private readonly originWallMs: number;
  private readonly epochs: Epoch[] = [];
  private count = 0;
  private positionMs = 0;
  private lastArrival: number | null = null;

  constructor(opts: FrameTimelineOptions = {}) {
    this.frameMs = opts.frameMs ?? FRAME_MS;
    this.epochGapMs = opts.epochGapMs ?? EPOCH_GAP_MS;
    this.originWallMs = opts.originWallMs ?? 0;
  }

  /** Record the next frame passed to the provider and the wall time it arrived. */
  push(arrivalWallMs: number, durationMs: number = this.frameMs): void {
    const startInputMs = this.positionMs;
    const candidate = arrivalWallMs - (startInputMs + durationMs);
    const current = this.epochs[this.epochs.length - 1];
    if (
      current === undefined ||
      this.lastArrival === null ||
      arrivalWallMs - this.lastArrival > this.epochGapMs
    ) {
      this.epochs.push({ startInputMs, offset: candidate });
    } else if (candidate < current.offset) {
      current.offset = candidate;
    }
    this.lastArrival = arrivalWallMs;
    this.positionMs += durationMs;
    this.count++;
  }

  /**
   * Wall time at which input position `inputMs` was captured. Linear within an epoch (so it
   * interpolates inside frames and extrapolates past the last one); positions before the first
   * frame use the first epoch.
   */
  wallAt(inputMs: number): number {
    const epoch = this.epochFor(inputMs);
    return epoch === undefined ? this.originWallMs + inputMs : inputMs + epoch.offset;
  }

  /** Frames pushed so far. */
  get frames(): number {
    return this.count;
  }

  /** Input position after the last pushed frame (ms of audio passed to the provider). */
  get inputMs(): number {
    return this.positionMs;
  }

  /** Number of epochs (diagnostics). */
  get epochCount(): number {
    return this.epochs.length;
  }

  private epochFor(inputMs: number): Epoch | undefined {
    // Last epoch with startInputMs <= inputMs (binary search; epochs are in input order).
    let lo = 0;
    let hi = this.epochs.length - 1;
    let found = this.epochs[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const epoch = this.epochs[mid] as Epoch; // lo <= mid <= hi < length
      if (epoch.startInputMs <= inputMs) {
        found = epoch;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }
}
