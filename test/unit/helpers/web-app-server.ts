// A small in-memory fake of the server's app API (src/server/portal.ts, src/server/org-api.ts and
// the block history of src/server/app.ts) for the app pages under happy-dom. `fetch` answers from
// it and every request is recorded, so a test can check both what the page shows and what it sent.
// One-off answers (`once`) stand in for failures: an HTTP error, a lost connection, a slow reply.
import { vi } from "vitest";
import type {
  AppMode,
  Block,
  KeyStatus,
  Me,
  OrgView,
  PrayerEvent,
  ScreenView,
  UserView,
} from "../../../src/shared/protocol.js";

export interface Sent {
  method: string;
  /** Path and query, as the page asked for it. */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

/** An answer: a status with a JSON body, a raw body text, a lost connection, or a body that
 *  can't be read. */
export type Reply =
  | { status: number; body?: unknown; text?: string; headers?: Record<string, string> }
  | "network"
  | "unreadable";

export type Handler = (req: Sent) => Reply | Promise<Reply>;

export interface FakeUser extends UserView {
  password: string;
}

export interface FakeSession {
  blocks: Block[];
  live?: boolean;
  from?: string;
  to?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  /** The access key the session needs (401 without it). */
  key?: string;
}

export const NO_KEY: KeyStatus = {
  provider: "soniox",
  set: false,
  last4: null,
  validatedAt: null,
  source: null,
};

const fail = (status: number, message: string): Reply => ({
  status,
  body: { ok: false, message },
});

/** A deferred answer: the request waits until release(). */
export interface Held {
  release(reply?: Reply): void;
}

export class FakeServer {
  mode: AppMode = "local";
  signupOpen = true;
  /** POST /api/auth/setup answers 403 (not from the server's own computer). */
  setupRemote = false;
  users: FakeUser[] = [];
  /** The logged-in account (the login cookie), or null. */
  session: string | null = null;
  /** GET /api/org: null answers 404 (an older server without organisations). */
  org: { id: string; name: string; usage: OrgView["usage"] } | null = {
    id: "local",
    name: "",
    usage: { monthMinutes: 0, estimateUsd: 0 },
  };
  soniox: KeyStatus = { ...NO_KEY };
  /** The server's .env holds SONIOX_API_KEY (a stored key is not used while it is set). */
  envKey = false;
  /** What Soniox says about a key (PUT /api/org/keys/soniox). */
  keyCheck: (
    key: string,
  ) =>
    | { result: "ok" }
    | { result: "rejected"; message: string }
    | { result: "unchecked"; message: string } = () => ({ result: "ok" });
  screens: ScreenView[] = [];
  requireScreen = false;
  sessions = new Map<string, FakeSession>();
  /** GET /api/languages. */
  languages: unknown = {
    sources: [{ code: "ar", en: "Arabic" }],
    targets: [
      { code: "nl", en: "Dutch" },
      { code: "en", en: "English" },
      { code: "tlh", en: "Klingon" },
    ],
  };
  readonly sent: Sent[] = [];
  private readonly overrides: Array<{ route: string; handler: Handler; times: number }> = [];
  private seq = 0;

  readonly fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const req: Sent = {
      method: (init.method ?? "GET").toUpperCase(),
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.sent.push(req);
    const route = `${req.method} ${req.path}`;
    const o = this.overrides.find((x) => x.route === route || x.route === req.path);
    let reply: Reply;
    if (o) {
      if (--o.times === 0) this.overrides.splice(this.overrides.indexOf(o), 1);
      reply = await o.handler(req);
    } else {
      reply = this.handle(req);
    }
    return respond(reply);
  });

  /** The next `times` requests to `route` ("POST /api/auth/login", or a path for any method). */
  once(route: string, reply: Reply | Handler, times = 1): void {
    this.overrides.push({
      route,
      handler: typeof reply === "function" ? reply : () => reply,
      times,
    });
  }

  /** The next request to `route` waits until it is released (default: the normal answer). */
  hold(route: string): Held {
    let release: (reply?: Reply) => void = () => {};
    const waiting = new Promise<Reply | undefined>((resolve) => {
      release = resolve;
    });
    this.once(route, async (req) => (await waiting) ?? this.handle(req));
    return { release: (reply) => release(reply) };
  }

  /** "METHOD /path" of every request so far, in order. */
  requests(): string[] {
    return this.sent.map((r) => `${r.method} ${r.path}`);
  }

  last(route: string): Sent | undefined {
    return [...this.sent].reverse().find((r) => `${r.method} ${r.path}` === route);
  }

