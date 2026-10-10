// Who may open what: the admin token,
// access keys and logins on the LAN and behind a proxy, failure limits, CSRF and JSON-only
// bodies, the protected overlay, and hosted mode's organisations.
import { writeFileSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyStore } from "../../src/auth/keys.js";
import type { SessionManagerApi } from "../../src/core/contracts.js";
import {
  buildTestApp,
  FakeSession,
  fakeBlock,
  openWS,
  TempRoot,
  type TestApp,
} from "./helpers/server-fakes.js";

const TOKEN = "lan-admin-token-0123456789abcdef";
const LAN_HOST = "192.168.1.10:8765";
const LAN = `server:\n  host: 0.0.0.0\n  exposure: lan\n  token: ${TOKEN}\n`;

function writeArchive(root: TempRoot, id: string, orgId?: string): void {
  const dir = `transcripts/2026-10-02_1300_${id}`;
  root.write(
    `${dir}/session.jsonl`,
    `${JSON.stringify({ t: 1, type: "start", kind: "page", from: "ar", to: "nl", orgId })}\n`,
  );
  root.write(`${dir}/blocks.jsonl`, `${JSON.stringify(fakeBlock(id, 0))}\n`);
}

describe("app access on the LAN (admin token, access keys, logins)", () => {
  let root: TempRoot;
  let t: TestApp;
  let accessKey: string;

  const req = (
    url: string,
    opts: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      headers?: Record<string, string>;
      payload?: Record<string, unknown>;
      ip?: string;
    } = {},
  ): Promise<LightMyRequestResponse> =>
    t.app.inject({
      method: opts.method ?? "GET",
      url,
      headers: { host: LAN_HOST, ...opts.headers },
      remoteAddress: opts.ip ?? "192.168.1.50",
      ...(opts.payload === undefined ? {} : { payload: opts.payload }),
    });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    root = new TempRoot("app-access-");
    accessKey = new KeyStore(root.path("keys.yaml")).add({ label: "Hall" }).key;
    writeArchive(root, "arch2345");
    t = await buildTestApp(root, LAN);
  });

  afterEach(async () => {
    await t.app.close();
    root.remove();
  });

  it("needs the admin token or an admin login for the admin API and tools", async () => {
    const api = await req("/api/sessions");
    expect(api.statusCode).toBe(401);
    expect(api.headers["www-authenticate"]).toBe('Bearer realm="captions"');
    expect(api.json().message).toBe(
      "Admin login required: log in at /login as an admin, or use the admin token (Authorization: Bearer <token> or ?token=)",
    );
    const page = await req("/control");
    expect([page.statusCode, page.headers["content-type"]]).toEqual([
      401,
      "text/plain; charset=utf-8",
    ]);
    expect((await req("/api/sessions", { headers: bearer(TOKEN) })).statusCode).toBe(200);
    expect((await req(`/control?token=${TOKEN}`)).statusCode).toBe(200);
    const admin = t.cookie(t.user("imam"));
    expect((await req("/control", { headers: { cookie: admin } })).statusCode).toBe(200);
    const member = t.cookie(t.user("guest", "user"));
    const refused = await req("/api/sessions", { headers: { cookie: member } });
    expect([refused.statusCode, refused.json().message]).toEqual([
      403,
      "Only an admin account can open this",
    ]);
    const refusedPage = await req("/control", { headers: { cookie: member } });
    expect([refusedPage.statusCode, refusedPage.body]).toEqual([
      403,
      "Only an admin account can open this\n",
    ]);
    // A percent-encoded path cannot slip past the check.
    expect([401, 404]).toContain(
      (await req("/%61pi/session/stop", { method: "POST", payload: {} })).statusCode,
    );
    // The overlay is open unless protectOverlay is on; the picker's API too.
    expect((await req("/overlay")).statusCode).toBe(200);
    expect((await req("/api/languages")).json().keyRequired).toBe(true);
  });

  it("counts wrong tokens and blocks the address after 10, with Retry-After", async () => {
    for (let i = 0; i < 5; i++) await req("/api/sessions", { headers: bearer(`wrong-${i}`) });
    // A right token forgets the failures.
    expect((await req("/api/sessions", { headers: bearer(TOKEN) })).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) {
      expect((await req("/api/sessions", { headers: bearer(`wrong-${i}`) })).statusCode).toBe(401);
    }
    expect((await req("/api/sessions", { headers: bearer("wrong-again") })).statusCode).toBe(401);
    const blocked = await req("/api/sessions", { headers: bearer(TOKEN) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("600");
    expect(blocked.json().message).toBe("Too many failed attempts; try again later");
    const blockedPage = await req("/control", { headers: bearer(TOKEN) });
    expect([blockedPage.statusCode, blockedPage.body]).toEqual([
      429,
      "Too many failed attempts; try again later\n",
    ]);
    // Another address is not affected.
    expect(
      (await req("/api/sessions", { headers: bearer(TOKEN), ip: "192.168.1.51" })).statusCode,
    ).toBe(200);
  });

  it("does not count requests that present no credential at all", async () => {
    for (let i = 0; i < 15; i++) expect((await req("/api/sessions")).statusCode).toBe(401);
    expect((await req("/api/sessions", { headers: bearer(TOKEN) })).statusCode).toBe(200);
    for (let i = 0; i < 15; i++) {
      expect((await req("/api/sessions/arch2345/blocks")).statusCode).toBe(401);
    }
    expect((await req(`/api/sessions/arch2345/blocks?key=${accessKey}`)).statusCode).toBe(200);
  });

  it("opens the session history with an access key, the token or any login", async () => {
    const none = await req("/api/sessions/arch2345/blocks");
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toBe('Bearer realm="captions"');
    expect(none.json().message).toBe(
      "Access key required: add ?key=… to the URL or log in at /login, or use the admin token",
    );
    expect((await req("/api/sessions/arch2345/blocks?key=not-a-key")).statusCode).toBe(401);
    for (const headers of [
      bearer(accessKey),
      bearer(TOKEN),
      { cookie: t.cookie(t.user("guest", "user")) },
    ]) {
      expect((await req("/api/sessions/arch2345/blocks", { headers })).statusCode).toBe(200);
    }
    expect((await req(`/api/sessions/arch2345/export.md?key=${accessKey}`)).statusCode).toBe(200);
    // The archive page itself holds no data: open (it asks for a key).
    expect((await req("/s/arch2345")).statusCode).toBe(200);
    // Writes need the admin token; an access key is not enough.
    const event = await req("/api/sessions/all/event", {
      method: "POST",
      headers: bearer(accessKey),
      payload: { event: "athan" },
    });
    expect(event.statusCode).toBe(401);
  });

  it("keeps preset reads open and writes for the admin", async () => {
    expect((await req("/api/presets")).statusCode).toBe(200);
    const preset = { preset: { id: "hall", name: "Hall" } };
    expect((await req("/api/presets", { method: "POST", payload: preset })).statusCode).toBe(401);
    const created = await req("/api/presets", {
      method: "POST",
      payload: preset,
      headers: bearer(TOKEN),
    });
    expect(created.statusCode).toBe(201);
    // DELETE outside the portal API needs no JSON body.
    expect((await req("/api/presets/hall", { method: "DELETE" })).statusCode).toBe(401);
    const deleted = await req("/api/presets/hall", { method: "DELETE", headers: bearer(TOKEN) });
    expect(deleted.statusCode).toBe(200);
  });

  it("refuses mutating API requests from another origin (CSRF), and non-JSON portal changes", async () => {
    const auth = bearer(TOKEN);
    for (const origin of ["https://evil.example", "null", "ftp://192.168.1.10:8765"]) {
      const res = await req("/api/session/stop", {
        method: "POST",
        headers: { ...auth, origin },
        payload: {},
      });
      expect([origin, res.statusCode, res.json().message]).toEqual([
        origin,
        403,
        "Cross-origin requests are not allowed",
      ]);
    }
    expect(t.lines.some((l) => l.msg === "cross-origin API request refused")).toBe(true);
    const same = await req("/api/session/stop", {
      method: "POST",
      headers: { ...auth, origin: `http://${LAN_HOST}` },
      payload: {},
    });
    expect(same.statusCode).toBe(409);
    const badHost = await req("/api/session/stop", {
      method: "POST",
      headers: { ...auth, origin: "http://a.test", host: "bad host" },
      payload: {},
    });
    expect(badHost.statusCode).toBe(403);
    // Reads are not checked.
    expect(
      (await req("/api/sessions", { headers: { ...auth, origin: "https://x.test" } })).statusCode,
    ).toBe(200);
    const cookie = t.cookie(t.user("imam"));
    const patch = await t.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { host: LAN_HOST, cookie },
      payload: "requireScreen=true",
    });
    expect(patch.statusCode).toBe(415);
  });

  it("speaks of the admin token only when there is one", async () => {
    await t.app.close();
    // A token is generated for exposure lan; without one (its file is broken) it is not offered.
    writeFileSync(root.path("admin.token"), "");
    t = await buildTestApp(root, "server:\n  host: 0.0.0.0\n  exposure: lan\n");
    expect(t.loaded.config.server.token).toBe("");
    const admin = await req("/api/sessions", { headers: bearer("guess") });
    expect(admin.statusCode).toBe(401);
    expect(admin.headers["www-authenticate"]).toBeUndefined();
    expect(admin.json().message).toBe("Admin login required: log in at /login as an admin");
    const viewer = await req("/api/sessions/arch2345/blocks");
    expect(viewer.headers["www-authenticate"]).toBe('Bearer realm="captions"');
    expect(viewer.json().message).toBe(
      "Access key required: add ?key=… to the URL or log in at /login",
    );
  });
});

