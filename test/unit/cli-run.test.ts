import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { replayCommand, runCommand, type ServeOptions, serve } from "../../src/cli/run.js";
import { COMMAND_USAGE } from "../../src/cli/usage.js";
import type { LoadedConfig } from "../../src/config.js";
import { readMarker, writeMarker } from "../../src/core/resume.js";
import { createLogger } from "../../src/log.js";
import { packageVersion } from "../../src/version.js";
import { fakeSpawn } from "./audio-fake-ffmpeg.js";
import {
  capture,
  configured,
  freePort,
  removeTempDirs,
  tempDir,
  trackSignalListeners,
} from "./helpers/cli-env.js";
import { hasOpenssl, makeCert } from "./helpers/cli-tls.js";
import { tanzilContents } from "./quran-test-corpus.js";

// The server's log goes to a list the tests can read, not to the test's stdout.
vi.mock("../../src/log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/log.js")>()),
  createLogger: vi.fn(),
}));

// `--dev` starts the browser-page watcher with spawn, and an idle monitor starts ffmpeg: the tests
// put fakes in their place (anything else still gets node's spawn).
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn(real.spawn) };
});

const FIXTURE = resolve("test/fixtures/soniox-tts-1.jsonl");
/** An ffmpeg that is never on any computer: the spawn mock answers it with a fake. */
const TEST_FFMPEG = "/nonexistent/ffmpeg-for-turjuman-tests";

/** What the device listing tools print in these tests (macOS: ffmpeg; Linux: pactl). */
const LISTINGS: Record<string, { flag: string; code: number; stdout: string; stderr: string }> = {
  [TEST_FFMPEG]: {
    flag: "-list_devices",
    code: 1,
    stdout: "",
    stderr: [
      "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
      "[AVFoundation indev @ 0x1] [0] Test mic",
    ].join("\n"),
  },
  pactl: {
    flag: "sources",
    code: 0,
    stdout: "1\tTest mic\tmodule\ts16le 1ch 48000Hz\tIDLE\n",
    stderr: "",
  },
};

/** A listing tool that prints its answer and exits. */
function listing(answer: { code: number; stdout: string; stderr: string }): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(answer.stdout));
    child.stderr.emit("data", Buffer.from(answer.stderr));
    child.emit("close", answer.code);
  });
  return child as unknown as ChildProcess;
}

/** Waits for a server under a busy machine (the whole suite runs in parallel). */
const SLOW = { timeout: 15_000 };
vi.setConfig({ testTimeout: 60_000 });

let restoreSignals: () => void;
let logs: Array<Record<string, unknown>>;
let ffmpeg: ReturnType<typeof fakeSpawn>;
let watcher: (EventEmitter & { kill: ReturnType<typeof vi.fn> }) | null;

beforeEach(async () => {
  restoreSignals = trackSignalListeners();
  logs = [];
  vi.mocked(createLogger).mockImplementation(() =>
    pino({ level: "debug" }, { write: (line: string) => void logs.push(JSON.parse(line)) }),
  );
  ffmpeg = fakeSpawn();
  watcher = null;
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: object) => {
    if (command === "pnpm") {
      watcher = Object.assign(new EventEmitter(), { kill: vi.fn() });
      return watcher as unknown as ChildProcess;
    }
    if (LISTINGS[command] !== undefined && args.includes(LISTINGS[command].flag)) {
      return listing(LISTINGS[command]);
    }
    if (command === TEST_FFMPEG) {
      const child = ffmpeg.spawn(command, args, options);
      const proc = ffmpeg.last();
      proc.onKill = (signal) => proc.exit(null, signal);
      return child;
    }
    return real.spawn(command, args, options);
  }) as typeof spawn);
  // No key of the caller's shell may reach a test server (and no test may call Soniox).
  for (const name of ["SONIOX_API_KEY", "CAPTIONS_CONTAINER", "CAPTIONS_URL", "TOKEN"]) {
    vi.stubEnv(name, undefined);
  }
  // `turjuman run` downloads missing Quran data: here from a closed port on this computer.
  vi.stubEnv("TURJUMAN_TANZIL_URL", "http://127.0.0.1:9");
});

