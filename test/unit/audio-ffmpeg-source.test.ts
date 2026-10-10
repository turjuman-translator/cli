import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_BYTES } from "../../src/audio/chunker.js";
import {
  createAudioSource,
  FFMPEG_TIMING,
  FfmpegAudioSource,
  type FfmpegAudioSourceOptions,
  RAW_TAP_FORMAT,
} from "../../src/audio/ffmpeg.js";
import type { Level } from "../../src/audio/level.js";
import type { Config } from "../../src/config.js";
import type { AudioInputHandlers, AudioInputSpec } from "../../src/core/contracts.js";
import type { AudioState } from "../../src/shared/protocol.js";
import { fakeLog, fakeSpawn } from "./audio-fake-ffmpeg.js";

const DEVICE: AudioInputSpec = { kind: "device", device: "hw:1,0" };
const FILE: AudioInputSpec = { kind: "file", path: "/srv/khutbah.wav", loop: false, startAtSec: 0 };
const LOOP: AudioInputSpec = { kind: "file", path: "/srv/khutbah.wav", loop: true, startAtSec: 0 };
const NETWORK: AudioInputSpec = { kind: "network", port: 7000, sampleRate: 48_000, channels: 2 };

/** `n` frames of 16 kHz mono s16le (silence unless `fill` is given). */
const frames = (n = 1, fill = 0): Uint8Array => new Uint8Array(FRAME_BYTES * n).fill(fill);

