// @vitest-environment happy-dom
// Microphone capture of the caption page (web/shared/mic.ts): constraints, `mic=` label matching,
// the 16 kHz context or the native rate with resampling, frames from the worklet, and the readable
// problems that heal by themselves (denied, missing, busy, unplugged, suspended).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MicCallbacks, MicCapture, type MicOptions } from "../../web/shared/mic.js";
import { settle } from "./helpers/web-shared-fakes.js";
import {
  FakeAudioContext,
  type FakeMediaDevices,
  FakeWorkletNode,
  installMedia,
  uninstallMedia,
  WORKLET_URL,
  workletFrame,
} from "./helpers/web-shared-media.js";

let devices: FakeMediaDevices;

beforeEach(() => {
  vi.useFakeTimers();
  devices = installMedia();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  uninstallMedia();
});

function callbacks() {
  return {
    onFrame: vi.fn<MicCallbacks["onFrame"]>(),
    onRunning: vi.fn<MicCallbacks["onRunning"]>(),
    onProblem: vi.fn<MicCallbacks["onProblem"]>(),
    onWarning: vi.fn<MicCallbacks["onWarning"]>(),
  };
}

async function started(opts: Partial<MicOptions> = {}) {
  const cb = callbacks();
  const mic = new MicCapture({ mic: null, ch: "mix", dsp: false, ...opts }, cb);
  mic.start();
  await settle();
  return { mic, cb };
}

describe("opening the microphone", () => {
  it("needs a secure context", async () => {
    vi.stubGlobal("isSecureContext", false);
    const { mic, cb } = await started();
    expect(cb.onProblem).toHaveBeenCalledWith({ kind: "insecure" }, null);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(mic.running).toBe(false);
  });

  it("needs getUserMedia", async () => {
    installMedia({ mediaDevices: false });
    const { cb } = await started();
    expect(cb.onProblem).toHaveBeenCalledWith({ kind: "insecure" }, null);
    // stop() copes without mediaDevices too.
  });

  it("asks for a raw mono microphone and runs a 16 kHz capture graph", async () => {
    const { mic, cb } = await started();
    expect(devices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const ctx = FakeAudioContext.last();
    expect(ctx.sampleRate).toBe(16000);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(WORKLET_URL);
    const node = FakeWorkletNode.last();
    expect(node.name).toBe("capture-processor");
    expect(node.options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ch: "mix" },
    });
    expect(ctx.sources[0]?.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(ctx.destination);
    expect(cb.onRunning).toHaveBeenCalledWith({
      label: "Built-in Microphone",
      sampleRate: 16000,
      resampling: false,
    });
    expect(mic.running).toBe(true);
    expect(mic.label).toBe("Built-in Microphone");
    expect(mic.sampleRate).toBe(16000);
    expect(mic.resampling).toBe(false);
    expect(cb.onProblem).not.toHaveBeenCalled();
  });

  it("starts once", async () => {
    const { mic } = await started();
    mic.start();
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("names an unnamed microphone", async () => {
    devices.devices = [{ deviceId: "default", kind: "audioinput", label: "" }];
    const { mic, cb } = await started();
    expect(mic.label).toBe("Default microphone");
    expect(cb.onRunning).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Default microphone" }),
    );
  });

  it("turns the browser's voice processing on with dsp=1", async () => {
    await started({ dsp: true });
    expect(devices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  });

  it("picks one channel of a stereo interface", async () => {
    devices.channelCount = 2;
    const { cb } = await started({ ch: "left" });
    expect(devices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ channelCount: 2 }) }),
    );
    expect(FakeWorkletNode.last().options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ch: "left" },
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    expect(cb.onWarning).not.toHaveBeenCalled();
  });

  it("ignores ch= on a mono microphone, with a warning", async () => {
    devices.channelCount = 1;
    const { cb } = await started({ ch: "right" });
    expect(cb.onWarning).toHaveBeenCalledWith("This microphone is mono; ch=right ignored.");
    expect(FakeWorkletNode.last().options.processorOptions).toEqual({ ch: "mix" });
    expect(FakeWorkletNode.last().options.channelCount).toBeUndefined();
  });

  it("runs at the native rate and resamples where 16 kHz can't take a microphone (Firefox)", async () => {
    FakeAudioContext.refuseOtherRate = true;
    FakeAudioContext.closeRejects = true;
    const { mic, cb } = await started();
    const [first, second] = FakeAudioContext.all;
    expect(first?.sampleRate).toBe(16000);
    expect(first?.close).toHaveBeenCalled();
    expect(second?.sampleRate).toBe(48000);
    expect(second?.audioWorklet.addModule).toHaveBeenCalledWith(WORKLET_URL);
    expect(mic.resampling).toBe(true);
    expect(cb.onRunning).toHaveBeenCalledWith({
      label: "Built-in Microphone",
      sampleRate: 48000,
      resampling: true,
    });
  });

  it("skips the 16 kHz context with rate=native", async () => {
    const { mic } = await started({ nativeRate: true });
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(FakeAudioContext.last().sampleRate).toBe(48000);
    expect(mic.resampling).toBe(true);
  });

  it("passes the worklet's frames on and ignores anything else", async () => {
    const { cb } = await started();
    const node = FakeWorkletNode.last();
    const f = workletFrame(123, -31.5, -12);
    node.post(f);
    expect(cb.onFrame).toHaveBeenCalledTimes(1);
    const frame = cb.onFrame.mock.calls[0]?.[0];
    expect(frame?.samples).toHaveLength(1600);
    expect(frame?.samples[0]).toBe(123);
    expect(frame?.rmsDbfs).toBe(-31.5);
    expect(frame?.peakDbfs).toBe(-12);
    for (const junk of [
      null,
      "x",
      { pcm: "no" },
      { pcm: new ArrayBuffer(2), rms: "1", peak: 0 },
      { pcm: new ArrayBuffer(2), rms: 1 },
    ]) {
      node.post(junk);
    }
    expect(cb.onFrame).toHaveBeenCalledTimes(1);
  });
});

