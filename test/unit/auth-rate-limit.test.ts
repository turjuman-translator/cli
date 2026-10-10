import { describe, expect, it } from "vitest";
import { FailureRateLimiter, limiterKey } from "../../src/auth/rate-limit.js";

/** A limiter on a manual clock. */
function limiter(opts: { maxFailures?: number; windowMs?: number; blockMs?: number } = {}) {
  const clock = { t: 0 };
  const lim = new FailureRateLimiter({ ...opts, now: () => clock.t });
  return { lim, clock };
}

/** 10,000 distinct IPv4 addresses (the limiter tracks at most this many). */
function ipv4(i: number): string {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

describe("limiterKey", () => {
  it("expands '::' compression before taking the /64", () => {
    expect(limiterKey("::1")).toBe("0:0:0:0::/64");
    expect(limiterKey("fe80::")).toBe("fe80:0:0:0::/64");
    expect(limiterKey("2001:0db8:0000:0042:0000:8a2e:0370:7334")).toBe("2001:db8:0:42::/64");
    expect(limiterKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(limiterKey("::FFFF:198.51.100.7")).toBe("198.51.100.7");
    expect(limiterKey("unix-socket")).toBe("unix-socket");
  });
});

describe("FailureRateLimiter", () => {
  it("defaults: 10 failures within 10 minutes block for 10 minutes", () => {
    const lim = new FailureRateLimiter();
    for (let i = 0; i < 9; i++) expect(lim.recordFailure("192.0.2.1")).toBe(false);
    expect(lim.recordFailure("192.0.2.1")).toBe(true);
    const left = lim.blockedFor("192.0.2.1");
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);
  });

  it("forgets failures outside the window and lifts a block when it expires", () => {
    const { lim, clock } = limiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
    expect(lim.blockedFor("a")).toBe(0);
    lim.recordFailure("a");
    lim.recordFailure("a");
    clock.t = 1500;
    expect(lim.recordFailure("a")).toBe(false); // the first two are outside the window
    lim.recordFailure("a");
    expect(lim.recordFailure("a")).toBe(true);
    expect(lim.blockedFor("a")).toBe(5000);
    clock.t = 6499;
    expect(lim.isBlocked("a")).toBe(true);
    expect(lim.tryBegin("a")).toBe(false);
    clock.t = 6500;
    expect(lim.isBlocked("a")).toBe(false);
    expect(lim.tryBegin("a")).toBe(true);
  });

  it("a success keeps an active block, and keeps the entry while attempts are running", () => {
    const { lim } = limiter({ maxFailures: 2 });
    lim.recordSuccess("unknown"); // nothing tracked: no-op
    lim.recordFailure("b");
    lim.recordFailure("b");
    lim.recordSuccess("b");
    expect(lim.isBlocked("b")).toBe(true);

    lim.recordFailure("g");
    lim.recordSuccess("g"); // failures forgotten
    expect(lim.recordFailure("g")).toBe(false);

    expect(lim.tryBegin("c")).toBe(true);
    expect(lim.tryBegin("c")).toBe(true);
    lim.finish("c", "success"); // one still running: its slot stays counted
    expect([lim.tryBegin("c"), lim.tryBegin("c")]).toEqual([true, false]);
    lim.finish("c", "neutral");
    expect(lim.tryBegin("c")).toBe(true);
  });

  it("finish() without a matching tryBegin() only records the outcome", () => {
    const { lim } = limiter({ maxFailures: 1 });
    lim.finish("d", "neutral"); // never seen: nothing to free
    expect(lim.tryBegin("d")).toBe(true);
    lim.finish("d", "neutral");
    lim.finish("d", "neutral"); // a second finish for the same attempt is ignored
    lim.finish("d", "failure");
    expect(lim.isBlocked("d")).toBe(true);
  });

  it("a neutral finish keeps the address's failures and its block", () => {
    const { lim } = limiter({ maxFailures: 2 });
    expect(lim.tryBegin("e")).toBe(true);
    lim.finish("e", "failure");
    expect(lim.tryBegin("e")).toBe(true);
    lim.finish("e", "neutral"); // one failure stays
    expect(lim.tryBegin("e")).toBe(true);
    lim.finish("e", "failure");
    expect(lim.isBlocked("e")).toBe(true);

    // Blocked while an attempt was running: finishing it neutrally does not lift the block.
    expect(lim.tryBegin("f")).toBe(true);
    lim.recordFailure("f");
    lim.recordFailure("f");
    lim.finish("f", "neutral");
    expect(lim.isBlocked("f")).toBe(true);
  });

  it("when full, forgets idle addresses but keeps blocks, running attempts and recent failures", () => {
    const { lim, clock } = limiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
    for (let i = 0; i < 9997; i++) lim.recordFailure(ipv4(i)); // idle once the window passes
    for (let i = 0; i < 3; i++) lim.recordFailure("blocked");
    expect(lim.tryBegin("running")).toBe(true);
    clock.t = 1500;
    lim.recordFailure("recent");
    lim.recordFailure("recent");
    expect(lim.tryBegin("new")).toBe(true); // 10,000 tracked: prune first
    expect(lim.isBlocked("blocked")).toBe(true);
    // Its first attempt still counts: only two more fit under the limit.
    expect([lim.tryBegin("running"), lim.tryBegin("running"), lim.tryBegin("running")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(lim.recordFailure("recent")).toBe(true);
  });

  it("when full of active addresses, drops the oldest ones", () => {
    const { lim } = limiter({ maxFailures: 2 });
    for (let i = 0; i < 10_000; i++) lim.recordFailure(ipv4(i));
    lim.recordFailure("newcomer"); // evicts ipv4(0)
    lim.recordFailure(ipv4(0)); // a fresh entry again (evicts ipv4(1)): one failure, not blocked
    expect(lim.isBlocked(ipv4(0))).toBe(false);
    expect(lim.recordFailure(ipv4(2))).toBe(true); // kept: its second failure blocks
  });
});
