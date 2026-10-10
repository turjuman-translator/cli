// Smoke test for the HTTP + WebSocket server (src/server) against a fake SessionManager:
// no engines, no network, temp CONFIG_DIR/DATA_DIR. Prints one PASS/FAIL line per check.
// Run: pnpm exec tsx scripts/smoke-server.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { KeyStore } from "../src/auth/keys.js";
import { keysCommand, usageCommand } from "../src/cli/keys.js";
import { loadConfig } from "../src/config.js";
import type {
  CaptionSessionApi,
  LocalStartRequest,
  PageSessionRequest,
  SessionListener,
  SessionManagerApi,
} from "../src/core/contracts.js";
import { buildApp } from "../src/server/app.js";
import type {
  Block,
  Health,
  PrayerEvent,
  Segment,
  ServerMessage,
  SessionInfo,
  SessionKind,
  SessionSummary,
  Status,
  TrackId,
} from "../src/shared/protocol.js";
import { BUILTIN_PRESETS } from "../src/shared/theme.js";

const REPO = resolve(import.meta.dirname, "..");
const TOKEN = "smoke-admin-token-0123456789";
const SECRET_KEY_IN_URL = "SMOKESECRETKEY123456";

// --- fake session layer ----------------------------------------------------------------------

const LATENCY = { p50Ms: null, p95Ms: null, n: 0 };

/** Blocks the fake sessions start with (seq 0..249). */
const FAKE_BLOCKS = 250;

function fakeBlock(sessionId: string, seq: number, lang: string): Block {
  return {
    id: `${sessionId}:b${seq}`,
    seq,
    kind: "speech",
    text: `Zin nummer ${seq}.`,
    ref: null,
    src: null,
    lang,
    segmentIds: [],
    createdAt: Date.now(),
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
  };
}

class FakeSession implements CaptionSessionApi {
  readonly startedAt = Date.now();
  frames = 0;
  speaking = false;
  attached = true;
  stopped = false;
  lastEvent: PrayerEvent | "none" | null = null;
  private seq = 0;
  private readonly segments: Segment[] = [];
  private readonly blockList: Block[] = [];
  private readonly listeners = new Set<SessionListener>();
  private levelTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    readonly kind: SessionKind,
    private readonly from: string,
    private readonly to: string,
    private readonly onUsage: ((engine: TrackId, ms: number) => void) | undefined,
    private readonly onStop: (s: FakeSession) => void,
  ) {
    for (let i = 0; i < FAKE_BLOCKS; i++) this.blockList.push(fakeBlock(id, i, to));
    if (kind !== "page") {
      this.levelTimer = setInterval(
        () => this.emit({ type: "level", rmsDbfs: -30, peakDbfs: -12 }),
        40,
      );
      this.levelTimer.unref();
    }
  }

  blocks(opts: { before?: number; limit?: number } = {}): { blocks: Block[]; hasMore: boolean } {
    const before = opts.before;
    const eligible =
      before === undefined ? this.blockList : this.blockList.filter((b) => b.seq < before);
    const limit = Math.min(200, opts.limit ?? 100);
    return {
      blocks: eligible.slice(Math.max(0, eligible.length - limit)),
      hasMore: eligible.length > limit,
    };
  }

  overrideEvent(event: PrayerEvent | "none"): void {
    this.lastEvent = event;
    this.emit({ type: "mode", mode: event === "none" ? "speech" : event });
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
      state: this.stopped ? "idle" : "live",
      primary: "soniox",
      provider: "live",
      audio: { state: "ok", rmsDbfs: -30, lastFrameAgoMs: 0, noSignal: false },
      latency: LATENCY,
      tracks: [
        {
          track: "soniox",
          active: true,
          provider: "live",
          latency: { source: LATENCY, translation: LATENCY },
          vadLatency: null,
          costUsd: 0,
          segments: this.segments.length,
        },
      ],
      session: this.info(),
      ...(this.kind === "page"
        ? { page: { speaking: this.speaking, engineOpen: this.speaking, streamedMinutes: 0 } }
        : {}),
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
      durationMs: Date.now() - this.startedAt,
      streamedMinutes: 0,
      latency: LATENCY,
      state: this.stopped ? "idle" : "live",
    };
  }

  snapshots(): ServerMessage[] {
    const last = this.blocks({ limit: 200 });
    return [
      {
        type: "snapshot",
        track: "soniox",
        session: this.info(),
        segments: [...this.segments],
        status: this.status(),
      },
      { type: "blocks.snapshot", blocks: last.blocks, hasMore: last.hasMore },
      { type: "mode", mode: "speech" },
    ];
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(msg: ServerMessage): void {
    for (const l of [...this.listeners]) l(msg);
  }

  private segment(text: string, final: boolean): void {
    const seq = this.seq++;
    const seg: Segment = {
      id: `${this.id}:soniox:${seq}`,
      sessionId: this.id,
      track: "soniox",
      seq,
      kind: "speech",
      startMs: 0,
      endMs: null,
      source: { lang: this.from, text, finalLen: final ? text.length : 0, final },
      translations: { [this.to]: { text: final ? "In de naam van God" : "", finalLen: 0, final } },
      closed: final,
      timing: { source: "provider", firstTokenAt: Date.now() },
    };
    this.segments.push(seg);
    this.emit({ type: "segment", track: "soniox", segment: seg });
  }

  pushFrame(frame: Uint8Array): void {
    if (frame.byteLength !== 3200) throw new Error("bad frame size reached the session");
    this.frames++;
    this.onUsage?.("soniox", 100);
    if (this.speaking && this.frames === 2) this.segment("بسم", false);
    if (this.speaking && this.frames === 5) {
      this.segment("بسم الله", true);
      const block = fakeBlock(this.id, this.blockList.length, this.to);
      this.blockList.push(block);
      this.emit({ type: "block.add", block });
    }
  }

  speech(state: "start" | "end"): void {
    this.speaking = state === "start";
    this.emit({ type: "status", status: this.status() });
  }

  detach(): void {
    this.attached = false;
  }

  attach(): void {
    this.attached = true;
  }

  clear(track: TrackId | "all" = "all"): void {
    this.segments.length = 0;
    this.emit({ type: "clear", track });
  }

  async stop(_reason: string): Promise<void> {
    this.stopped = true;
    if (this.levelTimer !== null) clearInterval(this.levelTimer);
    this.onStop(this);
  }
}

