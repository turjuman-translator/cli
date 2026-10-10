// Session registry: at most one local (device/file) session plus the caption-page sessions, the
// idle audio monitor and /health.
// Sessions get the "blocks" layout (fast blocks) when the block dependencies are
// there; otherwise "rollup" (logged once).

import type { Logger } from "pino";
import type { QuranFollowerApi } from "../compose/types.js";
import type { LoadedConfig, Secrets } from "../config.js";
import type { EventDetectorApi } from "../events/types.js";
import { type Glossary, loadGlossary } from "../glossary.js";
import { resolveIn } from "../paths.js";
import type {
  AudioState,
  CaptionLayout,
  Health,
  SessionSummary,
  Status,
} from "../shared/protocol.js";
import { frameLevel } from "../shared/vad.js";
import { Coalescer } from "./coalesce.js";
import {
  type AudioInputApi,
  type AudioInputSpec,
  type CaptionSessionApi,
  type EngineFactory,
  type LocalStartRequest,
  type PageSessionRequest,
  SessionError,
  type SessionListener,
  type SessionManagerApi,
} from "./contracts.js";
import { EMPTY_STATS } from "./metrics.js";
import {
  CaptionSession,
  FIRST_FRAME_TIMEOUT_MS,
  NO_SIGNAL_MS,
  newSessionId,
  RESUME_FIRST_FRAME_TIMEOUT_MS,
  type SessionBlocksOptions,
} from "./session.js";

/** Caption-block dependencies (absent → every session uses the rollup layout). */
export interface SessionBlocksDeps {
  detectorFactory(): EventDetectorApi | null;
  /** One Quran follower per session (default: no Quran). */
  followerFactory?: (targetLang: string) => QuranFollowerApi;
}

export interface SessionManagerOptions {
  loaded: LoadedConfig;
  engineFactory: EngineFactory;
  audioInputFactory: (spec: AudioInputSpec) => AudioInputApi;
  log: Logger;
  version: string;
  now?: () => number;
  blocks?: SessionBlocksDeps;
  /**
   * The API keys of an organisation (KeyResolver.resolve); default: the server's
   * .env keys for every organisation.
   */
  keys?: (orgId: string) => Secrets;
}

/** Local sessions and pages without an organisation run as the local one. */
const LOCAL_ORG = "local";

type LocalInput = { spec: AudioInputSpec; kind: "device" | "file" } | { error: string };

/** Level + status of the configured input while no local session runs. */
class IdleMonitor {
  private readonly input: AudioInputApi;
  private readonly levels: Coalescer<"level">;
  private readonly statuses: Coalescer<"status">;
  private ticker: NodeJS.Timeout | null = null;
  private audioState: AudioState;
  private lastStderr: string | null = null;
  private rms: number | null = null;
  private peak: number | null = null;
  private lastFrameAt: number | null = null;
  private lastLoudAt: number;
  private readonly startedAt: number;

  constructor(
    spec: AudioInputSpec,
    factory: (spec: AudioInputSpec) => AudioInputApi,
    private readonly loaded: LoadedConfig,
    private readonly emit: SessionListener,
    private readonly now: () => number,
  ) {
    this.input = factory(spec);
    this.audioState = this.input.state;
    this.startedAt = now();
    this.lastLoudAt = this.startedAt;
    this.levels = new Coalescer<"level">(() => this.emitLevel(), { intervalMs: 200, now });
    this.statuses = new Coalescer<"status">(
      () => this.emit({ type: "status", status: this.status() }),
      { intervalMs: 500, now },
    );
  }

  start(): void {
    this.input.start({
      onFrame: (frame) => this.onFrame(frame),
      onState: (state, detail) => {
        this.audioState = state;
        if (detail.lastStderr !== null) this.lastStderr = detail.lastStderr;
        this.statuses.push("status");
      },
    });
    this.ticker = setInterval(() => this.statuses.push("status"), 1000);
  }

  async stop(): Promise<void> {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    this.levels.dispose();
    this.statuses.dispose();
    await this.input.stop();
  }

  status(): Status {
    const now = this.now();
    const audio: Status["audio"] = {
      state: this.audioState,
      rmsDbfs: this.rms,
      lastFrameAgoMs: this.lastFrameAt === null ? null : Math.max(0, now - this.lastFrameAt),
      noSignal: now - this.lastLoudAt >= NO_SIGNAL_MS,
    };
    if (this.lastStderr !== null) audio.lastStderr = this.lastStderr;
    return {
      state: "idle",
      primary: "soniox",
      provider: "idle",
      audio,
      latency: EMPTY_STATS,
      tracks: [],
    };
  }

