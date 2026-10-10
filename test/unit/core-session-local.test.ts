import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineUnavailableError } from "../../src/core/contracts.js";
import {
  FIRST_FRAME_TIMEOUT_MS,
  NO_SIGNAL_MS,
  PROVIDER_LIVE_TIMEOUT_MS,
} from "../../src/core/session.js";
import { ManualInput, silentFrame, src, tempDirs, toneFrame, tr } from "./helpers/core-fakes.js";
import { makeSession, type SessionSetup } from "./helpers/core-session.js";

const T0 = new Date(2026, 9, 9, 13, 0, 0).getTime();
const temp = tempDirs("core-session-local-");

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const local = (s: SessionSetup = {}) => makeSession(temp.make(), { kind: "device", ...s });

/** Start, deliver the first frame and wait for the provider: the usual successful start. */
async function startLive(p: ReturnType<typeof local>) {
  const started = p.session.startLocal();
  const input = p.inputs[0];
  if (input === undefined) throw new Error("no input");
  input.setState("ok");
  input.frame();
  await flush();
  return { result: await started, input };
}

describe("local session: start", () => {
  it("goes live after the input's first frame and the provider's connect", async () => {
    const p = local();
    expect(p.session.status()).toMatchObject({ state: "starting", audio: { state: "none" } });
    const { result, input } = await startLive(p);
    expect(result).toEqual({ ok: true, message: "live" });
    expect(input.started).toBe(true);
    expect(p.session.status()).toMatchObject({
      state: "live",
      provider: "live",
      audio: { state: "ok", noSignal: false },
      session: { kind: "device", source: "device", inputKind: "device" },
    });
    expect(p.session.status().page).toBeUndefined();
    input.frame();
    expect(p.f.providers[0]?.frames).toBe(1);
    expect(p.markers().map((m) => m.type)).toEqual(["start", "engine-open", "live"]);
    expect(await p.session.startLocal()).toEqual({ ok: false, message: "session already started" });
    await p.session.stop("test");
  });

  it("describes a network input and a file input", async () => {
    const net = local({ spec: { kind: "network", port: 7000, sampleRate: 48_000, channels: 2 } });
    expect(net.session.info().inputKind).toBe("network");
    expect(net.session.info().file).toBeUndefined();
    await net.session.stop("test");
    const file = local({
      kind: "file",
      spec: { kind: "file", path: "/media/khutbah.wav", loop: false, startAtSec: 0 },
    });
    expect(file.session.info()).toMatchObject({
      kind: "file",
      source: "file",
      inputKind: "file",
      file: "/media/khutbah.wav",
    });
    await startLive(file);
    expect(file.markers()[0]).toMatchObject({ type: "start", file: "/media/khutbah.wav" });
    expect(readFileSync(join(file.dir() ?? "", "session.log"), "utf8")).toContain(
      ", file /media/khutbah.wav",
    );
    await file.session.stop("test");
  });

  it("stops at the end of a file", async () => {
    const p = local({
      kind: "file",
      spec: { kind: "file", path: "/media/k.wav", loop: false, startAtSec: 0 },
    });
    const { input } = await startLive(p);
    input.end();
    await flush();
    expect(p.session.stopped).toBe(true);
    expect(p.markers().map((m) => m.type)).toContain("input-ended");
    expect(p.markers().at(-1)).toMatchObject({ type: "stop", reason: "file ended" });
  });

  it("takes a frame delivered while the input starts as the first frame", async () => {
    const p = local({
      input: (spec) => {
        const input = new ManualInput(spec, "ok");
        const start = input.start.bind(input);
        input.start = (handlers) => {
          start(handlers);
          handlers.onFrame(toneFrame(), Date.now());
        };
        return input;
      },
    });
    expect(await p.session.startLocal()).toEqual({ ok: true, message: "live" });
    await p.session.stop("test");
  });

  it("is not a local session without local options", async () => {
    const device = local({ options: { local: undefined } });
    expect(device.session.info().inputKind).toBe("device");
    expect(await device.session.startLocal()).toEqual({
      ok: false,
      message: "not a local session",
    });
    await device.session.stop("test");
    const file = local({ kind: "file", options: { local: undefined } });
    expect(file.session.info().inputKind).toBe("file");
    await file.session.stop("test");
    const page = makeSession(temp.make());
    expect(await page.session.startLocal()).toEqual({ ok: false, message: "not a local session" });
    await page.session.stop("test");
  });
});