class FakeManager implements SessionManagerApi {
  readonly sessions = new Map<string, FakeSession>();
  localSession: FakeSession | null = null;
  lastPageRequest: PageSessionRequest | null = null;
  private n = 0;

  constructor(private readonly exposure: Health["exposure"]) {}

  private remove = (s: FakeSession): void => {
    this.sessions.delete(s.id);
    if (this.localSession === s) this.localSession = null;
  };

  createPage(req: PageSessionRequest): CaptionSessionApi {
    this.lastPageRequest = req;
    const s = new FakeSession(
      `page${++this.n}`,
      "page",
      req.from,
      req.to,
      req.onUsage,
      this.remove,
    );
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): CaptionSessionApi | undefined {
    return this.sessions.get(id);
  }

  page(id: string): FakeSession | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  local(): CaptionSessionApi | null {
    return this.localSession;
  }

  async startLocal(req: LocalStartRequest): Promise<{ ok: boolean; message: string }> {
    if (this.localSession !== null) return { ok: false, message: "already live" };
    const s = new FakeSession(`local${++this.n}`, req.source, "ar", "nl", undefined, this.remove);
    this.sessions.set(s.id, s);
    this.localSession = s;
    return {
      ok: true,
      message: `started ${req.source}${req.file === undefined ? "" : ` ${req.file}`}`,
    };
  }

  async stopLocal(): Promise<{ ok: boolean; message: string }> {
    const s = this.localSession;
    if (s === null) return { ok: false, message: "not running" };
    await s.stop("api");
    return { ok: true, message: "stopped" };
  }

  async switchLocal(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "switched" };
  }

  subscribeMonitor(listener: SessionListener): () => void {
    const timer = setInterval(() => listener({ type: "level", rmsDbfs: -50, peakDbfs: -40 }), 40);
    return () => clearInterval(timer);
  }

  health(): Health {
    return {
      ok: true,
      version: "smoke",
      uptimeMs: 1,
      exposure: this.exposure,
      local: this.localSession?.status() ?? null,
      sessions: this.list(),
    };
  }

  async stopAll(): Promise<void> {
    for (const s of [...this.sessions.values()]) await s.stop("shutdown");
  }
}

// --- helpers -------------------------------------------------------------------------------

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}

type Msg = Record<string, unknown> & { type?: string };

class WsProbe {
  readonly messages: Msg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private wake: (() => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") this.messages.push(JSON.parse(ev.data) as Msg);
      this.wake?.();
    });
    this.closed = new Promise((res) => {
      ws.addEventListener("close", (ev) => {
        res({ code: ev.code, reason: ev.reason });
        this.wake?.();
      });
    });
  }

  static open(url: string, init?: WebSocketInit): Promise<WsProbe> {
    const ws = new WebSocket(url, init);
    const probe = new WsProbe(ws);
    return new Promise((res, rej) => {
      ws.addEventListener("open", () => res(probe));
      ws.addEventListener("error", () => rej(new Error(`WebSocket ${url} failed`)));
    });
  }

  /** The first message (from `from` on) matching `pred`, waiting up to timeoutMs. */
  async waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000, from = 0): Promise<Msg | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(from).find(pred);
      if (found !== undefined) return found;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        this.wake = () => {
          clearTimeout(t);
          res();
        };
      });
    }
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}

function hello(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "hello",
    protocol: 1,
    from: "ar",
    to: "nl",
    resume: null,
    client: { obs: false, ua: "smoke" },
    format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
    ...extra,
  });
}

/** Raw HTTP request (lets us set the Host header, which fetch does not). */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (r) => {
        r.resume();
        res(r.statusCode ?? 0);
      },
    );
    req.on("error", rej);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Env {
  root: string;
  configDir: string;
  dataDir: string;
  publicDir: string;
}