  private onFrame(frame: Uint8Array): void {
    const now = this.now();
    this.lastFrameAt = now;
    try {
      const level = frameLevel(frame);
      this.rms = level.rmsDbfs;
      this.peak = this.peak === null ? level.peakDbfs : Math.max(this.peak, level.peakDbfs);
      if (level.rmsDbfs >= this.loaded.config.audio.silenceWarnDbfs) this.lastLoudAt = now;
    } catch {
      return;
    }
    this.levels.push("level");
  }

  private emitLevel(): void {
    const rms = this.rms as number; // onFrame sets it before every level push
    const peak = this.peak ?? rms;
    this.peak = null;
    this.emit({
      type: "level",
      rmsDbfs: Math.round(rms * 100) / 100,
      peakDbfs: Math.round(peak * 100) / 100,
    });
  }
}

export class SessionManager implements SessionManagerApi {
  private readonly loaded: LoadedConfig;
  private readonly engineFactory: EngineFactory;
  private readonly audioInputFactory: (spec: AudioInputSpec) => AudioInputApi;
  private readonly log: Logger;
  private readonly version: string;
  private readonly now: () => number;
  private readonly startedAt: number;

  private readonly pages = new Map<string, CaptionSession>();
  private localSession: CaptionSession | null = null;
  private localBusy = false;
  private monitor: IdleMonitor | null = null;
  private monitorStopping: Promise<void> | null = null;
  private readonly monitorListeners = new Set<SessionListener>();
  private shuttingDown = false;
  private readonly blocksDeps: SessionBlocksDeps | null;
  private blocksFallbackLogged = false;
  private readonly keys: (orgId: string) => Secrets;
  /** The organisation of each page session. */
  private readonly pageOrgs = new Map<string, string>();

  constructor(opts: SessionManagerOptions) {
    this.loaded = opts.loaded;
    this.engineFactory = opts.engineFactory;
    this.audioInputFactory = opts.audioInputFactory;
    this.log = opts.log.child({ component: "sessions" });
    this.version = opts.version;
    this.now = opts.now ?? Date.now;
    this.blocksDeps = opts.blocks ?? null;
    const env = opts.loaded.secrets;
    this.keys = opts.keys ?? (() => env);
    this.startedAt = this.now();
  }

  // --- page sessions ---------------------------------------------------------------------------

  createPage(req: PageSessionRequest): CaptionSessionApi {
    if (this.shuttingDown) {
      throw new SessionError("engine_unavailable", "the server is shutting down");
    }
    const orgId = req.orgId ?? LOCAL_ORG;
    const secrets = (): Secrets => this.keys(orgId);
    const id = newSessionId();
    const glossary = this.glossaryFor(req.from, req.to);
    const requested: CaptionLayout = req.layout ?? this.loaded.config.display.layout;
    const blocks = requested === "blocks" ? this.blocksFor(id) : null;
    const layout: CaptionLayout = blocks === null ? "rollup" : "blocks";
    const missing = this.missingKey(orgId);
    if (missing !== null) throw new SessionError("engine_unavailable", missing);
    const session = new CaptionSession({
      id,
      layout,
      blocks,
      kind: "page",
      loaded: this.loaded,
      engineFactory: this.engineFactory,
      log: this.log,
      now: this.now,
      from: req.from,
      to: req.to,
      glossary,
      saveTranscripts: this.loaded.config.pages.savePageSessions,
      secrets,
      orgId,
      page: {
        keyId: req.keyId,
        keyLabel: req.keyLabel,
        client: req.client,
        ...(req.onUsage === undefined ? {} : { onUsage: req.onUsage }),
      },
      onStopped: (s) => {
        if (this.pages.get(s.id) === s) {
          this.pages.delete(s.id);
          this.pageOrgs.delete(s.id);
        }
      },
    });
    this.pages.set(session.id, session);
    this.pageOrgs.set(session.id, orgId);
    return session;
  }

  /** The organisation of a live session ("local" for the local session), or null. */
  orgOf(id: string): string | null {
    if (this.pages.has(id)) return this.pageOrgs.get(id) ?? LOCAL_ORG;
    return this.localSession?.id === id ? LOCAL_ORG : null;
  }

  get(id: string): CaptionSessionApi | undefined {
    const page = this.pages.get(id);
    if (page !== undefined) return page;
    return this.localSession?.id === id ? this.localSession : undefined;
  }

  list(): SessionSummary[] {
    const out: SessionSummary[] = [];
    if (this.localSession !== null && !this.localSession.stopped) {
      out.push(this.localSession.summary());
    }
    for (const s of this.pages.values()) if (!s.stopped) out.push(s.summary());
    return out;
  }

  // --- the local session ---------------------------------------------------------------------

  local(): CaptionSessionApi | null {
    return this.localSession;
  }

