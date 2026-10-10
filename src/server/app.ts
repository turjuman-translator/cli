// HTTP + WebSocket server: the pages, the session and caption APIs, caption pages, archives and
// exports, presets, and the portal (/login, /admin, accounts, screens, settings).
// buildApp() only builds the Fastify instance; the caller listens and closes it.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";
import type { Logger } from "pino";
import { parseDocument } from "yaml";
import { z } from "zod";
import { KeyResolver } from "../accounts/key-resolver.js";
import { MasterKey } from "../accounts/keystore.js";
import { LOCAL_ORG_ID, OrgStore } from "../accounts/orgs.js";
import { checkProviderKey, type KeyCheck } from "../accounts/provider-check.js";
import { ScreenStore } from "../accounts/screens.js";
import { SigningSecret } from "../accounts/secret.js";
import { isAdminRole, UserStore } from "../accounts/users.js";
import { KeyStore } from "../auth/keys.js";
import { FailureRateLimiter } from "../auth/rate-limit.js";
import { lanCertCmd } from "../cli/hint.js";
import { type LoadedConfig, parseConfig } from "../config.js";
import {
  type BlockPage,
  BlocksArchive,
  EXPORT_TYPES,
  type ExportMeta,
  exportFileName,
  MAX_PAGE,
  pageBlocks,
  renderExport,
} from "../core/blocks-archive.js";
import type { CaptionSessionApi, SessionManagerApi } from "../core/contracts.js";
import { UsageStore } from "../core/usage.js";
import { type Languages, loadLanguages } from "../languages.js";
import { scrubSecrets } from "../log.js";
import { resolveIn, writeFileAtomic } from "../paths.js";
import { PresetStore } from "../presets.js";
import type { Block, Health, KeyProvider, PortalSettings } from "../shared/protocol.js";
import { BUILTIN_PRESETS } from "../shared/theme.js";
import type { ThemePreset } from "../shared/theme-vars.js";
import {
  type Access,
  accessFor,
  isPortalRoute,
  presentedCredentials,
  presentedToken,
  tokenMatches,
} from "./auth.js";
import { Hub } from "./hub.js";
import { PageSockets } from "./page-ws.js";
import { PortalAuth, registerPortal } from "./portal.js";
import { ScreenHub } from "./screen-hub.js";
import {
  applyHtmlHeaders,
  isAllowedLocalHost,
  logUrl,
  normaliseOrigin,
  safeHost,
  stripQuery,
} from "./security.js";
import { isWebsite, looksLikeSitePage, NOINDEX, registerSite } from "./site.js";

export interface BuildAppOptions {
  loaded: LoadedConfig;
  manager: SessionManagerApi;
  log: Logger;
  /** Directory with the web build: <name>.html, assets/, fonts/. */
  publicDir: string;
  version: string;
  /** GET /api/devices (501 when absent). */
  listDevices?: () => Promise<unknown>;
  /** Built-in look presets (default: BUILTIN_PRESETS from src/shared/theme.ts). */
  builtinPresets?: readonly ThemePreset[];
  /** Optional shared instances (created from `loaded.paths` when omitted). */
  keys?: KeyStore;
  usage?: UsageStore;
  languages?: Languages;
  presets?: PresetStore;
  archive?: BlocksArchive;
  /** Accounts, screens and the signing secret (created from `loaded.paths` / CAPTIONS_SECRET
   *  when omitted). */
  users?: UserStore;
  screens?: ScreenStore;
  secret?: SigningSecret;
  /** Organisations and their keys (created from `loaded` when omitted). */
  orgs?: OrgStore;
  keyResolver?: KeyResolver;
  /** Check a key with its provider (default: the provider's list-models endpoint). */
  checkKey?: (provider: KeyProvider, key: string) => Promise<KeyCheck>;
}

/** First path segments that are never language codes. */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "api",
  "ws",
  "overlay",
  "control",
  "customize",
  "health",
  "fonts",
  "assets",
  "s",
  "login",
  "admin",
  // The app, sign-up and the website preview.
  "app",
  "signup",
  "site",
  "site-assets",
]);

type PageName =
  | "picker"
  | "caption"
  | "overlay"
  | "control"
  | "customize"
  | "archive"
  | "login"
  | "admin"
  | "signup"
  | "keys";
type Query = Record<string, string | string[] | undefined>;
type ExportFormat = keyof typeof EXPORT_TYPES;

