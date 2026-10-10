// The caption track of a session: Soniox speech recognition and
// its own translation.
//
// A Track is persistent for the session: its SegmentStore, latency metrics, cost counter and
// transcript writer outlive the engines. Engines (an SttProvider from the EngineFactory) are
// instances that come and go: a page opens one per speech burst after a silence close. Every
// instance has its own FrameTimeline (the frames it was sent) and its own engine id in the store.

import type { Logger } from "pino";
import { FrameTimeline } from "../audio/timeline.js";
import type { LoadedConfig, Secrets } from "../config.js";
import type { Glossary } from "../glossary.js";
import type { ProviderState, Segment, TrackId, TrackStatus } from "../shared/protocol.js";
import { EnergyVad, pcmBytesToSamples } from "../shared/vad.js";
import type { ProviderEvent, SttProvider } from "../stt/types.js";
import type { Engine, EngineFactory } from "./contracts.js";
import { CostCounter, type OpenPeriod } from "./cost.js";
import { TrackLatency } from "./metrics.js";
import { type OpenSegmentView, SegmentStore } from "./segments.js";
import type { TrackTranscript } from "./transcripts.js";

/** A stopping provider is hard-closed after this long (page silence close). */
export const SWITCH_HARD_CLOSE_MS = 3000;
/** Session stop: room for the provider's own finalize → end-of-stream (≤5 s) sequence. */
export const STOP_HARD_CLOSE_MS = 6000;
/** Process shutdown: the providers' fast path needs ≤1 s. */
export const FAST_HARD_CLOSE_MS = 1500;

export interface TrackHooks {
  /** Coalesced segment upsert. */
  onSegment(track: TrackId, seg: Segment): void;
  /** Something status-relevant changed (provider state, error, counts). */
  onChange(): void;
  /** A session.jsonl marker plus its session.log line. */
  onMarker(type: string, data: Record<string, unknown>, line: string): void;
  /** The current engine failed: fatal (no retry) or a failed connect. */
  onFailure(track: TrackId, message: string, fatal: boolean): void;
}

export interface TrackContext {
  sessionId: string;
  from: string;
  to: string;
  sessionStartWall: number;
  loaded: LoadedConfig;
  engineFactory: EngineFactory;
  glossary: Glossary | null;
  transcript: TrackTranscript | null;
  log: Logger;
  now: () => number;
  hooks: TrackHooks;
  /** Fast blocks: Soniox gets the fast-blocks endpoint defaults (engines.ts). */
  fastBlocks?: boolean;
  /** The organisation's API keys, read at every engine start (a replaced key applies next time). */
  secrets?: () => Secrets;
}

/** One engine instance on a track. */
export interface EngineInstance {
  readonly id: string;
  readonly engine: Engine;
  readonly timeline: FrameTimeline;
  readonly openedAt: number;
  closedAt: number | null;
  live: boolean;
  failed: boolean;
  stopping: boolean;
  framesSent: number;
  usageReportedTo: number;
  liveWaiters: Array<(live: boolean) => void>;
  stopPromise: Promise<void> | null;
}

export interface StopOptions {
  fast: boolean;
  hardCloseMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/u).length;
}

