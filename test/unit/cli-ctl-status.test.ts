import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CTL_HELP, ctlCommand } from "../../src/cli/ctl.js";
import { apiEnv, callApi, messageOf, serviceUrl } from "../../src/cli/http.js";
import { runCli } from "../../src/cli/index.js";
import { formatHealth, statusCommand } from "../../src/cli/status.js";
import type { LoadedConfig } from "../../src/config.js";
import type { SessionManagerApi } from "../../src/core/contracts.js";
import { buildApp } from "../../src/server/app.js";
import type { Health, SessionInfo, SessionSummary, Status } from "../../src/shared/protocol.js";
import { capture, configured, freePort, removeTempDirs, tempDir } from "./helpers/cli-env.js";

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Reply = { status: number; body?: string };

/** A stand-in for the Turjuman server: records each request and answers from `routes`. */
async function fakeServer(
  routes: Record<string, Reply | ((seen: Seen) => Reply)>,
): Promise<{ port: number; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      };
      seen.push(entry);
      const route = routes[`${entry.method} ${entry.url}`];
      const reply = typeof route === "function" ? route(entry) : route;
      res.statusCode = reply?.status ?? 404;
      res.end(reply?.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(status: number, value: unknown): Reply {
  return { status, body: JSON.stringify(value) };
}

/** The CLI's view of a config whose server listens on `port`. */
function onPort(port: number, yaml = ""): LoadedConfig {
  return configured(`server:\n  port: ${port}\n${yaml}`).loaded;
}

const latency = { p50Ms: 1200, p95Ms: 2600, n: 14 };

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    kind: "page",
    from: "ar",
    to: "nl",
    engines: ["soniox"],
    keyLabel: "Main hall",
    startedAt: 0,
    durationMs: 754_000,
    streamedMinutes: 12.345,
    latency,
    state: "live",
    ...over,
  };
}

function localStatus(over: Partial<Status> = {}): Status {
  return {
    state: "live",
    primary: "soniox",
    provider: "live",
    audio: { state: "ok", rmsDbfs: -23.44, lastFrameAgoMs: 20, noSignal: false },
    latency,
    tracks: [
      {
        track: "soniox",
        active: true,
        provider: "live",
        latency: { source: latency, translation: latency },
        vadLatency: null,
        costUsd: 0,
        segments: 3,
      },
    ],
    session: {
      id: "loc1",
      kind: "device",
      from: "ar",
      to: "nl",
      inputKind: "device",
      startedAt: 0,
    } as Status["session"],
    ...over,
  };
}

beforeEach(() => {
  // The caller's shell must not point the CLI elsewhere or add a token.
  for (const name of ["TOKEN", "CAPTIONS_TOKEN", "CAPTIONS_URL"]) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDirs();
});

describe("serviceUrl and apiEnv", () => {
  it("talks to the configured port on loopback, or to CAPTIONS_URL without its trailing slash", () => {
    const loaded = onPort(9123);
    expect(serviceUrl(loaded, {})).toBe("http://127.0.0.1:9123");
    expect(serviceUrl(null, {})).toBe("http://127.0.0.1:8765");
    expect(serviceUrl(loaded, { CAPTIONS_URL: "http://box:8000/" })).toBe("http://box:8000");
    expect(serviceUrl(loaded, { CAPTIONS_URL: "" })).toBe("http://127.0.0.1:9123");
  });

  it("uses server.token as TOKEN unless the environment gives one", () => {
    const withToken = onPort(9123, "  token: from-config\n");
    expect(apiEnv(withToken, {}).TOKEN).toBe("from-config");
    expect(apiEnv(withToken, { TOKEN: "" }).TOKEN).toBe("from-config");
    expect(apiEnv(withToken, { TOKEN: "mine" }).TOKEN).toBe("mine");
    expect(apiEnv(withToken, { CAPTIONS_TOKEN: "theirs" })).toEqual({ CAPTIONS_TOKEN: "theirs" });
    expect(apiEnv(onPort(9123), {})).toEqual({});
    expect(apiEnv(null, { A: "1" })).toEqual({ A: "1" });
  });

  it("messageOf reads message, then error, else the JSON or the text", () => {
    expect(messageOf({ message: "done", error: "no" })).toBe("done");
    expect(messageOf({ error: "Bad Request" })).toBe("Bad Request");
    expect(messageOf({ ok: true })).toBe('{"ok":true}');
    expect(messageOf("plain text")).toBe("plain text");
    expect(messageOf(null)).toBe("");
    expect(messageOf(undefined)).toBe("");
  });
});

