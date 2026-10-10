// A first start needs nothing from the operator: `turjuman start` and `run` make config.yaml for
// this deployment, the server says where the generated admin token is (never the token itself),
// and missing Quran data is downloaded in the background (a fake tanzil.net here) while the
// server already serves. Sessions that start after it arrived follow the Quran.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlocksDeps, runCommand, type ServeOptions, serve } from "../../src/cli/run.js";
import { startCommand } from "../../src/cli/start.js";
import { DEPLOYMENT, type LoadedConfig, loadConfig, newConfigYaml } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import {
  capture,
  freePort,
  LANGUAGES_FILE,
  removeTempDirs,
  tempDir,
  trackSignalListeners,
} from "./helpers/cli-env.js";
import {
  ALL,
  fakeTanzil,
  SIMPLE,
  TEXT_QUERY,
  transQuery,
  UTHMANI,
} from "./helpers/quran-tanzil.js";

vi.mock("../../src/log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/log.js")>()),
  createLogger: vi.fn(),
}));

vi.setConfig({ testTimeout: 60_000 });

let logs: Array<Record<string, unknown>>;
let restoreSignals: () => void;

beforeEach(() => {
  restoreSignals = trackSignalListeners();
  logs = [];
  vi.mocked(createLogger).mockImplementation(() =>
    pino({ level: "debug" }, { write: (line: string) => void logs.push(JSON.parse(line)) }),
  );
  for (const name of ["SONIOX_API_KEY", "CAPTIONS_CONTAINER", "TOKEN"]) vi.stubEnv(name, undefined);
  vi.stubEnv("TURJUMAN_TANZIL_URL", "http://127.0.0.1:9");
});

afterEach(() => {
  restoreSignals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

const BASE = "https://tanzil.test";
const messages = (): string[] => logs.map((l) => String(l.msg));
const memoryLog = () =>
  pino({ level: "debug" }, { write: (l: string) => void logs.push(JSON.parse(l)) });

/** Lets the background work run (promises, file writes, real timers). */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

/** A config folder (= DATA_DIR) with this config.yaml, loaded with an environment of its own. */
function install(yaml: string): { dir: string; loaded: LoadedConfig } {
  const dir = tempDir("first-start-");
  writeFileSync(join(dir, "config.yaml"), `languagesFile: ${LANGUAGES_FILE}\n${yaml}`);
  return { dir, loaded: loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir }) };
}

function placeQuran(dir: string, which: { translation?: boolean } = {}): void {
  mkdirSync(join(dir, "quran"), { recursive: true });
  writeFileSync(join(dir, "quran", "quran-simple-clean.txt"), SIMPLE);
  writeFileSync(join(dir, "quran", "quran-uthmani.txt"), UTHMANI);
  if (which.translation !== false) {
    writeFileSync(join(dir, "quran", "nl.siregar.txt"), String(ALL[transQuery("nl.siregar")]));
  }
}

describe("the Quran data of the caption blocks", () => {
  it("uses the data in place at once, without downloading anything", () => {
    const { dir, loaded } = install("");
    placeQuran(dir);
    const tanzil = fakeTanzil(ALL, BASE);
    const { deps, background } = createBlocksDeps(loaded, memoryLog(), {
      fetch: tanzil.fetch,
      baseUrl: BASE,
    });
    expect(background).toBeNull();
    expect(tanzil.calls).toEqual([]);
    expect(deps.followerFactory?.("nl").ready).toBe(true);
    expect(messages()).toEqual(["Quran matcher ready"]);
  });

  it("downloads missing data in the background: the sessions after it follow the Quran", async () => {
    const { dir, loaded } = install("");
    const { deps, background } = createBlocksDeps(loaded, memoryLog(), {
      fetch: fakeTanzil(ALL, BASE).fetch,
      baseUrl: BASE,
    });
    // A session that starts now has no Quran follower; nothing waits for the download.
    expect(deps.followerFactory?.("nl").ready).toBe(false);
    expect(messages()[0]).toBe(
      "Quran data missing (3 file(s)): downloading it in the background; verse references start once it is in place",
    );
    await until(() => messages().includes("Quran matcher ready"));
    expect(deps.followerFactory?.("nl").ready).toBe(true);
    expect(readFileSync(join(dir, "quran", "quran-simple-clean.txt"), "utf8")).toBe(SIMPLE);
    expect(messages()).toContain(
      "Quran data: complete (Tanzil Project, tanzil.net; terms in LICENSE-tanzil.txt)",
    );
    background?.stop();
  });

  it("uses the text at once when only a translation is missing, then loads the translation", async () => {
    const { dir, loaded } = install("");
    placeQuran(dir, { translation: false });
    const tanzil = fakeTanzil(ALL, BASE);
    const { deps } = createBlocksDeps(loaded, memoryLog(), { fetch: tanzil.fetch, baseUrl: BASE });
    expect(deps.followerFactory?.("nl").ready).toBe(true);
    await until(() => messages().filter((m) => m === "Quran matcher ready").length === 2);
    expect(tanzil.urls()).toEqual([transQuery("nl.siregar")]);
    // The missing translation was a problem of the first load only.
    expect(logs.filter((l) => l.msg === "Quran data problem")).toHaveLength(1);
  });

  it("without a download (a replay) names the command that gets the data", () => {
    const { loaded } = install("");
    const { deps, background } = createBlocksDeps(loaded, memoryLog(), undefined);
    expect(background).toBeNull();
    expect(deps.followerFactory?.("nl").ready).toBe(false);
    expect(messages().at(-1)).toBe(
      "Quran data missing: run pnpm exec tsx scripts/quran-data.ts (verse references are off until then)",
    );
    expect(createBlocksDeps(loaded, memoryLog(), null).background).toBeNull();
  });

  it("downloads nothing when Quran references are off", () => {
    const { loaded } = install("quran:\n  enabled: false\n");
    const tanzil = fakeTanzil(ALL, BASE);
    const { deps, background } = createBlocksDeps(loaded, memoryLog(), { fetch: tanzil.fetch });
    expect(background).toBeNull();
    expect(tanzil.calls).toEqual([]);
    expect(deps.followerFactory?.("nl").ready).toBe(false);
    expect(logs).toEqual([]);
  });
});

