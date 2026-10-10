// Fakes for the server tests (src/server): a session layer that records what the server asks of
// it, a ws-like socket, log capture, and temporary CONFIG_DIR/DATA_DIR/public folders.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { type Logger, pino } from "pino";
import type { WebSocket } from "ws";
import { SESSION_COOKIE, signSession } from "../../../src/accounts/cookies.js";
import { OrgStore } from "../../../src/accounts/orgs.js";
import { hashPassword } from "../../../src/accounts/passwords.js";
import { ScreenStore } from "../../../src/accounts/screens.js";
import { SigningSecret } from "../../../src/accounts/secret.js";
import { type UserRecord, UserStore } from "../../../src/accounts/users.js";
import { type LoadedConfig, loadConfig } from "../../../src/config.js";
import type {
  CaptionSessionApi,
  LocalStartRequest,
  PageSessionRequest,
  SessionListener,
  SessionManagerApi,
} from "../../../src/core/contracts.js";
import { type BuildAppOptions, buildApp } from "../../../src/server/app.js";
import type {
  Block,
  Health,
  PrayerEvent,
  ServerMessage,
  SessionInfo,
  SessionKind,
  SessionMode,
  SessionState,
  SessionSummary,
  Status,
  TrackId,
  TrackStatus,
  UserRole,
} from "../../../src/shared/protocol.js";

export const LANGUAGES_FILE = join(process.cwd(), "languages.yaml");
const LATENCY = { p50Ms: null, p95Ms: null, n: 0 };

export function fakeBlock(sessionId: string, seq: number, extra: Partial<Block> = {}): Block {
  return {
    id: `${sessionId}:b${seq}`,
    seq,
    kind: "speech",
    text: `Zin ${seq}.`,
    ref: null,
    src: null,
    lang: "nl",
    segmentIds: [],
    createdAt: 0,
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    ...extra,
  };
}

export interface FakeSessionOptions {
  from?: string;
  to?: string;
  startedAt?: number;
  blocks?: number;
  onUsage?: (engine: TrackId, ms: number) => void;
  onStop?: (s: FakeSession) => void;
}

/** A caption session that records every call the server makes. */
export class FakeSession implements CaptionSessionApi {
  readonly listeners = new Set<SessionListener>();
  readonly frames: number[] = [];
  readonly speechEvents: Array<"start" | "end"> = [];
  readonly events: Array<PrayerEvent | "none"> = [];
  readonly clears: Array<TrackId | "all"> = [];
  readonly stopReasons: string[] = [];
  readonly blockList: Block[] = [];
  attaches = 0;
  detaches = 0;
  state: SessionState = "live";
  eventMode: SessionMode | undefined;
  speaking = false;
  tracks: TrackStatus[] = [
    {
      track: "soniox",
      active: true,
      provider: "live",
      latency: { source: LATENCY, translation: LATENCY },
      vadLatency: null,
      costUsd: 0,
      segments: 0,
    },
  ];
  /** Throws from detach() when set (the server must log it and go on). */
  detachError: Error | null = null;
  /** Rejects stop() when set. */
  stopError: Error | null = null;
  readonly from: string;
  readonly to: string;
  readonly startedAt: number;
  readonly onUsage: ((engine: TrackId, ms: number) => void) | undefined;
  private readonly onStop: ((s: FakeSession) => void) | undefined;

  constructor(
    readonly id: string,
    readonly kind: SessionKind,
    opts: FakeSessionOptions = {},
  ) {
    this.from = opts.from ?? "ar";
    this.to = opts.to ?? "nl";
    this.startedAt = opts.startedAt ?? 1_000;
    this.onUsage = opts.onUsage;
    this.onStop = opts.onStop;
    for (let i = 0; i < (opts.blocks ?? 0); i++) this.blockList.push(fakeBlock(id, i));
  }

  info(): SessionInfo {
    return {
      id: this.id,
      kind: this.kind,
      startedAt: this.startedAt,
      from: this.from,
      to: this.to,
      source: this.kind,
      inputKind: this.kind,
    };
  }