describe("callApi", () => {
  it("sends the token, JSON for POSTs, and parses JSON, text and empty answers", async () => {
    const server = await fakeServer({
      "GET /json": json(200, { a: 1 }),
      "GET /text": { status: 500, body: "Internal trouble" },
      "POST /empty": { status: 204 },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await callApi(base, "GET", "/json", undefined, { CAPTIONS_TOKEN: "t1" })).toEqual({
        ok: true,
        status: 200,
        body: { a: 1 },
      });
      expect(server.seen[0]).toMatchObject({ authorization: "Bearer t1", body: "" });
      expect(server.seen[0]?.contentType).toBeUndefined();
      expect(await callApi(base, "GET", "/text", undefined, {})).toEqual({
        ok: false,
        status: 500,
        body: "Internal trouble",
      });
      expect(server.seen[1]?.authorization).toBeUndefined();
      expect(await callApi(base, "POST", "/empty", undefined, { TOKEN: "t2" })).toEqual({
        ok: true,
        status: 204,
        body: null,
      });
      expect(server.seen[2]).toMatchObject({
        method: "POST",
        authorization: "Bearer t2",
        contentType: "application/json",
        body: "{}",
      });
    } finally {
      await server.close();
    }
  });
});

describe("turjuman ctl", () => {
  let server: Awaited<ReturnType<typeof fakeServer>>;
  let loaded: LoadedConfig;

  async function start(routes: Parameters<typeof fakeServer>[0], yaml = ""): Promise<void> {
    server = await fakeServer(routes);
    loaded = onPort(server.port, yaml);
  }

  afterEach(async () => {
    await server?.close();
  });

  it("starts the local session from the device, or from a file", async () => {
    await start({
      "POST /api/session/start": (seen) =>
        json(200, { ok: true, message: `started with ${seen.body}` }),
    });
    const c = capture();
    expect(await ctlCommand(["start"], c.io, loaded)).toBe(0);
    expect(await ctlCommand(["start", "--file", "khutbah.wav"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([
      'started with {"source":"device"}',
      'started with {"source":"file","file":"khutbah.wav"}',
    ]);
    expect(server.seen.map((s) => s.contentType)).toEqual(["application/json", "application/json"]);
  });

  it("says ok for an empty answer and reports an HTTP error with exit code 1", async () => {
    await start({
      "POST /api/captions/clear": { status: 200 },
      "POST /api/session/stop": json(500, { ok: false, message: "the engine hung" }),
    });
    const c = capture();
    expect(await ctlCommand(["clear"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual(["ok"]);
    expect(server.seen[0]?.body).toBe("{}");
    expect(await ctlCommand(["stop"], c.io, loaded)).toBe(1);
    expect(c.err).toEqual(["HTTP 500: the engine hung"]);
  });

  it("treats a 409 on stop as nothing to stop", async () => {
    await start({ "POST /api/session/stop": json(409, { ok: false, message: "not running" }) });
    const c = capture();
    expect(await ctlCommand(["stop"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual(["Nothing to stop: not running"]);
    expect(c.err).toEqual([]);
  });

  it("stops one session by id, escaping it in the path", async () => {
    await start({
      "POST /api/sessions/a%2Fb%20c/stop": json(200, {
        ok: true,
        message: "Stopped session a/b c",
      }),
      "POST /api/sessions/gone/stop": json(404, { ok: false, message: "No session gone" }),
    });
    const c = capture();
    expect(await ctlCommand(["kill", "a/b c"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual(["Stopped session a/b c"]);
    expect(await ctlCommand(["kill", "gone"], c.io, loaded)).toBe(1);
    expect(c.err).toEqual(["HTTP 404: No session gone"]);
  });

  it("lists active sessions one per line", async () => {
    const list = [
      summary(),
      summary({ id: "s2", kind: "device", keyLabel: undefined, durationMs: 59_600 }),
    ];
    await start({ "GET /api/sessions": json(200, list) });
    const c = capture();
    expect(await ctlCommand(["sessions"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([
      "s1  page  ar→nl  soniox  Main hall  754 s  12.3 min  live",
      "s2  device  ar→nl  soniox  -  60 s  12.3 min  live",
    ]);
  });

  it("says so when no session runs (an answer that is not a list counts as none)", async () => {
    await start({ "GET /api/sessions": json(200, []) });
    const c = capture();
    expect(await ctlCommand(["sessions"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual(["No active sessions."]);
    await server.close();
    await start({ "GET /api/sessions": json(200, { sessions: "?" }) });
    c.clear();
    expect(await ctlCommand(["sessions"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual(["No active sessions."]);
  });

  it("reports a refused session list (wrong token) with exit code 1", async () => {
    await start({ "GET /api/sessions": json(401, { error: "Unauthorized" }) });
    const c = capture();
    expect(await ctlCommand(["sessions"], c.io, loaded)).toBe(1);
    expect(c.err).toEqual(["HTTP 401: Unauthorized"]);
  });

  it("sends server.token from the config, and TOKEN from the environment before it", async () => {
    await start(
      { "POST /api/captions/clear": json(200, { message: "Cleared" }) },
      "  token: cfg-token\n",
    );
    const c = capture();
    expect(await ctlCommand(["clear"], c.io, loaded)).toBe(0);
    vi.stubEnv("TOKEN", "env-token");
    expect(await ctlCommand(["clear"], c.io, loaded)).toBe(0);
    expect(server.seen.map((s) => s.authorization)).toEqual([
      "Bearer cfg-token",
      "Bearer env-token",
    ]);
  });

  it("uses CAPTIONS_URL instead of the configured port", async () => {
    await start({ "POST /api/captions/clear": json(200, { message: "Cleared" }) });
    vi.stubEnv("CAPTIONS_URL", `http://127.0.0.1:${server.port}/`);
    const c = capture();
    expect(await ctlCommand(["clear"], c.io, onPort(1))).toBe(0);
    expect(c.out).toEqual(["Cleared"]);
  });

  it("prints its help with exit code 2 for a missing action, or kill without an id", async () => {
    await start({});
    for (const args of [[], ["kill"], ["kill", ""]]) {
      const c = capture();
      expect(await ctlCommand(args, c.io, loaded)).toBe(2);
      expect(c.err).toEqual([CTL_HELP]);
    }
    expect(server.seen).toEqual([]);
  });

  it("names an unknown action above its help, with exit code 2", async () => {
    await start({});
    const c = capture();
    expect(await ctlCommand(["restart", "now"], c.io, loaded)).toBe(2);
    expect(c.err).toEqual([`ctl: unknown action restart\n\n${CTL_HELP}`]);
    expect(server.seen).toEqual([]);
  });

  it("says where it looked when no server answers", async () => {
    const port = await freePort();
    const c = capture();
    expect(await ctlCommand(["stop"], c.io, onPort(port))).toBe(1);
    expect(c.errText()).toMatch(
      new RegExp(`^Service not reachable at http://127\\.0\\.0\\.1:${port}: `),
    );
    server = await fakeServer({});
  });
});

describe("turjuman status", () => {
  it("formats the health of a server with a local session and page sessions", () => {
    const health: Health = {
      ok: true,
      version: "1.2.3",
      uptimeMs: 3_725_000,
      exposure: "lan",
      local: localStatus({
        error: "provider hiccup",
        audio: {
          state: "ok",
          rmsDbfs: -23.44,
          lastFrameAgoMs: 20,
          noSignal: true,
          lastStderr: "buffer underrun",
        },
      }),
      sessions: [
        summary(),
        summary({ id: "s2", keyLabel: undefined, latency: { p50Ms: null, p95Ms: null, n: 0 } }),
      ],
    };
    expect(formatHealth(health).split("\n")).toEqual([
      "Service: up (v1.2.3, uptime 1h02m, exposure lan)",
      "Local session: live (device, ar→nl, id loc1)",
      "  engine: soniox live",
      "  audio: ok (device connected)  level: -23.4 dBFS  NO SIGNAL",
      "  latency: p50 1.2 s / p95 2.6 s (n=14)",
      "  error: provider hiccup",
      "  ffmpeg: buffer underrun",
      "Active sessions: 2",
      "  s1  page   ar→nl     soniox        Main hall       12m34s  12.3 min  p50 1.2 s / p95 2.6 s (n=14)  live",
      "  s2  page   ar→nl     soniox        -               12m34s  12.3 min  –  live",
    ]);
  });

  it("names the local session's input as it is: a device, the audio bridge, a file or a replay", () => {
    const lines = (session: Partial<SessionInfo>, audio: Status["audio"]["state"] = "ok") =>
      formatHealth({
        ok: true,
        version: "1",
        uptimeMs: 0,
        exposure: "local",
        local: localStatus({
          audio: { state: audio, rmsDbfs: -100, lastFrameAgoMs: 0, noSignal: false },
          session: { ...(localStatus().session as SessionInfo), ...session },
        }),
        sessions: [],
      })
        .split("\n")
        .slice(1, 4)
        .filter((l) => !l.includes("engine"));
    expect(lines({ inputKind: "network" })).toEqual([
      "Local session: live (audio bridge, ar→nl, id loc1)",
      "  audio: ok (bridge connected)  level: -100.0 dBFS",
    ]);
    expect(lines({ inputKind: "network" }, "waiting-for-bridge")[1]).toBe(
      "  audio: waiting-for-bridge  level: -100.0 dBFS",
    );
    expect(lines({ kind: "file", inputKind: "file", file: "/rec/khutbah.wav" })).toEqual([
      "Local session: live (file, ar→nl, id loc1)",
      "  audio: ok (playing the file)  level: -100.0 dBFS",
    ]);
    // `turjuman replay`: the session's file is the provider log, the audio is silence.
    expect(lines({ kind: "file", inputKind: "file", file: "/logs/provider.jsonl" })).toEqual([
      "Local session: live (file, ar→nl, id loc1)",
      "  audio: ok (replay: silent input)  level: -100.0 dBFS",
    ]);
    expect(lines({ kind: "page", inputKind: "page" })[1]).toBe(
      "  audio: ok (page connected)  level: -100.0 dBFS",
    );
  });

  it("shows a local session without details, and no local session at all", () => {
    const idle = localStatus({
      state: "idle",
      session: undefined,
      tracks: [],
      audio: { state: "waiting-for-bridge", rmsDbfs: null, lastFrameAgoMs: null, noSignal: false },
      latency: { p50Ms: 900, p95Ms: null, n: 1 },
    });
    const text = formatHealth({
      ok: true,
      version: "1",
      uptimeMs: 61_000,
      exposure: "local",
      local: idle,
      sessions: [],
    });
    expect(text.split("\n")).toEqual([
      "Service: up (v1, uptime 1m01s, exposure local)",
      "Local session: idle",
      "  engine: –",
      "  audio: waiting-for-bridge  level: –",
      "  latency: p50 0.9 s / p95 0.0 s (n=1)",
      "Active sessions: 0",
    ]);
    expect(
      formatHealth({
        ok: true,
        version: "1",
        uptimeMs: 0,
        exposure: "public",
        local: null,
        sessions: [],
      }),
    ).toContain("Local session: none");
  });

  it("sends server.token from the config, as ctl does (a hosted server shows its sessions only then)", async () => {
    const health = (sessions: SessionSummary[]): Health => ({
      ok: true,
      version: "1",
      uptimeMs: 0,
      exposure: "local",
      local: null,
      sessions,
    });
    const server = await fakeServer({
      "GET /health": (seen) =>
        json(200, health(seen.authorization === "Bearer op-token" ? [summary()] : [])),
    });
    try {
      const c = capture();
      expect(await statusCommand(c.io, onPort(server.port, "  token: op-token\n"))).toBe(0);
      expect(c.out[0]).toContain("Active sessions: 1\n  s1  page");
      expect(await statusCommand(c.io, onPort(server.port))).toBe(0);
      expect(c.out[1]).toContain("Active sessions: 0");
      expect(server.seen.map((s) => s.authorization)).toEqual(["Bearer op-token", undefined]);
    } finally {
      await server.close();
    }
  });

  it("reports an HTTP error and an unreachable server with exit code 1", async () => {
    const server = await fakeServer({ "GET /health": { status: 503, body: "down" } });
    try {
      const c = capture();
      expect(await statusCommand(c.io, onPort(server.port))).toBe(1);
      expect(c.err).toEqual([`Service at http://127.0.0.1:${server.port} answered HTTP 503`]);
    } finally {
      await server.close();
    }
    const port = await freePort();
    const c = capture();
    expect(await statusCommand(c.io, onPort(port))).toBe(1);
    expect(c.errText()).toContain(`Service not reachable at http://127.0.0.1:${port}`);
  });
});

describe("status and ctl against a real server", () => {
  let app: FastifyInstance;
  let manager: SessionManagerApi;
  let port: number;
  const token = "a-token-for-the-cli-tests";

  beforeEach(async () => {
    const root = tempDir("cli-ctl-app-");
    for (const dir of ["public/assets", "public/fonts"])
      mkdirSync(join(root, dir), { recursive: true });
    const { loaded } = configured(`server:\n  token: ${token}\n`);
    manager = {
      createPage: vi.fn(),
      get: vi.fn(() => undefined),
      list: vi.fn(() => [summary()]),
      local: vi.fn(() => null),
      startLocal: vi.fn(async () => ({ ok: true, message: "local session started" })),
      stopLocal: vi.fn(async () => ({ ok: false, message: "no local session" })),
      subscribeMonitor: vi.fn(() => () => {}),
      health: vi.fn(
        (): Health => ({
          ok: true,
          version: "9.9.9",
          uptimeMs: 5000,
          exposure: "local",
          local: null,
          sessions: [summary()],
        }),
      ),
      stopAll: vi.fn(async () => {}),
    };
    writeFileSync(join(root, "public", "control.html"), "<!doctype html><title>control</title>");
    app = await buildApp({
      loaded,
      manager,
      log: pino({ level: "silent" }),
      publicDir: join(root, "public"),
      version: "9.9.9",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
  });

  it("status prints the server's /health", async () => {
    const c = capture();
    expect(await statusCommand(c.io, onPort(port, `  token: ${token}\n`))).toBe(0);
    expect(c.out[0]).toContain("Service: up (v9.9.9, uptime 0m05s, exposure local)");
    expect(c.out[0]).toContain("Active sessions: 1");
  });

  it("ctl drives the session API with the config's token", async () => {
    const loaded = onPort(port, `  token: ${token}\n`);
    const c = capture();
    expect(await ctlCommand(["start"], c.io, loaded)).toBe(0);
    expect(manager.startLocal).toHaveBeenCalledWith({ source: "device" });
    expect(await ctlCommand(["stop"], c.io, loaded)).toBe(0);
    expect(await ctlCommand(["sessions"], c.io, loaded)).toBe(0);
    expect(await ctlCommand(["kill", "nope"], c.io, loaded)).toBe(1);
    expect(c.out).toEqual([
      "local session started",
      "Nothing to stop: no local session",
      "s1  page  ar→nl  soniox  Main hall  754 s  12.3 min  live",
    ]);
    expect(c.err).toEqual(["HTTP 404: No session nope"]);
  });

  it("runCli status and ctl work without a config (the defaults) and refuse options", async () => {
    vi.stubEnv("CAPTIONS_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("TOKEN", token);
    // No config: tryLoadConfig() falls back to null when loading fails.
    const dir = tempDir();
    writeFileSync(join(dir, "config.yaml"), "server: [not, a, map]\n");
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      const c = capture();
      expect(await runCli(["status"], c.io)).toBe(0);
      expect(c.out[0]).toContain("Service: up (v9.9.9");
      expect(await runCli(["ctl", "sessions"], c.io)).toBe(0);
      expect(c.out[1]).toContain("s1  page");
      c.clear();
      expect(await runCli(["status", "--verbose"], c.io)).toBe(2);
      expect(c.errText()).toMatch(/^turjuman status: Unknown option '--verbose'\./);
      expect(c.errText()).toContain("Whether the server runs, and what it is doing");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
