// Admin portal API: login (cookie), first-admin setup, accounts, screens
// and settings. These routes authenticate themselves in every exposure mode: the login cookie,
// or the admin token (Bearer / ?token=) which counts as an admin. CSRF (JSON + same Origin) is
// checked by the app's onRequest hook. Every change is logged at info with {user, screen};
// passwords, cookies, the secret and link signatures never are.
// Everything is scoped to the caller's organisation (the admin token acts
// for the local one); owners and admins manage it; hosted mode logs in by e-mail and has sign-up
// instead of the first-admin setup (org-api.ts: sign-up, the organisation and its keys).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import {
  loginCookie,
  logoutCookie,
  readCookie,
  SESSION_COOKIE,
  signSession,
  verifySession,
} from "../accounts/cookies.js";
import type { KeyResolver } from "../accounts/key-resolver.js";
import { LOCAL_ORG_ID, type OrgStore } from "../accounts/orgs.js";
import {
  dummyVerify,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from "../accounts/passwords.js";
import type { KeyCheck } from "../accounts/provider-check.js";
import {
  type Actor,
  MAX_QUERY,
  type ScreenRecord,
  type ScreenStore,
  sanitizeQuery,
  screenTarget,
  screenUrl,
} from "../accounts/screens.js";
import type { SigningSecret } from "../accounts/secret.js";
import {
  AccountError,
  isAdminRole,
  normalizeEmail,
  normalizeUsername,
  toMe,
  toUserView,
  type UserRecord,
  type UserStore,
} from "../accounts/users.js";
import { type AttemptOutcome, FailureRateLimiter } from "../auth/rate-limit.js";
import { turjumanCmd } from "../cli/hint.js";
import { isLoopbackHost, type LoadedConfig } from "../config.js";
import type { UsageStore } from "../core/usage.js";
import type { Languages } from "../languages.js";
import type { PresetStore } from "../presets.js";
import type {
  AuthStateView,
  KeyProvider,
  PortalSettings,
  PrayerEvent,
  ScreenAction,
  ScreenView,
} from "../shared/protocol.js";
import { presentedToken, tokenMatches } from "./auth.js";
import { registerOrgApi } from "./org-api.js";
import type { ScreenLive } from "./screen-hub.js";
import { safeHost } from "./security.js";

/** What the portal needs from /ws/page (PageSockets). */
export interface ScreenControl {
  screenLive(screenId: string): ScreenLive;
  enableScreen(screenId: string, name: string): number;
  disableScreen(screenId: string, name: string): Promise<number>;
  resetScreen(screenId: string): number;
  invalidateScreen(screenId: string): Promise<number>;
  /** A prayer event (or "none") on every running session; the count. */
  eventScreen(screenId: string, event: PrayerEvent | "none"): number;
  /** The look changed: pages reload /feed/<guid>; the count told. */
  reloadScreen(screenId: string): number;
  /** Launch: stop every page session of an organisation (it was deleted); the count. */
  stopOrg(orgId: string): Promise<number>;
}

/** Who is asking: a logged-in account, or the admin token (acts as an admin). */
export type Requester = { kind: "user"; user: UserRecord } | { kind: "token" };

const USERNAME_IN = z.string().max(200);
const PASSWORD_IN = z.string().max(1024);
/** `username` may hold an e-mail address too (hosted mode logs in by e-mail). */
const LoginBody = z
  .object({
    username: USERNAME_IN.optional(),
    email: USERNAME_IN.optional(),
    password: PASSWORD_IN,
  })
  .refine((b) => (b.username ?? b.email ?? "").trim() !== "", {
    message: "Enter your e-mail address or username",
  });
const SetupBody = z.object({
  username: USERNAME_IN,
  password: PASSWORD_IN,
  displayName: z.string().max(200).optional(),
});
const PasswordBody = z.object({ current: PASSWORD_IN, next: PASSWORD_IN });
const NewUserBody = z.object({
  /** Local mode: required. Hosted mode: made from the e-mail address when absent. */
  username: USERNAME_IN.optional(),
  /** Hosted mode: required (the login). */
  email: z.string().max(254).optional(),
  password: PASSWORD_IN,
  displayName: z.string().max(200).optional(),
  role: z.enum(["admin", "user"]).default("user"),
});
const PatchUserBody = z.object({
  displayName: z.string().max(200).optional(),
  role: z.enum(["admin", "user"]).optional(),
  disabled: z.boolean().optional(),
  password: PASSWORD_IN.optional(),
});
const NewScreenBody = z.object({
  name: z.string().max(200),
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
  query: z.string().max(8000).default(""),
});
const PatchScreenBody = z.object({
  name: z.string().max(200).optional(),
  query: z.string().max(8000).optional(),
});
const OwnerControlBody = z.object({ allowed: z.boolean() });
const ScreenEventBody = z.object({ event: z.enum(["athan", "iqama", "salah", "none"]) });
const SettingsBody = z.object({ requireScreen: z.boolean() });

const WRONG_LOGIN = "Wrong username or password";
const WRONG_EMAIL_LOGIN = "Wrong e-mail address or password";
/** Hosted accounts need at least 10 characters. */
export const HOSTED_MIN_PASSWORD = 10;
/** Hosted mode: what one organisation may have (one tenant must not slow the whole server). */
export const MAX_SCREENS_PER_ORG = 50;
export const MAX_ACCOUNTS_PER_ORG = 100;
/** Caption-page options a feed link passes on: for setting a screen up, not part of its look. */
const FEED_KEPT_PARAMS = ["debug", "ui"] as const;
const EMAIL = z.string().trim().toLowerCase().email().max(254);

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`)
    .join("; ");
}

/** Milliseconds of an ISO time; 0 when it cannot be read. */
function iso(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/** Host part of a Host header ("[::1]:8765" → "[::1]", "localhost:8765" → "localhost"). */
function hostOnly(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

function isLoopbackAddress(address: string | undefined): boolean {
  // No address (a socket that is gone already) is not a loopback one.
  return isLoopbackHost((address ?? "").replace(/^::ffff:/i, ""));
}

// --- login cookie --------------------------------------------------------------------------------

/** Login cookies: issue, clear, and resolve a request's account (memoized per request). */
export class PortalAuth {
  private readonly cache = new WeakMap<FastifyRequest, UserRecord | null>();

  constructor(
    private readonly opts: {
      loaded: LoadedConfig;
      users: UserStore;
      secret: SigningSecret;
      log: Logger;
      now?: () => number;
      /** Hosted mode: accounts of a disabled (or deleted) organisation are logged out. */
      orgs?: OrgStore;
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The enabled account of a valid login cookie (current sessionVersion), or null. */
  user(req: FastifyRequest): UserRecord | null {
    if (this.cache.has(req)) return this.cache.get(req) ?? null;
    const user = this.lookup(req);
    this.cache.set(req, user);
    return user;
  }

  /** An owner or admin account. */
  isAdmin(req: FastifyRequest): boolean {
    const user = this.user(req);
    return user !== null && isAdminRole(user.role);
  }

  /** Set the login cookie (HttpOnly; SameSite=Lax; Path=/; Max-Age; Secure on HTTPS). */
  login(req: FastifyRequest, reply: FastifyReply, user: UserRecord): void {
    const maxAge = this.opts.loaded.config.accounts.sessionDays * 86_400;
    const exp = Math.floor(this.now() / 1000) + maxAge;
    const value = signSession(this.opts.secret, { u: user.id, v: user.sessionVersion, exp });
    reply.header("Set-Cookie", loginCookie(value, maxAge, this.secure(req)));
    this.cache.set(req, user);
  }

  logout(req: FastifyRequest, reply: FastifyReply): void {
    reply.header("Set-Cookie", logoutCookie(this.secure(req)));
    this.cache.set(req, null);
  }

  private lookup(req: FastifyRequest): UserRecord | null {
    const values = readCookie(req.headers.cookie, SESSION_COOKIE);
    // No accounts: nothing can be valid (and the secret is not created for nothing).
    if (values.length === 0 || this.opts.users.count() === 0) return null;
    const nowSec = Math.floor(this.now() / 1000);
    for (const value of values) {
      let claims: ReturnType<typeof verifySession>;
      try {
        claims = verifySession(this.opts.secret, value, nowSec);
      } catch (err) {
        this.opts.log.error({ err }, "login cookie check failed");
        return null;
      }
      if (claims === null) continue;
      const user = this.opts.users.get(claims.u);
      if (user !== undefined && !user.disabled && user.sessionVersion === claims.v) {
        return this.orgActive(user) ? user : null;
      }
    }
    return null;
  }

  /** Secure cookies on HTTPS, and always on a hosted server whose public address is https. */
  private secure(req: FastifyRequest): boolean {
    const { config } = this.opts.loaded;
    if (req.protocol === "https") return true;
    return config.mode === "hosted" && (config.hosted.publicUrl?.startsWith("https://") ?? false);
  }

  /** Hosted mode: the account's organisation exists and is not disabled. */
  orgActive(user: UserRecord): boolean {
    const orgs = this.opts.orgs;
    if (orgs === undefined || this.opts.loaded.config.mode !== "hosted") return true;
    const org = orgs.get(user.orgId);
    return org !== undefined && !org.disabled;
  }
}

// --- routes ----------------------------------------------------------------------------------------

export interface PortalDeps {
  loaded: LoadedConfig;
  users: UserStore;
  screens: ScreenStore;
  secret: SigningSecret;
  auth: PortalAuth;
  pages: ScreenControl;
  languages: Languages;
  /** Live server settings (requireScreen); PATCH /api/settings updates it. */
  settings: PortalSettings;
  /** Write pages.requireScreen into config.yaml (keeping comments). */
  saveSettings: (changes: { requireScreen: boolean }) => { ok: boolean; message: string };
  /** Per-IP failure limit for login, setup and password changes. */
  loginLimiter: FailureRateLimiter;
  /** The admin-token failure limiter (shared with the rest of the API). */
  adminLimiter: FailureRateLimiter;
  log: Logger;
  /** Organisations, their keys, usage and custom presets. */
  orgs: OrgStore;
  keys: KeyResolver;
  usage: UsageStore;
  presets: PresetStore;
  /** 5 sign-ups per IP per hour. */
  signupLimiter: FailureRateLimiter;
  /** Check a key with its provider (tests inject a fake). */
  checkKey: (provider: KeyProvider, key: string) => Promise<KeyCheck>;
}

/** What org-api.ts shares with the portal routes. */
export interface PortalContext {
  deps: PortalDeps;
  hosted: boolean;
  fail: (reply: FastifyReply, status: number, message: string) => FastifyReply;
  tooMany: (reply: FastifyReply, blockedMs: number) => FastifyReply;
  storeError: (reply: FastifyReply, err: unknown) => FastifyReply;
  requireLogin: (req: FastifyRequest, reply: FastifyReply) => Requester | null;
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Requester | null;
  orgOf: (who: Requester) => string;
  label: (who: Requester) => string;
  passwordIssue: (password: string) => string | null;
  /** A free username made from an e-mail address (hosted accounts log in by e-mail). */
  usernameFor: (email: string) => string;
  zodMessage: (error: z.ZodError) => string;
}

export function registerPortal(app: FastifyInstance, deps: PortalDeps): void {
  const { loaded, users, screens, auth, pages, languages, settings, log } = deps;
  const { config } = loaded;
  const hosted = config.mode === "hosted";
  // Guesses at one account from many addresses; account and screen creation per address.
  const accountGuesses = new FailureRateLimiter({ maxFailures: 10, blockMs: 15 * 60_000 });
  const createLimiter = new FailureRateLimiter({
    maxFailures: 60,
    windowMs: 60 * 60_000,
    blockMs: 60 * 60_000,
  });
  /** The wait to announce when an attempt is refused (at least a second). */
  const waitOf = (limiter: FailureRateLimiter, key: string): number =>
    Math.max(limiter.blockedFor(key), 1000);

  const fail = (reply: FastifyReply, status: number, message: string): FastifyReply =>
    reply.code(status).send({ ok: false, message });

  const tooMany = (reply: FastifyReply, blockedMs: number): FastifyReply => {
    reply.header("Retry-After", String(Math.ceil(blockedMs / 1000)));
    return fail(
      reply,
      429,
      `Too many failed attempts; try again in ${Math.ceil(blockedMs / 60_000)} min`,
    );
  };

  /** Errors from the stores: AccountError → its status; anything else → 500 (logged). */
  const storeError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof AccountError) return fail(reply, err.status, err.message);
    log.error({ err }, "portal: request failed");
    return fail(reply, 500, "Internal server error");
  };

  /** The admin token (counts as admin) or the login cookie; null = neither. */
  const requester = (req: FastifyRequest): Requester | null => {
    const presented = presentedToken(req);
    if (presented !== null) {
      if (tokenMatches(presented, config.server.token)) {
        deps.adminLimiter.recordSuccess(req.ip);
        return { kind: "token" };
      }
      deps.adminLimiter.recordFailure(req.ip);
    }
    const user = auth.user(req);
    return user === null ? null : { kind: "user", user };
  };

  const requireLogin = (req: FastifyRequest, reply: FastifyReply): Requester | null => {
    if (presentedToken(req) !== null) {
      const blockedMs = deps.adminLimiter.blockedFor(req.ip);
      if (blockedMs > 0) {
        tooMany(reply, blockedMs);
        return null;
      }
    }
    const who = requester(req);
    if (who === null) {
      fail(reply, 401, "Log in first");
      return null;
    }
    return who;
  };

  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): Requester | null => {
    const who = requireLogin(req, reply);
    if (who === null) return null;
    if (!isAdmin(who)) {
      fail(reply, 403, "Only an admin can do this");
      return null;
    }
    return who;
  };

  const isAdmin = (who: Requester): boolean => who.kind === "token" || isAdminRole(who.user.role);
  /** The requester's organisation: the account's, or the local one for the admin token. */
  const orgOf = (who: Requester): string => (who.kind === "token" ? LOCAL_ORG_ID : who.user.orgId);
  /** Hosted accounts need longer passwords. */
  const passwordIssue = (password: string): string | null =>
    hosted && password.length < HOSTED_MIN_PASSWORD
      ? `The password needs at least ${HOSTED_MIN_PASSWORD} characters`
      : passwordProblem(password);
  const actorOf = (who: Requester): Actor =>
    who.kind === "token"
      ? { id: null, name: "Admin token" }
      : { id: who.user.id, name: who.user.displayName };
  const label = (who: Requester): string =>
    who.kind === "token" ? "admin-token" : who.user.username;
  const isOwner = (who: Requester, screen: ScreenRecord): boolean =>
    who.kind === "user" && screen.ownerId === who.user.id;
  const canEdit = (who: Requester, screen: ScreenRecord): boolean =>
    isAdmin(who) || isOwner(who, screen);
  const canControl = (who: Requester, screen: ScreenRecord): boolean =>
    isAdmin(who) || (isOwner(who, screen) && screen.ownerControl);

  /** scheme://host of the request (X-Forwarded-Proto/-Host only with trustProxy). */
  const originOf = (req: FastifyRequest): string =>
    `${req.protocol}://${safeHost(req.host) ?? `127.0.0.1:${config.server.port}`}`;

  /** The server listens on this computer's loopback address (127.0.0.1 or every address). */
  const onLoopback = ((h: string) => h === "0.0.0.0" || h === "::" || isLoopbackHost(h))(
    config.server.host,
  );

  /** The ports this computer reaches the server on (the compose-published ones in Docker). */
  const httpPort = loaded.context.publishedPort ?? config.server.port;
  const httpsPortOut = loaded.context.publishedHttpsPort ?? config.server.https.port;

  /** Local mode: the feed link on the computer that runs Turjuman (no HTTPS needed there). */
  const localFeed = (screen: ScreenRecord): string | null =>
    hosted || !onLoopback ? null : screenUrl(`http://127.0.0.1:${httpPort}`, screen);

  /** Local mode: an HTTPS screen link for other devices, when this server has one: HTTPS set up
   *  and exposure lan (with exposure local it answers on this computer only). */
  const secureFeed = (req: FastifyRequest, screen: ScreenRecord): string | null => {
    if (hosted || config.server.exposure !== "lan") return null;
    if (req.protocol === "https") return screenUrl(originOf(req), screen);
    const httpsPort = config.server.https.port === null ? null : httpsPortOut;
    const host = safeHost(req.host);
    if (httpsPort === null || host === null) return null;
    if (!existsSync(loaded.paths.tlsCertFile) || !existsSync(loaded.paths.tlsKeyFile)) return null;
    const hostname = host.startsWith("[")
      ? host.slice(0, host.indexOf("]") + 1)
      : host.split(":")[0];
    return screenUrl(`https://${hostname}:${httpsPort}`, screen);
  };

  const screenView = (req: FastifyRequest, who: Requester, screen: ScreenRecord): ScreenView => {
    const owner = screen.ownerId === null ? undefined : users.get(screen.ownerId);
    return {
      id: screen.id,
      name: screen.name,
      from: screen.from,
      to: screen.to,
      query: screen.query,
      guid: screen.guid,
      enabled: screen.enabled,
      ownerControl: screen.ownerControl,
      owner: owner === undefined ? null : { id: owner.id, displayName: owner.displayName },
      createdAt: iso(screen.createdAt),
      updatedAt: iso(screen.updatedAt),
      lastChange:
        screen.lastChange === null
          ? null
          : {
              action: screen.lastChange.action,
              by: screen.lastChange.by,
              at: iso(screen.lastChange.at),
            },
      url: screenUrl(originOf(req), screen),
      localUrl: localFeed(screen),
      secureUrl: secureFeed(req, screen),
      live: pages.screenLive(screen.id),
      canControl: canControl(who, screen),
      canEdit: canEdit(who, screen),
    };
  };

  /** The screen if the requester may see it (admin: the organisation's, user: own); else 404. */
  const visibleScreen = (reply: FastifyReply, who: Requester, id: string): ScreenRecord | null => {
    const screen = screens.get(id);
    if (
      screen === undefined ||
      screen.orgId !== orgOf(who) ||
      !(isAdmin(who) || isOwner(who, screen))
    ) {
      fail(reply, 404, "No such screen");
      return null;
    }
    return screen;
  };

  /** Setup from the server itself: exposure local (loopback-only), or a loopback request. */
  const fromServerMachine = (req: FastifyRequest): boolean => {
    if (config.server.exposure === "local") return true;
    return (
      isLoopbackAddress(req.ip) &&
      isLoopbackAddress(req.socket.remoteAddress) &&
      isLoopbackHost(hostOnly(req.headers.host ?? ""))
    );
  };

  // --- feed links -------------------------------------------------------------------------------

  // /feed/<guid>: the caption page with the screen's languages and look. An unknown (or replaced)
  // GUID goes to the default pair: the page then shows the calm "link not valid" card.
  // ?debug= and ?ui= (for the person setting up the screen, not part of its look) are kept.
  app.get<{ Params: { guid: string }; Querystring: Record<string, unknown> }>(
    "/feed/:guid",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      const keep = (target: string): string => {
        const [path = "", query = ""] = target.split("?", 2);
        const params = new URLSearchParams(query);
        for (const name of FEED_KEPT_PARAMS) {
          const value = req.query[name];
          if (typeof value === "string" && value.length <= 16) params.set(name, value);
        }
        return `${path}?${params.toString()}`;
      };
      const guid = req.params.guid.trim().toLowerCase();
      const screen = screens.byGuid(guid);
      if (screen !== null) return reply.redirect(keep(screenTarget(screen)), 302);
      const fallback = new URLSearchParams({ screen: req.params.guid });
      const { defaultFrom, defaultTo } = config.pages;
      return reply.redirect(
        keep(
          `/${encodeURIComponent(defaultFrom)}/${encodeURIComponent(defaultTo)}?${fallback.toString()}`,
        ),
        302,
      );
    },
  );

  // --- auth ----------------------------------------------------------------------------------------

  /** The account with this login's time recorded (users list: LAST LOGIN). */
  const stampLogin = (user: UserRecord): UserRecord => {
    try {
      return users.update(user.id, { lastLoginAt: Date.now() });
    } catch (err) {
      log.warn({ err }, "portal: could not record the login time");
      return user;
    }
  };

  app.get("/api/auth/state", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const state: AuthStateView = {
      setupRequired: !hosted && users.count() === 0,
      mode: config.mode,
      signup: hosted && config.hosted.signup === "open",
      loggedIn: auth.user(req) !== null,
    };
    return state;
  });

  app.post("/api/auth/setup", async (req, reply) => {
    // Hosted mode has sign-up instead: every organisation starts with its owner.
    if (hosted) return fail(reply, 404, "Create an account at /signup");
    const blockedMs = deps.loginLimiter.blockedFor(req.ip);
    if (blockedMs > 0) return tooMany(reply, blockedMs);
    if (users.count() > 0) return fail(reply, 409, "The admin account exists already: log in");
    const presented = presentedToken(req);
    const byToken = presented !== null && tokenMatches(presented, config.server.token);
    if (!byToken && !fromServerMachine(req)) {
      deps.loginLimiter.recordFailure(req.ip);
      log.warn({ ip: req.ip }, "portal: first-admin setup refused (not from this machine)");
      return fail(
        reply,
        403,
        `Create the first admin on the server itself (http://127.0.0.1:${httpPort}/app), ` +
          (config.server.token === "" ? "" : "with the admin token, ") +
          `or with: ${turjumanCmd("users add <name> --admin", loaded.context.inContainer)}`,
      );
    }
    const body = SetupBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    const problem = passwordProblem(body.data.password);
    if (problem !== null) return fail(reply, 400, problem);
    const passwordHash = await hashPassword(body.data.password);
    let user: UserRecord;
    try {
      // Checked again after hashing: two setup requests must not both win.
      if (users.count() > 0) return fail(reply, 409, "The admin account exists already: log in");
      user = users.insert({
        username: body.data.username,
        ...(body.data.displayName === undefined ? {} : { displayName: body.data.displayName }),
        role: "admin",
        passwordHash,
      });
    } catch (err) {
      return storeError(reply, err);
    }
    deps.loginLimiter.recordSuccess(req.ip);
    user = stampLogin(user);
    auth.login(req, reply, user);
    log.info({ user: user.username, ip: req.ip, byToken }, "portal: first admin created");
    return { me: toMe(user) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    // The attempt counts while it runs, so parallel guesses cannot all pass the check first.
    if (!deps.loginLimiter.tryBegin(req.ip)) {
      return tooMany(reply, waitOf(deps.loginLimiter, req.ip));
    }
    let outcome: AttemptOutcome = "neutral";
    try {
      const body = LoginBody.safeParse(req.body ?? {});
      if (!body.success) return fail(reply, 400, zodMessage(body.error));
      const name = (body.data.email ?? body.data.username ?? "").trim();
      const byEmail = name.includes("@");
      const user = byEmail ? users.byEmail(name) : users.byUsername(name);
      // An account under attack from many addresses gets its own limit.
      const account = user === undefined ? null : `acct-${user.id}`;
      if (account !== null && accountGuesses.isBlocked(account)) {
        outcome = "failure";
        return tooMany(reply, waitOf(accountGuesses, account));
      }
      let ok = false;
      if (user === undefined) await dummyVerify(body.data.password);
      else ok = await verifyPassword(body.data.password, user.passwordHash);
      if (!ok || user === undefined) {
        outcome = "failure";
        if (account !== null) accountGuesses.recordFailure(account);
        // The typed name is logged only when it is an account (it might be a mistyped password).
        log.warn(
          { ip: req.ip, user: user?.username ?? null, known: user !== undefined },
          "portal: login failed",
        );
        return fail(reply, 401, byEmail || hosted ? WRONG_EMAIL_LOGIN : WRONG_LOGIN);
      }
      if (user.disabled) {
        log.warn({ ip: req.ip, user: user.username }, "portal: login of a disabled account");
        return fail(reply, 403, "This account is disabled");
      }
      if (!auth.orgActive(user)) {
        log.warn(
          { ip: req.ip, user: user.username, org: user.orgId },
          "portal: login, org disabled",
        );
        return fail(reply, 403, "This organisation is disabled; contact the server's operator");
      }
      outcome = "success";
      if (account !== null) accountGuesses.recordSuccess(account);
      const current = stampLogin(user);
      auth.login(req, reply, current);
      log.info({ user: current.username, ip: req.ip }, "portal: login");
      return { me: toMe(current) };
    } finally {
      deps.loginLimiter.finish(req.ip, outcome);
    }
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const user = auth.user(req);
    auth.logout(req, reply);
    if (user !== null) {
      // Invalidate the login server-side as well (new sessionVersion): the signed cookie is
      // stateless, so clearing it in this browser alone would leave a copied cookie valid until
      // it expires. This also ends the account's other sessions.
      try {
        users.endSessions(user.id);
      } catch (err) {
        log.warn({ err, user: user.username }, "portal: ending the login server-side failed");
      }
      log.info({ user: user.username }, "portal: logout");
    }
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = auth.user(req);
    if (user === null) return fail(reply, 401, "Log in first");
    return { me: toMe(user) };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const user = auth.user(req);
    if (user === null) return fail(reply, 401, "Log in first");
    if (!deps.loginLimiter.tryBegin(req.ip)) {
      return tooMany(reply, waitOf(deps.loginLimiter, req.ip));
    }
    const body = PasswordBody.safeParse(req.body ?? {});
    let right = false;
    try {
      if (!body.success) return fail(reply, 400, zodMessage(body.error));
      right = await verifyPassword(body.data.current, user.passwordHash);
    } finally {
      deps.loginLimiter.finish(req.ip, !body.success ? "neutral" : right ? "success" : "failure");
    }
    if (!right) {
      log.warn(
        { user: user.username, ip: req.ip },
        "portal: password change with a wrong password",
      );
      return fail(reply, 403, "The current password is wrong");
    }
    const problem = passwordIssue(body.data.next);
    if (problem !== null) return fail(reply, 400, problem);
    const passwordHash = await hashPassword(body.data.next);
    let updated: UserRecord;
    try {
      updated = users.update(user.id, { passwordHash });
    } catch (err) {
      return storeError(reply, err);
    }
    // Every other device is logged out (new sessionVersion); this one gets a fresh cookie.
    auth.login(req, reply, updated);
    log.info({ user: user.username }, "portal: password changed");
    return reply.code(204).send();
  });

  // --- accounts (admin) ----------------------------------------------------------------------------

  const userViews = (list: UserRecord[]): ReturnType<typeof toUserView>[] => {
    const counts = screens.countByOwner();
    return list.map((u) => toUserView(u, counts.get(u.id) ?? 0));
  };

  app.get("/api/users", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    reply.header("Cache-Control", "no-store");
    const list = users.inOrg(orgOf(who)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return userViews(list);
  });

  /** An account of the requester's organisation, else 404 is sent. */
  const orgAccount = (reply: FastifyReply, who: Requester, id: string): UserRecord | null => {
    const target = users.get(id);
    if (target === undefined || target.orgId !== orgOf(who)) {
      fail(reply, 404, "No such account");
      return null;
    }
    return target;
  };

  /** Only the owner changes the owner's account. */
  const ownerGuard = (reply: FastifyReply, who: Requester, target: UserRecord): boolean => {
    if (target.role !== "owner" || (who.kind === "user" && who.user.id === target.id)) return true;
    fail(reply, 403, "Only the owner can change the owner's account");
    return false;
  };

  /** A free username made from an e-mail address ("imam.ali@x.nl" → "imam.ali-k3x9"). */
  const usernameFor = (email: string): string => {
    const local = normalizeUsername(email.split("@")[0] ?? "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 24);
    const base = local === "" ? "user" : local;
    for (;;) {
      const suffix = randomBytes(3).toString("hex").slice(0, 4);
      const candidate = `${base}-${suffix}`;
      if (users.byUsername(candidate) === undefined) return candidate;
    }
  };

  app.post("/api/users", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    const body = NewUserBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    let email: string | null = null;
    if (body.data.email !== undefined && body.data.email.trim() !== "") {
      const parsed = EMAIL.safeParse(body.data.email);
      if (!parsed.success) return fail(reply, 400, "Enter a valid e-mail address");
      email = normalizeEmail(parsed.data);
    }
    if (hosted && email === null) return fail(reply, 400, "An account needs an e-mail address");
    const username = body.data.username ?? (email === null ? undefined : usernameFor(email));
    if (username === undefined) return fail(reply, 400, "An account needs a username");
    const problem = passwordIssue(body.data.password);
    if (problem !== null) return fail(reply, 400, problem);
    const orgId = orgOf(who);
    if (hosted && users.inOrg(orgId).length >= MAX_ACCOUNTS_PER_ORG) {
      return fail(reply, 409, `A mosque can have at most ${MAX_ACCOUNTS_PER_ORG} accounts`);
    }
    // Every attempt counts: an organisation admin must not probe other mosques' addresses.
    if (!createLimiter.tryBegin(req.ip)) return tooMany(reply, waitOf(createLimiter, req.ip));
    let user: UserRecord;
    try {
      const passwordHash = await hashPassword(body.data.password);
      user = users.insert({
        username,
        ...(body.data.displayName === undefined ? {} : { displayName: body.data.displayName }),
        role: body.data.role,
        passwordHash,
        orgId,
        email,
      });
    } catch (err) {
      // Hosted: never say whether another mosque uses this e-mail address or username.
      if (hosted && err instanceof AccountError && err.status === 409) {
        return fail(
          reply,
          409,
          "This e-mail address can't be used. Ask the person for another one, or contact the server's operator.",
        );
      }
      return storeError(reply, err);
    } finally {
      createLimiter.finish(req.ip, "failure");
    }
    log.info(
      { user: label(who), account: user.username, role: user.role },
      "portal: account created",
    );
    return reply.code(201).send(toUserView(user, 0));
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    const body = PatchUserBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    const target = orgAccount(reply, who, req.params.id);
    if (target === null) return reply;
    if (!ownerGuard(reply, who, target)) return reply;
    const { displayName, role, disabled, password } = body.data;
    const self = who.kind === "user" && who.user.id === target.id;
    if (self && ((role !== undefined && role !== target.role) || disabled === true)) {
      return fail(reply, 409, "You cannot demote or disable your own account");
    }
    // Your own password changes through /api/auth/password, which asks for the current one: a
    // stolen login cookie must not be enough to take the account over.
    if (self && password !== undefined) {
      return fail(reply, 403, "Change your own password from your account menu");
    }
    if (password !== undefined) {
      const problem = passwordIssue(password);
      if (problem !== null) return fail(reply, 400, problem);
    }
    const passwordHash = password === undefined ? undefined : await hashPassword(password);
    let updated: UserRecord;
    try {
      updated = users.update(target.id, {
        ...(displayName === undefined ? {} : { displayName }),
        ...(role === undefined ? {} : { role }),
        ...(disabled === undefined ? {} : { disabled }),
        ...(passwordHash === undefined ? {} : { passwordHash }),
      });
    } catch (err) {
      return storeError(reply, err);
    }
    log.info(
      {
        user: label(who),
        account: updated.username,
        changes: Object.keys(body.data).filter((k) => k !== "password" || password !== undefined),
      },
      "portal: account changed",
    );
    return toUserView(updated, screens.countByOwner().get(updated.id) ?? 0);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    const target = orgAccount(reply, who, req.params.id);
    if (target === null) return reply;
    if (!ownerGuard(reply, who, target)) return reply;
    if (who.kind === "user" && who.user.id === target.id) {
      return fail(reply, 409, "You cannot delete your own account");
    }
    let moved: number;
    try {
      users.remove(target.id);
      // Their screens move to the deleting admin (to no owner, admins only, for the token).
      moved = screens.reassign(target.id, who.kind === "user" ? who.user.id : null);
    } catch (err) {
      return storeError(reply, err);
    }
    log.info(
      { user: label(who), account: target.username, screensMoved: moved },
      "portal: account deleted",
    );
    return reply.code(204).send();
  });

  // --- screens ---------------------------------------------------------------------------------------

  app.get("/api/screens", async (req, reply) => {
    const who = requireLogin(req, reply);
    if (who === null) return reply;
    reply.header("Cache-Control", "no-store");
    return screens
      .inOrg(orgOf(who))
      .filter((s) => isAdmin(who) || isOwner(who, s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => screenView(req, who, s));
  });

  app.post("/api/screens", async (req, reply) => {
    const who = requireLogin(req, reply);
    if (who === null) return reply;
    const body = NewScreenBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    const query = sanitizeQuery(body.data.query);
    if (query.length > MAX_QUERY) return fail(reply, 400, "The display settings are too long");
    // The language pair must be one the caption page accepts (like /:from/:to).
    const problem = languages.validatePair(body.data.from, body.data.to);
    if (problem !== null) return fail(reply, 400, problem);
    if (hosted && screens.inOrg(orgOf(who)).length >= MAX_SCREENS_PER_ORG) {
      return fail(reply, 409, `A mosque can have at most ${MAX_SCREENS_PER_ORG} screens`);
    }
    if (!createLimiter.tryBegin(req.ip)) return tooMany(reply, waitOf(createLimiter, req.ip));
    createLimiter.finish(req.ip, "failure");
    let screen: ScreenRecord;
    try {
      screen = screens.create(
        {
          name: body.data.name,
          from: body.data.from,
          to: body.data.to,
          query,
          ownerId: who.kind === "user" ? who.user.id : null,
          orgId: orgOf(who),
        },
        actorOf(who),
      );
    } catch (err) {
      return storeError(reply, err);
    }
    log.info(
      { user: label(who), screen: screen.id, name: screen.name, from: screen.from, to: screen.to },
      "portal: screen created",
    );
    return reply.code(201).send(screenView(req, who, screen));
  });

  app.patch<{ Params: { id: string } }>("/api/screens/:id", async (req, reply) => {
    const who = requireLogin(req, reply);
    if (who === null) return reply;
    const screen = visibleScreen(reply, who, req.params.id);
    if (screen === null) return reply;
    const body = PatchScreenBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    let query: string | undefined;
    if (body.data.query !== undefined) {
      query = sanitizeQuery(body.data.query);
      if (query.length > MAX_QUERY) return fail(reply, 400, "The display settings are too long");
    }
    let updated: ScreenRecord;
    try {
      updated = screens.update(
        screen.id,
        {
          ...(body.data.name === undefined ? {} : { name: body.data.name }),
          ...(query === undefined ? {} : { query }),
        },
        "edited",
        actorOf(who),
      );
    } catch (err) {
      return storeError(reply, err);
    }
    log.info(
      { user: label(who), screen: screen.id, changes: Object.keys(body.data) },
      "portal: screen edited",
    );
    // A new look reaches the OBS pages at once: they reload their /feed/<guid> link.
    if (query !== undefined && query !== screen.query) pages.reloadScreen(screen.id);
    return screenView(req, who, updated);
  });

  app.delete<{ Params: { id: string } }>("/api/screens/:id", async (req, reply) => {
    const who = requireLogin(req, reply);
    if (who === null) return reply;
    const screen = visibleScreen(reply, who, req.params.id);
    if (screen === null) return reply;
    try {
      screens.remove(screen.id);
    } catch (err) {
      return storeError(reply, err);
    }
    void pages.invalidateScreen(screen.id).catch((err: unknown) => {
      log.error({ err, screen: screen.id }, "portal: closing the pages of a deleted screen failed");
    });
    log.info({ user: label(who), screen: screen.id, name: screen.name }, "portal: screen deleted");
    return reply.code(204).send();
  });

  /** enable / disable / reset: admin, or the owner when the admin allowed it (ownerControl). */
  const controlled = (
    action: "enable" | "disable" | "reset",
    run: (screen: ScreenRecord, who: Requester) => { record: ScreenRecord; detail: object },
  ): void => {
    app.post<{ Params: { id: string } }>(`/api/screens/:id/${action}`, async (req, reply) => {
      const who = requireLogin(req, reply);
      if (who === null) return reply;
      const screen = visibleScreen(reply, who, req.params.id);
      if (screen === null) return reply;
      if (!canControl(who, screen)) {
        return fail(reply, 403, "The admin has not allowed you to switch this screen");
      }
      let result: { record: ScreenRecord; detail: object };
      try {
        result = run(screen, who);
      } catch (err) {
        return storeError(reply, err);
      }
      log.info(
        { user: label(who), screen: screen.id, name: screen.name, ...result.detail },
        `portal: screen ${action === "reset" ? "reset" : `${action}d`}`,
      );
      return screenView(req, who, result.record);
    });
  };

  const change = (
    screen: ScreenRecord,
    who: Requester,
    patch: { enabled?: boolean },
    action: ScreenAction,
  ): ScreenRecord => screens.update(screen.id, patch, action, actorOf(who));

  controlled("enable", (screen, who) => {
    const record = change(screen, who, { enabled: true }, "enabled");
    const pagesNotified = pages.enableScreen(record.id, record.name);
    return { record, detail: { pagesNotified } };
  });

  controlled("disable", (screen, who) => {
    const record = change(screen, who, { enabled: false }, "disabled");
    void pages.disableScreen(record.id, record.name).catch((err: unknown) => {
      log.error({ err, screen: record.id }, "portal: stopping the sessions of a screen failed");
    });
    return { record, detail: {} };
  });

  controlled("reset", (screen, who) => {
    const sessions = pages.resetScreen(screen.id);
    const record = change(screen, who, {}, "reset");
    return { record, detail: { sessions } };
  });

  // Start or end a prayer event (Athan, Iqama, Salah) on every page of a screen by hand, as the
  // detector would: admin, or the owner when the admin allowed it.
  app.post<{ Params: { id: string } }>("/api/screens/:id/event", async (req, reply) => {
    const who = requireLogin(req, reply);
    if (who === null) return reply;
    const screen = visibleScreen(reply, who, req.params.id);
    if (screen === null) return reply;
    if (!canControl(who, screen)) {
      return fail(reply, 403, "The admin has not allowed you to switch this screen");
    }
    const body = ScreenEventBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    if (!screen.enabled) return fail(reply, 409, "This screen is off: switch it on first");
    const sessions = pages.eventScreen(screen.id, body.data.event);
    if (sessions === 0) return fail(reply, 409, "No screen is showing this feed right now");
    log.info(
      { user: label(who), screen: screen.id, event: body.data.event, sessions },
      "portal: screen prayer event",
    );
    return screenView(req, who, screen);
  });

  app.post<{ Params: { id: string } }>("/api/screens/:id/regenerate", async (req, reply) => {
    const who = requireLogin(req, reply);
    if (who === null) return reply;
    const screen = visibleScreen(reply, who, req.params.id);
    if (screen === null) return reply;
    let updated: ScreenRecord;
    try {
      updated = screens.update(screen.id, { regenerate: true }, "regenerated", actorOf(who));
    } catch (err) {
      return storeError(reply, err);
    }
    void pages.invalidateScreen(screen.id).catch((err: unknown) => {
      log.error({ err, screen: screen.id }, "portal: closing the pages of a screen failed");
    });
    log.info(
      { user: label(who), screen: screen.id, version: updated.version },
      "portal: screen link regenerated",
    );
    return screenView(req, who, updated);
  });

  app.post<{ Params: { id: string } }>("/api/screens/:id/owner-control", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    const screen = visibleScreen(reply, who, req.params.id);
    if (screen === null) return reply;
    const body = OwnerControlBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    let updated: ScreenRecord;
    try {
      updated = screens.update(
        screen.id,
        { ownerControl: body.data.allowed },
        "edited",
        actorOf(who),
      );
    } catch (err) {
      return storeError(reply, err);
    }
    log.info(
      { user: label(who), screen: screen.id, ownerControl: body.data.allowed },
      "portal: owner control changed",
    );
    return screenView(req, who, updated);
  });

  // --- settings (admin) ----------------------------------------------------------------------------

  app.get("/api/settings", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    reply.header("Cache-Control", "no-store");
    const out: PortalSettings = { requireScreen: settings.requireScreen };
    return out;
  });

  app.patch("/api/settings", async (req, reply) => {
    const who = requireAdmin(req, reply);
    if (who === null) return reply;
    // A server-wide setting: in hosted mode only the operator (admin token) changes it.
    if (hosted && who.kind !== "token") {
      return fail(reply, 403, "This is a setting of the whole server");
    }
    const body = SettingsBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, zodMessage(body.error));
    let result: { ok: boolean; message: string };
    try {
      result = deps.saveSettings({ requireScreen: body.data.requireScreen });
    } catch (err) {
      log.error({ err }, "portal: saving the settings failed");
      return fail(reply, 500, "The settings could not be saved to config.yaml");
    }
    if (!result.ok) return fail(reply, 400, result.message);
    settings.requireScreen = body.data.requireScreen;
    log.info(
      { user: label(who), requireScreen: body.data.requireScreen },
      "portal: settings changed",
    );
    const out: PortalSettings = { requireScreen: settings.requireScreen };
    return out;
  });

  registerOrgApi(app, {
    deps,
    hosted,
    fail,
    tooMany,
    storeError,
    requireLogin,
    requireAdmin,
    orgOf,
    label,
    passwordIssue,
    usernameFor,
    zodMessage,
  });
}