function setup(spec: AudioInputSpec, extra: Partial<FfmpegAudioSourceOptions> = {}) {
  const fake = fakeSpawn();
  const log = fakeLog();
  const states: AudioState[] = [];
  const arrivals: number[] = [];
  const levels: Level[] = [];
  let ended = 0;
  const handlers: AudioInputHandlers = {
    onFrame: (_frame, at) => {
      arrivals.push(at);
    },
    onLevel: (level) => {
      levels.push(level);
    },
    onState: (state) => {
      states.push(state);
    },
    onEnded: () => {
      ended++;
    },
  };
  const src = new FfmpegAudioSource({
    ffmpegPath: "ffmpeg",
    spec,
    channel: "mix",
    gainDb: 0,
    highpassHz: 0,
    silenceWarnDbfs: -50,
    platform: "linux",
    spawn: fake.spawn,
    log: log.logger,
    now: () => Date.now(),
    ...extra,
  });
  return { src, fake, log, states, arrivals, levels, handlers, ended: () => ended };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FfmpegAudioSource: running", () => {
  it("goes ok on the first byte, cuts frames, meters levels and keeps the last stderr line", () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    expect(p.command).toBe("ffmpeg");
    expect(p.args).toContain("pipe:3"); // the raw tap is on by default for a device on Linux
    expect(t.src.rawTapActive).toBe(true);
    expect(t.src.state).toBe("idle");

    p.out(frames(2).subarray(0, 5000)); // one frame + 1,800 bytes carried over
    expect(t.src.state).toBe("ok");
    expect(t.states).toEqual(["ok"]);
    expect(t.arrivals).toEqual([1_000_000]);
    vi.advanceTimersByTime(100);
    p.out(frames(1).subarray(0, 1400));
    expect(t.src.framesEmitted).toBe(2);
    expect(t.src.lastFrameAt).toBe(1_000_100);
    expect(t.levels).toEqual([{ rmsDbfs: -100, peakDbfs: -100 }]); // the second is not due yet
    expect(t.src.level).toEqual({ rmsDbfs: -100, peakDbfs: -100 });
    expect(t.src.noSignal).toBe(false);

    p.err("first line\r\nsecond");
    expect(t.src.lastStderr).toBe("first line");
    p.err(" part\n\n");
    expect(t.src.lastStderr).toBe("second part");
    expect(t.log.warn).toHaveBeenCalledWith({ stderr: "second part" }, "ffmpeg");
  });

  it("kills a stalled ffmpeg and restarts it with backoff; a dead run's output is ignored", () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.out(frames(1));
    vi.advanceTimersByTime(FFMPEG_TIMING.stallMs - 250);
    expect(t.src.state).toBe("ok");
    vi.advanceTimersByTime(250);
    expect(t.src.state).toBe("stalled");
    expect(p.signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(FFMPEG_TIMING.watchdogMs * 4); // being killed: not killed again
    expect(p.signals).toEqual(["SIGTERM"]);
    p.out(frames(1)); // after a stall kill: dropped
    expect(t.src.framesEmitted).toBe(1);
    p.err("Connection timed out");
    p.exit(null, "SIGTERM");
    expect(t.src.state).toBe("restarting");
    expect(t.states).toEqual(["ok", "stalled", "restarting"]);
    expect(t.log.messages("info")).toContain("ffmpeg exited");
    vi.advanceTimersByTime(499);
    expect(t.fake.procs).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.fake.procs).toHaveLength(2);
    vi.advanceTimersByTime(FFMPEG_TIMING.killGraceMs);
    expect(p.signals).toEqual(["SIGTERM"]); // exited in time: no SIGKILL

    p.out(frames(1)); // the replaced run
    p.raw([1, 2, 3, 4]);
    expect(t.src.framesEmitted).toBe(1);
    t.fake.last().out(frames(1));
    expect(t.src.state).toBe("ok");
    expect(t.src.framesEmitted).toBe(2);
  });

  it("steps the backoff 0.5 → 1 s and resets it after 30 s of ok", () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    t.fake.last().exit(1);
    vi.advanceTimersByTime(500);
    t.fake.last().exit(1);
    vi.advanceTimersByTime(999);
    expect(t.fake.procs).toHaveLength(2);
    vi.advanceTimersByTime(1);
    const p = t.fake.last();
    expect(t.fake.procs).toHaveLength(3);
    for (let i = 0; i < 31; i++) {
      p.out(frames(1));
      vi.advanceTimersByTime(1000);
    }
    p.exit(0); // a crash after a long healthy run: the first backoff step again
    vi.advanceTimersByTime(500);
    expect(t.fake.procs).toHaveLength(4);
  });

  it("restarts a device that produces no audio; five failed starts in a row mean error", () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    vi.advanceTimersByTime(FFMPEG_TIMING.firstByteTimeoutMs - 250);
    expect(t.fake.last().signals).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(t.fake.last().signals).toEqual(["SIGTERM"]);
    expect(t.log.messages("warn")).toContain("ffmpeg produced no audio; restarting");
    t.fake.last().exit(null, "SIGTERM"); // failed start 1 → 0.5 s
    for (const delay of [500, 1000, 2000, 5000]) {
      vi.advanceTimersByTime(delay);
      t.fake.last().exit(1); // failed starts 2..5
    }
    expect(t.src.state).toBe("error");
    expect(t.fake.procs).toHaveLength(5);
    vi.advanceTimersByTime(FFMPEG_TIMING.errorRetryMs);
    expect(t.fake.procs).toHaveLength(6);
    t.fake.last().err("Device or resource busy\n");
    expect(t.log.debug).toHaveBeenCalledWith({ stderr: "Device or resource busy" }, "ffmpeg");
    t.fake.last().out(frames(1));
    expect(t.src.state).toBe("ok");
    expect(t.states).toEqual(["restarting", "error", "ok"]);
  });

  it("network: waits for the bridge without restarting, and relaunches the listener", () => {
    const t = setup(NETWORK);
    t.src.start(t.handlers);
    expect(t.fake.last().args).toContain("tcp://0.0.0.0:7000?listen=1");
    expect(t.src.state).toBe("waiting-for-bridge");
    vi.advanceTimersByTime(60_000); // silence is normal while waiting
    expect(t.fake.last().signals).toEqual([]);
    t.fake.last().exit(1); // a listener that had bound its port: not a failed start
    expect(t.src.state).toBe("restarting");
    vi.advanceTimersByTime(500);
    const p = t.fake.last();
    expect(t.src.state).toBe("waiting-for-bridge");
    p.out(frames(1));
    expect(t.src.state).toBe("ok");
    p.exit(0); // the bridge disconnected
    vi.advanceTimersByTime(500);
    expect(t.fake.procs).toHaveLength(3);
    expect(t.states).toEqual([
      "waiting-for-bridge",
      "restarting",
      "waiting-for-bridge",
      "ok",
      "restarting",
      "waiting-for-bridge",
    ]);
  });

  it("network: a listener that keeps dying at once ends in error, and recovers once it binds", () => {
    const t = setup(NETWORK);
    t.src.start(t.handlers);
    t.fake.last().exit(1);
    for (const delay of [500, 1000, 2000, 5000]) {
      vi.advanceTimersByTime(delay);
      t.fake.last().exit(1);
    }
    expect(t.src.state).toBe("error");
    vi.advanceTimersByTime(FFMPEG_TIMING.errorRetryMs);
    expect(t.src.state).toBe("error"); // relaunched, but still in error until it has bound
    vi.advanceTimersByTime(FFMPEG_TIMING.listenSettleMs);
    expect(t.src.state).toBe("waiting-for-bridge");
  });

  it("file: the end of the file ends the input; a loop or a crash restarts it", async () => {
    const t = setup(FILE);
    t.src.start(t.handlers);
    expect(t.fake.last().args).not.toContain("pipe:3"); // no raw tap for files by default
    expect(t.src.rawTapActive).toBe(false);
    t.fake.last().out(frames(1));
    t.fake.last().exit(1);
    expect(t.src.state).toBe("restarting");
    vi.advanceTimersByTime(500);
    t.fake.last().out(frames(1));
    t.fake.last().exit(0);
    expect(t.src.state).toBe("ended");
    expect(t.ended()).toBe(1);
    await t.src.stop();
    expect(t.src.state).toBe("ended");

    const loop = setup(LOOP);
    loop.src.start(loop.handlers);
    loop.fake.last().out(frames(1));
    loop.fake.last().exit(0);
    expect(loop.src.state).toBe("restarting");

    const stalled = setup(FILE);
    stalled.src.start(stalled.handlers);
    stalled.fake.last().out(frames(1));
    vi.advanceTimersByTime(FFMPEG_TIMING.stallMs);
    stalled.fake.last().exit(0); // killed for a stall: not the end of the file
    expect(stalled.src.state).toBe("restarting");
  });

  it("Windows: an exit on a console interrupt waits for stop() before relaunching", async () => {
    const t = setup(DEVICE, { platform: "win32" });
    t.src.start(t.handlers);
    expect(t.fake.last().args).not.toContain("pipe:3"); // no raw tap on Windows by default
    t.fake.last().out(frames(1));
    t.fake.last().exit(255);
    expect(t.src.state).toBe("ok");
    expect(t.log.messages("info")).toContain("ffmpeg exited on a console interrupt");
    vi.advanceTimersByTime(FFMPEG_TIMING.windowsInterruptGraceMs - 1);
    expect(t.fake.procs).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.fake.procs).toHaveLength(2);
    expect(t.src.state).toBe("restarting");

    t.fake.last().exit(0xc000013a);
    await t.src.stop(); // the app stops within the grace period: no relaunch
    vi.advanceTimersByTime(10_000);
    expect(t.fake.procs).toHaveLength(2);
    expect(t.src.state).toBe("idle");

    const killed = setup(DEVICE, { platform: "win32" });
    killed.src.start(killed.handlers);
    killed.fake.last().exit(null, "SIGKILL"); // no exit code: an ordinary failure
    expect(killed.src.state).toBe("restarting");
  });

  it("does not relaunch when a state handler stops the input", async () => {
    const t = setup(DEVICE, { platform: "win32" });
    let stopped: Promise<void> | null = null;
    t.src.start({
      ...t.handlers,
      onState: (state) => {
        if (state === "restarting") stopped = t.src.stop();
      },
    });
    t.fake.last().exit(-1073741510);
    vi.advanceTimersByTime(FFMPEG_TIMING.windowsInterruptGraceMs);
    expect(t.fake.procs).toHaveLength(1);
    await stopped;
    expect(t.src.state).toBe("idle");
  });

  it("reports a spawn failure and retries", () => {
    const t = setup(DEVICE);
    t.fake.throwOnce(new Error("spawn EACCES"));
    t.src.start(t.handlers);
    expect(t.fake.procs).toHaveLength(0);
    expect(t.src.lastStderr).toBe("cannot start ffmpeg: spawn EACCES");
    expect(t.src.state).toBe("restarting");
    t.fake.throwOnce("no such file");
    vi.advanceTimersByTime(500);
    expect(t.src.lastStderr).toBe("cannot start ffmpeg: no such file");
    vi.advanceTimersByTime(1000);
    expect(t.fake.procs).toHaveLength(1);
  });

  it("an 'error' without a pid is a failed spawn; with a pid it is only logged", () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.pid = undefined;
    p.fail(new Error("spawn ffmpeg ENOENT"));
    expect(t.src.lastStderr).toBe("cannot start ffmpeg: spawn ffmpeg ENOENT");
    expect(t.src.state).toBe("restarting");
    p.exit(-2); // a 'close' after the 'error': already handled
    expect(t.log.messages("info").filter((m) => m === "ffmpeg exited")).toHaveLength(1);
    vi.advanceTimersByTime(500);
    const q = t.fake.last();
    q.fail(new Error("EPIPE"));
    expect(t.log.messages("warn")).toContain("ffmpeg process error");
    expect(t.fake.procs).toHaveLength(2);
  });

  it("logs pipe errors at debug level without changing state", () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.stdout.emit("error", new Error("EPIPE stdout"));
    p.stderr.emit("error", new Error("EPIPE stderr"));
    p.tap?.emit("error", new Error("EPIPE tap"));
    expect(t.log.messages("debug").filter((m) => m === "ffmpeg pipe error")).toHaveLength(3);
    expect(t.src.state).toBe("idle");
  });

  it("scrubs secrets from stderr, caps long lines and logs the unterminated tail on exit", () => {
    const t = setup(NETWORK, { secrets: ["s3cr3t-token"] });
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.err("bad key s3cr3t-token\n");
    expect(t.src.lastStderr).toBe("bad key [redacted]");
    p.err(`${"x".repeat(600)}\n`);
    expect(t.src.lastStderr).toHaveLength(500);
    p.err("y".repeat(3000));
    p.err("z");
    p.exit(1);
    expect(t.src.lastStderr).toBe("y".repeat(500)); // the carried tail was capped at 2,000
  });

  it("counts handler errors and logs the 1st and every 100th", () => {
    const t = setup(DEVICE);
    t.src.start({
      onFrame: () => {
        throw new Error("consumer bug");
      },
    });
    t.fake.last().out(frames(150));
    expect(t.src.framesEmitted).toBe(150);
    const counts = t.log.error.mock.calls
      .filter((args) => args[1] === "audio input handler threw")
      .map((args) => (args[0] as { count: number }).count);
    expect(counts).toEqual([1, 100]);
  });

  it("stops delivering a chunk's frames once a handler stopped the input", async () => {
    const t = setup(DEVICE);
    let stopped: Promise<void> | null = null;
    t.src.start({
      onFrame: () => {
        stopped ??= t.src.stop();
      },
    });
    t.fake.last().out(frames(3));
    expect(t.src.framesEmitted).toBe(1);
    t.fake.last().exit(0);
    await stopped;
  });
});