  /** `resume`: resume-after-restart (wait up to 10 s for the first frame instead of 5 s). */
  async startLocal(
    req: LocalStartRequest & { resume?: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    if (this.shuttingDown) return { ok: false, message: "the server is shutting down" };
    if (this.localBusy) return { ok: false, message: "a local session is starting or stopping" };
    const current = this.localSession;
    if (current?.running) {
      return { ok: false, message: `already live (session ${current.id})` };
    }
    const input = this.localInput(req);
    if ("error" in input) return { ok: false, message: input.error };
    const cfg = this.loaded.config;
    const from = cfg.stt.soniox.languageHints[0] ?? "auto";
    const to = cfg.translation.targetLanguage;
    const id = newSessionId();
    const glossary = this.glossaryFor(from, to);
    const secrets = (): Secrets => this.keys(LOCAL_ORG);
    const blocks = cfg.display.layout === "blocks" ? this.blocksFor(id) : null;
    const layout: CaptionLayout = blocks === null ? "rollup" : "blocks";
    const missing = this.missingKey(LOCAL_ORG);
    if (missing !== null) return { ok: false, message: missing };
    this.localBusy = true;
    try {
      // A previous session that is still stopping must release its input first.
      if (current !== null && !current.stopped) await current.stop("replaced by a new start");
      await this.stopMonitor();
      // stopAll() began while this start waited: it could not see (or stop) a session made now.
      if (this.shuttingDown) return { ok: false, message: "the server is shutting down" };
      const session = new CaptionSession({
        id,
        layout,
        blocks,
        kind: input.kind,
        loaded: this.loaded,
        engineFactory: this.engineFactory,
        log: this.log,
        now: this.now,
        from,
        to,
        glossary,
        saveTranscripts: true,
        secrets,
        local: { spec: input.spec, inputFactory: this.audioInputFactory },
        onStopped: () => this.ensureMonitor(),
      });
      this.localSession = session;
      return await session.startLocal({
        firstFrameTimeoutMs:
          req.resume === true ? RESUME_FIRST_FRAME_TIMEOUT_MS : FIRST_FRAME_TIMEOUT_MS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, "local session start failed");
      return { ok: false, message };
    } finally {
      this.localBusy = false;
      // A failed start gives the input back to the idle monitor.
      if (this.localSession === null || !this.localSession.running) this.ensureMonitor();
    }
  }

  async stopLocal(reason: string): Promise<{ ok: boolean; message: string }> {
    const session = this.localSession;
    if (session === null || !session.running) {
      return { ok: false, message: "no local session is running" };
    }
    await session.stop(reason);
    this.ensureMonitor();
    return { ok: true, message: `stopped (${reason})` };
  }

  // --- idle monitor -----------------------------------------------------------------------------

  subscribeMonitor(listener: SessionListener): () => void {
    this.monitorListeners.add(listener);
    this.ensureMonitor();
    // Without an audio input there is no monitor: the subscriber (the control dock) still hears
    // that the server is idle.
    const status: Status = this.monitor?.status() ?? {
      state: "idle",
      primary: "soniox",
      provider: "idle",
      audio: { state: "none", rmsDbfs: null, lastFrameAgoMs: null, noSignal: false },
      latency: EMPTY_STATS,
      tracks: [],
    };
    try {
      listener({ type: "status", status });
    } catch (err) {
      this.log.warn({ err }, "monitor listener threw");
    }
    return () => {
      this.monitorListeners.delete(listener);
    };
  }

  /** Start the idle monitor now (otherwise it starts with the first monitor subscriber). */
  startMonitor(): void {
    this.ensureMonitor();
  }

  // --- health, shutdown -----------------------------------------------------------------------

  health(): Health {
    return {
      ok: true,
      version: this.version,
      uptimeMs: this.now() - this.startedAt,
      exposure: this.loaded.config.server.exposure,
      local: this.localSession?.status() ?? null,
      sessions: this.list(),
    };
  }

  async stopAll(reason: string): Promise<void> {
    this.shuttingDown = true;
    const tasks: Array<Promise<void>> = [];
    for (const s of this.pages.values()) tasks.push(s.stop(reason, { fast: true }));
    if (this.localSession !== null) tasks.push(this.localSession.stop(reason, { fast: true }));
    tasks.push(this.stopMonitor());
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === "rejected") this.log.warn({ err: r.reason }, "stop during shutdown failed");
    }
  }

  // --- internals ---------------------------------------------------------------------------------

