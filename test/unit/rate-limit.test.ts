import { describe, expect, it } from "vitest";
import { FailureRateLimiter, limiterKey } from "../../src/auth/rate-limit.js";

describe("failure rate limiter: IPv6 prefixes and attempts in flight", () => {
  it("counts IPv6 addresses per /64 and IPv4-mapped addresses as IPv4", () => {
    expect(limiterKey("203.0.113.9")).toBe("203.0.113.9");
    expect(limiterKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(limiterKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(limiterKey("2001:db8:1:2::77")).toBe(limiterKey("2001:db8:1:2:ffff::1"));
    expect(limiterKey("2001:db8:1:3::1")).not.toBe(limiterKey("2001:db8:1:2::1"));
  });

  it("refuses a parallel burst before any attempt finished", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 3 });
    const begun = [1, 2, 3, 4, 5].map(() => limiter.tryBegin("198.51.100.1"));
    expect(begun).toEqual([true, true, true, false, false]);
    for (let i = 0; i < 3; i++) limiter.finish("198.51.100.1", "failure");
    expect(limiter.isBlocked("198.51.100.1")).toBe(true);
  });

  it("frees the slot of a neutral attempt and clears failures on success", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 2 });
    expect(limiter.tryBegin("a")).toBe(true);
    limiter.finish("a", "neutral");
    expect(limiter.tryBegin("a")).toBe(true);
    limiter.finish("a", "failure");
    expect(limiter.tryBegin("a")).toBe(true);
    limiter.finish("a", "success");
    expect(limiter.tryBegin("a")).toBe(true);
    expect(limiter.tryBegin("a")).toBe(true);
    expect(limiter.tryBegin("a")).toBe(false);
  });

  it("an IPv6 attacker cannot rotate addresses inside its /64", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 3 });
    for (let i = 1; i <= 3; i++) limiter.recordFailure(`2001:db8:1:2::${i}`);
    expect(limiter.isBlocked("2001:db8:1:2::abcd")).toBe(true);
  });
});
