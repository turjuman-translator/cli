// Per-IP failure rate limit for access keys and the admin token: more than `maxFailures`
// failures within `windowMs` blocks the address for `blockMs`. IPv6 addresses count per /64
// (one host usually owns the whole prefix), and `tryBegin`/`finish` count an attempt while it is
// still running, so parallel requests cannot all pass the check before the first failure is
// recorded.

export interface FailureLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  blockMs?: number;
  now?: () => number;
}

interface IpState {
  failures: number[];
  blockedUntil: number;
  /** Attempts begun with tryBegin() and not finished yet. */
  inFlight: number;
}

/** How an attempt begun with tryBegin() ended. */
export type AttemptOutcome = "failure" | "success" | "neutral";

const MAX_TRACKED = 10_000;

/**
 * The address a limit applies to: IPv4 as is (also when IPv4-mapped), IPv6 by its /64 prefix.
 * Exported for tests.
 */
export function limiterKey(ip: string): string {
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4?.[1] !== undefined) return v4[1];
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export class FailureRateLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;
  private readonly ips = new Map<string, IpState>();

  constructor(opts: FailureLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 10;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.blockMs = opts.blockMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Remaining block time in ms (0 = not blocked). */
  blockedFor(ip: string): number {
    const state = this.ips.get(limiterKey(ip));
    if (state === undefined) return 0;
    const left = state.blockedUntil - this.now();
    return left > 0 ? left : 0;
  }

  isBlocked(ip: string): boolean {
    return this.blockedFor(ip) > 0;
  }

  /** Record a failed attempt; returns true when the address is now blocked. */
  recordFailure(ip: string): boolean {
    const now = this.now();
    const state = this.state(limiterKey(ip), now);
    state.failures = state.failures.filter((t) => now - t < this.windowMs);
    state.failures.push(now);
    if (state.failures.length >= this.maxFailures) {
      state.blockedUntil = now + this.blockMs;
      state.failures = [];
    }
    return state.blockedUntil > now;
  }

  /** Forget an address's failures after a successful attempt (an active block stays). */
  recordSuccess(ip: string): void {
    const key = limiterKey(ip);
    const state = this.ips.get(key);
    if (state === undefined || state.blockedUntil > this.now()) return;
    state.failures = [];
    if (state.inFlight === 0) this.ips.delete(key);
  }

  /**
   * Start an attempt: false (refuse it) when the address is blocked, or when its recent
   * failures plus the attempts still running already reach the limit. Every true must be
   * followed by exactly one finish().
   */
  tryBegin(ip: string): boolean {
    const now = this.now();
    const state = this.state(limiterKey(ip), now);
    if (state.blockedUntil > now) return false;
    state.failures = state.failures.filter((t) => now - t < this.windowMs);
    if (state.failures.length + state.inFlight >= this.maxFailures) return false;
    state.inFlight++;
    return true;
  }

  /** End an attempt begun with tryBegin(): count it as a failure, a success, or neither. */
  finish(ip: string, outcome: AttemptOutcome): void {
    const key = limiterKey(ip);
    const state = this.ips.get(key);
    if (state !== undefined && state.inFlight > 0) state.inFlight--;
    if (outcome === "failure") this.recordFailure(ip);
    else if (outcome === "success") this.recordSuccess(ip);
    else if (state !== undefined && state.inFlight === 0 && state.failures.length === 0) {
      if (state.blockedUntil <= this.now()) this.ips.delete(key);
    }
  }

  private state(key: string, now: number): IpState {
    let state = this.ips.get(key);
    if (state === undefined) {
      if (this.ips.size >= MAX_TRACKED) this.prune(now);
      state = { failures: [], blockedUntil: 0, inFlight: 0 };
      this.ips.set(key, state);
    }
    return state;
  }

  private prune(now: number): void {
    for (const [ip, state] of this.ips) {
      const recent = state.failures.some((t) => now - t < this.windowMs);
      if (!recent && state.blockedUntil <= now && state.inFlight === 0) this.ips.delete(ip);
    }
    // Still full (an attack from many addresses): drop the oldest entries.
    for (const ip of this.ips.keys()) {
      if (this.ips.size < MAX_TRACKED) break;
      this.ips.delete(ip);
    }
  }
}
