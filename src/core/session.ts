// One captioning session.
//
// Kinds:
//   page    audio + VAD events from a browser caption page. The engine opens lazily at the first
//           speech start, `finalize()`s at every speech end, stays open (provider keepalives)
//           for pages.closeAfterSilenceSec of silence, then closes; the next speech opens a new
//           engine instance. Engine-open time is reported through onUsage (what Soniox bills).
//   device  ffmpeg device / bridge input (AudioInputApi), with cost guards (silence, duration).
//   file    ffmpeg file replay; stops at the end of the file unless looping.
//
// Every session has one track (Soniox: speech recognition and its own translation) with its
// store, metrics, cost and transcript folder.
//
// Layouts: "blocks" runs fast blocks (FastBlocks): the track's segments, with
// Soniox's streaming translation, become caption blocks, and block/mode/listening messages go to
// subscribers. "rollup" shows the segments themselves.

import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { FastBlocks, passThroughFollower } from "../compose/fast-blocks.js";
import type { EventLabels, QuranFollowerApi } from "../compose/types.js";
import type { LoadedConfig, Secrets } from "../config.js";
import type { EventDetectorApi } from "../events/types.js";
import type { Glossary } from "../glossary.js";
import type {
  AudioState,
  Block,
  CaptionLayout,
  PrayerEvent,
  ServerMessage,
  SessionInfo,
  SessionKind,
  SessionState,
  SessionSummary,
  Status,
  TrackId,
} from "../shared/protocol.js";
import { EnergyVad, frameLevel, pcmBytesToSamples } from "../shared/vad.js";
import { Coalescer } from "./coalesce.js";
import type {
  AudioInputApi,
  AudioInputSpec,
  CaptionSessionApi,
  EngineFactory,
  SessionListener,
} from "./contracts.js";
import { type EngineInstance, Track, type TrackHooks } from "./track.js";
import { SessionTranscript } from "./transcripts.js";

/** The session's one track: Soniox. */
const TRACK: TrackId = "soniox";

/** Local Start: frames must arrive within this long (10 s when resuming after a restart). */
export const FIRST_FRAME_TIMEOUT_MS = 5000;
export const RESUME_FIRST_FRAME_TIMEOUT_MS = 10_000;
/** Local Start: wait this long for the provider to go live. */
export const PROVIDER_LIVE_TIMEOUT_MS = 10_000;
/** "No signal" after this long below audio.silenceWarnDbfs. */
export const NO_SIGNAL_MS = 10_000;
/** Page usage reports (engine-open ms) at this interval and at every engine close. */
export const USAGE_REPORT_MS = 10_000;
const TICK_MS = 1000;
const STATUS_INTERVAL_MS = 500;
const LEVEL_INTERVAL_MS = 200;
const PREBUFFER_FRAMES = 10;
const PREBUFFER_MAX_AGE_MS = 1500;
const RETRY_OPEN_MS = 2000;
const INPUT_STOP_TIMEOUT_MS = 5000;