describe("FfmpegAudioSource: stopping", () => {
  it("SIGTERMs ffmpeg and resolves once it exited; stop() is shared while it runs", async () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.out(frames(1));
    const stopping = t.src.stop();
    expect(t.src.stop()).toBe(stopping);
    expect(p.signals).toEqual(["SIGTERM"]);
    expect(() => t.src.start(t.handlers)).toThrow("audio input is still stopping");
    p.exit(0);
    await stopping;
    expect(t.src.state).toBe("idle");
    expect(t.log.messages("info")).not.toContain("ffmpeg exited");
    t.src.start(t.handlers);
    expect(() => t.src.start(t.handlers)).toThrow("audio input already started");
    expect(t.fake.procs).toHaveLength(2);
  });

  it("SIGKILLs after the grace period and gives up waiting after 5 s", async () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    const stopping = t.src.stop();
    vi.advanceTimersByTime(FFMPEG_TIMING.killGraceMs);
    expect(p.signals).toEqual(["SIGTERM", "SIGKILL"]);
    vi.advanceTimersByTime(3000);
    await stopping;
    expect(t.src.state).toBe("idle");
    p.exit(null, "SIGKILL"); // it finally exits: nothing restarts
    vi.advanceTimersByTime(10_000);
    expect(t.fake.procs).toHaveLength(1);
  });

  it("keeps going when ffmpeg cannot be signalled", async () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.onKill = () => {
      throw new Error("EPERM");
    };
    const stopping = t.src.stop();
    expect(t.log.messages("warn")).toContain("could not signal ffmpeg");
    p.exit(0);
    await stopping;
  });

  it("cancels a pending restart, and stops cleanly when never started", async () => {
    const t = setup(DEVICE);
    await t.src.stop();
    expect(t.src.state).toBe("idle");
    t.src.start(t.handlers);
    t.fake.last().exit(1);
    expect(t.src.state).toBe("restarting");
    await t.src.stop();
    vi.advanceTimersByTime(10_000);
    expect(t.fake.procs).toHaveLength(1);
    expect(t.src.state).toBe("idle");
  });

  it("a stall kill followed by stop() keeps a single kill timer", async () => {
    const t = setup(DEVICE);
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.out(frames(1));
    vi.advanceTimersByTime(FFMPEG_TIMING.stallMs);
    expect(p.signals).toEqual(["SIGTERM"]);
    const stopping = t.src.stop();
    expect(p.signals).toEqual(["SIGTERM", "SIGTERM"]);
    vi.advanceTimersByTime(FFMPEG_TIMING.killGraceMs);
    expect(p.signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    p.exit(null, "SIGKILL");
    await stopping;
  });
});

