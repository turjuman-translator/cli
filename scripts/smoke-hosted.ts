// Smoke test for hosted mode: in-process buildApp with the real SessionManager
// and KeyResolver, fake engines that record the API key they were given, a fake provider check,
// temp CONFIG_DIR/DATA_DIR, real HTTP requests and WebSockets. Two mosques sign up; each screen's
// caption page must run with its own mosque's key, and neither mosque can see or switch the other's
// screens. Prints one PASS/FAIL line per check.
// Run: pnpm exec tsx scripts/smoke-hosted.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pino } from "pino";
import { KeyResolver } from "../src/accounts/key-resolver.js";
import { MasterKey } from "../src/accounts/keystore.js";
import { OrgStore } from "../src/accounts/orgs.js";
import { SigningSecret } from "../src/accounts/secret.js";
import { loadConfig } from "../src/config.js";
import type { AudioInputApi, EngineFactory } from "../src/core/contracts.js";
import { SessionManager } from "../src/core/sessions.js";
import { orgUsageKey, UsageStore } from "../src/core/usage.js";
import { buildApp } from "../src/server/app.js";
import type { OrgView, ProviderState, ScreenView, TrackId } from "../src/shared/protocol.js";
import type { ProviderEvent, SttProvider } from "../src/stt/types.js";

const REPO = resolve(import.meta.dirname, "..");
const PASSWORD = "smoke-hosted-password";
const KEY_A = "soniox-key-of-mosque-A-0001";
const ENV_KEY = "soniox-key-of-the-server-9999";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}

// --- a fake engine that remembers its key -------------------------------------------------------

/** Engine starts and the Soniox key each was given (null: none). */
const engineKeys: Array<string | null> = [];

/** One final word every 3 frames; finalize closes the utterance. */
class WordProvider implements SttProvider {
  readonly capabilities = {
    nativeTranslation: true,
    timing: "arrival" as const,
    translationFinalAtEndpoint: true,
  };
  private current: ProviderState = "idle";
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  private frames = 0;

  constructor(readonly track: TrackId) {}

  get state(): ProviderState {
    return this.current;
  }

  async start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    this.onEvent = opts.onEvent;
    this.set("live");
  }

  sendAudio(): void {
    if (++this.frames % 3 !== 0) return;
    this.onEvent?.({
      type: "tokens",
      final: [
        { text: "الحمد لله ", kind: "source" },
        { text: "Alle lof ", kind: "translation", lang: "nl" },
      ],
      nonFinal: [],
      receivedAt: Date.now(),
    });
  }

  finalize(): void {
    this.onEvent?.({ type: "endpoint", receivedAt: Date.now() });
  }

  async stop(): Promise<void> {
    this.set("idle");
  }

  private set(state: ProviderState): void {
    this.current = state;
    this.onEvent?.({ type: "state", state });
  }
}

const engineFactory: EngineFactory = (req) => {
  engineKeys.push(req.secrets?.sonioxApiKey ?? null);
  return { provider: new WordProvider(req.track) };
};

const noInput = (): AudioInputApi => {
  throw new Error("no local audio in this smoke test");
};

// --- HTTP + WebSocket helpers ------------------------------------------------------------------

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
  text: string;
}

function call(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (opts.cookie) headers.cookie = opts.cookie;
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
        res({ status: response.statusCode ?? 0, headers: response.headers, json, text });
      });
    });
    r.on("error", rej);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

function cookieOf(res: Res): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return first.split(";")[0] ?? "";
}

type Msg = Record<string, unknown> & { type?: string };

class Page {
  readonly messages: Msg[] = [];
  readonly closed: Promise<number>;
  private wake: (() => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") this.messages.push(JSON.parse(ev.data) as Msg);
      this.wake?.();
    });
    this.closed = new Promise((res) => ws.addEventListener("close", (ev) => res(ev.code)));
  }

  static open(port: number, cookie?: string): Promise<Page> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/page`, {
      headers: cookie === undefined ? {} : { cookie },
    } as WebSocketInit);
    const page = new Page(ws);
    return new Promise((res, rej) => {
      ws.addEventListener("open", () => res(page));
      ws.addEventListener("error", () => rej(new Error("WebSocket failed")));
    });
  }

  async waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(pred);
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

  hello(screen?: string): void {
    this.ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        from: "ar",
        to: "nl",
        resume: null,
        client: { obs: true, ua: "smoke-hosted" },
        format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
        layout: "rollup",
        ...(screen === undefined ? {} : { screen: { guid: screen } }),
      }),
    );
  }

  async speak(): Promise<void> {
    this.ws.send(JSON.stringify({ type: "speech", state: "start" }));
    for (let i = 0; i < 6; i++) {
      this.ws.send(new Uint8Array(3200).fill(1));
      await sleep(60);
    }
    this.ws.send(JSON.stringify({ type: "speech", state: "end" }));
  }

  close(): void {
    this.ws.close();
  }
}

const guidOf = (view: ScreenView): string => view.url.split("/feed/")[1] ?? "";

// --- the run -------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "smoke-hosted-"));
const configDir = join(root, "config");
const dataDir = join(root, "data");
const publicDir = join(root, "public");
for (const d of [configDir, dataDir, join(publicDir, "assets"), join(publicDir, "fonts")]) {
  mkdirSync(d, { recursive: true });
}
for (const page of ["caption", "login", "admin", "signup", "keys"]) {
  writeFileSync(join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
}
writeFileSync(
  join(configDir, "config.yaml"),
  `mode: hosted