  /** Fast-blocks dependencies for a new session, or null → rollup layout (logged once). */
  private blocksFor(sessionId: string): SessionBlocksOptions | null {
    const deps = this.blocksDeps;
    if (deps === null) {
      if (!this.blocksFallbackLogged) {
        this.blocksFallbackLogged = true;
        this.log.warn(
          { sessionId, reason: "no block pipeline is configured" },
          "layout blocks falls back to rollup",
        );
      }
      return null;
    }
    let detector: EventDetectorApi | null = null;
    try {
      detector = deps.detectorFactory();
    } catch (err) {
      this.log.error({ err }, "event detector could not be created; events disabled");
    }
    const followerFactory = deps.followerFactory;
    return { detector, ...(followerFactory === undefined ? {} : { followerFactory }) };
  }

  /** A message when the organisation has no Soniox key, else null. */
  private missingKey(orgId: string): string | null {
    if (this.keys(orgId).sonioxApiKey !== null) return null;
    // Hosted mode: each organisation brings its own keys, added in the app.
    return this.loaded.config.mode === "hosted"
      ? "This mosque has no Soniox key yet: add it in the app under Keys"
      : "No Soniox key yet: add it in the app under Keys (or with turjuman setup)";
  }

  private glossaryFor(from: string, to: string): Glossary | null {
    if (from === "auto") return null;
    try {
      const loaded = loadGlossary(this.loaded.paths.glossariesDir, from, to);
      if (loaded === null) return null;
      for (const w of loaded.warnings) this.log.warn(w);
      return loaded.glossary;
    } catch (err) {
      this.log.warn({ err, from, to }, "glossary could not be loaded; continuing without it");
      return null;
    }
  }

  private localInput(req: LocalStartRequest): LocalInput {
    const input = this.loaded.config.audio.input;
    const dataDir = this.loaded.paths.dataDir;
    if (req.source === "file") {
      if (req.file !== undefined) {
        return {
          kind: "file",
          spec: { kind: "file", path: req.file, loop: req.loop ?? false, startAtSec: 0 },
        };
      }
      if (input.path === undefined) {
        return { error: "no file given (and audio.input.path is not set)" };
      }
      return {
        kind: "file",
        spec: {
          kind: "file",
          path: resolveIn(dataDir, input.path),
          loop: req.loop ?? input.loop,
          startAtSec: input.startAtSec,
        },
      };
    }
    switch (input.kind) {
      case "device":
        return { kind: "device", spec: { kind: "device", device: input.device } };
      case "network":
        return {
          kind: "device",
          spec: {
            kind: "network",
            port: input.network.port,
            sampleRate: input.network.sampleRate,
            channels: input.network.channels,
          },
        };
      case "file":
        if (input.path === undefined) return { error: "audio.input.path is not set" };
        return {
          kind: "file",
          spec: {
            kind: "file",
            path: resolveIn(dataDir, input.path),
            loop: req.loop ?? input.loop,
            startAtSec: input.startAtSec,
          },
        };
      case "none":
        return { error: "device capture is disabled (audio.input.kind: none)" };
    }
  }

  private monitorSpec(): AudioInputSpec | null {
    const cfg = this.loaded.config.audio;
    if (!cfg.monitorWhenIdle) return null;
    if (cfg.input.kind === "device") return { kind: "device", device: cfg.input.device };
    if (cfg.input.kind === "network") {
      return {
        kind: "network",
        port: cfg.input.network.port,
        sampleRate: cfg.input.network.sampleRate,
        channels: cfg.input.network.channels,
      };
    }
    return null;
  }

  private ensureMonitor(): void {
    if (this.shuttingDown || this.monitor !== null || this.localBusy) return;
    if (this.localSession?.running) return;
    const spec = this.monitorSpec();
    if (spec === null) return;
    // The previous monitor (or session input) has released the device/port by now: the callers
    // of stopMonitor() (startLocal, stopAll) hold localBusy / shuttingDown until it has, and a
    // session's input is stopped before its onStopped.
    try {
      const monitor = new IdleMonitor(
        spec,
        this.audioInputFactory,
        this.loaded,
        (msg) => {
          for (const l of [...this.monitorListeners]) {
            try {
              l(msg);
            } catch (err) {
              this.log.warn({ err }, "monitor listener threw");
            }
          }
        },
        this.now,
      );
      this.monitor = monitor;
      monitor.start();
    } catch (err) {
      this.monitor = null;
      this.log.warn({ err }, "idle audio monitor failed to start");
    }
  }

  private async stopMonitor(): Promise<void> {
    const monitor = this.monitor;
    if (monitor === null) {
      await this.monitorStopping;
      return;
    }
    this.monitor = null;
    const stopping = monitor.stop().catch((err: unknown) => {
      this.log.warn({ err }, "idle audio monitor stop failed");
    });
    this.monitorStopping = stopping;
    await stopping;
    if (this.monitorStopping === stopping) this.monitorStopping = null;
  }
}
