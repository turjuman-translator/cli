// The app's portal API: the first admin, logins and
// passwords, accounts, screens and their live pages, settings and feed links.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { AccountError, type UserRecord } from "../../src/accounts/users.js";
import { PageSockets } from "../../src/server/page-ws.js";
import type { ScreenView, UserView } from "../../src/shared/protocol.js";
import {
  buildTestApp,
  cookieOf,
  hello,
  openWS,
  PASSWORD,
  TempRoot,
  type TestApp,
} from "./helpers/server-fakes.js";

const TOKEN = "portal-admin-token-0123456789ab";
const LAN_HOST = "192.168.1.10:8765";
const LAN = `server:\n  host: 0.0.0.0\n  exposure: lan\n  token: ${TOKEN}\n`;
const REMOTE = "192.168.1.50";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

describe("portal", () => {
  let root: TempRoot;
  let t: TestApp;

  /** The Host header: the LAN address, or this computer's for exposure local. */
  let host = LAN_HOST;

  async function build(yaml = LAN, env: Record<string, string> = {}): Promise<void> {
    host = yaml.includes("exposure:") ? LAN_HOST : "127.0.0.1:8765";
    await t?.app.close();
    t = await buildTestApp(root, yaml, { env });
    await t.app.ready();
  }

  const call = (
    method: Method,
    url: string,
    opts: {
      cookie?: string;
      payload?: Record<string, unknown>;
      headers?: Record<string, string>;
      ip?: string;
    } = {},
  ): Promise<LightMyRequestResponse> =>
    t.app.inject({
      method,
      url,
      headers: {
        host,
        ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
        ...opts.headers,
      },
      remoteAddress: opts.ip ?? REMOTE,
      ...(opts.payload === undefined && method === "GET" ? {} : { payload: opts.payload ?? {} }),
    });
  const asToken = { authorization: `Bearer ${TOKEN}` };
  const logged = (msg: string): Record<string, unknown> | undefined =>
    t.lines.find((l) => l.msg === msg);

  beforeEach(async () => {
    root = new TempRoot("portal-");
    host = LAN_HOST;
    t = await buildTestApp(root, LAN);
    await t.app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await t.app.close();
    root.remove();
  });

  describe("the first admin", () => {
    it("is made on the server itself, once", async () => {
      await build("");
      expect((await call("GET", "/api/auth/state")).json()).toEqual({
        setupRequired: true,
        mode: "local",
        signup: false,
        loggedIn: false,
      });
      expect(
        (await call("POST", "/api/auth/setup", { payload: { username: "x" } })).statusCode,
      ).toBe(400);
      const weak = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: "short" },
      });
      expect([weak.statusCode, weak.json().message]).toEqual([
        400,
        "The password needs at least 8 characters",
      ]);
      const badName = await call("POST", "/api/auth/setup", {
        payload: { username: "No Spaces!", password: PASSWORD },
      });
      expect(badName.statusCode).toBe(400);
      expect(badName.json().message).toMatch(/^A username has/);
      const ok = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: PASSWORD, displayName: "Imam Ali" },
      });
      expect(ok.json().me).toMatchObject({
        username: "imam",
        displayName: "Imam Ali",
        role: "admin",
      });
      expect(t.users.byUsername("imam")?.lastLoginAt).not.toBeNull();
      const state = await call("GET", "/api/auth/state", { cookie: cookieOf(ok) });
      expect(state.json()).toMatchObject({ setupRequired: false, loggedIn: true });
      const again = await call("POST", "/api/auth/setup", {
        payload: { username: "other", password: PASSWORD },
      });
      expect([again.statusCode, again.json().message]).toEqual([
        409,
        "The admin account exists already: log in",
      ]);
    });

    it("makes one admin when two set-ups arrive at once", async () => {
      await build("");
      const [a, b] = await Promise.all(
        ["first", "second"].map((username) =>
          call("POST", "/api/auth/setup", { payload: { username, password: PASSWORD } }),
        ),
      );
      expect([a?.statusCode, b?.statusCode].sort()).toEqual([200, 409]);
      expect(t.users.count()).toBe(1);
    });

    it("on the LAN: only from this machine or with the admin token", async () => {
      const remote = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: PASSWORD },
      });
      expect(remote.statusCode).toBe(403);
      expect(remote.json().message).toMatch(
        /^Create the first admin on the server itself \(http:\/\/127\.0\.0\.1:8765\/app\), with the admin token, or with: .*turjuman users add <name> --admin$/,
      );
      expect(logged("portal: first-admin setup refused (not from this machine)")).toBeDefined();
      // A proxy on this machine forwards a remote client: its Host is not loopback.
      const proxied = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: PASSWORD },
        ip: "127.0.0.1",
      });
      expect(proxied.statusCode).toBe(403);
      // From this machine (IPv6 loopback): past the machine check, the body is checked next.
      const v6 = await call("POST", "/api/auth/setup", {
        payload: { username: "imam" },
        ip: "::1",
        headers: { host: "[::1]:8765" },
      });
      expect(v6.statusCode).toBe(400);
      const loopback = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: PASSWORD },
        ip: "::ffff:127.0.0.1",
        headers: { host: "localhost" },
      });
      expect(loopback.statusCode).toBe(200);
    });

    it("on the LAN with the admin token, from anywhere", async () => {
      const res = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: PASSWORD },
        headers: asToken,
      });
      expect(res.statusCode).toBe(200);
    });

    it("blocks an address after 10 refused set-ups", async () => {
      for (let i = 0; i < 10; i++) {
        await call("POST", "/api/auth/setup", {
          payload: { username: "imam", password: PASSWORD },
        });
      }
      const blocked = await call("POST", "/api/auth/setup", {
        payload: { username: "imam", password: PASSWORD },
        headers: asToken,
      });
      expect([blocked.statusCode, blocked.json().message]).toEqual([
        429,
        "Too many failed attempts; try again in 10 min",
      ]);
      expect(blocked.headers["retry-after"]).toBe("600");
    });
  });

  describe("logging in", () => {
    let imam: UserRecord;
    beforeEach(() => {
      imam = t.user("imam");
    });

    const login = (payload: Record<string, unknown>, ip = REMOTE) =>
      call("POST", "/api/auth/login", { payload, ip });

    it("logs in with the right password and records when", async () => {
      const res = await login({ username: " IMAM ", password: PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(res.json().me).toMatchObject({ id: imam.id, role: "admin" });
      const cookie = String(res.headers["set-cookie"]);
      expect(cookie).toMatch(
        /^captions_session=.+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/,
      );
      expect(t.users.get(imam.id)?.lastLoginAt).not.toBeNull();
      expect((await call("GET", "/api/auth/me", { cookie: cookieOf(res) })).json().me.id).toBe(
        imam.id,
      );
    });

    it("still logs in when the login time cannot be recorded", async () => {
      vi.spyOn(t.users, "update").mockImplementation(() => {
        throw new Error("read-only");
      });
      expect((await login({ username: "imam", password: PASSWORD })).statusCode).toBe(200);
      expect(logged("portal: could not record the login time")).toBeDefined();
    });

    it("refuses wrong passwords, unknown names and disabled accounts alike", async () => {
      const wrong = await login({ username: "imam", password: "wrong-password" });
      expect([wrong.statusCode, wrong.json().message]).toEqual([401, "Wrong username or password"]);
      expect(logged("portal: login failed")).toMatchObject({ user: "imam", known: true });
      const unknown = await login({ username: "nobody", password: PASSWORD });
      expect(unknown.json().message).toBe("Wrong username or password");
      const byEmail = await login({ email: "imam@x.nl", password: PASSWORD });
      expect(byEmail.json().message).toBe("Wrong e-mail address or password");
      expect((await login({ password: PASSWORD })).statusCode).toBe(400);
      const empty = await login({ username: "  ", password: PASSWORD });
      expect([empty.statusCode, empty.json().message]).toEqual([
        400,
        "Enter your e-mail address or username",
      ]);
      t.user("second");
      t.users.update(imam.id, { disabled: true });
      const disabled = await login({ username: "imam", password: PASSWORD });
      expect([disabled.statusCode, disabled.json().message]).toEqual([
        403,
        "This account is disabled",
      ]);
    });

    it("limits guesses per address and per account", async () => {
      for (let i = 0; i < 10; i++) await login({ username: "nobody", password: "x" }, "10.0.0.1");
      const blocked = await login({ username: "imam", password: PASSWORD }, "10.0.0.1");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBe("600");
      // One account guessed at from many addresses gets a limit of its own.
      for (let i = 0; i < 10; i++) {
        expect(
          (await login({ username: "imam", password: "wrong" }, `10.0.1.${i}`)).statusCode,
        ).toBe(401);
      }
      const account = await login({ username: "imam", password: PASSWORD }, "10.0.2.1");
      expect([account.statusCode, account.headers["retry-after"]]).toEqual([429, "900"]);
    });

    it("logs out (the cookie is cleared) with or without a login", async () => {
      const out = await call("POST", "/api/auth/logout", { cookie: t.cookie(imam) });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
      expect((await call("POST", "/api/auth/logout")).statusCode).toBe(204);
      expect((await call("GET", "/api/auth/me")).statusCode).toBe(401);
    });

    it("changes the password with the current one; other devices are logged out", async () => {
      const cookie = t.cookie(imam);
      expect((await call("POST", "/api/auth/password", { payload: {} })).statusCode).toBe(401);
      expect((await call("POST", "/api/auth/password", { cookie, payload: {} })).statusCode).toBe(
        400,
      );
      const wrong = await call("POST", "/api/auth/password", {
        cookie,
        payload: { current: "wrong-password", next: "another-password-1" },
      });
      expect([wrong.statusCode, wrong.json().message]).toEqual([
        403,
        "The current password is wrong",
      ]);
      const weak = await call("POST", "/api/auth/password", {
        cookie,
        payload: { current: PASSWORD, next: "short" },
      });
      expect(weak.statusCode).toBe(400);
      const ok = await call("POST", "/api/auth/password", {
        cookie,
        payload: { current: PASSWORD, next: "another-password-1" },
      });
      expect(ok.statusCode).toBe(204);
      expect((await call("GET", "/api/auth/me", { cookie })).statusCode).toBe(401);
      expect((await call("GET", "/api/auth/me", { cookie: cookieOf(ok) })).statusCode).toBe(200);
    });

    it("refuses a password change while the address is blocked, or when saving fails", async () => {
      const cookie = t.cookie(imam);
      vi.spyOn(t.users, "update").mockImplementation(() => {
        throw new Error("disk full");
      });
      const failed = await call("POST", "/api/auth/password", {
        cookie,
        payload: { current: PASSWORD, next: "another-password-1" },
      });
      expect([failed.statusCode, failed.json().message]).toEqual([500, "Internal server error"]);
      expect(logged("portal: request failed")).toBeDefined();
      for (let i = 0; i < 10; i++) {
        await call("POST", "/api/auth/password", {
          cookie,
          payload: { current: "wrong-password", next: "another-password-1" },
        });
      }
      const blocked = await call("POST", "/api/auth/password", {
        cookie,
        payload: { current: PASSWORD, next: "another-password-1" },
      });
      expect(blocked.statusCode).toBe(429);
    });

    it("ignores stale cookies next to a valid one, and cookies of a server without accounts", async () => {
      const stale = t.cookie({ ...imam, sessionVersion: 0 });
      const both = `${stale}; other=1; ${t.cookie(imam)}`;
      expect((await call("GET", "/api/auth/me", { cookie: both })).statusCode).toBe(200);
      expect((await call("GET", "/api/auth/me", { cookie: `${stale}; x=y` })).statusCode).toBe(401);
      // Without any account no cookie can be valid.
      writeFileSync(root.path("users.yaml"), "users: []\n");
      t.users.reload(true);
      expect((await call("GET", "/api/auth/me", { cookie: both })).statusCode).toBe(401);
    });

    it("treats a broken secret.key as no login, and logs it", async () => {
      const cookie = t.cookie(imam);
      writeFileSync(root.path("secret.key"), "not a secret\n");
      expect((await call("GET", "/api/auth/me", { cookie })).statusCode).toBe(401);
      expect(logged("login cookie check failed")).toBeDefined();
    });

    it("accepts the admin token next to a wrong cookie, and counts a wrong token", async () => {
      const cookie = t.cookie(imam);
      // A wrong token falls back to the login (and counts as a failed attempt).
      const res = await call("GET", "/api/users", {
        cookie,
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(200);
      for (let i = 0; i < 10; i++) {
        await call("GET", "/api/users", { headers: { authorization: `Bearer wrong-${i}` } });
      }
      const blocked = await call("GET", "/api/users", { headers: asToken });
      expect(blocked.statusCode).toBe(429);
    });
  });

  describe("accounts", () => {
    let admin: string;
    let adminUser: UserRecord;
    beforeEach(() => {
      adminUser = t.user("imam");
      admin = t.cookie(adminUser);
    });

    it("lists the organisation's accounts, oldest first, for admins only", async () => {
      vi.setSystemTime(Date.now() + 1000);
      const guest = t.user("guest", "user");
      vi.useRealTimers();
      const list = (await call("GET", "/api/users", { cookie: admin })).json() as UserView[];
      expect(list.map((u) => u.username)).toEqual(["imam", "guest"]);
      expect(list[0]).not.toHaveProperty("passwordHash");
      expect((await call("GET", "/api/users", { cookie: t.cookie(guest) })).statusCode).toBe(403);
      expect((await call("GET", "/api/users", { headers: asToken })).json()).toHaveLength(2);
    });

    it("creates accounts by username or e-mail address", async () => {
      const made = await call("POST", "/api/users", {
        cookie: admin,
        payload: { username: "guest", password: PASSWORD, displayName: "Guest" },
      });
      expect(made.statusCode).toBe(201);
      expect(made.json()).toMatchObject({ username: "guest", role: "user", screens: 0 });
      const byEmail = await call("POST", "/api/users", {
        cookie: admin,
        payload: { email: " Imam.Ali@Example.NL ", password: PASSWORD, role: "admin" },
      });
      expect(byEmail.json()).toMatchObject({ email: "imam.ali@example.nl", role: "admin" });
      expect(byEmail.json().username).toMatch(/^imam\.ali-[0-9a-f]{4}$/);
      const symbols = await call("POST", "/api/users", {
        cookie: admin,
        payload: { email: "__@example.nl", password: PASSWORD },
      });
      expect(symbols.json().username).toMatch(/^user-[0-9a-f]{4}$/);
      for (const [payload, message] of [
        [{ username: "x", password: PASSWORD, role: "owner" }, /^role: /],
        [{ email: "not-an-email", password: PASSWORD }, /^Enter a valid e-mail address$/],
        [{ email: " ", password: PASSWORD }, /^An account needs a username$/],
        [{ username: "short", password: "short" }, /^The password needs at least 8/],
        [{ username: "guest", password: PASSWORD }, /already taken/],
      ] as const) {
        const res = await call("POST", "/api/users", { cookie: admin, payload });
        expect([JSON.stringify(payload), res.json().message]).toEqual([
          JSON.stringify(payload),
          expect.stringMatching(message),
        ]);
      }
    });

    it("changes accounts, but never demotes, disables or re-passwords your own", async () => {
      const guest = t.user("guest", "user");
      const guestCookie = t.cookie(guest);
      const patch = (id: string, payload: Record<string, unknown>, cookie = admin) =>
        call("PATCH", `/api/users/${id}`, { cookie, payload });
      expect((await patch(guest.id, { role: "boss" })).statusCode).toBe(400);
      expect((await patch("nope", { displayName: "x" })).statusCode).toBe(404);
      expect((await patch(adminUser.id, { role: "user" })).statusCode).toBe(409);
      expect((await patch(adminUser.id, { disabled: true })).statusCode).toBe(409);
      expect((await patch(adminUser.id, { password: "another-password-1" })).json().message).toBe(
        "Change your own password from your account menu",
      );
      expect((await patch(adminUser.id, { displayName: "Imam" })).json().displayName).toBe("Imam");
      expect((await patch(adminUser.id, { role: "admin" })).statusCode).toBe(200);
      expect((await patch(guest.id, { password: "short" })).statusCode).toBe(400);
      const renamed = await patch(guest.id, {
        displayName: "Guest",
        password: "another-password-1",
        role: "admin",
        disabled: false,
      });
      expect(renamed.json()).toMatchObject({
        displayName: "Guest",
        role: "admin",
        disabled: false,
      });
      // A new password logs the account out everywhere.
      expect((await call("GET", "/api/auth/me", { cookie: guestCookie })).statusCode).toBe(401);
      // The token may not demote the last admins either.
      await patch(guest.id, { disabled: true });
      const last = await call("PATCH", `/api/users/${adminUser.id}`, {
        headers: asToken,
        payload: { role: "user" },
      });
      expect([last.statusCode, last.json().message]).toEqual([
        409,
        "This is the last enabled admin account; make another admin first",
      ]);
    });

    it("deletes accounts; their screens go to the admin who deleted them", async () => {
      const guest = t.user("guest", "user");
      const screen = await call("POST", "/api/screens", {
        cookie: t.cookie(guest),
        payload: { name: "Guest hall", from: "ar", to: "nl" },
      });
      expect((await call("DELETE", "/api/users/nope", { cookie: admin })).statusCode).toBe(404);
      expect(
        (await call("DELETE", `/api/users/${adminUser.id}`, { cookie: admin })).json().message,
      ).toBe("You cannot delete your own account");
      expect((await call("DELETE", `/api/users/${guest.id}`, { cookie: admin })).statusCode).toBe(
        204,
      );
      expect(t.screens.get(screen.json().id)?.ownerId).toBe(adminUser.id);
      // By the token: the screens have no owner any more (admins only).
      const other = t.user("other", "user");
      const theirs = await call("POST", "/api/screens", {
        cookie: t.cookie(other),
        payload: { name: "Other hall", from: "ar", to: "nl" },
      });
      expect(
        (await call("DELETE", `/api/users/${other.id}`, { headers: asToken })).statusCode,
      ).toBe(204);
      expect(t.screens.get(theirs.json().id)?.ownerId).toBeNull();
      const last = await call("DELETE", `/api/users/${adminUser.id}`, { headers: asToken });
      expect(last.statusCode).toBe(409);
    });
  });

  describe("screens", () => {
    let admin: string;
    let adminUser: UserRecord;
    let guest: UserRecord;
    let guestCookie: string;

    beforeEach(() => {
      adminUser = t.user("imam");
      admin = t.cookie(adminUser);
      guest = t.user("guest", "user");
      guestCookie = t.cookie(guest);
    });

    const create = async (cookie: string, name = "Hall"): Promise<ScreenView> => {
      const res = await call("POST", "/api/screens", {
        cookie,
        payload: { name, from: "ar", to: "nl", query: "?size=40&key=secret&token=t" },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as ScreenView;
    };

    /** A caption page of the screen, ready (or parked when the screen is off). */
    const page = async (screen: ScreenView) => {
      const ws = await openWS(t.app, "/ws/page", { host: LAN_HOST });
      ws.ws.send(JSON.stringify(hello({ screen: { guid: screen.guid } })));
      return ws;
    };

    it("creates screens with their feed links and shows each user their own", async () => {
      const mine = await create(admin);
      expect(mine).toMatchObject({
        name: "Hall",
        query: "size=40",
        enabled: false,
        ownerControl: false,
        owner: { id: adminUser.id, displayName: "imam" },
        url: `http://${LAN_HOST}/feed/${mine.guid}`,
        localUrl: `http://127.0.0.1:8765/feed/${mine.guid}`,
        secureUrl: null,
        live: { pages: 0, sessions: 0, speaking: false, since: null, event: null },
        canControl: true,
        canEdit: true,
        lastChange: { action: "created", by: "imam" },
      });
      vi.setSystemTime(Date.now() + 1000);
      const theirs = await create(guestCookie, "Guest hall");
      vi.useRealTimers();
      expect(theirs).toMatchObject({ canControl: false, canEdit: true });
      const all = (await call("GET", "/api/screens", { cookie: admin })).json() as ScreenView[];
      expect(all.map((s) => s.name)).toEqual(["Guest hall", "Hall"]);
      const own = (
        await call("GET", "/api/screens", { cookie: guestCookie })
      ).json() as ScreenView[];
      expect(own.map((s) => s.name)).toEqual(["Guest hall"]);
      const byToken = await call("POST", "/api/screens", {
        headers: asToken,
        payload: { name: "Token hall", from: "ar", to: "en" },
      });
      expect(byToken.json().owner).toBeNull();
      expect((await call("GET", "/api/screens")).statusCode).toBe(401);
    });

    it("refuses bad screens", async () => {
      for (const [payload, status, message] of [
        [{ name: "Hall", from: "ar" }, 400, /^to: /],
        [{ name: "Hall", from: "ar", to: "nl", query: `a=${"x".repeat(2100)}` }, 400, /too long/],
        [{ name: "Hall", from: "ar", to: "xx" }, 400, /Unknown target language/],
        [{ name: "  ", from: "ar", to: "nl" }, 400, /^A screen needs a name$/],
      ] as const) {
        const res = await call("POST", "/api/screens", { cookie: admin, payload });
        expect([res.statusCode, res.json().message]).toEqual([
          status,
          expect.stringMatching(message),
        ]);
      }
    });

    it("limits how many screens and accounts one address creates per hour", async () => {
      for (let i = 0; i < 60; i++) {
        await call("POST", "/api/screens", {
          cookie: admin,
          payload: { name: `Screen ${i}`, from: "ar", to: "nl" },
        });
      }
      const screen = await call("POST", "/api/screens", {
        cookie: admin,
        payload: { name: "One more", from: "ar", to: "nl" },
      });
      expect(screen.statusCode).toBe(429);
      const account = await call("POST", "/api/users", {
        cookie: admin,
        payload: { username: "late", password: PASSWORD },
      });
      expect(account.statusCode).toBe(429);
    });

    it("shows a screen's owner, change and dates even from an older screens.yaml", async () => {
      const at = "2026-01-01T00:00:00.000Z";
      writeFileSync(
        root.path("screens.yaml"),
        stringify({
          screens: [
            {
              id: "oldscreen1",
              guid: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
              name: "Old",
              ownerId: "gone-user",
              from: "ar",
              to: "nl",
              createdAt: "not a date",
              updatedAt: at,
            },
          ],
        }),
      );
      t.screens.reload(true);
      const [old] = (await call("GET", "/api/screens", { cookie: admin })).json() as ScreenView[];
      expect(old).toMatchObject({
        owner: null,
        createdAt: 0,
        updatedAt: Date.parse(at),
        lastChange: null,
        enabled: false,
      });
    });

    it("edits a screen; a new look reloads its pages at once", async () => {
      const screen = await create(admin);
      await call("POST", `/api/screens/${screen.id}/enable`, { cookie: admin });
      const ws = await page(screen);
      await ws.next("ready");
      const renamed = await call("PATCH", `/api/screens/${screen.id}`, {
        cookie: admin,
        payload: { name: "Main hall" },
      });
      expect(renamed.json()).toMatchObject({ name: "Main hall", lastChange: { action: "edited" } });
      const relooked = await call("PATCH", `/api/screens/${screen.id}`, {
        cookie: admin,
        payload: { query: "size=60" },
      });
      expect(relooked.json().query).toBe("size=60");
      expect(await ws.next("screen")).toEqual({
        type: "screen",
        state: "reload",
        name: "Main hall",
      });
      // The same look again: nothing to reload.
      await call("PATCH", `/api/screens/${screen.id}`, {
        cookie: admin,
        payload: { query: "size=60" },
      });
      expect(ws.messages.filter((m) => m.type === "screen")).toHaveLength(1);
      for (const [payload, status] of [
        [{ name: 5 }, 400],
        [{ query: `a=${"x".repeat(2100)}` }, 400],
        [{ name: " " }, 400],
      ] as const) {
        const res = await call("PATCH", `/api/screens/${screen.id}`, { cookie: admin, payload });
        expect([JSON.stringify(payload), res.statusCode]).toEqual([
          JSON.stringify(payload),
          status,
        ]);
      }
      expect(
        (await call("PATCH", `/api/screens/${screen.id}`, { cookie: guestCookie, payload: {} }))
          .statusCode,
      ).toBe(404);
      expect(
        (await call("PATCH", "/api/screens/nope", { cookie: admin, payload: {} })).statusCode,
      ).toBe(404);
      ws.ws.terminate();
    });

    it("switches a screen on and off, and lets the owner do so only when allowed", async () => {
      const screen = await create(guestCookie);
      const ws = await page(screen);
      expect(await ws.next()).toEqual({ type: "screen", state: "disabled", name: "Hall" });
      const refused = await call("POST", `/api/screens/${screen.id}/enable`, {
        cookie: guestCookie,
      });
      expect([refused.statusCode, refused.json().message]).toEqual([
        403,
        "The admin has not allowed you to switch this screen",
      ]);
      expect(
        (
          await call("POST", `/api/screens/${screen.id}/owner-control`, {
            cookie: guestCookie,
            payload: { allowed: true },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call("POST", `/api/screens/${screen.id}/owner-control`, {
            cookie: admin,
            payload: { allowed: "yes" },
          })
        ).statusCode,
      ).toBe(400);
      const allowed = await call("POST", `/api/screens/${screen.id}/owner-control`, {
        cookie: admin,
        payload: { allowed: true },
      });
      expect(allowed.json()).toMatchObject({ ownerControl: true });
      const on = await call("POST", `/api/screens/${screen.id}/enable`, { cookie: guestCookie });
      expect(on.json()).toMatchObject({
        enabled: true,
        lastChange: { action: "enabled", by: "guest" },
      });
      expect(await ws.next()).toEqual({ type: "screen", state: "enabled", name: "Hall" });
      ws.ws.send(JSON.stringify(hello({ screen: { guid: screen.guid } })));
      const ready = await ws.next("ready");
      const session = t.manager.page(String(ready.sessionId));
      const reset = await call("POST", `/api/screens/${screen.id}/reset`, { cookie: guestCookie });
      expect(reset.json().lastChange.action).toBe("reset");
      expect(session.clears).toEqual(["all"]);
      const off = await call("POST", `/api/screens/${screen.id}/disable`, { cookie: guestCookie });
      expect(off.json()).toMatchObject({ enabled: false });
      expect(await ws.next("screen")).toEqual({ type: "screen", state: "disabled", name: "Hall" });
      expect(session.stopReasons).toEqual(["screen disabled"]);
      ws.ws.terminate();
    });

    it("starts and ends prayer events on a screen's pages", async () => {
      const screen = await create(admin);
      const event = (payload: Record<string, unknown>, cookie = admin) =>
        call("POST", `/api/screens/${screen.id}/event`, { cookie, payload });
      expect((await event({ event: "athan" }, guestCookie)).statusCode).toBe(404);
      expect((await event({ event: "party" })).statusCode).toBe(400);
      const off = await event({ event: "athan" });
      expect([off.statusCode, off.json().message]).toEqual([
        409,
        "This screen is off: switch it on first",
      ]);
      await call("POST", `/api/screens/${screen.id}/enable`, { cookie: admin });
      const nobody = await event({ event: "athan" });
      expect([nobody.statusCode, nobody.json().message]).toEqual([
        409,
        "No screen is showing this feed right now",
      ]);
      const ws = await page(screen);
      const ready = await ws.next("ready");
      const res = await event({ event: "athan" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: screen.id, live: { pages: 1, sessions: 1 } });
      expect(t.manager.page(String(ready.sessionId)).events).toEqual(["athan"]);
      ws.ws.terminate();
    });

    it("refuses events and switches to an owner without control", async () => {
      const screen = await create(guestCookie);
      for (const action of ["event", "disable", "reset"]) {
        const res = await call("POST", `/api/screens/${screen.id}/${action}`, {
          cookie: guestCookie,
          payload: { event: "athan" },
        });
        expect([action, res.statusCode]).toEqual([action, 403]);
      }
    });

    it("regenerates and deletes links: their pages close", async () => {
      const screen = await create(admin);
      await call("POST", `/api/screens/${screen.id}/enable`, { cookie: admin });
      const ws = await page(screen);
      await ws.next("ready");
      const fresh = await call("POST", `/api/screens/${screen.id}/regenerate`, { cookie: admin });
      expect(fresh.json().guid).not.toBe(screen.guid);
      expect(await ws.next("error")).toMatchObject({ code: "screen_invalid" });
      const again = await page(fresh.json() as ScreenView);
      await again.next("ready");
      expect(
        (await call("DELETE", `/api/screens/${screen.id}`, { cookie: admin })).statusCode,
      ).toBe(204);
      expect(await again.next("error")).toMatchObject({ code: "screen_invalid" });
      expect(
        (await call("DELETE", `/api/screens/${screen.id}`, { cookie: admin })).statusCode,
      ).toBe(404);
    });

    it("logs store failures and page failures, and answers 500", async () => {
      const screen = await create(admin);
      const broken = new Error("disk full");
      vi.spyOn(t.screens, "update").mockImplementation(() => {
        throw broken;
      });
      for (const [method, url, payload] of [
        ["PATCH", `/api/screens/${screen.id}`, { name: "x" }],
        ["POST", `/api/screens/${screen.id}/enable`, {}],
        ["POST", `/api/screens/${screen.id}/regenerate`, {}],
        ["POST", `/api/screens/${screen.id}/owner-control`, { allowed: true }],
      ] as const) {
        const res = await call(method, url, { cookie: admin, payload });
        expect([url, res.statusCode, res.json().message]).toEqual([
          url,
          500,
          "Internal server error",
        ]);
      }
      vi.spyOn(t.screens, "update").mockImplementation(() => {
        throw new AccountError(404, "No such screen");
      });
      expect(
        (await call("POST", `/api/screens/${screen.id}/reset`, { cookie: admin })).statusCode,
      ).toBe(404);
      vi.spyOn(t.screens, "remove").mockImplementation(() => {
        throw broken;
      });
      expect(
        (await call("DELETE", `/api/screens/${screen.id}`, { cookie: admin })).statusCode,
      ).toBe(500);
      vi.spyOn(t.screens, "create").mockImplementation(() => {
        throw broken;
      });
      expect(
        (
          await call("POST", "/api/screens", {
            cookie: admin,
            payload: { name: "x", from: "ar", to: "nl" },
          })
        ).statusCode,
      ).toBe(500);
      vi.spyOn(t.users, "insert").mockImplementation(() => {
        throw broken;
      });
      expect(
        (
          await call("POST", "/api/users", {
            cookie: admin,
            payload: { username: "x1", password: PASSWORD },
          })
        ).statusCode,
      ).toBe(500);
      vi.spyOn(t.users, "remove").mockImplementation(() => {
        throw broken;
      });
      expect((await call("DELETE", `/api/users/${guest.id}`, { cookie: admin })).statusCode).toBe(
        500,
      );
      vi.spyOn(t.users, "update").mockImplementation(() => {
        throw broken;
      });
      expect(
        (
          await call("PATCH", `/api/users/${guest.id}`, {
            cookie: admin,
            payload: { displayName: "x" },
          })
        ).statusCode,
      ).toBe(500);
    });

    it("logs it when the pages of a screen could not be told", async () => {
      vi.restoreAllMocks();
      const failure = new Error("pages broke");
      vi.spyOn(PageSockets.prototype, "invalidateScreen").mockRejectedValue(failure);
      vi.spyOn(PageSockets.prototype, "disableScreen").mockRejectedValue(failure);
      await build();
      adminUser = t.user("imam2");
      admin = t.cookie(adminUser);
      const screen = await create(admin);
      await call("POST", `/api/screens/${screen.id}/enable`, { cookie: admin });
      await call("POST", `/api/screens/${screen.id}/disable`, { cookie: admin });
      await call("POST", `/api/screens/${screen.id}/regenerate`, { cookie: admin });
      await call("DELETE", `/api/screens/${screen.id}`, { cookie: admin });
      for (const msg of [
        "portal: stopping the sessions of a screen failed",
        "portal: closing the pages of a screen failed",
        "portal: closing the pages of a deleted screen failed",
      ]) {
        expect([msg, logged(msg) !== undefined]).toEqual([msg, true]);
      }
    });
  });

  it("asks for a login first on every account, screen and settings route", async () => {
    const screen = t.screens.create(
      { name: "Hall", from: "ar", to: "nl", query: "", ownerId: null },
      { id: null, name: "test" },
    );
    for (const [method, url] of [
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", "/api/users/x"],
      ["DELETE", "/api/users/x"],
      ["GET", "/api/screens"],
      ["POST", "/api/screens"],
      ["PATCH", `/api/screens/${screen.id}`],
      ["DELETE", `/api/screens/${screen.id}`],
      ["POST", `/api/screens/${screen.id}/enable`],
      ["POST", `/api/screens/${screen.id}/disable`],
      ["POST", `/api/screens/${screen.id}/reset`],
      ["POST", `/api/screens/${screen.id}/event`],
      ["POST", `/api/screens/${screen.id}/regenerate`],
      ["POST", `/api/screens/${screen.id}/owner-control`],
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings"],
    ] as const) {
      const res = await call(method, url);
      expect([method, url, res.statusCode, res.json().message]).toEqual([
        method,
        url,
        401,
        "Log in first",
      ]);
    }
    // An admin asking about a screen that does not exist.
    const admin = t.cookie(t.user("imam"));
    const missing = await call("POST", "/api/screens/nope/owner-control", {
      cookie: admin,
      payload: { allowed: true },
    });
    expect([missing.statusCode, missing.json().message]).toEqual([404, "No such screen"]);
  });

  describe("feed links", () => {
    it("send an unknown link to the default pair, keeping only short debug options", async () => {
      const res = await call("GET", "/feed/NOT-A-GUID?debug=1&ui=xxxxxxxxxxxxxxxxxxxxxx&ui=b");
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/ar/nl?screen=NOT-A-GUID&debug=1");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("give HTTPS links on the LAN: the request's own, or the HTTPS port's", async () => {
      await build(`${LAN}  trustProxy: true\n  https:\n    port: 8443\n`);
      const admin = t.cookie(t.user("imam"));
      const create = (headers: Record<string, string>) =>
        call("POST", "/api/screens", {
          cookie: admin,
          headers,
          payload: { name: "Hall", from: "ar", to: "nl" },
        }).then((r) => r.json() as ScreenView);
      const viaHttps = await create({ "x-forwarded-proto": "https" });
      expect(viaHttps.secureUrl).toBe(`https://${LAN_HOST}/feed/${viaHttps.guid}`);
      // No certificate yet: no HTTPS link.
      expect((await create({})).secureUrl).toBeNull();
      mkdirSync(root.path("tls"), { recursive: true });
      writeFileSync(root.path("tls", "server.crt"), "x");
      writeFileSync(root.path("tls", "server.key"), "x");
      const v6 = await create({ host: "[fe80::1]:8765" });
      expect(v6.secureUrl).toBe(`https://[fe80::1]:8443/feed/${v6.guid}`);
      const badHost = await create({ host: "bad host" });
      expect(badHost.secureUrl).toBeNull();
      expect(badHost.url).toBe(`http://127.0.0.1:8765/feed/${badHost.guid}`);
    });

    it("give no local link when the server does not listen on this computer's loopback", async () => {
      await build("server:\n  host: 192.168.1.10\n  exposure: lan\n");
      const admin = t.cookie(t.user("imam"));
      const res = await call("POST", "/api/screens", {
        cookie: admin,
        payload: { name: "Hall", from: "ar", to: "nl" },
      });
      expect(res.json()).toMatchObject({ localUrl: null, secureUrl: null });
      await build("server:\n  host: '::'\n  exposure: lan\n");
      const v6 = await call("POST", "/api/screens", {
        cookie: t.cookie(t.user("imam2")),
        payload: { name: "Hall", from: "ar", to: "nl" },
      });
      expect(v6.json().localUrl).toMatch(/^http:\/\/127\.0\.0\.1:8765\/feed\//);
    });
  });

  describe("settings", () => {
    it("shows and saves requireScreen; pages without a screen link are refused at once", async () => {
      const admin = t.cookie(t.user("imam"));
      const guest = t.cookie(t.user("guest", "user"));
      expect((await call("GET", "/api/settings", { cookie: admin })).json()).toEqual({
        requireScreen: false,
      });
      expect((await call("GET", "/api/settings", { cookie: guest })).statusCode).toBe(403);
      expect(
        (await call("PATCH", "/api/settings", { cookie: admin, payload: { requireScreen: "yes" } }))
          .statusCode,
      ).toBe(400);
      const saved = await call("PATCH", "/api/settings", {
        cookie: admin,
        payload: { requireScreen: true },
      });
      expect(saved.json()).toEqual({ requireScreen: true });
      expect(readFileSync(root.path("config.yaml"), "utf8")).toContain("requireScreen: true");
      const ws = await openWS(t.app, "/ws/page", { host: LAN_HOST });
      ws.ws.send(JSON.stringify(hello()));
      expect(await ws.next()).toMatchObject({ type: "error", code: "screen_required" });
    });

    it("says when config.yaml cannot be changed", async () => {
      const admin = t.cookie(t.user("imam"));
      writeFileSync(root.path("config.yaml"), "pages: [broken\n");
      const invalid = await call("PATCH", "/api/settings", {
        cookie: admin,
        payload: { requireScreen: true },
      });
      expect([invalid.statusCode, invalid.json().message]).toEqual([
        400,
        expect.stringMatching(/^Cannot edit /),
      ]);
      writeFileSync(root.path("not-a-dir"), "x");
      t.loaded.paths.configFile = root.path("not-a-dir", "config.yaml");
      const failed = await call("PATCH", "/api/settings", {
        cookie: admin,
        payload: { requireScreen: true },
      });
      expect([failed.statusCode, failed.json().message]).toEqual([
        500,
        "The settings could not be saved to config.yaml",
      ]);
      expect(logged("portal: saving the settings failed")).toBeDefined();
      expect((await call("GET", "/api/settings", { cookie: admin })).json().requireScreen).toBe(
        false,
      );
    });
  });
});

describe("portal in hosted mode", () => {
  const OPERATOR = "operator-token-0123456789abcdef";
  let root: TempRoot;
  let t: TestApp;

  beforeEach(async () => {
    root = new TempRoot("portal-hosted-");
    t = await buildTestApp(
      root,
      `mode: hosted\nhosted:\n  publicUrl: https://turjuman.example\nserver:\n  token: ${OPERATOR}\n`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.app.close();
    root.remove();
  });

  const call = (
    method: Method,
    url: string,
    cookie: string | null,
    payload?: Record<string, unknown>,
  ) =>
    t.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1:8765", ...(cookie === null ? {} : { cookie }) },
      ...(payload === undefined ? {} : { payload }),
    });

  it("logs in by e-mail and sets Secure cookies for an https public address", async () => {
    const org = t.orgs.create({ name: "Masjid" });
    t.user("imam", "owner", { orgId: org.id, email: "imam@x.nl" });
    const wrong = await call("POST", "/api/auth/login", null, {
      username: "imam",
      password: "wrong",
    });
    expect(wrong.json().message).toBe("Wrong e-mail address or password");
    const ok = await call("POST", "/api/auth/login", null, {
      email: "imam@x.nl",
      password: PASSWORD,
    });
    expect(String(ok.headers["set-cookie"])).toContain("; Secure");
  });

  it("caps the accounts of one mosque and never says who uses an address", async () => {
    const org = t.orgs.create({ name: "Masjid" });
    const owner = t.cookie(t.user("owner", "owner", { orgId: org.id, email: "owner@x.nl" }));
    const other = t.orgs.create({ name: "Other" });
    t.user("taken", "user", { orgId: other.id, email: "taken@y.nl" });
    const taken = await call("POST", "/api/users", owner, {
      email: "taken@y.nl",
      password: PASSWORD,
    });
    expect([taken.statusCode, taken.json().message]).toEqual([
      409,
      "This e-mail address can't be used. Ask the person for another one, or contact the server's operator.",
    ]);
    const short = await call("POST", "/api/users", owner, {
      email: "new@x.nl",
      password: "nine-char",
    });
    expect(short.json().message).toBe("The password needs at least 10 characters");
    for (let i = 1; i < 100; i++)
      t.user(`member${i}`, "user", { orgId: org.id, email: `m${i}@x.nl` });
    const full = await call("POST", "/api/users", owner, { email: "one@x.nl", password: PASSWORD });
    expect([full.statusCode, full.json().message]).toEqual([
      409,
      "A mosque can have at most 100 accounts",
    ]);
  });

  it("lets only the owner change the owner's account, and only the operator change settings", async () => {
    const org = t.orgs.create({ name: "Masjid" });
    const ownerUser = t.user("owner", "owner", { orgId: org.id, email: "owner@x.nl" });
    const admin = t.cookie(t.user("admin", "admin", { orgId: org.id, email: "admin@x.nl" }));
    expect((await call("DELETE", `/api/users/${ownerUser.id}`, admin, {})).statusCode).toBe(403);
    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { host: "127.0.0.1:8765", authorization: `Bearer ${OPERATOR}` },
      payload: { requireScreen: true },
    });
    expect(res.json()).toEqual({ requireScreen: true });
  });

  it("logs out the accounts of a deleted organisation", async () => {
    const cookie = t.cookie(t.user("ghost", "owner", { orgId: "deletedorg", email: "g@x.nl" }));
    expect((await call("GET", "/api/auth/me", cookie)).statusCode).toBe(401);
  });
});
