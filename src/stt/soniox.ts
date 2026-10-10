// Soniox real-time provider over the raw WebSocket protocol, with a dead-socket watchdog and a
// context fallback when Soniox rejects the session config.
import type { Logger } from "pino";
import { Backoff, PROVIDER_BACKOFF_MS } from "../core/backoff.js";
import type { SonioxContext } from "../glossary.js";
import { scrubSecrets } from "../log.js";
import type { TrackId } from "../shared/protocol.js";
import { type RecordingEntry, RecordingWriter } from "./recording.js";
import {
  EndpointDeduper,
  mapSonioxMessage,
  sessionStartsWithReconnect,
  sonioxErrorEvent,
} from "./soniox-map.js";
import { SonioxPauseDetector } from "./soniox-pause.js";
import {
  buildSonioxConfig,
  classifySonioxError,
  describeSonioxError,
  parseSonioxResponse,
  redactSonioxConfig,
  reduceSonioxContext,
  SONIOX_URLS,
  type SonioxRegion,
  type SonioxServerError,
  type SonioxSessionConfig,
} from "./soniox-protocol.js";
import type { ProviderCapabilities, ProviderEvent, ProviderState, SttProvider } from "./types.js";

const FRAME_MS = 100;
const FRAME_BYTES = 3200;
/** Pause finalizes are at least this far apart (each follows ≥ 500 ms without a new word). */
const PAUSE_FINALIZE_MIN_GAP_MS = 600;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export interface SonioxTimings {
  /** Abandon a connection attempt that has not opened after this long. */
  connectTimeoutMs: number;
  /** Send {"type":"keepalive"} after this long without audio (server closes after ~20 s). */
  keepaliveAfterMs: number;
  /** Minimum gap between {"type":"finalize"} messages (Soniox: not every few seconds). */
  finalizeMinIntervalMs: number;
  /** Watchdog: this much audio sent and this long without any server message → reconnect. */
  watchdogMs: number;
  /** Watchdog: ws.bufferedAmount above this on two checks in a row → reconnect. */
  maxBufferedBytes: number;
  /** Reset the reconnect backoff after this long live. */
  backoffResetAfterMs: number;
  /** stop(): how long to wait for `finished` (fast: fastStopTimeoutMs). */
  stopTimeoutMs: number;
  fastStopTimeoutMs: number;
  /** Housekeeping interval: keepalive, watchdog, backpressure. */
  tickMs: number;
  /** Frames buffered while not yet connected (50 = 5 s); the oldest are dropped beyond it. */
  preConnectFrames: number;
}

export const SONIOX_TIMINGS: Readonly<SonioxTimings> = {
  connectTimeoutMs: 10_000,
  keepaliveAfterMs: 5_000,
  finalizeMinIntervalMs: 2_000,
  watchdogMs: 10_000,
  maxBufferedBytes: 65_536,
  backoffResetAfterMs: 30_000,
  stopTimeoutMs: 5_000,
  fastStopTimeoutMs: 1_000,
  tickMs: 1_000,
  preConnectFrames: 50,
};

export interface SonioxProviderOptions {
  apiKey: string;
  region: SonioxRegion;
  /** e.g. "stt-rt-v5". */
  model: string;
  /** Source language code, or "auto" (no language_hints). */
  from: string;
  /** Extra language hints after `from` (config stt.soniox.languageHints). */
  languageHints?: readonly string[];
  /** One-way translation target; null = no translation block (speech recognition only). */
  targetLanguage: string | null;
  /** From buildSonioxContext(glossary, { nativeTranslation }); null = no context. */
  context: SonioxContext | null;
  endpointDetection: boolean;
  /** 500–3000, or null for the Soniox default. */
  maxEndpointDelayMs: number | null;
  /** Endpoint tuning (null = Soniox defaults). */
  endpointLatencyLevel?: number | null;
  endpointSensitivity?: number | null;
  /** Finalize when Soniox has processed this much audio after the newest
   *  unfinalized word (a pause, even in a noisy room); null/0 = off. */
  pauseFinalizeMs?: number | null;
  /** provider.jsonl path, or null. */
  recordFile: string | null;
  log: Logger;
  /** Override the WebSocket URL (tests, fault injection). */
  url?: string;
  now?: () => number;
  track?: TrackId;
  /** Capability flag: an utterance's translation is complete at its endpoint (default false). */
  translationFinalAtEndpoint?: boolean;
  /** Test hook: shorter timers. */
  timings?: Partial<SonioxTimings>;
}

