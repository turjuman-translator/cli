// The server commands as an operator runs them: `start`, `run` and `replay` in temp installs on
// free ports (stopped with Ctrl-C), and the commands that talk to a running server: `status`,
// `ctl`, `sessions`, `usage` and `open`. Engines are provider logs (test/fixtures/soniox-*.jsonl)
// and every process is in the network jail: nothing reaches Soniox.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import type { Segment } from "../../../src/shared/protocol.js";
import { turjuman } from "../helpers/cli.js";
import {
  audioBridge,
  baseYaml,
  Cleanup,
  type CliInstall,
  cliInstall,
  fakeProgram,
  listenWs,
  spawnCli,
  waitUntil,
} from "../helpers/cli-tools.js";
import { freePort, randomToken, writeWav } from "../helpers/instance.js";
import { REPO } from "../helpers/paths.js";
import { type Server, startServer } from "../helpers/server.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

const VERSION = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
).version;
const PAUSES = join(REPO, "test", "fixtures", "soniox-tts-pauses.jsonl");

async function install(opts: Parameters<typeof cliInstall>[0] = {}): Promise<CliInstall> {
  const inst = await cliInstall(opts);
  cleanup.add(() => inst.remove());
  return inst;
}

async function serve(
  inst: CliInstall,
  command: "run" | "start" | "replay",
  args: string[] = [],
): Promise<Server> {
  const srv = await startServer(inst, inst.port, { command, args });
  cleanup.add(() => srv.stop());
  return srv;
}

function waitForLog(srv: Server, pattern: RegExp | string, timeoutMs = 15_000): Promise<true> {
  return waitUntil(
    () => `${String(pattern)} in the server's output:\n${srv.logs()}`,
    () => (typeof pattern === "string" ? srv.logs().includes(pattern) : pattern.test(srv.logs())),
    timeoutMs,
  );
}

/** The session folder DATA_DIR/transcripts/<YYYY-MM-DD_HHmm>_<id>. */
function sessionFolder(inst: CliInstall, id: string): string {
  const root = join(inst.dataDir, "transcripts");
  const name = readdirSync(root).find((n) => n.endsWith(`_${id}`));
  if (name === undefined) throw new Error(`no transcript folder for ${id} in ${root}`);
  return join(root, name);
}