  addUser(u: Partial<FakeUser> & { username: string }): FakeUser {
    const user: FakeUser = {
      id: `u${++this.seq}`,
      displayName: "",
      role: "user",
      orgId: this.org?.id ?? "local",
      email: null,
      disabled: false,
      createdAt: Date.UTC(2026, 0, 1),
      lastLoginAt: null,
      screens: 0,
      password: "correct-horse",
      ...u,
    };
    this.users.push(user);
    return user;
  }

  /** Log `user` in (the cookie the browser would carry). */
  login(user: FakeUser): FakeUser {
    this.session = user.id;
    return user;
  }

  addScreen(s: Partial<ScreenView> & { name: string }): ScreenView {
    const n = ++this.seq;
    const guid = `g${n}aaaaaaaabbbbbbbb`;
    const screen: ScreenView = {
      id: `s${n}`,
      from: "ar",
      to: "nl",
      query: "",
      guid,
      enabled: false,
      ownerControl: false,
      owner: null,
      createdAt: Date.UTC(2026, 0, 1),
      updatedAt: Date.UTC(2026, 0, 1),
      lastChange: null,
      url: `https://turjuman.example/feed/${guid}`,
      localUrl: `http://127.0.0.1:8765/feed/${guid}`,
      secureUrl: null,
      live: { pages: 0, sessions: 0, speaking: false, since: null, event: null },
      canControl: true,
      canEdit: true,
      ...s,
    };
    this.screens.unshift(screen);
    return screen;
  }

  me(): FakeUser | null {
    return this.users.find((u) => u.id === this.session) ?? null;
  }