afterEach(() => {
  restoreSignals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

/** Log entries with this message. */
function logged(msg: string): Array<Record<string, unknown>> {
  return logs.filter((entry) => entry.msg === msg);
}

/** Synthetic Tanzil files in DATA_DIR/quran (where the default config looks for them). */
function quranData(dataDir: string, opts: { translation?: boolean } = {}): void {
  const files = tanzilContents({
    "1:1": { simple: "بسم الله الرحمن الرحيم", translations: { nl: "In de naam van Allah" } },
  });
  mkdirSync(join(dataDir, "quran"), { recursive: true });
  writeFileSync(join(dataDir, "quran", "quran-simple-clean.txt"), files.simple);
  writeFileSync(join(dataDir, "quran", "quran-uthmani.txt"), files.uthmani);
  if (opts.translation !== false) {
    writeFileSync(join(dataDir, "quran", "nl.siregar.txt"), files.translations.nl ?? "");
  }
}

/** Use this folder as CONFIG_DIR, DATA_DIR and working folder for commands that load the config. */
function useDir(dir: string): void {
  vi.stubEnv("CONFIG_DIR", dir);
  vi.stubEnv("DATA_DIR", dir);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

type Captured = ReturnType<typeof capture>;

async function started(c: Captured): Promise<void> {
  await vi.waitFor(() => expect(c.out[0]).toMatch(/^Turjuman server running/), SLOW);
}

async function localLine(c: Captured): Promise<string> {
  await vi.waitFor(
    () => expect(c.out.some((l) => l.startsWith("Local session: "))).toBe(true),
    SLOW,
  );
  return c.out.find((l) => l.startsWith("Local session: ")) ?? "";
}

function stop(done: Promise<number>, signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
  process.emit(signal, signal);
  return done;
}

function serveWith(loaded: LoadedConfig, c: Captured, opts: Partial<ServeOptions> = {}) {
  return serve({
    loaded,
    io: c.io,
    dev: false,
    print: false,
    fakeProviderFile: null,
    fakeSpeed: 1,
    fakeLoop: false,
    silentAudio: false,
    autoStart: null,
    ...opts,
  });
}

/** GET a path over HTTPS, trusting `ca`. */
function httpsJson(port: number, path: string, ca: Buffer): Promise<unknown> {
  return new Promise((resolveGet, reject) => {
    httpsGet({ host: "127.0.0.1", port, path, ca }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => resolveGet(JSON.parse(body)));
    }).on("error", reject);
  });
}

/** Hold a TCP port so the server cannot have it. */
async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return server;
}

