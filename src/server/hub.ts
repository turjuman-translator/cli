// /ws hub for the overlay and control pages: hello + snapshots on connect (segment snapshots,
// blocks.snapshot, mode), then the followed session's messages as they come: segment/clear/status
// (≤2/s), blocks.snapshot/block.add/block.update/mode/listening/session.ended, and level (≤5/s,
// subscribers only).
// Follows the local session by default (re-sent hello + snapshots when it appears or
// disappears; idle-monitor levels/status in between); `?session=<id>` follows any session.
// Also exports the socket helpers /ws/page uses (ping, backpressure, throttles).
import type { Logger } from "pino";
import type { RawData, WebSocket } from "ws";
import type { Config } from "../config.js";
import type { CaptionSessionApi, SessionManagerApi } from "../core/contracts.js";
import type { ServerMessage } from "../shared/protocol.js";

export const PING_INTERVAL_MS = 10_000;
/** Clients whose send buffer grows past this are dropped; they reconnect and get a snapshot. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
const STATUS_INTERVAL_MS = 500; // status ≤ 2/s
const LEVEL_INTERVAL_MS = 200; // level ≤ 5/s
const POLL_INTERVAL_MS = 1_000;
const MAX_CLIENT_TEXT = 4096;

/** Send JSON if the socket is open; terminate a client that cannot keep up. */
export function sendJson(
  socket: WebSocket,
  msg: unknown,
  maxBuffered: number = MAX_BUFFERED_BYTES,
): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > maxBuffered) {
    socket.terminate();
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}

/**
 * Ping every `intervalMs`; terminate when the previous ping got no pong or the send buffer is
 * over `maxBuffered`. `onTick` runs on every interval while the socket is healthy.
 */
export function keepAlive(
  socket: WebSocket,
  opts: { intervalMs?: number; maxBuffered?: number; onTick?: () => void } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? PING_INTERVAL_MS;
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED_BYTES;
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive || socket.bufferedAmount > maxBuffered) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      socket.terminate();
      return;
    }
    opts.onTick?.();
  }, intervalMs);
  timer.unref();
  const stop = (): void => clearInterval(timer);
  socket.once("close", stop);
  return stop;
}

/** Leading + trailing throttle: at most one value per interval, always delivering the latest. */
export class Throttle<T> {
  private last = Number.NEGATIVE_INFINITY;
  private pending: { value: T } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (value: T) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(value: T): void {
    const now = this.now();
    if (this.timer === null && now - this.last >= this.intervalMs) {
      this.last = now;
      this.emit(value);
      return;
    }
    this.pending = { value };
    if (this.timer === null) {
      this.timer = setTimeout(
        () => {
          this.timer = null;
          const p = this.pending;
          this.pending = null;
          if (p !== null) {
            this.last = this.now();
            this.emit(p.value);
          }
        },
        Math.max(0, this.intervalMs - (now - this.last)),
      );
      this.timer.unref();
    }
  }

  /** Drop the pending value (e.g. a snapshot carried a newer status). */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/** Text of a WebSocket message (ws hands Buffer, ArrayBuffer or Buffer[]). */
export function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

export interface HubOptions {
  manager: SessionManagerApi;
  config: Config;
  log: Logger;
  pingIntervalMs?: number;
  pollIntervalMs?: number;
}

interface Client {
  socket: WebSocket;
  /** `?session=<id>` (debug), or null to follow the local session. */
  follow: string | null;
  /** Session currently forwarded; null = idle; undefined = nothing sent yet. */
  attachedId: string | null | undefined;
  unsubscribe: (() => void) | null;
  wantsLevel: boolean;
  lastLevelAt: number;
  status: Throttle<ServerMessage>;
}

export class Hub {
  private readonly clients = new Set<Client>();
  private poll: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HubOptions) {}

  get size(): number {
    return this.clients.size;
  }

  /** GET /ws handler; listeners are attached synchronously. */
  handle(socket: WebSocket, follow: string | null): void {
    const client: Client = {
      socket,
      follow,
      attachedId: undefined,
      unsubscribe: null,
      wantsLevel: false,
      lastLevelAt: Number.NEGATIVE_INFINITY,
      status: new Throttle<ServerMessage>(STATUS_INTERVAL_MS, (m) => this.send(client, m)),
    };
    this.clients.add(client);
    socket.on("message", (data, isBinary) => this.onMessage(client, data, isBinary));
    socket.on("close", () => this.drop(client));
    keepAlive(socket, {
      ...(this.opts.pingIntervalMs === undefined ? {} : { intervalMs: this.opts.pingIntervalMs }),
    });
    this.sync(client);
    this.ensurePoll();
  }

