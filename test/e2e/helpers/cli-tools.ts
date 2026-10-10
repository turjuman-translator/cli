// Tools for the CLI end-to-end suites (test/e2e/cli/): installs whose processes live in the
// network jail (cli-net-jail.ts), a fake Soniox, long-running commands, polling, a /ws listener,
// fake programs on PATH and a fake audio bridge.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, type Instance, makeInstance } from "./instance.js";
import { MAIN, REPO } from "./paths.js";

/** The preload that keeps every process of a CLI install off the network. */
export const JAIL = fileURLToPath(new URL("./cli-net-jail.ts", import.meta.url));

/** Things to undo after a test file, in reverse order. */
export class Cleanup {
  private readonly fns: Array<{ fn: () => unknown; label: string }> = [];

  add(fn: () => unknown, label = fn.toString().slice(0, 80)): void {
    this.fns.push({ fn, label });
  }

  /** Runs every step (each at most 15 s); throws afterwards when one failed or hung. */
  async run(): Promise<void> {
    const problems: string[] = [];
    for (const { fn, label } of this.fns.reverse()) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), 15_000);
      });
      try {
        if ((await Promise.race([Promise.resolve().then(fn), timeout])) === "hung") {
          problems.push(`hung: ${label}`);
        }
      } catch (err) {
        problems.push(`failed: ${label}: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    this.fns.length = 0;
    if (problems.length > 0) throw new Error(`cleanup:\n${problems.join("\n")}`);
  }
}

/** What the jail recorded: one entry per connection to another computer. */
export interface NetAttempt {
  pid: number;
  host: string;
  port: number;
  action: "blocked" | "redirected";
  to?: string;
}

export interface CliInstall extends Instance {
  /** server.port of its config.yaml (a free port when it was made). */
  port: number;
  /** The jail's log of this install's processes. */
  netAttempts(): NetAttempt[];
  /** A file in the install's folder (written when `text` is given). */
  file(name: string, text?: string): string;
}

/** The default config: a free port, and no Quran data (nothing to download). */
export function baseYaml(port: number, extra = ""): string {
  return `server:\n  port: ${port}\nquran:\n  enabled: false\n${extra}`;
}

/**
 * A temp install (instance.ts) whose processes are in the network jail: connections to other
 * computers are refused (logged in net.log), or go to the fake Soniox when one is given.
 */
export async function cliInstall(
  opts: {
    /** config.yaml for the port; null = no config.yaml. Default: baseYaml(port). */
    yaml?: ((port: number) => string) | null;
    env?: NodeJS.ProcessEnv;
    soniox?: FakeSoniox;
  } = {},
): Promise<CliInstall> {
  const port = await freePort();
  const inst = makeInstance(opts.yaml === null ? {} : { yaml: (opts.yaml ?? baseYaml)(port) });
  const netLog = join(inst.dir, "net.log");
  const redirects = opts.soniox === undefined ? "" : opts.soniox.redirects;
  Object.assign(
    inst.env,
    {
      NODE_OPTIONS: [inst.env.NODE_OPTIONS, `--import="${JAIL}"`].filter(Boolean).join(" "),
      E2E_NET_LOG: netLog,
      E2E_NET_REDIRECT: redirects,
    },
    opts.soniox === undefined ? {} : { NODE_EXTRA_CA_CERTS: opts.soniox.ca },
    opts.env,
  );
  return {
    ...inst,
    port,
    netAttempts: () =>
      existsSync(netLog)
        ? readFileSync(netLog, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as NetAttempt)
        : [],
    file: (name, text) => {
      const path = join(inst.dir, name);
      if (text !== undefined) writeFileSync(path, text);
      return path;
    },
  };
}

/** Poll `check` until it returns a value other than undefined/false. */
export async function waitUntil<T>(
  what: string | (() => string),
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      const text = typeof what === "string" ? what : what();
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${text}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A command that keeps running (`run`, `record`, `run --dry-run`, …) until it ends or is stopped. */
export interface RunningCli {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** stdout and stderr, in the order they came. */
  output(): string;
  /** Resolves when the output matches. */
  waitFor(pattern: RegExp | string, timeoutMs?: number): Promise<void>;
  exited: Promise<Exit>;
  /** Send a signal (Ctrl-C: SIGINT) and wait for the exit (SIGKILL after 15 s). */
  stop(signal?: NodeJS.Signals): Promise<Exit>;
}

export function spawnCli(
  inst: Instance,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): RunningCli {
  const child = spawn(process.execPath, [MAIN, ...args], {
    cwd: inst.dir,
    env: { ...inst.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let all = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
    all += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
    all += d.toString();
  });
  child.stdin?.end(opts.input ?? "");
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let done = false;
  void exited.then(() => {
    done = true;
  });
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    output: () => all,
    waitFor: async (pattern, timeoutMs = 15_000) => {
      const matches = (): boolean =>
        typeof pattern === "string" ? all.includes(pattern) : pattern.test(all);
      await waitUntil(
        () => `${String(pattern)} from turjuman ${args.join(" ")}\n--- output so far:\n${all}`,
        () => matches() || (done ? Promise.reject(new Error(`exited first:\n${all}`)) : false),
        timeoutMs,
      );
    },
    exited,
    stop: async (signal = "SIGINT") => {
      if (!done) {
        const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.kill(signal);
        const exit = await exited;
        clearTimeout(kill);
        return exit;
      }
      return exited;
    },
  };
}

/** The /ws messages of a server (the overlay's view of the local session). */
export interface WsListener {
  messages: Array<Record<string, unknown>>;
  waitFor<T>(what: string, pick: (msg: Record<string, unknown>) => T | undefined): Promise<T>;
  close(): void;
}

export async function listenWs(url: string): Promise<WsListener> {
  const ws = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    messages.push(JSON.parse(String(e.data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket ${url} failed`)), {
      once: true,
    });
  });
  return {
    messages,
    waitFor: (what, pick) =>
      waitUntil(what, () => {
        for (const m of messages) {
          const v = pick(m);
          if (v !== undefined) return v;
        }
        return undefined;
      }),
    close: () => ws.close(),
  };
}