describe("FfmpegAudioSource: raw tap and recording", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-ffmpeg-rec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes whole sample frames to the raw listener, carrying partial ones over", () => {
    const t = setup(DEVICE);
    const chunks: number[][] = [];
    t.src.setRawListener((chunk) => {
      chunks.push([...chunk]);
    });
    t.src.start(t.handlers);
    const p = t.fake.last();
    p.raw([1, 2, 3, 4, 5, 6]);
    p.raw([7, 8]);
    p.raw([9, 10, 11]);
    p.raw([12]);
    expect(chunks).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ]);
    t.src.setRawListener(() => {
      throw new Error("listener bug");
    });
    p.raw([1, 2, 3, 4]);
    expect(t.log.messages("error")).toContain("audio input handler threw");
    t.src.setRawListener(null);
    p.raw([1, 2, 3, 4]);
    expect(chunks).toHaveLength(3);
  });

  it("records the raw tap into a WAV (set before start: no restart needed)", async () => {
    const t = setup(DEVICE);
    const path = join(dir, "rec.wav");
    expect(t.src.recording).toBeNull();
    await t.src.setRecording(path);
    expect(t.src.recording).toEqual({ path, startedAt: 1_000_000 });
    t.src.start(t.handlers);
    expect(t.fake.procs).toHaveLength(1);
    const p = t.fake.last();
    p.raw(new Array(1922).fill(3)); // 480 sample frames + 2 bytes carried
    p.raw([3, 3]);
    await t.src.setRecording(null);
    expect(t.src.recording).toBeNull();
    const bytes = readFileSync(path);
    expect(bytes.byteLength).toBe(44 + 1924);
    expect(bytes.readUInt32LE(40)).toBe(1924);
    expect(bytes.readUInt32LE(24)).toBe(RAW_TAP_FORMAT.sampleRate);
    const saved = t.log.info.mock.calls.find((args) => args[1] === "recording saved");
    expect(saved?.[0]).toMatchObject({ path, seconds: 1924 / (48_000 * 4) });
    const stopping = t.src.stop();
    p.exit(0);
    await stopping;
  });

  it("restarts a tap-less ffmpeg once to start a recording", async () => {
    const t = setup(FILE);
    t.src.start(t.handlers);
    const p1 = t.fake.last();
    p1.out(frames(1));
    await t.src.setRecording(join(dir, "a.wav"));
    expect(t.log.messages("info")).toContain("restarting ffmpeg to enable the raw tap");
    expect(p1.signals).toEqual(["SIGTERM"]);
    p1.out(frames(1)); // still delivered until it exits (a deliberate restart)
    expect(t.src.framesEmitted).toBe(2);
    p1.exit(null, "SIGTERM");
    expect(t.log.messages("debug")).toContain("ffmpeg exited");
    expect(t.fake.procs).toHaveLength(2); // relaunched at once, no backoff
    const p2 = t.fake.last();
    expect(p2.args).toContain("pipe:3");
    expect(t.src.rawTapActive).toBe(true);

    await t.src.setRecording(join(dir, "b.wav")); // the tap is already on
    expect(p2.signals).toEqual([]);
    await t.src.setRecording(null); // the tap goes off with the next restart
    p2.out(frames(1));
    p2.exit(1);
    vi.advanceTimersByTime(500);
    const p3 = t.fake.last();
    expect(p3.args).not.toContain("pipe:3");

    p3.out(frames(1));
    vi.advanceTimersByTime(FFMPEG_TIMING.stallMs);
    expect(p3.signals).toEqual(["SIGTERM"]);
    await t.src.setRecording(join(dir, "c.wav")); // already being killed: no second kill
    expect(p3.signals).toEqual(["SIGTERM"]);
    p3.exit(null, "SIGTERM");
    vi.advanceTimersByTime(1000);
    expect(t.fake.last().args).toContain("pipe:3");
    const stopping = t.src.stop();
    t.fake.last().exit(0);
    await stopping;
    expect(t.src.recording).toBeNull();
  });
});