  status(): Status {
    return {
      state: this.state,
      primary: "soniox",
      provider: "live",
      audio: { state: "ok", rmsDbfs: -30, lastFrameAgoMs: 0, noSignal: false },
      latency: LATENCY,
      tracks: this.tracks,
      session: this.info(),
      ...(this.kind === "page"
        ? { page: { speaking: this.speaking, engineOpen: this.speaking, streamedMinutes: 0 } }
        : {}),
      ...(this.eventMode === undefined ? {} : { eventMode: this.eventMode }),
    };
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      kind: this.kind,
      from: this.from,
      to: this.to,
      engines: ["soniox"],
      startedAt: this.startedAt,
      durationMs: 0,
      streamedMinutes: 0,
      latency: LATENCY,
      state: this.state,
    };
  }

  snapshots(): ServerMessage[] {
    return [
      {
        type: "snapshot",
        track: "soniox",
        session: this.info(),
        segments: [],
        status: this.status(),
      },
      { type: "mode", mode: "speech" },
    ];
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(msg: ServerMessage): void {
    for (const l of [...this.listeners]) l(msg);
  }

  pushFrame(frame: Uint8Array): void {
    this.frames.push(frame.byteLength);
  }

  speech(state: "start" | "end"): void {
    this.speechEvents.push(state);
  }

  detach(): void {
    this.detaches++;
    if (this.detachError !== null) throw this.detachError;
  }

  attach(): void {
    this.attaches++;
  }

  clear(track: TrackId | "all" = "all"): void {
    this.clears.push(track);
  }

  blocks(opts: { before?: number; limit?: number } = {}): { blocks: Block[]; hasMore: boolean } {
    const before = opts.before;
    const eligible =
      before === undefined ? this.blockList : this.blockList.filter((b) => b.seq < before);
    const limit = opts.limit ?? 100;
    return {
      blocks: eligible.slice(Math.max(0, eligible.length - limit)),
      hasMore: eligible.length > limit,
    };
  }

  overrideEvent(event: PrayerEvent | "none"): void {
    this.events.push(event);
  }

  async stop(reason: string): Promise<void> {
    this.stopReasons.push(reason);
    this.state = "stopping";
    this.onStop?.(this);
    if (this.stopError !== null) throw this.stopError;
  }
}

/** A session manager over FakeSessions. */
export class FakeManager implements SessionManagerApi {
  readonly sessions = new Map<string, FakeSession>();
  readonly pageRequests: PageSessionRequest[] = [];
  readonly localStarts: LocalStartRequest[] = [];
  readonly monitorListeners = new Set<SessionListener>();
  readonly orgById = new Map<string, string>();
  localSession: FakeSession | null = null;
  /** Thrown by the next createPage(). */
  createError: Error | null = null;
  /** Thrown by health() / list() / local() when set. */
  healthError: Error | null = null;
  listError: Error | null = null;
  localError: Error | null = null;
  /** Remove a session from the manager when it stops (like the real one). */
  removeOnStop = true;
  private n = 0;

  private readonly removed = (s: FakeSession): void => {
    if (!this.removeOnStop) return;
    this.sessions.delete(s.id);
    if (this.localSession === s) this.localSession = null;
  };

  createPage(req: PageSessionRequest): CaptionSessionApi {
    if (this.createError !== null) {
      const err = this.createError;
      this.createError = null;
      throw err;
    }
    this.pageRequests.push(req);
    const s = new FakeSession(`page${++this.n}`, "page", {
      from: req.from,
      to: req.to,
      ...(req.onUsage === undefined ? {} : { onUsage: req.onUsage }),
      onStop: this.removed,
    });
    this.sessions.set(s.id, s);
    if (req.orgId !== undefined) this.orgById.set(s.id, req.orgId);
    return s;
  }

  /** Add a session by hand (a local one, or a page session of an organisation). */
  add(s: FakeSession, orgId?: string): FakeSession {
    this.sessions.set(s.id, s);
    if (orgId !== undefined) this.orgById.set(s.id, orgId);
    return s;
  }

