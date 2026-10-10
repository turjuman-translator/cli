// Reconnecting WebSocket for /ws (overlay, control) and the base of the page client.
// Backoff 0.5 → 1 → 2 s (capped), so captions are back within 5 s of a server restart. Quiet by
// design: no console output.
import type { ServerMessage } from "../../src/shared/protocol.js";

export const RECONNECT_BACKOFF_MS: readonly number[] = [500, 1000, 2000];

export type SocketState = "connecting" | "open" | "closed";

export interface ReconnectingSocketOptions {
  /** Called for every attempt, so query parameters can change between attempts. */
  url: () => string;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (data: string | ArrayBuffer) => void;
  /** `downSince` = wall ms when the connection was lost (null while open). */
  onState?: (state: SocketState, downSince: number | null) => void;
  /** Called on close; return false to stop reconnecting (fatal errors). */
  onClose?: (ev: CloseEvent) => boolean | undefined;
  backoffMs?: readonly number[];
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private downSince: number | null = null;
  private readonly backoff: readonly number[];
  private overrideDelayMs: number | null = null;

  constructor(private readonly opts: ReconnectingSocketOptions) {
    this.backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get socket(): WebSocket | null {
    return this.ws;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Down since now: a socket made long before (the caption page waits for its microphone)
    // must not count as unreachable for that time.
    this.downSince = Date.now();
    window.addEventListener("online", this.onOnline);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    }
  }

  /** Force a reconnect now (e.g. after a dead-connection watchdog fired). */
  restart(): void {
    const ws = this.ws;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(4000, "client restart");
      } catch {
        // ignore
      }
    }
  }

  /** Delay for the next reconnect only (e.g. engine_unavailable: retry slower). */
  setNextDelay(ms: number): void {
    this.overrideDelayMs = ms;
  }

  send(data: string | ArrayBuffer): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private readonly onOnline = (): void => {
    if (this.stopped || this.connected) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.connect();
    }
  };

  /** Only called while started: start(), "online" and the reconnect timer (stop() clears it). */
  private connect(): void {
    this.timer = null;
    this.opts.onState?.("connecting", this.downSince);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.downSince = null;
      this.opts.onState?.("open", null);
      this.opts.onOpen?.(ws);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      const data: unknown = ev.data;
      if (typeof data === "string" || data instanceof ArrayBuffer) this.opts.onMessage(data);
    };
    ws.onerror = () => {
      // onclose follows; nothing to log (no console spam)
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.downSince === null) this.downSince = Date.now();
      this.opts.onState?.("closed", this.downSince);
      const keepGoing = this.opts.onClose?.(ev);
      if (keepGoing === false) {
        this.stopped = true;
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay =
      this.overrideDelayMs ?? this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 2000;
    this.overrideDelayMs = null;
    this.attempt++;
    this.timer = setTimeout(() => this.connect(), delay);
  }
}

/** Parse a server JSON message; null for anything that isn't an object with a string `type`. */
export function parseMessage<T extends { type: string } = ServerMessage>(data: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  return value as T;
}