describe("choosing a microphone by name (mic=)", () => {
  beforeEach(() => {
    devices.devices = [
      { deviceId: "default", kind: "audioinput", label: "Built-in Microphone" },
      { deviceId: "usb-1", kind: "audioinput", label: "Focusrite USB Audio" },
      { deviceId: "cam", kind: "videoinput", label: "USB Camera" },
    ];
  });

  it("re-opens the matching device (case-insensitive)", async () => {
    const { mic, cb } = await started({ mic: "focusrite" });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(devices.getUserMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ deviceId: { exact: "usb-1" } }),
      }),
    );
    expect(devices.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(cb.onWarning).toHaveBeenCalledWith(null);
    expect(mic.label).toBe("Focusrite USB Audio");
  });

  it("keeps the default stream when it already is the matching device", async () => {
    const { cb } = await started({ mic: "built-in" });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(cb.onWarning).toHaveBeenCalledWith(null);
  });

  it("uses the default with a warning that lists the microphones when nothing matches", async () => {
    devices.devices.push({ deviceId: "x", kind: "audioinput", label: "" });
    const { mic, cb } = await started({ mic: "Shure" });
    expect(cb.onWarning).toHaveBeenCalledWith(
      'No microphone matches "Shure"; using the default. Available: Built-in Microphone, Focusrite USB Audio, (unnamed).',
    );
    expect(mic.running).toBe(true);
  });

  it("says none are available when the browser lists no microphones", async () => {
    devices.devices = [];
    const { cb } = await started({ mic: "Shure" });
    expect(cb.onWarning).toHaveBeenCalledWith(
      'No microphone matches "Shure"; using the default. Available: none.',
    );
  });

  it("tries again when a device is plugged in after no match", async () => {
    const { cb } = await started({ mic: "Shure" });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    devices.devices.push({ deviceId: "shure", kind: "audioinput", label: "Shure MV7" });
    devices.dispatchEvent(new Event("devicechange"));
    await settle();
    expect(devices.getUserMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: "shure" } }) }),
    );
    expect(cb.onWarning).toHaveBeenLastCalledWith(null);
    // The first graph was torn down before the new one.
    expect(FakeAudioContext.all[0]?.close).toHaveBeenCalled();
  });

  it("does nothing on a device change while the right microphone runs", async () => {
    await started({ mic: "focusrite" });
    devices.dispatchEvent(new Event("devicechange"));
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
  });
});