export interface SonioxStats {
  /** Frames passed to sendAudio (including dropped ones). */
  framesIn: number;
  framesSent: number;
  framesDropped: number;
  /** Provider sessions that went live. */
  sessions: number;
  reconnects: number;
  messages: number;
  finalizeSent: number;
  finalizeSkipped: number;
  keepalivesSent: number;
}

/** One WebSocket connection = one Soniox session once live. */
interface Conn {
  ws: WebSocket;
  config: SonioxSessionConfig;
  /** Provider session index, set when the session goes live. */
  index: number | null;
  live: boolean;
  /** A non-error frame has arrived (an error before this counts as "at session start"). */
  hadFrame: boolean;
  finished: boolean;
  closed: boolean;
  /** The recording has this session's close line (written at stop when the close lags). */
  closeRecorded: boolean;
  closedPromise: Promise<void>;
  onFinished: (() => void) | null;
}

type Timer = ReturnType<typeof setTimeout>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves when `p` settles or after `ms`, whichever is first (the timer is cleared). */
async function within(p: Promise<void>, ms: number): Promise<void> {
  let timer: Timer | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([p, timeout]);
  clearTimeout(timer);
}

/**
 * SttProvider for Soniox real-time (stt-rt-v5) with native one-way translation.
 *
 * - start() resolves once the first connection attempt has settled (live, reconnecting or
 *   error); provider errors arrive as `error`/`state` events, never as rejections.
 * - Audio sent before the connection is live (or before start) is buffered (≤ 5 s) and
 *   flushed right after the config message; audio sent while reconnecting is dropped but
 *   counted, and the next session reports its input position in `reconnected`.
 * - start() after stop() is allowed: counters and the recording continue, and the new
 *   session starts with `reconnected` (its token ms are relative to that session).
 */
export class SonioxProvider implements SttProvider {
  readonly track: TrackId;
  readonly capabilities: ProviderCapabilities;

  private readonly opts: SonioxProviderOptions;
  private readonly url: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly timings: SonioxTimings;
  private readonly backoff = new Backoff(PROVIDER_BACKOFF_MS);
  private readonly endpoints = new EndpointDeduper();
  private readonly pause: SonioxPauseDetector | null;

  private _state: ProviderState = "idle";
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private running = false;
  private stopping = false;
  /** The context left after the reductions so far (sticky for this provider); undefined = none. */
  private reducedContext: SonioxContext | null | undefined = undefined;
  private conn: Conn | null = null;
  private recorder: RecordingWriter | null = null;
  /** Wall time of the first start(): recording times are relative to it. */
  private t0 = 0;
  private startedBefore = false;
  private gapStartedAt: number | null = null;
  private preBuffer: Uint8Array[] = [];
  private startSettled: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  private backoffResetTimer: Timer | null = null;

  private lastServerMsgAt = 0;
  private lastAudioSentAt = 0;
  private lastKeepaliveAt = 0;
  private lastFinalizeAt = Number.NEGATIVE_INFINITY;
  private framesSinceServerMsg = 0;
  private overBufferedTicks = 0;

  private readonly counters: SonioxStats = {
    framesIn: 0,
    framesSent: 0,
    framesDropped: 0,
    sessions: 0,
    reconnects: 0,
    messages: 0,
    finalizeSent: 0,
    finalizeSkipped: 0,
    keepalivesSent: 0,
  };