  /** Stop polling and detach every client (the websocket plugin closes the sockets). */
  close(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    for (const client of this.clients) this.detach(client);
    this.clients.clear();
  }

  private ensurePoll(): void {
    if (this.poll !== null) return;
    this.poll = setInterval(() => {
      for (const client of this.clients) this.sync(client);
    }, this.opts.pollIntervalMs ?? POLL_INTERVAL_MS);
    this.poll.unref();
  }

  private send(client: Client, msg: ServerMessage): void {
    sendJson(client.socket, msg);
  }

  private target(client: Client): CaptionSessionApi | null {
    const { manager } = this.opts;
    if (client.follow !== null) return manager.get(client.follow) ?? null;
    return manager.local();
  }

  /** (Re)attach when the followed session changed: new hello + snapshots. */
  private sync(client: Client): void {
    let session: CaptionSessionApi | null;
    try {
      session = this.target(client);
    } catch (err) {
      this.opts.log.error({ err }, "hub: session lookup failed");
      return;
    }
    const id = session?.id ?? null;
    if (client.attachedId === id) return;
    this.detach(client);
    client.attachedId = id;
    try {
      if (session === null) this.attachIdle(client);
      else this.attachSession(client, session);
    } catch (err) {
      this.opts.log.error({ err }, "hub: attach failed");
      client.socket.close(1011, "internal error");
    }
  }

  private detach(client: Client): void {
    client.unsubscribe?.();
    client.unsubscribe = null;
    client.status.cancel();
  }

  private attachSession(client: Client, session: CaptionSessionApi): void {
    const info = session.info();
    const status = session.status();
    const tracks = status.tracks.filter((t) => t.active).map((t) => t.track);
    this.send(client, {
      type: "hello",
      protocol: 1,
      serverTime: Date.now(),
      sessionId: session.id,
      langs: { source: info.from, targets: [info.to] },
      tracks: tracks.length > 0 ? tracks : [status.primary],
      primary: status.primary,
    });
    for (const m of session.snapshots()) this.send(client, m);
    client.unsubscribe = session.subscribe((msg) => this.forward(client, msg, session));
  }

  /** No session: hello(sessionId null) from config, then the idle monitor's status/levels. */
  private attachIdle(client: Client): void {
    const { config, manager } = this.opts;
    this.send(client, {
      type: "hello",
      protocol: 1,
      serverTime: Date.now(),
      sessionId: null,
      langs: {
        source: config.stt.soniox.languageHints[0] ?? config.pages.defaultFrom,
        targets: [config.translation.targetLanguage],
      },
      tracks: ["soniox"],
      primary: "soniox",
    });
    if (client.follow === null) {
      client.unsubscribe = manager.subscribeMonitor((msg) => this.forward(client, msg, null));
    }
  }

  private forward(client: Client, msg: ServerMessage, session: CaptionSessionApi | null): void {
    switch (msg.type) {
      case "hello":
        return; // the hub sends its own
      case "level": {
        if (!client.wantsLevel) return;
        const now = Date.now();
        if (now - client.lastLevelAt < LEVEL_INTERVAL_MS) return;
        client.lastLevelAt = now;
        this.send(client, msg);
        return;
      }
      case "status":
        client.status.push(msg);
        return;
      case "snapshot":
        client.status.cancel();
        this.send(client, msg);
        return;
      case "clear":
        this.send(client, msg);
        if (session !== null) {
          client.status.cancel();
          for (const m of session.snapshots()) this.send(client, m);
        }
        return;
      default:
        this.send(client, msg);
    }
  }

  /** Overlay/control clients are read-only: `subscribe` is the only message. */
  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    const buf = rawToBuffer(data);
    if (buf.length > MAX_CLIENT_TEXT) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const m = parsed as { type?: unknown; topics?: unknown };
    if (m.type === "subscribe" && Array.isArray(m.topics)) {
      client.wantsLevel = m.topics.includes("level");
    }
  }

  private drop(client: Client): void {
    this.detach(client);
    this.clients.delete(client);
    if (this.clients.size === 0 && this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}
