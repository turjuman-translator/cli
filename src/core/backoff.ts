/** Retry delays that step through `steps` (ms) and then stay at the last one. */
export class Backoff {
  private index = 0;

  constructor(private readonly steps: readonly number[]) {
    if (steps.length === 0) throw new Error("Backoff needs at least one step");
  }

  /** Delay for the next attempt. */
  next(): number {
    const delay = this.steps[Math.min(this.index, this.steps.length - 1)] ?? 0;
    this.index++;
    return delay;
  }

  /** Attempts made since the last reset. */
  get attempts(): number {
    return this.index;
  }

  reset(): void {
    this.index = 0;
  }
}

/** Provider reconnects: 0.5 → 1 → 2 → 4 → 8 s (cap). */
export const PROVIDER_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
/** ffmpeg restarts: 0.5 → 1 → 2 → 5 s (cap). */
export const FFMPEG_BACKOFF_MS = [500, 1000, 2000, 5000] as const;
