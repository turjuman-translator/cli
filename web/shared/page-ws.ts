// Caption page ↔ server WebSocket: hello → ready (or error, or a disabled screen), then binary
// 3,200-byte frames + speech events up; snapshot/segment/clear/status and the block messages down.
// Reconnects with backoff 0.5 → 1 → 2 s and resumes the session. A signed screen link travels in
// every hello.
import {
  type CaptionLayout,
  PAGE_FRAME_BYTES,
  type PageClientMessage,
  type PageErrorCode,
  type PageServerMessage,
  type ScreenLink,
  type ScreenState,
} from "../../src/shared/protocol.js";
import { wsUrl } from "./dom.js";
import { parseMessage, ReconnectingSocket } from "./ws-client.js";

export type ReadyMessage = Extract<PageServerMessage, { type: "ready" }>;
export type PageDataMessage = Exclude<PageServerMessage, { type: "ready" | "error" | "screen" }>;

export interface PageHello {
  from: string;
  to: string;
  key: string | null;
  layout: CaptionLayout;
  /** `?screen=<guid>`, sent in every hello. */
  screen: ScreenLink | null;
}

export type PageConnState = "connecting" | "handshake" | "ready" | "down" | "stopped";

export interface PageSocketHandlers {
  onReady(msg: ReadyMessage): void;
  onError(code: PageErrorCode, message: string, retryInMs: number | null): void;
  onData(msg: PageDataMessage): void;
  /** The screen's switch (disabled → no session; enabled → send a fresh hello). */
  onScreen(state: ScreenState, name: string): void;
  /** `downSince` = when the link was lost (null while connected). */
  onState(state: PageConnState, downSince: number | null): void;
}

/** Retry policy per error code: null = give up (needs a new URL). */
const RETRY_MS: Record<PageErrorCode, number | null> = {
  bad_language: null,
  unauthorized: 5 * 60_000,
  quota_exceeded: 5 * 60_000,
  engine_unavailable: 30_000,
  // A revoked link is not fixed by retrying fast; a server restart might: once a minute.
  screen_invalid: 60_000,
  screen_required: 60_000,
};

/** Frames are dropped while this much is queued (network stall: realtime audio, no backlog). */
const MAX_BUFFERED_BYTES = 16 * PAGE_FRAME_BYTES;
/** A send buffer that doesn't drain for this long means a dead link: reconnect. */
const STALL_MS = 8_000;

export class PageSocket {
  sessionId: string | null = null;
  framesSent = 0;
  framesDropped = 0;
  private isReady = false;
  private fatal = false;
  private readonly sock: ReconnectingSocket;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stallSince: number | null = null;
  private lastBuffered = 0;

  constructor(
    private readonly hello: PageHello,
    private readonly h: PageSocketHandlers,
  ) {
    this.sock = new ReconnectingSocket({
      url: () => wsUrl("/ws/page"),
      onOpen: (ws) => this.sendHello(ws),
      onMessage: (data) => this.onMessage(data),
      onState: (state, downSince) => {
        if (state !== "open") this.isReady = false;
        if (state === "connecting") this.h.onState("connecting", downSince);
        else if (state === "closed") this.h.onState(this.fatal ? "stopped" : "down", downSince);
      },
      onClose: () => !this.fatal,
    });
  }

  get ready(): boolean {
    return this.isReady && this.sock.connected;
  }

  start(): void {
    this.fatal = false;
    this.sock.start();
    if (this.watchdog === null) this.watchdog = setInterval(() => this.checkStall(), 1000);
  }

  stop(): void {
    this.sock.stop();
    this.isReady = false;
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Send a new hello on the open socket (screen enabled): a new session, never a resume. */
  rehello(): void {
    this.sessionId = null;
    this.isReady = false;
    const ws = this.sock.socket;
    if (ws && ws.readyState === WebSocket.OPEN) this.sendHello(ws);
  }

  sendSpeech(state: "start" | "end"): boolean {
    if (!this.ready) return false;
    const msg: PageClientMessage = { type: "speech", state };
    return this.sock.send(JSON.stringify(msg));
  }

  /** One 100 ms frame (1,600 samples = 3,200 bytes). */
  sendFrame(samples: Int16Array): boolean {
    const ws = this.sock.socket;
    if (!this.ready || !ws) return false;
    if (samples.byteLength !== PAGE_FRAME_BYTES) return false;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.framesDropped++;
      return false;
    }
    const buf =
      samples.byteOffset === 0 && samples.buffer.byteLength === PAGE_FRAME_BYTES
        ? samples.buffer
        : samples.slice().buffer;
    if (!(buf instanceof ArrayBuffer)) return false;
    const ok = this.sock.send(buf);
    if (ok) this.framesSent++;
    return ok;
  }

  private sendHello(ws: WebSocket): void {
    this.h.onState("handshake", null);
    const msg: PageClientMessage = {
      type: "hello",
      protocol: 1,
      from: this.hello.from,
      to: this.hello.to,
      ...(this.hello.key ? { key: this.hello.key } : {}),
      resume: this.sessionId,
      layout: this.hello.layout,
      ...(this.hello.screen ? { screen: this.hello.screen } : {}),
      client: { obs: window.obsstudio !== undefined, ua: navigator.userAgent },
      format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // the close handler reconnects
    }
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const msg = parseMessage<PageServerMessage>(data);
    if (!msg) return;
    switch (msg.type) {
      case "ready":
        this.sessionId = msg.sessionId;
        this.isReady = true;
        this.h.onState("ready", null);
        this.h.onReady(msg);
        return;
      case "error": {
        const retry = msg.code in RETRY_MS ? RETRY_MS[msg.code] : 10_000;
        this.isReady = false;
        if (retry === null) this.fatal = true;
        else this.sock.setNextDelay(retry);
        this.h.onError(msg.code, msg.message, retry);
        this.sock.restart();
        return;
      }
      case "screen":
        // Disabled: no session runs (a live one has just ended), so nothing may be sent.
        if (msg.state === "disabled") {
          this.isReady = false;
          this.sessionId = null;
        }
        this.h.onScreen(msg.state, msg.name);
        return;
      case "snapshot":
      case "segment":
      case "clear":
      case "status":
      case "blocks.snapshot":
      case "block.add":
      case "block.update":
      case "mode":
      case "listening":
      case "session.ended":
        this.h.onData(msg);
        return;
      default:
        return;
    }
  }

  private checkStall(): void {
    const ws = this.sock.socket;
    if (!ws || !this.isReady) {
      this.stallSince = null;
      return;
    }
    const buffered = ws.bufferedAmount;
    if (buffered === 0 || buffered < this.lastBuffered) {
      this.stallSince = null;
    } else if (this.stallSince === null) {
      this.stallSince = Date.now();
    } else if (Date.now() - this.stallSince > STALL_MS) {
      this.stallSince = null;
      this.sock.restart();
    }
    this.lastBuffered = buffered;
  }
}