  constructor(opts: SonioxProviderOptions) {
    this.opts = opts;
    this.track = opts.track ?? "soniox";
    this.url = opts.url ?? SONIOX_URLS[opts.region];
    this.now = opts.now ?? Date.now;
    this.timings = { ...SONIOX_TIMINGS, ...opts.timings };
    this.log = opts.log.child({ provider: "soniox", track: this.track });
    const pauseMs = opts.pauseFinalizeMs ?? 0;
    this.pause = pauseMs > 0 ? new SonioxPauseDetector(pauseMs) : null;
    this.capabilities = {
      nativeTranslation: opts.targetLanguage !== null,
      timing: "provider",
      translationFinalAtEndpoint: opts.translationFinalAtEndpoint ?? false,
    };
  }

  get state(): ProviderState {
    return this._state;
  }

  stats(): SonioxStats {
    return { ...this.counters };
  }

  async start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    if (this.stopPromise !== null) await this.stopPromise;
    if (this.running) throw new Error("SonioxProvider: already started");
    this.onEvent = opts.onEvent;
    this.running = true;
    this.stopping = false;
    this.backoff.reset();
    const config = this.buildConfig(opts.sessionId);
    const firstStart = !this.startedBefore;
    if (firstStart) {
      this.startedBefore = true;
      this.t0 = this.now();
    }
    if (this.opts.recordFile !== null && this.recorder === null) {
      this.openRecorder(this.opts.recordFile, config, firstStart);
    }
    this.setState("connecting");
    this.tickTimer = setInterval(() => this.guard("tick", () => this.tick()), this.timings.tickMs);
    const settled = new Promise<void>((resolve) => {
      this.startSettled = resolve;
    });
    this.connect(config);
    await settled;
  }

  sendAudio(frame: Uint8Array): void {
    this.counters.framesIn++;
    const conn = this.conn;
    if (conn?.live && !this.stopping) {
      this.sendFrame(conn, frame);
      return;
    }
    if (!this.stopping && (this._state === "connecting" || this._state === "idle")) {
      this.preBuffer.push(frame.slice());
      if (this.preBuffer.length > this.timings.preConnectFrames) {
        this.preBuffer.shift();
        this.counters.framesDropped++;
      }
      return;
    }
    this.counters.framesDropped++;
  }

  finalize(): void {
    const conn = this.conn;
    if (conn === null || !conn.live || this.stopping) return;
    const now = this.now();
    if (now - this.lastFinalizeAt < this.timings.finalizeMinIntervalMs) {
      this.counters.finalizeSkipped++;
      this.log.debug("finalize skipped (rate limit)");
      return;
    }
    if (this.sendText(conn, JSON.stringify({ type: "finalize" }))) {
      this.lastFinalizeAt = now;
      this.counters.finalizeSent++;
    }
  }

  /** A pause seen in Soniox's word timing: finalize (own, shorter rate limit). */
  private pauseFinalize(conn: Conn, now: number): void {
    if (this.stopping || now - this.lastFinalizeAt < PAUSE_FINALIZE_MIN_GAP_MS) return;
    if (this.sendText(conn, JSON.stringify({ type: "finalize" }))) {
      this.lastFinalizeAt = now;
      this.counters.finalizeSent++;
    }
  }

  stop(opts?: { fast?: boolean }): Promise<void> {
    if (this.stopPromise === null) {
      this.stopPromise = this.doStop(opts?.fast === true).finally(() => {
        this.stopPromise = null;
      });
    }
    return this.stopPromise;
  }

  // --- connection lifecycle ------------------------------------------------------------------

  private buildConfig(sessionId: string): SonioxSessionConfig {
    const o = this.opts;
    return buildSonioxConfig({
      apiKey: o.apiKey,
      model: o.model,
      from: o.from,
      languageHints: o.languageHints,
      targetLanguage: o.targetLanguage,
      context: this.reducedContext === undefined ? o.context : this.reducedContext,
      endpointDetection: o.endpointDetection,
      maxEndpointDelayMs: o.maxEndpointDelayMs,
      endpointLatencyLevel: o.endpointLatencyLevel ?? null,
      endpointSensitivity: o.endpointSensitivity ?? null,
      sessionId,
    });
  }

  private openRecorder(file: string, config: SonioxSessionConfig, first: boolean): void {
    try {
      this.recorder = new RecordingWriter(
        file,
        {
          kind: "meta",
          provider: "soniox",
          version: 1,
          startedAt: this.t0,
          config: redactSonioxConfig(config),
        },
        {
          append: !first,
          secrets: [this.opts.apiKey],
          onError: (err) => this.log.warn({ err }, "provider recording failed; recording stopped"),
        },
      );
    } catch (err) {
      this.log.warn({ err }, "cannot open provider recording");
    }
  }

  /**
   * Opens a connection. Called by start() and by the reconnect timer: neither can run while
   * stopping or after a fatal error (stop() and fail() clear the timer), so the provider is running.
   */
  private connect(config: SonioxSessionConfig): void {
    this.reconnectTimer = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.fail(`Soniox: cannot open ${this.url}: ${errorMessage(err)}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    const conn: Conn = {
      ws,
      config,
      index: null,
      live: false,
      hadFrame: false,
      finished: false,
      closed: false,
      closeRecorded: false,
      closedPromise: new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve());
      }),
      onFinished: null,
    };
    this.conn = conn;
    // Cleared whenever this connection opens or is dropped: when it fires, `conn` is current.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.log.warn({ timeoutMs: this.timings.connectTimeoutMs }, "Soniox connect timeout");
      this.discard(conn, "connect timeout");
      this.scheduleReconnect(conn.config, "connect timeout");
    }, this.timings.connectTimeoutMs);
    ws.addEventListener("open", () => this.guard("open", () => this.onOpen(conn)));
    ws.addEventListener("message", (ev) => {
      const data: unknown = ev.data;
      this.guard("message", () => this.onMessage(conn, data));
    });
    ws.addEventListener("error", () => {
      if (this.conn === conn) this.log.debug("Soniox socket error (close follows)");
    });
    ws.addEventListener("close", (ev) => {
      conn.closed = true;
      this.guard("close", () => this.onClose(conn, ev.code, ev.reason));
    });
  }

  private onOpen(conn: Conn): void {
    // A dropped connection whose close failed may still open. (stop() drops a connecting one at
    // once, so the current connection never opens while stopping.)
    if (this.conn !== conn) return;
    this.clearConnectTimer();
    this.pause?.reset(); // audio time restarts with every Soniox session
    if (!this.sendText(conn, JSON.stringify(conn.config))) {
      this.discard(conn, "config send failed");
      this.scheduleReconnect(conn.config, "could not send the session config");
      return;
    }
    const now = this.now();
    const index = this.counters.sessions++;
    conn.index = index;
    conn.live = true;
    this.endpoints.reset();
    const audioOffsetMs = (this.counters.framesIn - this.preBuffer.length) * FRAME_MS;
    const gapMs = this.gapStartedAt === null ? null : Math.max(0, now - this.gapStartedAt);
    this.gapStartedAt = null;
    const t = this.t(now);
    this.record(
      gapMs === null
        ? { t, kind: "session", index, audioOffsetMs }
        : { t, kind: "session", index, audioOffsetMs, gapMs },
    );
    this.lastServerMsgAt = now;
    this.lastKeepaliveAt = now;
    this.framesSinceServerMsg = 0;
    this.overBufferedTicks = 0;
    const buffered = this.preBuffer;
    this.preBuffer = [];
    for (const frame of buffered) this.sendFrame(conn, frame);
    this.log.info(
      { session: index, audioOffsetMs, gapMs, flushedFrames: buffered.length },
      "Soniox session live",
    );
    this.setState("live");
    if (sessionStartsWithReconnect(index, audioOffsetMs)) {
      if (index > 0) this.counters.reconnects++;
      this.emit({ type: "reconnected", gapMs: gapMs ?? 0, audioOffsetMs });
    }
    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = null;
      this.backoff.reset();
    }, this.timings.backoffResetAfterMs);
    this.settleStart();
  }

  private onMessage(conn: Conn, data: unknown): void {
    const receivedAt = this.now();
    if (typeof data !== "string") {
      this.log.warn("Soniox sent a binary frame; ignored");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.log.warn("Soniox sent invalid JSON; ignored");
      return;
    }
    if (conn.index !== null)
      this.record({ t: this.t(receivedAt), kind: "msg", session: conn.index, data: raw });
    if (this.conn !== conn) return;
    this.counters.messages++;
    this.lastServerMsgAt = receivedAt;
    this.framesSinceServerMsg = 0;
    const parsed = parseSonioxResponse(raw);
    if (!parsed.ok) {
      this.log.warn({ reason: parsed.reason }, "Soniox frame failed validation; ignored");
      return;
    }
    if (parsed.droppedTokens > 0) {
      this.log.warn({ dropped: parsed.droppedTokens }, "Soniox frame had malformed tokens");
    }
    const { msg } = parsed;
    if (msg.error !== null) {
      this.onServerError(conn, msg.error);
      return;
    }
    conn.hadFrame = true;
    const events = mapSonioxMessage(msg, { targetLanguage: this.opts.targetLanguage, receivedAt });
    for (const e of this.endpoints.apply(events)) this.emit(e);
    if (this.pause?.onResponse(msg) === true) this.pauseFinalize(conn, receivedAt);
    if (msg.finished) {
      conn.finished = true;
      conn.onFinished?.();
    }
  }

  private onServerError(conn: Conn, err: SonioxServerError): void {
    const message = this.scrub(describeSonioxError(err));
    if (this.stopping) {
      this.log.warn({ message }, "Soniox error while stopping");
      conn.onFinished?.();
      return;
    }
    if (err.code === 400 && !conn.hadFrame) {
      const reduced = reduceSonioxContext(conn.config);
      if (reduced !== null) {
        this.reducedContext = reduced.config.context ?? null;
        const event = sonioxErrorEvent(err, `retrying without ${reduced.dropped}`);
        this.log.warn(
          { message },
          `Soniox rejected the config; retrying without ${reduced.dropped}`,
        );
        this.emit({ ...event, message: this.scrub(event.message) });
        this.discard(conn, "config rejected");
        this.scheduleReconnect(
          reduced.config,
          `config rejected; retrying without ${reduced.dropped}`,
          0,
        );
        return;
      }
    }
    if (classifySonioxError(err.code, err.type) === "fatal") {
      this.fail(message);
      return;
    }
    this.log.warn({ message }, "Soniox error; reconnecting");
    this.emit({ type: "error", fatal: false, message });
    this.discard(conn, "server error");
    // 413 = the 300-minute session cap: open a new session right away.
    this.scheduleReconnect(conn.config, message, err.code === 413 ? 0 : undefined);
  }

  private onClose(conn: Conn, code: number, reason: string): void {
    if (conn.index !== null && !conn.closeRecorded) {
      conn.closeRecorded = true;
      this.record({ t: this.t(this.now()), kind: "close", session: conn.index, code, reason });
    }
    if (this.conn !== conn) return;
    this.conn = null;
    this.clearConnectTimer();
    if (this.stopping) {
      conn.onFinished?.();
      return;
    }
    const detail = this.scrub(
      `${conn.live ? "connection closed" : "connection failed"} (${code}${reason !== "" ? ` ${reason}` : ""})`,
    );
    this.log.warn({ code, reason }, `Soniox ${detail}`);
    this.scheduleReconnect(conn.config, detail);
  }

  /**
   * Callers have just dropped the current connection of a running provider that is not stopping
   * (no reconnect can be pending while a connection is current).
   */
  private scheduleReconnect(config: SonioxSessionConfig, reason: string, delayMs?: number): void {
    this.clearTimer("backoffResetTimer");
    if (this.gapStartedAt === null) this.gapStartedAt = this.now();
    if (this.preBuffer.length > 0) {
      this.counters.framesDropped += this.preBuffer.length;
      this.preBuffer = [];
    }
    const wait = delayMs ?? this.backoff.next();
    this.log.info(
      { delayMs: wait, attempt: this.backoff.attempts, reason },
      "Soniox reconnect scheduled",
    );
    this.setState("reconnecting", reason);
    this.reconnectTimer = setTimeout(
      () => this.guard("reconnect", () => this.connect(config)),
      wait,
    );
    this.settleStart();
  }

  /** Fatal: auth/config/quota. No retry; state stays "error" until stop() or start(). */
  private fail(message: string): void {
    this.log.error({ message }, "Soniox fatal error; not retrying");
    this.running = false;
    this.stopTimers();
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) this.closeSocket(conn, "fatal error");
    this.counters.framesDropped += this.preBuffer.length;
    this.preBuffer = [];
    this.emit({ type: "error", fatal: true, message });
    this.setState("error", message);
    this.settleStart();
  }

  private async doStop(fast: boolean): Promise<void> {
    this.stopping = true;
    this.stopTimers();
    const conn = this.conn;
    if (conn !== null) {
      if (conn.live && conn.ws.readyState === WS_OPEN) {
        // 200 ms of silence lets Soniox finalize the last word, then finalize + end of stream.
        const zeros = new Uint8Array(FRAME_BYTES);
        this.sendRaw(conn, zeros);
        this.sendRaw(conn, zeros);
        this.sendText(conn, JSON.stringify({ type: "finalize" }));
        this.sendText(conn, "");
        const timeoutMs = fast ? this.timings.fastStopTimeoutMs : this.timings.stopTimeoutMs;
        const finished = await this.waitFinished(conn, timeoutMs);
        if (!finished) this.log.warn({ timeoutMs }, "Soniox did not confirm end of stream in time");
      }
      this.conn = null;
      this.closeSocket(conn, "stop");
      // Soniox closes ~1.1 s after `finished`; don't hold stop() for it, but keep the
      // recording complete (the late close event is then not recorded again).
      await within(conn.closedPromise, fast ? 200 : 1000);
      if (!conn.closed && conn.index !== null) {
        conn.closeRecorded = true;
        this.record({
          t: this.t(this.now()),
          kind: "close",
          session: conn.index,
          reason: "stopped (server close pending)",
        });
      }
    }
    this.counters.framesDropped += this.preBuffer.length;
    this.preBuffer = [];
    this.running = false;
    this.stopping = false;
    this.gapStartedAt = this.now();
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder !== null) await recorder.close();
    this.setState("idle");
    this.settleStart();
  }

  private waitFinished(conn: Conn, timeoutMs: number): Promise<boolean> {
    // `conn` is current, so not closed yet (onClose drops a closed one at once).
    if (conn.finished) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        conn.onFinished = null;
        resolve(false);
      }, timeoutMs);
      conn.onFinished = () => {
        clearTimeout(timer);
        conn.onFinished = null;
        resolve(true);
      };
    });
  }

  // --- housekeeping ---------------------------------------------------------------------------

  /** Runs while started (stop() clears the interval before anything else). */
  private tick(): void {
    const conn = this.conn;
    if (conn === null || !conn.live) return;
    const now = this.now();
    const silentForMs = now - this.lastServerMsgAt;
    // Audio has been flowing but the server has gone quiet → assume a dead socket.
    if (
      this.framesSinceServerMsg * FRAME_MS >= this.timings.watchdogMs &&
      silentForMs >= this.timings.watchdogMs
    ) {
      this.restartConn(
        conn,
        `no server message for ${Math.round(silentForMs / 1000)} s while sending audio`,
      );
      return;
    }
    if (conn.ws.bufferedAmount > this.timings.maxBufferedBytes) {
      this.overBufferedTicks++;
      if (this.overBufferedTicks >= 2) {
        this.restartConn(conn, `send buffer at ${conn.ws.bufferedAmount} bytes`);
        return;
      }
    } else {
      this.overBufferedTicks = 0;
    }
    if (
      now - Math.max(this.lastAudioSentAt, this.lastKeepaliveAt) >=
      this.timings.keepaliveAfterMs
    ) {
      if (this.sendText(conn, JSON.stringify({ type: "keepalive" }))) {
        this.lastKeepaliveAt = now;
        this.counters.keepalivesSent++;
      }
    }
  }

  private restartConn(conn: Conn, reason: string): void {
    this.log.warn({ reason }, "Soniox connection stalled; reconnecting");
    this.emit({
      type: "error",
      fatal: false,
      message: `Soniox connection stalled (${reason}); reconnecting`,
    });
    this.discard(conn, "stalled");
    this.scheduleReconnect(conn.config, reason);
  }

  // --- helpers -------------------------------------------------------------------------------

  private sendFrame(conn: Conn, frame: Uint8Array): void {
    if (!this.sendRaw(conn, frame)) {
      this.counters.framesDropped++;
      return;
    }
    this.counters.framesSent++;
    this.lastAudioSentAt = this.now();
    this.framesSinceServerMsg++;
  }

  private sendRaw(conn: Conn, data: Uint8Array): boolean {
    try {
      conn.ws.send(data);
      return true;
    } catch (err) {
      this.log.debug({ err: errorMessage(err) }, "Soniox send failed");
      return false;
    }
  }

  private sendText(conn: Conn, text: string): boolean {
    try {
      conn.ws.send(text);
      return true;
    } catch (err) {
      this.log.debug({ err: errorMessage(err) }, "Soniox send failed");
      return false;
    }
  }

  /** Drops the current connection; its late events are ignored (its close is still recorded). */
  private discard(conn: Conn, reason: string): void {
    this.conn = null;
    this.clearConnectTimer();
    this.closeSocket(conn, reason);
  }

  private closeSocket(conn: Conn, reason: string): void {
    const state = conn.ws.readyState;
    if (state !== WS_CONNECTING && state !== WS_OPEN) return;
    try {
      conn.ws.close(1000, reason.slice(0, 100));
    } catch (err) {
      this.log.debug({ err: errorMessage(err) }, "Soniox close failed");
    }
  }

  private stopTimers(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.clearTimer("reconnectTimer");
    this.clearTimer("connectTimer");
    this.clearTimer("backoffResetTimer");
  }

  private clearConnectTimer(): void {
    this.clearTimer("connectTimer");
  }

  private clearTimer(name: "reconnectTimer" | "connectTimer" | "backoffResetTimer"): void {
    const timer = this[name];
    if (timer !== null) clearTimeout(timer);
    this[name] = null;
  }

  private setState(state: ProviderState, detail?: string): void {
    if (this._state === state) return;
    this._state = state;
    this.emit(detail === undefined ? { type: "state", state } : { type: "state", state, detail });
  }

  private emit(e: ProviderEvent): void {
    try {
      this.onEvent?.(e);
    } catch (err) {
      this.log.error({ err }, "provider event handler threw");
    }
  }

  private settleStart(): void {
    const settle = this.startSettled;
    this.startSettled = null;
    settle?.();
  }

  private record(line: RecordingEntry): void {
    this.recorder?.write(line);
  }

  private t(now: number): number {
    return now - this.t0;
  }

  private scrub(text: string): string {
    return scrubSecrets(text, [this.opts.apiKey]);
  }

  /** Socket/timer callbacks must never throw (an EventTarget listener error crashes Node). */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error({ err, what }, "Soniox provider internal error");
    }
  }
}
