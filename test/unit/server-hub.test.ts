import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, parseConfig } from "../../src/config.js";
import {
  Hub,
  keepAlive,
  MAX_BUFFERED_BYTES,
  PING_INTERVAL_MS,
  rawToBuffer,
  sendJson,
  Throttle,
} from "../../src/server/hub.js";
import { type ScreenConn, ScreenHub } from "../../src/server/screen-hub.js";
import type { ServerMessage, Status } from "../../src/shared/protocol.js";
import { captureLog, FakeManager, FakeSession, FakeSocket, flush } from "./helpers/server-fakes.js";

function config(raw: Record<string, unknown> = {}): Config {
  const result = parseConfig(raw, { inContainer: false, bindAddress: null });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.config;
}

const status = (session: FakeSession): ServerMessage => ({
  type: "status",
  status: session.status(),
});
const level = (rmsDbfs: number): ServerMessage => ({ type: "level", rmsDbfs, peakDbfs: -10 });

describe("hub socket helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends JSON to an open socket and drops a client that cannot keep up", () => {
    const socket = new FakeSocket();
    expect(sendJson(socket.ws, { type: "x" })).toBe(true);
    expect(socket.sent).toEqual([{ type: "x" }]);
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    expect(sendJson(socket.ws, { type: "y" })).toBe(false);
    expect(socket.terminated).toBe(true);
    expect(sendJson(socket.ws, { type: "z" })).toBe(false);
    expect(socket.sent).toHaveLength(1);
    // A custom limit.
    const small = new FakeSocket();
    small.bufferedAmount = 10;
    expect(sendJson(small.ws, { type: "x" }, 5)).toBe(false);
  });

  it("pings on every interval and terminates a socket that stopped answering", () => {
    const socket = new FakeSocket();
    const ticks = vi.fn();
    keepAlive(socket.ws, { intervalMs: 1000, onTick: ticks });
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    socket.emit("pong");
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(2);
    // No pong this time: the next tick terminates it.
    vi.advanceTimersByTime(1000);
    expect(socket.terminated).toBe(true);
    expect(ticks).toHaveBeenCalledTimes(2);
  });

  it("terminates a socket whose send buffer is over the limit, or whose ping throws", () => {
    const full = new FakeSocket();
    keepAlive(full.ws, { intervalMs: 100, maxBuffered: 10 });
    full.bufferedAmount = 11;
    vi.advanceTimersByTime(100);
    expect(full.terminated).toBe(true);
    expect(full.pings).toBe(0);

    const broken = new FakeSocket();
    broken.pingError = new Error("not open");
    const ticks = vi.fn();
    keepAlive(broken.ws, { intervalMs: 100, onTick: ticks });
    vi.advanceTimersByTime(100);
    expect(broken.terminated).toBe(true);
    expect(ticks).not.toHaveBeenCalled();
  });

  it("stops pinging once the socket closes, or when stopped by hand", async () => {
    const socket = new FakeSocket();
    keepAlive(socket.ws);
    socket.close();
    await flush();
    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(socket.pings).toBe(0);
    const other = new FakeSocket();
    const stop = keepAlive(other.ws, { intervalMs: 10 });
    stop();
    vi.advanceTimersByTime(100);
    expect(other.pings).toBe(0);
  });

  it("throttles to one value per interval and always delivers the latest", () => {
    let now = 10_000;
    const out: number[] = [];
    const t = new Throttle<number>(
      500,
      (v) => out.push(v),
      () => now,
    );
    t.push(1);
    expect(out).toEqual([1]);
    now += 100;
    t.push(2);
    t.push(3);
    expect(out).toEqual([1]);
    now += 400;
    vi.advanceTimersByTime(400);
    expect(out).toEqual([1, 3]);
    now += 100;
    t.push(4); // within the interval of the trailing value
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(out).toEqual([1, 3]);
    now += 1000;
    t.push(5);
    expect(out).toEqual([1, 3, 5]);
    t.cancel(); // nothing pending: harmless
  });

  it("turns any ws payload into a Buffer", () => {
    const buf = Buffer.from("abc");
    expect(rawToBuffer(buf)).toBe(buf);
    expect(rawToBuffer([Buffer.from("ab"), Buffer.from("c")]).toString()).toBe("abc");
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([1, 2, 3]);
    expect([...rawToBuffer(ab)]).toEqual([1, 2, 3]);
  });
});