function release(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

const DEVICE = "audio:\n  input:\n    kind: device\n    device: Test mic\n";

describe("turjuman replay", () => {
  it("replays a provider log as the local session without any API key, and --print prints it", async () => {
    const port = await freePort();
    const { dir } = configured(`server:\n  port: ${port}\n`);
    useDir(dir);
    const c = capture();
    const done = replayCommand([FIXTURE, "--speed", "20", "--print"], c.io);
    await started(c);
    expect(c.out[0]).toBe(
      [
        `Turjuman server running (v${packageVersion()}, exposure local, FAKE provider)`,
        `  Caption link:     http://127.0.0.1:${port}/`,
        `  Caption page:     http://127.0.0.1:${port}/ar/nl`,
        `  Overlay / dock:   http://127.0.0.1:${port}/overlay   http://127.0.0.1:${port}/control`,
        `  Health:           http://127.0.0.1:${port}/health`,
      ].join("\n"),
    );
    expect(await localLine(c)).toBe("Local session: live");
    await vi.waitFor(
      () => expect(c.out.some((l) => /^\[soniox #\d+\] \S/.test(l))).toBe(true),
      SLOW,
    );
    const first = c.out.findIndex((l) => l.startsWith("[soniox #"));
    expect(c.out[first + 1]).toMatch(/^ {8}nl: \S/);
    expect(await stop(done)).toBe(0);
  });

  it("needs a provider log, and reads --speed, --loop and --config", async () => {
    const c = capture();
    expect(await replayCommand([], c.io)).toBe(2);
    expect(c.err).toEqual([COMMAND_USAGE.replay]);
    const [port, otherPort] = [await freePort(), await freePort()];
    const { dir } = configured(`server:\n  port: ${port}\nevents:\n  enabled: false\n`);
    useDir(configured(`server:\n  port: ${otherPort}\n`).dir);
    c.clear();
    const done = replayCommand(
      [FIXTURE, "--speed", "fast", "--loop", "--config", join(dir, "config.yaml")],
      c.io,
    );
    await started(c);
    expect(c.out[0]).toContain(`  Health:           http://127.0.0.1:${port}/health`);
    expect(await localLine(c)).toBe("Local session: live");
    expect(await stop(done, "SIGHUP")).toBe(0);
    expect(logged("shutting down")[0]?.signal).toBe("SIGHUP");
  });
});

describe("serve: a live local session", () => {
  it.skipIf(!hasOpenssl)(
    "prints the addresses with HTTPS, keeps the resume marker fresh and stops on SIGTERM",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
      const [port, httpsPort] = [await freePort(), await freePort()];
      const token = "a-token-for-the-serve-tests";
      const { dir, loaded } = configured(
        `server:\n  port: ${port}\n  token: ${token}\n  https:\n    port: ${httpsPort}\n${DEVICE}`,
        { SONIOX_API_KEY: "a-key-that-is-never-sent" },
      );
      const { cert } = makeCert(join(dir, "tls"), ["127.0.0.1"]);
      quranData(dir);
      const c = capture();
      const done = serveWith(loaded, c, {
        fakeProviderFile: FIXTURE,
        fakeLoop: true,
        silentAudio: true,
        print: true,
        autoStart: { source: "device" },
      });
      await started(c);
      expect(c.out[0]?.split("\n").slice(-2)).toEqual([
        `  Health:           http://127.0.0.1:${port}/health`,
        `  HTTPS:            https://127.0.0.1:${httpsPort}/`,
      ]);
      expect(await localLine(c)).toBe("Local session: live");
      expect(createLogger).toHaveBeenCalledWith({
        pretty: false,
        terminal: false,
        secrets: ["a-key-that-is-never-sent", token],
      });
      expect(logged("Quran matcher ready")).toHaveLength(1);
      // The same app answers on the HTTPS port.
      const health = (await httpsJson(httpsPort, "/health", readFileSync(cert))) as {
        version: string;
      };
      expect(health.version).toBe(packageVersion());

      expect(readMarker(loaded.paths.stateDir)).toBeNull();
      vi.advanceTimersByTime(5000);
      const marker = readMarker(loaded.paths.stateDir);
      expect(marker).toMatchObject({ resumes: 0, inputKind: "device" });
      vi.advanceTimersByTime(5000);
      const again = readMarker(loaded.paths.stateDir);
      expect(again?.sessionId).toBe(marker?.sessionId);
      expect(again?.startedAt).toBe(marker?.startedAt);

      expect(await stop(done)).toBe(0);
      // SIGTERM (docker restart) keeps the marker, so the session resumes after the restart.
      expect(readMarker(loaded.paths.stateDir)?.sessionId).toBe(marker?.sessionId);
      expect(logged("shutting down")[0]?.signal).toBe("SIGTERM");
    },
  );

  it("resumes a session that was live a moment ago, and counts the resume", async () => {
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n${DEVICE}`);
    const now = Date.now();
    writeMarker(loaded.paths.stateDir, {
      sessionId: "before",
      startedAt: now - 600_000,
      lastAliveAt: now - 2000,
      resumes: 1,
      inputKind: "device",
    });
    const c = capture();
    const done = serveWith(loaded, c, { fakeProviderFile: FIXTURE, silentAudio: true });
    await started(c);
    await vi.waitFor(
      () => expect(logged("resumed the local session after a restart")).toHaveLength(1),
      SLOW,
    );
    expect(logged("resumed the local session after a restart")[0]?.resumed).toEqual({
      ok: true,
      message: "live",
    });
    expect(readMarker(loaded.paths.stateDir)).toMatchObject({
      sessionId: "before",
      startedAt: now - 600_000,
      resumes: 2,
    });
    expect(await stop(done, "SIGINT")).toBe(0);
  });

  it("keeps a failed resume out of the marker", async () => {
    const port = await freePort();
    // No key and no provider log: the resumed start is refused at once.
    const { loaded } = configured(`server:\n  port: ${port}\n${DEVICE}`);
    const now = Date.now();
    writeMarker(loaded.paths.stateDir, {
      sessionId: "before",
      startedAt: now - 1000,
      lastAliveAt: now - 1000,
      resumes: 0,
      inputKind: "device",
    });
    const c = capture();
    const done = serveWith(loaded, c, { silentAudio: true });
    await started(c);
    await vi.waitFor(
      () => expect(logged("resumed the local session after a restart")).toHaveLength(1),
      SLOW,
    );
    expect(logged("resumed the local session after a restart")[0]?.resumed).toMatchObject({
      ok: false,
    });
    expect(readMarker(loaded.paths.stateDir)?.resumes).toBe(0);
    expect(await stop(done)).toBe(0);
  });

  it("forgets a marker that is too old to resume", async () => {
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n${DEVICE}`);
    writeMarker(loaded.paths.stateDir, {
      sessionId: "long-ago",
      startedAt: 0,
      lastAliveAt: 0,
      resumes: 0,
      inputKind: "device",
    });
    const c = capture();
    const done = serveWith(loaded, c, { silentAudio: true });
    await started(c);
    expect(readMarker(loaded.paths.stateDir)).toBeNull();
    expect(logged("resumed the local session after a restart")).toEqual([]);
    expect(await stop(done)).toBe(0);
  });

  it("clears the marker at the heartbeat when no local session runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const port = await freePort();
    const { loaded } = configured(
      `server:\n  port: ${port}\nsession:\n  resumeAfterRestart: false\n`,
    );
    writeMarker(loaded.paths.stateDir, {
      sessionId: "x",
      startedAt: Date.now(),
      lastAliveAt: Date.now(),
      resumes: 0,
      inputKind: "device",
    });
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    expect(readMarker(loaded.paths.stateDir)).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(readMarker(loaded.paths.stateDir)).toBeNull();
    expect(await stop(done)).toBe(0);
  });

  it("leaves the marker alone while a session is still starting", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const port = await freePort();
    const { loaded } = configured(
      `server:\n  port: ${port}\naudio:\n  ffmpegPath: ${TEST_FFMPEG}\n  input:\n    kind: device\n`,
    );
    const c = capture();
    const done = serveWith(loaded, c, { fakeProviderFile: FIXTURE });
    await started(c);
    await vi.waitFor(() => expect(ffmpeg.procs).toHaveLength(1), SLOW); // the idle monitor
    // A start from the control page: its ffmpeg sends nothing yet, so the session waits.
    const start = fetch(`http://127.0.0.1:${port}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await vi.waitFor(() => expect(ffmpeg.procs).toHaveLength(2), SLOW);
    vi.advanceTimersByTime(5000);
    expect(readMarker(loaded.paths.stateDir)).toBeNull();
    expect(await stop(done)).toBe(0);
    expect((await start).status).toBe(409);
  });

  it("forgets the session on Ctrl-C at a terminal (a deliberate stop)", async () => {
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n${DEVICE}`);
    const c = capture();
    const done = serveWith(loaded, c, {
      fakeProviderFile: FIXTURE,
      fakeLoop: true,
      silentAudio: true,
      autoStart: { source: "device" },
    });
    await started(c);
    expect(await localLine(c)).toBe("Local session: live");
    writeMarker(loaded.paths.stateDir, {
      sessionId: "live-one",
      startedAt: Date.now(),
      lastAliveAt: Date.now(),
      resumes: 0,
      inputKind: "device",
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as typeof process.stdin);
    expect(await stop(done, "SIGINT")).toBe(0);
    expect(readMarker(loaded.paths.stateDir)).toBeNull();
  });

  it("writes no marker for a replayed file session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n`);
    const c = capture();
    const done = serveWith(loaded, c, {
      fakeProviderFile: FIXTURE,
      fakeLoop: true,
      silentAudio: true,
      autoStart: { source: "file", file: FIXTURE, loop: true },
    });
    await started(c);
    expect(await localLine(c)).toBe("Local session: live");
    vi.advanceTimersByTime(5000);
    expect(readMarker(loaded.paths.stateDir)).toBeNull();
    expect(await stop(done)).toBe(0);
  });
});