describe("local session: failed starts", () => {
  it("fails when the input cannot start", async () => {
    const p = local({
      input: () => {
        throw new Error("no such device");
      },
    });
    const result = await p.session.startLocal();
    expect(result).toEqual({
      ok: false,
      message: "audio input failed to start: no such device",
    });
    expect(p.session.status()).toMatchObject({
      state: "error",
      error: "audio input failed to start: no such device",
    });
    expect(p.stopped).toEqual([p.session]);
  });

  it("reports an input that fails with something other than an Error", async () => {
    const p = local({
      input: () => {
        throw "ffmpeg not found";
      },
    });
    expect(await p.session.startLocal()).toEqual({
      ok: false,
      message: "audio input failed to start: ffmpeg not found",
    });
  });

  it("shows the error state as soon as the engine fails during the start", async () => {
    const p = local({ providers: [{ start: "manual" }] });
    const started = p.session.startLocal();
    p.inputs[0]?.frame();
    await flush();
    p.f.providers[0]?.emit({ type: "error", fatal: true, message: "401 Unauthorized" });
    expect(p.session.status()).toMatchObject({ state: "error", error: "401 Unauthorized" });
    expect(await started).toEqual({ ok: false, message: "401 Unauthorized" });
  });

  it("fails without audio in time, quoting the input's last stderr line", async () => {
    const p = local();
    const started = p.session.startLocal();
    const input = p.inputs[0];
    if (input === undefined) throw new Error("no input");
    input.stderr = "Device or resource busy";
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    expect(await started).toEqual({
      ok: false,
      message: "no audio from the device input within 5 s: Device or resource busy",
    });
    // An idle input start leaves no transcript folder behind.
    expect(p.dir()).toBeNull();
  });

  it("falls back to the stderr the input reported, or says nothing more", async () => {
    const reported = local();
    const a = reported.session.startLocal({ firstFrameTimeoutMs: 10_000 });
    reported.inputs[0]?.setState("restarting", "ffmpeg exited with code 1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await a).toEqual({
      ok: false,
      message: "no audio from the device input within 10 s: ffmpeg exited with code 1",
    });
    const silent = local({
      spec: { kind: "network", port: 7000, sampleRate: 48_000, channels: 2 },
    });
    const b = silent.session.startLocal();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    expect(await b).toEqual({ ok: false, message: "no audio from the network input within 5 s" });
  });

  it("fails when no engine can be built", async () => {
    const p = local();
    p.f.failWith = new EngineUnavailableError("SONIOX_API_KEY is not set");
    const { result } = await startLive(p);
    expect(result).toEqual({ ok: false, message: "SONIOX_API_KEY is not set" });
    expect(p.session.status().state).toBe("error");
  });

  it("fails when the provider cannot connect", async () => {
    const p = local({ providers: [{ start: "manual" }] });
    const started = p.session.startLocal();
    p.inputs[0]?.frame();
    await flush();
    p.f.providers[0]?.failStart("connect refused");
    expect(await started).toEqual({ ok: false, message: "connect refused" });
    expect(p.inputs[0]?.stopped).toBe(true);
  });

  it("goes live while the provider is still connecting", async () => {
    const p = local({ providers: [{ start: "manual" }] });
    const started = p.session.startLocal();
    p.inputs[0]?.frame();
    await vi.advanceTimersByTimeAsync(PROVIDER_LIVE_TIMEOUT_MS);
    expect(await started).toEqual({ ok: true, message: "started; provider still connecting" });
    expect(readFileSync(join(p.dir() ?? "", "session.log"), "utf8")).toContain(
      "live (provider still connecting)",
    );
    await p.session.stop("test");
  });

  it("ends the start when the session is stopped while it waits", async () => {
    const waitingForFrame = local();
    const a = waitingForFrame.session.startLocal();
    await waitingForFrame.session.stop("operator");
    expect(await a).toEqual({ ok: false, message: "session stopped" });

    const connecting = local({ providers: [{ start: "manual" }] });
    const b = connecting.session.startLocal();
    connecting.inputs[0]?.frame();
    await flush();
    await connecting.session.stop("operator");
    expect(await b).toEqual({ ok: false, message: "session stopped" });

    const failing = local({ providers: [{ start: "manual" }] });
    const c = failing.session.startLocal();
    failing.inputs[0]?.frame();
    await flush();
    failing.f.providers[0]?.emit({ type: "error", fatal: true, message: "401 Unauthorized" });
    void failing.session.stop("operator");
    expect(await c).toEqual({ ok: false, message: "401 Unauthorized" });
  });
});

