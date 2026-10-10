import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey, KeyStore } from "../../src/auth/keys.js";
import { runCli } from "../../src/cli/index.js";
import { KEYS_HELP, keysCommand, USAGE_HELP, usageCommand } from "../../src/cli/keys.js";
import { UsageStore } from "../../src/core/usage.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

/** Local `YYYY-MM-DD HH:mm` of an ISO time, the way the tables print it. */
function local(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The cells of a table line (columns are separated by two or more spaces). */
function cells(line: string | undefined): string[] {
  return (line ?? "").split(/ {2,}/);
}

describe("turjuman keys add", () => {
  it("creates a key, prints it once and stores only its hash", async () => {
    const { loaded } = configured("server:\n  port: 8801\n  exposure: lan\n");
    const c = capture();
    expect(await keysCommand(["add", "--label", " Main hall "], c.io, loaded)).toBe(0);
    const [entry] = new KeyStore(loaded.paths.keysFile).list();
    const key = c.out[2]?.trim() ?? "";
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.out).toEqual([
      `Created access key ${entry?.id} "Main hall" (no daily limit)`,
      "",
      `  ${key}`,
      "",
      `This is the only time the key is shown; ${loaded.paths.keysFile} keeps only its hash.`,
      `Add it to caption page URLs as ?key=…, e.g. http://<server>:8801/ar/nl?key=${key}`,
    ]);
    const file = readFileSync(loaded.paths.keysFile, "utf8");
    expect(file).not.toContain(key);
    expect(file).toContain(hashKey(key));
  });

  it("takes a daily limit and an expiry date, and notes that local pages need no key", async () => {
    const { loaded } = configured();
    const c = capture();
    const args = [
      "add",
      "--label",
      "Guest",
      "--daily-minutes",
      "45",
      "--expires",
      "2031-06-01T10:30:00Z",
    ];
    expect(await keysCommand(args, c.io, loaded)).toBe(0);
    const expires = local("2031-06-01T10:30:00Z");
    expect(c.out[0]).toMatch(
      new RegExp(`^Created access key \\w+ "Guest" \\(daily limit 45 min; expires ${expires}\\)$`),
    );
    expect(c.out[5]).toMatch(
      /^Add it to caption page URLs as \?key=…, e\.g\. http:\/\/<server>:8765\/ar\/nl\?key=/,
    );
    expect(c.out[6]).toBe(
      'Note: server.exposure is "local", where pages need no key (keys apply to lan/public).',
    );
    expect(new KeyStore(loaded.paths.keysFile).list()[0]).toMatchObject({
      label: "Guest",
      dailyMinutes: 45,
      expires: "2031-06-01T10:30:00.000Z",
    });
  });

  it("shows an https example for a public server", async () => {
    const { loaded } = configured("server:\n  exposure: public\n  trustProxy: true\n");
    const c = capture();
    expect(await keysCommand(["add", "--label", "Remote"], c.io, loaded)).toBe(0);
    expect(c.out[5]).toMatch(/e\.g\. https:\/\/<your-domain>\/ar\/nl\?key=/);
    expect(c.out).toHaveLength(6);
  });

  it("refuses a missing label and a bad daily limit with exit code 2", async () => {
    const { loaded } = configured();
    const cases: Array<[string[], string]> = [
      [["add"], 'keys add: --label "<name>" is required'],
      [["add", "--label", "   "], 'keys add: --label "<name>" is required'],
      [
        ["add", "--label", "x", "--daily-minutes", "lots"],
        "keys add: --daily-minutes must be a positive number",
      ],
      [
        ["add", "--label", "x", "--daily-minutes", "0"],
        "keys add: --daily-minutes must be a positive number",
      ],
      [
        ["add", "--label", "x", "--daily-minutes=-5"],
        "keys add: --daily-minutes must be a positive number",
      ],
      // Not node's "argument is ambiguous": a negative number is just a wrong limit.
      [
        ["add", "--label", "x", "--daily-minutes", "-3"],
        "keys add: --daily-minutes must be a positive number",
      ],
      [
        ["add", "--label", "x", "--expires", "tomorrow"],
        "keys add: --expires must be a date, e.g. 2027-01-01",
      ],
    ];
    for (const [args, message] of cases) {
      const c = capture();
      expect(await keysCommand(args, c.io, loaded)).toBe(2);
      expect(c.err).toEqual([message]);
    }
    expect(new KeyStore(loaded.paths.keysFile).list()).toEqual([]);
  });

  it("shows an expiry date given without a time as that date", async () => {
    const { loaded } = configured();
    const c = capture();
    const args = ["add", "--label", "Ramadan", "--expires", "2027-01-01"];
    expect(await keysCommand(args, c.io, loaded)).toBe(0);
    expect(c.out[0]).toMatch(
      /^Created access key \w+ "Ramadan" \(no daily limit; expires 2027-01-01\)$/,
    );
    c.clear();
    expect(await keysCommand(["list"], c.io, loaded)).toBe(0);
    expect(cells((c.out[0] ?? "").split("\n")[1])[3]).toBe("2027-01-01");
  });

  it("reports what the key store refuses with exit code 1", async () => {
    const { loaded } = configured();
    writeFileSync(loaded.paths.keysFile, "keys:\n  - id: 1\n");
    const c = capture();
    expect(await keysCommand(["add", "--label", "x"], c.io, loaded)).toBe(1);
    expect(c.err[0]).toMatch(/^keys add: Invalid .*keys\.yaml/);
  });
});