const ASSET_CACHE = "public, max-age=31536000, immutable";
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;
const MUTATING: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const StartBody = z.object({
  source: z.enum(["device", "file"]).optional(),
  file: z.string().min(1).max(1024).optional(),
  loop: z.boolean().optional(),
});
const ClearBody = z.object({
  track: z.enum(["soniox", "all"]).optional(),
  session: z.string().min(1).max(200).optional(),
});
const SaveDefaultBody = z.object({
  /** display.preset: a built-in or custom preset id. */
  preset: z.string().min(1).max(48).optional(),
});
const EventBody = z.object({ event: z.enum(["athan", "iqama", "salah", "none"]) });
const BlocksQuery = z.object({
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

/** Requests not worth a log line: health checks and static files (app, website, fonts, icon). */
function quietRequest(req: FastifyRequest): boolean {
  const path = stripQuery(req.url);
  return (
    path === "/health" ||
    path === "/favicon.ico" ||
    path.startsWith("/assets/") ||
    path.startsWith("/site-assets/") ||
    path.startsWith("/fonts/")
  );
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function clip(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, message });
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`)
    .join("; ");
}

/** Resolve a requested recording strictly inside DATA_DIR/recordings (realpath check). */
export function resolveRecording(
  recordingsDir: string,
  dataDir: string,
  file: string,
): { ok: true; path: string } | { ok: false; message: string } {
  if (file.includes("\0")) return { ok: false, message: "Invalid file name" };
  let root: string;
  try {
    root = realpathSync(recordingsDir);
  } catch {
    return { ok: false, message: "There is no recordings folder in DATA_DIR" };
  }
  const candidates = isAbsolute(file) ? [file] : [resolve(root, file), resolve(dataDir, file)];
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (real !== root && !real.startsWith(root + sep)) {
      return { ok: false, message: "Files must be inside DATA_DIR/recordings" };
    }
    if (!statSync(real).isFile()) return { ok: false, message: `Not a file: ${clip(file, 120)}` };
    return { ok: true, path: real };
  }
  return { ok: false, message: `Recording not found: ${clip(file, 120)}` };
}

function exampleConfigFile(): string {
  return fileURLToPath(new URL("../../config.example.yaml", import.meta.url));
}

/**
 * "Save as default": set display.preset (and the portal's pages.requireScreen)
 * in the config file, keeping comments (yaml Document API), validated, written atomically. A
 * missing config.yaml is created from config.example.yaml.
 */
export function saveDefaults(
  loaded: LoadedConfig,
  changes: { preset?: string; requireScreen?: boolean },
): { ok: boolean; message: string } {
  const file = loaded.paths.configFile ?? join(loaded.paths.configDir, "config.yaml");
  let text = "";
  let mode = 0o600;
  if (existsSync(file)) {
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } else if (existsSync(exampleConfigFile())) {
    text = readFileSync(exampleConfigFile(), "utf8");
  }
  const doc = parseDocument(text);
  const first = doc.errors[0];
  if (first !== undefined) return { ok: false, message: `Cannot edit ${file}: ${first.message}` };
  if (changes.preset !== undefined) doc.setIn(["display", "preset"], changes.preset);
  if (changes.requireScreen !== undefined) {
    doc.setIn(["pages", "requireScreen"], changes.requireScreen);
  }
  const check = parseConfig(doc.toJS(), loaded.context);
  if (!check.ok) {
    return { ok: false, message: `The saved config would be invalid: ${check.errors.join("; ")}` };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, doc.toString(), mode);
  return { ok: true, message: `Saved as default in ${file}` };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { loaded, manager, publicDir } = opts;
  const { config, paths } = loaded;
  const startedAt = Date.now();
  // Accounts, screens and the signing secret (login cookies).
  const secret = opts.secret ?? new SigningSecret(paths.secretFile);
  const users = opts.users ?? new UserStore(paths.usersFile);
  const screens = opts.screens ?? new ScreenStore(paths.screensFile);
  const hosted = config.mode === "hosted";
  const orgs = opts.orgs ?? new OrgStore(paths.orgsFile);
  const keyResolver =
    opts.keyResolver ??
    new KeyResolver({
      mode: config.mode,
      env: loaded.secrets,
      orgs,
      master: new MasterKey(paths.masterKeyFile),
      log: opts.log,
    });
  const secrets = [config.server.token, loaded.secrets.sonioxApiKey ?? "", secret.envSecret];
  if (secret.weak) {
    opts.log.warn("CAPTIONS_SECRET is short; use at least 16 random characters");
  }

  const languages = opts.languages ?? loadLanguages(paths.languagesFile);
  const keys = opts.keys ?? new KeyStore(paths.keysFile);
  const ownsUsage = opts.usage === undefined;
  const usage =
    opts.usage ??
    new UsageStore({
      dir: paths.usageDir,
      onError: (err) => opts.log.error({ err }, "usage: flush failed"),
    });
  const keyLimiter = new FailureRateLimiter();
  // Archive/history/export failures must never lock caption pages (/ws/page uses keyLimiter).
  const viewerLimiter = new FailureRateLimiter();
  const adminLimiter = new FailureRateLimiter();
  // Portal login, first-admin setup and password changes.
  const loginLimiter = new FailureRateLimiter();
  // At most 5 sign-ups per address per hour.
  const signupLimiter = new FailureRateLimiter({
    maxFailures: 5,
    windowMs: 60 * 60_000,
    blockMs: 60 * 60_000,
  });
  /** Portal settings applied live (PATCH /api/settings also writes config.yaml). */
  const settings: PortalSettings = { requireScreen: config.pages.requireScreen };
  const portalAuth = new PortalAuth({ loaded, users, secret, log: opts.log, orgs });
  const screenHub = new ScreenHub();
  const builtinPresets = opts.builtinPresets ?? BUILTIN_PRESETS;
  const presets =
    opts.presets ?? new PresetStore(paths.presetsFile, new Set(builtinPresets.map((p) => p.id)));
  const archive = opts.archive ?? new BlocksArchive(paths.transcriptsDir);
  /** display.preset; "Save as default" updates it at runtime too. */
  let defaultPreset = config.display.preset;
  let loggedPresetProblems = "";

  /** The organisation of a live or archived session ("local" for sessions from before organisations existed). */
  const sessionOrg = (id: string): string | null => {
    const live = manager.orgOf?.(id);
    if (live !== undefined && live !== null) return live;
    if (manager.get(id) !== undefined) return LOCAL_ORG_ID;
    const archived = archive.get(id);
    return archived === null ? null : (archived.orgId ?? LOCAL_ORG_ID);
  };

  /**
   * Archive/blocks/export access: the admin token, any valid access key, or any login; in hosted
   * mode only a login of the session's own organisation.
   */
  const viewerAllowed = (req: FastifyRequest): boolean => {
    // Hosted: the operator's token, never a server access key (pages there don't use them).
    const credential = presentedCredentials(req).some(
      (c) => tokenMatches(c, config.server.token) || (!hosted && keys.verify(c) !== null),
    );
    if (credential) return true;
    const user = portalAuth.user(req);
    if (user === null) return false;
    if (!hosted) return true;
    const params = req.params as { id?: unknown } | undefined;
    const id = typeof params?.id === "string" ? params.id : null;
    return id !== null && sessionOrg(id) === user.orgId;
  };

  /** CSRF: a browser's Origin, when sent, must be this server's own origin. */
  const sameOrigin = (req: FastifyRequest): boolean => {
    const header = req.headers.origin;
    if (header === undefined || header === "") return true;
    const origin = normaliseOrigin(header);
    const host = safeHost(req.host);
    if (origin === null || host === null) return false;
    return origin === normaliseOrigin(`${req.protocol}://${host}`);
  };

  const httpLog = opts.log.child(
    {},
    {
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string }) => ({
          method: req.method,
          url: logUrl(req.url),
          remoteAddress: req.ip,
        }),
      },
    },
  );

  const app = Fastify({
    loggerInstance: httpLog as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: quietRequest }),
    trustProxy: config.server.trustProxy ? ["loopback", "linklocal", "uniquelocal"] : false,
    bodyLimit: 64 * 1024,
  });

  // JSON bodies; an empty body counts as {} so bodiless POSTs (stop, clear) work.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("Invalid JSON body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setNotFoundHandler(async (req, reply) => {
    // A page address the website could have: its 404 page (site.ts); everything else as before.
    if (await app.siteNotFound(req, reply)) return reply;
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found\n");
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode !== undefined && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err, url: logUrl(req.url) }, "request failed");
      reply.code(status).send({ ok: false, message: "Internal server error" });
      return;
    }
    reply.code(status).send({ ok: false, message: scrubSecrets(err.message, secrets) });
  });

  // Registered before the guard hook on purpose: its own onRequest hook must run first to mark
  // upgrade requests (req.ws), so that its onResponse hook destroys the socket of an upgrade
  // the guards below refuse (otherwise the raw socket would be left open).
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  /** JSON for API routes, a short text for pages. */
  function deny(
    reply: FastifyReply,
    route: string | undefined,
    status: number,
    message: string,
  ): FastifyReply {
    if (route?.startsWith("/api/") === true) return reply.code(status).send({ ok: false, message });
    return reply.code(status).type("text/plain; charset=utf-8").send(`${message}\n`);
  }

  // Guards, in order: WebSocket upgrades only on /ws and /ws/page, DNS-rebinding Host check
  // (local), same-origin mutating API requests (CSRF), credentials (lan|public: admin token or
  // admin login; access key or any login for viewer routes), JSON bodies (every POST; PATCH/
  // PUT/DELETE of the portal API). The portal API checks its credentials itself (portal.ts).
  // Every error says noindex as well, also a website file that does not exist (docs/seo.md).
  app.addHook("onSend", async (_req, reply, payload) => {
    if (reply.statusCode >= 400) reply.header("X-Robots-Tag", NOINDEX);
    return payload;
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    // Search engines index the public website only (docs/seo.md): the app, caption pages, feeds,
    // the API, every error and a self-hosted server's every answer say noindex.
    if (!isWebsite(config.mode, req)) reply.header("X-Robots-Tag", NOINDEX);
    const route = req.routeOptions.url;
    if (req.ws && route !== "/ws" && route !== "/ws/page") {
      // (the websocket plugin would accept, log the full URL incl. query, then close)
      return reply.code(404).type("text/plain; charset=utf-8").send("Not found\n");
    }
    if (
      config.server.exposure === "local" &&
      route !== "/health" &&
      !isAllowedLocalHost(req.host, config.server.host)
    ) {
      return reply.code(403).type("text/plain; charset=utf-8").send("Host not allowed\n");
    }
    const api = route?.startsWith("/api/") === true;
    if (api && MUTATING.has(req.method) && !sameOrigin(req)) {
      req.log.warn({ ip: req.ip, route }, "cross-origin API request refused");
      return reply.code(403).send({ ok: false, message: "Cross-origin requests are not allowed" });
    }
    const access: Access = accessFor(req.method, route, config);
    if (access !== "open") {
      const limiter = access === "admin" ? adminLimiter : viewerLimiter;
      const blockedMs = limiter.blockedFor(req.ip);
      if (blockedMs > 0) {
        reply.header("Retry-After", String(Math.ceil(blockedMs / 1000)));
        return deny(reply, route, 429, "Too many failed attempts; try again later");
      }
      // Hosted mode: "admin" is the server operator (admin token), never an organisation's login.
      const allowed =
        access === "admin"
          ? tokenMatches(presentedToken(req), config.server.token) ||
            (!hosted && portalAuth.isAdmin(req))
          : viewerAllowed(req);
      if (!allowed && access === "admin" && portalAuth.user(req) !== null) {
        return deny(
          reply,
          route,
          403,
          hosted
            ? "Only the server's operator can open this"
            : "Only an admin account can open this",
        );
      }
      if (!allowed) {
        // Only a wrong credential counts as a failed attempt; a request without any (an old
        // link, a page that has no key yet) is just refused.
        const presented =
          access === "admin" ? presentedToken(req) !== null : presentedCredentials(req).length > 0;
        if (presented) limiter.recordFailure(req.ip);
        req.log.warn({ ip: req.ip, route, access }, "credentials missing or wrong");
        if (access === "viewer" || config.server.token !== "") {
          reply.header("WWW-Authenticate", 'Bearer realm="captions"');
        }
        return deny(
          reply,
          route,
          401,
          access === "admin"
            ? "Admin login required: log in at /login as an admin" +
                (config.server.token === ""
                  ? ""
                  : ", or use the admin token (Authorization: Bearer <token> or ?token=)")
            : "Access key required: add ?key=… to the URL or log in at /login" +
                (config.server.token === "" ? "" : ", or use the admin token"),
        );
      }
      limiter.recordSuccess(req.ip);
    }
    if (
      api &&
      (req.method === "POST" || (MUTATING.has(req.method) && isPortalRoute(route ?? "")))
    ) {
      const type = req.headers["content-type"];
      if (typeof type !== "string" || !JSON_TYPE.test(type.trim())) {
        return reply
          .code(415)
          .send({ ok: false, message: "Content-Type must be application/json" });
      }
    }
    return undefined;
  });

  // Hashed bundles and fonts: cached forever (names change with content).
  for (const dir of ["assets", "fonts"] as const) {
    await app.register(fastifyStatic, {
      root: join(publicDir, dir),
      prefix: `/${dir}/`,
      decorateReply: false,
      index: false,
      list: false,
      dotfiles: "deny",
      cacheControl: false,
      suppressWarning: true,
      setHeaders: (reply) => {
        reply.header("Cache-Control", ASSET_CACHE);
      },
    });
  }

  async function sendPage(
    req: FastifyRequest,
    reply: FastifyReply,
    name: PageName,
  ): Promise<FastifyReply> {
    applyHtmlHeaders(req, reply);
    let html: Buffer;
    try {
      html = await readFile(join(publicDir, `${name}.html`));
    } catch {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send(`${name}.html has not been built yet (run: pnpm build:web)\n`);
    }
    return reply.type("text/html; charset=utf-8").send(html);
  }

  /** The builder shows the error: at / in local mode, at /app/new in hosted mode (/ is the website). */
  function redirectWithError(reply: FastifyReply, message: string): FastifyReply {
    reply.header("Cache-Control", "no-store");
    return reply.redirect(`${hosted ? "/app/new" : "/"}?error=${encodeURIComponent(message)}`, 302);
  }

  // --- pages -------------------------------------------------------------------------------

  /** Live session first, else its archived blocks.jsonl; null when neither exists. */
  function sessionBlocks(id: string): {
    live: boolean;
    meta: ExportMeta & { endedAt: number | null };
    page: (o: { before?: number | undefined; limit?: number | undefined }) => BlockPage;
    all: () => Block[];
  } | null {
    const session = manager.get(id);
    if (session !== undefined) {
      const info = session.info();
      return {
        live: true,
        meta: {
          sessionId: id,
          from: info.from,
          to: info.to,
          startedAt: info.startedAt,
          endedAt: null,
        },
        page: (o) =>
          session.blocks({
            ...(o.before === undefined ? {} : { before: o.before }),
            limit: Math.min(MAX_PAGE, o.limit ?? 100),
          }),
        all: () => allLiveBlocks(session),
      };
    }
    const archived = archive.get(id);
    if (archived === null) return null;
    return {
      live: false,
      meta: {
        sessionId: id,
        from: archived.from,
        to: archived.to,
        startedAt: archived.startedAt,
        endedAt: archived.endedAt,
      },
      page: (o) => pageBlocks(archived.blocks, o),
      all: () => archived.blocks,
    };
  }

  /** Every block of a live session, paging back through blocks() (oldest first). */
  function allLiveBlocks(session: CaptionSessionApi): Block[] {
    const pages: Block[][] = [];
    let before: number | undefined;
    for (let i = 0; i < 10_000; i++) {
      const page = session.blocks({ ...(before === undefined ? {} : { before }), limit: MAX_PAGE });
      pages.push(page.blocks);
      const first = page.blocks[0];
      if (!page.hasMore || first === undefined || (before !== undefined && first.seq >= before)) {
        break;
      }
      before = first.seq;
    }
    return pages.reverse().flat();
  }

  // Hosted mode serves the website at /, /nl and /ar; local mode keeps the
  // builder at / and previews the website at /site. The app lives under /app in both modes.
  if (!hosted) app.get("/", (req, reply) => sendPage(req, reply, "picker"));
  await registerSite(app, {
    mode: config.mode,
    publicDir,
    applyHtmlHeaders,
    publicUrl: config.hosted.publicUrl,
    privacyUrl: config.hosted.privacyUrl,
    contactUrl: config.hosted.contactUrl,
  });
  const appPages: Array<[string, PageName]> = [
    ["/app", "admin"],
    ["/app/new", "picker"],
    ["/app/look", "customize"],
    ["/app/keys", "keys"],
  ];
  if (hosted) appPages.push(["/signup", "signup"]);
  for (const [route, page] of appPages) {
    app.get(route, (req, reply) => {
      reply.header("X-Frame-Options", "DENY");
      return sendPage(req, reply, page);
    });
  }
  app.get("/overlay", (req, reply) => sendPage(req, reply, "overlay"));
  app.get("/control", (req, reply) => sendPage(req, reply, "control"));
  app.get("/customize", (req, reply) => sendPage(req, reply, "customize"));
  // Portal pages: served to anyone; /admin asks /api/auth/me and sends you to /login.
  // Never framed (the switches must not be clickjacked).
  for (const name of ["login", "admin"] as const) {
    app.get(`/${name}`, (req, reply) => {
      reply.header("X-Frame-Options", "DENY");
      return sendPage(req, reply, name);
    });
  }

  // Archive page of a live or ended session; viewer credentials for lan|public.
  app.get<{ Params: { sessionId: string } }>("/s/:sessionId", async (req, reply) => {
    if (sessionBlocks(req.params.sessionId) === null) {
      applyHtmlHeaders(req, reply);
      return reply.code(404).type("text/plain; charset=utf-8").send("No such session\n");
    }
    return sendPage(req, reply, "archive");
  });

  app.get<{ Params: { from: string; to: string }; Querystring: Query }>(
    "/:from/:to",
    async (req, reply) => {
      const { from, to } = req.params;
      if (RESERVED_SEGMENTS.has(from)) {
        return reply.code(404).type("text/plain; charset=utf-8").send("Not found\n");
      }
      if (!config.pages.enabled) {
        return reply
          .code(404)
          .type("text/plain; charset=utf-8")
          .send("Caption pages are disabled on this server (pages.enabled: false)\n");
      }
      // An older link may carry engine= or translation= (the removed engine choice): ignored.
      const error = languages.validatePair(clip(from), clip(to));
      if (error !== null) {
        // A mistyped website page (/nl/<page>, /ar/<page>) gets the website's 404, not the app.
        if (hosted && looksLikeSitePage(from, to) && languages.get(to) === undefined) {
          await app.siteNotFound(req, reply, from);
          return reply;
        }
        return redirectWithError(reply, error);
      }
      return sendPage(req, reply, "caption");
    },
  );

  // --- health + public API -----------------------------------------------------------------

  // The local CA certificate (public, no secret), installed once on each device that
  // opens the HTTPS port, so its microphone may be used without a certificate warning.
  app.get("/ca.crt", async (_req, reply) => {
    let body: Buffer;
    try {
      body = readFileSync(paths.tlsCaFile);
    } catch {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send(
          `No local certificate authority yet: on the server run ${lanCertCmd(paths.tlsCertFile, loaded.context.inContainer)}`,
        );
    }
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="turjuman-local-ca.crt"')
      .type("application/x-x509-ca-cert")
      .send(body);
  });

  // Browsers ask for /favicon.ico where a page names no icon (the caption page in OBS, files):
  // the app icon (a PNG; browsers read it at this address too).
  const favicon = ((): Buffer | null => {
    try {
      const dir = join(publicDir, "assets");
      const name = readdirSync(dir).find((f) => /^icon-192-[\w-]+\.png$/.test(f));
      return name === undefined ? null : readFileSync(join(dir, name));
    } catch {
      return null;
    }
  })();
  app.get("/favicon.ico", async (_req, reply) => {
    if (favicon === null)
      return reply.code(404).type("text/plain; charset=utf-8").send("Not found\n");
    return reply.header("Cache-Control", "public, max-age=86400").type("image/png").send(favicon);
  });

  app.get("/health", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const health = manager.health();
      // Hosted mode: the session list names other mosques' screens; it is the operator's. A
      // token tried here counts like on the API, so /health is no way to guess it.
      if (hosted) {
        const presented = presentedToken(req);
        let operator = false;
        if (presented !== null && adminLimiter.blockedFor(req.ip) === 0) {
          operator = tokenMatches(presented, config.server.token);
          if (operator) adminLimiter.recordSuccess(req.ip);
          else adminLimiter.recordFailure(req.ip);
        }
        if (!operator) return { ...health, local: null, sessions: [] };
      }
      return health;
    } catch (err) {
      opts.log.error({ err }, "health: manager.health() failed");
      const fallback: Health = {
        ok: true,
        version: opts.version,
        uptimeMs: Date.now() - startedAt,
        exposure: config.server.exposure,
        local: null,
        sessions: [],
      };
      return fallback;
    }
  });

  // Older pages ask with ?engine=…&translation=…: those parameters are ignored (Soniox only).
  app.get("/api/languages", async () => {
    const { sources, targets } = languages.engineLanguages();
    return {
      auto: true,
      sources,
      targets,
      defaults: {
        from: config.pages.defaultFrom,
        to: config.pages.defaultTo,
        show: config.pages.defaultShow,
      },
      // Hosted pages use screen links or a login, never access keys.
      keyRequired: !hosted && config.server.exposure !== "local",
    };
  });

  // --- admin API (token for lan|public; JSON POSTs only) -----------------------------------

  app.get("/api/sessions", async () => manager.list());

  app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (req, reply) => {
    const session = manager.get(req.params.id);
    if (session === undefined) {
      return reply.code(404).send({ ok: false, message: `No session ${clip(req.params.id, 80)}` });
    }
    await session.stop("stopped from the API");
    return { ok: true, message: `Stopped session ${session.id}` };
  });

  // Block history: newest `limit` (≤200, default 100) blocks with seq < `before`.
  app.get<{ Params: { id: string }; Querystring: Query }>(
    "/api/sessions/:id/blocks",
    async (req, reply) => {
      const query = BlocksQuery.safeParse({
        before: single(req.query.before),
        limit: single(req.query.limit),
      });
      if (!query.success) return badRequest(reply, zodMessage(query.error));
      const source = sessionBlocks(req.params.id);
      if (source === null) {
        return reply.code(404).send({ ok: false, message: `No session ${clip(req.params.id)}` });
      }
      const page = source.page({ before: query.data.before, limit: query.data.limit });
      reply.header("Cache-Control", "no-store");
      return {
        sessionId: req.params.id,
        live: source.live,
        from: source.meta.from,
        to: source.meta.to,
        startedAt: source.meta.startedAt,
        endedAt: source.meta.endedAt,
        blocks: page.blocks,
        hasMore: page.hasMore,
      };
    },
  );

  // Exports: txt / md / srt downloads of the whole session.
  for (const format of Object.keys(EXPORT_TYPES) as ExportFormat[]) {
    app.get<{ Params: { id: string } }>(
      `/api/sessions/:id/export.${format}`,
      async (req, reply) => {
        const source = sessionBlocks(req.params.id);
        if (source === null) {
          return reply.code(404).send({ ok: false, message: `No session ${clip(req.params.id)}` });
        }
        const body = renderExport(format, source.all(), source.meta);
        return reply
          .type(EXPORT_TYPES[format])
          .header("Cache-Control", "no-store")
          .header(
            "Content-Disposition",
            `attachment; filename="${exportFileName(source.meta, format)}"`,
          )
          .send(body);
      },
    );
  }

  // Manual prayer-event override: ":id" may be "all" (every live session).
  app.post<{ Params: { id: string } }>("/api/sessions/:id/event", async (req, reply) => {
    const body = EventBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, zodMessage(body.error));
    const { event } = body.data;
    let targets: CaptionSessionApi[];
    if (req.params.id === "all") {
      const byId = new Map<string, CaptionSessionApi>();
      for (const s of manager.list()) {
        const session = manager.get(s.id);
        if (session !== undefined) byId.set(session.id, session);
      }
      const local = manager.local();
      if (local !== null) byId.set(local.id, local);
      targets = [...byId.values()];
      if (targets.length === 0) {
        return reply.code(409).send({ ok: false, message: "No live sessions" });
      }
    } else {
      const session = manager.get(req.params.id);
      if (session === undefined) {
        return reply.code(404).send({ ok: false, message: `No session ${clip(req.params.id)}` });
      }
      targets = [session];
    }
    for (const session of targets) session.overrideEvent(event);
    const sessions = targets.map((s) => s.id);
    opts.log.info({ event, sessions }, "event override");
    return {
      ok: true,
      message: `${event === "none" ? "Normal" : event} → ${sessions.length} session(s)`,
      sessions,
    };
  });

  // --- look presets (built-in + CONFIG_DIR/presets.yaml) -----------------------------------

  /**
   * Whose custom presets a reader sees: local mode has one organisation; hosted
   * mode the screen's (?screen=<guid>, caption pages), else the logged-in account's, else none.
   */
  const presetReader = (req: FastifyRequest<{ Querystring: Query }>): string | null => {
    if (!hosted) return LOCAL_ORG_ID;
    const guid = single(req.query.screen);
    if (guid !== undefined && guid !== "") {
      const screen = screens.byGuid(guid.trim().toLowerCase());
      if (screen !== null) return screen.orgId;
    }
    return portalAuth.user(req)?.orgId ?? null;
  };

  /**
   * Whose presets a write changes: in local mode the local one (the hook checked the admin token
   * or login); in hosted mode the organisation of the logged-in owner/admin (else 401/403 sent).
   */
  const presetWriter = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!hosted) return LOCAL_ORG_ID;
    const user = portalAuth.user(req);
    if (user === null) {
      reply.code(401).send({ ok: false, message: "Log in first" });
      return null;
    }
    if (!isAdminRole(user.role)) {
      reply.code(403).send({ ok: false, message: "Only an admin can change presets" });
      return null;
    }
    return user.orgId;
  };

  app.get<{ Querystring: Query }>("/api/presets", async (req, reply) => {
    const orgId = presetReader(req);
    const custom = orgId === null ? [] : presets.list(orgId);
    const problems = presets.problems.join("\n");
    if (problems !== loggedPresetProblems) {
      loggedPresetProblems = problems;
      if (problems !== "") opts.log.warn({ problems: presets.problems }, "presets.yaml problems");
    }
    reply.header("Cache-Control", "no-store");
    return { builtin: builtinPresets, custom, default: defaultPreset };
  });

  app.post("/api/presets", async (req, reply) => {
    const orgId = presetWriter(req, reply);
    if (orgId === null) return reply;
    const body: unknown = req.body;
    const input =
      typeof body === "object" && body !== null && "preset" in body
        ? (body as { preset: unknown }).preset
        : body;
    const result = presets.upsert(input, orgId);
    if (!result.ok) {
      return reply
        .code(result.status)
        .send({ ok: false, message: result.errors.join("; "), errors: result.errors });
    }
    opts.log.info({ id: result.preset.id, created: result.created, org: orgId }, "preset saved");
    return reply.code(result.created ? 201 : 200).send({
      ok: true,
      message: `${result.created ? "Created" : "Updated"} preset ${result.preset.id}`,
      preset: result.preset,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/presets/:id", async (req, reply) => {
    const orgId = presetWriter(req, reply);
    if (orgId === null) return reply;
    const result = presets.remove(req.params.id, orgId);
    if (!result.ok) {
      return reply
        .code(result.status)
        .send({ ok: false, message: result.errors.join("; "), errors: result.errors });
    }
    opts.log.info({ id: req.params.id, org: orgId }, "preset deleted");
    return { ok: true, message: `Deleted preset ${req.params.id}` };
  });

  app.post("/api/session/start", async (req, reply) => {
    const body = StartBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, zodMessage(body.error));
    const { file, loop } = body.data;
    const source =
      body.data.source ??
      (file !== undefined || config.audio.input.kind === "file" ? "file" : "device");
    let path: string | undefined;
    if (source === "file") {
      if (file !== undefined) {
        const resolved = resolveRecording(paths.recordingsDir, paths.dataDir, file);
        if (!resolved.ok) return badRequest(reply, resolved.message);
        path = resolved.path;
      } else if (config.audio.input.path !== undefined) {
        path = resolveIn(paths.dataDir, config.audio.input.path);
      } else {
        return badRequest(reply, "No file given (body.file or audio.input.path)");
      }
    } else if (file !== undefined) {
      return badRequest(reply, 'A file needs source "file"');
    }
    const result = await manager.startLocal({
      source,
      ...(path === undefined ? {} : { file: path, loop: loop ?? config.audio.input.loop }),
    });
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  app.post("/api/session/stop", async (_req, reply) => {
    const result = await manager.stopLocal("stopped from the API");
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  app.post("/api/captions/clear", async (req, reply) => {
    const body = ClearBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, zodMessage(body.error));
    const session =
      body.data.session === undefined ? manager.local() : manager.get(body.data.session);
    if (session === null || session === undefined) {
      return reply.code(409).send({ ok: false, message: "No session to clear" });
    }
    session.clear(body.data.track ?? "all");
    return { ok: true, message: "Cleared" };
  });

  app.post("/api/config/save-default", async (req, reply) => {
    const body = SaveDefaultBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, zodMessage(body.error));
    const { preset } = body.data;
    if (preset === undefined) return badRequest(reply, "Nothing to save (preset)");
    if (
      preset !== undefined &&
      !builtinPresets.some((p) => p.id === preset) &&
      presets.get(preset) === undefined
    ) {
      return badRequest(reply, `Unknown preset "${clip(preset)}"`);
    }
    const result = saveDefaults(loaded, { preset });
    if (result.ok) {
      defaultPreset = preset;
      opts.log.info(body.data, "config: saved as default");
    }
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.get("/api/devices", async (_req, reply) => {
    if (opts.listDevices === undefined) {
      return reply.code(501).send({ ok: false, message: "Device listing is not available" });
    }
    try {
      return await opts.listDevices();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, message: scrubSecrets(message, secrets) });
    }
  });

  // --- WebSockets ----------------------------------------------------------------------------

  const hub = new Hub({ manager, config, log: opts.log.child({ component: "hub" }) });
  const pages = new PageSockets({
    loaded,
    manager,
    keys,
    usage,
    languages,
    limiter: keyLimiter,
    screens,
    secret,
    hub: screenHub,
    requireScreen: () => settings.requireScreen,
    log: opts.log.child({ component: "page-ws" }),
    userOf: (req) => portalAuth.user(req),
    users,
    orgs,
  });

  registerPortal(app, {
    loaded,
    users,
    screens,
    secret,
    auth: portalAuth,
    pages,
    languages,
    settings,
    saveSettings: (changes) => saveDefaults(loaded, changes),
    loginLimiter,
    adminLimiter,
    log: opts.log.child({ component: "portal" }),
    orgs,
    keys: keyResolver,
    usage,
    presets,
    signupLimiter,
    checkKey: opts.checkKey ?? ((provider, key) => checkProviderKey(provider, key)),
  });

  app.get<{ Querystring: Query }>("/ws", { websocket: true }, (socket, req) => {
    const session = single(req.query.session);
    hub.handle(socket, session === undefined || session === "" ? null : session);
  });

  app.get("/ws/page", { websocket: true }, (socket, req) => {
    pages.handle(socket, req);
  });

  app.addHook("onClose", async () => {
    hub.close();
    pages.close();
    if (ownsUsage) usage.close();
    else usage.flush();
  });

  return app;
}