describe("app access behind a proxy with a protected overlay", () => {
  let root: TempRoot;
  let t: TestApp;

  beforeEach(async () => {
    root = new TempRoot("app-proxy-");
    t = await buildTestApp(
      root,
      `server:\n  exposure: public\n  trustProxy: true\n  protectOverlay: true\n  token: ${TOKEN}\n`,
    );
    await t.app.ready();
  });

  afterEach(async () => {
    await t.app.close();
    root.remove();
  });

  it("needs the token for /overlay and /ws", async () => {
    const forwarded = {
      host: "127.0.0.1:8765",
      "x-forwarded-host": "captions.example",
      "x-forwarded-proto": "https",
    };
    expect((await t.app.inject({ url: "/overlay", headers: forwarded })).statusCode).toBe(401);
    const page = await t.app.inject({ url: `/overlay?token=${TOKEN}`, headers: forwarded });
    expect(page.statusCode).toBe(200);
    expect(String(page.headers["content-security-policy"])).toContain("wss://captions.example");
    await expect(openWS(t.app, "/ws")).rejects.toThrow(/401/);
    const ws = await openWS(t.app, `/ws?token=${TOKEN}`);
    expect(await ws.next()).toMatchObject({ type: "hello" });
    ws.ws.terminate();
  });
});