describe("FfmpegAudioSource: construction", () => {
  it("defaults the platform, spawn, clock, secrets and raw tap", () => {
    const log = fakeLog();
    const src = new FfmpegAudioSource({
      ffmpegPath: "ffmpeg",
      spec: FILE,
      channel: "mix",
      gainDb: 0,
      highpassHz: 0,
      silenceWarnDbfs: -50,
      log: log.logger,
    });
    expect(src.state).toBe("idle");
    expect(src.lastStderr).toBeNull();
    expect(src.framesEmitted).toBe(0);
    expect(src.lastFrameAt).toBeNull();
    expect(src.level).toBeNull();
    expect(src.recording).toBeNull();
    expect(src.rawTapActive).toBe(false);
  });

  it("fails fast on an invalid input spec", () => {
    expect(() => setup({ kind: "device", device: " " })).toThrow("audio.input.device is empty");
  });

  it("createAudioSource takes channel, gain, high-pass and the threshold from audio.*", () => {
    const fake = fakeSpawn();
    const audio: Config["audio"] = {
      ffmpegPath: "/opt/ffmpeg",
      input: {
        kind: "file",
        device: "",
        path: "k.wav",
        loop: false,
        startAtSec: 0,
        network: { port: 7000, sampleRate: 48_000, channels: 2 },
      },
      monitorWhenIdle: true,
      channel: "left",
      gainDb: 6,
      highpassHz: 80,
      silenceWarnDbfs: -50,
    };
    const src = createAudioSource(audio, FILE, {
      log: fakeLog().logger,
      spawn: fake.spawn,
      platform: "linux",
      rawTap: true,
      now: () => 0,
    });
    src.start({ onFrame: () => {} });
    const p = fake.last();
    expect(p.command).toBe("/opt/ffmpeg");
    expect(p.args[p.args.indexOf("-af") + 1]).toBe("pan=mono|c0=c0,highpass=f=80,volume=6dB");
    expect(p.args).toContain("pipe:3");
    p.exit(0);
  });
});