hosted:
  signup: open
server:
  host: 127.0.0.1
pages:
  resumeGraceSec: 1
  closeAfterSilenceSec: 2
languagesFile: ${join(REPO, "languages.yaml")}
`,
);
const loaded = loadConfig({
  env: { CONFIG_DIR: configDir, DATA_DIR: dataDir, SONIOX_API_KEY: ENV_KEY },
  cwd: root,
});
const logLines: string[] = [];
const log = pino({ level: "info" }, { write: (line: string) => void logLines.push(line) });
const orgs = new OrgStore(loaded.paths.orgsFile);
const keyResolver = new KeyResolver({
  mode: "hosted",
  env: loaded.secrets,
  orgs,
  master: new MasterKey(loaded.paths.masterKeyFile, ""),
  log,
});
const usage = new UsageStore({ dir: loaded.paths.usageDir, flushIntervalMs: 0 });
const manager = new SessionManager({
  loaded,
  engineFactory,
  audioInputFactory: noInput,
  log,
  version: "smoke",
  keys: (orgId) => keyResolver.resolve(orgId),
});
const app = await buildApp({
  loaded,
  manager,
  log,
  publicDir,
  version: "smoke",
  usage,
  orgs,
  keyResolver,
  secret: new SigningSecret(join(configDir, "secret.key"), ""),
  checkKey: async (_provider, key) =>
    key.includes("bad")
      ? { result: "rejected", message: "Soniox did not accept this key." }
      : { result: "ok" },
});
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

try {
  // Sign-up: two mosques.
  let r = await call(port, "GET", "/api/auth/state");
  check(
    "auth state: hosted, sign-up open",
    JSON.stringify(r.json) ===
      '{"setupRequired":false,"mode":"hosted","signup":true,"loggedIn":false}',
  );
  r = await call(port, "POST", "/api/auth/signup", {
    body: { orgName: "Masjid A", name: "Imam A", email: "a@example.nl", password: PASSWORD },
  });
  const a = cookieOf(r);
  check("mosque A signs up → 201 + login cookie", r.status === 201 && a !== "");
  r = await call(port, "POST", "/api/auth/signup", {
    body: { orgName: "Masjid B", name: "Imam B", email: "b@example.nl", password: PASSWORD },
  });
  const b = cookieOf(r);
  check("mosque B signs up → 201", r.status === 201 && b !== "");

  // Keys: checked, stored encrypted, never shown.
  r = await call(port, "PUT", "/api/org/keys/soniox", {
    cookie: a,
    body: { key: "bad-key-0123456789" },
  });
  check("a rejected key → 400, not stored", r.status === 400);
  r = await call(port, "PUT", "/api/org/keys/soniox", { cookie: a, body: { key: KEY_A } });
  check(
    "A stores its Soniox key → checked",
    r.status === 200 && (r.json as { checked: boolean }).checked,
  );
  const orgA = (await call(port, "GET", "/api/org", { cookie: a })).json as OrgView;
  check(
    "GET /api/org shows only the last four characters",
    orgA.keys.soniox.set &&
      orgA.keys.soniox.last4 === "0001" &&
      !JSON.stringify(orgA).includes(KEY_A),
  );
  const orgsText = readFileSync(loaded.paths.orgsFile, "utf8");
  check(
    "orgs.yaml holds the key encrypted only",
    orgsText.includes("enc:v1:") && !orgsText.includes(KEY_A),
  );

  // Screens.
  r = await call(port, "POST", "/api/screens", {
    cookie: a,
    body: {
      name: "Hall A",
      from: "ar",
      to: "nl",
      query: "layout=rollup",
    },
  });
  const screenA = r.json as ScreenView;
  check("A creates a screen", r.status === 201);
  await call(port, "POST", `/api/screens/${screenA.id}/enable`, { cookie: a, body: {} });
  r = await call(port, "POST", "/api/screens", {
    cookie: b,
    body: {
      name: "Hall B",
      from: "ar",
      to: "nl",
      query: "layout=rollup",
    },
  });
  const screenB = r.json as ScreenView;
  await call(port, "POST", `/api/screens/${screenB.id}/enable`, { cookie: b, body: {} });

  r = await call(port, "GET", "/api/screens", { cookie: b });
  check(
    "B does not see A's screen",
    Array.isArray(r.json) && (r.json as ScreenView[]).every((s) => s.id !== screenA.id),
  );
  for (const action of ["disable", "reset", "regenerate"]) {
    r = await call(port, "POST", `/api/screens/${screenA.id}/${action}`, { cookie: b, body: {} });
    check(`B cannot ${action} A's screen → 404`, r.status === 404);
  }
  r = await call(port, "POST", `/api/screens/${screenA.id}/event`, {
    cookie: b,
    body: { event: "athan" },
  });
  check("B cannot start a prayer event on A's screen → 404", r.status === 404);

  // A's feed runs with A's key.
  let page = await Page.open(port);
  page.hello(guidOf(screenA));
  const ready = await page.waitFor((m) => m.type === "ready");
  await page.speak();
  const seg = await page.waitFor((m) => m.type === "segment");
  check("A's screen → ready and captions", ready !== null && seg !== null);
  check(
    "A's session ran with A's key (not the server's)",
    engineKeys.at(-1) === KEY_A,
    String(engineKeys.at(-1)),
  );

  // B has no key yet: a calm message, no engine.
  const before = engineKeys.length;
  const pageB = await Page.open(port);
  pageB.hello(guidOf(screenB));
  const errB = await pageB.waitFor((m) => m.type === "error");
  check(
    "B's screen without a key → engine_unavailable (Keys)",
    errB?.code === "engine_unavailable" &&
      String(errB.message).includes("Keys") &&
      engineKeys.length === before,
    String(errB?.message),
  );

  // No screen link: a login is needed in hosted mode, and it decides the organisation.
  const anon = await Page.open(port);
  anon.hello();
  const errAnon = await anon.waitFor((m) => m.type === "error");
  check("no screen link, no login → unauthorized", errAnon?.code === "unauthorized");
  const preview = await Page.open(port, a);
  preview.hello();
  check(
    "A's login previews without a link → ready",
    (await preview.waitFor((m) => m.type === "ready")) !== null,
  );
  await preview.speak();
  await preview.waitFor((m) => m.type === "segment");
  check("the preview ran with A's key", engineKeys.at(-1) === KEY_A);
  preview.close();

  // A member's login stands in for a screen link; disabling the account stops its page.
  r = await call(port, "POST", "/api/users", {
    cookie: a,
    body: { email: "member@example.nl", password: PASSWORD },
  });
  check("A adds a member → 201", r.status === 201);
  const memberId = (r.json as { id: string }).id;
  r = await call(port, "POST", "/api/auth/login", {
    body: { username: "member@example.nl", password: PASSWORD },
  });
  const member = cookieOf(r);
  const memberPage = await Page.open(port, member);
  memberPage.hello();
  check(
    "the member previews → ready",
    (await memberPage.waitFor((m) => m.type === "ready")) !== null,
  );
  await memberPage.speak();
  r = await call(port, "PATCH", `/api/users/${memberId}`, { cookie: a, body: { disabled: true } });
  check("the owner disables the member → 200", r.status === 200);
  await memberPage.speak();
  const revoked = await memberPage.waitFor((m) => m.type === "error", 12_000);
  check(
    "the disabled member's running page stops",
    revoked?.code === "unauthorized",
    String(revoked?.message),
  );
  memberPage.close();

  // Usage is counted per organisation.
  await sleep(11_000);
  const aId = orgA.id;
  const rows = usage.report().rows;
  check(
    "usage is counted under A's organisation",
    rows.some((row) => row.keyId === orgUsageKey(aId) && row.monthMinutes > 0),
    JSON.stringify(rows.map((row) => row.keyId)),
  );

  // The operator disables A: its running page stops at the next usage report.
  orgs.setDisabled(aId, true);
  await page.speak();
  const stopped = await page.waitFor((m) => m.type === "error", 12_000);
  check(
    "disabling A stops its running page",
    stopped?.code === "unauthorized",
    String(stopped?.message),
  );
  page = await Page.open(port);
  page.hello(guidOf(screenA));
  check(
    "a disabled mosque's feed → unauthorized",
    (await page.waitFor((m) => m.type === "error"))?.code === "unauthorized",
  );
  r = await call(port, "GET", "/api/auth/me", { cookie: a });
  check("a disabled mosque's login no longer works", r.status === 401);

  check(
    "no API key in the logs",
    !logLines.some(
      (l) => l.includes(KEY_A) || l.includes(ENV_KEY) || l.includes("bad-key-0123456789"),
    ),
  );
  page.close();
  pageB.close();
  anon.close();
} finally {
  await app.close();
  await manager.stopAll("smoke done");
  usage.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
