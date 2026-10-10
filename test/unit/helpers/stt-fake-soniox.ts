// Test doubles for src/stt/soniox.ts: a local fake Soniox real-time server (Fastify +
// @fastify/websocket on port 0, never the real Soniox), a WebSocket with injectable faults, and a
// pino-like logger whose messages can be read.
import { createServer, type Server, type Socket } from "node:net";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { RawData, WebSocket as WsSocket } from "ws";
import {
  SonioxProvider,
  type SonioxProviderOptions,
  type SonioxTimings,
} from "../../../src/stt/soniox.js";
import type { ProviderEvent } from "../../../src/stt/types.js";

/** One client connection as the fake Soniox server sees it. */
export interface ServerConn {
  /** The session config: the first text message, parsed. */
  config: Record<string, unknown> | null;
  /** Binary audio frames in arrival order. */
  frames: Uint8Array[];
  /** Text messages after the config: "keepalive", "finalize", "" (end of stream) or raw text. */
  controls: string[];
  /** Set when the client closed the connection. */
  closed: { code: number; reason: string } | null;
  send(frame: Record<string, unknown>): void;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface FakeSonioxHandlers {
  /** A connection is open (before its config arrives). */
  connect(conn: ServerConn): void;
  config(conn: ServerConn): void;
  control(conn: ServerConn, type: string): void;
  /** End of stream (an empty text message). Default: `finished`, then close. */
  end(conn: ServerConn): void;
}

const finishAndClose = (conn: ServerConn): void => {
  conn.send({ tokens: [], finished: true });
  conn.close(1000, "");
};

export interface FakeSoniox {
  /** ws:// URL of the transcribe endpoint. */
  url: string;
  /** A URL whose upgrade is refused (HTTP 403). */
  refusingUrl: string;
  conns: ServerConn[];
  on: FakeSonioxHandlers;
  /** Answer the next upgrade only after this many ms. */
  delayNextUpgrade(ms: number): void;
  close(): Promise<void>;
}

function controlType(text: string): string {
  if (text === "") return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return String(parsed.type);
    }
  } catch {
    // not JSON: kept as it is
  }
  return text;
}

function wrap(socket: WsSocket): ServerConn {
  const conn: ServerConn = {
    config: null,
    frames: [],
    controls: [],
    closed: null,
    send: (frame) => socket.send(JSON.stringify(frame)),
    sendText: (text) => socket.send(text),
    sendBinary: (bytes) => socket.send(bytes),
    close: (code, reason) => socket.close(code, reason),
  };
  return conn;
}

export async function startFakeSoniox(): Promise<FakeSoniox> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(websocket);
  const conns: ServerConn[] = [];
  const on: FakeSonioxHandlers = {
    connect: () => {},
    config: () => {},
    control: () => {},
    end: finishAndClose,
  };
  let upgradeDelayMs = 0;
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/refuse") {
      await reply.code(403).send("forbidden");
      return;
    }
    const delay = upgradeDelayMs;
    upgradeDelayMs = 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  });
  app.get("/transcribe-websocket", { websocket: true }, (socket) => {
    const conn = wrap(socket);
    conns.push(conn);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (isBinary) {
        conn.frames.push(new Uint8Array(buf));
        return;
      }
      const text = buf.toString("utf8");
      if (conn.config === null) {
        conn.config = JSON.parse(text) as Record<string, unknown>;
        on.config(conn);
        return;
      }
      const type = controlType(text);
      conn.controls.push(type);
      if (type === "") on.end(conn);
      else on.control(conn, type);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      conn.closed = { code, reason: reason.toString("utf8") };
    });
    on.connect(conn);
  });
  app.get("/refuse", async () => "never reached");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const base = `ws://127.0.0.1:${address.port}`;
  return {
    url: `${base}/transcribe-websocket`,
    refusingUrl: `${base}/refuse`,
    conns,
    on,
    delayNextUpgrade(ms) {
      upgradeDelayMs = ms;
    },
    async close() {
      for (const client of app.websocketServer.clients) client.terminate();
      await app.close();
    },
  };
}

/** A TCP server that accepts connections and never answers (a WebSocket stays connecting). */
export async function startSilentServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `ws://127.0.0.1:${address.port}/transcribe-websocket`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// --- faults ------------------------------------------------------------------------------------

type SendData = Parameters<WebSocket["send"]>[0];

export interface SocketFaults {
  /** A value to throw from send(), or undefined to send normally. */
  send?: (data: SendData, socketIndex: number) => unknown;
  /** A value to throw from close(), or undefined to close normally. */
  close?: (socketIndex: number) => unknown;
  /** Close only after this many ms (a lagging close handshake). */
  closeDelayMs?: number;
  /** Reported send-buffer size, or undefined for the real one. */
  bufferedAmount?: (socketIndex: number) => number | undefined;
}

const RealWebSocket = globalThis.WebSocket;

