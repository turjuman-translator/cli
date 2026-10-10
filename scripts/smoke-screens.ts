// Smoke test for screens, signed screen links, accounts and the admin portal: in-process buildApp
// with the real SessionManager + a fake engine (scripted Soniox), temp CONFIG_DIR/
// DATA_DIR, real HTTP requests and WebSockets. Prints one PASS/FAIL line per check.
// Run: pnpm exec tsx scripts/smoke-screens.ts
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { ScreenStore } from "../src/accounts/screens.js";
import { SigningSecret } from "../src/accounts/secret.js";
import { KeyStore } from "../src/auth/keys.js";
import { screensCommand } from "../src/cli/screens-cmd.js";
import { usersCommand } from "../src/cli/users.js";
import { type LoadedConfig, loadConfig } from "../src/config.js";
import type { AudioInputApi, EngineFactory } from "../src/core/contracts.js";
import { SessionManager } from "../src/core/sessions.js";
import { buildApp } from "../src/server/app.js";
import type { Me, ProviderState, ScreenView, TrackId, UserView } from "../src/shared/protocol.js";
import type { ProviderEvent, SttProvider } from "../src/stt/types.js";

const REPO = resolve(import.meta.dirname, "..");
const TOKEN = "smoke-admin-token-0123456789";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}

// --- fake engine -------------------------------------------------------------------------------

/**
 * One final word every 3 frames; 4 words (or finalize) close the utterance with its translation
 * and an endpoint.
 */
class WordProvider implements SttProvider {
  readonly capabilities = {
    nativeTranslation: true,
    timing: "arrival" as const,
    translationFinalAtEndpoint: true,
  };
  private current: ProviderState = "idle";
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private frames = 0;
  private words: string[] = [];
  private static readonly WORDS = ["الحمد", "لله", "رب", "العالمين"];

  constructor(readonly track: TrackId) {}

  get state(): ProviderState {
    return this.current;
  }

  async start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    this.onEvent = opts.onEvent;
    this.set("connecting");
    await sleep(10);
    if (this.current === "connecting") this.set("live");
  }

  sendAudio(): void {
    this.frames++;
    if (this.frames % 3 !== 0) return;
    this.words.push(WordProvider.WORDS[this.words.length % 4] ?? "و");
    if (this.words.length >= 4) this.finish();
    else {
      this.onEvent?.({
        type: "tokens",
        final: [],
        nonFinal: [{ text: this.words.join(" "), kind: "source" }],
        receivedAt: Date.now(),
      });
    }
  }

  finalize(): void {
    if (this.words.length > 0) this.finish();
  }

  async stop(): Promise<void> {
    if (this.words.length > 0) this.finish();
    this.set("idle");
  }

  private finish(): void {
    const text = this.words.join(" ");
    this.words = [];
    this.onEvent?.({
      type: "tokens",
      final: [
        { text, kind: "source" },
        { text: "Alle lof is voor Allah, de Heer der werelden.", kind: "translation", lang: "nl" },
      ],
      nonFinal: [],
      receivedAt: Date.now(),
    });
    this.onEvent?.({ type: "endpoint", receivedAt: Date.now() });
  }

  private set(state: ProviderState): void {
    this.current = state;
    this.onEvent?.({ type: "state", state });
  }
}

const engineFactory: EngineFactory = (req) => ({ provider: new WordProvider(req.track) });

const noInput = (): AudioInputApi => {
  throw new Error("no local audio in this smoke test");
};

// --- HTTP + WebSocket helpers ------------------------------------------------------------------

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

/** The JSON body as an object ({} for arrays and non-JSON). */
function obj(r: Res): Record<string, unknown> {
  return typeof r.json === "object" && r.json !== null && !Array.isArray(r.json)
    ? (r.json as Record<string, unknown>)
    : {};
}

const sv = (r: Res): ScreenView => r.json as ScreenView;
const svs = (r: Res): ScreenView[] => (Array.isArray(r.json) ? (r.json as ScreenView[]) : []);

function call(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; cookie?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (opts.cookie !== undefined && opts.cookie !== null) {
    headers.cookie = `captions_session=${opts.cookie}`;
  }
  return new Promise((res, rej) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (c: Buffer) => chunks.push(c));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        res({ status: response.statusCode ?? 0, headers: response.headers, text, json });
      });
    });
    r.on("error", rej);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

function setCookie(res: Res): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

function cookieValue(res: Res): string | null {
  const m = /captions_session=([^;]*)/.exec(setCookie(res));
  return m?.[1] === undefined || m[1] === "" ? null : m[1];
}

type Msg = Record<string, unknown> & { type?: string };