/** Blocks sent in a snapshot: the last 200, with `hasMore` for older ones. */
export const SNAPSHOT_BLOCKS = 200;
const DRAIN_MS = 5000;
const DRAIN_FAST_MS = 1000;
const ENGLISH_LABELS: EventLabels = {
  athan: { ar: "الأذان", title: "Athan", subtitle: "Call to prayer" },
  iqama: { ar: "الإقامة", title: "Iqama", subtitle: "The prayer begins" },
  salah: { ar: "الصلاة", title: "Prayer", subtitle: "" },
};

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 8 random base32 characters (40 bits). */
export function newSessionId(): string {
  const bytes = randomBytes(5);
  let out = "";
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "a";
      bits -= 5;
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PageOptions {
  keyId: string | null;
  keyLabel: string | null;
  client: { obs: boolean; ua: string };
  onUsage?: (engine: TrackId, ms: number) => void;
}

export interface LocalOptions {
  spec: AudioInputSpec;
  inputFactory: (spec: AudioInputSpec) => AudioInputApi;
}

/** Blocks layout: what fast blocks need. */
export interface SessionBlocksOptions {
  /** The Quran follower (default: words only, no Quran). */
  followerFactory?: (targetLang: string) => QuranFollowerApi;
  detector: EventDetectorApi | null;
}

export interface CaptionSessionOptions {
  /** Pre-generated id; default: a new one. */
  id?: string;
  kind: SessionKind;
  loaded: LoadedConfig;
  engineFactory: EngineFactory;
  log: Logger;
  now?: () => number;
  from: string;
  to: string;
  glossary: Glossary | null;
  /** Write a transcripts folder (page sessions: pages.savePageSessions). */
  saveTranscripts: boolean;
  /** The organisation's API keys, read at every engine start; default .env. */
  secrets?: () => Secrets;
  /** The organisation the session belongs to (written in session.jsonl for the archive). */
  orgId?: string;
  page?: PageOptions;
  local?: LocalOptions;
  /** Requested layout (default "rollup"); "blocks" needs `blocks`. */
  layout?: CaptionLayout;
  blocks?: SessionBlocksOptions | null;
  /** Called once when the session has stopped (registry cleanup). */
  onStopped?: (session: CaptionSession) => void;
}

type Lifecycle = "starting" | "live" | "stopping" | "stopped";

export class CaptionSession implements CaptionSessionApi {
  readonly id: string;
  readonly kind: SessionKind;
  readonly startedAt: number;
  readonly from: string;
  readonly to: string;
  /** Effective layout ("blocks" only with the block dependencies). */
  readonly layout: CaptionLayout;

  private readonly loaded: LoadedConfig;
  /** Blocks from Soniox's streaming translation (blocks layout only). */
  private readonly pipeline: FastBlocks | null;
  /** Local sessions in blocks layout: speech start/end for the pipeline (flush, listening). */
  private readonly speechVad: EnergyVad | null;
  private vadAudioMs = 0;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly opts: CaptionSessionOptions;
  private readonly track: Track;
  private readonly listeners = new Set<SessionListener>();
  private readonly statusCoalescer: Coalescer<"status">;
  private readonly levelCoalescer: Coalescer<"level">;
  private readonly transcript: SessionTranscript | null;
  private readonly hooks: TrackHooks;

  private lifecycle: Lifecycle;
  private error: string | null = null;
  private errorFatal = false;
  private stopPromise: Promise<void> | null = null;
  private stoppedAt: number | null = null;
  private ticker: NodeJS.Timeout | null = null;

  // audio
  private audioState: AudioState;
  private lastStderr: string | null = null;
  private rmsDbfs: number | null = null;
  private peakSinceEmit: number | null = null;
  private lastFrameAt: number | null = null;
  private lastLoudAt: number;

  // page
  private speaking = false;
  private detached = false;
  private silenceTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private preBuffer: Array<{ frame: Uint8Array; at: number }> = [];
  private retryOpenAt = 0;

  // local
  private input: AudioInputApi | null = null;
  private firstFrameWaiters: Array<(ok: boolean) => void> = [];
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private liveSince: number | null = null;

  constructor(opts: CaptionSessionOptions) {
    this.opts = opts;
    this.id = opts.id ?? newSessionId();
    this.kind = opts.kind;
    this.layout = opts.layout === "blocks" && opts.blocks != null ? "blocks" : "rollup";
    this.loaded = opts.loaded;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.from = opts.from;
    this.to = opts.to;
    this.log = opts.log.child({ session: this.id, kind: opts.kind });
    this.lifecycle = opts.kind === "page" ? "live" : "starting";
    this.audioState = opts.kind === "page" ? "idle" : "none";
    this.lastLoudAt = this.startedAt;
    this.statusCoalescer = new Coalescer<"status">(
      () => this.emit({ type: "status", status: this.status() }),
      { intervalMs: STATUS_INTERVAL_MS, now: this.now },
    );
    this.levelCoalescer = new Coalescer<"level">(() => this.emitLevel(), {
      intervalMs: LEVEL_INTERVAL_MS,
      now: this.now,
    });
    this.hooks = {
      onSegment: (track, segment) => {
        this.emit({ type: "segment", track, segment });
        this.pipeline?.update(segment);
      },
      onChange: () => {
        // A page's non-fatal connect error is stale once its engine is live again.
        if (
          this.kind === "page" &&
          this.error !== null &&
          !this.errorFatal &&
          this.track.providerState() === "live"
        ) {
          this.error = null;
        }
        this.scheduleStatus();
      },
      onMarker: (type, data, line) => this.marker(type, data, line),
      onFailure: (track, message, fatal) => this.onTrackFailure(track, message, fatal),
    };
    const cfg = this.loaded.config;
    this.transcript = opts.saveTranscripts
      ? new SessionTranscript({
          rootDir: this.loaded.paths.transcriptsDir,
          sessionId: this.id,
          startedAt: this.startedAt,
          from: opts.from,
          to: opts.to,
          srt: cfg.transcripts.srt,
          log: this.log,
          now: this.now,
        })
      : null;
    this.pipeline =
      this.layout === "blocks" && opts.blocks != null ? this.createPipeline(opts.blocks) : null;
    this.speechVad =
      this.pipeline !== null && this.kind !== "page"
        ? new EnergyVad({
            thresholdDbfs: cfg.vad.thresholdDbfs,
            minSpeechMs: cfg.vad.minSpeechMs,
            minSilenceMs: cfg.vad.minSilenceMs,
          })
        : null;
    this.track = new Track(TRACK, {
      sessionId: this.id,
      from: this.from,
      to: this.to,
      sessionStartWall: this.startedAt,
      loaded: this.loaded,
      engineFactory: opts.engineFactory,
      glossary: opts.glossary,
      transcript: this.transcript?.track(TRACK) ?? null,
      log: this.log,
      now: this.now,
      hooks: this.hooks,
      fastBlocks: this.layout === "blocks",
      ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
    });
    this.track.active = true;
    const file = this.info().file;
    const keyLabel = opts.page?.keyLabel ?? null;
    this.marker(
      "start",
      {
        kind: this.kind,
        from: this.from,
        to: this.to,
        layout: this.layout,
        engines: TRACK,
        ...(file === undefined ? {} : { file }),
        ...(keyLabel === null ? {} : { keyLabel }),
        ...(opts.orgId === undefined ? {} : { orgId: opts.orgId }),
      },
      `start: ${this.kind} session ${this.id}, ${this.from} → ${this.to}, ${TRACK}, ` +
        `layout ${this.layout}` +
        (file === undefined ? "" : `, file ${file}`),
    );
    this.log.info({ from: this.from, to: this.to, engines: TRACK }, "session created");
    if (this.kind === "page") {
      this.startTicker();
      if (opts.page?.onUsage !== undefined) {
        this.usageTimer = setInterval(() => this.reportUsage(), USAGE_REPORT_MS);
      }
    }
  }

  // --- CaptionSessionApi: common ---------------------------------------------------------------

  info(): SessionInfo {
    const info: SessionInfo = {
      id: this.id,
      kind: this.kind,
      startedAt: this.startedAt,
      from: this.from,
      to: this.to,
      source: this.kind,
      inputKind: this.inputKind(),
    };
    const spec = this.opts.local?.spec;
    if (spec?.kind === "file") info.file = spec.path;
    const keyLabel = this.opts.page?.keyLabel;
    if (keyLabel !== undefined && keyLabel !== null) info.keyLabel = keyLabel;
    return info;
  }

  status(): Status {
    const now = this.now();
    const status: Status = {
      state: this.state(),
      primary: TRACK,
      provider: this.track.providerState(),
      audio: this.audioStatus(now),
      latency: this.track.latency.translation.stats(),
      tracks: [this.track.status(now)],
      session: this.info(),
    };
    if (this.error !== null) status.error = this.error;
    status.layout = this.layout;
    if (this.pipeline !== null) status.eventMode = this.pipeline.mode;
    if (this.kind === "page") {
      status.page = {
        speaking: this.speaking,
        engineOpen: this.track.engineOpen,
        streamedMinutes: round2(this.track.engineOpenMs(now) / 60_000),
      };
    }
    return status;
  }

  summary(): SessionSummary {
    const now = this.now();
    const summary: SessionSummary = {
      id: this.id,
      kind: this.kind,
      from: this.from,
      to: this.to,
      engines: this.track.active ? [TRACK] : [],
      startedAt: this.startedAt,
      durationMs: (this.stoppedAt ?? now) - this.startedAt,
      streamedMinutes: round2(this.track.engineOpenMs(now) / 60_000),
      latency: this.track.latency.translation.stats(),
      state: this.state(),
    };
    const keyLabel = this.opts.page?.keyLabel;
    if (keyLabel !== undefined && keyLabel !== null) summary.keyLabel = keyLabel;
    summary.layout = this.layout;
    if (this.pipeline !== null) summary.eventMode = this.pipeline.mode;
    return summary;
  }

  snapshots(): ServerMessage[] {
    const status = this.status();
    const out: ServerMessage[] = [
      {
        type: "snapshot",
        track: TRACK,
        session: this.info(),
        segments: this.track.store.snapshot(),
        status,
      },
    ];
    const pipeline = this.pipeline;
    if (pipeline !== null) {
      const page = pipeline.blocks({ limit: SNAPSHOT_BLOCKS });
      out.push({ type: "blocks.snapshot", blocks: page.blocks, hasMore: page.hasMore });
      out.push({ type: "mode", mode: pipeline.mode });
      // Always sent, so a page that reconnects clears dots that were lit before the drop.
      out.push({ type: "listening", ...pipeline.listeningState() });
      if (this.stoppedAt !== null) out.push({ type: "session.ended", endedAt: this.stoppedAt });
    }
    return out;
  }

  blocks(opts: { before?: number; limit?: number } = {}): { blocks: Block[]; hasMore: boolean } {
    return this.pipeline?.blocks(opts) ?? { blocks: [], hasMore: false };
  }

  overrideEvent(event: PrayerEvent | "none"): void {
    const pipeline = this.pipeline;
    if (pipeline === null || !this.running) {
      this.log.info({ event, layout: this.layout }, "event override ignored (no block pipeline)");
      return;
    }
    this.marker("event-override", { event }, `operator event override: ${event}`);
    pipeline.overrideEvent(event);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear the captions. "all" (control-page Clear, screen Reset) also forgets the
   * block history: {clear} then an empty blocks.snapshot go to subscribers, and blocks.jsonl
   * gets a {"type":"clear","at":…} line (transcripts and blocks.jsonl keep everything). The
   * history is forgotten before {clear} goes out: the hub answers it with fresh snapshots.
   */
  clear(track: TrackId | "all" = "all"): void {
    this.track.store.clear();
    const pipeline = track === "all" ? this.pipeline : null;
    pipeline?.clearHistory();
    this.emit({ type: "clear", track });
    if (pipeline !== null) {
      this.transcript?.appendBlock(JSON.stringify({ type: "clear", at: this.now() }));
      this.emit({ type: "blocks.snapshot", blocks: [], hasMore: false });
    }
    this.marker("clear", { track }, `clear: ${track}`);
  }

  /** Not stopping or stopped. */
  get running(): boolean {
    return this.lifecycle === "starting" || this.lifecycle === "live";
  }

  /** Stopped (final state). */
  get stopped(): boolean {
    return this.lifecycle === "stopped";
  }

  // --- page sessions -------------------------------------------------------------------------

  pushFrame(frame: Uint8Array): void {
    if (this.kind !== "page" || !this.running) return;
    const now = this.now();
    this.noteFrame(frame, now);
    const track = this.track;
    if (track.engineOpen) {
      track.sendFrame(frame, now);
      return;
    }
    // No engine: keep a short pre-roll for the next speech start, or reopen while speaking
    // (a connect that failed is retried every RETRY_OPEN_MS).
    this.preBuffer.push({ frame, at: now });
    if (this.preBuffer.length > PREBUFFER_FRAMES) this.preBuffer.shift();
    if (this.speaking && !track.fatal && now >= this.retryOpenAt) this.openPageEngine(track);
  }

  speech(state: "start" | "end"): void {
    if (this.kind !== "page" || !this.running) return;
    const track = this.track;
    this.pipeline?.speech(state, this.now());
    if (state === "start") {
      this.speaking = true;
      this.clearTimer("silence");
      if (!track.engineOpen && !track.fatal) this.openPageEngine(track);
    } else {
      if (!this.speaking) return;
      this.speaking = false;
      if (this.loaded.config.pages.finalizeOnSpeechEnd) track.finalize();
      this.armSilenceTimer();
    }
    this.scheduleStatus();
  }

  detach(): void {
    if (this.kind !== "page" || !this.running || this.detached) return;
    this.detached = true;
    if (this.speaking) this.speech("end");
    const graceMs = this.loaded.config.pages.resumeGraceSec * 1000;
    this.clearTimer("grace");
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.stop("page gone");
    }, graceMs);
    this.marker("detach", { graceMs }, "page disconnected; waiting for resume");
    this.scheduleStatus();
  }

  attach(): void {
    if (this.kind !== "page" || !this.detached || !this.running) return;
    this.detached = false;
    this.clearTimer("grace");
    this.marker("resume", {}, "page resumed");
    this.scheduleStatus();
  }

  // --- local sessions ------------------------------------------------------------------------

  /** Start a device/file session: input → first frame (≤5 s) → engines → live. */
  async startLocal(
    opts: { firstFrameTimeoutMs?: number } = {},
  ): Promise<{ ok: boolean; message: string }> {
    const local = this.opts.local;
    if (this.kind === "page" || local === undefined) {
      return { ok: false, message: "not a local session" };
    }
    if (this.lifecycle !== "starting" || this.input !== null) {
      return { ok: false, message: "session already started" };
    }
    this.scheduleStatus();
    let input: AudioInputApi;
    try {
      input = local.inputFactory(local.spec);
      this.input = input;
      this.audioState = input.state;
      input.start({
        onFrame: (frame, arrivalWallMs) => this.onLocalFrame(frame, arrivalWallMs),
        onState: (state, detail) => this.onInputState(state, detail.lastStderr),
        onEnded: () => {
          this.marker("input-ended", {}, "input ended (end of file)");
          void this.stop("file ended");
        },
      });
    } catch (err) {
      return this.failStart(`audio input failed to start: ${errorMessage(err)}`);
    }
    const firstFrameMs = opts.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    const gotFrame = await this.waitFirstFrame(firstFrameMs);
    if (this.lifecycle !== "starting") return { ok: false, message: "session stopped" };
    if (!gotFrame) {
      const detail = input.lastStderr ?? this.lastStderr;
      return this.failStart(
        `no audio from the ${this.inputKind()} input within ${firstFrameMs / 1000} s` +
          (detail === null ? "" : `: ${detail}`),
      );
    }
    this.transcript?.materialize();
    let inst: EngineInstance;
    try {
      inst = this.track.openEngine();
    } catch (err) {
      return this.failStart(errorMessage(err));
    }
    const live = await this.track.waitLive(inst, PROVIDER_LIVE_TIMEOUT_MS);
    if (this.lifecycle !== "starting") {
      return { ok: false, message: this.error ?? "session stopped" };
    }
    if (!live && inst.failed) {
      return this.failStart(this.track.lastError ?? "provider failed to connect");
    }
    const now = this.now();
    this.lifecycle = "live";
    this.liveSince = now;
    this.lastLoudAt = now;
    this.startTicker();
    const maxMin = this.loaded.config.session.maxDurationMin;
    this.maxDurationTimer = setTimeout(() => {
      this.maxDurationTimer = null;
      this.autoStop(`maximum session duration (${maxMin} min) reached`);
    }, maxMin * 60_000);
    this.marker("live", {}, live ? "live" : "live (provider still connecting)");
    this.scheduleStatus();
    return { ok: true, message: live ? "live" : "started; provider still connecting" };
  }

  // --- stop -----------------------------------------------------------------------------------

  /** Graceful stop; `fast` at process shutdown. Idempotent. */
  stop(reason: string, opts: { fast?: boolean } = {}): Promise<void> {
    if (this.stopPromise === null) this.stopPromise = this.doStop(reason, opts.fast === true);
    return this.stopPromise;
  }

  // --- internals: state -------------------------------------------------------------------------

  private state(): SessionState {
    switch (this.lifecycle) {
      case "stopped":
        return this.errorFatal ? "error" : "idle";
      case "stopping":
        return "stopping";
      case "starting":
        return this.errorFatal ? "error" : "starting";
      default:
        break;
    }
    if (this.errorFatal) return "error";
    const provider = this.track.providerState();
    if (provider === "reconnecting") return "reconnecting";
    if (provider === "error") return "error";
    return "live";
  }

  private inputKind(): SessionInfo["inputKind"] {
    if (this.kind === "page") return "page";
    const spec = this.opts.local?.spec;
    if (spec === undefined) return this.kind === "file" ? "file" : "device";
    return spec.kind;
  }

  private audioStatus(now: number): Status["audio"] {
    const lastFrameAgoMs = this.lastFrameAt === null ? null : Math.max(0, now - this.lastFrameAt);
    if (this.kind === "page") {
      const recent = lastFrameAgoMs !== null && lastFrameAgoMs < 2000;
      return {
        state: this.running && (this.speaking || recent) ? "ok" : "idle",
        rmsDbfs: this.rmsDbfs,
        lastFrameAgoMs,
        noSignal: false,
      };
    }
    const quietSince = Math.max(this.lastLoudAt, this.liveSince ?? now);
    const audio: Status["audio"] = {
      state: this.lifecycle === "stopped" ? "idle" : this.audioState,
      rmsDbfs: this.rmsDbfs,
      lastFrameAgoMs,
      noSignal: this.lifecycle === "live" && now - quietSince >= NO_SIGNAL_MS,
    };
    if (this.lastStderr !== null) audio.lastStderr = this.lastStderr;
    return audio;
  }

  // --- internals: blocks -----------------------------------------------------------------------

  private createPipeline(blocks: SessionBlocksOptions): FastBlocks {
    const cfg = this.loaded.config;
    const labels: EventLabels =
      cfg.events.labels[this.to] ?? cfg.events.labels.en ?? ENGLISH_LABELS;
    return new FastBlocks({
      sessionId: this.id,
      targetLang: this.to,
      follower: blocks.followerFactory?.(this.to) ?? passThroughFollower(),
      detector: cfg.events.enabled ? blocks.detector : null,
      labels,
      now: this.now,
      log: this.log,
      persist: (line) => this.transcript?.appendBlock(line),
      emit: (out) => this.emit(out),
    });
  }

  // --- internals: messages ----------------------------------------------------------------------

  private emit(msg: ServerMessage): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(msg);
      } catch (err) {
        this.log.warn({ err }, "session listener threw");
      }
    }
  }

  private scheduleStatus(): void {
    this.statusCoalescer.push("status");
  }

  private emitStatusNow(): void {
    this.statusCoalescer.cancel("status");
    this.emit({ type: "status", status: this.status() });
  }

  private emitLevel(): void {
    const rms = this.rmsDbfs as number; // noteFrame sets it before every level push
    const peak = this.peakSinceEmit ?? rms;
    this.peakSinceEmit = null;
    this.emit({ type: "level", rmsDbfs: round2(rms), peakDbfs: round2(peak) });
  }

  private marker(type: string, data: Record<string, unknown>, line: string): void {
    this.transcript?.marker(type, data);
    this.transcript?.logLine(line);
  }

  // --- internals: audio -------------------------------------------------------------------------

  private noteFrame(frame: Uint8Array, now: number): void {
    this.lastFrameAt = now;
    let rms: number;
    let peak: number;
    try {
      const level = frameLevel(frame);
      rms = level.rmsDbfs;
      peak = level.peakDbfs;
    } catch {
      return;
    }
    this.rmsDbfs = rms;
    this.peakSinceEmit = this.peakSinceEmit === null ? peak : Math.max(this.peakSinceEmit, peak);
    if (rms >= this.loaded.config.audio.silenceWarnDbfs) this.lastLoudAt = now;
    if (this.kind !== "page") this.levelCoalescer.push("level");
  }

  private onLocalFrame(frame: Uint8Array, arrivalWallMs: number): void {
    if (!this.running) return;
    this.noteFrame(frame, this.now());
    if (this.speechVad !== null && this.pipeline !== null) {
      try {
        for (const e of this.speechVad.push(pcmBytesToSamples(frame), this.vadAudioMs)) {
          this.pipeline.speech(e.type === "speechStart" ? "start" : "end", this.now());
        }
      } catch {
        // odd-length frame: no VAD update
      }
      this.vadAudioMs += 100;
    }
    if (this.firstFrameWaiters.length > 0) this.resolveFirstFrame(true);
    this.track.sendFrame(frame, arrivalWallMs);
  }

  private onInputState(state: AudioState, lastStderr: string | null): void {
    const previous = this.audioState;
    this.audioState = state;
    if (lastStderr !== null) this.lastStderr = lastStderr;
    if (
      state !== previous &&
      (state === "restarting" || state === "error" || state === "stalled")
    ) {
      this.marker(
        "audio",
        { state, lastStderr },
        `audio input ${state}${lastStderr === null ? "" : `: ${lastStderr}`}`,
      );
    }
    this.scheduleStatus();
  }

  private waitFirstFrame(timeoutMs: number): Promise<boolean> {
    if (this.lastFrameAt !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        this.firstFrameWaiters = this.firstFrameWaiters.filter((w) => w !== finish);
        resolve(ok);
      };
      this.firstFrameWaiters.push(finish);
    });
  }

  private resolveFirstFrame(ok: boolean): void {
    for (const w of [...this.firstFrameWaiters]) w(ok);
  }

  private async failStart(message: string): Promise<{ ok: boolean; message: string }> {
    this.error = message;
    this.errorFatal = true;
    this.log.warn({ message }, "local session failed to start");
    await this.stop(`start failed: ${message}`);
    return { ok: false, message };
  }

  // --- internals: page engine ---------------------------------------------------------------------

  private openPageEngine(track: Track): void {
    this.transcript?.materialize();
    try {
      track.openEngine();
    } catch (err) {
      const message = errorMessage(err);
      track.lastError = message;
      this.error = message;
      this.retryOpenAt = this.now() + RETRY_OPEN_MS;
      this.log.warn({ err }, "page engine failed to open");
      this.scheduleStatus();
      return;
    }
    this.retryOpenAt = 0;
    // Frames that came in just before the speech start are the pre-roll: send them first.
    const now = this.now();
    for (const { frame, at } of this.preBuffer) {
      if (now - at <= PREBUFFER_MAX_AGE_MS) track.sendFrame(frame, at);
    }
    this.preBuffer = [];
    this.scheduleStatus();
  }

  private armSilenceTimer(): void {
    this.clearTimer("silence");
    const ms = this.loaded.config.pages.closeAfterSilenceSec * 1000;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.closePageEngine();
    }, ms);
  }

  private async closePageEngine(): Promise<void> {
    const track = this.track;
    if (!track.engineOpen || this.speaking) return;
    await track.closeCurrent({ fast: false });
    this.reportUsage();
    this.scheduleStatus();
  }

  private reportUsage(): void {
    const onUsage = this.opts.page?.onUsage;
    if (onUsage === undefined) return;
    const ms = this.track.takeUsageMs(this.now());
    if (ms <= 0) return;
    try {
      onUsage(this.track.id, ms);
    } catch (err) {
      this.log.warn({ err }, "onUsage threw");
    }
  }

  // --- internals: failures, guards ------------------------------------------------------------

  private onTrackFailure(track: TrackId, message: string, fatal: boolean): void {
    this.log.warn({ track, message, fatal }, "engine failed");
    if (this.kind === "page") {
      // Keep the session so the page shows the error; a failed connect retries at the next speech.
      this.error = message;
      if (fatal) this.errorFatal = true;
      else this.retryOpenAt = this.now() + RETRY_OPEN_MS;
      this.scheduleStatus();
      return;
    }
    this.error = message;
    this.errorFatal = true;
    if (this.lifecycle === "live") void this.stop(`error: ${message}`);
    this.scheduleStatus();
  }

  /** Pages from the start, local sessions once live; doStop clears it before anything else. */
  private startTicker(): void {
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const now = this.now();
    const cfg = this.loaded.config;
    if (this.kind === "page") {
      // Pages are silence-gated (engine closes after closeAfterSilenceSec); their cost cap is
      // the per-key daily limit enforced by the server. A session-wide duration cap would stop
      // an OBS page that stays connected for days in the middle of a later khutbah.
      if (this.track.engineOpen) this.scheduleStatus();
      return;
    }
    // No frames at all counts as silence too (lastLoudAt only moves on loud frames).
    const silentMs = now - Math.max(this.lastLoudAt, this.liveSince ?? now);
    const limitMin = cfg.session.autoStopAfterSilenceMin;
    if (silentMs >= limitMin * 60_000) {
      this.autoStop(`no audio above ${cfg.audio.silenceWarnDbfs} dBFS for ${limitMin} min`);
      return;
    }
    this.scheduleStatus();
  }

  /** From the ticker or the max-duration timer: both run only while the session is live. */
  private autoStop(reason: string): void {
    this.error = `auto-stopped: ${reason}`;
    this.log.warn({ reason }, "cost guard: stopping session");
    this.marker("auto-stop", { reason }, `cost guard: ${reason}`);
    void this.stop(reason);
  }

  // --- internals: stop -----------------------------------------------------------------------------

  private clearTimer(which: "silence" | "grace" | "usage" | "max" | "ticker"): void {
    switch (which) {
      case "silence":
        if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
        return;
      case "grace":
        if (this.graceTimer !== null) clearTimeout(this.graceTimer);
        this.graceTimer = null;
        return;
      case "usage":
        if (this.usageTimer !== null) clearInterval(this.usageTimer);
        this.usageTimer = null;
        return;
      case "max":
        if (this.maxDurationTimer !== null) clearTimeout(this.maxDurationTimer);
        this.maxDurationTimer = null;
        return;
      case "ticker":
        if (this.ticker !== null) clearInterval(this.ticker);
        this.ticker = null;
        return;
    }
  }

  private async doStop(reason: string, fast: boolean): Promise<void> {
    const wasRunning = this.running;
    this.lifecycle = "stopping";
    for (const t of ["silence", "grace", "usage", "max", "ticker"] as const) this.clearTimer(t);
    this.resolveFirstFrame(false);
    this.speaking = false;
    this.log.info({ reason, fast }, "session stopping");
    this.emitStatusNow();
    try {
      // Engines first, so their last words still arrive; then the input.
      await this.track.shutdown({ fast });
      const input = this.input;
      if (input !== null) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, INPUT_STOP_TIMEOUT_MS);
        });
        await Promise.race([input.stop().catch(() => undefined), timeout]);
        clearTimeout(timer);
      }
      this.track.store.finalizeAll();
      this.reportUsage();
      if (this.pipeline !== null) {
        // Show what may still be shown, then announce the end.
        await this.pipeline.drain(fast ? DRAIN_FAST_MS : DRAIN_MS);
      }
    } catch (err) {
      this.log.error({ err }, "error while stopping session");
    }
    const now = this.now();
    this.stoppedAt = now;
    if (this.pipeline !== null) {
      this.pipeline.close();
      this.emit({ type: "session.ended", endedAt: now });
      // The archive (blocks-archive.ts) reads the end time from this line too.
      this.transcript?.appendBlock(JSON.stringify({ type: "session.ended", endedAt: now }));
    }
    if (this.transcript?.materialized === true) {
      const t = this.track;
      this.transcript.logLine(`summary ${t.id}: ${t.latency.summary()}; ${t.costBreakdown(now)}`);
      this.marker("stop", { reason, durationMs: now - this.startedAt }, `stop: ${reason}`);
      this.transcript.finish();
    }
    this.lifecycle = "stopped";
    this.emitStatusNow();
    this.track.store.dispose();
    this.statusCoalescer.dispose();
    this.levelCoalescer.dispose();
    this.log.info({ reason, wasRunning }, "session stopped");
    try {
      this.opts.onStopped?.(this);
    } catch (err) {
      this.log.warn({ err }, "onStopped threw");
    }
  }
}