  page(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`no session ${id}`);
    return s;
  }

  get(id: string): CaptionSessionApi | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    if (this.listError !== null) throw this.listError;
    return [...this.sessions.values()].map((s) => s.summary());
  }

  local(): CaptionSessionApi | null {
    if (this.localError !== null) throw this.localError;
    return this.localSession;
  }

  async startLocal(req: LocalStartRequest): Promise<{ ok: boolean; message: string }> {
    this.localStarts.push(req);
    if (this.localSession !== null) return { ok: false, message: "A session is already live" };
    const s = new FakeSession(`local${++this.n}`, req.source, { onStop: this.removed });
    this.sessions.set(s.id, s);
    this.localSession = s;
    return { ok: true, message: `Started ${req.source}` };
  }

  async stopLocal(reason: string): Promise<{ ok: boolean; message: string }> {
    const s = this.localSession;
    if (s === null) return { ok: false, message: "No local session" };
    await s.stop(reason);
    return { ok: true, message: "Stopped" };
  }

  subscribeMonitor(listener: SessionListener): () => void {
    this.monitorListeners.add(listener);
    return () => this.monitorListeners.delete(listener);
  }

  emitMonitor(msg: ServerMessage): void {
    for (const l of [...this.monitorListeners]) l(msg);
  }

  health(): Health {
    if (this.healthError !== null) throw this.healthError;
    return {
      ok: true,
      version: "fake",
      uptimeMs: 1,
      exposure: "local",
      local: this.localSession?.status() ?? null,
      sessions: this.list(),
    };
  }

  async stopAll(reason: string): Promise<void> {
    for (const s of [...this.sessions.values()]) await s.stop(reason);
  }

  orgOf(id: string): string | null {
    return this.orgById.get(id) ?? null;
  }
}

/**
 * A ws-like socket: what the server sends is parsed and kept; close() closes asynchronously (as ws
 * does), terminate() at once.
 */
