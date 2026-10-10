import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../../src/audio/ffmpeg.js";
import { runCli } from "../../src/cli/index.js";
import {
  FRAME_TOLERANCE_PCT,
  ffprobePathFor,
  probeDurationSec,
  type RunDryOptions,
  runDryCommand,
} from "../../src/cli/run-dry.js";
import type { LoadedConfig } from "../../src/config.js";
import { type FakeFfmpeg, fakeSpawn } from "./audio-fake-ffmpeg.js";
import {
  capture,
  configured,
  removeTempDirs,
  tempDir,
  trackSignalListeners,
} from "./helpers/cli-env.js";

let restoreSignals: () => void;

beforeEach(() => {
  restoreSignals = trackSignalListeners();
});

afterEach(() => {
  restoreSignals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

const FRAME = 3200;

/** Fake ffmpeg processes that exit as soon as they are killed. */
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

/** A small executable shell script (a stand-in for ffprobe). */
function script(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A WAV-named file the dry run may open (the fake ffmpeg never reads it). */
function audioFile(dir: string, name = "khutbah.wav"): string {
  const file = join(dir, name);
  writeFileSync(file, "RIFF");
  return file;
}

interface Run {
  c: ReturnType<typeof capture>;
  fake: ReturnType<typeof fakeSpawn>;
  done: Promise<number>;
  proc(): FakeFfmpeg;
}

/** Start a dry run with a fake ffmpeg; the test plays ffmpeg's part. */
async function dryRun(loaded: LoadedConfig, opts: Partial<RunDryOptions> = {}): Promise<Run> {
  const c = capture();
  const fake = exitingSpawn();
  const done = runDryCommand({
    loaded,
    io: c.io,
    platform: "linux",
    spawn: fake.spawn,
    probeDuration: async () => 1,
    ...opts,
  });
  await Promise.resolve();
  return { c, fake, done, proc: () => fake.last() };
}

describe("ffprobePathFor", () => {
  it("finds ffprobe next to ffmpeg", () => {
    expect(ffprobePathFor("ffmpeg")).toBe("ffprobe");
    expect(ffprobePathFor("/usr/local/bin/ffmpeg")).toBe("/usr/local/bin/ffprobe");
    expect(ffprobePathFor("C:\\ffmpeg\\bin\\FFMPEG.exe")).toBe("C:\\ffmpeg\\bin\\ffprobe.exe");
    expect(ffprobePathFor("/opt/av/avconv")).toBe("/opt/av/ffprobe");
    expect(ffprobePathFor("C:\\tools\\avconv.EXE")).toBe("C:\\tools\\ffprobe.exe");
  });
});

describe("probeDurationSec", () => {
  it("reads the duration ffprobe prints", async () => {
    const dir = tempDir();
    const ffprobe = script(dir, "ffprobe", 'echo "$@" > "$(dirname "$0")/args"; echo 12.480000');
    expect(await probeDurationSec(ffprobe, "/a b.wav")).toBe(12.48);
  });

  it("is null when ffprobe is missing, fails, or prints no positive number", async () => {
    const dir = tempDir();
    expect(await probeDurationSec(join(dir, "missing-ffprobe"), "x.wav")).toBeNull();
    expect(await probeDurationSec(script(dir, "fails", "echo 3; exit 1"), "x.wav")).toBeNull();
    expect(await probeDurationSec(script(dir, "na", "echo N/A"), "x.wav")).toBeNull();
    expect(await probeDurationSec(script(dir, "zero", "echo 0"), "x.wav")).toBeNull();
  });
});

describe("turjuman run --dry-run: what it opens", () => {
  it("refuses kind none, a missing file and a file input without a path, with exit code 2", async () => {
    const cases: Array<[string, string | undefined, RegExp]> = [
      ["", undefined, /audio\.input\.kind is "none".*pass --file <wav>/],
      ["", join(tempDir(), "gone.wav"), /^turjuman run --dry-run: file not found: .*gone\.wav$/],
      ["audio:\n  input:\n    kind: file\n", undefined, /audio\.input\.path is required/],
      [
        "audio:\n  input:\n    kind: device\n    device: ''\n",
        undefined,
        /audio\.input\.device is empty/,
      ],
    ];
    for (const [yaml, file, message] of cases) {
      const { loaded } = configured(yaml);
      const r = await dryRun(loaded, file === undefined ? {} : { file });
      expect(await r.done).toBe(2);
      expect(r.c.errText()).toMatch(message);
      expect(r.fake.procs).toEqual([]);
    }
  });

  it("finds audio.input.path under DATA_DIR, like the server (not the working folder)", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, "recordings"));
    audioFile(join(dataDir, "recordings"), "dry-run-data-dir-check.wav");
    const { loaded } = configured(
      "audio:\n  input:\n    kind: file\n    path: recordings/dry-run-data-dir-check.wav\n",
      { DATA_DIR: dataDir },
    );
    const r = await dryRun(loaded);
    const expected = join(dataDir, "recordings", "dry-run-data-dir-check.wav");
    expect(r.c.err[0]).toBe(
      `dry run (audio and levels only, no provider): file ${expected}; Ctrl-C to stop`,
    );
    expect(r.proc().args.join(" ")).toContain(expected);
    r.proc().out(new Uint8Array(FRAME * 10));
    r.proc().exit(0);
    expect(await r.done).toBe(0);
  });

  it("describes a device, a network listener and a looping file from a start time", async () => {
    const dir = tempDir();
    audioFile(dir, "loop.wav");
    const cases: Array<[string, string]> = [
      ["audio:\n  input:\n    kind: device\n    device: USB Mic\n", 'device "USB Mic"'],
      [
        "audio:\n  input:\n    kind: network\n",
        "network: listening on tcp port 7000 for the audio bridge (48000 Hz, 2 ch)",
      ],
      [
        "audio:\n  input:\n    kind: file\n    path: loop.wav\n    loop: true\n    startAtSec: 5\n",
        `file ${join(dir, "loop.wav")} (loop) from 5 s`,
      ],
    ];
    for (const [yaml, described] of cases) {
      const { loaded } = configured(yaml, { DATA_DIR: dir });
      const abort = new AbortController();
      const r = await dryRun(loaded, { signal: abort.signal });
      expect(r.c.err[0]).toBe(
        `dry run (audio and levels only, no provider): ${described}; Ctrl-C to stop`,
      );
      abort.abort();
      expect(await r.done).toBe(0);
    }
  });
});