describe("serve: startup", () => {
  it("--dev starts the page watcher, never resumes, leaves the marker alone and stops the watcher", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n`);
    writeMarker(loaded.paths.stateDir, {
      sessionId: "x",
      startedAt: Date.now(),
      lastAliveAt: Date.now(),
      resumes: 0,
      inputKind: "device",
    });
    const c = capture();
    const done = serveWith(loaded, c, { dev: true });
    await started(c);
    expect(spawn).toHaveBeenCalledWith("pnpm", ["exec", "tsx", "scripts/build-web.ts", "--watch"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({ pretty: true }));
    // Dev restarts on every save: the marker is dropped, never resumed.
    expect(readMarker(loaded.paths.stateDir)).toBeNull();
    writeMarker(loaded.paths.stateDir, {
      sessionId: "y",
      startedAt: Date.now(),
      lastAliveAt: Date.now(),
      resumes: 0,
      inputKind: "device",
    });
    vi.advanceTimersByTime(5000);
    expect(readMarker(loaded.paths.stateDir)?.sessionId).toBe("y");
    expect(await stop(done, "SIGBREAK")).toBe(0);
    expect(watcher?.kill).toHaveBeenCalledOnce();
  });

  it("names the website and the app on a hosted server", async () => {
    const port = await freePort();
    const hosted = configured(
      `mode: hosted\nhosted:\n  publicUrl: https://captions.example.org/\nserver:\n  port: ${port}\n`,
    );
    const c = capture();
    const done = serveWith(hosted.loaded, c);
    await started(c);
    expect(c.out[0]?.split("\n")).toEqual([
      `Turjuman server running (v${packageVersion()}, hosted, exposure local)`,
      "  Website:          https://captions.example.org/",
      "  App:              https://captions.example.org/app",
      `  Health:           http://127.0.0.1:${port}/health`,
    ]);
    expect(await stop(done)).toBe(0);
    const bare = configured(`mode: hosted\nserver:\n  port: ${port}\n`);
    const d = capture();
    const again = serveWith(bare.loaded, d);
    await started(d);
    expect(d.out[0]?.split("\n")[1]).toBe(`  Website:          http://127.0.0.1:${port}/`);
    expect(await stop(again)).toBe(0);
  });

  it("warns that the Quran data is missing, or names what is missing in it", async () => {
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n`);
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    expect(
      logged(
        "Quran data missing: run pnpm exec tsx scripts/quran-data.ts (verse references are off until then)",
      ),
    ).toHaveLength(1);
    expect(await stop(done)).toBe(0);

    logs.length = 0;
    const partial = configured(`server:\n  port: ${port}\n`);
    quranData(partial.dir, { translation: false });
    const d = capture();
    const again = serveWith(partial.loaded, d);
    await started(d);
    expect(logged("Quran data problem")[0]?.quran).toMatch(/translation "nl" not found/);
    expect(logged("Quran matcher ready")).toHaveLength(1);
    expect(await stop(again)).toBe(0);

    logs.length = 0;
    const off = configured(
      `server:\n  port: ${port}\nquran:\n  enabled: false\nevents:\n  enabled: false\n`,
    );
    const e = capture();
    const third = serveWith(off.loaded, e);
    await started(e);
    expect(logged("Quran matcher ready")).toEqual([]);
    expect(logs.filter((l) => String(l.msg).startsWith("Quran data missing"))).toEqual([]);
    expect(await stop(third)).toBe(0);
  });

  it("logs the config's warnings", async () => {
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\nstt:\n  provider: gemini\n`);
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    expect(logs.some((l) => String(l.msg).startsWith("stt.provider is no longer used"))).toBe(true);
    expect(await stop(done)).toBe(0);
  });

  it("starts the idle monitor on ffmpeg for a network input", async () => {
    const port = await freePort();
    const { loaded } = configured(
      `server:\n  port: ${port}\naudio:\n  ffmpegPath: ${TEST_FFMPEG}\n  input:\n    kind: network\n`,
    );
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    await vi.waitFor(() => expect(ffmpeg.procs).toHaveLength(1), SLOW);
    expect(ffmpeg.last().args.join(" ")).toContain("tcp://0.0.0.0:7000?listen=1");
    expect(await stop(done)).toBe(0);
    expect(ffmpeg.last().signals).toContain("SIGTERM");
  });

  it("migrates a legacy glossary.yaml and writes the SRT files a crash left out", async () => {
    const port = await freePort();
    // A glossaries folder of the test's own (never the app's copy in the repository).
    const glossaries = tempDir();
    const { dir, loaded } = configured(`server:\n  port: ${port}\nglossariesDir: ${glossaries}\n`);
    writeFileSync(join(dir, "glossary.yaml"), "terms:\n  - خطبة\n");
    const session = join(loaded.paths.transcriptsDir, "2026-10-09_1200_abc123", "soniox");
    mkdirSync(session, { recursive: true });
    const text = (t: string) => ({ text: t, finalLen: t.length, final: true });
    const segment = {
      id: "abc123:soniox:1",
      sessionId: "abc123",
      track: "soniox",
      seq: 1,
      kind: "speech",
      startMs: 0,
      endMs: 2000,
      source: { lang: "ar", ...text("الحمد لله") },
      translations: { nl: text("Alle lof is voor Allah") },
      closed: true,
      timing: { source: "provider", firstTokenAt: 0 },
    };
    writeFileSync(join(session, "segments.jsonl"), `${JSON.stringify(segment)}\n`);
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    expect(logged("legacy glossary.yaml")[0]?.migration).toBe("migrated");
    expect(readFileSync(join(glossaries, "ar-nl.yaml"), "utf8")).toContain("خطبة");
    const regenerated = logged("regenerated missing SRT files")[0]?.regenerated as string[];
    expect(regenerated).toHaveLength(2);
    expect(readFileSync(regenerated[1] ?? "", "utf8")).toContain("Alle lof is voor Allah");
    expect(await stop(done)).toBe(0);
  });

  it("lists the audio devices for the app, with the configured ffmpeg", async () => {
    const port = await freePort();
    const { loaded } = configured(
      `server:\n  port: ${port}\naudio:\n  ffmpegPath: ${TEST_FFMPEG}\n`,
    );
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    const res = await fetch(`http://127.0.0.1:${port}/api/devices`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { devices: Array<{ name: string }> };
    expect(list.devices.map((d) => d.name)).toContain("Test mic");
    // A second signal while it shuts down changes nothing.
    process.emit("SIGTERM", "SIGTERM");
    expect(await stop(done)).toBe(0);
    expect(logged("shutting down")).toHaveLength(1);
  });

  it("says when the port is taken, and exits with 1", async () => {
    const port = await freePort();
    const holder = await occupy(port);
    try {
      const { loaded } = configured(`server:\n  port: ${port}\n`);
      const c = capture();
      expect(await serveWith(loaded, c)).toBe(1);
      expect(c.err).toEqual([
        `Port ${port} is in use: is Turjuman running already? (pnpm turjuman status)\n` +
          "To use another port, set server.port in config.yaml (start from config.example.yaml).",
      ]);
      expect(c.out).toEqual([]);
    } finally {
      await release(holder);
    }
  });

  it("throws other errors of the listen", async () => {
    const port = await freePort();
    // 192.0.2.1 (TEST-NET-1) is never an address of this computer.
    const { loaded } = configured(`server:\n  host: 192.0.2.1\n  exposure: lan\n  port: ${port}\n`);
    const c = capture();
    await expect(serveWith(loaded, c)).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });
});

