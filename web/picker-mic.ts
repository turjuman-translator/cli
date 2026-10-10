// Microphone helpers for the picker (GET /): list input devices by label (the caption page's
// `mic=` matches labels, see web/shared/mic.ts) and a "Test my microphone" level meter. The
// test only runs while the user asks for it and always releases the device afterwards.
import type { MsgKey } from "./shared/app-i18n.js";
import type { Channel } from "./shared/params.js";

export function micCapable(): boolean {
  return (
    window.isSecureContext &&
    "mediaDevices" in navigator &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/** The message key (web/shared/app-i18n.ts) for a getUserMedia / enumerateDevices failure. */
export function micErrorText(err: unknown): MsgKey {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "mic.blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "mic.notFound";
  if (name === "NotReadableError" || name === "AbortError") return "mic.busy";
  return "mic.unavailable";
}

function inputLabels(devices: MediaDeviceInfo[]): string[] {
  const labels: string[] = [];
  for (const d of devices) {
    // Skip Chrome's "default"/"communications" aliases: "Default microphone" covers them.
    if (d.kind !== "audioinput" || !d.label) continue;
    if (d.deviceId === "default" || d.deviceId === "communications") continue;
    if (!labels.includes(d.label)) labels.push(d.label);
  }
  return labels;
}

/** Device labels without asking: only filled once permission was granted before. */
export async function knownMicLabels(): Promise<string[]> {
  if (!micCapable() || typeof navigator.mediaDevices.enumerateDevices !== "function") return [];
  try {
    return inputLabels(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return [];
  }
}

/** Ask for permission (labels are hidden before that), list the inputs, release the device. */
export async function requestMicLabels(): Promise<string[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    return inputLabels(await navigator.mediaDevices.enumerateDevices());
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

export interface MicTestOptions {
  /** Part of a device label (as `mic=`), or "" for the default device. */
  mic: string;
  dsp: boolean;
  ch: Channel;
}

export type MicTestState =
  | { kind: "starting" }
  | { kind: "listening" }
  | { kind: "heard" }
  | { kind: "quiet" }
  /** `message` is a message key of web/shared/app-i18n.ts. */
  | { kind: "error"; message: MsgKey };

export interface MicTestCallbacks {
  /** 0…1, smoothed, about 60×/s. */
  onLevel(level: number): void;
  onState(state: MicTestState): void;
  /** Device labels became readable (permission granted). */
  onLabels(labels: string[]): void;
}

const HEARD_DBFS = -46;
const HEARD_MS = 250;
const QUIET_AFTER_MS = 7000;

export class MicTester {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private seq = 0;
  /** The run that may still report (0 = stopped). */
  private run = 0;

  constructor(private readonly cb: MicTestCallbacks) {}

  get active(): boolean {
    return this.run > 0 && this.stream !== null;
  }

  async start(opts: MicTestOptions): Promise<void> {
    this.stop();
    this.seq += 1;
    const run = this.seq;
    this.run = run;
    this.cb.onState({ kind: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(this.constraints(opts, null));
      const labels = inputLabels(await navigator.mediaDevices.enumerateDevices());
      if (run !== this.run) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.cb.onLabels(labels);
      if (opts.mic) {
        const wanted = opts.mic.toLowerCase();
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find(
          (d) => d.kind === "audioinput" && d.label.toLowerCase().includes(wanted),
        );
        const current = stream.getAudioTracks()[0]?.getSettings().deviceId;
        if (match?.deviceId && match.deviceId !== current) {
          for (const t of stream.getTracks()) t.stop();
          stream = await navigator.mediaDevices.getUserMedia(
            this.constraints(opts, match.deviceId),
          );
        }
      }
    } catch (err) {
      if (run === this.run) {
        this.run = 0;
        this.cb.onState({ kind: "error", message: micErrorText(err) });
      }
      return;
    }
    if (run !== this.run) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(analyser);
      analyser.connect(mute);
      mute.connect(ctx.destination);
      if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
      this.loop(run, analyser);
      this.cb.onState({ kind: "listening" });
    } catch (err) {
      this.stop();
      this.cb.onState({ kind: "error", message: micErrorText(err) });
    }
  }

  stop(): void {
    this.run = 0;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }

  private constraints(opts: MicTestOptions, deviceId: string | null): MediaStreamConstraints {
    const audio: MediaTrackConstraints = {
      channelCount: opts.ch === "mix" ? 1 : 2,
      echoCancellation: opts.dsp,
      noiseSuppression: opts.dsp,
      autoGainControl: opts.dsp,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio, video: false };
  }

  private loop(run: number, analyser: AnalyserNode): void {
    const buf = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let last = started;
    let loudMs = 0;
    let level = 0;
    let state: "listening" | "heard" | "quiet" = "listening";
    const tick = (now: number): void => {
      if (run !== this.run) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -120;
      // -60 dBFS (silence) … -12 dBFS (loud speech) → 0…1; fast attack, slow release.
      const target = Math.min(1, Math.max(0, (db + 60) / 48));
      level = target > level ? target : level * 0.9 + target * 0.1;
      this.cb.onLevel(level);
      const dt = Math.min(100, now - last);
      last = now;
      if (db > HEARD_DBFS) loudMs += dt;
      if (state !== "heard" && loudMs >= HEARD_MS) {
        state = "heard";
        this.cb.onState({ kind: "heard" });
      } else if (state === "listening" && now - started > QUIET_AFTER_MS) {
        state = "quiet";
        this.cb.onState({ kind: "quiet" });
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
