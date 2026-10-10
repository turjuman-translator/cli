import { EventEmitter } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, createServer, type Server } from "node:net";
import { join } from "node:path";
import { type ConnectionOptions, connect, type TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realDoctorDeps } from "../../src/cli/doctor.js";
import { runCli } from "../../src/cli/index.js";
import { COMMAND_USAGE } from "../../src/cli/usage.js";
import { capture, configured, freePort, removeTempDirs, tempDir } from "./helpers/cli-env.js";

// The TLS check talks to Soniox's host on port 443: these tests answer for it (no network).
vi.mock("node:tls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tls")>()),
  connect: vi.fn(),
}));

type Outcome =
  | { kind: "secure"; protocol: string | null }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

let tlsCalls: ConnectionOptions[];

/** What the next TLS connection does. */
function tlsWill(outcome: Outcome): void {
  vi.mocked(connect).mockImplementation(((options: ConnectionOptions, onSecure?: () => void) => {
    tlsCalls.push(options);
    const socket = Object.assign(new EventEmitter(), {
      getProtocol: () => (outcome.kind === "secure" ? outcome.protocol : null),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    setImmediate(() => {
      if (outcome.kind === "secure") onSecure?.();
      else if (outcome.kind === "timeout") socket.emit("timeout");
      else socket.emit("error", new Error(outcome.message));
    });
    return socket as unknown as TLSSocket;
  }) as typeof connect);
}

beforeEach(() => {
  tlsCalls = [];
  tlsWill({ kind: "secure", protocol: "TLSv1.3" });
  for (const name of ["SONIOX_API_KEY", "CAPTIONS_CONTAINER", "SERVER_HOST"])
    vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeTempDirs();
});

/** A small executable shell script (a stand-in for ffmpeg). */
function script(body: string): string {
  const file = join(tempDir(), "ffmpeg");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("realDoctorDeps: ffmpeg", () => {
  it("runs ffmpeg and collects its output and exit code", async () => {
    const ffmpeg = script('echo "devices: $1"; echo "a warning" 1>&2; exit 3');
    const deps = realDoctorDeps(ffmpeg);
    expect(deps.nodeVersion).toBe(process.versions.node);
    expect(deps.platform).toBe(process.platform);
    expect(await deps.runFfmpeg(["-devices"])).toEqual({
      code: 3,
      stdout: "devices: -devices\n",
      stderr: "a warning\n",
    });
  });

  it("is null when ffmpeg is not there", async () => {
    expect(await realDoctorDeps(join(tempDir(), "no-ffmpeg")).runFfmpeg(["-devices"])).toBeNull();
  });

  it("stops an ffmpeg that hangs after ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ffmpeg = script("exec sleep 30");
    const run = realDoctorDeps(ffmpeg).runFfmpeg(["-devices"]);
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(10_000);
    expect(await run).toEqual({ code: null, stdout: "", stderr: "" });
  });
});

describe("realDoctorDeps: the port", () => {
  let held: Server | null = null;
  let health: HttpServer | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (held === null ? resolve() : held.close(() => resolve())));
    await new Promise<void>((resolve) =>
      health === null ? resolve() : health.close(() => resolve()),
    );
    held = null;
    health = null;
  });

  it("finds a free port free and a taken one taken", async () => {
    const deps = realDoctorDeps("ffmpeg");
    const port = await freePort();
    expect(await deps.portFree("127.0.0.1", port)).toBe(true);
    held = createServer();
    await new Promise<void>((resolve) => held?.listen(port, "127.0.0.1", resolve));
    expect(await deps.portFree("127.0.0.1", port)).toBe(false);
  });

  it("knows a running Turjuman by its /health, also behind 0.0.0.0", async () => {
    const deps = realDoctorDeps("ffmpeg");
    let status = 200;
    const paths: string[] = [];
    health = createHttpServer((req, res) => {
      paths.push(req.url ?? "");
      res.statusCode = status;
      res.end("{}");
    });
    await new Promise<void>((resolve) => health?.listen(0, "127.0.0.1", resolve));
    const { port } = health.address() as AddressInfo;
    expect(await deps.healthOk("127.0.0.1", port)).toBe(true);
    expect(await deps.healthOk("0.0.0.0", port)).toBe(true);
    expect(await deps.healthOk("::", port)).toBe(true);
    status = 500;
    expect(await deps.healthOk("127.0.0.1", port)).toBe(false);
    expect(paths).toEqual(["/health", "/health", "/health", "/health"]);
    expect(await deps.healthOk("127.0.0.1", await freePort())).toBe(false);
  });
});

