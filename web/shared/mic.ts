// Microphone capture for the caption page: getUserMedia with ch/dsp constraints, `mic=` label
// matching, AudioContext at 16 kHz (or the native rate + resampling in the worklet when the browser
// refuses, e.g. Firefox), and self-healing retries every 5 s.
import type { Channel } from "./params.js";

export interface MicOptions {
  mic: string | null;
  ch: Channel;
  dsp: boolean;
  /** Skip the 16 kHz context (tests the resampling path that Firefox needs). */
  nativeRate?: boolean;
}

export interface MicFrame {
  samples: Int16Array;
  rmsDbfs: number;
  peakDbfs: number;
}

export type MicProblem =
  | { kind: "insecure" }
  | { kind: "denied"; detail: string }
  | { kind: "notfound"; detail: string }
  | { kind: "busy"; detail: string }
  | { kind: "suspended" }
  | { kind: "other"; detail: string };

export interface MicCallbacks {
  onFrame(frame: MicFrame): void;
  onRunning(info: { label: string; sampleRate: number; resampling: boolean }): void;
  onProblem(problem: MicProblem, retryInMs: number | null): void;
  onWarning(text: string | null): void;
}

const RETRY_MS = 5_000;
const DENIED_RETRY_MS = 15_000;

interface WorkletFrameMessage {
  pcm: ArrayBuffer;
  rms: number;
  peak: number;
}

function isFrameMessage(v: unknown): v is WorkletFrameMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return m.pcm instanceof ArrayBuffer && typeof m.rms === "number" && typeof m.peak === "number";
}