describe("turjuman run --dry-run: frames and levels", () => {
  it("passes when the frames at the end of the file match its duration", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const file = audioFile(dir);
    const { loaded } = configured();
    const r = await dryRun(loaded, { file, probeDuration: async () => 2 });
    const proc = r.proc();
    expect(proc.args).not.toContain("pipe:3");
    for (let i = 0; i < 20; i++) {
      proc.out(new Uint8Array(FRAME).fill(i % 2 === 0 ? 0x10 : 0xf0));
      vi.advanceTimersByTime(100);
    }
    proc.exit(0);
    expect(await r.done).toBe(0);
    expect(r.c.out[0]).toMatch(/^rms -?\d+\.\d dBFS {2}peak -?\d+\.\d dBFS {2}frames 1$/);
    expect(r.c.out.filter((l) => l.startsWith("rms "))).toHaveLength(10);
    expect(r.c.out[r.c.out.length - 1]).toBe("frames=20 expected≈20.0 (Δ=0.00%)");
    expect(r.c.err).toContain("audio: ok");
    expect(r.c.err).toContain("audio: ended");
  });

  it("fails when frames are missing or extra beyond ±1 % (and one frame)", async () => {
    expect(FRAME_TOLERANCE_PCT).toBe(1);
    const file = audioFile(tempDir());
    const { loaded } = configured();
    const cases: Array<[number, number, string]> = [
      [10, 5, "frames=5 expected≈10.0 (Δ=-50.00%)"],
      [1, 12, "frames=12 expected≈10.0 (Δ=+20.00%)"],
    ];
    for (const [, frames, line] of cases) {
      const r = await dryRun(loaded, { file, probeDuration: async () => 1 });
      r.proc().out(new Uint8Array(FRAME * frames));
      r.proc().exit(0);
      expect(await r.done).toBe(1);
      expect(r.c.out[r.c.out.length - 1]).toBe(line);
    }
    // A trailing partial frame is never emitted: one frame short still passes.
    const r = await dryRun(loaded, { file, probeDuration: async () => 1 });
    r.proc().out(new Uint8Array(FRAME * 9));
    r.proc().exit(0);
    expect(await r.done).toBe(0);
  });

  it("counts from audio.input.startAtSec, and a start past the end expects nothing", async () => {
    const dir = tempDir();
    audioFile(dir, "late.wav");
    const { loaded } = configured(
      "audio:\n  input:\n    kind: file\n    path: late.wav\n    startAtSec: 5\n",
      { DATA_DIR: dir },
    );
    const silent = await dryRun(loaded, { probeDuration: async () => 3 });
    silent.proc().exit(0);
    expect(await silent.done).toBe(0);
    expect(silent.c.out[silent.c.out.length - 1]).toBe("frames=0 expected≈0.0 (Δ=0.00%)");
    const noisy = await dryRun(loaded, { probeDuration: async () => 3 });
    noisy.proc().out(new Uint8Array(FRAME * 2));
    noisy.proc().exit(0);
    expect(await noisy.done).toBe(1);
    expect(noisy.c.out[noisy.c.out.length - 1]).toBe("frames=2 expected≈0.0 (Δ=+100.00%)");
  });

  it("cannot check the frames without a duration", async () => {
    const file = audioFile(tempDir());
    const { loaded } = configured();
    const r = await dryRun(loaded, { file, probeDuration: async () => null });
    r.proc().out(new Uint8Array(FRAME * 3));
    r.proc().exit(0);
    expect(await r.done).toBe(1);
    expect(r.c.err[r.c.err.length - 1]).toBe(
      "frames=3; could not read the file duration with ffprobe",
    );
  });

  it("reports a duration check that throws with exit code 1", async () => {
    const file = audioFile(tempDir());
    const { loaded } = configured();
    const r = await dryRun(loaded, {
      file,
      probeDuration: () => Promise.reject(new Error("ffprobe crashed")),
    });
    r.proc().exit(0);
    expect(await r.done).toBe(1);
    expect(r.c.err[r.c.err.length - 1]).toBe("turjuman run --dry-run: ffprobe crashed");
  });

  it("asks the ffprobe next to the configured ffmpeg by default", async () => {
    const tools = tempDir();
    script(tools, "ffprobe", "echo 0.5");
    const file = audioFile(tempDir());
    const { loaded } = configured(`audio:\n  ffmpegPath: ${join(tools, "ffmpeg")}\n`);
    const r = await dryRun(loaded, { file, probeDuration: undefined });
    expect(r.proc().command).toBe(join(tools, "ffmpeg"));
    r.proc().out(new Uint8Array(FRAME * 5));
    r.proc().exit(0);
    expect(await r.done).toBe(0);
    expect(r.c.out[r.c.out.length - 1]).toBe("frames=5 expected≈5.0 (Δ=0.00%)");
  });

  it("shows NO SIGNAL after ten seconds of silence, and ffmpeg's complaint with a problem state", async () => {
    vi.useFakeTimers();
    const { loaded } = configured("audio:\n  input:\n    kind: device\n    device: Mic\n");
    const abort = new AbortController();
    const r = await dryRun(loaded, { signal: abort.signal });
    const proc = r.proc();
    for (let i = 0; i < 102; i++) {
      proc.out(new Uint8Array(FRAME));
      vi.advanceTimersByTime(100);
    }
    expect(r.c.out[r.c.out.length - 1]).toMatch(/frames 10\d {2}NO SIGNAL$/);
    proc.err("Device busy\n");
    vi.advanceTimersByTime(2500);
    expect(r.c.err).toContain("audio: stalled (Device busy)");
    expect(r.c.err).toContain("audio: restarting (Device busy)");
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await r.done).toBe(0);
    expect(r.c.err[r.c.err.length - 1]).toMatch(/^stopped after 10\d frames$/);
  });

  it("ends with exit code 1 when ffmpeg cannot read the file, instead of retrying it", async () => {
    vi.useFakeTimers();
    const file = audioFile(tempDir(), "broken.wav");
    const { loaded } = configured();
    const r = await dryRun(loaded, { file });
    r.proc().err("Error opening input files: Invalid data found when processing input\n");
    r.proc().exit(183);
    expect(await r.done).toBe(1);
    // No "audio: restarting": the run ends, it does not retry.
    expect(r.c.err.slice(1)).toEqual([
      "audio: idle",
      "turjuman run --dry-run: ffmpeg could not read the file (Error opening input files: Invalid data found when processing input)",
    ]);
    // Nothing is retried after the end.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.fake.procs).toHaveLength(1);
  });

  it("also ends for a looping file from the config, and says so without ffmpeg's words", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    audioFile(dir, "loop.wav");
    const { loaded } = configured(
      "audio:\n  input:\n    kind: file\n    path: loop.wav\n    loop: true\n",
      {
        DATA_DIR: dir,
      },
    );
    const r = await dryRun(loaded);
    r.proc().exit(1);
    expect(await r.done).toBe(1);
    expect(r.c.err.at(-1)).toBe("turjuman run --dry-run: ffmpeg could not read the file");
  });

  it("stops once when the run is cancelled while the input starts", async () => {
    const { loaded } = configured("audio:\n  input:\n    kind: network\n");
    const abort = new AbortController();
    const err: string[] = [];
    const fake = exitingSpawn();
    const code = await runDryCommand({
      loaded,
      io: {
        out: () => {},
        err: (text) => {
          err.push(text);
          // The input's first state change cancels the run (an abort inside start()).
          if (text === "audio: waiting-for-bridge") abort.abort();
        },
      },
      platform: "linux",
      spawn: fake.spawn,
      signal: abort.signal,
    });
    expect(code).toBe(0);
    expect(err.filter((l) => l.startsWith("stopped after"))).toEqual(["stopped after 0 frames"]);
    expect(fake.last().signals).toEqual(["SIGTERM"]);
  });

  it("stops at once when the run was cancelled before it started", async () => {
    const { loaded } = configured("audio:\n  input:\n    kind: device\n");
    const abort = new AbortController();
    abort.abort();
    const r = await dryRun(loaded, { signal: abort.signal });
    expect(await r.done).toBe(0);
    expect(r.c.err[r.c.err.length - 1]).toBe("stopped after 0 frames");
  });
});