describe("problems", () => {
  it.each([
    ["NotAllowedError", "denied", 15_000],
    ["SecurityError", "denied", 15_000],
    ["PermissionDeniedError", "denied", 15_000],
    ["NotFoundError", "notfound", 5_000],
    ["OverconstrainedError", "notfound", 5_000],
    ["DevicesNotFoundError", "notfound", 5_000],
    ["NotReadableError", "busy", 5_000],
    ["AbortError", "busy", 5_000],
    ["TrackStartError", "busy", 5_000],
    ["WeirdError", "other", 5_000],
  ])("%s is %s and retried after %i ms", async (name, kind, retry) => {
    devices.failures.push(new DOMException("it failed", name));
    const { mic, cb } = await started();
    expect(cb.onProblem).toHaveBeenCalledWith({ kind, detail: `${name}: it failed` }, retry);
    expect(mic.running).toBe(false);
    vi.advanceTimersByTime(retry - 1);
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(mic.running).toBe(true);
  });

  it("describes plain errors and thrown values", async () => {
    devices.failures.push(new TypeError("bad constraint"), "just a string");
    const { cb } = await started();
    expect(cb.onProblem).toHaveBeenLastCalledWith(
      { kind: "other", detail: "TypeError: bad constraint" },
      5_000,
    );
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(cb.onProblem).toHaveBeenLastCalledWith(
      { kind: "other", detail: "just a string" },
      5_000,
    );
  });

  it("reports a stream without an audio track as a missing microphone", async () => {
    devices.getUserMedia.mockImplementationOnce(
      async () =>
        ({
          getAudioTracks: () => [],
          getTracks: () => [],
        }) as unknown as MediaStream,
    );
    const { cb } = await started();
    expect(cb.onProblem).toHaveBeenCalledWith(
      { kind: "notfound", detail: "NotFoundError: no audio track" },
      5_000,
    );
  });

  it("retries at once when a microphone is plugged in while none was found", async () => {
    devices.failures.push(new DOMException("none", "NotFoundError"));
    const { mic } = await started();
    expect(mic.running).toBe(false);
    devices.dispatchEvent(new Event("devicechange"));
    await settle();
    expect(mic.running).toBe(true);
    // The pending retry was cancelled.
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not start a second attempt while one is still opening", async () => {
    devices.hold = true;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    devices.dispatchEvent(new Event("devicechange"));
    devices.hold = false;
    devices.release();
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(mic.running).toBe(true);
  });

  it("reopens a microphone that was unplugged", async () => {
    const { mic, cb } = await started();
    const ctx = FakeAudioContext.last();
    const node = FakeWorkletNode.last();
    devices.lastTrack().end();
    expect(mic.running).toBe(false);
    expect(node.port.onmessage).toBeNull();
    expect(node.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
    expect(cb.onProblem).toHaveBeenCalledWith(
      { kind: "notfound", detail: "The microphone was disconnected." },
      5_000,
    );
    vi.advanceTimersByTime(1000);
    await settle();
    expect(mic.running).toBe(true);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("reopens a microphone unplugged while its context was still starting", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    devices.lastTrack().end();
    expect(cb.onProblem).toHaveBeenCalledWith(
      { kind: "notfound", detail: "The microphone was disconnected." },
      5_000,
    );
    // The retry (after 1 s) waits for the attempt that is still waiting for its context.
    await vi.advanceTimersByTimeAsync(1500);
    expect(cb.onRunning).not.toHaveBeenCalled();
    expect(cb.onProblem).not.toHaveBeenCalledWith({ kind: "suspended" }, null);
    FakeAudioContext.startState = "running";
    await vi.advanceTimersByTimeAsync(1000);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(mic.running).toBe(true);
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
  });

  it("ignores the end of a track it no longer uses", async () => {
    const { mic, cb } = await started();
    const old = devices.lastTrack();
    mic.stop();
    old.end();
    expect(cb.onProblem).not.toHaveBeenCalled();
    mic.start();
    await settle();
    old.end();
    expect(cb.onProblem).not.toHaveBeenCalled();
    expect(mic.running).toBe(true);
  });

  it("survives a node that is already disconnected", async () => {
    const { mic } = await started();
    FakeWorkletNode.last().disconnect.mockImplementation(() => {
      throw new Error("not connected");
    });
    expect(() => mic.stop()).not.toThrow();
  });
});

describe("a suspended audio context", () => {
  it("waits up to 1.5 s, then says audio is paused until a gesture resumes it", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    expect(cb.onRunning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
    expect(cb.onProblem).toHaveBeenCalledWith({ kind: "suspended" }, null);

    // A gesture without effect changes nothing (its resume() keeps waiting).
    const waiting = mic.resume();
    await settle();
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
    FakeAudioContext.resumeWorks = true;
    await mic.resume();
    await waiting;
    expect(FakeAudioContext.last().resume).toHaveBeenCalled();
    expect(cb.onRunning).toHaveBeenCalledTimes(2);
    expect(cb.onRunning).toHaveBeenLastCalledWith({
      label: "Built-in Microphone",
      sampleRate: 16000,
      resampling: false,
    });
    // Once running, another resume does nothing.
    await mic.resume();
    expect(cb.onRunning).toHaveBeenCalledTimes(2);
  });

  it("names the default microphone when it resumes without a label", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    devices.devices = [{ deviceId: "default", kind: "audioinput", label: "" }];
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await vi.advanceTimersByTimeAsync(1500);
    mic.label = null;
    FakeAudioContext.resumeWorks = true;
    await mic.resume();
    expect(cb.onRunning).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Default microphone" }),
    );
  });

  it("starts at once when resume succeeds during the start", async () => {
    FakeAudioContext.startState = "suspended";
    const { cb } = await started();
    expect(FakeAudioContext.last().resume).toHaveBeenCalled();
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
    expect(cb.onProblem).not.toHaveBeenCalled();
  });

  it("copes with a resume that rejects", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeRejects = true;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
    expect(cb.onProblem).toHaveBeenCalledWith({ kind: "suspended" }, null);
    await expect(mic.resume()).resolves.toBeUndefined();
  });

  it("does nothing on resume without a context", async () => {
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    await mic.resume();
    expect(cb.onRunning).not.toHaveBeenCalled();
  });
});