function errorName(err: unknown): string {
  return err instanceof DOMException || err instanceof Error ? err.name : "";
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export class MicCapture {
  label: string | null = null;
  sampleRate: number | null = null;
  resampling = false;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private stopped = true;
  /** Counts stop() calls: an attempt that sees it change was stopped while it was opening. */
  private epoch = 0;
  private unmatched = false;
  private lastProblem: MicProblem["kind"] | null = null;

  constructor(
    private readonly opts: MicOptions,
    private readonly cb: MicCallbacks,
  ) {}

  get running(): boolean {
    return this.node !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.cb.onProblem({ kind: "insecure" }, null);
      return;
    }
    navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    void this.attempt();
  }

  stop(): void {
    this.stopped = true;
    this.epoch++;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    navigator.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange);
    this.teardown();
  }

  /** Resume a suspended AudioContext (needs a user gesture in some browsers). */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        // still suspended
      }
    }
    if (this.ctx?.state === "running" && this.lastProblem === "suspended") {
      this.lastProblem = null;
      this.cb.onRunning({
        label: this.label ?? "Default microphone",
        sampleRate: this.ctx.sampleRate,
        resampling: this.resampling,
      });
    }
  }

  /** Listening only while started (start() adds it, stop() removes it). */
  private readonly onDeviceChange = (): void => {
    // A device appeared: retry now if we're waiting for one, or if `mic=` didn't match before.
    if (!this.running || this.unmatched) this.retryNow();
  };

  private retryNow(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.starting) {
      this.teardown();
      void this.attempt();
    }
  }

  /** Only called while started and without a pending retry: after a failed attempt or an
   *  unplugged microphone (stop() clears the timer). */
  private scheduleRetry(ms: number): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // An attempt still waiting for its audio context finishes first.
      if (this.starting) this.scheduleRetry(ms);
      else void this.attempt();
    }, ms);
  }

  private constraints(deviceId: string | null): MediaStreamConstraints {
    const audio: MediaTrackConstraints = {
      channelCount: this.opts.ch === "mix" ? 1 : 2,
      echoCancellation: this.opts.dsp,
      noiseSuppression: this.opts.dsp,
      autoGainControl: this.opts.dsp,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio, video: false };
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    const epoch = this.epoch;
    try {
      let stream = await navigator.mediaDevices.getUserMedia(this.constraints(null));
      this.unmatched = false;
      if (this.opts.mic) {
        const wanted = this.opts.mic.toLowerCase();
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "audioinput",
        );
        const match = inputs.find((d) => d.label.toLowerCase().includes(wanted));
        const current = stream.getAudioTracks()[0]?.getSettings().deviceId;
        if (match?.deviceId && match.deviceId !== current) {
          for (const t of stream.getTracks()) t.stop();
          stream = await navigator.mediaDevices.getUserMedia(this.constraints(match.deviceId));
          this.cb.onWarning(null);
        } else if (!match) {
          this.unmatched = true;
          const labels = inputs.map((d) => d.label || "(unnamed)").join(", ");
          this.cb.onWarning(
            `No microphone matches "${this.opts.mic}"; using the default. Available: ${labels || "none"}.`,
          );
        } else {
          this.cb.onWarning(null);
        }
      }
      if (this.epoch !== epoch) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      // Before the graph: it marks a context that stays suspended, which resume() then clears.
      this.lastProblem = null;
      await this.setupGraph(stream, epoch);
    } catch (err) {
      // A failure after stop() is not a problem of the microphone in use.
      if (this.epoch !== epoch) return;
      this.teardown();
      this.report(err);
    } finally {
      this.starting = false;
      // Stopped and started again while this attempt was opening: open the microphone afresh.
      if (!this.stopped && this.epoch !== epoch) void this.attempt();
    }
  }

  private report(err: unknown): void {
    const name = errorName(err);
    const detail = errorText(err);
    let problem: MicProblem;
    let retry: number;
    if (
      name === "NotAllowedError" ||
      name === "SecurityError" ||
      name === "PermissionDeniedError"
    ) {
      problem = { kind: "denied", detail };
      retry = DENIED_RETRY_MS;
    } else if (
      name === "NotFoundError" ||
      name === "OverconstrainedError" ||
      name === "DevicesNotFoundError"
    ) {
      problem = { kind: "notfound", detail };
      retry = RETRY_MS;
    } else if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
      problem = { kind: "busy", detail };
      retry = RETRY_MS;
    } else {
      problem = { kind: "other", detail };
      retry = RETRY_MS;
    }
    this.lastProblem = problem.kind;
    this.cb.onProblem(problem, retry);
    this.scheduleRetry(retry);
  }

  private async setupGraph(stream: MediaStream, epoch: number): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new DOMException("no audio track", "NotFoundError");
    this.stream = stream;
    const settings = track.getSettings();
    let ch = this.opts.ch;
    if (ch !== "mix" && settings.channelCount === 1) {
      this.cb.onWarning(`This microphone is mono; ch=${ch} ignored.`);
      ch = "mix";
    }

    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode;
    try {
      if (this.opts.nativeRate) throw new Error("native rate requested");
      ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule(__WORKLET_URL__);
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // Firefox can't connect a mic to a context at another rate: native rate + resampling.
      if (ctx) void ctx.close().catch(() => undefined);
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule(__WORKLET_URL__);
      source = ctx.createMediaStreamSource(stream);
    }
    if (this.epoch !== epoch) {
      // stop() ran while the context started: its teardown never saw this context.
      void ctx.close().catch(() => undefined);
      return;
    }
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.resampling = ctx.sampleRate !== 16000;

    const options: AudioWorkletNodeOptions = {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ch },
    };
    if (ch !== "mix") {
      // Pick one channel of a stereo interface: keep both channels as they are.
      options.channelCount = 2;
      options.channelCountMode = "explicit";
      options.channelInterpretation = "discrete";
    }
    const node = new AudioWorkletNode(ctx, "capture-processor", options);
    node.port.onmessage = (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (!isFrameMessage(data)) return;
      this.cb.onFrame({
        samples: new Int16Array(data.pcm),
        rmsDbfs: data.rms,
        peakDbfs: data.peak,
      });
    };
    source.connect(node);
    // The node outputs silence; connecting it keeps it pulled by the graph in every browser.
    node.connect(ctx.destination);
    this.node = node;

    track.addEventListener("ended", () => {
      if (this.stopped || this.stream !== stream) return;
      this.teardown();
      this.cb.onProblem({ kind: "notfound", detail: "The microphone was disconnected." }, RETRY_MS);
      this.scheduleRetry(1000);
    });

    this.label = track.label || "Default microphone";
    if (ctx.state !== "running") {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]).catch(
        () => undefined,
      );
      // Stopped or unplugged meanwhile: the teardown gave everything back (and an unplug retries).
      if (this.node !== node) return;
    }
    this.cb.onRunning({
      label: this.label,
      sampleRate: ctx.sampleRate,
      resampling: this.resampling,
    });
    if (ctx.state !== "running") {
      this.lastProblem = "suspended";
      this.cb.onProblem({ kind: "suspended" }, null);
    }
  }

  private teardown(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      try {
        this.node.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.node = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}