/** A WebSocket class whose sockets fail as `faults` says (install with vi.stubGlobal). */
export function faultyWebSocket(faults: SocketFaults): typeof WebSocket {
  let created = 0;
  return class FaultyWebSocket extends RealWebSocket {
    readonly socketIndex = created++;

    override send(data: SendData): void {
      const fault = faults.send?.(data, this.socketIndex);
      if (fault !== undefined) throw fault;
      super.send(data);
    }

    override close(code?: number, reason?: string): void {
      const fault = faults.close?.(this.socketIndex);
      if (fault !== undefined) throw fault;
      const delay = faults.closeDelayMs ?? 0;
      if (delay > 0) setTimeout(() => super.close(code, reason), delay);
      else super.close(code, reason);
    }

    override get bufferedAmount(): number {
      return faults.bufferedAmount?.(this.socketIndex) ?? super.bufferedAmount;
    }
  };
}

// --- logger ------------------------------------------------------------------------------------

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  obj: Record<string, unknown>;
}

export interface SttLog {
  logger: Logger;
  entries: LogEntry[];
  messages(level: LogEntry["level"]): string[];
  /** The next log call with this message throws (a broken log transport). */
  throwOnce(msg: string): void;
}

export function sttLog(): SttLog {
  const entries: LogEntry[] = [];
  let throwOn: string | null = null;
  const at =
    (level: LogEntry["level"]) =>
    (objOrMsg: unknown, msg?: string): void => {
      const text = typeof objOrMsg === "string" ? objOrMsg : (msg ?? "");
      const obj =
        typeof objOrMsg === "object" && objOrMsg !== null
          ? (objOrMsg as Record<string, unknown>)
          : {};
      entries.push({ level, msg: text, obj });
      if (throwOn !== null && text === throwOn) {
        throwOn = null;
        throw new Error("log transport failed");
      }
    };
  const logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return {
    logger: logger as unknown as Logger,
    entries,
    messages: (level) => entries.filter((e) => e.level === level).map((e) => e.msg),
    throwOnce(msg) {
      throwOn = msg;
    },
  };
}

/** Polls `check` until it returns true (real timers; sockets need the event loop). */
export async function until(check: () => boolean, what = "condition", timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- provider harness --------------------------------------------------------------------------

/** Not a real key: long enough to be scrubbed from logs, errors and recordings. */
export const TEST_KEY = "sk-test-0123456789-not-a-real-key";

/** Short timers, with keepalive, watchdog and backoff reset out of the way unless a test sets them. */
export const QUICK_TIMINGS: Partial<SonioxTimings> = {
  connectTimeoutMs: 3000,
  keepaliveAfterMs: 60_000,
  watchdogMs: 60_000,
  backoffResetAfterMs: 60_000,
  stopTimeoutMs: 3000,
  fastStopTimeoutMs: 300,
  tickMs: 20,
};

export interface Harness {
  provider: SonioxProvider;
  events: ProviderEvent[];
  log: SttLog;
  start(sessionId?: string): Promise<void>;
  /** state events as "state" or "state: detail". */
  states(): string[];
  errors(): Array<Extract<ProviderEvent, { type: "error" }>>;
  /** Final text of one kind, over every tokens event. */
  finalText(kind: "source" | "translation"): string;
}

const live: SonioxProvider[] = [];

export function harness(url: string, over: Partial<SonioxProviderOptions> = {}): Harness {
  const log = sttLog();
  const events: ProviderEvent[] = [];
  const provider = new SonioxProvider({
    apiKey: TEST_KEY,
    region: "default",
    model: "stt-rt-v5",
    from: "ar",
    targetLanguage: "nl",
    context: null,
    endpointDetection: true,
    maxEndpointDelayMs: null,
    recordFile: null,
    log: log.logger,
    url,
    timings: QUICK_TIMINGS,
    ...over,
  });
  live.push(provider);
  return {
    provider,
    events,
    log,
    start: (sessionId = "sess-1") => provider.start({ sessionId, onEvent: (e) => events.push(e) }),
    states: () =>
      events.flatMap((e) =>
        e.type === "state" ? [e.detail === undefined ? e.state : `${e.state}: ${e.detail}`] : [],
      ),
    errors: () => events.flatMap((e) => (e.type === "error" ? [e] : [])),
    finalText: (kind) =>
      events
        .flatMap((e) => (e.type === "tokens" ? e.final : []))
        .filter((t) => t.kind === kind)
        .map((t) => t.text)
        .join(""),
  };
}

/** Stops every provider a harness made (afterEach). */
export async function stopProviders(): Promise<void> {
  const all = live.splice(0);
  await Promise.all(all.map((p) => p.stop({ fast: true })));
}

/** One 100 ms audio frame (16 kHz mono s16le) filled with `fill`. */
export const audio = (fill = 1): Uint8Array => new Uint8Array(3200).fill(fill);

/** Soniox tokens as the server sends them. */
export const word = (text: string, isFinal: boolean, startMs?: number, endMs?: number) => ({
  text,
  is_final: isFinal,
  language: "ar",
  translation_status: "original",
  ...(startMs === undefined ? {} : { start_ms: startMs }),
  ...(endMs === undefined ? {} : { end_ms: endMs }),
});
export const translated = (text: string, isFinal = true) => ({
  text,
  is_final: isFinal,
  language: "nl",
  translation_status: "translation",
});
export const marker = (text: "<end>" | "<fin>") => ({ text, is_final: true });
