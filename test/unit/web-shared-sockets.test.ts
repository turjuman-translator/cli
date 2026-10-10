// @vitest-environment happy-dom
// The reconnecting WebSocket of the overlay and the control dock (web/shared/ws-client.ts) and the
// caption page's own socket on top of it (page-ws.ts): backoff, the hello/ready handshake, resume,
// error codes and their retry policy, signed screens, audio frames and the stall watchdog.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_FRAME_BYTES, type PageServerMessage } from "../../src/shared/protocol.js";
import { type PageHello, PageSocket, type PageSocketHandlers } from "../../web/shared/page-ws.js";
import {
  parseMessage,
  RECONNECT_BACKOFF_MS,
  ReconnectingSocket,
  type ReconnectingSocketOptions,
} from "../../web/shared/ws-client.js";
import { FakeWebSocket, setUrl } from "./helpers/web-shared-fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  setUrl("https://mosque.example.org/ar/nl");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "obsstudio");
});

describe("reconnecting socket", () => {
  type Opts = Required<ReconnectingSocketOptions>;

  function make(over: Partial<ReconnectingSocketOptions> = {}) {
    const opts = {
      url: vi.fn(() => "wss://mosque.example.org/ws"),
      onOpen: vi.fn<Opts["onOpen"]>(),
      onMessage: vi.fn<Opts["onMessage"]>(),
      onState: vi.fn<Opts["onState"]>(),
      onClose: vi.fn<Opts["onClose"]>(() => undefined),
    };
    return { sock: new ReconnectingSocket({ ...opts, ...over }), opts };
  }

  it("connects on start, as arraybuffer, and reports connecting with the down time", () => {
    const { sock, opts } = make();
    expect(sock.socket).toBeNull();
    expect(sock.connected).toBe(false);
    sock.start();
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe("wss://mosque.example.org/ws");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(opts.onState).toHaveBeenCalledWith("connecting", Date.now());
    expect(sock.socket).toBe(ws as unknown as WebSocket);
    sock.start();
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("counts the time down from start, not from when it was made", () => {
    const { sock, opts } = make();
    vi.advanceTimersByTime(10_000);
    sock.start();
    expect(opts.onState).toHaveBeenCalledWith("connecting", Date.now());
  });

  it("reports open, hands over the socket and passes text and binary messages", () => {
    const { sock, opts } = make();
    sock.start();
    const ws = FakeWebSocket.last();
    ws.accept();
    expect(sock.connected).toBe(true);
    expect(opts.onState).toHaveBeenLastCalledWith("open", null);
    expect(opts.onOpen).toHaveBeenCalledWith(ws);
    ws.receive("hello");
    const bin = new ArrayBuffer(4);
    ws.receive(bin);
    ws.onmessage?.(new MessageEvent("message", { data: new Blob(["x"]) }));
    expect(opts.onMessage.mock.calls).toEqual([["hello"], [bin]]);
  });

  it("works without the optional callbacks", () => {
    const sock = new ReconnectingSocket({ url: () => "ws://x/ws", onMessage: () => undefined });
    sock.start();
    FakeWebSocket.last().accept();
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all).toHaveLength(2);
    sock.stop();
  });

  it("backs off 0.5 → 1 → 2 → 2 s and starts again from 0.5 s after a success", () => {
    const { sock, opts } = make();
    expect(RECONNECT_BACKOFF_MS).toEqual([500, 1000, 2000]);
    sock.start();
    const lostAt = Date.now();
    FakeWebSocket.last().drop();
    expect(opts.onState).toHaveBeenLastCalledWith("closed", lostAt);
    for (const delay of [500, 1000, 2000, 2000]) {
      const before = FakeWebSocket.all.length;
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.all).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.all).toHaveLength(before + 1);
      // Still down since the first loss.
      expect(opts.onState).toHaveBeenLastCalledWith("connecting", lostAt);
      FakeWebSocket.last().drop();
    }
    vi.advanceTimersByTime(2000);
    FakeWebSocket.last().accept();
    FakeWebSocket.last().drop();
    const n = FakeWebSocket.all.length;
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all).toHaveLength(n + 1);
    expect(opts.url).toHaveBeenCalledTimes(n + 1);
  });

  it("uses its own backoff list, and 2 s when the list is empty", () => {
    const custom = make({ backoffMs: [100] });
    custom.sock.start();
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.all).toHaveLength(2);
    custom.sock.stop();

    FakeWebSocket.reset();
    const empty = make({ backoffMs: [] });
    empty.sock.start();
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("stops reconnecting when onClose says so", () => {
    const onClose = vi.fn(() => false);
    const { sock } = make({ onClose });
    sock.start();
    FakeWebSocket.last().drop(4001);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 4001 }));
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    // A later start connects again.
    sock.start();
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("waits the given delay once before the next attempt (a slower retry)", () => {
    const { sock } = make();
    sock.start();
    sock.setNextDelay(5000);
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(4999);
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(2);
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(3);
  });

  it("retries later when the browser refuses to make the socket", () => {
    const { sock, opts } = make();
    FakeWebSocket.failNext = 1;
    sock.start();
    expect(FakeWebSocket.all).toHaveLength(0);
    expect(opts.onState).toHaveBeenCalledWith("connecting", expect.any(Number));
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("restarts an open or connecting socket, and ignores a closed one", () => {
    const { sock } = make();
    sock.restart();
    sock.start();
    const first = FakeWebSocket.last();
    sock.restart();
    expect(first.closes).toEqual([{ code: 4000, reason: "client restart" }]);
    vi.advanceTimersByTime(500);
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    second.accept();
    second.throwOnClose = true;
    expect(() => sock.restart()).not.toThrow();
    second.readyState = FakeWebSocket.CLOSED;
    second.throwOnClose = false;
    sock.restart();
    expect(second.closes).toHaveLength(1);
  });

  it("sends only on an open socket, and reports a failed send", () => {
    const { sock } = make();
    expect(sock.send("x")).toBe(false);
    sock.start();
    const ws = FakeWebSocket.last();
    expect(sock.send("x")).toBe(false);
    ws.accept();
    expect(sock.send("x")).toBe(true);
    expect(ws.sent).toEqual(["x"]);
    ws.throwOnSend = true;
    expect(sock.send("y")).toBe(false);
  });

  it("stops: no handlers, a normal close, no reconnect, no online retry", () => {
    const { sock, opts } = make();
    sock.start();
    const ws = FakeWebSocket.last();
    ws.accept();
    sock.stop();
    expect(ws.closes).toEqual([{ code: 1000, reason: undefined }]);
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(sock.socket).toBeNull();
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(opts.onState).not.toHaveBeenCalledWith("closed", expect.anything());
  });

  it("stops while waiting to reconnect, and survives a close that throws", () => {
    const { sock } = make();
    sock.start();
    FakeWebSocket.last().drop();
    sock.stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    sock.start();
    const ws = FakeWebSocket.last();
    ws.throwOnClose = true;
    expect(() => sock.stop()).not.toThrow();
    sock.stop();
  });

  it("reconnects at once when the network comes back while waiting", () => {
    const { sock } = make();
    sock.start();
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(500);
    FakeWebSocket.last().drop();
    expect(FakeWebSocket.all).toHaveLength(2);
    window.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.all).toHaveLength(3);
    // The cancelled timer does not connect a second time.
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(3);
    // While connecting (no timer) or connected, "online" changes nothing.
    window.dispatchEvent(new Event("online"));
    FakeWebSocket.last().accept();
    window.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.all).toHaveLength(3);
  });

  it("does not reconnect when a callback stops it on close", () => {
    let sock: ReconnectingSocket | null = null;
    const made = make({
      onClose: () => {
        sock?.stop();
        return undefined;
      },
    });
    sock = made.sock;
    sock.start();
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("does not retry a refused socket when a callback stopped it meanwhile", () => {
    let sock: ReconnectingSocket | null = null;
    const made = make({
      onState: (state) => {
        if (state === "connecting") sock?.stop();
      },
    });
    sock = made.sock;
    FakeWebSocket.failNext = 1;
    sock.start();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.all).toHaveLength(0);
  });

  it("ignores events of a socket it has already replaced", () => {
    const { sock, opts } = make();
    sock.start();
    const old = FakeWebSocket.last();
    old.drop();
    vi.advanceTimersByTime(500);
    const fresh = FakeWebSocket.last();
    opts.onState.mockClear();
    old.accept();
    old.receive("late");
    old.drop();
    expect(opts.onOpen).not.toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onState).not.toHaveBeenCalled();
    expect(sock.socket).toBe(fresh as unknown as WebSocket);
  });
});