function markers(folder: string): Array<Record<string, unknown>> {
  return readFileSync(join(folder, "session.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function localSessionId(statusOut: string): string {
  const id = /^Local session: live \(file, ar→nl, id (\w+)\)$/m.exec(statusOut)?.[1];
  if (id === undefined) throw new Error(`no live local session in:\n${statusOut}`);
  return id;
}

describe.concurrent("turjuman start and run", () => {
  it("start prints the server banner and where to open the app, and stops cleanly on Ctrl-C", async ({
    expect,
  }) => {
    const inst = await install();
    const srv = await serve(inst, "start");
    const url = srv.url;
    await waitForLog(srv, "Caption look:");
    const logs = srv.logs();
    for (const line of [
      `Turjuman server running (v${VERSION}, exposure local)`,
      `  Caption link:     ${url}/`,
      `  Caption page:     ${url}/ar/nl`,
      `  Overlay / dock:   ${url}/overlay   ${url}/control`,
      `  Health:           ${url}/health`,
      "Open the app:",
      `  Screens (dashboard):  ${url}/app`,
      `  New screen (builder): ${url}/app/new`,
      `  Caption look:         ${url}/app/look`,
      'No Soniox API key yet: run "pnpm turjuman setup", or add it in the app under Keys. The server starts anyway.',
    ]) {
      expect(logs).toContain(line);
    }
    for (const path of ["/", "/ar/nl", "/overlay", "/control", "/health", "/app", "/app/new"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status, path).toBe(200);
    }
    await srv.stop();
    expect(await srv.exited()).toEqual({ code: 0, signal: null });
    expect(srv.logs()).toContain('"msg":"shutting down"');
    expect(inst.netAttempts()).toEqual([]);
  });

  it("run --config serves the caption pages of another config file without the app addresses, and stops on SIGTERM", async ({
    expect,
  }) => {
    const inst = await install({ yaml: null });
    const other = inst.file("mosque.yaml", baseYaml(inst.port, "pages:\n  defaultTo: en\n"));
    // Like `docker stop`: SIGTERM instead of Ctrl-C.
    const run = spawnCli(inst, ["run", "--config", other]);
    cleanup.add(() => run.stop("SIGKILL"));
    await run.waitFor("Health:");
    const url = `http://127.0.0.1:${inst.port}`;
    expect(run.stdout()).toContain(`  Caption page:     ${url}/ar/en\n`);
    expect(run.stdout()).toContain(`Turjuman server running (v${VERSION}, exposure local)\n`);
    expect(run.output()).not.toContain("Open the app:");
    expect(run.output()).not.toContain("No Soniox API key yet");
    expect((await fetch(`${url}/ar/nl`)).status).toBe(200);
    expect(await run.stop("SIGTERM")).toEqual({ code: 0, signal: null });
    expect(run.output()).toContain('"signal":"SIGTERM","msg":"shutting down"');
  });

  it("run says when its port is in use and points at turjuman status", async ({ expect }) => {
    const inst = await install();
    const blocker = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(inst.port, "127.0.0.1", resolve));
    cleanup.add(() => new Promise((resolve) => blocker.close(resolve)));
    const r = await turjuman(inst, ["run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `Port ${inst.port} is in use: is Turjuman running already? (pnpm turjuman status)\n` +
        "To use another port, set server.port in config.yaml (start from config.example.yaml).",
    );
  });

  it("run --dev logs for a person to read and starts the page watcher", async ({ expect }) => {
    const inst = await install();
    const srv = await serve(inst, "run", ["--dev"]);
    await waitForLog(srv, "Health:");
    expect(srv.logs()).toMatch(/INFO.*Server listening at/);
    expect(srv.logs()).not.toMatch(/^\{"level"/m);
    await srv.stop();
    expect((await srv.exited()).code).toBe(0);
  });

  it("run --fake-provider --file plays a recording through a provider log and --print prints the captions", async ({
    expect,
  }) => {
    const inst = await install();
    const wav = writeWav(join(inst.dir, "khutbah.wav"), { seconds: 6, tone: true });
    const srv = await serve(inst, "run", ["--fake-provider", PAUSES, "--file", wav, "--print"]);
    await waitForLog(srv, "Local session: live");
    expect(srv.logs()).toContain(
      `Turjuman server running (v${VERSION}, exposure local, FAKE provider)`,
    );
    await waitForLog(
      srv,
      /\[soniox #1\] بسم الله الرحمن الرحيم\.\n {8}nl: In de naam van Allah, de Meest Barmhartige, de Meest Genadevolle\./,
    );
    // The recording ends after 6 s, and with it the session; the server keeps running.
    await waitUntil("the end of the recording", async () => {
      const r = await turjuman(inst, ["ctl", "sessions"]);
      return r.stdout === "No active sessions.\n";
    });
    const sessions = await turjuman(inst, ["sessions"]);
    expect(sessions.code).toBe(0);
    expect(sessions.stdout).toMatch(
      /^\w+\s+.+\s+file\s+ar→nl\s+soniox\s+0m0\ds\s+\d+ seg {2}file ended$/m,
    );
    await srv.stop();
    expect((await srv.exited()).code).toBe(0);
    expect(inst.netAttempts()).toEqual([]);
  });

  it("run --file --loop repeats the recording until the session is stopped", async ({ expect }) => {
    const inst = await install();
    const wav = writeWav(join(inst.dir, "short.wav"), { seconds: 1, tone: true });
    const srv = await serve(inst, "run", ["--fake-provider", PAUSES, "--file", wav, "--loop"]);
    await waitForLog(srv, "Local session: live");
    // Three times as long as the recording: still live.
    await new Promise((r) => setTimeout(r, 3000));
    const status = await turjuman(inst, ["status"]);
    const id = localSessionId(status.stdout);
    const stop = await turjuman(inst, ["ctl", "stop"]);
    expect(stop).toMatchObject({ code: 0, stdout: "stopped (stopped from the API)\n" });
    expect(markers(sessionFolder(inst, id)).find((m) => m.type === "stop")).toMatchObject({
      reason: "stopped from the API",
    });
    await srv.stop();
  });

  it("start --config --file --loop rehearses with a recording from another config file", async ({
    expect,
  }) => {
    const inst = await install({ yaml: null });
    const other = inst.file("rehearsal.yaml", baseYaml(inst.port));
    const wav = writeWav(join(inst.dir, "short.wav"), { seconds: 1, tone: true });
    const srv = await serve(inst, "start", [
      "--config",
      other,
      "--file",
      wav,
      "--loop",
      "--fake-provider",
      PAUSES,
    ]);
    await waitForLog(srv, "Local session: live");
    expect(srv.logs()).toContain(`  Screens (dashboard):  ${srv.url}/app`);
    await new Promise((r) => setTimeout(r, 2500));
    const status = await turjuman(inst, ["status"], { env: { CAPTIONS_URL: srv.url } });
    expect(status.stdout).toMatch(/^Local session: live \(file, ar→nl, id \w+\)$/m);
    await srv.stop();
    expect((await srv.exited()).code).toBe(0);
  });

  it("start --start and run --start start the local session from the audio input (the audio bridge)", async ({
    expect,
  }) => {
    for (const command of ["start", "run"] as const) {
      const bridgePort = await freePort();
      const inst = await install({
        yaml: (port) =>
          baseYaml(
            port,
            `audio:\n  input:\n    kind: network\n    network:\n      port: ${bridgePort}\n`,
          ),
      });
      const bridge = audioBridge(bridgePort);
      cleanup.add(() => bridge.stop());
      const srv = await serve(inst, command, ["--start", "--fake-provider", PAUSES]);
      await waitForLog(srv, "Local session: live", 20_000);
      const status = await turjuman(inst, ["status"]);
      expect(status.stdout, command).toMatch(
        /^Local session: live \(audio bridge, ar→nl, id \w+\)$/m,
      );
      expect(status.stdout, command).toContain("  audio: ok (bridge connected)");
      bridge.stop();
      await srv.stop();
      expect((await srv.exited()).code, command).toBe(0);
    }
  });
});

describe.concurrent("turjuman replay", () => {
  it("replay plays a provider log: captions over /ws, --print, status, ctl sessions, sessions and transcripts", async ({
    expect,
  }) => {
    const inst = await install();
    const srv = await serve(inst, "replay", [PAUSES, "--speed", "3", "--print"]);
    await waitForLog(srv, "Local session: live");
    expect(srv.logs()).toContain(
      `Turjuman server running (v${VERSION}, exposure local, FAKE provider)`,
    );

    const ws = await listenWs(`ws://127.0.0.1:${inst.port}/ws`);
    cleanup.add(() => ws.close());
    const first = await ws.waitFor("the first caption over /ws", (m) => {
      if (m.type !== "segment") return undefined;
      const s = m.segment as Segment;
      return s.closed && s.translations.nl?.final === true ? s : undefined;
    });
    expect(first.source.text).toContain("بسم الله الرحمن الرحيم");
    expect(first.translations.nl?.text).toContain("In de naam van Allah");

    const status = await turjuman(inst, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stderr).toBe("");
    const id = localSessionId(status.stdout);
    expect(status.stdout).toMatch(
      new RegExp(
        `^Service: up \\(v${VERSION.replaceAll(".", "\\.")}, uptime \\d+m\\d{2}s, exposure local\\)$`,
        "m",
      ),
    );
    expect(status.stdout).toContain("  engine: soniox live");
    // A replay's input is silence: no device, no bridge.
    expect(status.stdout).toMatch(/^ {2}audio: ok \(replay: silent input\) {2}level: /m);
    expect(status.stdout).toContain("Active sessions: 1");
    expect(status.stdout).toMatch(new RegExp(`^ {2}${id} {2}file +ar→nl +soniox .* live$`, "m"));

    const ctl = await turjuman(inst, ["ctl", "sessions"]);
    expect(ctl.code).toBe(0);
    expect(ctl.stdout).toMatch(
      new RegExp(`^${id} {2}file {2}ar→nl {2}soniox {2}- {2}\\d+ s {2}\\d+\\.\\d min {2}live\n$`),
    );

    // --print: each finished caption, the Arabic and under it the Dutch.
    await waitForLog(srv, /^\[soniox #\d+\] \p{Script=Arabic}.*\n {8}nl: \p{Script=Latin}.*$/mu);
    await srv.stop();
    expect(await srv.exited()).toEqual({ code: 0, signal: null });

    // The transcripts, where the config says (DATA_DIR/transcripts).
    const folder = sessionFolder(inst, id);
    expect(readFileSync(join(folder, "soniox", "ar.srt"), "utf8")).toContain(
      "بسم الله الرحمن الرحيم",
    );
    expect(readFileSync(join(folder, "soniox", "nl.srt"), "utf8")).toContain(
      "In de naam van Allah",
    );
    const all = markers(folder);
    expect(all.find((m) => m.type === "start")).toMatchObject({
      kind: "file",
      from: "ar",
      to: "nl",
    });
    expect(all.find((m) => m.type === "stop")).toMatchObject({ reason: "signal SIGINT" });

    const sessions = await turjuman(inst, ["sessions"]);
    expect(sessions.code).toBe(0);
    const transcripts = join(inst.dataDir, "transcripts");
    expect(sessions.stdout).toMatch(
      new RegExp(
        `^${id}\\s+.+\\s+file\\s+ar→nl\\s+soniox\\s+\\d+m\\d{2}s\\s+\\d+ seg {2}signal SIGINT$`,
        "m",
      ),
    );
    expect(sessions.stdout).toMatch(
      new RegExp(`Folders: ${transcripts.replaceAll(/[.\\]/g, "\\$&")}\\n$`),
    );

    expect(inst.netAttempts()).toEqual([]);
  });

  it("sessions --limit shows that many sessions; usage --month shows another month", async ({
    expect,
  }) => {
    const inst = await install();
    const transcripts = join(inst.dataDir, "transcripts");
    const none = await turjuman(inst, ["sessions"]);
    expect(none).toMatchObject({ code: 0, stdout: `No sessions yet in ${transcripts}\n` });
    const srv = await serve(inst, "run", ["--fake-provider", PAUSES]);
    const wavs = join(inst.dataDir, "recordings");
    mkdirSync(wavs, { recursive: true });
    writeWav(join(wavs, "a.wav"), { seconds: 30, tone: true });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect((await turjuman(inst, ["ctl", "start", "--file", "a.wav"])).stdout).toBe("live\n");
      ids.push(localSessionId((await turjuman(inst, ["status"])).stdout));
      expect((await turjuman(inst, ["ctl", "stop"])).code).toBe(0);
    }
    await srv.stop();
    // Newest first by their start time (both started within the same minute, most likely).
    const both = await turjuman(inst, ["sessions"]);
    const listed = both.stdout.split("\n").filter((l) => /^\w{8} /.test(l));
    expect(listed.map((l) => l.slice(0, 8))).toEqual([ids[1], ids[0]]);
    const one = await turjuman(inst, ["sessions", "--limit", "1"]);
    const lines = one.stdout.split("\n").filter((l) => /^\w{8} /.test(l));
    expect(lines.map((l) => l.slice(0, 8))).toEqual([ids[1]]);

    const old = await turjuman(inst, ["usage", "--month", "2020-01"]);
    expect(old.code).toBe(0);
    expect(old.stdout).toBe(
      `Streamed minutes per key and engine (month 2020-01)\nNo usage recorded (${join(inst.dataDir, "usage")}).\n`,
    );
    const wrong = await turjuman(inst, ["usage", "--month", "2026/10"]);
    expect(wrong).toMatchObject({ code: 2, stderr: "usage: --month must look like 2026-10\n" });
  });

  it("replay --loop starts the provider log over at its end; replay --config reads another config file", async ({
    expect,
  }) => {
    const once = await install();
    const looped = await install({ yaml: null });
    const other = looped.file("replay.yaml", baseYaml(looped.port));
    const a = await serve(once, "replay", [PAUSES, "--speed", "40"]);
    const b = await serve(looped, "replay", [PAUSES, "--speed", "40", "--loop", "--config", other]);
    await waitForLog(a, "Local session: live");
    await waitForLog(b, "Local session: live");
    const idA = localSessionId((await turjuman(once, ["status"])).stdout);
    const idB = localSessionId(
      (await turjuman(looped, ["status"], { env: { CAPTIONS_URL: b.url } })).stdout,
    );
    // The log lasts 46 s, 1.2 s at speed 40: a loop announces itself as a provider reconnect.
    await waitUntil("a second pass of the looped replay", () =>
      markers(sessionFolder(looped, idB)).some((m) => m.type === "reconnect"),
    );
    expect(markers(sessionFolder(once, idA)).some((m) => m.type === "reconnect")).toBe(false);
    await Promise.all([a.stop(), b.stop()]);
    expect((await b.exited()).code).toBe(0);
  });

  // --print follows the local session from its start: caption #1 is done after 1.2 s at speed 3,
  // before the server's first 5-second heartbeat.
  it("replay --print prints the captions finished in the first seconds too", async ({ expect }) => {
    const inst = await install();
    const srv = await serve(inst, "replay", [PAUSES, "--speed", "3", "--print"]);
    await waitForLog(srv, "[soniox #3]");
    expect(srv.logs()).toContain("[soniox #1] بسم الله الرحمن الرحيم.");
  });

  // Faster than real time the log's words are placed in the audio this session sent: they never
  // end after they arrive. --print shows only the sides that have text.
  it("replay --speed --loop keeps the latencies positive, and --print never prints an empty side", async ({
    expect,
  }) => {
    const inst = await install();
    const srv = await serve(inst, "replay", [PAUSES, "--speed", "40", "--loop", "--print"]);
    await waitForLog(srv, "[soniox #15]", 20_000);
    const status = await turjuman(inst, ["status"]);
    const latencies = [...status.stdout.matchAll(/p(?:50|95) (-?\d+\.\d) s/g)].map((m) =>
      Number(m[1]),
    );
    expect(latencies.length, status.stdout).toBeGreaterThan(0);
    for (const value of latencies) expect(value, status.stdout).toBeGreaterThanOrEqual(0);
    expect(srv.logs()).not.toMatch(/^\[soniox #\d+\] $|^ {8}nl: ?$/m);
  });

  it("replay needs no Soniox key (no network, no cost)", async ({ expect }) => {
    const inst = await install();
    const srv = await serve(inst, "replay", [PAUSES, "--speed", "40"]);
    await waitForLog(srv, "Local session:");
    expect(srv.logs()).toContain("Local session: live");
    expect(inst.netAttempts()).toEqual([]);
  });
});

describe.concurrent("turjuman status and ctl", () => {
  it("ctl starts, clears, stops and kills the local session of a running server", async ({
    expect,
  }) => {
    const inst = await install();
    mkdirSync(join(inst.dataDir, "recordings"));
    writeWav(join(inst.dataDir, "recordings", "rehearsal.wav"), { seconds: 30, tone: true });
    const srv = await serve(inst, "run", ["--fake-provider", PAUSES]);
    const ctl = (...args: string[]) => turjuman(inst, ["ctl", ...args]);

    expect(await ctl("sessions")).toMatchObject({ code: 0, stdout: "No active sessions.\n" });
    expect(await ctl("clear")).toMatchObject({
      code: 1,
      stderr: "HTTP 409: No session to clear\n",
    });
    expect(await ctl("start", "--file", "rehearsal.wav")).toMatchObject({
      code: 0,
      stdout: "live\n",
    });
    const listed = await ctl("sessions");
    expect(listed.stdout).toMatch(
      /^\w{8} {2}file {2}ar→nl {2}soniox {2}- {2}\d+ s {2}\d+\.\d min {2}live\n$/,
    );
    expect(await ctl("clear")).toMatchObject({ code: 0, stdout: "Cleared\n" });
    expect(await ctl("stop")).toMatchObject({
      code: 0,
      stdout: "stopped (stopped from the API)\n",
    });
    expect(await ctl("stop")).toMatchObject({
      code: 0,
      stdout: "Nothing to stop: no local session is running\n",
    });
    expect(await ctl("start", "--file", "missing.wav")).toMatchObject({
      code: 1,
      stderr: "HTTP 400: Recording not found: missing.wav\n",
    });
    // Without --file: the configured input, which is off here.
    expect(await ctl("start")).toMatchObject({
      code: 1,
      stderr: "HTTP 409: device capture is disabled (audio.input.kind: none)\n",
    });

    expect((await ctl("start", "--file", "rehearsal.wav")).stdout).toBe("live\n");
    const id = /^(\w{8}) /.exec((await ctl("sessions")).stdout)?.[1] ?? "";
    expect(await ctl("kill", id)).toMatchObject({ code: 0, stdout: `Stopped session ${id}\n` });
    await waitUntil(
      "the killed session to end",
      async () => (await ctl("sessions")).stdout === "No active sessions.\n",
    );
    expect(await ctl("kill", "nosuchid")).toMatchObject({
      code: 1,
      stderr: "HTTP 404: No session nosuchid\n",
    });
    expect(await ctl("kill")).toMatchObject({ code: 2 });
    await srv.stop();
    expect((await srv.exited()).code).toBe(0);
  });

  it("status and ctl say when no server answers, or when it answers with an error", async ({
    expect,
  }) => {
    const inst = await install();
    const base = `http://127.0.0.1:${inst.port}`;
    const status = await turjuman(inst, ["status"]);
    expect(status.code).toBe(1);
    expect(status.stderr).toBe(`Service not reachable at ${base}: fetch failed\n`);
    for (const action of ["sessions", "stop", "clear", "start"]) {
      const r = await turjuman(inst, ["ctl", action]);
      expect(r.code, action).toBe(1);
      expect(r.stderr, action).toBe(`Service not reachable at ${base}: fetch failed\n`);
    }
    // CAPTIONS_URL points the CLI at another address: here a server that answers 500.
    const broken = createHttpServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "broken on purpose" }));
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    cleanup.add(() => new Promise((resolve) => broken.close(resolve)));
    const address = broken.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    const r = await turjuman(inst, ["status"], { env: { CAPTIONS_URL: `${url}/` } });
    expect(r).toMatchObject({ code: 1, stderr: `Service at ${url} answered HTTP 500\n` });
    const c = await turjuman(inst, ["ctl", "sessions"], { env: { CAPTIONS_URL: url } });
    expect(c).toMatchObject({ code: 1, stderr: "HTTP 500: broken on purpose\n" });
  });

  it("status, ctl and start on a hosted server: the operator's token comes from the config", async ({
    expect,
  }) => {
    const token = randomToken();
    const inst = await install({
      yaml: (port) =>
        `mode: hosted\nhosted:\n  signup: open\n${baseYaml(port).replace("server:\n", `server:\n  token: ${token}\n`)}`,
    });
    const srv = await serve(inst, "start");
    await waitForLog(srv, "Caption look:");
    for (const line of [
      `Turjuman server running (v${VERSION}, hosted, exposure local)`,
      `  Website:          ${srv.url}/`,
      `  App:              ${srv.url}/app`,
      `  Screens (dashboard):  ${srv.url}/app`,
    ]) {
      expect(srv.logs()).toContain(line);
    }
    expect(srv.logs()).not.toContain("No Soniox API key yet");

    const status = await turjuman(inst, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(
      /^Service: up \(v.+, exposure local\)\nLocal session: none\nActive sessions: 0\n$/,
    );
    expect(await turjuman(inst, ["ctl", "sessions"])).toMatchObject({
      code: 0,
      stdout: "No active sessions.\n",
    });
    expect(
      await turjuman(inst, ["ctl", "sessions"], { env: { CAPTIONS_TOKEN: token } }),
    ).toMatchObject({ code: 0 });
    const wrong = await turjuman(inst, ["ctl", "sessions"], { env: { TOKEN: "not-the-token" } });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toBe(
      "HTTP 401: Admin login required: log in at /login as an admin, or use the admin token (Authorization: Bearer <token> or ?token=)\n",
    );
    await srv.stop();
    expect((await srv.exited()).code).toBe(0);
  });

  /** A hosted server whose local session plays a recording (provider log, no key needed). */
  async function hostedLive(token: string): Promise<{ inst: CliInstall; srv: Server }> {
    const inst = await install({
      yaml: (port) =>
        `mode: hosted\n${baseYaml(port).replace("server:\n", `server:\n  token: ${token}\n`)}`,
    });
    const wav = writeWav(join(inst.dir, "khutbah.wav"), { seconds: 30, tone: true });
    const srv = await serve(inst, "run", ["--fake-provider", PAUSES, "--file", wav]);
    await waitForLog(srv, "Local session: live");
    return { inst, srv };
  }

  it("status on a hosted server shows the sessions to the operator's TOKEN; ctl uses the config's token", async ({
    expect,
  }) => {
    const token = randomToken();
    const { inst } = await hostedLive(token);
    const status = await turjuman(inst, ["status"], { env: { TOKEN: token } });
    expect(status.stdout).toMatch(/^Local session: live \(file, ar→nl, id \w+\)$/m);
    expect(status.stdout).toContain("Active sessions: 1\n");
    const ctl = await turjuman(inst, ["ctl", "sessions"]);
    expect(ctl.stdout).toMatch(
      /^\w{8} {2}file {2}ar→nl {2}soniox {2}- {2}\d+ s {2}\d+\.\d min {2}live\n$/,
    );
  });

  // Like ctl, status sends server.token from the config: a hosted server's /health shows its
  // sessions only to it (and `make status` runs `turjuman status` next to the server).
  it("status on a hosted server shows its sessions with the operator's token from the config", async ({
    expect,
  }) => {
    const { inst } = await hostedLive(randomToken());
    const status = await turjuman(inst, ["status"]);
    expect(status.stdout).toMatch(/^Local session: live \(file, ar→nl, id \w+\)$/m);
    expect(status.stdout).toContain("Active sessions: 1\n");
  });
});

describe.concurrent("turjuman estimate", () => {
  it("estimate start prints the cost of a session per minute and per hour from the config's prices", async ({
    expect,
  }) => {
    const inst = await install();
    expect(await turjuman(inst, ["estimate", "start"])).toMatchObject({
      code: 0,
      stderr: "",
      stdout:
        "Estimated cost: $0.0030/min (≈ $0.18/hour) for Soniox, billed while the session runs.\n",
    });
    const priced = await install({
      yaml: (port) =>
        baseYaml(port, "pricing:\n  sonioxSttPerHour: 6\n  sonioxTranslationPerHour: 3\n"),
    });
    expect((await turjuman(priced, ["estimate", "start"])).stdout).toBe(
      "Estimated cost: $0.15/min (≈ $9.00/hour) for Soniox, billed while the session runs.\n",
    );
    expect(await turjuman(inst, ["estimate"])).toMatchObject({
      code: 2,
      stderr: "usage: turjuman estimate start\n",
    });
  });
});

describe.concurrent("turjuman open", () => {
  /** The program the CLI starts to open an address, and the environment it needs. */
  const opener = process.platform === "darwin" ? "open" : "xdg-open";

  it("open opens the app, the builder and the look editor in the browser of this computer", async ({
    expect,
  }) => {
    const inst = await install();
    const bin = join(inst.dir, "bin");
    const browser = fakeProgram(bin, opener);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, DISPLAY: ":0" };
    const srv = await serve(inst, "run");
    const pages: Array<[string[], string, string]> = [
      [[], "the app", "/app"],
      [["app"], "the app", "/app"],
      [["builder"], "the builder", "/app/new"],
      [["look"], "the look editor", "/app/look"],
    ];
    for (const [args, label, path] of pages) {
      const r = await turjuman(inst, ["open", ...args], { env });
      expect(r, args.join(" ")).toMatchObject({
        code: 0,
        stdout: `Opening ${label}: ${srv.url}${path}\n`,
        stderr: "",
      });
      expect((await fetch(`${srv.url}${path}`)).status, path).toBe(200);
    }
    expect(browser.calls()).toEqual(pages.map(([, , path]) => `${srv.url}${path}`));
  });

  it("open uses hosted.publicUrl when it is set", async ({ expect }) => {
    const inst = await install({
      yaml: (port) => baseYaml(port, "hosted:\n  publicUrl: https://captions.example.org/\n"),
    });
    const bin = join(inst.dir, "bin");
    const browser = fakeProgram(bin, opener);
    const r = await turjuman(inst, ["open", "look"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, DISPLAY: ":0" },
    });
    expect(r).toMatchObject({
      code: 0,
      stdout: "Opening the look editor: https://captions.example.org/app/look\n",
    });
    expect(browser.calls()).toEqual(["https://captions.example.org/app/look"]);
  });

  it("open says so when no browser can be started, and refuses an unknown page", async ({
    expect,
  }) => {
    const inst = await install();
    const empty = join(inst.dir, "empty-bin");
    mkdirSync(empty);
    const r = await turjuman(inst, ["open"], { env: { PATH: empty, DISPLAY: ":0" } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(`Opening the app: http://127.0.0.1:${inst.port}/app\n`);
    expect(r.stderr).toBe(
      `Could not start a browser (${opener}: spawn ${opener} ENOENT); open the address yourself.\n`,
    );
    for (const args of [["nope"], ["app", "look"]]) {
      const bad = await turjuman(inst, ["open", ...args]);
      expect(bad.code, args.join(" ")).toBe(2);
      expect(
        bad.stderr.startsWith(
          "open: choose app, builder or look\n\nturjuman open [app|builder|look]",
        ),
      ).toBe(true);
    }
  });
});
