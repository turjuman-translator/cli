// The organisation API: sign-up, the caller's organisation and its usage, its API
// keys (checked, stored encrypted, never returned), and deleting it.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyCheck } from "../../src/accounts/provider-check.js";
import type { UserRecord } from "../../src/accounts/users.js";
import { dayKey, monthKey } from "../../src/core/usage.js";
import { PageSockets } from "../../src/server/page-ws.js";
import type { ScreenView } from "../../src/shared/protocol.js";
import {
  buildTestApp,
  cookieOf,
  hello,
  openWS,
  PASSWORD,
  TempRoot,
  type TestApp,
} from "./helpers/server-fakes.js";

const OPERATOR = "operator-token-0123456789abcdef";
const HOSTED = `mode: hosted\nserver:\n  token: ${OPERATOR}\n`;
const KEY = "soniox-test-key-ABCDEFGH1234";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A month of usage: 60 Soniox minutes for `keyId` today, and an older engine's minutes. */
function writeUsage(root: TempRoot, rows: Record<string, number>): void {
  const now = Date.now();
  const byKey: Record<string, Record<string, number>> = {};
  for (const [keyId, minutes] of Object.entries(rows)) {
    byKey[keyId] = { soniox: minutes * 60_000, gemini: 30 * 60_000 };
  }
  root.write(
    `usage/usage-${monthKey(now)}.json`,
    JSON.stringify({ version: 1, month: monthKey(now), days: { [dayKey(now)]: byKey } }),
  );
}