class WsProbe {
  readonly messages: Msg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  isClosed = false;
  private wake: (() => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") this.messages.push(JSON.parse(ev.data) as Msg);
      this.wake?.();
    });
    this.closed = new Promise((res) => {
      ws.addEventListener("close", (ev) => {
        this.isClosed = true;
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

  index(pred: (m: Msg) => boolean, from = 0): number {
    const i = this.messages.slice(from).findIndex(pred);
    return i < 0 ? -1 : i + from;
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
    client: { obs: true, ua: "smoke-screens" },
    format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
    ...extra,
  });
}

/** A screen's feed link is <origin>/feed/<guid> (a random UUID: the GUID is the key). */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function linkOf(view: ScreenView): { guid: string } {
  const m = /^\/feed\/([^/?#]+)$/.exec(new URL(view.url).pathname);
  return { guid: m?.[1] ?? "" };
}

const FRAME = new Uint8Array(3200).fill(1);

/** Speech start, 13 frames (4 words → a final segment → a block), speech end. */
async function speak(page: WsProbe): Promise<void> {
  page.send(JSON.stringify({ type: "speech", state: "start" }));
  for (let i = 0; i < 13; i++) {
    page.send(FRAME);
    await sleep(70);
  }
  page.send(JSON.stringify({ type: "speech", state: "end" }));
}

interface Env {
  root: string;
  configDir: string;
  dataDir: string;
  publicDir: string;
}

function makeEnv(name: string, configYaml: string): Env {
  const root = mkdtempSync(join(tmpdir(), `smoke-screens-${name}-`));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const publicDir = join(root, "public");
  for (const d of [
    configDir,
    dataDir,
    publicDir,
    join(publicDir, "assets"),
    join(publicDir, "fonts"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  for (const page of ["picker", "caption", "control", "login", "admin"]) {
    writeFileSync(join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  }
  writeFileSync(join(configDir, "config.yaml"), configYaml);
  return { root, configDir, dataDir, publicDir };
}

async function start(
  env: Env,
  logLines: string[],
): Promise<{ app: FastifyInstance; port: number; manager: SessionManager; loaded: LoadedConfig }> {
  const loaded = loadConfig({
    env: {
      CONFIG_DIR: env.configDir,
      DATA_DIR: env.dataDir,
      SONIOX_API_KEY: "fake-soniox",
    },
    cwd: env.root,
  });
  const log = pino({ level: "info" }, { write: (line: string) => void logLines.push(line) });
  const manager = new SessionManager({
    loaded,
    engineFactory,
    audioInputFactory: noInput,
    log,
    version: "smoke",
    blocks: { detectorFactory: () => null },
  });
  const app = await buildApp({
    loaded,
    manager,
    log,
    publicDir: env.publicDir,
    version: "smoke",
    secret: new SigningSecret(join(env.configDir, "secret.key"), ""),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { app, port, manager, loaded };
}

function config(exposure: string, extra = ""): string {
  return `# smoke config (this comment must survive PATCH /api/settings)
server:
  host: 127.0.0.1
  exposure: ${exposure}
  token: ${TOKEN}
${extra}pages:
  resumeGraceSec: 1
  closeAfterSilenceSec: 2
  maxSessions: 8
  requireScreen: false # only signed links
languagesFile: ${join(REPO, "languages.yaml")}
accounts:
  sessionDays: 7
`;
}

// --- phase 1: exposure lan: accounts, screens, signed links -------------------------------------

async function phaseLan(): Promise<void> {
  console.log("\n# exposure: lan (accounts, screens, signed links)");
  const env = makeEnv("lan", config("lan"));
  const logs: string[] = [];
  const { app, port, manager } = await start(env, logs);
  const ws = `ws://127.0.0.1:${port}/ws/page`;
  const pages: WsProbe[] = [];
  const openPage = async (): Promise<WsProbe> => {
    const p = await WsProbe.open(ws);
    pages.push(p);
    return p;
  };
  try {
    // -- setup + login --
    let r = await call(port, "GET", "/api/auth/state");
    check(
      "GET /api/auth/state → setupRequired true",
      r.status === 200 && obj(r).setupRequired === true,
    );
    r = await call(port, "GET", "/admin");
    check(
      "GET /admin → admin.html (open, no-store + CSP, never framed)",
      r.status === 200 &&
        r.text.includes("admin") &&
        r.headers["cache-control"] === "no-store" &&
        String(r.headers["content-security-policy"]).includes("script-src 'self'") &&
        r.headers["x-frame-options"] === "DENY",
    );
    r = await call(port, "GET", "/login");
    check("GET /login → login.html", r.status === 200 && r.text.includes("login"));
    r = await call(port, "GET", "/api/auth/me");
    check("GET /api/auth/me without login → 401", r.status === 401);
    r = await call(port, "POST", "/api/auth/setup", {
      headers: { host: "captions.example:8765" },
      body: { username: "admin", password: "correct horse 1" },
    });
    check("setup via a non-loopback Host (proxy) → 403", r.status === 403, String(obj(r).message));
    r = await call(port, "POST", "/api/auth/setup", {
      body: { username: "admin", password: "short" },
    });
    check("setup with a 5-character password → 400", r.status === 400);
    r = await call(port, "POST", "/api/auth/setup", {
      body: { username: "Admin", password: "correct horse 1", displayName: "Abdullah" },
    });
    const adminMe = obj(r).me as Me | undefined;
    const sc = setCookie(r);
    check(
      "setup from loopback → {me} admin + cookie",
      r.status === 200 &&
        adminMe?.role === "admin" &&
        adminMe.username === "admin" &&
        adminMe.displayName === "Abdullah",
      JSON.stringify(r.json),
    );
    check(
      "cookie flags: HttpOnly; SameSite=Lax; Path=/; Max-Age=7 days; no Secure on http",
      sc.includes("HttpOnly") &&
        sc.includes("SameSite=Lax") &&
        sc.includes("Path=/") &&
        sc.includes("Max-Age=604800") &&
        !sc.includes("Secure"),
      sc.replace(/=[^;]{20,}/, "=…"),
    );
    let admin = cookieValue(r);
    r = await call(port, "POST", "/api/auth/setup", {
      body: { username: "other", password: "correct horse 2" },
    });
    check("setup a second time → 409", r.status === 409);
    r = await call(port, "GET", "/api/auth/state");
    check("state → setupRequired false", obj(r).setupRequired === false);
    r = await call(port, "GET", "/api/auth/me", { cookie: admin });
    check(
      "GET /api/auth/me with the cookie → me",
      r.status === 200 && (obj(r).me as Me | undefined)?.username === "admin",
    );

    const [payload, mac] = (admin ?? ".").split(".");
    const tampered = `${payload?.slice(0, -2)}${payload?.endsWith("A") ? "B" : "A"}${payload?.slice(-1)}.${mac}`;
    r = await call(port, "GET", "/api/auth/me", { cookie: tampered });
    check("tampered cookie payload → 401", r.status === 401);
    const forged = `${Buffer.from(JSON.stringify({ u: adminMe?.id, v: 1, exp: 9999999999 })).toString("base64url")}.${mac}`;
    r = await call(port, "GET", "/api/auth/me", { cookie: forged });
    check("forged payload with an old MAC → 401", r.status === 401);
    r = await call(port, "GET", "/api/auth/me", { cookie: `${payload}.${"A".repeat(43)}` });
    check("wrong MAC → 401", r.status === 401);

    r = await call(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "wrong password" },
    });
    check(
      "login with a wrong password → 401 generic",
      r.status === 401 && obj(r).message === "Wrong username or password",
    );
    r = await call(port, "POST", "/api/auth/login", {
      body: { username: "nobody", password: "wrong password" },
    });
    check(
      "login with an unknown user → 401 generic",
      r.status === 401 && obj(r).message === "Wrong username or password",
    );
    r = await call(port, "POST", "/api/auth/login", {
      body: { username: "ADMIN", password: "correct horse 1" },
    });
    check(
      "login (username case-insensitive) → {me} + cookie",
      r.status === 200 && cookieValue(r) !== null,
    );
    admin = cookieValue(r);

    // -- admin login works where the admin token does --
    r = await call(port, "GET", "/control");
    check("GET /control (lan) without credentials → 401", r.status === 401);
    r = await call(port, "GET", "/control", { cookie: admin });
    check("GET /control with the admin cookie → 200", r.status === 200);
    r = await call(port, "GET", "/api/sessions", { cookie: admin });
    check(
      "GET /api/sessions with the admin cookie → 200",
      r.status === 200 && Array.isArray(r.json),
    );
    r = await call(port, "GET", "/api/users", { headers: { authorization: `Bearer ${TOKEN}` } });
    check("GET /api/users with the admin token → 200", r.status === 200 && Array.isArray(r.json));

    // -- accounts --
    r = await call(port, "POST", "/api/users", {
      cookie: admin,
      body: {
        username: "imam",
        password: "imam password 1",
        displayName: "Imam Yusuf",
        role: "user",
      },
    });
    const imamView = r.json as UserView;
    check(
      "POST /api/users → 201 UserView (no hash)",
      r.status === 201 &&
        imamView.username === "imam" &&
        imamView.role === "user" &&
        !r.text.includes("scrypt"),
    );
    r = await call(port, "POST", "/api/users", {
      cookie: admin,
      body: { username: "guest", password: "guest password 1", role: "user" },
    });
    check("POST /api/users (guest) → 201", r.status === 201);
    r = await call(port, "POST", "/api/users", {
      cookie: admin,
      body: { username: "imam", password: "imam password 1" },
    });
    check("POST /api/users with a taken username → 409", r.status === 409);
    let imam = cookieValue(
      await call(port, "POST", "/api/auth/login", {
        body: { username: "imam", password: "imam password 1" },
      }),
    );
    const guest = cookieValue(
      await call(port, "POST", "/api/auth/login", {
        body: { username: "guest", password: "guest password 1" },
      }),
    );
    check("imam and guest can log in", imam !== null && guest !== null);
    r = await call(port, "GET", "/api/users", { cookie: imam });
    check("user: GET /api/users → 403", r.status === 403);
    r = await call(port, "GET", "/control", { cookie: imam });
    check("user: GET /control → 403", r.status === 403);
    r = await call(port, "GET", "/api/settings", { cookie: imam });
    check("user: GET /api/settings → 403", r.status === 403);

    // -- screens --
    r = await call(port, "POST", "/api/screens", {
      cookie: imam,
      body: {
        name: "Imam screen",
        from: "ar",
        to: "nl",
        query: "?engine=soniox&key=SECRETKEY&token=x&theme=dark&screen=zz&sig=yy",
      },
    });
    const imamScreen = r.json as ScreenView;
    check(
      "user: POST /api/screens → 201, disabled, no ownerControl, query sanitized (no engine=)",
      r.status === 201 &&
        imamScreen.enabled === false &&
        imamScreen.ownerControl === false &&
        imamScreen.query === "theme=dark" &&
        imamScreen.canEdit &&
        !imamScreen.canControl &&
        imamScreen.owner?.displayName === "Imam Yusuf",
      JSON.stringify({ q: imamScreen.query, owner: imamScreen.owner }),
    );
    const imamGuid = linkOf(imamScreen).guid;
    check(
      "ScreenView.url = <request origin>/feed/<guid> (a UUID; no query, no keys)",
      imamScreen.url === `http://127.0.0.1:${port}/feed/${imamGuid}` &&
        GUID_RE.test(imamGuid) &&
        !imamScreen.url.includes("SECRETKEY"),
      imamScreen.url,
    );
    r = await call(port, "GET", `/feed/${imamGuid}`);
    check(
      "GET /feed/<guid> → 302 to /ar/nl?<query>&screen=<guid> (no-store)",
      r.status === 302 &&
        r.headers.location === `/ar/nl?theme=dark&screen=${imamGuid}` &&
        String(r.headers["cache-control"]).includes("no-store"),
      `${r.status} ${String(r.headers.location)}`,
    );
    r = await call(port, "GET", "/feed/0b9a5f3e-6c1d-4e2f-9a8b-7c6d5e4f3a2b");
    check(
      "GET /feed/<unknown guid> → 302 to the default caption page (it shows 'link not valid')",
      r.status === 302 &&
        r.headers.location === "/ar/nl?screen=0b9a5f3e-6c1d-4e2f-9a8b-7c6d5e4f3a2b",
      `${r.status} ${String(r.headers.location)}`,
    );
    r = await call(port, "GET", "/feed/%3Cscript%3E");
    check(
      "GET /feed/<garbage> → the redirect carries it encoded",
      r.status === 302 && r.headers.location === "/ar/nl?screen=%3Cscript%3E",
      String(r.headers.location),
    );
    r = await call(port, "POST", "/api/screens", {
      cookie: admin,
      body: { name: "Main hall TV", from: "ar", to: "nl", query: "layout=blocks" },
    });
    const hall = r.json as ScreenView;
    check(
      "admin: POST /api/screens → 201 owned by the admin",
      r.status === 201 && hall.owner?.id === adminMe?.id && hall.canControl,
    );
    r = await call(port, "POST", "/api/screens", {
      cookie: admin,
      body: { name: "Bad", from: "ar", to: "xx" },
    });
    check("POST /api/screens with an unknown pair → 400", r.status === 400, String(obj(r).message));
    r = await call(port, "GET", "/api/screens", { cookie: imam });
    check(
      "user sees only own screens",
      r.status === 200 && svs(r).length === 1 && svs(r)[0]?.id === imamScreen.id,
    );
    r = await call(port, "GET", "/api/screens", { cookie: admin });
    check(
      "admin sees all, newest first",
      svs(r).length === 2 && svs(r)[0]?.id === hall.id && svs(r)[1]?.id === imamScreen.id,
    );
    r = await call(port, "GET", "/api/screens", { cookie: guest });
    check("other user sees none", r.status === 200 && svs(r).length === 0);
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/enable`, {
      cookie: guest,
      body: {},
    });
    check("other user: enable → 404", r.status === 404);
    r = await call(port, "PATCH", `/api/screens/${imamScreen.id}`, {
      cookie: guest,
      body: { name: "x" },
    });
    check("other user: PATCH → 404", r.status === 404);
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/enable`, {
      cookie: imam,
      body: {},
    });
    check("owner without ownerControl: enable → 403", r.status === 403);
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/owner-control`, {
      cookie: imam,
      body: { allowed: true },
    });
    check("owner: owner-control → 403 (admin only)", r.status === 403);
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/owner-control`, {
      cookie: admin,
      body: { allowed: true },
    });
    check(
      "admin: owner-control {allowed:true} → ownerControl",
      r.status === 200 && sv(r).ownerControl === true,
    );
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/enable`, {
      cookie: imam,
      body: {},
    });
    check(
      "owner with ownerControl: enable → enabled + lastChange",
      r.status === 200 &&
        sv(r).enabled === true &&
        sv(r).canControl === true &&
        sv(r).lastChange?.action === "enabled" &&
        sv(r).lastChange?.by === "Imam Yusuf",
    );
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/disable`, {
      cookie: imam,
      body: {},
    });
    check(
      "owner with ownerControl: disable → disabled",
      r.status === 200 && sv(r).enabled === false,
    );
    r = await call(port, "PATCH", `/api/screens/${imamScreen.id}`, {
      cookie: imam,
      body: { name: "  Imam   screen 2 ", query: "engine=gemini&theme=light&key=zz" },
    });
    check(
      "owner: PATCH name/query → edited, cleaned",
      r.status === 200 &&
        sv(r).name === "Imam screen 2" &&
        sv(r).query === "theme=light" &&
        sv(r).lastChange?.action === "edited",
    );

    // -- CSRF --
    r = await call(port, "POST", `/api/screens/${hall.id}/reset`, {
      cookie: admin,
      body: {},
      headers: { origin: "http://evil.example" },
    });
    check("CSRF: wrong Origin → 403", r.status === 403);
    r = await call(port, "POST", `/api/screens/${hall.id}/reset`, {
      cookie: admin,
      body: {},
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    check("CSRF: same Origin → 200", r.status === 200);
    r = await call(port, "POST", `/api/screens/${hall.id}/reset`, {
      cookie: admin,
      body: "{}",
      headers: { "content-type": "text/plain" },
    });
    check("CSRF: text/plain body → 415", r.status === 415);
    r = await call(port, "DELETE", `/api/screens/${imamScreen.id}`, { cookie: admin });
    check("CSRF: DELETE without a JSON content type → 415", r.status === 415);
    r = await call(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "correct horse 1" },
      headers: { origin: "http://evil.example" },
    });
    check("CSRF: login from another Origin → 403", r.status === 403);

    // -- signed links on /ws/page --
    const plain = await openPage();
    plain.send(hello());
    const noKey = await plain.waitFor((m) => m.type === "error");
    check("lan: plain hello without a key → unauthorized", noKey?.code === "unauthorized");

    const page = await openPage();
    page.send(hello({ screen: linkOf(hall) }));
    const off = await page.waitFor((m) => m.type === "screen");
    await sleep(150);
    check(
      "disabled screen → {screen disabled, name}, no ready, socket open",
      off?.state === "disabled" &&
        off.name === "Main hall TV" &&
        !page.messages.some((m) => m.type === "ready") &&
        !page.isClosed,
      JSON.stringify(off),
    );
    page.send(FRAME);
    page.send(FRAME);
    await sleep(100);
    check(
      "parked socket ignores binary frames (stays open)",
      !page.isClosed && manager.list().length === 0,
    );
    r = await call(port, "GET", "/api/screens", { cookie: admin });
    let liveHall = svs(r).find((s) => s.id === hall.id);
    check(
      "ScreenView.live: 1 page, 0 sessions",
      liveHall?.live.pages === 1 && liveHall.live.sessions === 0,
      JSON.stringify(liveHall?.live),
    );

    let mark = page.messages.length;
    r = await call(port, "POST", `/api/screens/${hall.id}/enable`, { cookie: admin, body: {} });
    const on = await page.waitFor((m) => m.type === "screen" && m.state === "enabled", 2000, mark);
    check(
      "enable → parked page gets {screen enabled}",
      r.status === 200 && on !== null && on.name === "Main hall TV",
    );
    page.send(hello({ screen: linkOf(hall) }));
    const ready = await page.waitFor((m) => m.type === "ready", 3000, mark);
    const snap = await page.waitFor((m) => m.type === "blocks.snapshot", 2000, mark);
    check(
      "second hello on the same socket → ready + blocks.snapshot",
      ready !== null &&
        snap !== null &&
        page.messages.slice(mark).filter((m) => m.type === "screen").length === 1,
    );
    const sessionId = String(ready?.sessionId);
    await speak(page);
    const block = await page.waitFor((m) => m.type === "block.add", 4000, mark);
    check("speech → block.add", block !== null, JSON.stringify(block?.block ?? null).slice(0, 80));
    r = await call(port, "GET", "/api/screens", { cookie: admin });
    liveHall = svs(r).find((s) => s.id === hall.id);
    check(
      "ScreenView.live: 1 page, 1 session, since",
      liveHall?.live.pages === 1 &&
        liveHall.live.sessions === 1 &&
        typeof liveHall.live.since === "number",
      JSON.stringify(liveHall?.live),
    );

    // A second OBS source with the same link: its own session.
    const second = await openPage();
    second.send(hello({ screen: linkOf(hall) }));
    const ready2 = await second.waitFor((m) => m.type === "ready");
    check(
      "a second page with the same link → its own session",
      ready2 !== null && ready2.sessionId !== sessionId,
    );

    // Prayer events per screen: every live page of the screen gets the card.
    type EventBlock = { kind?: string; event?: { type?: string; active?: boolean } };
    const evOf = (m: Record<string, unknown>): EventBlock => (m.block ?? {}) as EventBlock;
    mark = page.messages.length;
    let mark2nd = second.messages.length;
    r = await call(port, "POST", `/api/screens/${hall.id}/event`, {
      cookie: admin,
      body: { event: "salah" },
    });
    const salahCard = await page.waitFor(
      (m) => m.type === "block.add" && evOf(m).kind === "event" && evOf(m).event?.type === "salah",
      3000,
      mark,
    );
    const salahCard2 = await second.waitFor(
      (m) => m.type === "block.add" && evOf(m).kind === "event" && evOf(m).event?.type === "salah",
      3000,
      mark2nd,
    );
    check(
      "event salah → 200, every page of the screen gets the Salah card, live.event = salah",
      r.status === 200 && sv(r).live.event === "salah" && salahCard !== null && salahCard2 !== null,
      `${r.status} ${JSON.stringify(sv(r).live)}`,
    );
    mark = page.messages.length;
    r = await call(port, "POST", `/api/screens/${hall.id}/event`, {
      cookie: admin,
      body: { event: "none" },
    });
    const eventEnded = await page.waitFor(
      (m) => m.type === "block.update" && evOf(m).event?.active === false,
      3000,
      mark,
    );
    check(
      "event none → the card ends, live.event = null",
      r.status === 200 && sv(r).live.event === null && eventEnded !== null,
      `${r.status} ${JSON.stringify(sv(r).live)}`,
    );
    r = await call(port, "POST", `/api/screens/${hall.id}/event`, {
      cookie: admin,
      body: { event: "fajr" },
    });
    check("event with an unknown name → 400", r.status === 400);
    await call(port, "POST", `/api/screens/${imamScreen.id}/owner-control`, {
      cookie: admin,
      body: { allowed: false },
    });
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/event`, {
      cookie: imam,
      body: { event: "athan" },
    });
    check("owner without ownerControl: event → 403", r.status === 403, String(r.status));
    await call(port, "POST", `/api/screens/${imamScreen.id}/owner-control`, {
      cookie: admin,
      body: { allowed: true },
    });
    r = await call(port, "POST", `/api/screens/${imamScreen.id}/event`, {
      cookie: imam,
      body: { event: "athan" },
    });
    check(
      "owner with ownerControl, screen off: event → 409",
      r.status === 409,
      `${r.status} ${String(obj(r).message)}`,
    );

    // A new look reaches the OBS pages without a new link: they reload /feed/<guid>.
    mark = page.messages.length;
    mark2nd = second.messages.length;
    r = await call(port, "PATCH", `/api/screens/${hall.id}`, {
      cookie: admin,
      body: { query: "layout=blocks&theme=light" },
    });
    const reload = await page.waitFor(
      (m) => m.type === "screen" && m.state === "reload",
      2000,
      mark,
    );
    const reload2 = await second.waitFor(
      (m) => m.type === "screen" && m.state === "reload",
      2000,
      mark2nd,
    );
    check(
      "PATCH the look → every page of the screen gets {screen reload}",
      r.status === 200 && reload !== null && reload2 !== null,
    );

    // Reset.
    mark = page.messages.length;
    const mark2 = second.messages.length;
    r = await call(port, "POST", `/api/screens/${hall.id}/reset`, { cookie: admin, body: {} });
    const clear = await page.waitFor((m) => m.type === "clear", 2000, mark);
    const emptied = await page.waitFor((m) => m.type === "blocks.snapshot", 2000, mark);
    const clearAt = page.index((m) => m.type === "clear", mark);
    const snapAt = page.index((m) => m.type === "blocks.snapshot", mark);
    check(
      "reset → {clear all} then an empty blocks.snapshot",
      r.status === 200 &&
        sv(r).lastChange?.action === "reset" &&
        clear?.track === "all" &&
        Array.isArray(emptied?.blocks) &&
        (emptied?.blocks as unknown[] | undefined)?.length === 0 &&
        emptied?.hasMore === false &&
        clearAt < snapAt,
    );
    check(
      "reset reaches every page of the screen",
      (await second.waitFor((m) => m.type === "clear", 2000, mark2)) !== null,
    );
    r = await call(port, "GET", `/api/sessions/${sessionId}/blocks`, { cookie: imam });
    check(
      "after reset the block history is empty (viewer route accepts a login)",
      r.status === 200 && Array.isArray(obj(r).blocks) && (obj(r).blocks as unknown[]).length === 0,
      `status ${r.status}`,
    );
    const folder = readdirSync(join(env.dataDir, "transcripts")).find((d) =>
      d.endsWith(`_${sessionId}`),
    );
    const blocksFile =
      folder === undefined
        ? ""
        : readFileSync(join(env.dataDir, "transcripts", folder, "blocks.jsonl"), "utf8");
    check(
      "blocks.jsonl keeps the block and gets a {type:clear,at} line",
      blocksFile.includes('"kind":"speech"') && /\{"type":"clear","at":\d+\}/.test(blocksFile),
    );

    // Disable while live.
    mark = page.messages.length;
    r = await call(port, "POST", `/api/screens/${hall.id}/disable`, { cookie: admin, body: {} });
    const ended = await page.waitFor((m) => m.type === "session.ended", 6000, mark);
    const parked = await page.waitFor(
      (m) => m.type === "screen" && m.state === "disabled",
      6000,
      mark,
    );
    const endedAt = page.index((m) => m.type === "session.ended", mark);
    const parkedAt = page.index((m) => m.type === "screen", mark);
    await sleep(100);
    check(
      "disable while live → session.ended, then {screen disabled}; socket stays open",
      r.status === 200 && ended !== null && parked !== null && endedAt < parkedAt && !page.isClosed,
    );
    check(
      "…and the screen's sessions are stopped",
      manager.get(sessionId) === undefined && manager.list().length === 0,
      JSON.stringify(manager.list().map((s) => s.id)),
    );
    const sessionLog =
      folder === undefined
        ? ""
        : readFileSync(join(env.dataDir, "transcripts", folder, "session.jsonl"), "utf8");
    check(
      "…transcripts written (stop marker)",
      sessionLog.includes('"type":"stop"') && sessionLog.includes("screen disabled"),
    );

    // Enable again: the same socket handshakes a third time.
    mark = page.messages.length;
    await call(port, "POST", `/api/screens/${hall.id}/enable`, { cookie: admin, body: {} });
    await page.waitFor((m) => m.type === "screen" && m.state === "enabled", 2000, mark);
    page.send(hello({ screen: linkOf(hall) }));
    const ready3 = await page.waitFor((m) => m.type === "ready", 3000, mark);
    check(
      "enable again → {screen enabled} → hello → ready (same socket)",
      ready3 !== null && ready3.sessionId !== sessionId,
    );

    // Resume re-checks the screen: drop the socket, disable, resume → parked.
    // Disable and enable again at once (the session may still be stopping): the page wakes.
    mark = page.messages.length;
    await call(port, "POST", `/api/screens/${hall.id}/disable`, { cookie: admin, body: {} });
    await call(port, "POST", `/api/screens/${hall.id}/enable`, { cookie: admin, body: {} });
    const rewake = await page.waitFor(
      (m) => m.type === "screen" && m.state === "enabled",
      6000,
      mark,
    );
    page.send(hello({ screen: linkOf(hall) }));
    const ready4 = await page.waitFor((m) => m.type === "ready", 3000, mark);
    check(
      "disable + enable in quick succession → disabled, enabled, hello → ready",
      rewake !== null && ready4 !== null && manager.list().length === 1,
      JSON.stringify(
        page.messages
          .slice(mark)
          .map((m) => `${m.type}${m.state === undefined ? "" : `:${String(m.state)}`}`),
      ),
    );

    const resumeId = String(ready4?.sessionId);
    page.close();
    await page.closed;
    await call(port, "POST", `/api/screens/${hall.id}/disable`, { cookie: admin, body: {} });
    const resumed = await openPage();
    resumed.send(hello({ screen: linkOf(hall), resume: resumeId }));
    const resumedMsg = await resumed.waitFor((m) => m.type === "screen" || m.type === "ready");
    check(
      "resume of a disabled screen → {screen disabled} (no ready)",
      resumedMsg?.type === "screen" && resumedMsg.state === "disabled",
    );

    // Pair mismatch.
    const mismatch = await openPage();
    mismatch.send(hello({ screen: linkOf(hall), to: "en" }));
    const mm = await mismatch.waitFor((m) => m.type === "error");
    check(
      "link used with other languages → screen_invalid + close",
      mm?.code === "screen_invalid" && (await mismatch.closed).code === 1008,
    );

    // Regenerate.
    const oldLink = linkOf(hall);
    r = await call(port, "POST", `/api/screens/${hall.id}/regenerate`, { cookie: admin, body: {} });
    const regenerated = r.json as ScreenView;
    const invalid = await resumed.waitFor((m) => m.type === "error");
    check(
      "regenerate → connected pages get screen_invalid + close",
      invalid?.code === "screen_invalid" &&
        invalid.message === "This link is no longer valid" &&
        (await resumed.closed).code === 1008,
    );
    check(
      "regenerate → a new GUID",
      r.status === 200 &&
        GUID_RE.test(linkOf(regenerated).guid) &&
        linkOf(regenerated).guid !== oldLink.guid &&
        regenerated.lastChange?.action === "regenerated",
    );
    r = await call(port, "GET", `/feed/${oldLink.guid}`);
    check(
      "old GUID: GET /feed/<old guid> → the default page (not the screen's look)",
      r.status === 302 && r.headers.location === `/ar/nl?screen=${oldLink.guid}`,
    );
    const stale = await openPage();
    stale.send(hello({ screen: oldLink }));
    check(
      "old GUID → screen_invalid",
      (await stale.waitFor((m) => m.type === "error"))?.code === "screen_invalid",
    );
    const fresh = await openPage();
    fresh.send(hello({ screen: linkOf(regenerated) }));
    const freshMsg = await fresh.waitFor((m) => m.type === "screen");
    check("new GUID → accepted (screen is off → waiting)", freshMsg?.state === "disabled");
    const bogus = await openPage();
    bogus.send(hello({ screen: { guid: "0b9a5f3e-6c1d-4e2f-9a8b-7c6d5e4f3a2b" } }));
    check(
      "unknown screen → screen_invalid",
      (await bogus.waitFor((m) => m.type === "error"))?.code === "screen_invalid",
    );

    // requireScreen (settings).
    const keys = new KeyStore(join(env.configDir, "keys.yaml"));
    const { key } = keys.add({ label: "smoke" });
    const keyed = await openPage();
    keyed.send(hello({ key }));
    check(
      "plain page with an access key → ready (requireScreen off)",
      (await keyed.waitFor((m) => m.type === "ready")) !== null,
    );
    keyed.close();
    r = await call(port, "PATCH", "/api/settings", { cookie: imam, body: { requireScreen: true } });
    check("user: PATCH /api/settings → 403", r.status === 403);
    r = await call(port, "PATCH", "/api/settings", {
      cookie: admin,
      body: { requireScreen: true },
    });
    const cfgText = readFileSync(join(env.configDir, "config.yaml"), "utf8");
    check(
      "admin: PATCH /api/settings → {requireScreen:true}",
      r.status === 200 && obj(r).requireScreen === true,
    );
    check(
      "…written to config.yaml, comments kept",
      /requireScreen: true/.test(cfgText) &&
        cfgText.includes("# smoke config (this comment must survive") &&
        cfgText.includes("# only signed links"),
    );
    r = await call(port, "GET", "/api/settings", { cookie: admin });
    check("GET /api/settings → requireScreen true", obj(r).requireScreen === true);
    const required = await openPage();
    required.send(hello({ key }));
    check(
      "requireScreen on → plain hello gets screen_required",
      (await required.waitFor((m) => m.type === "error"))?.code === "screen_required",
    );
    const stillOk = await openPage();
    stillOk.send(hello({ screen: linkOf(regenerated) }));
    check(
      "requireScreen on → screen links still work",
      (await stillOk.waitFor((m) => m.type === "screen"))?.state === "disabled",
    );
    await call(port, "PATCH", "/api/settings", { cookie: admin, body: { requireScreen: false } });

    // Delete a screen with a connected page.
    r = await call(port, "DELETE", `/api/screens/${hall.id}`, { cookie: admin, body: {} });
    check("DELETE /api/screens/:id → 204", r.status === 204, `${r.status} ${r.text.slice(0, 200)}`);
    check(
      "…its pages get screen_invalid",
      (await stillOk.waitFor((m) => m.type === "error"))?.code === "screen_invalid",
    );

    // Password change logs out other devices.
    const imamPhone = imam;
    r = await call(port, "POST", "/api/auth/password", {
      cookie: imam,
      body: { current: "wrong one!", next: "imam password 2" },
    });
    check("password change with a wrong current password → 403", r.status === 403);
    r = await call(port, "POST", "/api/auth/password", {
      cookie: imam,
      body: { current: "imam password 1", next: "short" },
    });
    check("password change to a short password → 400", r.status === 400);
    r = await call(port, "POST", "/api/auth/password", {
      cookie: imam,
      body: { current: "imam password 1", next: "imam password 2" },
    });
    imam = cookieValue(r);
    check("password change → 204 + a new cookie", r.status === 204 && imam !== null);
    check(
      "…the old cookie (other device) is logged out",
      (await call(port, "GET", "/api/auth/me", { cookie: imamPhone })).status === 401,
    );
    check(
      "…the new cookie works",
      (await call(port, "GET", "/api/auth/me", { cookie: imam })).status === 200,
    );

    // Last-admin protection.
    r = await call(port, "PATCH", `/api/users/${adminMe?.id}`, {
      cookie: admin,
      body: { role: "user" },
    });
    check("admin cannot demote itself → 409", r.status === 409);
    r = await call(port, "POST", "/api/users", {
      cookie: admin,
      body: { username: "admin2", password: "second admin 1", role: "admin" },
    });
    const admin2Id = String(obj(r).id);
    const admin2 = cookieValue(
      await call(port, "POST", "/api/auth/login", {
        body: { username: "admin2", password: "second admin 1" },
      }),
    );
    r = await call(port, "PATCH", `/api/users/${adminMe?.id}`, {
      cookie: admin2,
      body: { disabled: true },
    });
    check(
      "another admin can disable the first admin",
      r.status === 200 && obj(r).disabled === true,
    );
    check(
      "…which logs it out",
      (await call(port, "GET", "/api/auth/me", { cookie: admin })).status === 401,
    );
    r = await call(port, "PATCH", `/api/users/${admin2Id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { role: "user" },
    });
    check("last enabled admin cannot be demoted → 409", r.status === 409, String(obj(r).message));
    r = await call(port, "DELETE", `/api/users/${admin2Id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {},
    });
    check("last enabled admin cannot be deleted → 409", r.status === 409);
    r = await call(port, "DELETE", `/api/users/${imamView.id}`, { cookie: admin2, body: {} });
    check("DELETE /api/users/:id → 204", r.status === 204);
    r = await call(port, "GET", "/api/screens", { cookie: admin2 });
    const moved = svs(r).find((s) => s.id === imamScreen.id);
    check("…their screens move to the deleting admin", moved?.owner?.id === admin2Id);
    check(
      "…and the deleted account is logged out",
      (await call(port, "GET", "/api/auth/me", { cookie: imam })).status === 401,
    );

    // Logout.
    r = await call(port, "POST", "/api/auth/logout", { cookie: admin2, body: {} });
    check("logout → 204 + cookie cleared", r.status === 204 && setCookie(r).includes("Max-Age=0"));

    // Files.
    const mode = (f: string): string => (statSync(join(env.configDir, f)).mode & 0o777).toString(8);
    check(
      "users.yaml, screens.yaml and secret.key are mode 0600",
      mode("users.yaml") === "600" &&
        mode("screens.yaml") === "600" &&
        mode("secret.key") === "600",
      `${mode("users.yaml")} ${mode("screens.yaml")} ${mode("secret.key")}`,
    );
    const usersYaml = readFileSync(join(env.configDir, "users.yaml"), "utf8");
    check(
      "users.yaml holds scrypt hashes only",
      usersYaml.includes("scrypt$16384$8$1$") && !usersYaml.includes("second admin 1"),
    );

    // Login rate limit (last: it blocks 127.0.0.1 for 10 minutes).
    let limited: Res | null = null;
    for (let i = 0; i < 12 && limited === null; i++) {
      const attempt = await call(port, "POST", "/api/auth/login", {
        body: { username: "admin2", password: `wrong ${i}` },
      });
      if (attempt.status === 429) limited = attempt;
    }
    check(
      "login rate limit → 429 + Retry-After",
      limited !== null && Number(limited.headers["retry-after"]) > 0,
    );
    r = await call(port, "POST", "/api/auth/login", {
      body: { username: "admin2", password: "second admin 1" },
    });
    check("…even the right password is refused while blocked", r.status === 429);

    // Logs: never passwords, cookies, secrets or feed GUIDs (a GUID is the link's key).
    const allLogs = logs.join("\n");
    const secretKey = readFileSync(join(env.configDir, "secret.key"), "utf8").trim();
    check(
      "logs carry no password, cookie, secret or feed GUID",
      !allLogs.includes("correct horse 1") &&
        !allLogs.includes("imam password") &&
        !allLogs.includes(String(admin2)) &&
        !allLogs.includes(secretKey) &&
        !allLogs.includes(linkOf(regenerated).guid) &&
        !allLogs.includes(oldLink.guid),
    );
    check(
      "screen actions are logged with user + screen",
      /"user":"admin","screen":"[a-z2-7]{10}".*"msg":"portal: screen enabled"/.test(allLogs),
    );
  } finally {
    for (const p of pages) p.close();
    await app.close();
    await manager.stopAll("smoke done");
    rmSync(env.root, { recursive: true, force: true });
  }
}

// --- phase 2: exposure public + trustProxy -----------------------------------------------------

async function phasePublic(): Promise<void> {
  console.log("\n# exposure: public, trustProxy (setup by token, Secure cookie, forwarded origin)");
  const env = makeEnv("public", config("public", "  trustProxy: true\n"));
  const { app, port, manager } = await start(env, []);
  const proxied = {
    "x-forwarded-for": "203.0.113.9",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "captions.example",
  };
  try {
    let r = await call(port, "POST", "/api/auth/setup", {
      headers: proxied,
      body: { username: "admin", password: "correct horse 1" },
    });
    check("setup from a remote client (forwarded) → 403", r.status === 403);
    r = await call(port, "POST", "/api/auth/setup", {
      headers: { ...proxied, authorization: `Bearer ${TOKEN}` },
      body: { username: "admin", password: "correct horse 1" },
    });
    const admin = cookieValue(r);
    check(
      "setup with the admin token → 200 + Secure cookie (https)",
      r.status === 200 && setCookie(r).includes("; Secure") && admin !== null,
    );
    r = await call(port, "POST", "/api/screens", {
      cookie: admin,
      headers: { ...proxied, origin: "https://captions.example" },
      body: { name: "Remote TV", from: "ar", to: "nl" },
    });
    const screen = r.json as ScreenView;
    check(
      "same forwarded Origin → allowed; url uses https://captions.example/feed/<guid>",
      r.status === 201 && screen.url === `https://captions.example/feed/${screen.guid}`,
      screen.url,
    );
    r = await call(port, "POST", "/api/screens", {
      cookie: admin,
      headers: { ...proxied, origin: "http://captions.example" },
      body: { name: "x", from: "ar", to: "nl" },
    });
    check("Origin with the wrong scheme → 403", r.status === 403);
    const page = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`, {
      headers: { origin: "https://captions.example", ...proxied },
    });
    page.send(hello({ screen: linkOf(screen) }));
    check(
      "public: a screen link needs no access key",
      (await page.waitFor((m) => m.type === "screen"))?.state === "disabled",
    );
    page.close();
  } finally {
    await app.close();
    await manager.stopAll("smoke done");
    rmSync(env.root, { recursive: true, force: true });
  }
}

// --- phase 3: exposure local --------------------------------------------------------------------

async function phaseLocal(): Promise<void> {
  console.log("\n# exposure: local");
  const env = makeEnv("local", config("local"));
  const { app, port, manager } = await start(env, []);
  try {
    let r = await call(port, "GET", "/api/screens");
    check("local: the portal API still needs a login → 401", r.status === 401);
    r = await call(port, "GET", "/control");
    check("local: /control stays open", r.status === 200);
    r = await call(port, "GET", "/login/x");
    check("/login/x is not a language pair (reserved) → 404", r.status === 404);
    r = await call(port, "POST", "/api/auth/setup", {
      body: { username: "owner", password: "correct horse 1" },
    });
    check("local: first admin from this machine → 200", r.status === 200);
    const page = await WsProbe.open(`ws://127.0.0.1:${port}/ws/page`);
    page.send(hello());
    check(
      "local: plain caption pages work as before",
      (await page.waitFor((m) => m.type === "ready")) !== null,
    );
    page.close();
  } finally {
    await app.close();
    await manager.stopAll("smoke done");
    rmSync(env.root, { recursive: true, force: true });
  }
}

// --- phase 4: CLI -------------------------------------------------------------------------------

async function phaseCli(): Promise<void> {
  console.log("\n# CLI: captions users / screens");
  const env = makeEnv("cli", config("local"));
  const loaded = loadConfig({
    env: { CONFIG_DIR: env.configDir, DATA_DIR: env.dataDir },
    cwd: env.root,
  });
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) };
  try {
    let code = await usersCommand(
      ["add", "Abdullah", "--admin", "--name", "Abdullah H"],
      io,
      loaded,
      { readPassword: async () => null },
    );
    const generated = /Password: (\S+)/.exec(out.join("\n"))?.[1] ?? "";
    check(
      "users add --admin (no stdin) → generated 16-char password, printed once",
      code === 0 && generated.length === 16 && out.join("\n").includes("admin account abdullah"),
    );
    out.length = 0;
    code = await usersCommand(["add", "imam"], io, loaded, {
      readPassword: async () => "piped password 1",
    });
    check(
      "users add with a piped password → no password printed",
      code === 0 && !out.join("\n").includes("Password:"),
    );
    code = await usersCommand(["add", "short"], io, loaded, { readPassword: async () => "short" });
    check("users add with a short piped password → refused", code === 2);
    out.length = 0;
    code = await usersCommand(["list"], io, loaded);
    check(
      "users list → both accounts",
      code === 0 &&
        out.join("\n").includes("abdullah") &&
        out.join("\n").includes("imam") &&
        !out.join("\n").includes("scrypt"),
    );
    out.length = 0;
    code = await usersCommand(["passwd", "imam"], io, loaded, {
      readPassword: async () => "piped password 2",
    });
    check(
      "users passwd → logged out everywhere",
      code === 0 && out.join("\n").includes("logged out"),
    );
    err.length = 0;
    code = await usersCommand(["remove", "abdullah"], io, loaded);
    check(
      "users remove of the last admin → refused",
      code === 1 && err.join("\n").includes("last enabled admin"),
    );
    const screens = new ScreenStore(loaded.paths.screensFile);
    const created = screens.create(
      { name: "Hall", from: "ar", to: "nl", query: "layout=blocks", ownerId: null },
      { id: null, name: "smoke" },
    );
    out.length = 0;
    code = await screensCommand(["list"], io, () => loaded, { lan: null });
    const link = /(http:\/\/127\.0\.0\.1:\d+\/feed\/\S+)/.exec(out.join("\n"))?.[1] ?? "";
    const guid = /\/feed\/([^/?#]+)$/.exec(link)?.[1] ?? "";
    const verified = guid === "" ? null : screens.byGuid(guid);
    check(
      "screens list → the /feed/<guid> link of that screen",
      code === 0 && verified?.id === created.id && out.join("\n").includes("Hall"),
    );
    code = await usersCommand(["remove", "imam"], io, loaded);
    check("users remove imam → 0", code === 0);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
}

await phaseLan();
await phasePublic();
await phaseLocal();
await phaseCli();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
