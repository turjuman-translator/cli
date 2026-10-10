import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SigningSecret } from "../../src/accounts/secret.js";
import { usersCommand } from "../../src/cli/users.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";
import type { SessionManagerApi } from "../../src/core/contracts.js";
import { buildApp } from "../../src/server/app.js";

const PASSWORD = "test-account-password";
const proxyHeaders = {
  host: "turjuman.nl",
  origin: "https://turjuman.nl",
  "x-forwarded-host": "turjuman.nl",
  "x-forwarded-proto": "https",
  "x-forwarded-for": "203.0.113.10",
};

describe("public admin accounts without an admin token", () => {
  let root: string;
  let loaded: LoadedConfig;
  let app: FastifyInstance;

  async function build(): Promise<FastifyInstance> {
    const manager: SessionManagerApi = {
      createPage: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      local: vi.fn(() => null),
      startLocal: vi.fn(),
      stopLocal: vi.fn(),
      subscribeMonitor: vi.fn(),
      health: vi.fn(),
      stopAll: vi.fn(),
    };
    return buildApp({
      loaded,
      manager,
      log: pino({ level: "silent" }),
      publicDir: join(root, "public"),
      version: "test",
      secret: new SigningSecret(loaded.paths.secretFile, ""),
    });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "admin-login-"));
    for (const dir of ["public/assets", "public/fonts"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    for (const page of ["picker", "control", "login", "admin"]) {
      writeFileSync(join(root, "public", `${page}.html`), `<!doctype html><title>${page}</title>`);
    }
    writeFileSync(
      join(root, "config.yaml"),
      `server:\n  exposure: public\n  trustProxy: true\nlanguagesFile: ${join(process.cwd(), "languages.yaml")}\n`,
    );
    // A public server generates its token; this one has none, as when its file is broken.
    writeFileSync(join(root, "admin.token"), "");
    loaded = loadConfig({ env: { CONFIG_DIR: root, DATA_DIR: root }, cwd: root });
    expect(loaded.config.server.token).toBe("");
    expect(loaded.warnings).toContain(
      `No admin token: ${join(root, "admin.token")} holds no valid admin token; delete it to make a new one`,
    );
    app = await build();
  });

  afterEach(async () => {
    await app?.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  async function addAccount(username: string, admin = true): Promise<void> {
    const code = await usersCommand(
      ["add", username, ...(admin ? ["--admin"] : [])],
      { out: vi.fn(), err: vi.fn() },
      loaded,
      { readPassword: async () => PASSWORD },
    );
    expect(code).toBe(0);
  }

  async function login(username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: proxyHeaders,
      payload: { username, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    return cookie.split(";")[0] ?? "";
  }

  it("serves the public domain but refuses remote first-admin registration", async () => {
    expect((await app.inject({ url: "/", headers: proxyHeaders })).statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: proxyHeaders,
      payload: { username: "admin", password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("turjuman users add");
    expect(response.json().message).not.toContain("admin token");
    expect((await app.inject("/api/auth/state")).json().setupRequired).toBe(true);
  });

  it("keeps admin endpoints protected when no token is configured", async () => {
    for (const url of ["/api/users", "/api/sessions", "/control"]) {
      for (const credentials of [{}, { authorization: "Bearer arbitrary-token" }]) {
        const response = await app.inject({
          url,
          headers: { ...proxyHeaders, ...credentials },
        });
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain("use the admin token");
      }
      expect((await app.inject({ url: `${url}?token=`, headers: proxyHeaders })).statusCode).toBe(
        401,
      );
    }
  });

  it("accepts an admin created through the CLI and remembers the login across a restart", async () => {
    await addAccount("admin");
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: proxyHeaders,
      payload: { username: "admin", password: "wrong-password" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    const cookie = await login("admin");
    const headers = { ...proxyHeaders, cookie };
    for (const url of ["/api/users", "/api/sessions", "/control"]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(200);
    }
    await app.close();
    app = await build();
    expect((await app.inject({ url: "/api/users", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/me", headers })).json().me.role).toBe("admin");
  });

  it("allows regular users to log in without granting admin access", async () => {
    await addAccount("admin");
    await addAccount("viewer", false);
    const headers = { ...proxyHeaders, cookie: await login("viewer") };
    expect((await app.inject({ url: "/api/auth/me", headers })).statusCode).toBe(200);
    for (const url of ["/api/users", "/api/sessions", "/control"]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
    }
  });

  it("rejects cross-origin admin changes and modified login cookies", async () => {
    await addAccount("admin");
    const cookie = await login("admin");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...proxyHeaders, cookie, origin: "https://unrelated.example" },
      payload: { requireScreen: true },
    });
    expect(response.statusCode).toBe(403);
    const forged = await app.inject({
      url: "/api/users",
      headers: { ...proxyHeaders, cookie: `${cookie}invalid` },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("still accepts an explicitly configured admin token for automation", async () => {
    await app.close();
    loaded.config.server.token = "configured-admin-token";
    app = await build();
    for (const url of ["/api/users", "/api/sessions"]) {
      const response = await app.inject({
        url,
        headers: { ...proxyHeaders, authorization: "Bearer configured-admin-token" },
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
