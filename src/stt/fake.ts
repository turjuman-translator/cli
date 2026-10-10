// FakeProvider: replays a provider.jsonl through the recording
// provider's pure replay mapper with the original timing (÷ speed). No network, no audio use.
// Faster than real time, the session sends less audio than the recording heard: token times and
// reconnect positions are divided by the speed too, so they stay positions in the audio this
// session sent (else segment times run ahead of the session and latencies come out negative).
import type { TrackId } from "../shared/protocol.js";
import {
  type Recording,
  type RecordingMeta,
  readRecording,
  readRecordingMeta,
} from "./recording.js";
import { targetLanguageFromConfig } from "./soniox-protocol.js";
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderState,
  ReplayMapper,
  ReplayMapperFactory,
  SttProvider,
  Token,
} from "./types.js";

const FRAME_MS = 100;

export interface FakeProviderOptions {
  /** provider.jsonl to replay. */
  file: string;
  track: TrackId;
  /** Replay speed factor (default 1). Infinity replays synchronously inside start(). */
  speed?: number;
  /** Start over at the end, announced with `reconnected` (not allowed with speed Infinity). */
  loop?: boolean;
  /** Start the replay clock at the first sendAudio instead of at start(). */
  startOnFirstAudio?: boolean;
  /** Replay mappers by recording `meta.provider`, e.g. { soniox: sonioxReplayMapper }. */
  mappers: Record<string, ReplayMapperFactory>;
  /** Default: replayCapabilities(meta) of the recording. */
  capabilities?: ProviderCapabilities;
  /** Clock for receivedAt and scheduling (must advance with the timers). Default Date.now. */
  now?: () => number;
}

/** Capabilities a recording implies (Soniox: provider timing; others: arrival timing). */
export function replayCapabilities(meta: RecordingMeta): ProviderCapabilities {
  if (meta.provider === "soniox") {
    return {
      nativeTranslation: targetLanguageFromConfig(meta.config) !== null,
      timing: "provider",
      translationFinalAtEndpoint: false,
    };
  }
  return { nativeTranslation: false, timing: "arrival", translationFinalAtEndpoint: false };
}

/** The recording being replayed and the mapper factory of its provider. */
interface Replay {
  recording: Recording;
  factory: ReplayMapperFactory;
}

/**
 * Input-audio length a recording covers up to its last line at `lastT` (real-time audio assumed
 * after each session start), rounded up to whole frames: where the next loop's audio starts.
 */
function loopAudioMs(rec: Recording, lastT: number): number {
  let end = lastT;
  for (const l of rec.lines) {
    if (l.kind === "session") end = Math.max(end, l.audioOffsetMs + (lastT - l.t));
  }
  return (Math.floor(end / FRAME_MS) + 1) * FRAME_MS;
}

/**
 * SttProvider that replays a recording. Events go through the same mapper the live provider's
 * recording implies; `receivedAt` is the replay time. Frames and finalize calls are only
 * counted (`framesReceived`, `finalizeCalls`) for page/lifecycle tests.
 */
export class FakeProvider implements SttProvider {
  readonly track: TrackId;
  readonly capabilities: ProviderCapabilities;

  private readonly opts: FakeProviderOptions;
  private readonly speed: number;
  private readonly now: () => number;
  private _state: ProviderState = "idle";
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private replay: Replay | null = null;
  private cursor = 0;
  private loopStartedAt = 0;
  private loopOffsetMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private replayBegun = false;
  private active = false;
  private done = false;
  private doneWaiters: Array<() => void> = [];
  private frames = 0;
  private finalizes = 0;

  constructor(opts: FakeProviderOptions) {
    const speed = opts.speed ?? 1;
    if (!(speed > 0)) throw new Error(`FakeProvider: speed must be > 0 (got ${speed})`);
    if (opts.loop === true && speed === Number.POSITIVE_INFINITY) {
      throw new Error("FakeProvider: loop needs a finite speed");
    }
    this.opts = opts;
    this.speed = speed;
    this.track = opts.track;
    this.now = opts.now ?? Date.now;
    this.capabilities = opts.capabilities ?? replayCapabilities(readRecordingMeta(opts.file));
  }

  get state(): ProviderState {
    return this._state;
  }

  /** Frames passed to sendAudio. */
  get framesReceived(): number {
    return this.frames;
  }

  /** finalize() calls. */
  get finalizeCalls(): number {
    return this.finalizes;
  }

