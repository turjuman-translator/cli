import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/accounts/passwords.js";
import { SigningSecret } from "../../src/accounts/secret.js";
import { UserStore } from "../../src/accounts/users.js";
import { loadConfig } from "../../src/config.js";
import type { AudioInputApi, EngineFactory } from "../../src/core/contracts.js";
import { SessionManager } from "../../src/core/sessions.js";
import { buildApp } from "../../src/server/app.js";
import type { ProviderState, TrackId } from "../../src/shared/protocol.js";
import type { ProviderEvent, SttProvider } from "../../src/stt/types.js";

const PASSWORD = "a-long-password-123";

class SilentProvider implements SttProvider {
  readonly capabilities = {
    nativeTranslation: true,
    timing: "arrival" as const,
    translationFinalAtEndpoint: true,
  };
  state: ProviderState = "idle";
  constructor(readonly track: TrackId) {}
  async start(opts: { onEvent: (e: ProviderEvent) => void }): Promise<void> {
    this.state = "live";
    opts.onEvent({ type: "state", state: "live" });
  }
  sendAudio(): void {}
  finalize(): void {}
  async stop(): Promise<void> {
    this.state = "idle";
  }
}

const engineFactory: EngineFactory = (req) => ({ provider: new SilentProvider(req.track) });
const noInput = (): AudioInputApi => {
  throw new Error("no local audio");
};

function hello(): string {
  return JSON.stringify({
    type: "hello",
    protocol: 1,
    from: "ar",
    to: "nl",
    engine: "soniox",
    translation: "native",
    resume: null,
    client: { obs: false, ua: "test" },
    format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
    layout: "rollup",
  });
}

/** The first JSON message of a page socket (ready or error). */
function firstMessage(url: string, cookie?: string): Promise<{ type: string; code?: string }> {
  const ws = new WebSocket(url, {
    headers: cookie === undefined ? {} : { cookie },
  } as WebSocketInit);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => ws.send(hello()));
    ws.addEventListener("message", (ev) => {
      resolve(JSON.parse(String(ev.data)) as { type: string; code?: string });
      ws.close();
    });
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
}

describe("caption pages on the LAN in local mode: a login stands in for an access key", () => {
  let root: string;
  let app: FastifyInstance;
  let manager: SessionManager;
  let port = 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "page-login-"));
    for (const d of ["public/assets", "public/fonts"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(
      join(root, "config.yaml"),
      `server:\n  exposure: lan\npages:\n  savePageSessions: false\nlanguagesFile: ${join(process.cwd(), "languages.yaml")}\n`,
    );
    const loaded = loadConfig({
      env: { CONFIG_DIR: root, DATA_DIR: root, SONIOX_API_KEY: "fake-soniox-key" },
      cwd: root,
    });
    new UserStore(loaded.paths.usersFile).insert({
      username: "imam",
      role: "admin",
      passwordHash: await hashPassword(PASSWORD),
    });
    const log = pino({ level: "silent" });
    manager = new SessionManager({
      loaded,
      engineFactory,
      audioInputFactory: noInput,
      log,
      version: "test",
    });
    app = await buildApp({
      loaded,
      manager,
      log,
      publicDir: join(root, "public"),
      version: "test",
      secret: new SigningSecret(loaded.paths.secretFile, ""),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    await app.close();
    await manager.stopAll("test done");
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses an anonymous page but accepts a logged-in one", async () => {
    const url = `ws://127.0.0.1:${port}/ws/page`;
    expect(await firstMessage(url)).toMatchObject({ type: "error", code: "unauthorized" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: `127.0.0.1:${port}` },
      payload: { username: "imam", password: PASSWORD },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    expect(await firstMessage(url, cookie)).toMatchObject({ type: "ready" });
  });
});
