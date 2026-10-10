import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/accounts/passwords.js";
import { SigningSecret } from "../../src/accounts/secret.js";
import { UserStore } from "../../src/accounts/users.js";
import { loadConfig } from "../../src/config.js";
import type { SessionManagerApi } from "../../src/core/contracts.js";
import { buildApp } from "../../src/server/app.js";
import type { ScreenView } from "../../src/shared/protocol.js";

const LAN = { host: "192.168.1.10:8765" };
const PASSWORD = "a-long-password-123";

/** Local mode on the LAN: which feed links the dashboard gets for OBS and for other devices. */
describe("feed links for this computer and for other devices (local mode)", () => {
  let root: string;
  let app: FastifyInstance;

  async function build(extra = "", env: Record<string, string> = {}): Promise<FastifyInstance> {
    writeFileSync(
      join(root, "config.yaml"),
      `server:\n  host: 0.0.0.0\n  exposure: lan\n${extra}languagesFile: ${join(process.cwd(), "languages.yaml")}\n`,
    );
    const loaded = loadConfig({ env: { CONFIG_DIR: root, DATA_DIR: root, ...env }, cwd: root });
    new UserStore(loaded.paths.usersFile).insert({
      username: "imam",
      role: "admin",
      passwordHash: await hashPassword(PASSWORD),
    });
    const manager = { list: vi.fn(() => []), get: vi.fn() } as unknown as SessionManagerApi;
    return buildApp({
      loaded,
      manager,
      log: pino({ level: "silent" }),
      publicDir: join(root, "public"),
      version: "test",
      secret: new SigningSecret(loaded.paths.secretFile, ""),
    });
  }

  async function screenAs(headers: Record<string, string>): Promise<ScreenView> {
    const login: LightMyRequestResponse = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers,
      payload: { username: "imam", password: PASSWORD },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const res = await app.inject({
      method: "POST",
      url: "/api/screens",
      headers: { ...headers, cookie },
      payload: { name: "Hall", from: "ar", to: "nl", query: "" },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as ScreenView;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "screen-links-"));
    mkdirSync(join(root, "public", "assets"), { recursive: true });
    mkdirSync(join(root, "public", "fonts"), { recursive: true });
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("gives the 127.0.0.1 link for OBS on this computer, and no HTTPS link without a certificate", async () => {
    app = await build();
    const screen = await screenAs(LAN);
    expect(screen.url).toBe(`http://192.168.1.10:8765/feed/${screen.guid}`);
    expect(screen.localUrl).toBe(`http://127.0.0.1:8765/feed/${screen.guid}`);
    expect(screen.secureUrl).toBeNull();
  });

  it("uses the ports Docker publishes on this computer (another instance on 8780/8781)", async () => {
    mkdirSync(join(root, "tls"));
    writeFileSync(join(root, "tls", "server.crt"), "test");
    writeFileSync(join(root, "tls", "server.key"), "test");
    app = await build("  https:\n    port: 8443\n", {
      CAPTIONS_HTTP_PORT: "8780",
      CAPTIONS_HTTPS_PORT: "8781",
    });
    const screen = await screenAs({ host: "192.168.1.10:8780" });
    expect(screen.localUrl).toBe(`http://127.0.0.1:8780/feed/${screen.guid}`);
    expect(screen.secureUrl).toBe(`https://192.168.1.10:8781/feed/${screen.guid}`);
  });

  it("gives the HTTPS link on the same host when the LAN certificate is in place", async () => {
    mkdirSync(join(root, "tls"));
    writeFileSync(join(root, "tls", "server.crt"), "test");
    writeFileSync(join(root, "tls", "server.key"), "test");
    app = await build("  https:\n    port: 8443\n");
    const screen = await screenAs(LAN);
    expect(screen.secureUrl).toBe(`https://192.168.1.10:8443/feed/${screen.guid}`);
  });

  it("offers no HTTPS link for other devices while exposure is local", async () => {
    mkdirSync(join(root, "tls"));
    writeFileSync(join(root, "tls", "server.crt"), "test");
    writeFileSync(join(root, "tls", "server.key"), "test");
    writeFileSync(
      join(root, "config.yaml"),
      `server:\n  https:\n    port: 8443\nlanguagesFile: ${join(process.cwd(), "languages.yaml")}\n`,
    );
    const loaded = loadConfig({ env: { CONFIG_DIR: root, DATA_DIR: root }, cwd: root });
    new UserStore(loaded.paths.usersFile).insert({
      username: "imam",
      role: "admin",
      passwordHash: await hashPassword(PASSWORD),
    });
    const manager = { list: vi.fn(() => []), get: vi.fn() } as unknown as SessionManagerApi;
    app = await buildApp({
      loaded,
      manager,
      log: pino({ level: "silent" }),
      publicDir: join(root, "public"),
      version: "test",
      secret: new SigningSecret(loaded.paths.secretFile, ""),
    });
    const screen = await screenAs({ host: "127.0.0.1:8765" });
    expect(screen.localUrl).toBe(`http://127.0.0.1:8765/feed/${screen.guid}`);
    expect(screen.secureUrl).toBeNull();
  });

  it("keeps ?debug= and ?ui= of a feed link (setting a screen up), nothing else", async () => {
    app = await build();
    const screen = await screenAs(LAN);
    const res = await app.inject({
      method: "GET",
      url: `/feed/${screen.guid}?debug=1&ui=show&engine=gemini`,
      headers: LAN,
    });
    expect(res.statusCode).toBe(302);
    const target = new URL(String(res.headers.location), "http://x");
    expect(target.pathname).toBe("/ar/nl");
    expect(target.searchParams.get("screen")).toBe(screen.guid);
    expect(target.searchParams.get("debug")).toBe("1");
    expect(target.searchParams.get("ui")).toBe("show");
    expect(target.searchParams.get("engine")).toBeNull();
    const plain = await app.inject({ method: "GET", url: `/feed/${screen.guid}`, headers: LAN });
    expect(String(plain.headers.location)).toBe(`/ar/nl?screen=${screen.guid}`);
  });

  it("serves the app icon at /favicon.ico, and says how to make the CA when there is none", async () => {
    writeFileSync(join(root, "public", "assets", "icon-192-TEST1234.png"), "png bytes");
    app = await build();
    const icon = await app.inject({ method: "GET", url: "/favicon.ico", headers: LAN });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.body).toBe("png bytes");
    const ca = await app.inject({ method: "GET", url: "/ca.crt", headers: LAN });
    expect(ca.statusCode).toBe(404);
    expect(ca.body).toMatch(/on the server run bash scripts\/lan-cert\.sh /);
  });

  it("records the login time of the first admin made in the app", async () => {
    writeFileSync(
      join(root, "config.yaml"),
      `languagesFile: ${join(process.cwd(), "languages.yaml")}\n`,
    );
    const loaded = loadConfig({ env: { CONFIG_DIR: root, DATA_DIR: root }, cwd: root });
    const manager = { list: vi.fn(() => []), get: vi.fn() } as unknown as SessionManagerApi;
    app = await buildApp({
      loaded,
      manager,
      log: pino({ level: "silent" }),
      publicDir: join(root, "public"),
      version: "test",
      secret: new SigningSecret(loaded.paths.secretFile, ""),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "imam", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(new UserStore(loaded.paths.usersFile).byUsername("imam")?.lastLoginAt).not.toBeNull();
  });
});