  async start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    if (this._state !== "idle") throw new Error("FakeProvider: already started");
    const recording = readRecording(this.opts.file);
    const factory = this.opts.mappers[recording.meta.provider];
    if (factory === undefined) {
      throw new Error(`FakeProvider: no replay mapper for provider "${recording.meta.provider}"`);
    }
    this.onEvent = opts.onEvent;
    this.replay = { recording, factory };
    this.replayBegun = false;
    this.done = false;
    this.setState("connecting");
    this.setState("live");
    if (this.opts.startOnFirstAudio !== true || this.frames > 0) this.beginReplay();
  }

  sendAudio(_frame: Uint8Array): void {
    this.frames++;
    if (this.opts.startOnFirstAudio === true && this._state === "live") this.beginReplay();
  }

  finalize(): void {
    this.finalizes++;
  }

  async stop(_opts?: { fast?: boolean }): Promise<void> {
    this.active = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.setState("idle");
    this.markDone();
  }

  /** Resolves when the replay has reached its end (never with loop) or stop() was called. */
  whenDone(): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise<void>((resolve) => this.doneWaiters.push(resolve));
  }

  private beginReplay(): void {
    const replay = this.replay;
    if (this.replayBegun || replay === null) return;
    this.replayBegun = true;
    this.active = true;
    this.loopOffsetMs = 0;
    this.startLoop(replay, false);
  }

  private startLoop(replay: Replay, announce: boolean): void {
    this.timer = null;
    this.cursor = 0;
    const mapper = replay.factory(replay.recording.meta);
    this.loopStartedAt = this.now();
    if (announce) {
      this.emit({ type: "reconnected", gapMs: 0, audioOffsetMs: this.position(this.loopOffsetMs) });
    }
    this.pump(replay, mapper);
  }

  /** Plays every line that is due; a consumer's stop() (inside onEvent) ends the loop. */
  private pump(replay: Replay, mapper: ReplayMapper): void {
    this.timer = null;
    const elapsed =
      this.speed === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : (this.now() - this.loopStartedAt) * this.speed;
    while (this.active) {
      const line = replay.recording.lines[this.cursor];
      if (line === undefined) {
        this.endOfRecording(replay);
        return;
      }
      if (line.t > elapsed) {
        this.timer = setTimeout(() => this.pump(replay, mapper), (line.t - elapsed) / this.speed);
        return;
      }
      this.cursor++;
      for (const e of mapper.onLine(line)) this.emit(this.adjust(e));
    }
  }

  /** Replay clock for receivedAt; audio positions at the replay's speed, after the loops. */
  private adjust(e: ProviderEvent): ProviderEvent {
    if (e.type === "tokens") {
      const at = (t: Token): Token => ({
        ...t,
        ...(t.startMs === undefined ? {} : { startMs: this.position(t.startMs) }),
        ...(t.endMs === undefined ? {} : { endMs: this.position(t.endMs) }),
      });
      return { ...e, final: e.final.map(at), nonFinal: e.nonFinal.map(at), receivedAt: this.now() };
    }
    if (e.type === "endpoint") return { ...e, receivedAt: this.now() };
    if (e.type === "reconnected") {
      return { ...e, audioOffsetMs: this.position(e.audioOffsetMs + this.loopOffsetMs) };
    }
    return e;
  }

  /** A position in the recording's audio → in the audio sent at this speed (whole ms). With
   *  infinite speed no audio is sent at all: the recording's positions stay. */
  private position(ms: number): number {
    return this.speed === Number.POSITIVE_INFINITY ? ms : Math.round(ms / this.speed);
  }

  private endOfRecording(replay: Replay): void {
    const last = replay.recording.lines.at(-1);
    if (this.opts.loop === true && last !== undefined) {
      // Next loop = a new provider session positioned after this loop's input audio.
      this.loopOffsetMs += loopAudioMs(replay.recording, last.t);
      this.timer = setTimeout(() => this.startLoop(replay, true), FRAME_MS / this.speed);
      return;
    }
    this.active = false;
    this.markDone();
  }

  private markDone(): void {
    this.done = true;
    const waiters = this.doneWaiters;
    this.doneWaiters = [];
    for (const w of waiters) w();
  }

  private setState(state: ProviderState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit({ type: "state", state });
  }

  private emit(e: ProviderEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      // A throwing consumer must not break the replay (the live provider logs and continues).
    }
  }
}
