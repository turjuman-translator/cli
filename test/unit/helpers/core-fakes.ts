// Fakes for the session-layer tests (src/core): a config, a log that records its lines, a
// provider the test drives by hand, an audio input the test feeds by hand, and PCM frames.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, pino } from "pino";
import type { LoadedConfig, Secrets } from "../../../src/config.js";
import { parseConfig } from "../../../src/config.js";
import type {
  AudioInputApi,
  AudioInputHandlers,
  AudioInputSpec,
  EngineFactory,
  EngineRequest,
} from "../../../src/core/contracts.js";
import type { AudioState, ProviderState, TrackId } from "../../../src/shared/protocol.js";
import type {
  ProviderCapabilities,
  ProviderEvent,
  SttProvider,
  Token,
} from "../../../src/stt/types.js";

export const FRAME_BYTES = 3200;
export const KEYS: Secrets = { sonioxApiKey: "test-soniox-key" };
export const NO_KEYS: Secrets = { sonioxApiKey: null };

// --- temp folders ---------------------------------------------------------------------------

export function tempDirs(prefix: string): { make(): string; cleanup(): void } {
  const made: string[] = [];
  return {
    make() {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      made.push(dir);
      return dir;
    },
    cleanup() {
      for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

// --- config ---------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

/** A validated config (defaults + `over`) with every path inside `dataDir`. */
export function testConfig(dataDir: string, over: Raw = {}, secrets: Secrets = KEYS): LoadedConfig {
  const parsed = parseConfig(over, { inContainer: false, bindAddress: null });
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return {
    config: parsed.config,
    paths: {
      configDir: dataDir,
      dataDir,
      configFile: null,
      languagesFile: join(dataDir, "languages.yaml"),
      glossariesDir: join(dataDir, "glossaries"),
      keysFile: join(dataDir, "keys.yaml"),
      usersFile: join(dataDir, "users.yaml"),
      screensFile: join(dataDir, "screens.yaml"),
      secretFile: join(dataDir, "secret.key"),
      orgsFile: join(dataDir, "orgs.yaml"),
      masterKeyFile: join(dataDir, "master.key"),
      tlsCertFile: join(dataDir, "tls", "server.crt"),
      tlsKeyFile: join(dataDir, "tls", "server.key"),
      tlsCaFile: join(dataDir, "tls", "ca.crt"),
      transcriptsDir: join(dataDir, "transcripts"),
      recordingsDir: join(dataDir, "recordings"),
      benchDir: join(dataDir, "bench"),
      stateDir: join(dataDir, "state"),
      usageDir: join(dataDir, "usage"),
      presetsFile: join(dataDir, "presets.yaml"),
      quranDir: join(dataDir, "quran"),
      quranTextFile: join(dataDir, "quran", "quran-simple-clean.txt"),
      quranUthmaniFile: join(dataDir, "quran", "quran-uthmani.txt"),
      quranTranslations: {},
      exportsDir: join(dataDir, "exports"),
    },
    secrets,
    warnings: [],
    context: { inContainer: false, bindAddress: null },
  };
}

// --- log ------------------------------------------------------------------------------------

export interface LogLine {
  level: number;
  msg: string;
  [key: string]: unknown;
}

/** A pino logger whose lines (debug and up) are kept in `lines`. */
export function captureLog(): {
  log: Logger;
  lines: LogLine[];
  messages(level?: number): string[];
} {
  const lines: LogLine[] = [];
  const log = pino(
    { level: "debug" },
    {
      write(s: string) {
        lines.push(JSON.parse(s) as LogLine);
      },
    },
  );
  return {
    log,
    lines,
    messages: (level) =>
      lines.filter((l) => level === undefined || l.level === level).map((l) => l.msg),
  };
}

export const WARN = 40;
export const ERROR = 50;

// --- PCM frames -----------------------------------------------------------------------------

/** 100 ms of a 440 Hz tone (loud enough for the VAD and the "no signal" check). */
export function toneFrame(amplitude = 0.3): Uint8Array {
  const out = new Uint8Array(FRAME_BYTES);
  const view = new DataView(out.buffer);
  for (let i = 0; i < FRAME_BYTES / 2; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / 16_000) * amplitude * 32767;
    view.setInt16(i * 2, Math.round(v), true);
  }
  return out;
}

export function silentFrame(): Uint8Array {
  return new Uint8Array(FRAME_BYTES);
}

// --- provider -------------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface ControlledOptions {
  /** "live" (default): start() resolves at once; "manual": the test calls `connect()`/`failStart()`. */
  start?: "live" | "manual" | "throw";
  /**
   * "resolve" (default), "reject", "manual" (the first stop waits for `finishStop()`) or
   * "manual-then-reject" (the first stop waits, later ones fail).
   */
  stop?: "resolve" | "manual" | "reject" | "manual-then-reject";
  capabilities?: Partial<ProviderCapabilities>;
  sendAudioThrows?: boolean;
  finalizeThrows?: boolean;
}

/** An SttProvider the test drives: it records calls and emits what the test tells it to. */
export class ControlledProvider implements SttProvider {
  readonly track: TrackId = "soniox";
  readonly capabilities: ProviderCapabilities;
  state: ProviderState = "idle";
  onEvent: ((e: ProviderEvent) => void) | null = null;
  frames = 0;
  finalizeCalls = 0;
  stopCalls: Array<{ fast?: boolean } | undefined> = [];
  private readonly startGate = deferred();
  private stopGate = deferred();

  constructor(private readonly opts: ControlledOptions = {}) {
    this.capabilities = {
      nativeTranslation: true,
      timing: "provider",
      translationFinalAtEndpoint: true,
      ...opts.capabilities,
    };
  }

  start(o: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    if (this.opts.start === "throw") throw new Error("start threw synchronously");
    this.onEvent = o.onEvent;
    this.state = "connecting";
    if (this.opts.start === "manual") return this.startGate.promise;
    this.state = "live";
    return Promise.resolve();
  }

  /** Manual start: the connection is live. */
  connect(): void {
    this.state = "live";
    this.startGate.resolve();
  }

  /** Manual start: the connect failed (`fatal` → state "error"). */
  failStart(message: string, fatal = false): void {
    this.rejectStart(new Error(message), fatal);
  }

  /** Manual start: the connect failed with any value (not only an Error). */
  rejectStart(reason: unknown, fatal = false): void {
    this.state = fatal ? "error" : "reconnecting";
    this.startGate.reject(reason);
  }

  sendAudio(_frame: Uint8Array): void {
    this.frames++;
    if (this.opts.sendAudioThrows === true) throw new Error("socket closed");
  }

  finalize(): void {
    this.finalizeCalls++;
    if (this.opts.finalizeThrows === true) throw new Error("finalize failed");
  }

  stop(o?: { fast?: boolean }): Promise<void> {
    this.stopCalls.push(o);
    const stop = this.opts.stop;
    if (stop === "reject") return Promise.reject(new Error("stop failed"));
    if ((stop === "manual" || stop === "manual-then-reject") && this.stopCalls.length === 1) {
      return this.stopGate.promise;
    }
    if (stop === "manual-then-reject") return Promise.reject(new Error("hard close failed"));
    this.state = "idle";
    return Promise.resolve();
  }

  /** Manual stop: the graceful stop finished. */
  finishStop(): void {
    this.state = "idle";
    this.stopGate.resolve();
    this.stopGate = deferred();
  }

  emit(e: ProviderEvent): void {
    this.onEvent?.(e);
  }

  tokens(final: Token[], nonFinal: Token[] = [], receivedAt = Date.now()): void {
    this.emit({ type: "tokens", final, nonFinal, receivedAt });
  }

  endpoint(receivedAt = Date.now()): void {
    this.emit({ type: "endpoint", receivedAt });
  }
}

export const src = (text: string, startMs?: number, endMs?: number, lang = "ar"): Token => ({
  text,
  kind: "source",
  lang,
  ...(startMs === undefined ? {} : { startMs }),
  ...(endMs === undefined ? {} : { endMs }),
});

export const tr = (text: string, lang = "nl"): Token => ({ text, kind: "translation", lang });

export interface ControlledFactory {
  factory: EngineFactory;
  providers: ControlledProvider[];
  requests: EngineRequest[];
  /** Options for the next providers (shifted per engine; the last one stays). */
  next: ControlledOptions[];
  /** Make the factory throw this (EngineUnavailableError, …) instead of building a provider. */
  failWith: Error | null;
}

export function controlledFactory(...next: ControlledOptions[]): ControlledFactory {
  const out: ControlledFactory = {
    providers: [],
    requests: [],
    next,
    failWith: null,
    factory: (req) => {
      if (out.failWith !== null) throw out.failWith;
      out.requests.push(req);
      const opts = out.next.length > 1 ? (out.next.shift() ?? {}) : (out.next[0] ?? {});
      const provider = new ControlledProvider(opts);
      out.providers.push(provider);
      return { provider };
    },
  };
  return out;
}

// --- audio input ----------------------------------------------------------------------------

/** An AudioInputApi the test feeds by hand. */
export class ManualInput implements AudioInputApi {
  handlers: AudioInputHandlers | null = null;
  current: AudioState;
  stderr: string | null = null;
  started = false;
  stopped = false;
  stopBehaviour: "resolve" | "reject" | "hang" = "resolve";

  constructor(
    readonly spec: AudioInputSpec,
    initial: AudioState = "idle",
  ) {
    this.current = initial;
  }

  get state(): AudioState {
    return this.current;
  }

  get lastStderr(): string | null {
    return this.stderr;
  }

  start(handlers: AudioInputHandlers): void {
    this.started = true;
    this.handlers = handlers;
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.stopBehaviour === "reject") return Promise.reject(new Error("input stop failed"));
    if (this.stopBehaviour === "hang") return new Promise(() => {});
    return Promise.resolve();
  }

  frame(frame: Uint8Array = toneFrame(), at = Date.now()): void {
    this.handlers?.onFrame(frame, at);
  }

  setState(state: AudioState, lastStderr: string | null = null): void {
    this.current = state;
    this.handlers?.onState?.(state, { lastStderr });
  }

  end(): void {
    this.handlers?.onEnded?.();
  }
}