export class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closeCode: number | null = null;
  closeReason = "";
  terminated = false;
  pings = 0;
  pingError: Error | null = null;
  /** Answer every ping with a pong at once (a healthy client). */
  autoPong = false;
  /** Never complete a close handshake (a client that went away without a word). */
  holdClose = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.holdClose) return;
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    });
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  ping(): void {
    if (this.pingError !== null) throw this.pingError;
    this.pings++;
    if (this.autoPong) this.emit("pong");
  }

  /** The client sends a JSON text message. */
  text(msg: unknown): void {
    this.emit("message", Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg)), false);
  }

  /** The client sends a binary frame. */
  binary(bytes: number): void {
    this.emit("message", Buffer.alloc(bytes), true);
  }

  types(): string[] {
    return this.sent.map((m) => String(m.type));
  }

  last(type: string): Record<string, unknown> | undefined {
    return this.sent.filter((m) => m.type === type).at(-1);
  }

  get ws(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** Let queued microtasks (socket closes, settled promises) run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** The parts of a request the socket handlers read. */
export function fakeRequest(
  opts: {
    ip?: string;
    origin?: string;
    host?: string;
    protocol?: "http" | "https";
    cookie?: string;
  } = {},
): FastifyRequest {
  return {
    ip: opts.ip ?? "192.0.2.10",
    host: opts.host ?? "127.0.0.1:8765",
    protocol: opts.protocol ?? "http",
    headers: {
      ...(opts.origin === undefined ? {} : { origin: opts.origin }),
      ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    },
  } as unknown as FastifyRequest;
}

/** A logger that keeps every line (parsed) for assertions. */
export function captureLog(level = "debug"): {
  log: Logger;
  lines: Array<Record<string, unknown>>;
} {
  const lines: Array<Record<string, unknown>> = [];
  const log = pino(
    { level },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { log, lines };
}

export function silentLog(): Logger {
  return pino({ level: "silent" });
}

/** A temporary CONFIG_DIR = DATA_DIR with a built public folder (page names → minimal HTML). */
export class TempRoot {
  readonly root: string;
  readonly publicDir: string;

  constructor(
    prefix: string,
    pages: readonly string[] = [
      "picker",
      "caption",
      "overlay",
      "control",
      "customize",
      "archive",
      "login",
      "admin",
      "signup",
      "keys",
    ],
  ) {
    this.root = mkdtempSync(join(tmpdir(), prefix));
    this.publicDir = join(this.root, "public");
    for (const dir of ["assets", "fonts"])
      mkdirSync(join(this.publicDir, dir), { recursive: true });
    for (const page of pages) {
      writeFileSync(join(this.publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
    }
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  write(rel: string, text: string): string {
    const file = join(this.root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
  }

  /** Write config.yaml (languagesFile added) and load it. */
  load(yaml = "", env: Record<string, string> = {}): LoadedConfig {
    writeFileSync(join(this.root, "config.yaml"), `${yaml}languagesFile: ${LANGUAGES_FILE}\n`);
    return loadConfig({
      env: { CONFIG_DIR: this.root, DATA_DIR: this.root, ...env },
      cwd: this.root,
    });
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** The login cookie (name=value) of a response that set one. */
export function cookieOf(res: LightMyRequestResponse): string {
  return String(res.headers["set-cookie"]).split(";")[0] ?? "";
}

export function hello(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello",
    protocol: 1,
    from: "ar",
    to: "nl",
    resume: null,
    client: { obs: false, ua: "test" },
    format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
    ...extra,
  };
}

// --- the whole app -------------------------------------------------------------------------------

export interface TestApp {
  app: FastifyInstance;
  manager: FakeManager;
  loaded: LoadedConfig;
  secret: SigningSecret;
  users: UserStore;
  screens: ScreenStore;
  orgs: OrgStore;
  /** Every log line (parsed), at the level asked for. */
  lines: Array<Record<string, unknown>>;
  /** A login cookie (name=value) for an account, signed with the app's secret. */
  cookie(user: UserRecord): string;
  /** An account made directly in users.yaml (its password hash is PASSWORD_HASH's). */
  user(username: string, role?: UserRole, extra?: { orgId?: string; email?: string }): UserRecord;
}

export const PASSWORD = "a-long-password-123";
let passwordHash: string | null = null;

/** The scrypt hash of PASSWORD, made once per test file. */
export async function passwordHashOnce(): Promise<string> {
  passwordHash ??= await hashPassword(PASSWORD);
  return passwordHash;
}

/** buildApp() on a TempRoot with a FakeManager, the stores shared with the test. */
export async function buildTestApp(
  root: TempRoot,
  yaml = "",
  opts: {
    env?: Record<string, string>;
    manager?: FakeManager;
    logLevel?: string;
    app?: Partial<BuildAppOptions>;
  } = {},
): Promise<TestApp> {
  const loaded = root.load(yaml, opts.env ?? {});
  const manager = opts.manager ?? new FakeManager();
  const { log, lines } = captureLog(opts.logLevel ?? "warn");
  const secret = new SigningSecret(loaded.paths.secretFile, "");
  const users = new UserStore(loaded.paths.usersFile);
  const screens = new ScreenStore(loaded.paths.screensFile);
  const orgs = new OrgStore(loaded.paths.orgsFile);
  const hash = await passwordHashOnce();
  const app = await buildApp({
    loaded,
    manager,
    log,
    publicDir: root.publicDir,
    version: "test",
    secret,
    users,
    screens,
    orgs,
    checkKey: async () => ({ result: "ok" }),
    ...opts.app,
  });
  return {
    app,
    manager,
    loaded,
    secret,
    users,
    screens,
    orgs,
    lines,
    cookie: (user) =>
      `${SESSION_COOKIE}=${signSession(secret, {
        u: user.id,
        v: user.sessionVersion,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`,
    user: (username, role = "admin", extra = {}) =>
      users.insert({
        username,
        role,
        passwordHash: hash,
        ...(extra.orgId === undefined ? {} : { orgId: extra.orgId }),
        ...(extra.email === undefined ? {} : { email: extra.email }),
      }),
  };
}

export interface WsClient {
  ws: WebSocket;
  /** Every JSON message received, in order. */
  messages: Array<Record<string, unknown>>;
  /** The next message (of `type`, when given) after the ones already taken, waiting for it. */
  next(type?: string): Promise<Record<string, unknown>>;
  /** The close code and reason, once closed. */
  closed: Promise<{ code: number; reason: string }>;
}

/** A WebSocket to the app (injectWS: no port), recording messages from the first one on. */
export async function openWS(
  app: FastifyInstance,
  path: string,
  headers: Record<string, string> = { host: "127.0.0.1:8765" },
): Promise<WsClient> {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let resolveClosed: (v: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    resolveClosed = r;
  });
  // A peer address for request.ip, as a real connection has one.
  const socket = { remoteAddress: "127.0.0.1" } as Socket;
  const ws = await app.injectWS(
    path,
    { headers, socket },
    {
      onInit: (socket) => {
        socket.on("message", (data) => {
          messages.push(JSON.parse(String(data)) as Record<string, unknown>);
          for (const wake of waiters.splice(0)) wake();
        });
        socket.on("close", (code, reason) => resolveClosed({ code, reason: String(reason) }));
      },
    },
  );
  let taken = 0;
  return {
    ws,
    messages,
    closed,
    next: async (type) => {
      for (;;) {
        const i = messages.findIndex(
          (m, n) => n >= taken && (type === undefined || m.type === type),
        );
        const found = messages[i];
        if (found !== undefined) {
          taken = i + 1;
          return found;
        }
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
  };
}