function makeEnv(name: string, configYaml: string): Env {
  const root = mkdtempSync(join(tmpdir(), `smoke-server-${name}-`));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const publicDir = join(root, "public");
  for (const d of [configDir, dataDir, join(dataDir, "recordings"), publicDir]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(join(publicDir, "assets"), { recursive: true });
  mkdirSync(join(publicDir, "fonts"), { recursive: true });
  for (const page of ["picker", "caption", "overlay", "control", "archive", "customize"]) {
    writeFileSync(join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  }
  writeFileSync(join(publicDir, "assets", "caption-abc123.js"), "console.log(1);\n");
  writeFileSync(join(dataDir, "recordings", "test.wav"), "RIFF");
  writeFileSync(join(configDir, "config.yaml"), configYaml);
  writeArchiveFixture(dataDir);
  return { root, configDir, dataDir, publicDir };
}

// An ended session: transcripts/<date>_<id>/{session.jsonl, blocks.jsonl}.
const ARCHIVE_ID = "arch2345";
const ARCHIVE_START = new Date(2026, 9, 2, 13, 0, 0).getTime(); // local 13:00
const ATHAN_AT = ARCHIVE_START + 120_000; // local 13:02

function writeArchiveFixture(dataDir: string): void {
  const dir = join(dataDir, "transcripts", `2026-10-02_1300_${ARCHIVE_ID}`);
  mkdirSync(dir, { recursive: true });
  const markers = [
    { t: ARCHIVE_START, type: "start", kind: "page", from: "ar", to: "nl" },
    { t: ARCHIVE_START + 600_000, type: "stop", reason: "grace expired", durationMs: 600_000 },
  ];
  writeFileSync(
    join(dir, "session.jsonl"),
    `${markers.map((m) => JSON.stringify(m)).join("\n")}\n`,
  );
  const b = (
    seq: number,
    kind: Block["kind"],
    text: string,
    extra: Partial<Block> = {},
  ): Block => ({
    id: `${ARCHIVE_ID}:b${seq}`,
    seq,
    kind,
    text,
    ref: null,
    src: null,
    lang: "nl",
    segmentIds: [],
    createdAt: ARCHIVE_START + seq * 1000,
    ...extra,
  });
  const takbir = b(2, "speech", "Allah is de Grootste.", { startMs: 7000, endMs: 8000 });
  const athan = b(3, "event", "", { event: { type: "athan", active: true, startedAt: ATHAN_AT } });
  // The session layer writes one complete Block per line (a later line with the same id wins);
  // two lines use the {type, block} wrapper to check the reader's tolerance.
  const lines: unknown[] = [
    b(0, "speech", "Alle lof zij Allah.", { startMs: 0, endMs: 2000 }),
    b(1, "quran", "Allah belast niemand boven zijn vermogen.", {
      ref: "2:286",
      startMs: 2500,
      endMs: 6000,
    }),
    takbir,
    { type: "block.add", block: athan },
    { ...takbir, hidden: true },
    {
      type: "block.update",
      block: {
        ...athan,
        event: { type: "athan", active: false, startedAt: ATHAN_AT, endedAt: ATHAN_AT + 180_000 },
      },
    },
    // A block kind of the removed caption composer, as an older archive has it.
    { ...b(4, "speech", 'De Profeet ﷺ zei: "Glimlachen is liefdadigheid."'), kind: "hadith" },
  ];
  const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"id":"${ARCHIVE_ID}:b5","seq`;
  writeFileSync(join(dir, "blocks.jsonl"), text);
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Msg }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Msg = {};
  try {
    body = JSON.parse(text) as Msg;
  } catch {
    body = { text };
  }
  return { status: res.status, body };
}

function postJson(
  url: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
}

const seqs = (body: Msg): number[] =>
  ((body.blocks as Block[] | undefined) ?? []).map((x) => x.seq);

async function start(
  env: Env,
  manager: FakeManager,
  logLines: string[],
): Promise<{ app: FastifyInstance; port: number; warnings: string[] }> {
  const loaded = loadConfig({
    env: { CONFIG_DIR: env.configDir, DATA_DIR: env.dataDir },
    cwd: env.root,
  });
  const log = pino({ level: "info" }, { write: (line: string) => void logLines.push(line) });
  const app = await buildApp({
    loaded,
    manager,
    log,
    publicDir: env.publicDir,
    version: "smoke",
    listDevices: async () => [{ name: "Fake mic" }],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { app, port, warnings: loaded.warnings };
}

// --- phase A: exposure local -----------------------------------------------------------------

async function phaseLocal(): Promise<void> {
  console.log("\n# exposure: local");
  const env = makeEnv(
    "local",
    `# smoke config (comment must survive save-default)
server:
  host: 127.0.0.1
  exposure: local
stt:
  provider: soniox # engine
languagesFile: ${join(REPO, "languages.yaml")}
`,
  );
  const logs: string[] = [];
  const manager = new FakeManager("local");
  const { app, port, warnings: configWarnings } = await start(env, manager, logs);
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`);
    const body = (await health.json()) as Health;
    check("GET /health → 200 ok", health.status === 200 && body.ok === true);

    const soniox = (await (await fetch(`${base}/api/languages`)).json()) as {
      sources: unknown[];
      targets: unknown[];
      auto: boolean;
    };
    check(
      "GET /api/languages → 60 sources/targets (Soniox) + auto",
      soniox.sources.length === 60 && soniox.targets.length === 60 && soniox.auto === true,
      `sources=${soniox.sources.length} targets=${soniox.targets.length}`,
    );
    const older = await fetch(`${base}/api/languages?engine=gemini&translation=llm`);
    const olderBody = (await older.json()) as { sources: unknown[]; targets: unknown[] };
    check(
      "GET /api/languages?engine=gemini&translation=llm (an older page) → ignored, the same 60",
      older.status === 200 && olderBody.sources.length === 60 && olderBody.targets.length === 60,
    );
    check(
      "config with stt.provider (removed key) → loads with one warning",
      configWarnings.length === 1 &&
        configWarnings[0] === "stt.provider is no longer used: Turjuman uses Soniox only",
      configWarnings.join("; "),
    );

    const page = await fetch(`${base}/ar/nl?key=${SECRET_KEY_IN_URL}`, { redirect: "manual" });
    const csp = page.headers.get("content-security-policy") ?? "";
    check(
      "GET /ar/nl → 200 caption.html + CSP/Permissions-Policy/no-store",
      page.status === 200 &&
        (await page.text()).includes("caption") &&
        csp.includes("script-src 'self'") &&
        csp.includes(`connect-src 'self' ws://127.0.0.1:${port} wss://127.0.0.1:${port}`) &&
        page.headers.get("permissions-policy") === "microphone=(self)" &&
        page.headers.get("referrer-policy") === "no-referrer" &&
        page.headers.get("cache-control") === "no-store",
      csp,
    );
    const bad = await fetch(`${base}/ar/xx`, { redirect: "manual" });
    const location = bad.headers.get("location") ?? "";
    check(
      "GET /ar/xx → 302 /?error=…",
      bad.status === 302 && location.startsWith("/?error="),
      decodeURIComponent(location),
    );
    const olderLink = await fetch(`${base}/ar/nl?engine=gemini&translation=llm`, {
      redirect: "manual",
    });
    check(
      "GET /ar/nl?engine=gemini&translation=llm (an older link) → 200 caption page",
      olderLink.status === 200,
    );
    const auto = await fetch(`${base}/auto/nl`, { redirect: "manual" });
    check("GET /auto/nl → 200", auto.status === 200);
    const same = await fetch(`${base}/nl/nl`, { redirect: "manual" });
    check("GET /nl/nl → 302 (same language)", same.status === 302);
    const reserved = await fetch(`${base}/api/xx`, { redirect: "manual" });
    check("GET /api/xx → 404 (reserved segment)", reserved.status === 404);
    const asset = await fetch(`${base}/assets/caption-abc123.js`);
    check(
      "GET /assets/<hashed> → immutable",
      asset.status === 200 &&
        asset.headers.get("cache-control") === "public, max-age=31536000, immutable",
      asset.headers.get("cache-control") ?? "",
    );
    const picker = await fetch(`${base}/`);
    check("GET / → picker.html", picker.status === 200 && (await picker.text()).includes("picker"));
    const compare = await fetch(`${base}/compare`);
    check("GET /compare (removed) → 404", compare.status === 404);

    check("Host guard: Host evil.example → 403", (await rawGet(port, "/", "evil.example")) === 403);
    check(
      "Host guard: /health stays open",
      (await rawGet(port, "/health", "evil.example")) === 200,
    );
    check(
      "Host guard: localhost:1234 allowed",
      (await rawGet(port, "/", "localhost:1234")) === 200,
    );

    const noType = await fetch(`${base}/api/session/stop`, { method: "POST" });
    check("POST /api/session/stop without JSON type → 415", noType.status === 415);
    const outside = await fetch(`${base}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "file", file: "../../config/config.yaml" }),
    });
    check("POST /api/session/start outside recordings → 400", outside.status === 400);
    const devices = await fetch(`${base}/api/devices`);
    check("GET /api/devices → listDevices()", devices.status === 200);

    // /ws (overlay/control): idle hello, then the local session appears.
    const overlay = await WsProbe.open(`ws://127.0.0.1:${port}/ws`);
    const idle = await overlay.waitFor((m) => m.type === "hello");
    check("/ws → hello (idle, sessionId null)", idle !== null && idle.sessionId === null);
    overlay.send(JSON.stringify({ type: "subscribe", topics: ["level"] }));
    const monitorLevel = await overlay.waitFor((m) => m.type === "level", 1500);
    check("/ws idle → monitor level for subscribers", monitorLevel !== null);

    const startRes = await fetch(`${base}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "test.wav" }),
    });
    const startBody = (await startRes.json()) as { ok: boolean; message: string };
    check("POST /api/session/start {file} → 200", startRes.status === 200, startBody.message);
    const mark = overlay.messages.length;
    const live = await overlay.waitFor(
      (m) => m.type === "hello" && m.sessionId !== null,
      2500,
      mark,
    );
    const snap = await overlay.waitFor((m) => m.type === "snapshot", 1000, mark);
    check(
      "/ws → new hello + snapshot when the local session starts",
      live !== null && snap !== null,
    );
    const hubBlocks = await overlay.waitFor((m) => m.type === "blocks.snapshot", 1000, mark);
    const hubMode = await overlay.waitFor((m) => m.type === "mode", 1000, mark);
    check(
      "/ws → blocks.snapshot (200, hasMore) + mode on attach",
      (hubBlocks?.blocks as unknown[] | undefined)?.length === 200 &&
        hubBlocks?.hasMore === true &&
        hubMode?.mode === "speech",
    );
    const localId = String(live?.sessionId);
    const athanMark = overlay.messages.length;
    const override = await postJson(`${base}/api/sessions/${localId}/event`, { event: "athan" });
    const athanMode = await overlay.waitFor(
      (m) => m.type === "mode" && m.mode === "athan",
      1000,
      athanMark,
    );
    check(
      "POST /api/sessions/:id/event athan → overrideEvent + /ws forwards mode",
      override.status === 200 && athanMode !== null && manager.page(localId)?.lastEvent === "athan",
    );
    const levelMark = overlay.messages.length;
    await sleep(1000);
    const levels = overlay.messages.slice(levelMark).filter((m) => m.type === "level").length;
    check("/ws level throttled to ≤5/s", levels >= 1 && levels <= 6, `${levels} in 1 s`);
    const again = await fetch(`${base}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    check("POST /api/session/start twice → 409", again.status === 409);
    const stop = await fetch(`${base}/api/session/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    check("POST /api/session/stop (empty JSON body) → 200", stop.status === 200);
    overlay.close();

    // /ws/page: hello → ready → snapshot; speech + frames → segments.
    const pageWs = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`);
    pageWs.send(hello({ layout: "rollup" }));
    const ready = await pageWs.waitFor((m) => m.type === "ready");
    check(
      "/ws/page hello.layout → createPage({layout})",
      manager.lastPageRequest?.layout === "rollup",
      String(manager.lastPageRequest?.layout),
    );
    const pageBlocksSnap = await pageWs.waitFor((m) => m.type === "blocks.snapshot");
    check(
      "/ws/page → blocks.snapshot + mode after ready",
      (pageBlocksSnap?.blocks as unknown[] | undefined)?.length === 200 &&
        (await pageWs.waitFor((m) => m.type === "mode")) !== null,
    );
    const vad = ready?.vad as Record<string, number> | undefined;
    check(
      "/ws/page hello → ready (vad + limits)",
      ready !== null &&
        ready.resumed === false &&
        vad?.prerollMs === 500 &&
        vad?.minSilenceMs === 300 &&
        vad?.hangoverMs === 1500 &&
        (ready.limits as Record<string, unknown>).maxFrameBytes === 3200,
      JSON.stringify({ vad, limits: ready?.limits }),
    );
    const pageSnap = await pageWs.waitFor((m) => m.type === "snapshot");
    check("/ws/page → snapshot after ready", pageSnap !== null);
    pageWs.send(JSON.stringify({ type: "speech", state: "start" }));
    for (let i = 0; i < 5; i++) pageWs.send(new Uint8Array(3200));
    const final = await pageWs.waitFor(
      (m) => m.type === "segment" && (m.segment as Segment).source.final === true,
    );
    const segs = pageWs.messages.filter((m) => m.type === "segment").length;
    check("/ws/page speech + 5 frames → segment messages", final !== null && segs === 2, `${segs}`);
    const status = await pageWs.waitFor((m) => m.type === "status");
    check("/ws/page → status forwarded", status !== null);
    const added = await pageWs.waitFor((m) => m.type === "block.add");
    check(
      "/ws/page → block.add forwarded",
      (added?.block as Block | undefined)?.seq === FAKE_BLOCKS,
    );
    const sessionId = String(ready?.sessionId);
    pageWs.close();
    await pageWs.closed;
    await sleep(50);
    check("/ws/page close → session.detach()", manager.page(sessionId)?.attached === false);

    // Resume within the grace period.
    const resumed = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`);
    resumed.send(hello({ resume: sessionId }));
    const ready2 = await resumed.waitFor((m) => m.type === "ready");
    const snap2 = await resumed.waitFor((m) => m.type === "snapshot");
    check(
      "/ws/page resume → same session, resumed:true + snapshot",
      ready2?.sessionId === sessionId &&
        ready2?.resumed === true &&
        manager.page(sessionId)?.attached === true &&
        ((snap2?.segments as unknown[] | undefined)?.length ?? 0) === 2,
    );

    // Frame rules: wrong size dropped; burst above prerollMs/100 + 2 dropped.
    const before = manager.page(sessionId)?.frames ?? 0;
    resumed.send(new Uint8Array(100));
    for (let i = 0; i < 30; i++) resumed.send(new Uint8Array(3200));
    await sleep(200);
    const accepted = (manager.page(sessionId)?.frames ?? 0) - before;
    check(
      "/ws/page token bucket: 30-frame burst mostly dropped",
      accepted >= 7 && accepted <= 10,
      `${accepted} accepted`,
    );
    resumed.close();

    const badLang = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`);
    badLang.send(hello({ to: "xx" }));
    const err = await badLang.waitFor((m) => m.type === "error");
    check("/ws/page bad pair → error bad_language", err?.code === "bad_language");

    const evil = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`, {
      headers: { origin: "http://evil.example" },
    });
    const originErr = await evil.waitFor((m) => m.type === "error");
    check("/ws/page foreign Origin → error unauthorized", originErr?.code === "unauthorized");

    const second = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`);
    second.send(hello({ to: "en" }));
    const secondReady = await second.waitFor((m) => m.type === "ready");
    check("/ws/page another caption page → ready (no server-wide limit)", secondReady !== null);
    second.close();

    // --- caption blocks: block history, archive, exports, event override, presets ---
    const api = `${base}/api/sessions`;
    const p1 = await getJson(`${api}/${sessionId}/blocks`);
    check(
      "GET blocks (live) → newest 100 + hasMore",
      p1.status === 200 &&
        p1.body.live === true &&
        seqs(p1.body).length === 100 &&
        seqs(p1.body).at(-1) === FAKE_BLOCKS &&
        p1.body.hasMore === true,
      `${seqs(p1.body).length} blocks, last ${seqs(p1.body).at(-1)}`,
    );
    const p2 = await getJson(`${api}/${sessionId}/blocks?before=51&limit=500`);
    check(
      "GET blocks?before=51&limit=500 → 51 oldest (limit clamped), hasMore false",
      p2.status === 200 &&
        seqs(p2.body).length === 51 &&
        seqs(p2.body)[0] === 0 &&
        p2.body.hasMore === false,
      `${seqs(p2.body).length}`,
    );
    check(
      "GET blocks?before=abc → 400",
      (await getJson(`${api}/${sessionId}/blocks?before=abc`)).status === 400,
    );
    check(
      "GET blocks of an unknown session → 404",
      (await getJson(`${api}/nope2345/blocks`)).status === 404,
    );

    const a1 = await getJson(`${api}/${ARCHIVE_ID}/blocks`);
    const archived = (a1.body.blocks as Block[] | undefined) ?? [];
    check(
      "GET blocks (archived blocks.jsonl) → updates replayed, torn line skipped",
      a1.status === 200 &&
        a1.body.live === false &&
        archived.length === 5 &&
        archived[2]?.hidden === true &&
        archived[3]?.event?.active === false &&
        a1.body.from === "ar" &&
        a1.body.endedAt === ARCHIVE_START + 600_000,
      `${archived.length} blocks`,
    );
    const a2 = await getJson(`${api}/${ARCHIVE_ID}/blocks?before=3&limit=2`);
    check(
      "GET archived blocks?before=3&limit=2 → seq 1,2 + hasMore",
      seqs(a2.body).join(",") === "1,2" && a2.body.hasMore === true,
      seqs(a2.body).join(","),
    );

    const txtRes = await fetch(`${api}/${ARCHIVE_ID}/export.txt`);
    const txt = await txtRes.text();
    check(
      "export.txt → texts, quran with ref, [Athan · 13:02], hidden skipped, attachment",
      txtRes.status === 200 &&
        txt.includes('"Allah belast niemand boven zijn vermogen." (2:286)') &&
        txt.includes("[Athan · 13:02]") &&
        !txt.includes("Grootste") &&
        txt.startsWith("Alle lof zij Allah.") &&
        (txtRes.headers.get("content-disposition") ?? "") ===
          `attachment; filename="captions_2026-10-02_${ARCHIVE_ID}.txt"`,
      JSON.stringify(txt.slice(0, 60)),
    );
    const md = await (await fetch(`${api}/${ARCHIVE_ID}/export.md`)).text();
    check(
      "export.md → typed lines, (ref) for quran, event line; an older hadith block as speech",
      md.includes('- **quran**: "Allah belast niemand boven zijn vermogen." (2:286)') &&
        md.includes("- **event**: Athan · 13:02–13:05") &&
        md.includes("- **speech**: De Profeet") &&
        md.includes("· ar → nl ·") &&
        !md.includes("Grootste"),
    );
    const srtRes = await fetch(`${api}/${ARCHIVE_ID}/export.srt`);
    const srt = await srtRes.text();
    check(
      "export.srt → numbered timed entries only",
      srtRes.headers.get("content-type")?.startsWith("application/x-subrip") === true &&
        srt.startsWith("1\n00:00:00,000 --> 00:00:02,000\nAlle lof zij Allah.\n") &&
        srt.includes('2\n00:00:02,500 --> 00:00:06,000\n"Allah belast') &&
        !srt.includes("3\n"),
      JSON.stringify(srt.slice(0, 80)),
    );
    const liveTxt = await (await fetch(`${api}/${sessionId}/export.txt`)).text();
    check(
      "export.txt of a live session pages through all blocks",
      liveTxt.startsWith("Zin nummer 0.") && liveTxt.includes(`Zin nummer ${FAKE_BLOCKS}.`),
    );

    const ev1 = await postJson(`${api}/${sessionId}/event`, { event: "iqama" });
    const evAll = await postJson(`${api}/all/event`, { event: "none" });
    const evAllBody = (await evAll.json()) as { sessions?: string[] };
    check(
      "POST /api/sessions/:id/event + /all/event → overrideEvent on each",
      ev1.status === 200 &&
        evAll.status === 200 &&
        (evAllBody.sessions?.length ?? 0) === 2 &&
        [...manager.sessions.values()].every((s) => s.lastEvent === "none"),
      JSON.stringify(evAllBody.sessions),
    );
    const evBad = await postJson(`${api}/${sessionId}/event`, { event: "party" });
    const evMissing = await postJson(`${api}/nope2345/event`, { event: "athan" });
    check(
      "event: bad value → 400, unknown session → 404",
      evBad.status === 400 && evMissing.status === 404,
    );

    const archivePage = await fetch(`${base}/s/${ARCHIVE_ID}`);
    check(
      "GET /s/:id → archive.html with CSP + no-store",
      archivePage.status === 200 &&
        (await archivePage.text()).includes("archive") &&
        (archivePage.headers.get("content-security-policy") ?? "").includes("script-src 'self'") &&
        archivePage.headers.get("cache-control") === "no-store",
    );
    check("GET /s/<unknown> → 404", (await fetch(`${base}/s/nope2345`)).status === 404);
    check("GET /customize → customize.html", (await fetch(`${base}/customize`)).status === 200);

    const presetsUrl = `${base}/api/presets`;
    const empty = await getJson(presetsUrl);
    const builtin = (empty.body.builtin as Array<{ id: string }> | undefined) ?? [];
    check(
      "GET /api/presets → built-ins (theme.ts) + custom + default",
      empty.status === 200 &&
        builtin.length === BUILTIN_PRESETS.length &&
        builtin.some((p) => p.id === "mosque-dark") &&
        (empty.body.custom as unknown[]).length === 0 &&
        empty.body.default === "mosque-dark",
      `${builtin.length} built-in`,
    );
    const myLook = {
      id: "my-look",
      name: "My look",
      description: "Big and calm",
      vars: { "--cap-font-size": "44px", "--cap-font-family": "noto-sans" },
      options: { layout: "blocks", size: 44, quranArabic: true },
    };
    const created = await postJson(presetsUrl, { preset: myLook });
    const replaced = await postJson(presetsUrl, { preset: { ...myLook, name: "My look 2" } });
    const listed = await getJson(presetsUrl);
    const custom =
      (listed.body.custom as
        | Array<{ id: string; name: string; vars: Record<string, string> }>
        | undefined) ?? [];
    check(
      "POST /api/presets create (201) + replace (200) → listed, canonical values, presets.yaml",
      created.status === 201 &&
        replaced.status === 200 &&
        custom.length === 1 &&
        custom[0]?.name === "My look 2" &&
        custom[0]?.vars["--cap-font-family"]?.startsWith('"Noto Sans"') === true &&
        readFileSync(join(env.configDir, "presets.yaml"), "utf8").includes("my-look"),
      custom[0]?.vars["--cap-font-family"],
    );
    const reuse = await postJson(presetsUrl, { preset: { ...myLook, id: "mosque-dark" } });
    check("POST /api/presets with a built-in id → 409", reuse.status === 409);
    const statusOf = async (preset: unknown): Promise<number> =>
      (await postJson(presetsUrl, { preset })).status;
    const injections = await Promise.all([
      statusOf({ ...myLook, vars: { "--cap-text-color": "red;} body{display:none" } }),
      statusOf({ ...myLook, vars: { "--cap-panel-bg": "url(https://evil.example/x.png)" } }),
      statusOf({ ...myLook, vars: { "--cap-panel-bg": "<script>" } }),
      statusOf({ ...myLook, vars: { "--evil": "1px" } }),
      statusOf({ ...myLook, vars: { "--cap-font-size": "huge" } }),
      statusOf({ ...myLook, vars: { "--cap-font-family": "Comic Sans MS" } }),
      statusOf({ ...myLook, id: "My Look" }),
      statusOf({ ...myLook, options: { layout: "grid" } }),
    ]);
    check(
      "POST /api/presets rejects ; } url( < unknown vars, values the theme refuses, bad ids/options",
      injections.every((s) => s === 400),
      injections.join(","),
    );
    const defOk = await postJson(`${base}/api/config/save-default`, { preset: "my-look" });
    const defBad = await postJson(`${base}/api/config/save-default`, { preset: "nope" });
    const afterDefault = await getJson(presetsUrl);
    check(
      "save-default {preset} → display.preset + runtime default; unknown → 400",
      defOk.status === 200 &&
        defBad.status === 400 &&
        afterDefault.body.default === "my-look" &&
        readFileSync(join(env.configDir, "config.yaml"), "utf8").includes("preset: my-look"),
    );
    const del = await fetch(`${presetsUrl}/my-look`, { method: "DELETE" });
    const delAgain = await fetch(`${presetsUrl}/my-look`, { method: "DELETE" });
    check("DELETE /api/presets/:id → 200, then 404", del.status === 200 && delAgain.status === 404);

    const saved = readFileSync(join(env.configDir, "config.yaml"), "utf8");
    check(
      "save-default keeps the rest of config.yaml and its comments",
      saved.includes("# smoke config") && saved.includes("provider: soniox # engine"),
    );
    const engineSave = await fetch(`${base}/api/config/save-default`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "gemini", translation: "llm" }),
    });
    check(
      "POST /api/config/save-default {provider, translation} (removed) → 400, file unchanged",
      engineSave.status === 400 &&
        readFileSync(join(env.configDir, "config.yaml"), "utf8") === saved,
    );

    const strayUpgrade = await WsProbe.open(
      `ws://127.0.0.1:${port}/ar/nl?key=${SECRET_KEY_IN_URL}`,
    ).then(
      (p) => {
        p.close();
        return true;
      },
      () => false,
    );
    check("WS upgrade on a non-WS route → refused", !strayUpgrade);
    await fetch(`${base}/nope/at/all?token=${SECRET_KEY_IN_URL}`);

    await app.close();
    const leaked = logs.filter((l) => l.includes(SECRET_KEY_IN_URL));
    check("request logs never contain ?key= values", leaked.length === 0, `${logs.length} lines`);
  } finally {
    await app.close();
    rmSync(env.root, { recursive: true, force: true });
  }
}

