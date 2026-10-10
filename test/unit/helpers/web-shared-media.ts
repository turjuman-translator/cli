// Fake microphone and Web Audio for the happy-dom tests of the caption page (web/shared/mic.ts,
// web/caption.ts): getUserMedia with tracks the test can end, enumerateDevices, an AudioContext
// that may refuse 16 kHz (Firefox) or stay suspended, and the capture worklet node whose port the
// test feeds with frames.
import { vi } from "vitest";

export class FakeTrack extends EventTarget {
  stopped = false;
  constructor(
    readonly label: string,
    private readonly settings: MediaTrackSettings,
  ) {
    super();
  }
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
  stop(): void {
    this.stopped = true;
  }
  /** The device was unplugged. */
  end(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export interface FakeDevice {
  deviceId: string;
  kind: string;
  label: string;
}

/** navigator.mediaDevices: each getUserMedia answers with a track of the asked (or default) device. */
export class FakeMediaDevices extends EventTarget {
  devices: FakeDevice[] = [
    { deviceId: "default", kind: "audioinput", label: "Built-in Microphone" },
  ];
  /** Errors (or values) the next getUserMedia calls throw instead of answering. */
  readonly failures: unknown[] = [];
  channelCount = 1;
  /** When set, getUserMedia waits for `release()`. */
  hold = false;
  private waiting: Array<() => void> = [];
  readonly streams: FakeStream[] = [];
  readonly getUserMedia = vi.fn(async (c: MediaStreamConstraints): Promise<MediaStream> => {
    if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.failures.length > 0) throw this.failures.shift();
    const audio = typeof c.audio === "object" ? c.audio : {};
    const exact = audio.deviceId;
    const id =
      typeof exact === "object" && exact !== null && !Array.isArray(exact) && "exact" in exact
        ? String(exact.exact)
        : (this.devices[0]?.deviceId ?? "default");
    const device = this.devices.find((d) => d.deviceId === id);
    const track = new FakeTrack(device?.label ?? "", {
      deviceId: id,
      channelCount: this.channelCount,
    });
    const stream = new FakeStream([track]);
    this.streams.push(stream);
    return stream as unknown as MediaStream;
  });
  readonly enumerateDevices = vi.fn(async () => this.devices as unknown as MediaDeviceInfo[]);

  release(): void {
    const w = this.waiting;
    this.waiting = [];
    for (const resolve of w) resolve();
  }

  /** The tracks of the newest stream. */
  lastTrack(): FakeTrack {
    const t = this.streams.at(-1)?.tracks[0];
    if (!t) throw new Error("no stream yet");
    return t;
  }
}

export class FakeWorkletNode {
  static all: FakeWorkletNode[] = [];
  readonly port: { onmessage: ((ev: MessageEvent) => void) | null } = { onmessage: null };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  constructor(
    readonly context: FakeAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    FakeWorkletNode.all.push(this);
  }

  /** A frame from the capture worklet. */
  post(data: unknown): void {
    this.port.onmessage?.(new MessageEvent("message", { data }));
  }

  static last(): FakeWorkletNode {
    const n = FakeWorkletNode.all.at(-1);
    if (!n) throw new Error("no worklet node yet");
    return n;
  }
}

export class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  /** Firefox: a mic can't be connected to a context at another rate than the device's. */
  static refuseOtherRate = false;
  static nativeRate = 48_000;
  /** New contexts start in this state (autoplay policies keep them suspended). */
  static startState: AudioContextState = "running";
  /** resume() leaves a suspended context suspended (no user gesture yet). */
  static resumeWorks = true;
  static resumeRejects = false;
  static closeRejects = false;
  /** When set, addModule() waits for it (the worklet module is still loading). */
  static loading: Promise<void> | null = null;

  readonly sampleRate: number;
  state: AudioContextState;
  readonly destination = { kind: "destination" };
  readonly sources: Array<{ connect: ReturnType<typeof vi.fn> }> = [];
  readonly audioWorklet = {
    addModule: vi.fn(async (_url: string) => {
      if (FakeAudioContext.loading) await FakeAudioContext.loading;
    }),
  };
  readonly close = vi.fn(async () => {
    this.state = "closed";
    if (FakeAudioContext.closeRejects) throw new Error("already closed");
  });
  private pending: Array<() => void> = [];
  /** Like a browser: without a user gesture the promise waits until the context runs. */
  readonly resume = vi.fn(async (): Promise<void> => {
    if (FakeAudioContext.resumeRejects) throw new Error("no gesture");
    if (!FakeAudioContext.resumeWorks) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
      return;
    }
    this.state = "running";
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
  });

  constructor(opts?: AudioContextOptions) {
    this.sampleRate = opts?.sampleRate ?? FakeAudioContext.nativeRate;
    this.state = FakeAudioContext.startState;
    FakeAudioContext.all.push(this);
  }

  createMediaStreamSource(_stream: MediaStream): { connect: ReturnType<typeof vi.fn> } {
    if (FakeAudioContext.refuseOtherRate && this.sampleRate !== FakeAudioContext.nativeRate) {
      throw new DOMException("different sample-rate", "NotSupportedError");
    }
    const source = { connect: vi.fn() };
    this.sources.push(source);
    return source;
  }

  static reset(): void {
    FakeAudioContext.all = [];
    FakeAudioContext.refuseOtherRate = false;
    FakeAudioContext.nativeRate = 48_000;
    FakeAudioContext.startState = "running";
    FakeAudioContext.resumeWorks = true;
    FakeAudioContext.resumeRejects = false;
    FakeAudioContext.closeRejects = false;
    FakeAudioContext.loading = null;
  }

  static last(): FakeAudioContext {
    const c = FakeAudioContext.all.at(-1);
    if (!c) throw new Error("no AudioContext yet");
    return c;
  }
}

export const WORKLET_URL = "/assets/capture-worklet-test.js";

/** Install the fakes (a secure context with a microphone); returns the devices. */
export function installMedia(opts: { secure?: boolean; mediaDevices?: boolean } = {}) {
  FakeAudioContext.reset();
  FakeWorkletNode.all = [];
  const devices = new FakeMediaDevices();
  vi.stubGlobal("isSecureContext", opts.secure ?? true);
  Object.defineProperty(navigator, "mediaDevices", {
    value: opts.mediaDevices === false ? undefined : devices,
    configurable: true,
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("__WORKLET_URL__", WORKLET_URL);
  return devices;
}

export function uninstallMedia(): void {
  Reflect.deleteProperty(navigator, "mediaDevices");
}

/** A 100 ms worklet frame message (1,600 samples). */
export function workletFrame(value = 1000, rms = -30, peak = -20) {
  const pcm = new Int16Array(1600).fill(value).buffer;
  return { pcm, rms, peak };
}