/** A caption page's socket (/ws/page) after its hello: the server's first answer, and more. */
export interface PageSocket {
  /** "ready", "error" or "screen" (a switched-off screen parks the page). */
  first: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  send(data: string | Uint8Array): void;
  close(): void;
}

/** Open /ws/page like a caption page does (16 kHz mono PCM), with an access key or screen link. */
export async function openPage(
  base: string,
  hello: { from: string; to: string; key?: string; screen?: { guid: string } },
): Promise<PageSocket> {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/page`);
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") messages.push(JSON.parse(e.data) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("/ws/page failed")), { once: true });
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      resume: null,
      client: { obs: false, ua: "turjuman e2e" },
      format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
      ...hello,
    }),
  );
  const first = await waitUntil("the server's answer to the page's hello", () =>
    messages.find((m) => m.type === "ready" || m.type === "error" || m.type === "screen"),
  );
  return {
    first,
    messages,
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

/** Log in to the app (POST /api/auth/login): the status, the answer and the login cookie. */
export async function login(
  base: string,
  name: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown>; cookie: string }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      name.includes("@") ? { email: name, password } : { username: name, password },
    ),
  });
  const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cookie };
}

/** GET an app API route with a login cookie. */
export async function getJson(
  base: string,
  path: string,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}

/** A program on PATH that only writes its arguments, one call per line, to <dir>/<name>.log. */
export function fakeProgram(dir: string, name: string): { calls(): string[] } {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${name}.log`);
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(bin, 0o755);
  return {
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((l) => l !== "")
        : [],
  };
}

/**
 * A fake audio bridge (scripts/audio-bridge.sh without a sound card): connects to ffmpeg's
 * listening tcp port and streams a 440 Hz tone as raw s16le, 48 kHz stereo, in real time,
 * connecting again whenever ffmpeg closes the connection (an idle monitor handing over to a
 * session), until stopped.
 */
export function audioBridge(port: number): { sentBytes(): number; stop(): void } {
  const rate = 48_000;
  const chunkFrames = rate / 10;
  let n = 0;
  let sent = 0;
  let socket: Socket | null = null;
  let stopped = false;
  const dial = (): void => {
    if (stopped) return;
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      socket = s;
    });
    s.on("error", () => {});
    s.once("close", () => {
      if (socket === s) socket = null;
      setTimeout(dial, 100);
    });
  };
  dial();
  const timer = setInterval(() => {
    const buf = Buffer.alloc(chunkFrames * 4);
    for (let i = 0; i < chunkFrames; i++, n++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * n) / rate) * 8000);
      buf.writeInt16LE(v, i * 4);
      buf.writeInt16LE(v, i * 4 + 2);
    }
    if (socket !== null && !socket.destroyed) {
      socket.write(buf);
      sent += buf.length;
    }
  }, 100);
  return {
    sentBytes: () => sent,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      socket?.destroy();
    },
  };
}

/** The Soniox hosts the CLI talks to: the model list (key checks) and the streaming endpoint. */
export const SONIOX_HOSTS = [
  "api.soniox.com",
  "api.eu.soniox.com",
  "stt-rt.soniox.com",
  "stt-rt.eu.soniox.com",
];

export interface FakeSonioxRequest {
  host: string;
  method: string;
  path: string;
  authorization: string | null;
}

/**
 * A stand-in for Soniox on 127.0.0.1: an HTTPS server with a certificate for the Soniox host
 * names, made by the repository's own scripts/lan-cert.sh (its CA goes to NODE_EXTRA_CA_CERTS).
 * The jail sends the processes' connections to the Soniox hosts here.
 */
export interface FakeSoniox {
  /** The CA file for NODE_EXTRA_CA_CERTS. */
  ca: string;
  /** E2E_NET_REDIRECT for the jail. */
  redirects: string;
  requests: FakeSonioxRequest[];
  /** TLS handshakes (the doctor's check makes one without a request). */
  handshakes(): number;
  /** The answer of GET /v1/models for a bearer key (default: 200 with stt-rt-v5). */
  answer: (key: string | null) => { status: number; body?: unknown };
  close(): Promise<void>;
}

export async function startFakeSoniox(dir: string): Promise<FakeSoniox> {
  const tls = join(dir, "fake-soniox-tls");
  execFileSync("bash", [join(REPO, "scripts", "lan-cert.sh"), tls], {
    env: { ...process.env, LAN_NAMES: SONIOX_HOSTS.join(" ") },
    stdio: "pipe",
  });
  let handshakes = 0;
  const fake: FakeSoniox = {
    ca: join(tls, "ca.crt"),
    redirects: "",
    requests: [],
    handshakes: () => handshakes,
    answer: () => ({ status: 200, body: { models: [{ id: "stt-rt-v5" }] } }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const server = createHttpsServer(
    { key: readFileSync(join(tls, "server.key")), cert: readFileSync(join(tls, "server.crt")) },
    (req, res) => {
      const auth = req.headers.authorization ?? null;
      fake.requests.push({
        host: req.headers.host ?? "",
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: auth,
      });
      const key = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
      const { status, body } =
        req.url === "/v1/models" ? fake.answer(key) : { status: 404, body: { error: "not found" } };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    },
  );
  server.on("secureConnection", () => {
    handshakes++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  fake.redirects = SONIOX_HOSTS.map((h) => `${h}:443=127.0.0.1:${port}`).join(",");
  return fake;
}