describe("local session: while live", () => {
  it("captions what the provider hears", async () => {
    const p = local();
    await startLive(p);
    p.f.providers[0]?.tokens([src("الحمد", 0, 400), tr("Alle lof")]);
    expect(p.of("segment").at(-1)?.segment.translations.nl?.text).toBe("Alle lof");
    await p.session.stop("test");
  });

  it("sends levels at most five times a second, with the peak since the last one", async () => {
    const p = local();
    const { input } = await startLive(p);
    const before = p.of("level").length;
    for (let i = 0; i < 10; i++) {
      input.frame(i === 3 ? toneFrame(0.9) : toneFrame(0.1));
      vi.advanceTimersByTime(100);
    }
    const levels = p.of("level").slice(before);
    expect(levels.length).toBeGreaterThanOrEqual(4);
    expect(levels.length).toBeLessThanOrEqual(6);
    expect(Math.max(...levels.map((l) => l.peakDbfs))).toBeCloseTo(20 * Math.log10(0.9), 0);
    expect(levels.every((l) => Number.isInteger(l.rmsDbfs * 100))).toBe(true);
    // Odd-length frames carry no level.
    const count = p.of("level").length;
    input.frame(new Uint8Array(3));
    vi.advanceTimersByTime(300);
    expect(p.of("level").length).toBe(count);
    await p.session.stop("test");
  });

  it("marks input trouble once per change and shows its stderr", async () => {
    const p = local();
    const { input } = await startLive(p);
    input.setState("restarting", "ffmpeg exited with code 1");
    input.setState("restarting", null);
    input.setState("ok");
    input.setState("stalled");
    const audio = p.markers().filter((m) => m.type === "audio");
    expect(audio).toEqual([
      expect.objectContaining({ state: "restarting", lastStderr: "ffmpeg exited with code 1" }),
      expect.objectContaining({ state: "stalled", lastStderr: null }),
    ]);
    expect(p.session.status().audio).toMatchObject({
      state: "stalled",
      lastStderr: "ffmpeg exited with code 1",
    });
    const log = readFileSync(join(p.dir() ?? "", "session.log"), "utf8");
    expect(log).toContain("audio input restarting: ffmpeg exited with code 1");
    expect(log).toContain("audio input stalled\n");
    await p.session.stop("test");
    expect(p.session.status().audio.state).toBe("idle");
  });

  it("flags no signal after 10 s of quiet audio", async () => {
    const p = local({ config: { session: { autoStopAfterSilenceMin: 5 } } });
    const { input } = await startLive(p);
    for (let i = 0; i < NO_SIGNAL_MS / 100 - 1; i++) {
      input.frame(silentFrame());
      vi.advanceTimersByTime(100);
    }
    expect(p.session.status().audio.noSignal).toBe(false);
    vi.advanceTimersByTime(100);
    expect(p.session.status().audio.noSignal).toBe(true);
    input.frame(toneFrame());
    expect(p.session.status().audio.noSignal).toBe(false);
    await p.session.stop("test");
  });

  it("stops after autoStopAfterSilenceMin without loud audio (no frames count as silence)", async () => {
    const p = local({ config: { session: { autoStopAfterSilenceMin: 0.5 } } });
    const { input } = await startLive(p);
    await vi.advanceTimersByTimeAsync(20_000);
    input.frame(toneFrame());
    await vi.advanceTimersByTimeAsync(29_000);
    expect(p.session.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.session.stopped).toBe(true);
    expect(p.session.status()).toMatchObject({
      state: "idle",
      error: "auto-stopped: no audio above -50 dBFS for 0.5 min",
    });
    expect(p.markers().map((m) => m.type)).toContain("auto-stop");
  });

  it("stops at the maximum session duration", async () => {
    const p = local({ config: { session: { maxDurationMin: 1 } } });
    const { input } = await startLive(p);
    for (let s = 0; s < 59; s++) {
      input.frame(toneFrame());
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(p.session.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.session.stopped).toBe(true);
    expect(p.session.status().error).toBe("auto-stopped: maximum session duration (1 min) reached");
  });

  it("stops with the error when its engine fails", async () => {
    const p = local();
    await startLive(p);
    p.f.providers[0]?.emit({ type: "error", fatal: true, message: "401 Unauthorized" });
    await flush();
    expect(p.session.stopped).toBe(true);
    expect(p.session.status()).toMatchObject({ state: "error", error: "401 Unauthorized" });
    expect(p.markers().at(-1)).toMatchObject({ reason: "error: 401 Unauthorized" });
    // Frames after the stop are ignored.
    p.inputs[0]?.frame();
    expect(p.f.providers[0]?.frames).toBe(0);
  });
});

describe("local session: stop", () => {
  it("stops the engines first, then the input, and ends the transcript", async () => {
    const p = local();
    const { input } = await startLive(p);
    await p.session.stop("operator");
    expect(input.stopped).toBe(true);
    expect(p.f.providers[0]?.stopCalls).toEqual([undefined]);
    expect(p.markers().at(-1)).toMatchObject({ type: "stop", reason: "operator" });
  });

  it("does not wait more than 5 s for an input that hangs, nor fail on one that errors", async () => {
    const hang = local();
    const { input } = await startLive(hang);
    input.stopBehaviour = "hang";
    const stopping = hang.session.stop("operator");
    await vi.advanceTimersByTimeAsync(4999);
    expect(hang.session.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(hang.session.stopped).toBe(true);

    const failing = local();
    const started = await startLive(failing);
    started.input.stopBehaviour = "reject";
    await failing.session.stop("operator");
    expect(failing.session.stopped).toBe(true);
  });
});
