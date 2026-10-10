import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dayKey, LOCAL_KEY_ID, monthKey, orgUsageKey, UsageStore } from "../../src/core/usage.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "core-usage-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Local-time instant (the store keys days and months in local time). */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

function store(dir: string, clock: { t: number }, extra: { onError?: (e: unknown) => void } = {}) {
  return new UsageStore({ dir, flushIntervalMs: 0, now: () => clock.t, ...extra });
}

describe("usage keys", () => {
  it("names days and months in local time, and organisations as org:<id>", () => {
    expect(dayKey(at(2026, 3, 7))).toBe("2026-03-07");
    expect(monthKey(at(2026, 11, 30))).toBe("2026-11");
    expect(orgUsageKey("masjid-1")).toBe("org:masjid-1");
    expect(LOCAL_KEY_ID).toBe("local");
  });
});

describe("UsageStore", () => {
  it("adds streamed time per key and engine, and reports today's minutes", () => {
    const clock = { t: at(2026, 10, 9) };
    const s = store(tempDir(), clock);
    s.add("key-a", "soniox", 90_000);
    s.add("key-a", "soniox", 30_000);
    s.add(null, "soniox", 60_000);
    expect(s.minutesToday("key-a")).toBe(2);
    expect(s.minutesToday(null)).toBe(1);
    expect(s.minutesToday(LOCAL_KEY_ID)).toBe(1);
    expect(s.minutesToday("unknown")).toBe(0);
  });

  it("ignores zero, negative, NaN and infinite amounts", () => {
    const clock = { t: at(2026, 10, 9) };
    const s = store(tempDir(), clock);
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) s.add("k", "soniox", ms);
    expect(s.minutesToday("k")).toBe(0);
    expect(s.report().rows).toEqual([]);
  });

  it("reports this month's minutes per key and engine, sorted, with today's share", () => {
    const clock = { t: at(2026, 10, 8) };
    const s = store(tempDir(), clock);
    s.add("org:b", "soniox", 60_000);
    s.add("org:a", "soniox", 120_000);
    clock.t = at(2026, 10, 9);
    s.add("org:a", "soniox", 60_000);
    expect(s.report()).toEqual({
      month: "2026-10",
      today: "2026-10-09",
      rows: [
        { keyId: "org:a", engine: "soniox", todayMinutes: 1, monthMinutes: 3 },
        { keyId: "org:b", engine: "soniox", todayMinutes: 0, monthMinutes: 1 },
      ],
    });
  });

  it("reports engines of older files (Gemini) next to Soniox, sorted by engine", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "usage-2026-10.json"),
      JSON.stringify({
        version: 1,
        month: "2026-10",
        days: { "2026-10-01": { k: { soniox: 60_000, gemini: 120_000 } } },
      }),
    );
    const s = store(dir, { t: at(2026, 10, 9) });
    expect(s.report().rows.map((r) => [r.keyId, r.engine, r.monthMinutes])).toEqual([
      ["k", "gemini", 2],
      ["k", "soniox", 1],
    ]);
  });

  it("flushes the month file atomically, only when something changed", () => {
    const dir = join(tempDir(), "usage");
    const clock = { t: at(2026, 10, 9) };
    const s = store(dir, clock);
    s.flush();
    expect(s.months()).toEqual([]);
    s.add("k", "soniox", 60_000);
    s.flush();
    const file = join(dir, "usage-2026-10.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as unknown;
    expect(written).toEqual({
      version: 1,
      month: "2026-10",
      days: { "2026-10-09": { k: { soniox: 60_000 } } },
    });
    writeFileSync(file, "changed by hand");
    s.flush();
    expect(readFileSync(file, "utf8")).toBe("changed by hand");
  });

  it("loads the existing month file at start", () => {
    const dir = tempDir();
    const clock = { t: at(2026, 10, 9) };
    const first = store(dir, clock);
    first.add("k", "soniox", 60_000);
    first.close();
    const second = store(dir, clock);
    second.add("k", "soniox", 60_000);
    expect(second.minutesToday("k")).toBe(2);
  });

  it("switches to a new file when the month changes and can report past months", () => {
    const dir = tempDir();
    const clock = { t: at(2026, 9, 30, 23) };
    const s = store(dir, clock);
    s.add("k", "soniox", 60_000);
    clock.t = at(2026, 10, 1, 1);
    expect(s.minutesToday("k")).toBe(0);
    s.add("k", "soniox", 120_000);
    s.flush();
    expect(s.months()).toEqual(["2026-09", "2026-10"]);
    expect(s.report({ month: "2026-09" })).toEqual({
      month: "2026-09",
      today: "2026-10-01",
      rows: [{ keyId: "k", engine: "soniox", todayMinutes: 0, monthMinutes: 1 }],
    });
    expect(s.report({ month: "2026-10" }).rows[0]?.monthMinutes).toBe(2);
    expect(s.report({ month: "2025-01" }).rows).toEqual([]);
  });

  it("lists only usage files as months, and nothing when the folder is missing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "usage-2026-01.json"), "{}");
    writeFileSync(join(dir, "usage-2025-12.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "");
    writeFileSync(join(dir, "usage-2026-1.json"), "{}");
    const clock = { t: at(2026, 10, 9) };
    expect(store(dir, clock).months()).toEqual(["2025-12", "2026-01"]);
    expect(store(join(dir, "missing"), clock).months()).toEqual([]);
  });

  it("starts empty and reports the problem when the month file is unreadable", () => {
    const dir = tempDir();
    const clock = { t: at(2026, 10, 9) };
    const errors: unknown[] = [];
    writeFileSync(join(dir, "usage-2026-10.json"), "{ torn");
    const s = store(dir, clock, { onError: (e) => errors.push(e) });
    expect(s.minutesToday("k")).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SyntaxError);

    writeFileSync(
      join(dir, "usage-2026-10.json"),
      JSON.stringify({ version: 1, month: "2026-09", days: {} }),
    );
    store(dir, clock, { onError: (e) => errors.push(e) });
    expect(String(errors[1])).toContain("Ignoring unreadable usage file");
    writeFileSync(join(dir, "usage-2026-10.json"), JSON.stringify({ version: 2 }));
    store(dir, clock, { onError: (e) => errors.push(e) });
    expect(String(errors[2])).toContain("Ignoring unreadable usage file");
    // Without onError the problem is swallowed.
    expect(() => store(dir, clock).report()).not.toThrow();
  });

  it("keeps the data in memory and reports the error when a flush fails", () => {
    const parent = tempDir();
    const blocker = join(parent, "file");
    writeFileSync(blocker, "");
    const clock = { t: at(2026, 10, 9) };
    const errors: unknown[] = [];
    const s = store(join(blocker, "usage"), clock, { onError: (e) => errors.push(e) });
    s.add("k", "soniox", 60_000);
    s.flush();
    expect(errors).toHaveLength(1);
    expect(s.minutesToday("k")).toBe(1);
    // Still dirty: the next flush tries again.
    s.flush();
    expect(errors).toHaveLength(2);
  });

  it("flushes on its interval and on close, and stops the interval at close", () => {
    vi.useFakeTimers({ now: at(2026, 10, 9) });
    const dir = tempDir();
    const s = new UsageStore({ dir });
    s.add("k", "soniox", 60_000);
    vi.advanceTimersByTime(29_999);
    expect(s.months()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.months()).toEqual(["2026-10"]);
    s.add("k", "soniox", 60_000);
    s.close();
    const saved = JSON.parse(readFileSync(join(dir, "usage-2026-10.json"), "utf8")) as {
      days: Record<string, Record<string, Record<string, number>>>;
    };
    expect(saved.days["2026-10-09"]?.k?.soniox).toBe(120_000);
    expect(vi.getTimerCount()).toBe(0);
    s.close();
  });

  it("writes the month file into a folder it creates", () => {
    const dir = join(tempDir(), "a", "b");
    const clock = { t: at(2026, 10, 9) };
    const s = store(dir, clock);
    s.add("k", "soniox", 1);
    s.close();
    expect(s.months()).toEqual(["2026-10"]);
  });
});