describe("serve: HTTPS problems keep plain HTTP running", () => {
  async function httpsLine(yaml: string, setup?: (dir: string) => void): Promise<string> {
    const port = await freePort();
    const { dir, loaded } = configured(`server:\n  port: ${port}\n${yaml}`);
    setup?.(dir);
    const c = capture();
    const done = serveWith(loaded, c);
    await started(c);
    const line = c.out[0]?.split("\n").at(-1) ?? "";
    expect(await stop(done)).toBe(0);
    return line;
  }

  it("names the command that makes the certificate when there is none", async () => {
    const httpsPort = await freePort();
    const line = await httpsLine(`  https:\n    port: ${httpsPort}\n`);
    expect(line).toMatch(
      /^ {2}HTTPS: {12}not started, no certificate in .*\/tls: run bash scripts\/lan-cert\.sh \S+tls$/,
    );
    expect(logged("HTTPS not started")).toHaveLength(1);
  });

  it("says when the HTTPS port is taken", { skip: !hasOpenssl }, async () => {
    const httpsPort = await freePort();
    const holder = await occupy(httpsPort);
    try {
      const line = await httpsLine(`  https:\n    port: ${httpsPort}\n`, (dir) =>
        makeCert(join(dir, "tls"), ["127.0.0.1"]),
      );
      expect(line).toBe(
        `  HTTPS:            not started, port ${httpsPort} is in use (server.https.port in config.yaml)`,
      );
    } finally {
      await release(holder);
    }
  });

  it("points to the log for a certificate it cannot use", async () => {
    const httpsPort = await freePort();
    const line = await httpsLine(`  https:\n    port: ${httpsPort}\n`, (dir) => {
      mkdirSync(join(dir, "tls"));
      writeFileSync(join(dir, "tls", "server.crt"), "not a certificate");
      writeFileSync(join(dir, "tls", "server.key"), "not a key");
    });
    expect(line).toBe("  HTTPS:            not started (see the log)");
  });
});

