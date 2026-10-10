import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer } from "../../src/core/coalesce.js";

describe("Coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(intervalMs = 100): { c: Coalescer<string>; emitted: string[] } {
    const emitted: string[] = [];
    const c = new Coalescer<string>((key) => emitted.push(key), { intervalMs });
    return { c, emitted };
  }

  it("emits the first request at once and collapses later ones into one trailing emit", () => {
    const { c, emitted } = make();
    c.push("a");
    expect(emitted).toEqual(["a"]);
    vi.advanceTimersByTime(30);
    c.push("a");
    c.push("a");
    c.push("a");
    expect(emitted).toEqual(["a"]);
    vi.advanceTimersByTime(69);
    expect(emitted).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(["a", "a"]);
  });

  it("emits at once again when the interval since the last emit has passed", () => {
    const { c, emitted } = make();
    c.push("a");
    vi.advanceTimersByTime(150);
    c.push("a");
    expect(emitted).toEqual(["a", "a"]);
  });

  it("keeps keys apart", () => {
    const { c, emitted } = make();
    c.push("a");
    c.push("b");
    c.push("a");
    expect(emitted).toEqual(["a", "b"]);
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual(["a", "b", "a"]);
  });

  it("uses an injected clock when given one", () => {
    let now = 0;
    const emitted: number[] = [];
    const c = new Coalescer<number>((k) => emitted.push(k), { intervalMs: 100, now: () => now });
    c.push(1);
    now = 100;
    c.push(1);
    expect(emitted).toEqual([1, 1]);
  });

  it("flush() emits a pending trailing update now, and is a no-op otherwise", () => {
    const { c, emitted } = make();
    c.flush("a");
    expect(emitted).toEqual([]);
    c.push("a");
    c.flush("a");
    expect(emitted).toEqual(["a"]);
    c.push("a");
    c.flush("a");
    expect(emitted).toEqual(["a", "a"]);
    vi.advanceTimersByTime(500);
    expect(emitted).toEqual(["a", "a"]);
  });

  it("flushAll() emits every pending key", () => {
    const { c, emitted } = make();
    c.push("a");
    c.push("b");
    c.push("c");
    c.push("a");
    c.push("b");
    c.flushAll();
    expect(emitted).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("cancel() drops a pending update and forgets the key", () => {
    const { c, emitted } = make();
    c.cancel("nothing");
    c.push("a");
    c.push("a");
    c.cancel("a");
    vi.advanceTimersByTime(500);
    expect(emitted).toEqual(["a"]);
    c.push("b");
    c.cancel("b");
    c.push("b");
    expect(emitted).toEqual(["a", "b", "b"]);
  });

  it("dispose() cancels pending updates and ignores later requests", () => {
    const { c, emitted } = make();
    c.push("a");
    c.push("a");
    c.push("b");
    c.dispose();
    vi.advanceTimersByTime(500);
    c.push("c");
    c.flushAll();
    expect(emitted).toEqual(["a", "b"]);
  });

  it("forgets idle keys once 256 are known, so memory stays bounded", () => {
    const { c, emitted } = make();
    for (let i = 0; i < 256; i++) c.push(`k${i}`);
    vi.advanceTimersByTime(100);
    const entries = Reflect.get(c, "entries") as Map<string, unknown>;
    expect(entries.size).toBe(256);
    c.push("new");
    // Idle keys whose last emit is an interval old are dropped; the new one is kept.
    expect([...entries.keys()]).toEqual(["new"]);
    expect(emitted.at(-1)).toBe("new");
    // A forgotten key behaves like a new one: it emits at once.
    c.push("k1");
    expect(emitted.at(-1)).toBe("k1");
  });

  it("keeps keys that are recent or have a pending update when it prunes", () => {
    const { c } = make();
    for (let i = 0; i < 255; i++) c.push(`k${i}`);
    vi.advanceTimersByTime(100);
    c.push("recent");
    c.push("k0");
    c.push("k0");
    c.push("next");
    const entries = Reflect.get(c, "entries") as Map<string, unknown>;
    expect(entries.has("recent")).toBe(true);
    expect(entries.has("k0")).toBe(true);
    expect(entries.has("k1")).toBe(false);
  });
});