describe("turjuman keys list and revoke", () => {
  it("says how to make the first key when there is none", async () => {
    const { loaded } = configured();
    const c = capture();
    expect(await keysCommand(["list"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([
      `No access keys (${loaded.paths.keysFile}). Create one with: pnpm turjuman keys add --label "<name>"`,
    ]);
    // In the Docker image the hint is a make command.
    vi.stubEnv("CAPTIONS_CONTAINER", "1");
    c.clear();
    expect(await keysCommand(["list"], c.io, loaded)).toBe(0);
    expect(c.out[0]).toMatch(/Create one with: make cli ARGS='keys add --label "<name>"'$/);
  });

  it("lists labels, limits and times, never the keys", async () => {
    const { loaded } = configured();
    const created = "2026-01-02T03:04:05.000Z";
    const used = "2026-02-03T04:05:06.000Z";
    writeFileSync(
      loaded.paths.keysFile,
      `keys:
  - id: aa11
    label: Main hall
    keyHash: ${"a".repeat(64)}
    dailyMinutes: 30
    expires: "2030-12-31T23:00:00.000Z"
    createdAt: "${created}"
    lastUsedAt: "${used}"
  - id: bb22
    label: Guest
    keyHash: ${"b".repeat(64)}
    createdAt: not-a-date
`,
    );
    const c = capture();
    expect(await keysCommand(["list"], c.io, loaded)).toBe(0);
    const lines = (c.out[0] ?? "").split("\n");
    expect(lines.map(cells)).toEqual([
      ["ID", "LABEL", "DAILY MIN", "EXPIRES", "CREATED", "LAST USED"],
      ["aa11", "Main hall", "30", local("2030-12-31T23:00:00.000Z"), local(created), local(used)],
      ["bb22", "Guest", "-", "-", "not-a-date", "-"],
    ]);
    // Columns line up under their headers.
    expect(lines[1]?.indexOf("Main hall")).toBe(lines[0]?.indexOf("LABEL"));
    expect(lines[2]?.indexOf("not-a-date")).toBe(lines[0]?.indexOf("CREATED"));
    expect(c.out[0]).not.toContain("a".repeat(64));
  });

  it("warns about a broken keys.yaml", async () => {
    const { loaded } = configured();
    writeFileSync(loaded.paths.keysFile, "keys:\n  - id: 1\n");
    const c = capture();
    expect(await keysCommand(["list"], c.io, loaded)).toBe(0);
    expect(c.err[0]).toMatch(/^Warning: Invalid .*keys\.yaml/);
    expect(c.out[0]).toMatch(/^No access keys/);
    // Writing to a broken file is refused rather than losing the keys in it.
    c.clear();
    expect(await keysCommand(["revoke", "1"], c.io, loaded)).toBe(1);
    expect(c.err[0]).toMatch(/^keys revoke: Invalid .*keys\.yaml/);
  });

  it("revokes one key by id", async () => {
    const { loaded } = configured();
    const store = new KeyStore(loaded.paths.keysFile);
    const { id } = store.add({ label: "Old screen" });
    const c = capture();
    expect(await keysCommand(["revoke", id], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([`Revoked key ${id} "Old screen".`]);
    expect(store.list()).toEqual([]);
    expect(await keysCommand(["revoke", id], c.io, loaded)).toBe(1);
    expect(c.err).toEqual([`keys revoke: no key with id ${id}`]);
  });

  it("needs exactly one id to revoke", async () => {
    const { loaded } = configured();
    for (const args of [["revoke"], ["revoke", "a", "b"]]) {
      const c = capture();
      expect(await keysCommand(args, c.io, loaded)).toBe(2);
      expect(c.err).toEqual(["keys revoke: give exactly one key id (see pnpm turjuman keys list)"]);
    }
  });

  it("refuses an option to list or revoke (they take none), and an option without its value", async () => {
    const { loaded } = configured();
    for (const args of [
      ["list", "--bogus"],
      ["list", "extra"],
      ["revoke", "--all"],
      ["add", "--label", "x", "--daily-minutes"],
    ]) {
      await expect(keysCommand(args, capture().io, loaded), args.join(" ")).rejects.toMatchObject({
        code: expect.stringMatching(/^ERR_PARSE_ARGS_/),
      });
    }
  });

  it("prints its help, and refuses an unknown command with exit code 2", async () => {
    const { loaded } = configured();
    for (const sub of ["help", "--help", "-h"]) {
      const c = capture();
      expect(await keysCommand([sub], c.io, loaded)).toBe(0);
      expect(c.out).toEqual([KEYS_HELP]);
    }
    const c = capture();
    expect(await keysCommand([], c.io, loaded)).toBe(2);
    expect(c.err).toEqual([KEYS_HELP]);
    c.clear();
    expect(await keysCommand(["rotate"], c.io, loaded)).toBe(2);
    expect(c.err).toEqual([`Unknown keys command: rotate\n\n${KEYS_HELP}`]);
  });
});

describe("turjuman usage", () => {
  it("prints its help", async () => {
    const { loaded } = configured();
    for (const args of [["--help"], ["-h"]]) {
      const c = capture();
      expect(await usageCommand(args, c.io, loaded)).toBe(0);
      expect(c.out).toEqual([USAGE_HELP]);
    }
  });

  it("refuses a month that is not YYYY-MM", async () => {
    const { loaded } = configured();
    const c = capture();
    expect(await usageCommand(["--month", "March"], c.io, loaded)).toBe(2);
    expect(c.err).toEqual(["usage: --month must look like 2026-10"]);
  });

  it("says when nothing was streamed", async () => {
    const { loaded } = configured();
    const c = capture();
    expect(await usageCommand([], c.io, loaded)).toBe(0);
    expect(c.out[0]).toMatch(
      /^Streamed minutes per key and engine \(today \d{4}-\d{2}-\d{2}, month \d{4}-\d{2}\)$/,
    );
    expect(c.out[1]).toBe(`No usage recorded (${loaded.paths.usageDir}).`);
  });

  it("shows today and this month per key, with labels, limits and a total", async () => {
    const { loaded } = configured();
    const keys = new KeyStore(loaded.paths.keysFile);
    const hall = keys.add({ label: "Main hall", dailyMinutes: 30 });
    const open = keys.add({ label: "Open" });
    const usage = new UsageStore({ dir: loaded.paths.usageDir, flushIntervalMs: 0 });
    usage.add(null, "soniox", 90_000);
    usage.add(hall.id, "soniox", 120_000);
    usage.add(open.id, "soniox", 30_000);
    usage.add("revoked1", "soniox", 60_000);
    usage.close();
    const c = capture();
    expect(await usageCommand([], c.io, loaded)).toBe(0);
    const rows = (c.out[1] ?? "").split("\n").map(cells);
    expect(rows[0]).toEqual(["KEY", "LABEL", "ENGINE", "TODAY", "MONTH", "DAILY LIMIT"]);
    const byKey = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect(byKey.get("local")).toEqual(["local", "(no key / local)", "soniox", "1.5", "1.5", "-"]);
    expect(byKey.get(hall.id)).toEqual([hall.id, "Main hall", "soniox", "2.0", "2.0", "30"]);
    expect(byKey.get(open.id)).toEqual([open.id, "Open", "soniox", "0.5", "0.5", "-"]);
    expect(byKey.get("revoked1")).toEqual([
      "revoked1",
      "(revoked key)",
      "soniox",
      "1.0",
      "1.0",
      "-",
    ]);
    expect(rows[rows.length - 1]).toEqual(["total", "5.0", "5.0"]);
    expect(c.out[2]).toBe(
      "(The server writes usage every 30 s; the last half minute may be missing.)",
    );
  });

  it("shows only the month's minutes for another month", async () => {
    const { loaded } = configured();
    const march = new Date(2025, 2, 15, 12).getTime();
    const usage = new UsageStore({
      dir: loaded.paths.usageDir,
      flushIntervalMs: 0,
      now: () => march,
    });
    usage.add(null, "soniox", 600_000);
    usage.close();
    const c = capture();
    expect(await usageCommand(["--month", "2025-03"], c.io, loaded)).toBe(0);
    expect(c.out[0]).toBe("Streamed minutes per key and engine (month 2025-03)");
    expect((c.out[1] ?? "").split("\n").map(cells)).toEqual([
      ["KEY", "LABEL", "ENGINE", "MONTH"],
      ["local", "(no key / local)", "soniox", "10.0"],
      ["total", "10.0"],
    ]);
    expect(c.out).toHaveLength(2);
  });
});

describe("runCli keys and usage", () => {
  it("loads the config from CONFIG_DIR and refuses a wrong option with the usage", async () => {
    const { dir } = configured();
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["keys", "list"], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^No access keys/);
    expect(await runCli(["usage"], c.io)).toBe(0);
    expect(c.out[2]).toMatch(/^No usage recorded/);
    c.clear();
    expect(await runCli(["keys", "add", "--colour", "red"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman keys: Unknown option '--colour'.\n\n${KEYS_HELP}`);
    c.clear();
    expect(await runCli(["keys", "list", "--bogus"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman keys: Unknown option '--bogus'.\n\n${KEYS_HELP}`);
    c.clear();
    expect(await runCli(["usage", "--year", "2026"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman usage: Unknown option '--year'.\n\n${USAGE_HELP}`);
    c.clear();
    expect(await runCli(["keys", "--help"], c.io)).toBe(0);
    expect(await runCli(["usage", "-h"], c.io)).toBe(0);
    expect(c.out).toEqual([KEYS_HELP, USAGE_HELP]);
  });
});