describe("turjuman run", () => {
  it("starts the server with the options of run: --file, --loop and --print", async () => {
    const port = await freePort();
    const { dir } = configured(`server:\n  port: ${port}\n`);
    useDir(dir);
    const c = capture();
    const done = runCommand(["--file", "khutbah.wav", "--loop", "--print"], c.io);
    await started(c);
    expect(c.out[0]).toMatch(/^Turjuman server running \(v[^,]+, exposure local\)\n/);
    // No key and no provider log: the session is refused, the server keeps running.
    expect(await localLine(c)).toBe(
      "Local session: No Soniox key yet: add it in the app under Keys (or with turjuman setup)",
    );
    expect(await stop(done, "SIGINT")).toBe(0);
  });

  it("--start with --fake-provider and --config", async () => {
    const port = await freePort();
    const { dir } = configured(`server:\n  port: ${port}\n`);
    useDir(tempDir());
    const c = capture();
    const done = runCommand(
      ["--start", "--fake-provider", FIXTURE, "--config", join(dir, "config.yaml")],
      c.io,
    );
    await started(c);
    expect(c.out[0]).toMatch(/, FAKE provider\)\n/);
    expect(await localLine(c)).toBe(
      "Local session: device capture is disabled (audio.input.kind: none)",
    );
    expect(await stop(done)).toBe(0);
  });

  it("replays at speed 1 when --speed is not a positive number", async () => {
    const port = await freePort();
    const { dir } = configured(`server:\n  port: ${port}\n`);
    useDir(dir);
    const c = capture();
    const done = replayCommand([FIXTURE, "--speed", "0"], c.io);
    await started(c);
    expect(await localLine(c)).toBe("Local session: live");
    expect(await stop(done)).toBe(0);
  });

  it("logs one short line per entry at a terminal, JSON lines elsewhere", async () => {
    const port = await freePort();
    const { loaded } = configured(`server:\n  port: ${port}\n`);
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const c = capture();
      const done = serveWith(loaded, c);
      await started(c);
      expect(await stop(done)).toBe(0);
    } finally {
      if (isTTY === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", isTTY);
    }
    expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }));
  });

  it("turjuman start runs the server and prints where to open the app", async () => {
    const port = await freePort();
    const { dir } = configured(`server:\n  port: ${port}\n`);
    useDir(dir);
    const c = capture();
    const done = runCli(["start"], c.io);
    await started(c);
    expect(c.err[0]).toMatch(/^No Soniox API key yet: run "pnpm turjuman setup"/);
    expect(c.out[1]?.split("\n").slice(0, 3)).toEqual([
      "",
      "Open the app:",
      `  Screens (dashboard):  http://127.0.0.1:${port}/app`,
    ]);
    expect(await stop(done)).toBe(0);
    c.clear();
    expect(await runCli(["start", "--dry-run", "--config", join(dir, "config.yaml")], c.io)).toBe(
      2,
    );
    expect(c.errText()).toMatch(/audio\.input\.kind is "none"/);
  });

  it("runCli prints the usage of run and replay, and refuses a wrong option", async () => {
    const c = capture();
    expect(await runCli(["run", "--help"], c.io)).toBe(0);
    expect(await runCli(["replay", "-h"], c.io)).toBe(0);
    expect(c.out).toEqual([COMMAND_USAGE.run, COMMAND_USAGE.replay]);
    expect(await runCli(["run", "--port", "80"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman run: Unknown option '--port'.\n\n${COMMAND_USAGE.run}`);
    c.clear();
    expect(await runCli(["replay", "x.jsonl", "--fast"], c.io)).toBe(2);
    expect(c.errText()).toBe(
      `turjuman replay: Unknown option '--fast'.\n\n${COMMAND_USAGE.replay}`,
    );
  });
});