describe("realDoctorDeps: Soniox", () => {
  it("does a TLS handshake with the host on port 443 and names the protocol", async () => {
    const deps = realDoctorDeps("ffmpeg");
    expect(await deps.tlsReachable("stt-rt.soniox.com")).toEqual({
      ok: true,
      detail: "TLS handshake ok (TLSv1.3)",
    });
    expect(tlsCalls[0]).toEqual({
      host: "stt-rt.soniox.com",
      port: 443,
      servername: "stt-rt.soniox.com",
      timeout: 5000,
    });
    tlsWill({ kind: "secure", protocol: null });
    expect((await deps.tlsReachable("x")).detail).toBe("TLS handshake ok (tls)");
    tlsWill({ kind: "timeout" });
    expect(await deps.tlsReachable("x")).toEqual({ ok: false, detail: "timeout after 5 s" });
    tlsWill({ kind: "error", message: "getaddrinfo ENOTFOUND x" });
    expect(await deps.tlsReachable("x")).toEqual({ ok: false, detail: "getaddrinfo ENOTFOUND x" });
  });

  it("asks Soniox's model list (free) whether it takes the key and has the model", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    let answer: () => Response = () => Response.json({ models: [{ id: "stt-rt-v5" }, {}] });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return answer();
    });
    const { online } = realDoctorDeps("ffmpeg");
    expect(await online?.soniox("fake-key", "default", "stt-rt-v5")).toEqual({
      ok: true,
      detail: "key accepted; stt-rt-v5 available",
    });
    expect(seen[0]).toEqual({ url: "https://api.soniox.com/v1/models", auth: "Bearer fake-key" });
    expect(await online?.soniox("fake-key", "eu", "stt-rt-v9")).toEqual({
      ok: false,
      detail: "key accepted, but stt-rt-v9 not listed",
    });
    expect(seen[1]?.url).toBe("https://api.eu.soniox.com/v1/models");
    answer = () => Response.json({});
    expect((await online?.soniox("fake-key", "default", "stt-rt-v5"))?.ok).toBe(false);
    answer = () => new Response("no", { status: 401 });
    expect(await online?.soniox("fake-key", "default", "stt-rt-v5")).toEqual({
      ok: false,
      detail: "HTTP 401 from https://api.soniox.com/v1/models",
    });
    answer = () => {
      throw new Error("fetch failed");
    };
    expect(await online?.soniox("fake-key", "default", "stt-rt-v5")).toEqual({
      ok: false,
      detail: "fetch failed",
    });
  });
});

describe("turjuman doctor", () => {
  function useDir(dir: string): void {
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  }

  it("checks the setup with the real checks and the configured ffmpeg", async () => {
    const port = await freePort();
    const ffmpeg = script(
      'case "$2" in -devices) printf " ---\\n D  avfoundation  in\\n D  pulse  in\\n";; esac',
    );
    const { dir } = configured(`server:\n  port: ${port}\naudio:\n  ffmpegPath: ${ffmpeg}\n`);
    useDir(dir);
    const c = capture();
    const code = await runCli(["doctor"], c.io);
    const text = c.text();
    expect(text).toMatch(/\[ok\] {3}Node\.js +v\d+/);
    expect(text).toMatch(new RegExp(`Port +127\\.0\\.0\\.1:${port} is free`));
    expect(text).toMatch(/ffmpeg +found; input formats: avfoundation, pulse/);
    expect(text).toMatch(/TLS stt-rt\.soniox\.com +TLS handshake ok \(TLSv1\.3\)/);
    expect(text).toMatch(/\[FAIL\] Soniox API key/);
    expect(code).toBe(1);
  });

  it("--online asks Soniox about the key; --config reads another file", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ models: [{ id: "stt-rt-v5" }] }));
    const port = await freePort();
    const { dir } = configured(
      `server:\n  port: ${port}\naudio:\n  ffmpegPath: ${join(tempDir(), "none")}\n`,
    );
    useDir(tempDir());
    vi.stubEnv("SONIOX_API_KEY", "fake-key-for-doctor-online");
    const c = capture();
    const code = await runCli(["doctor", "--online", "--config", join(dir, "config.yaml")], c.io);
    expect(c.text()).toMatch(/\[ok\] {3}Soniox key \(online\) +key accepted; stt-rt-v5 available/);
    expect(c.text()).toMatch(
      /\[warn\] ffmpeg +".*none" not found \(needed for file replay and record\)/,
    );
    expect(c.text()).not.toContain("fake-key-for-doctor-online");
    expect(code).toBe(0);
  });

  it("reports a config it cannot load and checks the rest with the defaults", async () => {
    const dir = tempDir();
    useDir(dir);
    const c = capture();
    const code = await runCli(["doctor", "--config", join(dir, "missing.yaml")], c.io);
    expect(code).toBe(1);
    expect(c.text()).toMatch(/\[FAIL\] Config +Config file not found: .*missing\.yaml/);
    expect(c.text()).toMatch(/TLS stt-rt\.soniox\.com/);
  });

  it("prints its usage for --help and under a wrong option", async () => {
    const c = capture();
    expect(await runCli(["doctor", "--help"], c.io)).toBe(0);
    expect(c.out).toEqual([COMMAND_USAGE.doctor]);
    expect(await runCli(["doctor", "--offline"], c.io)).toBe(2);
    expect(c.errText()).toBe(
      `turjuman doctor: Unknown option '--offline'.\n\n${COMMAND_USAGE.doctor}`,
    );
  });
});