describe("organisation API", () => {
  let root: TempRoot;
  let t: TestApp;
  let checks: KeyCheck[];

  async function build(
    yaml: string,
    opts: { env?: Record<string, string>; defaultCheck?: boolean } = {},
  ) {
    await t?.app.close();
    t = await buildTestApp(root, yaml, {
      ...(opts.env === undefined ? {} : { env: opts.env }),
      app: {
        checkKey:
          opts.defaultCheck === true ? undefined : async () => checks.shift() ?? { result: "ok" },
      },
    });
  }

  const call = (
    method: Method,
    url: string,
    opts: { cookie?: string; token?: string; payload?: Record<string, unknown>; ip?: string } = {},
  ): Promise<LightMyRequestResponse> =>
    t.app.inject({
      method,
      url,
      headers: {
        host: "127.0.0.1:8765",
        ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
        ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
      },
      remoteAddress: opts.ip ?? "198.51.100.20",
      ...(method === "GET" ? {} : { payload: opts.payload ?? {} }),
    });
  const logged = (msg: string): Record<string, unknown> | undefined =>
    t.lines.find((l) => l.msg === msg);

  beforeEach(() => {
    root = new TempRoot("org-api-");
    checks = [];
    // The keys are sealed with master.key in the temp folder, whatever this shell has set.
    vi.stubEnv("TURJUMAN_MASTER_KEY", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await t?.app.close();
    root.remove();
  });

  describe("local mode", () => {
    it("has no sign-up and one organisation that cannot be deleted", async () => {
      await build("");
      const signup = await call("POST", "/api/auth/signup", { payload: {} });
      expect([signup.statusCode, signup.json().message]).toEqual([
        404,
        "This server has no sign-up: ask its admin for an account",
      ]);
      const admin = t.cookie(t.user("imam"));
      const del = await call("DELETE", "/api/org", {
        cookie: admin,
        payload: { password: PASSWORD },
      });
      expect([del.statusCode, del.json().message]).toEqual([
        404,
        "A local server has one organisation; it cannot be deleted",
      ]);
      for (const [method, url] of [
        ["GET", "/api/org"],
        ["PATCH", "/api/org"],
        ["DELETE", "/api/org"],
        ["PUT", "/api/org/keys/soniox"],
        ["DELETE", "/api/org/keys/soniox"],
      ] as const) {
        const res = await call(method, url);
        expect([method, url, res.statusCode, res.json().message]).toEqual([
          method,
          url,
          401,
          "Log in first",
        ]);
      }
    });

    it("shows the local organisation with the .env key, this month's minutes and their cost", async () => {
      writeUsage(root, { local: 60, k1: 30 });
      await build("", { env: { SONIOX_API_KEY: "env-soniox-key-WXYZ" } });
      const org = await call("GET", "/api/org", { cookie: t.cookie(t.user("imam")) });
      expect(org.headers["cache-control"]).toBe("no-store");
      expect(org.json()).toEqual({
        id: "local",
        name: "Local",
        mode: "local",
        role: "admin",
        keys: {
          soniox: {
            provider: "soniox",
            set: true,
            last4: "WXYZ",
            validatedAt: null,
            source: "env",
          },
        },
        // Every row is the local organisation's; the removed engine's minutes are left out.
        usage: { monthMinutes: 90, estimateUsd: 0.27 },
      });
      const stored = await call("PUT", "/api/org/keys/soniox", {
        token: OPERATOR,
        payload: { key: KEY },
      });
      expect(stored.statusCode).toBe(401);
    });

    it("warns that the .env key wins over a stored one", async () => {
      await build("", { env: { SONIOX_API_KEY: "env-soniox-key-WXYZ" } });
      const admin = t.cookie(t.user("imam"));
      const res = await call("PUT", "/api/org/keys/soniox", {
        cookie: admin,
        payload: { key: KEY },
      });
      expect(res.json()).toMatchObject({
        checked: true,
        status: { source: "env", last4: "WXYZ" },
        warning: "SONIOX_API_KEY in the server's .env is used while it is set",
      });
    });

    it("checks a key with Soniox by default: a malformed one never leaves the server", async () => {
      await build("", { defaultCheck: true });
      const admin = t.cookie(t.user("imam"));
      const res = await call("PUT", "/api/org/keys/soniox", {
        cookie: admin,
        payload: { key: "short" },
      });
      expect([res.statusCode, res.json().message]).toEqual([400, "This key is too short."]);
      expect(logged("portal: key rejected")).toMatchObject({ provider: "soniox", user: "imam" });
    });

    it("renames the organisation (admins only)", async () => {
      await build("");
      const admin = t.cookie(t.user("imam"));
      const member = t.cookie(t.user("guest", "user"));
      expect(
        (await call("PATCH", "/api/org", { cookie: member, payload: { name: "X" } })).statusCode,
      ).toBe(403);
      expect(
        (await call("PATCH", "/api/org", { cookie: admin, payload: { name: 5 } })).statusCode,
      ).toBe(400);
      const blank = await call("PATCH", "/api/org", { cookie: admin, payload: { name: "  " } });
      expect([blank.statusCode, blank.json().message]).toEqual([
        400,
        "Give your mosque or organisation a name",
      ]);
      const renamed = await call("PATCH", "/api/org", {
        cookie: admin,
        payload: { name: "Masjid Noor" },
      });
      expect(renamed.json()).toMatchObject({ id: "local", name: "Masjid Noor" });
    });

    it("answers 404 for an account whose organisation has no record", async () => {
      await build("");
      const stray = t.cookie(t.user("stray", "admin", { orgId: "elsewhere" }));
      expect((await call("GET", "/api/org", { cookie: stray })).json()).toEqual({
        ok: false,
        message: "No such organisation",
      });
    });

    it("says so when the master key is unusable or orgs.yaml cannot be written", async () => {
      await build("");
      const admin = t.cookie(t.user("imam"));
      writeFileSync(root.path("master.key"), "not a key\n");
      const sealed = await call("PUT", "/api/org/keys/soniox", {
        cookie: admin,
        payload: { key: KEY },
      });
      expect([sealed.statusCode, sealed.json().message]).toEqual([
        500,
        "This server cannot store keys: its master key is not valid",
      ]);
      expect(logged("portal: the master key is unusable")).toBeDefined();
      rmSync(root.path("master.key"));
      writeFileSync(root.path("orgs.yaml"), "orgs: [broken\n");
      for (const method of ["PUT", "DELETE"] as const) {
        const res = await call(method, "/api/org/keys/soniox", {
          cookie: admin,
          payload: { key: KEY },
        });
        expect([method, res.statusCode]).toEqual([method, 500]);
      }
      expect(
        (await call("PATCH", "/api/org", { cookie: admin, payload: { name: "X" } })).statusCode,
      ).toBe(500);
    });
  });

  describe("hosted mode", () => {
    beforeEach(async () => {
      await build(HOSTED);
    });

    const signup = (payload: Record<string, unknown>, ip = "198.51.100.30") =>
      call("POST", "/api/auth/signup", { payload, ip });
    const form = (email: string, extra: Record<string, unknown> = {}) => ({
      orgName: "Masjid Noor",
      name: "Imam Ali",
      email,
      password: PASSWORD,
      ...extra,
    });

    async function owner(email = "owner@noor.nl"): Promise<{ cookie: string; user: UserRecord }> {
      const res = await signup(form(email));
      expect(res.statusCode).toBe(201);
      const user = t.users.byEmail(email);
      if (user === undefined) throw new Error("no owner");
      return { cookie: cookieOf(res), user };
    }

    it("refuses incomplete sign-ups without counting them", async () => {
      expect((await signup({ email: "x@y.nl" })).statusCode).toBe(400);
      const noName = await signup(form("a@noor.nl", { name: " " }));
      expect([noName.statusCode, noName.json().message]).toEqual([400, "Enter your name"]);
      for (let i = 0; i < 6; i++) expect((await signup(form("bad"))).statusCode).toBe(400);
      await owner();
    });

    it("rolls a half-made sign-up back when the account cannot be stored", async () => {
      writeFileSync(root.path("users.yaml"), "users: [broken\n");
      const res = await signup(form("a@noor.nl"));
      expect([res.statusCode, res.json().message]).toEqual([500, "Internal server error"]);
      expect(t.orgs.list()).toEqual([]);
      writeFileSync(root.path("orgs.yaml"), "orgs: [broken\n");
      expect((await signup(form("b@noor.nl"))).statusCode).toBe(500);
    });

    it("signs up even when the login time cannot be recorded", async () => {
      vi.spyOn(t.users, "update").mockImplementation(() => {
        throw new Error("read-only");
      });
      expect((await signup(form("a@noor.nl"))).statusCode).toBe(201);
      expect(logged("portal: could not record the login time")).toBeDefined();
    });

    it("counts only the organisation's own minutes", async () => {
      await t.app.close();
      writeUsage(root, { "org:someone-else": 120 });
      await build(HOSTED);
      const { cookie, user } = await owner();
      await t.app.close();
      writeUsage(root, { [`org:${user.orgId}`]: 30, "org:someone-else": 120 });
      await build(HOSTED);
      const org = (await call("GET", "/api/org", { cookie })).json();
      expect(org.usage).toEqual({ monthMinutes: 30, estimateUsd: 0.09 });
      // The operator's token acts for the (implicit) local organisation.
      expect((await call("GET", "/api/org", { token: OPERATOR })).json()).toMatchObject({
        id: "local",
        role: "admin",
      });
    });

    it("stores a key unchecked when Soniox cannot be reached, and removes keys", async () => {
      const { cookie } = await owner();
      checks = [
        { result: "unchecked", message: "Soniox could not be reached; the key was not checked." },
      ];
      const res = await call("PUT", "/api/org/keys/soniox", { cookie, payload: { key: KEY } });
      expect(res.json()).toMatchObject({
        checked: false,
        status: { set: true, source: "stored", last4: "1234", validatedAt: null },
        warning: "Soniox could not be reached; the key was not checked.",
      });
      expect(readFileSync(root.path("orgs.yaml"), "utf8")).not.toContain(KEY);
      expect((await call("PUT", "/api/org/keys/soniox", { cookie, payload: {} })).statusCode).toBe(
        400,
      );
      expect((await call("DELETE", "/api/org/keys/gemini", { cookie })).statusCode).toBe(404);
      // The operator's token stores keys for the local organisation, by no account.
      const byToken = await call("PUT", "/api/org/keys/soniox", {
        token: OPERATOR,
        payload: { key: KEY },
      });
      expect(byToken.json().status).toMatchObject({ set: true, last4: "1234" });
      expect(t.orgs.get("local")?.keyMeta.soniox?.addedBy).toBeNull();
      const removed = await call("DELETE", "/api/org/keys/soniox", { cookie });
      expect(removed.json()).toEqual({
        status: { provider: "soniox", set: false, last4: null, validatedAt: null, source: null },
      });
    });

    it("limits key checks to 20 per hour per organisation, whatever the address", async () => {
      const { cookie } = await owner();
      for (let i = 0; i < 20; i++) {
        const res = await call("PUT", "/api/org/keys/soniox", {
          cookie,
          payload: { key: `${KEY}${i}` },
          ip: `203.0.113.${i + 1}`,
        });
        expect(res.statusCode).toBe(200);
      }
      const over = await call("PUT", "/api/org/keys/soniox", {
        cookie,
        payload: { key: KEY },
        ip: "203.0.113.99",
      });
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers["retry-after"])).toBeGreaterThanOrEqual(60);
      // That address's attempt was not counted against it: it may check another mosque's key.
      const other = await owner("other@x.nl");
      const res = await call("PUT", "/api/org/keys/soniox", {
        cookie: other.cookie,
        payload: { key: KEY },
        ip: "203.0.113.99",
      });
      expect(res.statusCode).toBe(200);
    });

    it("deletes the organisation: its screens, pages, presets, accounts and keys", async () => {
      const { cookie, user } = await owner();
      await call("PUT", "/api/org/keys/soniox", { cookie, payload: { key: KEY } });
      await call("POST", "/api/presets", {
        cookie,
        payload: { preset: { id: "hall", name: "Hall" } },
      });
      const screen = (
        await call("POST", "/api/screens", {
          cookie,
          payload: { name: "Hall", from: "ar", to: "nl" },
        })
      ).json() as ScreenView;
      await call("POST", `/api/screens/${screen.id}/enable`, { cookie });
      await t.app.ready();
      const page = await openWS(t.app, "/ws/page");
      page.ws.send(JSON.stringify(hello({ screen: { guid: screen.guid } })));
      const session = t.manager.page(String((await page.next("ready")).sessionId));
      const preview = await openWS(t.app, "/ws/page", { host: "127.0.0.1:8765", cookie });
      preview.ws.send(JSON.stringify(hello({ to: "en" })));
      await preview.next("ready");

      expect(
        (
          await call("DELETE", "/api/org", { token: OPERATOR, payload: { password: PASSWORD } })
        ).json(),
      ).toEqual({
        ok: false,
        message: "Only the owner can delete the organisation",
      });
      expect((await call("DELETE", "/api/org", { cookie, payload: {} })).statusCode).toBe(400);
      const res = await call("DELETE", "/api/org", { cookie, payload: { password: PASSWORD } });
      expect(res.statusCode).toBe(204);
      expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
      expect(await page.next("error")).toMatchObject({ code: "screen_invalid" });
      expect(await preview.next("error")).toEqual({
        type: "error",
        code: "unauthorized",
        message: "This organisation was deleted",
      });
      expect(session.stopReasons).toContain("screen link revoked");
      expect(t.users.inOrg(user.orgId)).toEqual([]);
      expect(t.screens.inOrg(user.orgId)).toEqual([]);
      expect(t.orgs.get(user.orgId)).toBeUndefined();
      expect(readFileSync(root.path("presets.yaml"), "utf8")).not.toContain("hall");
      expect((await call("GET", "/api/auth/me", { cookie })).statusCode).toBe(401);
    });

    it("refuses to delete while presets.yaml has problems, and logs store failures", async () => {
      const { cookie } = await owner();
      writeFileSync(root.path("presets.yaml"), "presets: 5\n");
      const blocked = await call("DELETE", "/api/org", { cookie, payload: { password: PASSWORD } });
      expect([blocked.statusCode, blocked.json().message]).toEqual([
        409,
        "The server cannot delete this organisation right now; contact its operator",
      ]);
      expect(logged("portal: org delete refused, presets.yaml has problems")).toBeDefined();
      writeFileSync(root.path("presets.yaml"), "presets: []\n");
      vi.spyOn(t.users, "removeOrg").mockImplementation(() => {
        throw new Error("disk full");
      });
      const failed = await call("DELETE", "/api/org", { cookie, payload: { password: PASSWORD } });
      expect(failed.statusCode).toBe(500);
    });

    it("blocks password guesses at the delete, and logs failures to stop the pages", async () => {
      vi.spyOn(PageSockets.prototype, "invalidateScreen").mockRejectedValue(new Error("x"));
      vi.spyOn(PageSockets.prototype, "stopOrg").mockRejectedValue(new Error("y"));
      await build(HOSTED);
      const { cookie } = await owner();
      await call("POST", "/api/screens", {
        cookie,
        payload: { name: "Hall", from: "ar", to: "nl" },
      });
      for (let i = 0; i < 10; i++) {
        const res = await call("DELETE", "/api/org", {
          cookie,
          payload: { password: "wrong-password" },
        });
        expect([i, res.statusCode]).toEqual([i, 403]);
      }
      const blocked = await call("DELETE", "/api/org", { cookie, payload: { password: PASSWORD } });
      expect(blocked.statusCode).toBe(429);
      const ok = await call("DELETE", "/api/org", {
        cookie,
        payload: { password: PASSWORD },
        ip: "198.51.100.99",
      });
      expect(ok.statusCode).toBe(204);
      await new Promise((r) => setImmediate(r));
      expect(logged("portal: closing a deleted screen's pages failed")).toBeDefined();
      expect(logged("portal: stopping a deleted organisation's sessions failed")).toBeDefined();
    });
  });
});