describe("Hub (/ws for the overlay and control pages)", () => {
  let manager: FakeManager;
  let hub: Hub;
  let lines: Array<Record<string, unknown>>;

  function makeHub(raw: Record<string, unknown> = {}): Hub {
    const captured = captureLog();
    lines = captured.lines;
    return new Hub({
      manager,
      config: config(raw),
      log: captured.log,
      pingIntervalMs: 5_000,
      pollIntervalMs: 1_000,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 12, 0, 0));
    manager = new FakeManager();
    hub = makeHub();
  });

  afterEach(() => {
    hub.close();
    vi.useRealTimers();
  });

  it("says hello with the configured languages while idle, and forwards the idle monitor", () => {
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    expect(hub.size).toBe(1);
    expect(socket.sent[0]).toMatchObject({
      type: "hello",
      protocol: 1,
      sessionId: null,
      langs: { source: "ar", targets: ["nl"] },
      tracks: ["soniox"],
      primary: "soniox",
    });
    // Levels only for subscribers, at most 5 per second.
    manager.emitMonitor(level(-40));
    expect(socket.types()).toEqual(["hello"]);
    socket.text({ type: "subscribe", topics: ["level"] });
    manager.emitMonitor(level(-41));
    manager.emitMonitor(level(-42));
    vi.advanceTimersByTime(200);
    manager.emitMonitor(level(-43));
    expect(socket.sent.filter((m) => m.type === "level").map((m) => m.rmsDbfs)).toEqual([-41, -43]);
    // Unsubscribing (topics without level) stops them.
    socket.text({ type: "subscribe", topics: [] });
    vi.advanceTimersByTime(500);
    manager.emitMonitor(level(-44));
    expect(socket.sent.filter((m) => m.type === "level")).toHaveLength(2);
    // A hello from the session layer is never forwarded (the hub sends its own).
    manager.emitMonitor({
      type: "hello",
      protocol: 1,
      serverTime: 0,
      sessionId: null,
      langs: { source: "ar", targets: ["nl"] },
      tracks: ["soniox"],
      primary: "soniox",
    });
    expect(socket.types().filter((t) => t === "hello")).toHaveLength(1);
    // A clear while idle is passed on as is (no snapshots to resend).
    manager.emitMonitor({ type: "clear", track: "all" });
    expect(socket.types().at(-1)).toBe("clear");
  });

  it("falls back to pages.defaultFrom when no language hint is configured", () => {
    hub.close();
    hub = makeHub({ stt: { soniox: { languageHints: [] } }, pages: { defaultFrom: "ur" } });
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    expect(socket.sent[0]?.langs).toEqual({ source: "ur", targets: ["nl"] });
  });

  it("switches to the local session when it starts, with hello and snapshots, and back when it ends", () => {
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    expect(manager.monitorListeners.size).toBe(1);
    const local = manager.add(new FakeSession("loc1", "device", { from: "ar", to: "en" }));
    manager.localSession = local;
    vi.advanceTimersByTime(1000);
    expect(manager.monitorListeners.size).toBe(0);
    const hello = socket.last("hello");
    expect(hello).toMatchObject({ sessionId: "loc1", langs: { source: "ar", targets: ["en"] } });
    expect(socket.types().slice(-3)).toEqual(["hello", "snapshot", "mode"]);
    // Nothing changes on the next poll: no second hello.
    vi.advanceTimersByTime(1000);
    expect(socket.types().filter((t) => t === "hello")).toHaveLength(2);

    // Session messages: segments and blocks pass, statuses are throttled to 2/s, a snapshot
    // cancels a pending status, a clear resends the snapshots.
    local.emit({ type: "block.add", block: { id: "b", seq: 0 } as never });
    local.emit(status(local));
    local.emit(status(local));
    expect(socket.types().filter((t) => t === "status")).toHaveLength(1);
    local.emit({
      type: "snapshot",
      track: "soniox",
      session: local.info(),
      segments: [],
      status: local.status(),
    });
    vi.advanceTimersByTime(1000);
    expect(socket.types().filter((t) => t === "status")).toHaveLength(1);
    const before = socket.sent.length;
    local.emit({ type: "clear", track: "all" });
    expect(socket.types().slice(before)).toEqual(["clear", "snapshot", "mode"]);

    // The session ends: idle hello again, and the monitor is followed again.
    manager.localSession = null;
    vi.advanceTimersByTime(1000);
    expect(socket.last("hello")?.sessionId).toBeNull();
    expect(manager.monitorListeners.size).toBe(1);
    expect(local.listeners.size).toBe(0);
  });

  it("names the primary track when no track is active", () => {
    const local = manager.add(new FakeSession("loc2", "file"));
    local.tracks = local.tracks.map((t) => ({ ...t, active: false }));
    manager.localSession = local;
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    expect(socket.sent[0]).toMatchObject({ sessionId: "loc2", tracks: ["soniox"] });
  });

  it("follows one session with ?session=, without the idle monitor", () => {
    const socket = new FakeSocket();
    hub.handle(socket.ws, "page7");
    expect(socket.sent[0]?.sessionId).toBeNull();
    expect(manager.monitorListeners.size).toBe(0);
    manager.add(new FakeSession("page7", "page"));
    vi.advanceTimersByTime(1000);
    expect(socket.last("hello")?.sessionId).toBe("page7");
  });

  it("logs and waits when the session lookup fails, and closes the socket when attaching fails", () => {
    manager.localError = new Error("lookup broke");
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    expect(socket.sent).toEqual([]);
    expect(lines.some((l) => l.msg === "hub: session lookup failed")).toBe(true);
    manager.localError = null;
    const broken = manager.add(new FakeSession("bad", "device"));
    broken.info = () => {
      throw new Error("info broke");
    };
    manager.localSession = broken;
    vi.advanceTimersByTime(1000);
    expect(lines.some((l) => l.msg === "hub: attach failed")).toBe(true);
    expect(socket.closeCode).toBe(1011);
  });

  it("ignores binary, oversized, malformed and unknown client messages", () => {
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "subscribe", topics: ["level"] })),
      true,
    );
    socket.text(`{"type":"subscribe","topics":["level"],"pad":"${"x".repeat(5000)}"}`);
    socket.text("{not json");
    socket.text("null");
    socket.text("42");
    socket.text({ type: "subscribe", topics: "level" });
    socket.text({ type: "other", topics: ["level"] });
    manager.emitMonitor(level(-40));
    expect(socket.types()).toEqual(["hello"]);
  });

  it("stops polling when the last client leaves, and starts again for the next", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.handle(a.ws, null);
    hub.handle(b.ws, null);
    expect(hub.size).toBe(2);
    a.close();
    await flush();
    expect(hub.size).toBe(1);
    b.close();
    await flush();
    expect(hub.size).toBe(0);
    expect(manager.monitorListeners.size).toBe(0);
    manager.localSession = manager.add(new FakeSession("later", "device"));
    vi.advanceTimersByTime(5000);
    expect(b.types()).toEqual(["hello"]);
    const c = new FakeSocket();
    hub.handle(c.ws, null);
    expect(c.sent[0]?.sessionId).toBe("later");
  });

  it("pings its clients and detaches every client on close", () => {
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    vi.advanceTimersByTime(5_000);
    expect(socket.pings).toBe(1);
    hub.close();
    expect(hub.size).toBe(0);
    expect(manager.monitorListeners.size).toBe(0);
    hub.close(); // twice is harmless
  });

  it("uses the default ping interval when none is given", () => {
    const plain = new Hub({ manager, config: config(), log: captureLog().log });
    const socket = new FakeSocket();
    plain.handle(socket.ws, null);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.pings).toBe(1);
    plain.close();
  });

  it("sends nothing to a socket that is no longer open", () => {
    const socket = new FakeSocket();
    hub.handle(socket.ws, null);
    socket.readyState = 2;
    manager.emitMonitor({ type: "status", status: {} as Status });
    expect(socket.types()).toEqual(["hello"]);
  });
});

describe("ScreenHub", () => {
  const conn = (): ScreenConn => ({
    connectedAt: 0,
    session: null,
    notifyEnabled: () => false,
    beginPark: () => {},
    park: () => {},
    invalidate: () => {},
    reload: () => true,
  });

  it("keeps the sockets of each screen until they leave", () => {
    const hub = new ScreenHub();
    const a = conn();
    const b = conn();
    hub.add("s1", a);
    hub.add("s1", b);
    hub.add("s2", a);
    expect(hub.list("s1")).toEqual([a, b]);
    hub.remove("s1", a);
    expect(hub.list("s1")).toEqual([b]);
    hub.remove("s1", b);
    expect(hub.list("s1")).toEqual([]);
    hub.remove("s1", b); // unknown screen: nothing happens
    hub.clear();
    expect(hub.list("s2")).toEqual([]);
  });
});