describe("parseMessage", () => {
  it("returns objects with a string type, null for anything else", () => {
    expect(parseMessage('{"type":"status","x":1}')).toEqual({ type: "status", x: 1 });
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage("42")).toBeNull();
    expect(parseMessage("null")).toBeNull();
    expect(parseMessage('"text"')).toBeNull();
    expect(parseMessage("{}")).toBeNull();
    expect(parseMessage('{"type":7}')).toBeNull();
  });
});

describe("caption page socket", () => {
  const VAD = {
    thresholdDbfs: -45,
    minSpeechMs: 200,
    minSilenceMs: 400,
    hangoverMs: 800,
    prerollMs: 500,
  };
  const READY: PageServerMessage = {
    type: "ready",
    sessionId: "s1",
    resumed: false,
    vad: VAD,
    limits: { maxFrameBytes: 3200, maxRealtimeFactor: 2, dailyMinutesLeft: null },
  };

  function handlers() {
    return {
      onReady: vi.fn<PageSocketHandlers["onReady"]>(),
      onError: vi.fn<PageSocketHandlers["onError"]>(),
      onData: vi.fn<PageSocketHandlers["onData"]>(),
      onScreen: vi.fn<PageSocketHandlers["onScreen"]>(),
      onState: vi.fn<PageSocketHandlers["onState"]>(),
    };
  }

  function open(hello: Partial<PageHello> = {}) {
    const h = handlers();
    const page = new PageSocket(
      { from: "ar", to: "nl", key: null, layout: "blocks", screen: null, ...hello },
      h,
    );
    page.start();
    const ws = FakeWebSocket.last();
    ws.accept();
    return { page, h, ws };
  }

  function ready() {
    const opened = open();
    opened.ws.receive(READY);
    return opened;
  }

  const frame = () => new Int16Array(PAGE_FRAME_BYTES / 2);

  it("connects to /ws/page on this host and says hello on open", () => {
    const { h, ws } = open({ key: "k-123", layout: "rollup" });
    expect(ws.url).toBe("wss://mosque.example.org/ws/page");
    expect(h.onState).toHaveBeenNthCalledWith(1, "connecting", expect.any(Number));
    expect(h.onState).toHaveBeenNthCalledWith(2, "handshake", null);
    expect(ws.json()).toEqual([
      {
        type: "hello",
        protocol: 1,
        from: "ar",
        to: "nl",
        key: "k-123",
        resume: null,
        layout: "rollup",
        client: { obs: false, ua: navigator.userAgent },
        format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1, frameMs: 100 },
      },
    ]);
  });

  it("sends the screen link in every hello and tells the server it runs in OBS", () => {
    Object.defineProperty(window, "obsstudio", {
      value: { pluginVersion: "2.0" },
      configurable: true,
    });
    const { ws } = open({ screen: { guid: "guid-1" } });
    const hello = ws.json()[0];
    expect(hello?.screen).toEqual({ guid: "guid-1" });
    expect(hello?.client).toEqual({ obs: true, ua: navigator.userAgent });
    expect(hello).not.toHaveProperty("key");
  });

  it("is ready after `ready`, with the session id", () => {
    const { page, h } = open();
    expect(page.ready).toBe(false);
    FakeWebSocket.last().receive(READY);
    expect(page.ready).toBe(true);
    expect(page.sessionId).toBe("s1");
    expect(h.onState).toHaveBeenLastCalledWith("ready", null);
    expect(h.onReady).toHaveBeenCalledWith(READY);
  });

  it("resumes its session after a reconnect", () => {
    const { h, ws } = ready();
    ws.drop();
    expect(h.onState).toHaveBeenLastCalledWith("down", Date.now());
    vi.advanceTimersByTime(500);
    const again = FakeWebSocket.last();
    again.accept();
    expect(again.json()[0]?.resume).toBe("s1");
  });

  it("sends speech events only while ready", () => {
    const { page, ws } = open();
    expect(page.sendSpeech("start")).toBe(false);
    ws.receive(READY);
    expect(page.sendSpeech("start")).toBe(true);
    expect(page.sendSpeech("end")).toBe(true);
    expect(ws.json().slice(1)).toEqual([
      { type: "speech", state: "start" },
      { type: "speech", state: "end" },
    ]);
  });

  it("sends 3,200-byte frames only while ready", () => {
    const h = handlers();
    const page = new PageSocket(
      { from: "ar", to: "nl", key: null, layout: "blocks", screen: null },
      h,
    );
    expect(page.sendFrame(frame())).toBe(false);
    page.start();
    expect(page.sendFrame(frame())).toBe(false);
    const ws = FakeWebSocket.last();
    ws.accept();
    ws.receive(READY);
    expect(page.sendFrame(new Int16Array(10))).toBe(false);
    const f = frame();
    expect(page.sendFrame(f)).toBe(true);
    expect(ws.sent.at(-1)).toBe(f.buffer);
    expect(page.framesSent).toBe(1);
  });

  it("copies a frame that is a view into a larger buffer", () => {
    const { page, ws } = ready();
    const big = new Int16Array(PAGE_FRAME_BYTES);
    big.fill(7);
    const view = big.subarray(10, 10 + PAGE_FRAME_BYTES / 2);
    expect(page.sendFrame(view)).toBe(true);
    const sent = ws.sent.at(-1);
    expect(sent).toBeInstanceOf(ArrayBuffer);
    expect(sent).not.toBe(big.buffer);
    expect((sent as ArrayBuffer).byteLength).toBe(PAGE_FRAME_BYTES);
    expect(new Int16Array(sent as ArrayBuffer)[0]).toBe(7);
  });

  it("refuses a frame on shared memory (only an ArrayBuffer can be sent)", () => {
    const { page } = ready();
    const shared = new Int16Array(new SharedArrayBuffer(PAGE_FRAME_BYTES));
    expect(page.sendFrame(shared)).toBe(false);
    expect(page.framesSent).toBe(0);
  });

  it("drops frames while the send buffer is full, and counts a failed send as not sent", () => {
    const { page, ws } = ready();
    ws.bufferedAmount = 16 * PAGE_FRAME_BYTES + 1;
    expect(page.sendFrame(frame())).toBe(false);
    expect(page.framesDropped).toBe(1);
    ws.bufferedAmount = 0;
    ws.throwOnSend = true;
    expect(page.sendFrame(frame())).toBe(false);
    expect(page.framesSent).toBe(0);
  });

  it("survives a hello that cannot be sent (the close handler reconnects)", () => {
    const h = handlers();
    const page = new PageSocket(
      { from: "ar", to: "nl", key: null, layout: "blocks", screen: null },
      h,
    );
    page.start();
    const ws = FakeWebSocket.last();
    ws.throwOnSend = true;
    expect(() => ws.accept()).not.toThrow();
    expect(h.onState).toHaveBeenLastCalledWith("handshake", null);
  });

  it("passes caption data on and ignores unknown, binary and broken messages", () => {
    const { h, ws } = ready();
    const data: PageServerMessage[] = [
      { type: "segment", track: "soniox", segment: {} as never },
      { type: "clear", track: "all" },
      { type: "blocks.snapshot", blocks: [], hasMore: false },
      { type: "block.add", block: {} as never },
      { type: "block.update", block: {} as never },
      { type: "mode", mode: "athan" },
      { type: "listening", active: true },
      { type: "session.ended", endedAt: 5 },
      { type: "status", status: {} as never },
      { type: "snapshot", track: "soniox", session: null, segments: [], status: {} as never },
    ];
    for (const m of data) ws.receive(m);
    ws.receive({ type: "level", rmsDbfs: 0, peakDbfs: 0 });
    ws.receive(new ArrayBuffer(8));
    ws.receive("{oops");
    expect(h.onData.mock.calls.map((c) => c[0].type)).toEqual(data.map((m) => m.type));
  });

  it.each([
    ["unauthorized", 300_000],
    ["quota_exceeded", 300_000],
    ["engine_unavailable", 30_000],
    ["screen_invalid", 60_000],
    ["screen_required", 60_000],
    ["something_new", 10_000],
  ])("retries %s after %i ms", (code, retry) => {
    const { page, h, ws } = ready();
    ws.receive({ type: "error", code, message: "nope" });
    expect(page.ready).toBe(false);
    expect(h.onError).toHaveBeenCalledWith(code, "nope", retry);
    expect(ws.closes[0]).toEqual({ code: 4000, reason: "client restart" });
    expect(h.onState).toHaveBeenLastCalledWith("down", expect.any(Number));
    vi.advanceTimersByTime(retry - 1);
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("gives up on a language pair the server refuses, until started again", () => {
    const { page, h, ws } = open();
    ws.receive({ type: "error", code: "bad_language", message: "No such pair" });
    expect(h.onError).toHaveBeenCalledWith("bad_language", "No such pair", null);
    expect(h.onState).toHaveBeenLastCalledWith("stopped", expect.any(Number));
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    page.start();
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("stops sending while its screen is switched off, and says hello again when it is on", () => {
    const { page, h, ws } = ready();
    ws.receive({ type: "screen", state: "disabled", name: "Hall" });
    expect(h.onScreen).toHaveBeenCalledWith("disabled", "Hall");
    expect(page.ready).toBe(false);
    expect(page.sessionId).toBeNull();
    expect(page.sendSpeech("start")).toBe(false);
    ws.receive({ type: "screen", state: "enabled", name: "Hall" });
    expect(h.onScreen).toHaveBeenLastCalledWith("enabled", "Hall");
    page.rehello();
    const hellos = ws.json().filter((m) => m.type === "hello");
    expect(hellos).toHaveLength(2);
    expect(hellos[1]?.resume).toBeNull();
    expect(page.ready).toBe(false);
  });

  it("passes a reload request on as it is", () => {
    const { page, h, ws } = ready();
    ws.receive({ type: "screen", state: "reload", name: "" });
    expect(h.onScreen).toHaveBeenCalledWith("reload", "");
    expect(page.sessionId).toBe("s1");
  });

  it("says hello again only on an open socket", () => {
    const h = handlers();
    const page = new PageSocket(
      { from: "ar", to: "nl", key: null, layout: "blocks", screen: null },
      h,
    );
    page.rehello();
    page.start();
    page.rehello();
    expect(FakeWebSocket.last().sent).toEqual([]);
  });

  it("stops: closes the socket and the watchdog", () => {
    const { page, ws } = ready();
    page.stop();
    expect(page.ready).toBe(false);
    expect(ws.closes).toEqual([{ code: 1000, reason: undefined }]);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    page.stop();
  });

  it("starts the stall watchdog once", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { page } = ready();
    page.start();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the send buffer has not drained for 8 s", () => {
    const { ws } = ready();
    ws.bufferedAmount = 6400;
    vi.advanceTimersByTime(9_000);
    expect(ws.closes).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(ws.closes).toEqual([{ code: 4000, reason: "client restart" }]);
  });

  it("keeps a link whose buffer drains or empties", () => {
    const { ws } = ready();
    ws.bufferedAmount = 6400;
    vi.advanceTimersByTime(5_000);
    ws.bufferedAmount = 3200;
    vi.advanceTimersByTime(1_000);
    ws.bufferedAmount = 3200;
    vi.advanceTimersByTime(5_000);
    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(5_000);
    ws.bufferedAmount = 100;
    vi.advanceTimersByTime(5_000);
    expect(ws.closes).toEqual([]);
  });

  it("does not watch a link that is not ready", () => {
    const { ws } = open();
    ws.bufferedAmount = 6400;
    vi.advanceTimersByTime(20_000);
    expect(ws.closes).toEqual([]);
  });
});