describe("stopping", () => {
  it("releases the microphone: tracks stopped, node disconnected, context closed", async () => {
    FakeAudioContext.closeRejects = true;
    const { mic } = await started();
    const track = devices.lastTrack();
    const ctx = FakeAudioContext.last();
    mic.stop();
    expect(track.stopped).toBe(true);
    expect(FakeWorkletNode.last().disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
    expect(mic.running).toBe(false);
    // Device changes no longer reopen it.
    devices.dispatchEvent(new Event("devicechange"));
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending retry", async () => {
    devices.failures.push(new DOMException("busy", "NotReadableError"));
    const { mic } = await started();
    mic.stop();
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("closes a stream that arrives after stop", async () => {
    devices.hold = true;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    mic.stop();
    devices.release();
    await settle();
    expect(devices.lastTrack().stopped).toBe(true);
    expect(FakeAudioContext.all).toHaveLength(0);
    expect(cb.onRunning).not.toHaveBeenCalled();
  });

  it("neither reports nor retries a failure that arrives after stop", async () => {
    devices.hold = true;
    devices.failures.push(new DOMException("denied", "NotAllowedError"));
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    mic.stop();
    devices.release();
    await settle();
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(cb.onProblem).not.toHaveBeenCalled();
  });

  it("opens afresh when stopped and started again while the worklet module loads", async () => {
    let loaded = (): void => undefined;
    FakeAudioContext.loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    const first = devices.lastTrack();
    mic.stop();
    mic.start();
    FakeAudioContext.loading = null;
    loaded();
    await settle();
    expect(first.stopped).toBe(true);
    expect(FakeAudioContext.all[0]?.close).toHaveBeenCalled();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(devices.lastTrack()).not.toBe(first);
    expect(devices.lastTrack().stopped).toBe(false);
    expect(mic.running).toBe(true);
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
  });

  it("opens afresh when stopped and started again while waiting for a suspended context", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    mic.stop();
    mic.start();
    FakeAudioContext.startState = "running";
    await vi.advanceTimersByTimeAsync(1500);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(devices.lastTrack().stopped).toBe(false);
    expect(mic.running).toBe(true);
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
  });

  it("opens afresh when stopped and started again before a failure arrives", async () => {
    devices.hold = true;
    devices.failures.push(new DOMException("busy", "NotReadableError"));
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    mic.stop();
    mic.start();
    devices.hold = false;
    devices.release();
    await settle();
    expect(cb.onProblem).not.toHaveBeenCalled();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(mic.running).toBe(true);
  });

  it("gives everything back when stopped while the worklet module loads", async () => {
    FakeAudioContext.closeRejects = true;
    let loaded = (): void => undefined;
    FakeAudioContext.loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    expect(FakeAudioContext.all).toHaveLength(1);
    mic.stop();
    loaded();
    await settle();
    expect(FakeAudioContext.last().close).toHaveBeenCalled();
    expect(FakeWorkletNode.all).toHaveLength(0);
    expect(devices.lastTrack().stopped).toBe(true);
    expect(cb.onRunning).not.toHaveBeenCalled();
    expect(mic.running).toBe(false);
  });

  it("gives everything back when stopped while waiting for a suspended context", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    mic.stop();
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeAudioContext.last().close).toHaveBeenCalled();
    expect(cb.onRunning).not.toHaveBeenCalled();
    expect(cb.onProblem).not.toHaveBeenCalled();
    expect(mic.running).toBe(false);
  });

  it("opens afresh when stopped and started again while getUserMedia is on its way", async () => {
    devices.hold = true;
    const cb = callbacks();
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, cb);
    mic.start();
    await settle();
    mic.stop();
    mic.start();
    await settle();
    devices.hold = false;
    devices.release();
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(devices.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(devices.lastTrack().stopped).toBe(false);
    expect(mic.running).toBe(true);
    expect(cb.onRunning).toHaveBeenCalledTimes(1);
  });

  it("can stop before it ever started, without mediaDevices", () => {
    installMedia({ mediaDevices: false });
    const mic = new MicCapture({ mic: null, ch: "mix", dsp: false }, callbacks());
    expect(() => mic.stop()).not.toThrow();
  });
});