function serveWith(loaded: LoadedConfig, opts: Partial<ServeOptions> = {}) {
  const c = capture();
  const done = serve({
    loaded,
    io: c.io,
    dev: false,
    print: false,
    fakeProviderFile: null,
    fakeSpeed: 1,
    fakeLoop: false,
    silentAudio: true,
    autoStart: null,
    ...opts,
  });
  return { c, done };
}

function withPort(loaded: LoadedConfig, port: number): LoadedConfig {
  return { ...loaded, config: { ...loaded.config, server: { ...loaded.config.server, port } } };
}

describe("serve: a first start", () => {
  it("says it made config.yaml and where the admin token is, never the token, and stops the download", async () => {
    const port = await freePort();
    const dir = tempDir("first-start-");
    const created = join(dir, "config.yaml");
    writeFileSync(created, `${newConfigYaml("hosted")}languagesFile: ${LANGUAGES_FILE}\n`);
    const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
    const token = loaded.config.server.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const offline = fakeTanzil({}, BASE);
    const { c, done } = serveWith(
      { ...withPort(loaded, port), createdConfigFile: created },
      { quranDownload: { fetch: offline.fetch, baseUrl: BASE, retryMs: [50] } },
    );
    await until(() => c.out.length > 0);
    expect(c.out[0]).toContain(`  Website:          http://127.0.0.1:${port}/`);
    expect(messages()).toContain(
      `Created ${created} (mode hosted, exposure public); edit it and restart to change a setting`,
    );
    expect(messages()).toContain(
      `Admin token: kept in ${join(dir, "admin.token")}; the CLI and make read it from there`,
    );
    // The server keeps trying the download while it serves.
    await until(() => offline.calls.length >= 6);
    process.emit("SIGTERM", "SIGTERM");
    expect(await done).toBe(0);
    const calls = offline.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(offline.calls.length).toBe(calls);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it("stops the download when the port is taken", async () => {
    const port = await freePort();
    const holder: Server = createServer();
    await new Promise<void>((r) => holder.listen(port, "127.0.0.1", r));
    try {
      const { loaded } = install(`server:\n  port: ${port}\n`);
      let aborted: AbortSignal | null = null;
      const hanging = fakeTanzil(
        {
          [TEXT_QUERY]: (signal) => {
            aborted = signal;
            return new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason)),
            );
          },
        },
        BASE,
      );
      const { c, done } = serveWith(loaded, {
        quranDownload: { fetch: hanging.fetch, baseUrl: BASE },
      });
      expect(await done).toBe(1);
      expect(c.err[0]).toMatch(new RegExp(`^Port ${port} is in use`));
      await until(() => aborted !== null);
      expect((aborted as AbortSignal | null)?.aborted).toBe(true);
      // Nothing is asked for after the stop.
      await new Promise((r) => setTimeout(r, 100));
      expect(hanging.urls()).toEqual([TEXT_QUERY]);
    } finally {
      await new Promise((r) => holder.close(r));
    }
  });
});

describe("turjuman start and run: config.yaml on a first start", () => {
  const expected = `mode ${DEPLOYMENT}, exposure ${DEPLOYMENT === "hosted" ? "public" : "local"}`;

  function fakeRun() {
    const calls: string[][] = [];
    const run = async (args: string[], io: { out(t: string): void }): Promise<number> => {
      calls.push(args);
      io.out("Turjuman server running (test)");
      return 0;
    };
    return { run, calls };
  }

  it("start makes config.yaml for this deployment and says so, once", async () => {
    const dir = tempDir("first-start-");
    const env: NodeJS.ProcessEnv = {
      CONFIG_DIR: dir,
      DATA_DIR: dir,
      SONIOX_API_KEY: "fake-key-00000000000",
    };
    const c = capture();
    expect(await startCommand([], c.io, { run: fakeRun().run, env, cwd: dir, lan: null })).toBe(0);
    expect(c.err).toEqual([`Created ${join(dir, "config.yaml")} (${expected}).`]);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(newConfigYaml(DEPLOYMENT));
    const again = capture();
    await startCommand([], again.io, { run: fakeRun().run, env, cwd: dir, lan: null });
    expect(again.err).toEqual([]);
  });

  it("start and run make nothing with --dry-run", async () => {
    const dir = tempDir("first-start-");
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, DATA_DIR: dir };
    const c = capture();
    await startCommand(["--dry-run"], c.io, { run: fakeRun().run, env, cwd: dir, lan: null });
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await runCommand(["--dry-run"], capture().io);
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);
  });
});
