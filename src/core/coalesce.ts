// Keyed leading + trailing throttle: segment upserts (≤10/s per segment), status messages
// (≤2/s) and level messages (≤5/s).
//
// The first request for a key emits immediately; requests within `intervalMs` of the last emit
// collapse into one trailing emit at the end of the interval. The emit callback reads the
// current state, so the trailing emit always carries the latest version.

interface Entry {
  lastAt: number;
  timer: NodeJS.Timeout | null;
}

export interface CoalescerOptions {
  intervalMs: number;
  now?: () => number;
}

export class Coalescer<K> {
  private readonly entries = new Map<K, Entry>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(
    private readonly emit: (key: K) => void,
    opts: CoalescerOptions,
  ) {
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? Date.now;
  }

  /** Request an emit for `key` (now, or at the end of the current interval). */
  push(key: K): void {
    if (this.disposed) return;
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.prune(now);
      this.entries.set(key, { lastAt: now, timer: null });
      this.emit(key);
      return;
    }
    if (entry.timer !== null) return;
    const wait = entry.lastAt + this.intervalMs - now;
    if (wait <= 0) {
      entry.lastAt = now;
      this.emit(key);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.lastAt = this.now();
      if (!this.disposed) this.emit(key);
    }, wait);
  }

  /** Emit a pending trailing update for `key` right away. */
  flush(key: K): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.lastAt = this.now();
    if (!this.disposed) this.emit(key);
  }

  /** Emit every pending trailing update right away. */
  flushAll(): void {
    for (const key of [...this.entries.keys()]) this.flush(key);
  }

  /** Drop a pending trailing update for `key`. */
  cancel(key: K): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  /** Cancel everything; later pushes are ignored. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  /** Forget idle keys whose last emit is older than the interval (bounded memory). */
  private prune(now: number): void {
    if (this.entries.size < 256) return;
    for (const [key, entry] of this.entries) {
      if (entry.timer === null && now - entry.lastAt >= this.intervalMs) this.entries.delete(key);
    }
  }
}