// --- phase B: exposure lan (admin token + access keys) ---------------------------------------

async function phaseLan(): Promise<void> {
  console.log("\n# exposure: lan");
  const env = makeEnv(
    "lan",
    `server:
  host: 127.0.0.1
  exposure: lan
  token: ${TOKEN}
languagesFile: ${join(REPO, "languages.yaml")}
`,
  );
  const logs: string[] = [];
  const manager = new FakeManager("lan");
  const keys = new KeyStore(join(env.configDir, "keys.yaml"));
  const good = keys.add({ label: "Smoke screen", dailyMinutes: 60, engines: ["soniox"] });
  const tiny = keys.add({ label: "Tiny quota", dailyMinutes: 0.002 });
  const { app, port } = await start(env, manager, logs);
  const base = `http://127.0.0.1:${port}`;
  const ws = `ws://127.0.0.1:${port}/ws/page`;
  try {
    const keysFile = readFileSync(join(env.configDir, "keys.yaml"), "utf8");
    check(
      "keys.yaml stores only hashes",
      !keysFile.includes(good.key) && keysFile.includes("keyHash"),
    );

    const noToken = await fetch(`${base}/api/session/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    check("lan: POST /api/session/stop without token → 401", noToken.status === 401);
    const withToken = await fetch(`${base}/api/session/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    check(
      "lan: POST /api/session/stop with Bearer token → not 401",
      withToken.status !== 401,
      `${withToken.status}`,
    );
    const encoded = await fetch(`${base}/%61pi/session/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    check(
      "lan: percent-encoded /%61pi/… cannot bypass the token",
      encoded.status === 401 || encoded.status === 404,
      `${encoded.status}`,
    );
    const control = await fetch(`${base}/control`);
    const controlTok = await fetch(`${base}/control?token=${TOKEN}`);
    check(
      "lan: /control 401 without token, 200 with ?token=",
      control.status === 401 && controlTok.status === 200,
    );
    const langs = await fetch(`${base}/api/languages`);
    check("lan: GET /api/languages stays open (picker)", langs.status === 200);
    const overlay = await fetch(`${base}/overlay`);
    check("lan: /overlay open (protectOverlay false)", overlay.status === 200);
    const pageOpen = await fetch(`${base}/ar/nl`);
    check("lan: /ar/nl open", pageOpen.status === 200);

    // The archive page itself is open (no data, shows a key form); its blocks/export APIs
    // need an access key (or the admin token); writes need the admin token.
    const keyParam = `key=${encodeURIComponent(good.key)}`;
    const archiveUrl = `${base}/s/${ARCHIVE_ID}`;
    const noKeyPage = await fetch(archiveUrl);
    const keyPage = await fetch(`${archiveUrl}?${keyParam}`);
    check(
      "lan: /s/:id page open (key form), 200 with or without ?key=",
      noKeyPage.status === 200 && keyPage.status === 200,
      `${noKeyPage.status}/${keyPage.status}`,
    );
    const blocksNoKey = await fetch(`${base}/api/sessions/${ARCHIVE_ID}/blocks`);
    const blocksWrongKey = await fetch(`${base}/api/sessions/${ARCHIVE_ID}/blocks?key=not-a-key`);
    const blocksBearer = await fetch(`${base}/api/sessions/${ARCHIVE_ID}/blocks`, {
      headers: { authorization: `Bearer ${good.key}` },
    });
    const exportKey = await fetch(`${base}/api/sessions/${ARCHIVE_ID}/export.md?${keyParam}`);
    check(
      "lan: blocks/export APIs → 401 without/wrong key, 200 with Bearer key or ?key=",
      blocksNoKey.status === 401 &&
        blocksWrongKey.status === 401 &&
        blocksBearer.status === 200 &&
        exportKey.status === 200,
    );
    // Requests without any key (old links, a page polling before it has a key) never lock out.
    let lastNoKey = 0;
    for (let i = 0; i < 15; i++) {
      lastNoKey = (await fetch(`${base}/api/sessions/${ARCHIVE_ID}/blocks`)).status;
    }
    const afterNoKey = await fetch(`${base}/api/sessions/${ARCHIVE_ID}/blocks?${keyParam}`);
    check(
      "lan: 15 key-less viewer requests → still 401 (not 429), and a valid key still works",
      lastNoKey === 401 && afterNoKey.status === 200,
      `${lastNoKey}/${afterNoKey.status}`,
    );
    const evKey = await postJson(
      `${base}/api/sessions/all/event`,
      { event: "athan" },
      { authorization: `Bearer ${good.key}` },
    );
    const evToken = await postJson(
      `${base}/api/sessions/all/event`,
      { event: "athan" },
      { authorization: `Bearer ${TOKEN}` },
    );
    check(
      "lan: event override needs the admin token (an access key is not enough)",
      evKey.status === 401 && evToken.status !== 401,
      `${evKey.status}/${evToken.status}`,
    );
    const auth = { authorization: `Bearer ${TOKEN}` };
    const presetsOpen = await fetch(`${base}/api/presets`);
    const presetNoToken = await postJson(`${base}/api/presets`, { preset: { id: "x", name: "X" } });
    const presetToken = await postJson(
      `${base}/api/presets`,
      { preset: { id: "x", name: "X" } },
      auth,
    );
    const delNoToken = await fetch(`${base}/api/presets/x`, { method: "DELETE" });
    const delToken = await fetch(`${base}/api/presets/x`, { method: "DELETE", headers: auth });
    check(
      "lan: GET /api/presets open; POST/DELETE need the admin token",
      presetsOpen.status === 200 &&
        presetNoToken.status === 401 &&
        presetToken.status === 201 &&
        delNoToken.status === 401 &&
        delToken.status === 200,
    );
    const customizeNo = await fetch(`${base}/customize`);
    const customizeTok = await fetch(`${base}/customize?token=${TOKEN}`);
    check(
      "lan: /customize needs the admin token",
      customizeNo.status === 401 && customizeTok.status === 200,
    );

    const noKey = await WsProbe.open(ws);
    noKey.send(hello());
    const e1 = await noKey.waitFor((m) => m.type === "error");
    check(
      "lan: /ws/page without key → error unauthorized",
      e1?.code === "unauthorized",
      String(e1?.message),
    );

    const withKey = await WsProbe.open(ws);
    withKey.send(hello({ key: good.key }));
    const ready = await withKey.waitFor((m) => m.type === "ready");
    const limits = ready?.limits as Record<string, unknown> | undefined;
    check(
      "lan: /ws/page with valid key → ready (dailyMinutesLeft 60)",
      ready !== null &&
        limits?.dailyMinutesLeft === 60 &&
        manager.lastPageRequest?.keyLabel === "Smoke screen",
      JSON.stringify(limits),
    );
    withKey.close();

    const olderPage = await WsProbe.open(ws);
    olderPage.send(hello({ key: good.key, engine: "gemini", translation: "llm" }));
    const r2 = await olderPage.waitFor((m) => m.type === "ready" || m.type === "error");
    check(
      "lan: an older page's hello (engine gemini, translation llm) → ready (Soniox)",
      r2?.type === "ready",
      JSON.stringify(r2),
    );
    olderPage.close();
    await manager.page(String(r2?.sessionId ?? ""))?.stop("smoke done");

    const quota = await WsProbe.open(ws);
    quota.send(hello({ key: tiny.key }));
    await quota.waitFor((m) => m.type === "ready");
    quota.send(JSON.stringify({ type: "speech", state: "start" }));
    for (let i = 0; i < 3; i++) quota.send(new Uint8Array(3200));
    const e3 = await quota.waitFor((m) => m.type === "error");
    check(
      "lan: daily limit reached mid-session → error quota_exceeded",
      e3?.code === "quota_exceeded",
    );
    const again = await WsProbe.open(ws);
    again.send(hello({ key: tiny.key }));
    const e4 = await again.waitFor((m) => m.type === "error");
    check("lan: daily limit used up → refused at hello", e4?.code === "quota_exceeded");

    let lastMessage = "";
    for (let i = 0; i < 11; i++) {
      const bad = await WsProbe.open(ws);
      bad.send(hello({ key: `wrong-key-${i}` }));
      const e = await bad.waitFor((m) => m.type === "error");
      lastMessage = String(e?.message);
    }
    check(
      "lan: 10 wrong keys → address blocked",
      lastMessage.startsWith("Too many failed"),
      lastMessage,
    );

    const io = { out: (s: string) => cliOut.push(s), err: (s: string) => cliOut.push(`ERR ${s}`) };
    const cliOut: string[] = [];
    const loaded = loadConfig({
      env: { CONFIG_DIR: env.configDir, DATA_DIR: env.dataDir },
      cwd: env.root,
    });
    const addCode = await keysCommand(
      ["add", "--label", "CLI key", "--daily-minutes", "30"],
      io,
      loaded,
    );
    const listCode = await keysCommand(["list"], io, loaded);
    await app.close(); // flushes usage
    const usageCode = await usageCommand([], io, loaded);
    const text = cliOut.join("\n");
    check(
      "CLI keys add/list + usage",
      addCode === 0 &&
        listCode === 0 &&
        usageCode === 0 &&
        text.includes("CLI key") &&
        text.includes("Tiny quota"),
    );
    if (process.env.SMOKE_VERBOSE === "1") console.log(text);
  } finally {
    await app.close();
    rmSync(env.root, { recursive: true, force: true });
  }
}

// --- phase C: exposure public + protectOverlay (behind a proxy) --------------------------------

async function phaseProtected(): Promise<void> {
  console.log("\n# exposure: public, protectOverlay, trustProxy");
  const env = makeEnv(
    "public",
    `server:
  host: 127.0.0.1
  exposure: public
  token: ${TOKEN}
  protectOverlay: true
  trustProxy: true
languagesFile: ${join(REPO, "languages.yaml")}
`,
  );
  const manager = new FakeManager("public");
  const { app, port } = await start(env, manager, []);
  const base = `http://127.0.0.1:${port}`;
  try {
    const refused = await WsProbe.open(`ws://127.0.0.1:${port}/ws`).then(
      (p) => {
        p.close();
        return false;
      },
      () => true,
    );
    check("protectOverlay: /ws without token → refused", refused);
    const overlay = await WsProbe.open(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const h = await overlay.waitFor((m) => m.type === "hello");
    check("protectOverlay: /ws?token= → hello", h !== null);
    overlay.close();
    const page = await fetch(`${base}/overlay`);
    check("protectOverlay: /overlay without token → 401", page.status === 401);
    // Behind the proxy the page origin is https://captions.example (X-Forwarded-*).
    const proxied = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`, {
      headers: {
        origin: "https://captions.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "captions.example",
      },
    });
    proxied.send(hello());
    const e = await proxied.waitFor((m) => m.type === "error");
    check(
      "trustProxy: forwarded same-origin passes the Origin check (then needs a key)",
      e?.code === "unauthorized" && String(e.message).includes("access key"),
      String(e?.message),
    );
    const csp = (
      await fetch(`${base}/ar/nl`, { headers: { "x-forwarded-host": "captions.example" } })
    ).headers.get("content-security-policy");
    check(
      "trustProxy: CSP connect-src uses the forwarded host",
      csp?.includes("wss://captions.example") === true,
    );
  } finally {
    await app.close();
    rmSync(env.root, { recursive: true, force: true });
  }
}

await phaseLocal();
await phaseLan();
await phaseProtected();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
