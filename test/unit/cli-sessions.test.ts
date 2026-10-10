import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enginePerMin, estimateCommand } from "../../src/cli/estimate.js";
import { runCli } from "../../src/cli/index.js";
import { listSessions, sessionsCommand } from "../../src/cli/sessions.js";
import { COMMAND_USAGE } from "../../src/cli/usage.js";
import type { LoadedConfig } from "../../src/config.js";
import { capture, configured, removeTempDirs, tempDir } from "./helpers/cli-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

/** A session folder as the server writes it: session.jsonl markers and one folder per track. */
function sessionFolder(
  root: string,
  name: string,
  markers: string[],
  segments: Record<string, number> = {},
): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "session.jsonl"), markers.join("\n"));
  for (const [track, count] of Object.entries(segments)) {
    mkdirSync(join(folder, track), { recursive: true });
    const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ seq: i }));
    writeFileSync(join(folder, track, "segments.jsonl"), `${lines.join("\n")}\n\n`);
  }
  return folder;
}

const START = Date.parse("2026-10-09T12:30:00Z");

function start(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: START,
    type: "start",
    kind: "device",
    from: "ar",
    to: "nl",
    engines: "soniox",
    ...extra,
  });
}

describe("listSessions", () => {
  it("is empty when there is no transcripts folder yet", () => {
    expect(listSessions(join(tempDir(), "missing"))).toEqual([]);
  });

  it("reads each session's start and stop markers and counts its segments, newest first", () => {
    const root = tempDir();
    sessionFolder(
      root,
      "2026-10-09_1230_abc123",
      [
        start(),
        '{"t": 1, "type": "note"}',
        JSON.stringify({ t: START + 1, type: "stop", durationMs: 1000, reason: "first stop" }),
        JSON.stringify({ t: START + 2, type: "stop", durationMs: 3_725_000, reason: "operator" }),
      ],
      { soniox: 3, other: 0 },
    );
    // A crash leaves a torn last line and no stop marker.
    sessionFolder(root, "2026-10-10_0900_def456", [start({ kind: "file" }), '{"t": 5, "ty']);
    writeFileSync(join(root, "notes.txt"), "not a session");
    const list = listSessions(root);
    expect(list).toEqual([
      {
        folder: join(root, "2026-10-10_0900_def456"),
        id: "def456",
        startedAt: START,
        kind: "file",
        pair: "ar→nl",
        engines: "soniox",
        durationMs: null,
        reason: null,
        segments: 0,
      },
      {
        folder: join(root, "2026-10-09_1230_abc123"),
        id: "abc123",
        startedAt: START,
        kind: "device",
        pair: "ar→nl",
        engines: "soniox",
        durationMs: 3_725_000,
        reason: "operator",
        segments: 3,
      },
    ]);
  });

  it("fills in what a folder does not say, and keeps ids that contain underscores", () => {
    const root = tempDir();
    sessionFolder(root, "odd", []);
    mkdirSync(join(root, "2026-01-01_0000_page_x1"));
    sessionFolder(root, "2026-01-02_0000_y2", [
      JSON.stringify({ type: "start", t: "noon", kind: 3 }),
    ]);
    // Without a start time, a folder sorts by the minute in its name; without one, last.
    const list = listSessions(root, 2);
    expect(list.map((s) => s.id)).toEqual(["y2", "page_x1"]);
    expect(list[0]).toMatchObject({ startedAt: null, kind: "?" });
    expect(listSessions(root).map((s) => s.id)).toEqual(["y2", "page_x1", "odd"]);
    expect(listSessions(root)[2]).toMatchObject({
      startedAt: null,
      kind: "?",
      pair: "?→?",
      engines: "?",
      segments: 0,
    });
  });

  it("sorts by the real start time: sessions of the same minute newest first, also with --limit", () => {
    const root = tempDir();
    // Same minute: the folder names sort by their random ids, not by time.
    sessionFolder(root, "2026-10-09_1230_zz9", [start({ t: START + 5_000 })]);
    sessionFolder(root, "2026-10-09_1230_aa1", [start({ t: START + 40_000 })]);
    sessionFolder(root, "2026-10-09_1229_mm5", [start({ t: START - 30_000 })]);
    expect(listSessions(root).map((s) => s.id)).toEqual(["aa1", "zz9", "mm5"]);
    expect(listSessions(root, 1).map((s) => s.id)).toEqual(["aa1"]);
  });
});