describe("turjuman run --dry-run: Ctrl-C", () => {
  it("stops on SIGINT, SIGTERM or SIGHUP and stops listening afterwards", async () => {
    const { loaded } = configured("audio:\n  input:\n    kind: device\n");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const before = process.listenerCount(signal);
      // This computer's platform (Ctrl-Break only on Windows).
      const r = await dryRun(loaded, { platform: undefined });
      expect(process.listenerCount(signal)).toBe(before + 1);
      expect(process.listenerCount("SIGBREAK")).toBe(process.platform === "win32" ? 1 : 0);
      r.proc().out(new Uint8Array(FRAME * 2));
      process.emit(signal, signal);
      expect(await r.done).toBe(0);
      expect(r.c.err[r.c.err.length - 1]).toBe("stopped after 2 frames");
      expect(process.listenerCount(signal)).toBe(before);
    }
  });

  it("also listens for Ctrl-Break on Windows", async () => {
    const { loaded } = configured("audio:\n  input:\n    kind: device\n");
    const r = await dryRun(loaded, { platform: "win32" });
    expect(process.listenerCount("SIGBREAK")).toBe(1);
    process.emit("SIGBREAK", "SIGBREAK");
    expect(await r.done).toBe(0);
    expect(process.listenerCount("SIGBREAK")).toBe(0);
  });
});

describe("turjuman run --dry-run through runCli", () => {
  it("loads the config and checks the input without starting a server", async () => {
    const { dir } = configured();
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["run", "--dry-run"], c.io)).toBe(2);
    expect(c.errText()).toMatch(/audio\.input\.kind is "none"/);
    c.clear();
    expect(await runCli(["run", "--dry-run", "--file", join(dir, "nope.wav")], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman run --dry-run: file not found: ${join(dir, "nope.wav")}`);
  });
});