/** Resolve after `ms` (cancellable, so no timer outlives the race). */
function delay(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Long-utterance guard: once the open segment passes the word or time
 * threshold it is armed, and fires `finalize()` at the next local silence (≥200 ms, EnergyVad);
 * at 1.5× the threshold it fires unconditionally. At most once per segment.
 */
class LongUtteranceGuard {
  private readonly vad: EnergyVad;
  private audioMs = 0;
  private firedFor: number | null = null;

  constructor(
    private readonly words: number | null,
    private readonly ms: number | null,
    vad: { thresholdDbfs: number; minSpeechMs: number },
  ) {
    this.vad = new EnergyVad({
      thresholdDbfs: vad.thresholdDbfs,
      minSpeechMs: vad.minSpeechMs,
      minSilenceMs: 200,
    });
  }

  check(
    frame: Uint8Array,
    open: OpenSegmentView | null,
    now: number,
  ): { seq: number; words: number; ageMs: number; forced: boolean } | null {
    try {
      this.vad.push(pcmBytesToSamples(frame), this.audioMs);
    } catch {
      // odd-length frame: skip the VAD update
    }
    this.audioMs += 100;
    if (open === null || open.seq === this.firedFor) return null;
    const words = countWords(open.text);
    const ageMs = now - open.firstTokenAt;
    const over =
      (this.words !== null && words >= this.words) || (this.ms !== null && ageMs >= this.ms);
    if (!over) return null;
    const forced =
      (this.words !== null && words >= this.words * 1.5) ||
      (this.ms !== null && ageMs >= this.ms * 1.5);
    if (!forced && this.vad.speaking) return null;
    this.firedFor = open.seq;
    return { seq: open.seq, words, ageMs, forced };
  }
}

export class Track {
  readonly store: SegmentStore;
  readonly latency: TrackLatency;
  readonly cost: CostCounter;
  /** Runs in the session (false once the session stops). */
  active = false;
  lastError: string | undefined;
  /** A fatal provider error happened: no new engines are opened. */
  fatal = false;

  private current: EngineInstance | null = null;
  /** Engines not closed yet (runStop removes one as soon as it sets closedAt). */
  private readonly instances = new Map<string, EngineInstance>();
  private engineSeq = 0;
  private closedEngineMs = 0;
  private unreportedMs = 0;
  private readonly guard: LongUtteranceGuard | null;
  private readonly log: Logger;

  constructor(
    readonly id: TrackId,
    private readonly ctx: TrackContext,
  ) {
    this.log = ctx.log.child({ track: id });
    const cfg = ctx.loaded.config;
    this.latency = new TrackLatency(ctx.sessionStartWall, ctx.to);
    this.cost = new CostCounter(cfg.pricing);
    this.store = new SegmentStore({
      sessionId: ctx.sessionId,
      track: id,
      sourceLang: ctx.from,
      targetLangs: [ctx.to],
      sessionStartWall: ctx.sessionStartWall,
      translationGraceMs: 3000,
      maxSegments: 50,
      now: ctx.now,
      onUpsert: (seg) => this.ctx.hooks.onSegment(this.id, seg),
      onDone: (seg) => this.onDone(seg),
      onLateDrop: (info) =>
        this.log.debug({ engine: info.engineId, lang: info.lang }, "late translation dropped"),
    });
    const { forceFinalizeAfterWords, forceFinalizeAfterMs } = cfg.stt.soniox;
    this.guard =
      forceFinalizeAfterWords !== null || forceFinalizeAfterMs !== null
        ? new LongUtteranceGuard(forceFinalizeAfterWords, forceFinalizeAfterMs, cfg.vad)
        : null;
  }

  // --- engines ---------------------------------------------------------------------------

  /** The engine receiving audio, if any. */
  get currentEngine(): EngineInstance | null {
    return this.current;
  }

  /** An engine is open and receiving audio. */
  get engineOpen(): boolean {
    return this.current !== null && !this.current.stopping;
  }

  /**
   * Build and start a new engine instance (not yet receiving audio; see `use()`).
   * Throws what the EngineFactory throws (EngineUnavailableError).
   */
  createEngine(): EngineInstance {
    const ctx = this.ctx;
    const recordFile =
      ctx.loaded.config.transcripts.recordProviderMessages && ctx.transcript !== null
        ? ctx.transcript.nextRecordFile()
        : null;
    const engine = ctx.engineFactory({
      track: this.id,
      sessionId: ctx.sessionId,
      from: ctx.from,
      to: ctx.to,
      glossary: ctx.glossary,
      recordFile,
      fastBlocks: ctx.fastBlocks === true,
      ...(ctx.secrets === undefined ? {} : { secrets: ctx.secrets() }),
    });
    const now = ctx.now();
    const inst: EngineInstance = {
      id: `${this.id}#${++this.engineSeq}`,
      engine,
      timeline: new FrameTimeline({ originWallMs: now }),
      openedAt: now,
      closedAt: null,
      live: false,
      failed: false,
      stopping: false,
      framesSent: 0,
      usageReportedTo: now,
      liveWaiters: [],
      stopPromise: null,
    };
    this.instances.set(inst.id, inst);
    this.store.beginEngine({
      engineId: inst.id,
      capabilities: engine.provider.capabilities,
      timeline: inst.timeline,
    });
    ctx.hooks.onMarker(
      "engine-open",
      { track: this.id, engine: inst.id },
      `${this.id}: engine ${inst.id} opened`,
    );
    const provider = engine.provider;
    let started: Promise<void>;
    try {
      started = provider.start({ sessionId: ctx.sessionId, onEvent: (e) => this.onEvent(inst, e) });
    } catch (err) {
      started = Promise.reject(err);
    }
    started.then(
      () => {
        if (!inst.stopping && !inst.failed) this.markLive(inst);
        ctx.hooks.onChange();
      },
      (err: unknown) => this.onStartFailed(inst, provider, err),
    );
    return inst;
  }

  /** Route audio to `inst` from now on; returns the engine it replaces (caller stops it). */
  use(inst: EngineInstance): EngineInstance | null {
    const previous = this.current;
    this.current = inst;
    this.ctx.hooks.onChange();
    return previous === inst ? null : previous;
  }

  /** `createEngine` + `use` (initial start, page speech after a silence close). */
  openEngine(): EngineInstance {
    const inst = this.createEngine();
    const previous = this.use(inst);
    if (previous !== null) void this.stopEngine(previous, { fast: false });
    return inst;
  }

  /** Resolves true once `inst` is live, false if it fails, is stopped or times out. */
  waitLive(inst: EngineInstance, timeoutMs: number): Promise<boolean> {
    if (inst.live) return Promise.resolve(true);
    if (inst.failed || inst.stopping) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (live: boolean): void => {
        clearTimeout(timer);
        inst.liveWaiters = inst.liveWaiters.filter((w) => w !== finish);
        resolve(live);
      };
      inst.liveWaiters.push(finish);
    });
  }

  /** One 100 ms frame for the current engine (arrival = capture wall time estimate). */
  sendFrame(frame: Uint8Array, arrivalWallMs: number): void {
    const inst = this.current;
    if (inst === null || inst.stopping || inst.failed) return;
    inst.timeline.push(arrivalWallMs);
    inst.framesSent++;
    try {
      inst.engine.provider.sendAudio(frame);
    } catch (err) {
      this.log.warn({ err, engine: inst.id }, "sendAudio threw");
    }
    if (this.guard !== null) {
      const fired = this.guard.check(frame, this.store.openSegment(inst.id), this.ctx.now());
      if (fired !== null) {
        inst.engine.provider.finalize();
        this.ctx.hooks.onMarker(
          "guard",
          { track: this.id, engine: inst.id, ...fired },
          `${this.id}: long-utterance guard finalized segment ${fired.seq} ` +
            `(${fired.words} words, ${Math.round(fired.ageMs / 1000)} s${fired.forced ? ", forced" : ""})`,
        );
      }
    }
  }

  /** Force-close the current utterance (page speech end). */
  finalize(): void {
    const inst = this.current;
    if (inst === null || inst.stopping || inst.failed) return;
    try {
      inst.engine.provider.finalize();
    } catch (err) {
      this.log.warn({ err, engine: inst.id }, "finalize threw");
    }
  }

  /** Stop the current engine (page silence close, track deactivation). */
  async closeCurrent(opts: StopOptions): Promise<void> {
    const inst = this.current;
    if (inst !== null) await this.stopEngine(inst, opts);
  }

  /**
   * Stop one engine: graceful provider stop (hard-closed after `hardCloseMs`), close its open
   * segment, then account its cost and usage.
   */
  stopEngine(inst: EngineInstance, opts: StopOptions): Promise<void> {
    if (inst.stopPromise !== null) return inst.stopPromise;
    inst.stopping = true;
    if (this.current === inst) this.current = null;
    for (const w of [...inst.liveWaiters]) w(false);
    this.ctx.hooks.onChange();
    inst.stopPromise = this.runStop(inst, opts);
    return inst.stopPromise;
  }

  /** Stop every engine of the track (session stop). */
  async shutdown(opts: { fast: boolean }): Promise<void> {
    this.active = false;
    const hardCloseMs = opts.fast ? FAST_HARD_CLOSE_MS : STOP_HARD_CLOSE_MS;
    await Promise.all(
      [...this.instances.values()].map((inst) =>
        this.stopEngine(inst, { fast: opts.fast, hardCloseMs }),
      ),
    );
  }

  // --- accounting ----------------------------------------------------------------------------

  /** Engine-open ms not yet reported (usage accounting). */
  takeUsageMs(now: number): number {
    let ms = this.unreportedMs;
    this.unreportedMs = 0;
    for (const inst of this.instances.values()) {
      ms += Math.max(0, now - inst.usageReportedTo);
      inst.usageReportedTo = now;
    }
    return ms;
  }

  /** Total engine-open time (closed + running engines). */
  engineOpenMs(now: number): number {
    let ms = this.closedEngineMs;
    for (const inst of this.instances.values()) ms += Math.max(0, now - inst.openedAt);
    return ms;
  }

  providerState(): ProviderState {
    if (this.current !== null) return this.current.engine.provider.state;
    return this.fatal ? "error" : "idle";
  }

  costUsd(now: number): number {
    return this.cost.usd(this.openPeriods(now));
  }

  costBreakdown(now: number): string {
    return this.cost.breakdown(this.openPeriods(now));
  }

  status(now: number): TrackStatus {
    const s: TrackStatus = {
      track: this.id,
      active: this.active,
      provider: this.providerState(),
      latency: {
        source: this.latency.source.stats(),
        translation: this.latency.translation.stats(),
      },
      vadLatency: null,
      costUsd: Math.round(this.costUsd(now) * 10_000) / 10_000,
      segments: this.store.closedCount,
    };
    if (this.lastError !== undefined) s.lastError = this.lastError;
    return s;
  }

  // --- internals -----------------------------------------------------------------------------

  private openPeriods(now: number): OpenPeriod[] {
    return [...this.instances.values()].map((inst) => ({
      streamMs: Math.max(0, now - inst.openedAt),
    }));
  }

  private markLive(inst: EngineInstance): void {
    if (inst.live) return;
    inst.live = true;
    for (const w of [...inst.liveWaiters]) w(true);
  }

  private onEvent(inst: EngineInstance, e: ProviderEvent): void {
    const hooks = this.ctx.hooks;
    switch (e.type) {
      case "tokens":
      case "endpoint":
        this.store.apply(e, inst.id);
        return;
      case "reconnected":
        this.store.apply(e, inst.id);
        hooks.onMarker(
          "reconnect",
          { track: this.id, engine: inst.id, gapMs: e.gapMs, audioOffsetMs: e.audioOffsetMs },
          `${this.id}: provider reconnected after a ${e.gapMs} ms gap`,
        );
        hooks.onChange();
        return;
      case "state":
        if (e.state === "live") this.markLive(inst);
        if (e.state !== "live" || e.detail !== undefined) {
          hooks.onMarker(
            "provider-state",
            { track: this.id, engine: inst.id, state: e.state, detail: e.detail ?? null },
            `${this.id}: provider ${e.state}${e.detail === undefined ? "" : ` (${e.detail})`}`,
          );
        }
        hooks.onChange();
        return;
      case "error":
        this.lastError = e.message;
        hooks.onMarker(
          "error",
          { track: this.id, engine: inst.id, fatal: e.fatal, message: e.message },
          `${this.id}: provider error${e.fatal ? " (fatal)" : ""}: ${e.message}`,
        );
        if (e.fatal) this.onEngineFailed(inst, e.message, true);
        hooks.onChange();
        return;
    }
  }

  private onStartFailed(inst: EngineInstance, provider: SttProvider, err: unknown): void {
    if (inst.stopping) return;
    const message = errorMessage(err);
    this.lastError = message;
    this.log.warn({ err, engine: inst.id }, "provider start failed");
    this.onEngineFailed(inst, message, provider.state === "error");
    this.ctx.hooks.onChange();
  }

  private onEngineFailed(inst: EngineInstance, message: string, fatal: boolean): void {
    if (inst.failed) return;
    inst.failed = true;
    for (const w of [...inst.liveWaiters]) w(false);
    const wasCurrent = this.current === inst;
    if (wasCurrent && fatal) this.fatal = true;
    void this.stopEngine(inst, { fast: true, hardCloseMs: FAST_HARD_CLOSE_MS });
    if (wasCurrent) this.ctx.hooks.onFailure(this.id, message, fatal);
  }

  private async runStop(inst: EngineInstance, opts: StopOptions): Promise<void> {
    const hardCloseMs = opts.hardCloseMs ?? (opts.fast ? FAST_HARD_CLOSE_MS : SWITCH_HARD_CLOSE_MS);
    const provider = inst.engine.provider;
    const graceful = provider.stop(opts.fast ? { fast: true } : undefined).then(
      () => "stopped" as const,
      (err: unknown) => {
        this.log.warn({ err, engine: inst.id }, "provider stop failed");
        return "stopped" as const;
      },
    );
    const hard = delay(hardCloseMs);
    const outcome = await Promise.race([graceful, hard.promise]);
    hard.cancel();
    if (outcome === "timeout") {
      this.log.warn({ engine: inst.id, ms: hardCloseMs }, "provider stop timed out; hard-closing");
      provider.stop({ fast: true }).catch(() => undefined);
    }
    inst.closedAt = this.ctx.now();
    const openMs = Math.max(0, inst.closedAt - inst.openedAt);
    this.closedEngineMs += openMs;
    this.unreportedMs += Math.max(0, inst.closedAt - inst.usageReportedTo);
    inst.usageReportedTo = inst.closedAt;
    this.cost.addPeriod({ streamMs: openMs });
    this.instances.delete(inst.id);
    // Accounted first: closing its segment runs callbacks that may read the status.
    this.store.endEngine(inst.id);
    this.ctx.hooks.onMarker(
      "engine-close",
      { track: this.id, engine: inst.id, openMs, framesSent: inst.framesSent },
      `${this.id}: engine ${inst.id} closed after ${(openMs / 1000).toFixed(1)} s`,
    );
    this.ctx.hooks.onChange();
  }

  private onDone(seg: Segment): void {
    this.latency.addDone(seg);
    this.ctx.transcript?.addDone(seg);
    this.ctx.hooks.onChange();
  }
}
