// Small browser fakes for the happy-dom tests of the caption views (web/shared, the caption page,
// the overlay and the control dock): a WebSocket the test drives by hand, a fetch that answers from
// a handler, the page templates from web/*.html, and builders for the wire types.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { Block, Segment, Status, TextState } from "../../../src/shared/protocol.js";

const WEB = join(import.meta.dirname, "..", "..", "..", "web");

// --- WebSocket ----------------------------------------------------------------------------------

/** A WebSocket the test opens, feeds and drops by hand; every instance is kept in `all`. */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  /** The next N constructions throw (a URL the browser refuses). */
  static failNext = 0;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "blob";
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  throwOnSend = false;
  throwOnClose = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    if (FakeWebSocket.failNext > 0) {
      FakeWebSocket.failNext--;
      throw new SyntaxError(`invalid url ${url}`);
    }
    this.url = url;
    FakeWebSocket.all.push(this);
  }

  static reset(): void {
    FakeWebSocket.all = [];
    FakeWebSocket.failNext = 0;
  }

  /** The newest socket (throws when none was made). */
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.all.at(-1);
    if (!ws) throw new Error("no WebSocket was created");
    return ws;
  }

  send(data: string | ArrayBuffer): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(data);
  }

  /** Like a browser, closing fires `close` (here at once, so the tests stay synchronous). */
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    if (this.throwOnClose) throw new Error("close failed");
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: code ?? 1005, reason: reason ?? "" }));
  }

  // --- the server's side ---

  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** A message from the server: objects are sent as JSON text. */
  receive(data: unknown): void {
    const payload =
      typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data);
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }

  /** The connection is lost (error, then close). */
  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code }));
  }

  /** The JSON text messages this socket sent. */
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

// --- fetch ----------------------------------------------------------------------------------------

export type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/** Replace fetch with `handler` (every call is recorded on the returned mock). */
export function fakeFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    ),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- pages ----------------------------------------------------------------------------------------

/** Navigate the test window (origin, path and query). */
export function setUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
}

/** Put the <body> of web/<page>.html into the document (with the body's class). */
export function loadTemplate(page: string): void {
  const html = readFileSync(join(WEB, `${page}.html`), "utf8");
  const m = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  if (!m) throw new Error(`${page}.html has no body`);
  const cls = /class="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "";
  document.body.className = cls;
  document.body.innerHTML = m[2] ?? "";
}

/**
 * Record the listeners added to `targets` from now on; the returned function removes them. Pages
 * that start on import add document/window listeners that would otherwise outlive their test.
 */
export function trackListeners(...targets: EventTarget[]): () => void {
  const added: Array<() => void> = [];
  const restore: Array<() => void> = [];
  for (const target of targets) {
    const original = target.addEventListener;
    // The test window's globals are own properties: put them back as they were.
    const own = Object.getOwnPropertyDescriptor(target, "addEventListener");
    restore.push(() => {
      if (own) Object.defineProperty(target, "addEventListener", own);
      else Reflect.deleteProperty(target, "addEventListener");
    });
    target.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener) added.push(() => target.removeEventListener(type, listener, options));
      original.call(this, type, listener, options);
    };
  }
  return () => {
    for (const remove of added) remove();
    for (const r of restore) r();
  };
}

/** Let pending promise callbacks run (fake timers keep their time). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// --- wire types -----------------------------------------------------------------------------------

export function text(t: string, finalLen = t.length, final = finalLen >= t.length): TextState {
  return { text: t, finalLen, final };
}

export function segment(
  seq: number,
  source: TextState,
  translations: Record<string, TextState> = {},
  opts: { session?: string; lang?: string; closed?: boolean } = {},
): Segment {
  const session = opts.session ?? "s1";
  return {
    id: `${session}:soniox:${seq}`,
    sessionId: session,
    track: "soniox",
    seq,
    kind: "speech",
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    source: { lang: opts.lang ?? "ar", ...source },
    translations,
    closed: opts.closed ?? source.final,
    timing: { source: "arrival", firstTokenAt: 0 },
  };
}

export function block(seq: number, over: Partial<Block> = {}, session = "s1"): Block {
  return {
    id: `${session}:b${seq}`,
    seq,
    kind: "speech",
    text: `Block ${seq}.`,
    ref: null,
    src: null,
    lang: "nl",
    segmentIds: [],
    createdAt: 1_000 + seq,
    ...over,
  };
}

export function status(over: Partial<Status> = {}): Status {
  return {
    state: "live",
    primary: "soniox",
    provider: "live",
    audio: { state: "ok", rmsDbfs: -30, lastFrameAgoMs: 20, noSignal: false },
    latency: { p50Ms: 900, p95Ms: 1400, n: 12 },
    tracks: [],
    ...over,
  };
}