describe("app access in hosted mode", () => {
  const OPERATOR = "operator-token-0123456789abcdef";
  let root: TempRoot;
  let t: TestApp;

  beforeEach(async () => {
    root = new TempRoot("app-hosted-");
    t = await buildTestApp(root, `mode: hosted\nserver:\n  token: ${OPERATOR}\n`);
  });

  afterEach(async () => {
    await t.app.close();
    root.remove();
  });

  const get = (url: string, headers: Record<string, string> = {}, ip = "198.51.100.7") =>
    t.app.inject({ url, headers: { host: "127.0.0.1:8765", ...headers }, remoteAddress: ip });

  it("shows a session's history only to its own organisation (or the operator)", async () => {
    const a = t.orgs.create({ name: "Masjid A" });
    const b = t.orgs.create({ name: "Masjid B" });
    const alice = t.cookie(t.user("alice", "user", { orgId: a.id, email: "alice@a.nl" }));
    const bob = t.cookie(t.user("bob", "admin", { orgId: b.id, email: "bob@b.nl" }));
    writeArchive(root, "archa234", a.id);
    writeArchive(root, "arold234");
    t.manager.add(new FakeSession("livea", "page"), a.id);
    t.manager.add(new FakeSession("local1", "device"));
    for (const [url, cookie, status] of [
      ["/api/sessions/archa234/blocks", alice, 200],
      ["/api/sessions/archa234/blocks", bob, 401],
      ["/api/sessions/livea/blocks", alice, 200],
      ["/api/sessions/livea/export.txt", bob, 401],
      ["/api/sessions/arold234/blocks", alice, 401],
      ["/api/sessions/local1/blocks", alice, 401],
      ["/api/sessions/nope2345/blocks", alice, 401],
    ] as const) {
      expect([url, (await get(url, { cookie })).statusCode]).toEqual([url, status]);
    }
    // Access keys do not apply on a hosted server; the operator's token does.
    const key = new KeyStore(root.path("keys.yaml")).add({ label: "x" }).key;
    expect((await get(`/api/sessions/archa234/blocks?key=${key}`)).statusCode).toBe(401);
    expect((await get(`/api/sessions/archa234/blocks?token=${OPERATOR}`)).statusCode).toBe(200);
    expect((await get("/api/languages")).json().keyRequired).toBe(false);
  });

  it("files sessions from before organisations existed, and sessions the manager cannot place, under local", async () => {
    const local = t.cookie(t.user("old", "admin", { orgId: "local", email: "old@x.nl" }));
    writeArchive(root, "arold234");
    t.manager.add(new FakeSession("local1", "device"));
    (t.manager as SessionManagerApi).orgOf = undefined;
    expect((await get("/api/sessions/arold234/blocks", { cookie: local })).statusCode).toBe(200);
    expect((await get("/api/sessions/local1/blocks", { cookie: local })).statusCode).toBe(200);
  });

  it("refuses an organisation's login on the operator's routes", async () => {
    const org = t.orgs.create({ name: "Masjid" });
    const cookie = t.cookie(t.user("imam", "owner", { orgId: org.id, email: "imam@x.nl" }));
    const res = await get("/api/sessions", { cookie });
    expect([res.statusCode, res.json().message]).toEqual([
      403,
      "Only the server's operator can open this",
    ]);
  });

  it("does not let /health guess the operator's token", async () => {
    t.manager.add(new FakeSession("s1", "page"));
    for (let i = 0; i < 10; i++) {
      expect(
        (await get("/health", { authorization: `Bearer wrong-${i}` })).json().sessions,
      ).toEqual([]);
    }
    // Blocked: even the right token shows no sessions now.
    expect((await get("/health", { authorization: `Bearer ${OPERATOR}` })).json().sessions).toEqual(
      [],
    );
    const other = await get("/health", { authorization: `Bearer ${OPERATOR}` }, "198.51.100.8");
    expect(other.json().sessions).toHaveLength(1);
  });

  it("scopes presets: a screen's page sees its organisation's, a write needs an admin login", async () => {
    const org = t.orgs.create({ name: "Masjid" });
    const admin = t.cookie(t.user("imam", "owner", { orgId: org.id, email: "imam@x.nl" }));
    const member = t.cookie(t.user("guest", "user", { orgId: org.id, email: "guest@x.nl" }));
    const send = (method: "POST" | "DELETE", url: string, cookie?: string) =>
      t.app.inject({
        method,
        url,
        headers: { host: "127.0.0.1:8765", ...(cookie === undefined ? {} : { cookie }) },
        payload: method === "POST" ? { preset: { id: "hall", name: "Hall" } } : {},
      });
    expect((await send("POST", "/api/presets")).json()).toEqual({
      ok: false,
      message: "Log in first",
    });
    const memberWrite = await send("POST", "/api/presets", member);
    expect([memberWrite.statusCode, memberWrite.json().message]).toEqual([
      403,
      "Only an admin can change presets",
    ]);
    expect((await send("DELETE", "/api/presets/hall", member)).statusCode).toBe(403);
    expect((await send("POST", "/api/presets", admin)).statusCode).toBe(201);
    const screen = t.screens.create(
      { name: "Hall", from: "ar", to: "nl", query: "", ownerId: null, orgId: org.id },
      { id: null, name: "test" },
    );
    expect(
      (await get(`/api/presets?screen=${screen.guid.toUpperCase()}`)).json().custom,
    ).toHaveLength(1);
    // An unknown screen falls back to the login, else to none.
    const unknown = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    expect(
      (await get(`/api/presets?screen=${unknown}`, { cookie: member })).json().custom,
    ).toHaveLength(1);
    expect((await get(`/api/presets?screen=${unknown}`)).json().custom).toEqual([]);
    expect((await get("/api/presets?screen=")).json().custom).toEqual([]);
    expect((await send("DELETE", "/api/presets/hall")).statusCode).toBe(401);
    expect((await send("DELETE", "/api/presets/hall", admin)).statusCode).toBe(200);
  });
});
