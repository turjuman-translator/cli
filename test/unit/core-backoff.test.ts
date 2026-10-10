import { describe, expect, it } from "vitest";
import { Backoff, FFMPEG_BACKOFF_MS, PROVIDER_BACKOFF_MS } from "../../src/core/backoff.js";

describe("Backoff", () => {
  it("steps through the delays, stays at the last one and counts the attempts", () => {
    const b = new Backoff([500, 1000, 2000]);
    expect(b.attempts).toBe(0);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([
      500, 1000, 2000, 2000, 2000,
    ]);
    expect(b.attempts).toBe(5);
  });

  it("starts over after reset()", () => {
    const b = new Backoff(PROVIDER_BACKOFF_MS);
    b.next();
    b.next();
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.next()).toBe(500);
  });

  it("refuses an empty list of steps", () => {
    expect(() => new Backoff([])).toThrow("Backoff needs at least one step");
  });

  it("uses the documented provider and ffmpeg schedules", () => {
    expect(PROVIDER_BACKOFF_MS).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(FFMPEG_BACKOFF_MS).toEqual([500, 1000, 2000, 5000]);
  });
});