  private toMe(u: FakeUser): Me {
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      orgId: u.orgId,
      email: u.email,
    };
  }

  private view(u: FakeUser): UserView {
    const { password: _password, ...view } = u;
    return view;
  }

  private orgView(me: FakeUser): OrgView | null {
    if (this.org === null) return null;
    return {
      id: this.org.id,
      name: this.org.name,
      mode: this.mode,
      role: me.role,
      keys: { soniox: { ...this.soniox } },
      usage: { ...this.org.usage },
    };
  }

  private handle(req: Sent): Reply {
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const me = this.me();
    const admin = me !== null && (me.role === "admin" || me.role === "owner");
    const route = `${method} ${path}`;

    // open routes
    if (route === "GET /api/auth/state") {
      return {
        status: 200,
        body: {
          setupRequired: this.mode === "local" && this.users.length === 0,
          mode: this.mode,
          signup: this.mode === "hosted" && this.signupOpen,
          loggedIn: me !== null,
        },
      };
    }
    if (route === "GET /api/languages") return { status: 200, body: this.languages };
    if (route === "GET /api/presets") return { status: 200, body: { custom: [], default: null } };
    if (route === "POST /api/auth/login") return this.loginRoute(body);
    if (route === "POST /api/auth/setup") return this.setupRoute(body);
    if (route === "POST /api/auth/signup") return this.signupRoute(body);
    if (route === "POST /api/auth/logout") {
      this.session = null;
      return { status: 204 };
    }
    const blocks = /^\/api\/sessions\/([^/]+)\/blocks$/.exec(path);
    if (method === "GET" && blocks?.[1])
      return this.blocksRoute(decodeURIComponent(blocks[1]), req);

    if (me === null) return fail(401, "Log in first");
    if (route === "GET /api/auth/me") return { status: 200, body: { me: this.toMe(me) } };
    if (route === "GET /api/org") {
      const view = this.orgView(me);
      return view === null ? fail(404, "No such organisation") : { status: 200, body: view };
    }
    if (route === "GET /api/screens") {
      const list = admin ? this.screens : this.screens.filter((s) => s.owner?.id === me.id);
      return { status: 200, body: list };
    }
    const screen = /^\/api\/screens\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (screen?.[1])
      return this.screenRoute(method, decodeURIComponent(screen[1]), screen[2], body);

    if (!admin) return fail(403, "Only an admin can do that");
    if (route === "PATCH /api/org") {
      if (this.org === null) return fail(404, "No such organisation");
      this.org.name = String(body.name ?? "").trim();
      return { status: 200, body: this.orgView(me) };
    }
    if (route === "DELETE /api/org") {
      if (this.mode !== "hosted") return fail(404, "A local server has one organisation");
      if (me.role !== "owner") return fail(403, "Only the owner can delete the organisation");
      if (body.password !== me.password) return fail(403, "The password is wrong");
      this.org = null;
      this.session = null;
      return { status: 204 };
    }
    if (path === "/api/org/keys/soniox") return this.keyRoute(method, body);
    if (route === "GET /api/users") {
      return {
        status: 200,
        body: this.users.filter((u) => u.orgId === me.orgId).map((u) => this.view(u)),
      };
    }
    if (route === "POST /api/users") return this.newUserRoute(me, body);
    const user = /^\/api\/users\/([^/]+)$/.exec(path);
    if (user?.[1]) return this.userRoute(method, me, decodeURIComponent(user[1]), body);
    if (route === "GET /api/settings")
      return { status: 200, body: { requireScreen: this.requireScreen } };
    if (route === "PATCH /api/settings") {
      this.requireScreen = body.requireScreen === true;
      return { status: 200, body: { requireScreen: this.requireScreen } };
    }
    return fail(404, "Not found");
  }

  private loginRoute(body: Record<string, unknown>): Reply {
    const name = String(body.username ?? "").trim();
    const user = this.users.find(
      (u) => u.username === name || (u.email !== null && u.email === name),
    );
    if (user === undefined || user.password !== body.password) {
      return fail(
        401,
        this.mode === "hosted" ? "Wrong e-mail or password" : "Wrong username or password",
      );
    }
    if (user.disabled) return fail(403, "This account is disabled");
    this.session = user.id;
    user.lastLoginAt = Date.now();
    return { status: 200, body: { me: this.toMe(user) } };
  }

  private setupRoute(body: Record<string, unknown>): Reply {
    if (this.mode === "hosted") return fail(404, "Create an account at /signup");
    if (this.users.length > 0) return fail(409, "The admin account exists already: log in");
    if (this.setupRemote) {
      return fail(403, "Create the first admin on the server itself (http://127.0.0.1:8765/app)");
    }
    const user = this.addUser({
      username: String(body.username),
      password: String(body.password),
      role: "admin",
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
    });
    this.session = user.id;
    return { status: 200, body: { me: this.toMe(user) } };
  }

  private signupRoute(body: Record<string, unknown>): Reply {
    if (this.mode !== "hosted")
      return fail(404, "This server has no sign-up: ask its admin for an account");
    if (!this.signupOpen) return fail(403, "Sign-up is closed on this server");
    if (String(body.website ?? "") !== "") return fail(400, "Sign-up failed");
    const email = String(body.email).toLowerCase();
    if (this.users.some((u) => u.email === email)) {
      return fail(409, "An account with this e-mail address exists already: log in");
    }
    this.org = {
      id: `org${++this.seq}`,
      name: String(body.orgName),
      usage: { monthMinutes: 0, estimateUsd: 0 },
    };
    const user = this.addUser({
      username: email.split("@")[0] ?? "owner",
      email,
      displayName: String(body.name),
      password: String(body.password),
      role: "owner",
      orgId: this.org.id,
    });
    this.session = user.id;
    return { status: 201, body: { me: this.toMe(user) } };
  }

  private keyRoute(method: string, body: Record<string, unknown>): Reply {
    if (method === "DELETE") {
      this.soniox = this.envKey
        ? { provider: "soniox", set: true, last4: null, validatedAt: null, source: "env" }
        : { ...NO_KEY };
      return { status: 200, body: { status: this.soniox } };
    }
    const key = String(body.key ?? "").trim();
    const check = this.keyCheck(key);
    if (check.result === "rejected") return fail(400, check.message);
    const stored: KeyStatus = {
      provider: "soniox",
      set: true,
      last4: key.slice(-4),
      validatedAt: check.result === "ok" ? "2026-10-09T10:00:00.000Z" : null,
      source: this.envKey ? "env" : "stored",
    };
    this.soniox = stored;
    const warning = this.envKey
      ? "SONIOX_API_KEY in the server's .env is used while it is set"
      : check.result === "unchecked"
        ? check.message
        : undefined;
    return {
      status: 200,
      body: { status: stored, checked: check.result === "ok", ...(warning ? { warning } : {}) },
    };
  }

  private screenRoute(
    method: string,
    id: string,
    action: string | undefined,
    body: Record<string, unknown>,
  ): Reply {
    const screen = this.screens.find((s) => s.id === id);
    if (screen === undefined) return fail(404, "No such screen");
    const touch = (a: NonNullable<ScreenView["lastChange"]>["action"]): void => {
      screen.lastChange = { action: a, by: this.me()?.displayName || "cli", at: Date.now() };
    };
    if (action === undefined && method === "PATCH") {
      screen.name = String(body.name);
      touch("edited");
      return { status: 200, body: screen };
    }
    if (action === undefined && method === "DELETE") {
      this.screens = this.screens.filter((s) => s !== screen);
      return { status: 204 };
    }
    if (method !== "POST") return fail(404, "Not found");
    const control = (): Reply | null =>
      screen.canControl ? null : fail(403, "The admin has not allowed you to switch this screen");
    switch (action) {
      case "enable":
      case "disable": {
        const refused = control();
        if (refused) return refused;
        screen.enabled = action === "enable";
        touch(action === "enable" ? "enabled" : "disabled");
        return { status: 200, body: screen };
      }
      case "reset": {
        const refused = control();
        if (refused) return refused;
        touch("reset");
        return { status: 200, body: screen };
      }
      case "event": {
        const refused = control();
        if (refused) return refused;
        if (!screen.enabled) return fail(409, "This screen is off: switch it on first");
        if (screen.live.sessions === 0)
          return fail(409, "No screen is showing this feed right now");
        const ev = body.event as PrayerEvent | "none";
        screen.live = { ...screen.live, event: ev === "none" ? null : ev };
        return { status: 200, body: screen };
      }
      case "regenerate": {
        screen.guid = `n${screen.guid}`.slice(0, 18);
        screen.url = `https://turjuman.example/feed/${screen.guid}`;
        touch("regenerated");
        return { status: 200, body: screen };
      }
      case "owner-control":
        screen.ownerControl = body.allowed === true;
        touch("edited");
        return { status: 200, body: screen };
      default:
        return fail(404, "Not found");
    }
  }

  private newUserRoute(me: FakeUser, body: Record<string, unknown>): Reply {
    const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
    const username =
      typeof body.username === "string" ? body.username : (email?.split("@")[0] ?? "");
    if (this.users.some((u) => u.username === username || (email !== null && u.email === email))) {
      return fail(
        409,
        email !== null
          ? "This e-mail address can't be used. Ask the person for another one."
          : `The username ${username} is taken`,
      );
    }
    const user = this.addUser({
      username,
      email,
      password: String(body.password),
      role: body.role === "admin" ? "admin" : "user",
      displayName: typeof body.displayName === "string" ? body.displayName : "",
      orgId: me.orgId,
    });
    return { status: 201, body: this.view(user) };
  }

  private userRoute(
    method: string,
    me: FakeUser,
    id: string,
    body: Record<string, unknown>,
  ): Reply {
    const target = this.users.find((u) => u.id === id && u.orgId === me.orgId);
    if (target === undefined) return fail(404, "No such account");
    if (method === "DELETE") {
      if (target.id === me.id) return fail(409, "You cannot delete your own account");
      this.users = this.users.filter((u) => u !== target);
      for (const s of this.screens) {
        if (s.owner?.id === target.id) s.owner = { id: me.id, displayName: me.displayName };
      }
      return { status: 204 };
    }
    if (typeof body.role === "string") target.role = body.role as FakeUser["role"];
    if (typeof body.disabled === "boolean") target.disabled = body.disabled;
    if (typeof body.password === "string") target.password = body.password;
    return { status: 200, body: this.view(target) };
  }

  private blocksRoute(id: string, req: Sent): Reply {
    const s = this.sessions.get(id);
    if (s === undefined) return fail(404, `No session ${id}`);
    if (s.key !== undefined && req.query.get("key") !== s.key)
      return fail(401, "Access key needed");
    const limit = Number(req.query.get("limit") ?? "100");
    const before = req.query.get("before");
    const older = s.blocks
      .filter((b) => before === null || b.seq < Number(before))
      .sort((a, b) => a.seq - b.seq);
    const page = older.slice(-limit);
    return {
      status: 200,
      body: {
        sessionId: id,
        live: s.live ?? false,
        from: s.from ?? "ar",
        to: s.to ?? "nl",
        startedAt: s.startedAt ?? null,
        endedAt: s.endedAt ?? null,
        blocks: [...page].reverse(),
        hasMore: older.length > page.length,
      },
    };
  }
}

/** The answer as the page's fetch() sees it (only what the pages read: ok, status, headers,
 *  text and json; plain promises, so fake timers never hold it up). */
function respond(reply: Reply): Response {
  if (reply === "network") throw new TypeError("Failed to fetch");
  const status = reply === "unreadable" ? 502 : reply.status;
  const text =
    reply === "unreadable"
      ? null
      : (reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)));
  const headers = new Map(
    Object.entries(reply === "unreadable" ? {} : (reply.headers ?? {})).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: () => (text === null ? Promise.reject(new Error("body lost")) : Promise.resolve(text)),
    json: () =>
      text === null ? Promise.reject(new Error("body lost")) : Promise.resolve(JSON.parse(text)),
  } as unknown as Response;
}
