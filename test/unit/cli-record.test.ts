import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../../src/audio/ffmpeg.js";
import { runCli } from "../../src/cli/index.js";
import { recordCommand } from "../../src/cli/record.js";
import { COMMAND_USAGE } from "../../src/cli/usage.js";
import { createLogger } from "../../src/log.js";
import { type FakeLog, fakeLog, fakeSpawn } from "./audio-fake-ffmpeg.js";
import { capture, configured, removeTempDirs, trackSignalListeners } from "./helpers/cli-env.js";

// ffmpeg's warnings go to a logger the test can read (not JSON lines on the test's stdout).
vi.mock("../../src/log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/log.js")>()),
  createLogger: vi.fn(),
}));

let restoreSignals: () => void;
let log: FakeLog;

beforeEach(() => {
  restoreSignals = trackSignalListeners();
  log = fakeLog();
  vi.mocked(createLogger).mockReturnValue(log.logger);
});

afterEach(() => {
  restoreSignals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

/** One 100 ms frame of 16 kHz mono s16le, as ffmpeg writes it to pipe:1. */
const FRAME = 3200;

/** Fake ffmpeg processes that exit as soon as they are killed (restarts included). */
function exitingSpawn(): ReturnType<typeof fakeSpawn> {
  const fake = fakeSpawn();
  const spawn: SpawnFn = (command, args, options) => {
    const child = fake.spawn(command, args, options);
    const proc = fake.last();
    proc.onKill = (signal) => proc.exit(null, signal);
    return child;
  };
  return { ...fake, spawn };
}

describe("turjuman record", () => {
  it("records the device's raw tap for --seconds into a WAV and says how much it captured", async () => {
    vi.useFakeTimers();
    const { dir, loaded } = configured("audio:\n  input:\n    kind: device\n    device: Mic\n");
    const fake = exitingSpawn();
    const out = join(dir, "takes", "first.wav");
    const c = capture();
    const done = recordCommand(["--out", out, "--seconds", "1"], c.io, loaded, {
      spawn: fake.spawn,
      platform: "linux",
    });
    await vi.advanceTimersByTimeAsync(0);
    const proc = fake.last();
    expect(proc.args).toContain("pipe:3"); // the raw tap, before the channel/gain chain
    proc.out(new Uint8Array(FRAME * 5));
    proc.raw(new Uint8Array(4 * 4800).fill(1)); // 0.1 s of 48 kHz stereo
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBe(0);
    expect(c.out).toEqual([
      `recording device input to ${out} for 1 s`,
      `saved ${out} (0.5 s captured)`,
    ]);
    expect(c.err).toEqual([]);
    expect(proc.signals).toEqual(["SIGTERM"]);
    expect(createLogger).toHaveBeenCalledWith({ pretty: false, level: "warn" });
    const wav = readFileSync(out);
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(40)).toBe(4 * 4800);
    expect(wav.length).toBe(44 + 4 * 4800);
  });

  it("waits for the bridge, reports a stall, and stops cleanly on Ctrl-C", async () => {
    vi.useFakeTimers();
    const { dir, loaded } = configured(
      "audio:\n  input:\n    kind: network\n    network:\n      port: 7123\n",
    );
    const fake = exitingSpawn();
    const out = join(dir, "bridge.wav");
    const c = capture();
    const done = recordCommand(["--out", out], c.io, loaded, {
      spawn: fake.spawn,
      platform: "linux",
    });
    await vi.advanceTimersByTimeAsync(0);
    const proc = fake.last();
    expect(c.out).toEqual([
      "waiting for the audio bridge on port 7123…",
      `recording network input to ${out}; Ctrl-C to stop`,
    ]);
    proc.out(new Uint8Array(FRAME * 3));
    proc.err("Connection reset by peer\n");
    await vi.advanceTimersByTimeAsync(2500);
    expect(c.err).toEqual(["audio: stalled (Connection reset by peer)"]);
    expect(log.messages("warn")).toContain("ffmpeg stalled");
    process.emit("SIGINT", "SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toBe(0);
    expect(c.out[c.out.length - 1]).toBe(`saved ${out} (0.3 s captured)`);
    expect(existsSync(out)).toBe(true);
  });

  it("names the state alone when ffmpeg said nothing, and stops on SIGTERM", async () => {
    vi.useFakeTimers();
    const { dir, loaded } = configured("audio:\n  input:\n    kind: device\n");
    const fake = exitingSpawn();
    const c = capture();
    const done = recordCommand(["--out", join(dir, "x.wav"), "--seconds", "60"], c.io, loaded, {
      spawn: fake.spawn,
      platform: "linux",
    });
    await vi.advanceTimersByTimeAsync(0);
    const proc = fake.last();
    proc.out(new Uint8Array(FRAME));
    await vi.advanceTimersByTimeAsync(2500);
    expect(c.err).toEqual(["audio: stalled"]);
    process.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toBe(0);
    expect(c.out[c.out.length - 1]).toMatch(/\(0\.1 s captured\)$/);
  });

  it("refuses a missing --out, an input it cannot record and a bad --seconds with exit code 2", async () => {
    const fake = fakeSpawn();
    const device = configured("audio:\n  input:\n    kind: device\n");
    const cases: Array<[string[], string, string]> = [
      [[], "", "usage: turjuman record --out <file.wav> [--seconds n]"],
      [
        ["--out", "a.wav"],
        "",
        "turjuman record needs audio.input.kind device or network in config.yaml",
      ],
      [
        ["--out", "a.wav"],
        "audio:\n  input:\n    kind: file\n    path: recordings/x.wav\n",
        "turjuman record needs audio.input.kind device or network in config.yaml",
      ],
    ];
    for (const [args, yaml, message] of cases) {
      const c = capture();
      expect(await recordCommand(args, c.io, configured(yaml).loaded, { spawn: fake.spawn })).toBe(
        2,
      );
      expect(c.err).toEqual([message]);
    }
    for (const seconds of ["ten", "0", "-3", "Infinity"]) {
      const c = capture();
      const out = join(device.dir, `${seconds}.wav`);
      const code = await recordCommand(
        ["--out", out, `--seconds=${seconds}`],
        c.io,
        device.loaded,
        {
          spawn: fake.spawn,
        },
      );
      expect(code).toBe(2);
      expect(c.err).toEqual(["turjuman record: --seconds must be a positive number of seconds"]);
      expect(existsSync(out)).toBe(false);
    }
    expect(fake.procs).toEqual([]);
  });

  it("runCli prints the record usage for --help and under a wrong option", async () => {
    const { dir } = configured();
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["record", "--help"], c.io)).toBe(0);
    expect(c.out).toEqual([COMMAND_USAGE.record]);
    expect(await runCli(["record", "--minutes", "3"], c.io)).toBe(2);
    expect(c.errText()).toBe(
      `turjuman record: Unknown option '--minutes'.\n\n${COMMAND_USAGE.record}`,
    );
    c.clear();
    expect(await runCli(["record", "--out", join(dir, "a.wav")], c.io)).toBe(2);
    expect(c.err).toEqual([
      "turjuman record needs audio.input.kind device or network in config.yaml",
    ]);
  });
});
