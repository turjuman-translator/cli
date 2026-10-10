import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyCheck } from "../../src/accounts/provider-check.js";
import { SigningSecret } from "../../src/accounts/secret.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";
import type { SessionManagerApi } from "../../src/core/contracts.js";
import { buildApp } from "../../src/server/app.js";
import type { KeyProvider } from "../../src/shared/protocol.js";

const PASSWORD = "a-long-password-123";
const SONIOX = "soniox-secret-key-ABCDEFGH1234";
const TOKEN = "operator-token-0123456789";
const HOST = { host: "127.0.0.1:8765" };

function signup(email: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { orgName: "Masjid An-Nour", name: "Imam Ali", email, password: PASSWORD, ...extra };
}

describe("hosted mode: sign-up, organisations, keys and scoping", () => {
  let root: string;
  let loaded: LoadedConfig;
  let app: FastifyInstance;
  let checks: KeyCheck[];
  const checkKey = vi.fn(async (_provider: KeyProvider, _key: string): Promise<KeyCheck> => {
    return checks.shift() ?? { result: "ok" };
  });

  async function build(signupMode = "open"): Promise<FastifyInstance> {
    writeFileSync(
      join(root, "config.yaml"),
      `mode: hosted\nhosted:\n  signup: ${signupMode}\nserver:\n  token: ${TOKEN}\nlanguagesFile: ${join(process.cwd(), "languages.yaml")}\n`,
    );
    loaded = loadConfig({
      env: { CONFIG_DIR: root, DATA_DIR: root, SONIOX_API_KEY: "server-env-soniox-key" },
      cwd: root,
    });
    const manager: SessionManagerApi = {
      createPage: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      local: vi.fn(() => null),
      startLocal: vi.fn(),
      stopLocal: vi.fn(),
      subscribeMonitor: vi.fn(),
      health: vi.fn(() => ({
        ok: true as const,
        version: "test",
        uptimeMs: 1,
        exposure: "local" as const,
        local: null,
        sessions: [{ id: "s1", keyLabel: "screen: Hall of another mosque" } as never],
      })),
      stopAll: vi.fn(),
    };
    return buildApp({
      loaded,
      manager,
      log: pino({ level: "silent" }),
      publicDir: join(root, "public"),
      version: "test",
      secret: new SigningSecret(loaded.paths.secretFile, ""),
      checkKey,
    });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hosted-"));
    for (const dir of ["public/assets", "public/fonts"])
      mkdirSync(join(root, dir), { recursive: true });
    for (const page of ["picker", "control", "login", "admin", "signup", "customize"]) {
      writeFileSync(join(root, "public", `${page}.html`), `<!doctype html><title>${page}</title>`);
    }
    checks = [];
    checkKey.mockClear();
    app = await build();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const cookieOf = (res: LightMyRequestResponse): string =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";

  async function newOrg(email: string, ip = "198.51.100.1"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: HOST,
      remoteAddress: ip,
      payload: signup(email),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().me.role).toBe("owner");
    return cookieOf(res);
  }

  const get = (url: string, cookie?: string): Promise<LightMyRequestResponse> =>
    app.inject({ url, headers: { ...HOST, ...(cookie === undefined ? {} : { cookie }) } });
  const send = (
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    cookie: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url,
      headers: { ...HOST, cookie },
      ...(payload === undefined ? {} : { payload }),
    });

  it("reports the mode and refuses the first-admin setup", async () => {
    expect((await get("/api/auth/state")).json()).toEqual({
      setupRequired: false,
      mode: "hosted",
      signup: true,
      loggedIn: false,
    });
    // With a login cookie the state says so (pages then ask /api/auth/me; without, they don't).
    const cookie = await newOrg("state@example.nl");
    expect((await get("/api/auth/state", cookie)).json().loggedIn).toBe(true);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: HOST,
      payload: { username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(404);
  });

  it("validates sign-ups and logs the owner in by e-mail", async () => {
    const bad = async (payload: Record<string, unknown>, status = 400): Promise<string> => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        headers: HOST,
        payload,
      });
      expect(res.statusCode).toBe(status);
      return String(res.json().message);
    };
    expect(await bad(signup("not-an-email"))).toContain("e-mail");
    expect(await bad(signup("a@b.nl", { password: "short-pw1" }))).toContain("10");
    expect(await bad(signup("a@b.nl", { orgName: "  " }))).toContain("mosque");
    expect(await bad(signup("a@b.nl", { website: "http://spam" }))).toBe("Sign-up failed");
    const cookie = await newOrg("Imam@Example.NL");
    const me = (await get("/api/auth/me", cookie)).json().me;
    expect(me).toMatchObject({ email: "imam@example.nl", role: "owner", displayName: "Imam Ali" });
    expect(await bad(signup("imam@example.nl"), 409)).toContain("exists");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: HOST,
      payload: { username: "IMAM@example.nl", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: HOST,
      payload: { email: "imam@example.nl", password: "wrong-password-1" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().message).toBe("Wrong e-mail address or password");
  });

  it("allows 5 sign-ups per address per hour", async () => {
    for (let i = 0; i < 5; i++) await newOrg(`imam${i}@example.nl`, "203.0.113.9");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: HOST,
      remoteAddress: "203.0.113.9",
      payload: signup("imam9@example.nl"),
    });
    expect(res.statusCode).toBe(429);
    await newOrg("elsewhere@example.nl", "203.0.113.10");
  });

  it("closed sign-up is refused", async () => {
    await app.close();
    app = await build("closed");
    expect((await get("/api/auth/state")).json().signup).toBe(false);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: HOST,
      payload: signup("a@b.nl"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("stores keys encrypted after checking them; never returns them", async () => {
    const cookie = await newOrg("imam@example.nl");
    let org = (await get("/api/org", cookie)).json();
    expect(org).toMatchObject({ mode: "hosted", role: "owner", name: "Masjid An-Nour" });
    expect(Object.keys(org.keys)).toEqual(["soniox"]);
    expect(org.keys.soniox).toMatchObject({ set: false, source: null });
    // The server's own .env key is never an organisation's key in hosted mode.
    expect(org.keys.soniox.last4).toBeNull();

    checks = [{ result: "rejected", message: "Soniox did not accept this key (HTTP 401)." }];
    let res = await send("PUT", "/api/org/keys/soniox", cookie, { key: SONIOX });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("did not accept");
    expect((await get("/api/org", cookie)).json().keys.soniox.set).toBe(false);

    res = await send("PUT", "/api/org/keys/soniox", cookie, { key: ` ${SONIOX} ` });
    expect(res.statusCode).toBe(200);
    expect(checkKey).toHaveBeenLastCalledWith("soniox", SONIOX);
    expect(res.json()).toMatchObject({ checked: true, status: { set: true, last4: "1234" } });
    expect(res.body).not.toContain(SONIOX);
    org = (await get("/api/org", cookie)).json();
    expect(org.keys.soniox).toMatchObject({ set: true, source: "stored", last4: "1234" });
    expect(org.keys.soniox.validatedAt).not.toBeNull();
    expect(JSON.stringify(org)).not.toContain(SONIOX);
    expect(readFileSync(join(root, "orgs.yaml"), "utf8")).not.toContain(SONIOX);

    checks = [
      { result: "unchecked", message: "Soniox could not be reached; the key was not checked." },
    ];
    res = await send("PUT", "/api/org/keys/soniox", cookie, { key: `${SONIOX}-2` });
    expect(res.json()).toMatchObject({
      checked: false,
      warning: expect.stringContaining("not checked"),
    });
    expect((await get("/api/org", cookie)).json().keys.soniox).toMatchObject({
      set: true,
      validatedAt: null,
    });

    // Mutating portal requests are JSON only (CSRF), DELETE included.
    expect((await send("DELETE", "/api/org/keys/soniox", cookie)).statusCode).toBe(415);
    res = await send("DELETE", "/api/org/keys/soniox", cookie, {});
    expect(res.json().status.set).toBe(false);
    expect((await send("PUT", "/api/org/keys/unknown", cookie, { key: SONIOX })).statusCode).toBe(
      404,
    );
    // The removed Gemini engine has no key any more.
    expect((await send("PUT", "/api/org/keys/gemini", cookie, { key: SONIOX })).statusCode).toBe(
      404,
    );
  });

  it("keeps organisations apart: accounts, screens, presets, keys", async () => {
    const a = await newOrg("a@example.nl");
    const b = await newOrg("b@example.nl", "198.51.100.2");
    let res = await send("POST", "/api/screens", a, {
      name: "Hall",
      from: "ar",
      to: "nl",
      query: "",
    });
    expect(res.statusCode).toBe(201);
    const screen = res.json();
    const guid = String(screen.url).split("/feed/")[1];
    // Hosted feed links are the public address only (no 127.0.0.1 or LAN variants).
    expect(screen.localUrl).toBeNull();
    expect(screen.secureUrl).toBeNull();

    expect((await get("/api/screens", b)).json()).toEqual([]);
    for (const [method, url] of [
      ["PATCH", `/api/screens/${screen.id}`],
      ["DELETE", `/api/screens/${screen.id}`],
      ["POST", `/api/screens/${screen.id}/enable`],
      ["POST", `/api/screens/${screen.id}/regenerate`],
    ] as const) {
      expect((await send(method, url, b, method === "PATCH" ? { name: "x" } : {})).statusCode).toBe(
        404,
      );
    }
    const aUsers = (await get("/api/users", a)).json();
    expect(aUsers.map((u: { email: string }) => u.email)).toEqual(["a@example.nl"]);
    const bUser = (await get("/api/users", b)).json()[0];
    expect(
      (await send("PATCH", `/api/users/${bUser.id}`, a, { displayName: "x" })).statusCode,
    ).toBe(404);

    // A member added by an owner belongs to the owner's organisation and logs in by e-mail.
    res = await send("POST", "/api/users", a, { email: "member@example.nl", password: PASSWORD });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "member@example.nl", role: "user" });
    expect(
      (await send("POST", "/api/users", a, { username: "nomail", password: PASSWORD })).statusCode,
    ).toBe(400);

    res = await send("POST", "/api/presets", a, { id: "hall-look", name: "Hall look" });
    expect(res.statusCode).toBe(201);
    expect((await get("/api/presets", b)).json().custom).toEqual([]);
    expect((await get("/api/presets", a)).json().custom.map((p: { id: string }) => p.id)).toEqual([
      "hall-look",
    ]);
    // A caption page of A's screen sees A's presets; a page without a link or login sees none.
    expect((await get(`/api/presets?screen=${guid}`)).json().custom).toHaveLength(1);
    expect((await get("/api/presets")).json().custom).toEqual([]);
    expect((await send("DELETE", "/api/presets/hall-look", b)).statusCode).toBe(404);

    await send("PUT", "/api/org/keys/soniox", a, { key: SONIOX });
    expect((await get("/api/org", b)).json().keys.soniox.set).toBe(false);
  });

  it("organisation logins never reach the operator's routes", async () => {
    const cookie = await newOrg("imam@example.nl");
    for (const url of ["/api/sessions", "/control", "/overlay"]) {
      expect((await get(url, cookie)).statusCode).toBe(403);
    }
    expect((await get("/api/sessions")).statusCode).toBe(401);
    const operator = await app.inject({
      url: "/api/sessions",
      headers: { ...HOST, authorization: `Bearer ${TOKEN}` },
    });
    expect(operator.statusCode).toBe(200);
    expect((await send("PATCH", "/api/settings", cookie, { requireScreen: true })).statusCode).toBe(
      403,
    );
    expect((await get("/customize", cookie)).statusCode).toBe(200);
    // /health stays open (Docker's health check); its session list is the operator's only.
    const health = await get("/health", cookie);
    expect(health.statusCode).toBe(200);
    expect(health.json().sessions).toEqual([]);
    const full = await app.inject({
      url: "/health",
      headers: { ...HOST, authorization: `Bearer ${TOKEN}` },
    });
    expect(full.json().sessions).toHaveLength(1);
  });

  it("sends a bad language pair to the builder (in hosted mode / is the website)", async () => {
    const res = await get("/ar/xx");
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toMatch(/^\/app\/new\?error=/);
  });

  it("limits key checks, screens per mosque, and own-password changes without the current one", async () => {
    const cookie = await newOrg("limits@example.nl");
    const puts: number[] = [];
    for (let i = 0; i < 21; i++) {
      puts.push(
        (await send("PUT", "/api/org/keys/soniox", cookie, { key: `${SONIOX}${i}` })).statusCode,
      );
    }
    expect(puts.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(puts[20]).toBe(429);
    const me = (await get("/api/auth/me", cookie)).json().me;
    const own = await send("PATCH", `/api/users/${me.id}`, cookie, {
      password: "another-password-1",
    });
    expect(own.statusCode).toBe(403);
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/screens",
        headers: { ...HOST, cookie },
        remoteAddress: `198.51.100.${(i % 200) + 1}`,
        payload: { name: `Screen ${i}`, from: "ar", to: "nl", query: "" },
      });
      expect(res.statusCode).toBe(201);
    }
    const over = await send("POST", "/api/screens", cookie, {
      name: "One too many",
      from: "ar",
      to: "nl",
      query: "",
    });
    expect(over.statusCode).toBe(409);
  });

  it("only the owner deletes the organisation, with the password", async () => {
    const owner = await newOrg("owner@example.nl");
    await send("POST", "/api/users", owner, {
      email: "admin@example.nl",
      password: PASSWORD,
      role: "admin",
    });
    const admin = cookieOf(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: HOST,
        payload: { username: "admin@example.nl", password: PASSWORD },
      }),
    );
    const ownerId = (await get("/api/auth/me", owner)).json().me.id;
    expect(
      (await send("PATCH", `/api/users/${ownerId}`, admin, { disabled: true })).statusCode,
    ).toBe(403);
    expect((await send("DELETE", "/api/org", admin, { password: PASSWORD })).statusCode).toBe(403);
    expect(
      (await send("DELETE", "/api/org", owner, { password: "wrong-password-1" })).statusCode,
    ).toBe(403);
    expect((await send("DELETE", "/api/org", owner, { password: PASSWORD })).statusCode).toBe(204);
    expect((await get("/api/auth/me", admin)).statusCode).toBe(401);
    expect(readFileSync(join(root, "users.yaml"), "utf8")).not.toContain("owner@example.nl");
  });

  it("logs out the accounts of a disabled organisation", async () => {
    const cookie = await newOrg("imam@example.nl");
    const orgId = (await get("/api/auth/me", cookie)).json().me.orgId;
    const file = join(root, "orgs.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("disabled: false", "disabled: true"));
    expect((await get("/api/auth/me", cookie)).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: HOST,
      payload: { username: "imam@example.nl", password: PASSWORD },
    });
    expect(login.statusCode).toBe(403);
    expect(orgId).toMatch(/^[a-z2-7]{10}$/);
  });
});