describe("turjuman sessions", () => {
  function withSessions(): LoadedConfig {
    const { loaded } = configured();
    const root = loaded.paths.transcriptsDir;
    sessionFolder(
      root,
      "2026-10-09_1230_abc123",
      [start(), JSON.stringify({ type: "stop", durationMs: 3_725_000, reason: "operator" })],
      { soniox: 12 },
    );
    sessionFolder(root, "2026-10-09_1330_def456", [
      start({ kind: "page", from: "ar", to: "en" }),
      JSON.stringify({ type: "stop", durationMs: 95_400 }),
    ]);
    sessionFolder(root, "2026-10-09_1430_ghi789", []);
    return loaded;
  }

  it("says where it looked when there are no sessions", () => {
    const { loaded } = configured();
    const c = capture();
    expect(sessionsCommand([], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([`No sessions yet in ${loaded.paths.transcriptsDir}`]);
  });

  it("prints one line per session with its duration, segments and outcome", () => {
    const loaded = withSessions();
    const c = capture();
    expect(sessionsCommand([], c.io, loaded)).toBe(0);
    const when = new Date(START).toLocaleString();
    expect(c.out).toEqual([
      `ghi789     ${"?".padEnd(22)} ?      ?→?      ${"?".padEnd(24)} running?     0 seg  `,
      `def456     ${when.padEnd(22)} page   ar→en    ${"soniox".padEnd(24)}    1m35s     0 seg  `,
      `abc123     ${when.padEnd(22)} device ar→nl    ${"soniox".padEnd(24)}    1h02m    12 seg  operator`,
      `Folders: ${loaded.paths.transcriptsDir}`,
    ]);
  });

  it("shows only the newest --limit sessions (20 when the number is not one)", () => {
    const loaded = withSessions();
    const c = capture();
    expect(sessionsCommand(["--limit", "1"], c.io, loaded)).toBe(0);
    expect(c.out).toHaveLength(2);
    expect(c.out[0]).toMatch(/^ghi789/);
    c.clear();
    expect(sessionsCommand(["--limit", "many"], c.io, loaded)).toBe(0);
    expect(c.out).toHaveLength(4);
  });

  it("runCli refuses a wrong option with the usage, and prints the usage for --help", async () => {
    const { dir } = configured();
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["sessions", "--all"], c.io)).toBe(2);
    expect(c.errText()).toBe(
      `turjuman sessions: Unknown option '--all'.\n\n${COMMAND_USAGE.sessions}`,
    );
    expect(await runCli(["sessions", "--help"], c.io)).toBe(0);
    expect(await runCli(["sessions"], c.io)).toBe(0);
    expect(c.out).toEqual([COMMAND_USAGE.sessions, expect.stringMatching(/^No sessions yet/)]);
  });
});

describe("turjuman estimate", () => {
  it("prices a minute and an hour of Soniox from the config", () => {
    const { loaded } = configured(
      "pricing:\n  sonioxSttPerHour: 0.12\n  sonioxTranslationPerHour: 0.06\n",
    );
    expect(enginePerMin(loaded.config)).toBeCloseTo(0.003, 10);
    const c = capture();
    expect(estimateCommand(["start"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([
      "Estimated cost: $0.0030/min (≈ $0.18/hour) for Soniox, billed while the session runs.",
    ]);
  });

  it("prints dollars and cents once a minute costs ten cents or more", () => {
    const { loaded } = configured(
      "pricing:\n  sonioxSttPerHour: 9\n  sonioxTranslationPerHour: 3\n",
    );
    const c = capture();
    expect(estimateCommand(["start"], c.io, loaded)).toBe(0);
    expect(c.out[0]).toBe(
      "Estimated cost: $0.20/min (≈ $12.00/hour) for Soniox, billed while the session runs.",
    );
  });

  it("knows only `estimate start`", () => {
    const { loaded } = configured();
    for (const args of [[], ["stop"], ["start", "now"]]) {
      const c = capture();
      expect(estimateCommand(args, c.io, loaded)).toBe(2);
      expect(c.err).toEqual(["usage: turjuman estimate start"]);
    }
  });

  it("runCli refuses an option with the usage", async () => {
    const { dir } = configured();
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["estimate", "start", "--hours", "2"], c.io)).toBe(2);
    expect(c.errText()).toBe(
      `turjuman estimate: Unknown option '--hours'.\n\n${COMMAND_USAGE.estimate}`,
    );
    expect(await runCli(["estimate", "start"], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^Estimated cost: /);
  });
});
