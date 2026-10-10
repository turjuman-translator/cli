import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { OrgStore } from "../../src/accounts/orgs.js";
import { type ScreenRecord, ScreenStore } from "../../src/accounts/screens.js";
import { SigningSecret } from "../../src/accounts/secret.js";
import { type UserRecord, UserStore } from "../../src/accounts/users.js";
import { KeyStore } from "../../src/auth/keys.js";
import { FailureRateLimiter } from "../../src/auth/rate-limit.js";
import { SessionError } from "../../src/core/contracts.js";
import { UsageStore } from "../../src/core/usage.js";
import { loadLanguages } from "../../src/languages.js";
import {
  CLOSE_REPLACED,
  CLOSE_SESSION_ENDED,
  PageSockets,
  type PageSocketsDeps,
  TokenBucket,
} from "../../src/server/page-ws.js";
import { ScreenHub } from "../../src/server/screen-hub.js";
import type { ServerMessage } from "../../src/shared/protocol.js";
import {
  captureLog,
  FakeManager,
  FakeSession,
  FakeSocket,
  fakeRequest,
  flush,
  hello,
  LANGUAGES_FILE,
  TempRoot,
} from "./helpers/server-fakes.js";

const actor = { id: null, name: "test" };
const LAN = "server:\n  host: 0.0.0.0\n  exposure: lan\n";
const HOSTED = "mode: hosted\n";
const languages = loadLanguages(LANGUAGES_FILE);

describe("TokenBucket", () => {
  it("allows a burst, then refills at its rate", () => {
    let now = 0;
    const bucket = new TokenBucket(0.01, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    now = 100;
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    now = 10_000;
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
  });
});

describe("PageSockets (/ws/page)", () => {
  let root: TempRoot;
  let manager: FakeManager;
  let pages: PageSockets;
  let screens: ScreenStore;
  let keys: KeyStore;
  let usage: UsageStore;
  let users: UserStore;
  let orgs: OrgStore;
  let hub: ScreenHub;
  let limiter: FailureRateLimiter;
  let lines: Array<Record<string, unknown>>;
  let requireScreen: boolean;
  let viewer: UserRecord | null;

  function setup(yaml = "", deps: Partial<PageSocketsDeps> = {}): PageSockets {
    const loaded = root.load(yaml);
    const captured = captureLog();
    lines = captured.lines;
    pages = new PageSockets({
      loaded,
      manager,
      keys,
      usage,
      languages,
      limiter,
      screens,
      secret: new SigningSecret(root.path("secret.key"), ""),
      hub,
      requireScreen: () => requireScreen,
      log: captured.log,
      helloTimeoutMs: 1_000,
      pingIntervalMs: 5_000,
      userOf: () => viewer,
      users,
      orgs,
      screenSyncMs: 0,
      ...deps,
    });
    return pages;
  }

  function connect(
    opts: Parameters<typeof fakeRequest>[0] = {},
    configure: (socket: FakeSocket) => void = () => {},
  ): FakeSocket {
    const socket = new FakeSocket();
    socket.autoPong = true;
    configure(socket);
    pages.handle(socket.ws, fakeRequest(opts));
    return socket;
  }

  /** A socket that said hello and is ready; its session. */
  function readyPage(extra: Record<string, unknown> = {}): {
    socket: FakeSocket;
    session: FakeSession;
  } {
    const socket = connect();
    socket.text(hello(extra));
    const ready = socket.last("ready");
    if (ready === undefined) throw new Error(`not ready: ${JSON.stringify(socket.sent)}`);
    return { socket, session: manager.page(String(ready.sessionId)) };
  }

  function screen(extra: { enabled?: boolean; orgId?: string; to?: string } = {}): ScreenRecord {
    const created = screens.create(
      {
        name: "Hall",
        from: "ar",
        to: extra.to ?? "nl",
        query: "",
        ownerId: null,
        ...(extra.orgId === undefined ? {} : { orgId: extra.orgId }),
      },
      actor,
    );
    return extra.enabled === false
      ? created
      : screens.update(created.id, { enabled: true }, "enabled", actor);
  }

  function user(username: string, orgId = "local"): UserRecord {
    return users.insert({ username, role: "admin", passwordHash: "hash", orgId });
  }

  const logged = (msg: string): Record<string, unknown> | undefined =>
    lines.find((l) => l.msg === msg);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 12, 0, 0));
    root = new TempRoot("page-ws-");
    manager = new FakeManager();
    screens = new ScreenStore(root.path("screens.yaml"));
    keys = new KeyStore(root.path("keys.yaml"));
    usage = new UsageStore({ dir: root.path("usage"), flushIntervalMs: 0 });
    users = new UserStore(root.path("users.yaml"));
    orgs = new OrgStore(root.path("orgs.yaml"));
    hub = new ScreenHub();
    limiter = new FailureRateLimiter();
    requireScreen = false;
    viewer = null;
  });

  afterEach(() => {
    pages?.close();
    usage.close();
    vi.useRealTimers();
    root.remove();
  });

  describe("handshake", () => {
    it("answers a hello with ready, the limits and the session's snapshots", () => {
      setup();
      const socket = connect();
      socket.text(hello({ layout: "rollup", engine: "gemini", translation: "llm" }));
      expect(socket.types()).toEqual(["ready", "snapshot", "mode"]);
      expect(socket.sent[0]).toEqual({
        type: "ready",
        sessionId: "page1",
        resumed: false,
        vad: {
          thresholdDbfs: -45,
          minSpeechMs: 200,
          minSilenceMs: 300,
          hangoverMs: 1500,
          prerollMs: 500,
        },
        limits: { maxFrameBytes: 3200, maxRealtimeFactor: 1.5, dailyMinutesLeft: null },
      });
      expect(manager.pageRequests[0]).toMatchObject({
        from: "ar",
        to: "nl",
        keyId: null,
        keyLabel: null,
        client: { obs: false, ua: "test" },
        layout: "rollup",
        orgId: "local",
      });
      expect(logged("page: ready")).toMatchObject({
        sessionId: "page1",
        keyId: null,
        screen: null,
      });
      // The hello timer was cleared: the socket stays open.
      vi.advanceTimersByTime(5_000);
      expect(socket.closeCode).toBeNull();
    });

    it("closes a socket that sends audio, garbage or nothing before its hello", () => {
      setup();
      const binary = connect();
      binary.binary(3200);
      expect([binary.closeCode, binary.closeReason]).toEqual([1002, "expected hello"]);
      const garbage = connect();
      garbage.text("{not json");
      expect([garbage.closeCode, garbage.closeReason]).toEqual([1002, "invalid hello"]);
      const wrong = connect();
      wrong.text(hello({ protocol: 2 }));
      expect(wrong.closeCode).toBe(1002);
      const silent = connect();
      vi.advanceTimersByTime(999);
      expect(silent.closeCode).toBeNull();
      vi.advanceTimersByTime(1);
      expect([silent.closeCode, silent.closeReason]).toEqual([1008, "hello timeout"]);
      expect(manager.pageRequests).toHaveLength(0);
    });

    it("refuses other websites before reading anything, and ignores what they send", () => {
      setup();
      const socket = connect({ origin: "https://evil.example" });
      expect(socket.sent[0]).toMatchObject({ type: "error", code: "unauthorized" });
      expect(String(socket.sent[0]?.message)).toContain("not allowed");
      expect([socket.closeCode, socket.closeReason]).toEqual([1008, "unauthorized"]);
      expect(logged("page: origin rejected")).toMatchObject({ origin: "https://evil.example" });
      socket.text(hello());
      expect(socket.sent).toHaveLength(1);
      expect(manager.pageRequests).toHaveLength(0);
      // A client that never completes the close: the hello timer finds it closed already.
      const lingering = connect({ origin: "https://evil.example" }, (s) => {
        s.holdClose = true;
      });
      vi.advanceTimersByTime(1_000);
      expect([lingering.closeCode, lingering.closeReason]).toEqual([1008, "unauthorized"]);
    });

    it("refuses every page while caption pages are disabled", () => {
      setup("pages:\n  enabled: false\n");
      const socket = connect();
      expect(socket.sent[0]).toEqual({
        type: "error",
        code: "engine_unavailable",
        message: "Caption pages are disabled on this server (pages.enabled: false)",
      });
    });

    it("refuses an unknown language pair", () => {
      setup();
      const socket = connect();
      socket.text(hello({ to: "xx" }));
      expect(socket.sent[0]).toEqual({
        type: "error",
        code: "bad_language",
        message: 'Unknown target language "xx"',
      });
    });

    it("passes the session layer's refusal on, and hides unexpected failures", () => {
      setup();
      manager.createError = new SessionError("engine_unavailable", "the server is shutting down");
      const refused = connect();
      refused.text(hello());
      expect(refused.sent[0]).toEqual({
        type: "error",
        code: "engine_unavailable",
        message: "the server is shutting down",
      });
      manager.createError = new Error("disk full");
      const broken = connect();
      broken.text(hello());
      expect(broken.sent[0]).toEqual({
        type: "error",
        code: "engine_unavailable",
        message: "The server could not start a caption session",
      });
      expect(logged("page: createPage failed")).toBeDefined();
    });

    it("releases a session made for a socket that closed meanwhile", () => {
      setup();
      const socket = connect();
      const create = manager.createPage.bind(manager);
      manager.createPage = (req) => {
        socket.readyState = 3;
        return create(req);
      };
      socket.text(hello());
      expect(socket.sent).toEqual([]);
      expect(manager.page("page1").detaches).toBe(1);
    });

    it("works without the optional dependencies (timeouts, login lookup)", async () => {
      setup("", { helloTimeoutMs: undefined, pingIntervalMs: undefined, userOf: undefined });
      const socket = connect();
      vi.advanceTimersByTime(9_999);
      expect(socket.closeCode).toBeNull();
      vi.advanceTimersByTime(1);
      expect(socket.closeCode).toBe(1008);
      const pinged = connect();
      pinged.text(hello());
      vi.advanceTimersByTime(10_000);
      expect(pinged.pings).toBe(1);
    });

    it("treats a failing login lookup as no login", () => {
      setup(LAN, {
        userOf: () => {
          throw new Error("cookie store broke");
        },
      });
      const socket = connect();
      socket.text(hello());
      expect(socket.sent[0]).toMatchObject({ type: "error", code: "unauthorized" });
      expect(logged("page: login check failed")).toBeDefined();
    });
  });

  describe("streaming", () => {
    it("passes speech events and real-time frames on, dropping bursts and wrong sizes", () => {
      setup();
      const { socket, session } = readyPage();
      socket.text({ type: "speech", state: "start" });
      for (let i = 0; i < 9; i++) socket.binary(3200);
      socket.binary(100);
      // Burst: the pre-roll (500 ms = 5 frames) + 2.
      expect(session.frames).toEqual(Array(7).fill(3200));
      const drops = lines.filter((l) => l.msg === "page: frames dropped");
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({
        sessionId: session.id,
        dropped: 1,
        reason: "rate",
        bytes: 3200,
      });
      vi.setSystemTime(Date.now() + 10_000);
      socket.binary(100);
      expect(lines.filter((l) => l.msg === "page: frames dropped").at(-1)).toMatchObject({
        dropped: 4,
        reason: "size",
        bytes: 100,
      });
      socket.binary(3200);
      expect(session.frames).toHaveLength(8);
      socket.text({ type: "speech", state: "end" });
      socket.text({ type: "speech", state: "loud" });
      socket.text("{not json");
      socket.text(`{"type":"speech","state":"start","pad":"${"x".repeat(9000)}"}`);
      expect(session.speechEvents).toEqual(["start", "end"]);
    });

    it("forwards the session's messages, statuses at most twice a second", () => {
      setup();
      const { socket, session } = readyPage();
      const start = socket.sent.length;
      const status: ServerMessage = { type: "status", status: session.status() };
      session.emit(status);
      session.emit(status);
      session.emit(status);
      expect(socket.types().slice(start)).toEqual(["status"]);
      vi.advanceTimersByTime(500);
      expect(socket.types().slice(start)).toEqual(["status", "status"]);
      session.emit(status);
      session.emit({
        type: "snapshot",
        track: "soniox",
        session: session.info(),
        segments: [],
        status: session.status(),
      });
      vi.advanceTimersByTime(1_000);
      const block = { id: "b1", seq: 1 } as never;
      for (const msg of [
        { type: "segment", track: "soniox", segment: {} },
        { type: "clear", track: "all" },
        { type: "blocks.snapshot", blocks: [], hasMore: false },
        { type: "block.add", block },
        { type: "block.update", block },
        { type: "mode", mode: "athan" },
        { type: "listening", active: true },
        { type: "level", rmsDbfs: -20, peakDbfs: -10 },
        {
          type: "hello",
          protocol: 1,
          serverTime: 0,
          sessionId: "x",
          langs: { source: "ar", targets: ["nl"] },
          tracks: ["soniox"],
          primary: "soniox",
        },
      ] as ServerMessage[]) {
        session.emit(msg);
      }
      expect(socket.types().slice(start + 2)).toEqual([
        "snapshot",
        "segment",
        "clear",
        "blocks.snapshot",
        "block.add",
        "block.update",
        "mode",
        "listening",
      ]);
      session.emit({ type: "session.ended", endedAt: 5 });
      expect(socket.last("session.ended")).toEqual({ type: "session.ended", endedAt: 5 });
      expect([socket.closeCode, socket.closeReason]).toEqual([
        CLOSE_SESSION_ENDED,
        "session ended",
      ]);
    });

    it("closes the socket when its session disappears (checked at every ping)", () => {
      setup();
      const { socket, session } = readyPage();
      vi.advanceTimersByTime(5_000);
      expect(socket.closeCode).toBeNull();
      manager.sessions.delete(session.id);
      vi.advanceTimersByTime(5_000);
      expect([socket.closeCode, socket.closeReason]).toEqual([
        CLOSE_SESSION_ENDED,
        "session ended",
      ]);
    });

    it("closes the socket when handling a message fails", () => {
      setup();
      const { socket, session } = readyPage();
      session.speech = () => {
        throw new Error("speech broke");
      };
      socket.text({ type: "speech", state: "start" });
      expect([socket.closeCode, socket.closeReason]).toEqual([1011, "internal error"]);
      expect(logged("page: message handling failed")).toBeDefined();
    });

    it("detaches the session when the socket closes (a failing detach is logged)", async () => {
      setup();
      const { socket, session } = readyPage();
      session.detachError = new Error("detach broke");
      socket.close();
      await flush();
      expect(session.detaches).toBe(1);
      expect(logged("page: detach failed")).toMatchObject({ sessionId: session.id });
      // The session was stopped meanwhile: a resume starts a new one.
      await session.stop("grace expired");
      const again = connect();
      again.text(hello({ resume: session.id }));
      expect(again.last("ready")).toMatchObject({ resumed: false, sessionId: "page2" });
    });
  });

  describe("resume", () => {
    it("resumes the session of a page that reconnects; the newest socket wins", async () => {
      setup();
      const { socket: first, session } = readyPage();
      const second = connect();
      second.text(hello({ resume: session.id }));
      expect(second.last("ready")).toMatchObject({ sessionId: session.id, resumed: true });
      expect(session.attaches).toBe(1);
      expect([first.closeCode, first.closeReason]).toEqual([CLOSE_REPLACED, "resumed elsewhere"]);
      await flush();
      // The replaced socket's close does not detach the session the new one feeds.
      expect(session.detaches).toBe(0);
      second.close();
      await flush();
      expect(session.detaches).toBe(1);
      const third = connect();
      third.text(hello({ resume: session.id }));
      expect(third.last("ready")).toMatchObject({ sessionId: session.id, resumed: true });
    });

    it("does not close twice a replaced socket that had already failed", () => {
      setup();
      const { socket: first, session } = readyPage();
      const speech = session.speech.bind(session);
      session.speech = () => {
        throw new Error("speech broke");
      };
      first.text({ type: "speech", state: "start" });
      expect(first.closeCode).toBe(1011);
      session.speech = speech;
      // Its close has not arrived yet when the page reconnects.
      const second = connect();
      second.text(hello({ resume: session.id }));
      expect(second.last("ready")).toMatchObject({ resumed: true });
      expect(first.closeCode).toBe(1011);
    });

    it("starts a new session when the resume does not match", async () => {
      setup();
      const { socket, session } = readyPage();
      socket.close();
      await flush();
      const otherPair = connect();
      otherPair.text(hello({ resume: session.id, to: "en" }));
      expect(otherPair.last("ready")).toMatchObject({ resumed: false, sessionId: "page2" });
      const unknown = connect();
      unknown.text(hello({ resume: "nope" }));
      expect(unknown.last("ready")).toMatchObject({ resumed: false, sessionId: "page3" });
      // Not a page session (any more).
      manager.sessions.set(session.id, new FakeSession(session.id, "device"));
      const notPage = connect();
      notPage.text(hello({ resume: session.id }));
      expect(notPage.last("ready")).toMatchObject({ resumed: false, sessionId: "page4" });
      const empty = connect();
      empty.text(hello({ resume: "" }));
      expect(empty.last("ready")).toMatchObject({ resumed: false });
    });
  });

  describe("access keys (exposure lan)", () => {
    it("refuses a page without a key or with a wrong one, and blocks after 10 failures", () => {
      setup(LAN);
      const none = connect();
      none.text(hello());
      expect(none.sent[0]).toEqual({
        type: "error",
        code: "unauthorized",
        message: "This server needs an access key: add ?key=… to the page URL",
      });
      for (let i = 0; i < 9; i++) {
        const wrong = connect();
        wrong.text(hello({ key: `wrong-${i}` }));
        expect(wrong.sent[0]?.message).toBe("Invalid or expired access key");
      }
      const { key } = keys.add({ label: "Hall key" });
      const blocked = connect();
      blocked.text(hello({ key }));
      expect(blocked.sent[0]).toMatchObject({ code: "unauthorized" });
      expect(String(blocked.sent[0]?.message)).toMatch(/^Too many failed key attempts .* 10 min$/);
      expect(logged("page: access key rejected")).toMatchObject({ keyPresented: false });
    });

    it("accepts a valid key, labels the session with it and shows the minutes left", () => {
      setup(LAN);
      const { id, key } = keys.add({ label: "Hall key", dailyMinutes: 60 });
      usage.add(id, "soniox", 15 * 60_000);
      const { socket } = readyPage({ key });
      expect(socket.sent[0]).toMatchObject({ limits: { dailyMinutesLeft: 45 } });
      expect(manager.pageRequests[0]).toMatchObject({ keyId: id, keyLabel: "Hall key" });
      expect(logged("page: ready")).toMatchObject({ keyId: id, keyLabel: "Hall key" });
    });

    it("refuses a key whose daily minutes are used up", () => {
      setup(LAN);
      const { id, key } = keys.add({ label: "Small", dailyMinutes: 1 });
      usage.add(id, "soniox", 60_000);
      const socket = connect();
      socket.text(hello({ key }));
      expect(socket.sent[0]).toEqual({
        type: "error",
        code: "quota_exceeded",
        message: "The daily limit of 1 min for this key is used up",
      });
    });

    it("stops a session mid-way when the key's daily minutes run out", () => {
      setup(LAN);
      manager.removeOnStop = false;
      const { id, key } = keys.add({ label: "Small", dailyMinutes: 1 });
      const { socket, session } = readyPage({ key });
      session.onUsage?.("soniox", 30_000);
      expect(socket.closeCode).toBeNull();
      session.onUsage?.("soniox", 30_000);
      expect(socket.last("error")).toEqual({
        type: "error",
        code: "quota_exceeded",
        message: "The daily limit of 1 min for this key is used up",
      });
      expect(session.stopReasons).toEqual(["quota_exceeded"]);
      expect(logged("page: stopping session")).toMatchObject({ keyId: id, code: "quota_exceeded" });
      // Later reports still count, but stop nothing twice.
      session.onUsage?.("soniox", 30_000);
      expect(usage.minutesToday(id)).toBe(1.5);
      expect(session.stopReasons).toHaveLength(1);
    });

    it("stops a session within 30 s of its key being revoked", async () => {
      setup(LAN);
      const { id, key } = keys.add({ label: "Hall" });
      const { socket, session } = readyPage({ key });
      session.stopError = new Error("stop broke");
      session.onUsage?.("soniox", 1_000);
      vi.setSystemTime(Date.now() + 30_000);
      session.onUsage?.("soniox", 1_000); // re-checked: still there
      keys.revoke(id);
      session.onUsage?.("soniox", 1_000); // re-checked less than 30 s ago
      expect(socket.closeCode).toBeNull();
      vi.setSystemTime(Date.now() + 30_000);
      session.onUsage?.("soniox", 1_000);
      expect(socket.last("error")).toMatchObject({
        code: "unauthorized",
        message: "The access key was revoked",
      });
      await flush();
      expect(logged("page: stop failed")).toMatchObject({ sessionId: session.id });
    });

    it("lets a login stand in for a key, and stops the session when the login ends", () => {
      setup(LAN);
      viewer = user("imam");
      const { socket, session } = readyPage();
      expect(manager.pageRequests[0]).toMatchObject({ keyId: null, keyLabel: "account: imam" });
      session.onUsage?.("soniox", 1_000);
      expect(socket.closeCode).toBeNull();
      users.update(viewer.id, { passwordHash: "new-hash" }); // logs out every device
      session.onUsage?.("soniox", 1_000);
      expect(socket.last("error")).toEqual({
        type: "error",
        code: "unauthorized",
        message: "This login is no longer valid: log in again",
      });
    });

    it("no longer accepts a login that was disabled or deleted", () => {
      setup(LAN);
      const disabled = user("disabled");
      viewer = disabled;
      user("second-admin");
      users.update(disabled.id, { disabled: true });
      const a = connect();
      a.text(hello());
      expect(a.sent[0]).toMatchObject({ code: "unauthorized" });
      const gone = user("gone");
      viewer = gone;
      const b = connect();
      users.remove(gone.id);
      b.text(hello());
      expect(b.sent[0]).toMatchObject({ code: "unauthorized" });
    });

    it("needs no key at exposure local, but uses one for attribution", () => {
      setup();
      const { id, key } = keys.add({ label: "Attributed" });
      const { socket, session } = readyPage({ key });
      expect(manager.pageRequests[0]).toMatchObject({ keyId: id, keyLabel: "Attributed" });
      // A revoked key does not stop a local session.
      keys.revoke(id);
      vi.setSystemTime(Date.now() + 60_000);
      session.onUsage?.("soniox", 1_000);
      expect(socket.closeCode).toBeNull();
      const wrong = connect();
      wrong.text(hello({ key: "not-a-key" }));
      expect(manager.pageRequests[1]).toMatchObject({ keyId: null, keyLabel: null });
      // Without a key, usage is counted for "local" and nothing is checked.
      const { session: plain } = readyPage();
      plain.onUsage?.("soniox", 6_000);
      expect(usage.minutesToday(null)).toBe(0.1);
    });
  });

  describe("screens", () => {
    it("starts a screen's session from its link, in any exposure, and shows it live", () => {
      setup(LAN);
      const s = screen();
      const { socket, session } = readyPage({ screen: { guid: s.guid } });
      expect(manager.pageRequests[0]).toMatchObject({ keyId: null, keyLabel: "screen: Hall" });
      expect(pages.screenLive(s.id)).toEqual({
        pages: 1,
        sessions: 1,
        speaking: false,
        since: session.startedAt,
        event: null,
      });
      const [conn] = hub.list(s.id);
      expect(conn?.session).toBe(session);
      session.speaking = true;
      session.eventMode = "held";
      expect(pages.screenLive(s.id)).toMatchObject({ speaking: true, event: null });
      session.eventMode = "athan";
      const { session: second } = readyPage({ screen: { guid: s.guid } });
      second.eventMode = "iqama";
      expect(pages.screenLive(s.id)).toMatchObject({ pages: 2, sessions: 2, event: "athan" });
      // Sessions that are stopping are not live any more.
      session.state = "stopping";
      second.state = "stopping";
      expect(pages.screenLive(s.id)).toMatchObject({ pages: 2, sessions: 0, since: null });
      expect(socket.closeCode).toBeNull();
    });

    it("refuses unknown links, links used with other languages, and links it cannot check", () => {
      setup();
      const s = screen();
      const unknown = connect();
      unknown.text(hello({ screen: { guid: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" } }));
      expect(unknown.sent[0]).toEqual({
        type: "error",
        code: "screen_invalid",
        message: "This link is no longer valid",
      });
      const other = connect();
      other.text(hello({ to: "en", screen: { guid: s.guid } }));
      expect(other.sent[0]).toMatchObject({ code: "screen_invalid" });
      expect(logged("page: screen link used with other languages")).toMatchObject({ screen: s.id });
      vi.spyOn(screens, "byGuid").mockImplementation(() => {
        throw new Error("screens.yaml unreadable");
      });
      const broken = connect();
      broken.text(hello({ screen: { guid: s.guid } }));
      expect(broken.sent[0]).toEqual({
        type: "error",
        code: "engine_unavailable",
        message: "The server could not check this screen link",
      });
    });

    it("requires a screen link when pages.requireScreen is on", () => {
      setup();
      requireScreen = true;
      const socket = connect();
      socket.text(hello());
      expect(socket.sent[0]).toEqual({
        type: "error",
        code: "screen_required",
        message:
          "This server only shows captions for signed screen links (made in the admin portal)",
      });
    });

    it("parks the page of a screen that is off, and wakes it when the screen is switched on", () => {
      setup();
      const s = screen({ enabled: false });
      const socket = connect();
      socket.text(hello({ screen: { guid: s.guid } }));
      expect(socket.sent).toEqual([{ type: "screen", state: "disabled", name: "Hall" }]);
      expect(manager.pageRequests).toHaveLength(0);
      expect(pages.screenLive(s.id)).toMatchObject({ pages: 1, sessions: 0 });
      expect(hub.list(s.id)[0]?.session).toBeNull();
      // Parked: audio and other messages are ignored; a hello is checked again.
      socket.binary(3200);
      socket.text({ type: "speech", state: "start" });
      socket.text("{bad");
      socket.text(hello({ screen: { guid: s.guid } }));
      expect(socket.types()).toEqual(["screen", "screen"]);
      vi.advanceTimersByTime(60_000);
      expect(socket.closeCode).toBeNull();

      screens.update(s.id, { enabled: true }, "enabled", actor);
      expect(pages.enableScreen(s.id, "Hall")).toBe(1);
      expect(socket.last("screen")).toEqual({ type: "screen", state: "enabled", name: "Hall" });
      expect(pages.enableScreen(s.id, "Hall")).toBe(0);
      // Audio still in flight and stray messages are ignored until the new hello.
      socket.binary(3200);
      socket.text("{bad");
      expect(socket.closeCode).toBeNull();
      socket.text(hello({ screen: { guid: s.guid } }));
      expect(socket.last("ready")).toMatchObject({ resumed: false });
      expect(manager.pageRequests).toHaveLength(1);
    });

    it("does nothing for a hello that arrives on a closing socket", () => {
      setup();
      const s = screen({ enabled: false });
      const socket = connect();
      socket.readyState = 2;
      socket.text(hello({ screen: { guid: s.guid } }));
      expect(socket.sent).toEqual([]);
      expect(hub.list(s.id)).toEqual([]);
    });

    it("closes a woken page that never says hello again", () => {
      setup();
      const s = screen({ enabled: false });
      const socket = connect();
      socket.text(hello({ screen: { guid: s.guid } }));
      pages.enableScreen(s.id, "Hall");
      vi.advanceTimersByTime(29_999);
      expect(socket.closeCode).toBeNull();
      vi.advanceTimersByTime(1);
      expect([socket.closeCode, socket.closeReason]).toEqual([1008, "hello timeout"]);
    });

    it("switching a screen off stops its sessions and parks its pages", async () => {
      setup();
      const s = screen();
      const { socket, session } = readyPage({ screen: { guid: s.guid } });
      const stop = session.stop.bind(session);
      session.stop = async (reason) => {
        // The session ends while the screen is being switched off: the socket stays, and what
        // the page still sends meanwhile is ignored.
        session.emit({ type: "session.ended", endedAt: 9 });
        socket.text({ type: "speech", state: "start" });
        await stop(reason);
      };
      screens.update(s.id, { enabled: false }, "disabled", actor);
      expect(await pages.disableScreen(s.id, "Hall")).toBe(1);
      expect(session.stopReasons).toEqual(["screen disabled"]);
      expect(socket.types().slice(-2)).toEqual(["session.ended", "screen"]);
      expect(socket.last("screen")).toEqual({ type: "screen", state: "disabled", name: "Hall" });
      expect(socket.closeCode).toBeNull();
      expect(session.detaches).toBe(1);
      expect(session.speechEvents).toEqual([]);
      socket.binary(3200);
      expect(session.frames).toEqual([]);
      // Switched off again while parked: nothing more to tell the page.
      const sent = socket.sent.length;
      expect(await pages.disableScreen(s.id, "Hall")).toBe(0);
      expect(socket.sent).toHaveLength(sent);
    });

    it("wakes the parked pages at once when the screen was switched on again meanwhile", async () => {
      setup();
      const s = screen();
      const { socket } = readyPage({ screen: { guid: s.guid } });
      // The store says "on" again by the time the sessions have stopped.
      expect(await pages.disableScreen(s.id, "Hall")).toBe(1);
      expect(socket.types().slice(-2)).toEqual(["screen", "screen"]);
      expect(socket.last("screen")).toEqual({ type: "screen", state: "enabled", name: "Hall" });
    });

    it("resets, sets prayer events and reloads a screen's pages", async () => {
      setup();
      const s = screen();
      const { socket, session } = readyPage({ screen: { guid: s.guid } });
      expect(pages.resetScreen(s.id)).toBe(1);
      expect(session.clears).toEqual(["all"]);
      expect(pages.eventScreen(s.id, "iqama")).toBe(1);
      expect(session.events).toEqual(["iqama"]);
      expect(pages.reloadScreen(s.id)).toBe(1);
      expect(socket.last("screen")).toEqual({ type: "screen", state: "reload", name: "Hall" });
      screens.remove(s.id);
      expect(pages.reloadScreen(s.id)).toBe(1);
      expect(socket.last("screen")).toEqual({ type: "screen", state: "reload", name: "" });
      socket.readyState = 2;
      expect(pages.reloadScreen(s.id)).toBe(0);
      expect(pages.resetScreen("no-such-screen")).toBe(0);
      // A session the manager no longer knows is not the screen's any more.
      manager.sessions.delete(session.id);
      expect(pages.resetScreen(s.id)).toBe(0);
    });

    it("closes every page of a regenerated or deleted link and stops its sessions", async () => {
      setup();
      const s = screen();
      const { socket, session } = readyPage({ screen: { guid: s.guid } });
      manager.removeOnStop = false;
      const first = pages.invalidateScreen(s.id);
      const second = pages.invalidateScreen(s.id);
      expect([await first, await second]).toEqual([1, 1]);
      // One error, one close, one stop per call.
      expect(socket.types().filter((t) => t === "error")).toHaveLength(1);
      expect(session.stopReasons).toEqual(["screen link revoked", "screen link revoked"]);
      expect(socket.last("error")).toEqual({
        type: "error",
        code: "screen_invalid",
        message: "This link is no longer valid",
      });
      expect(socket.closeCode).toBe(1008);
      await flush();
      expect(hub.list(s.id)).toEqual([]);
    });

    it("re-checks a screen link every 30 s while it streams", () => {
      setup();
      const s = screen();
      const { socket, session } = readyPage({ screen: { guid: s.guid } });
      session.onUsage?.("soniox", 1_000);
      vi.setSystemTime(Date.now() + 30_000);
      session.onUsage?.("soniox", 1_000);
      expect(socket.closeCode).toBeNull();
      screens.update(s.id, { regenerate: true }, "regenerated", actor);
      session.onUsage?.("soniox", 1_000);
      expect(socket.closeCode).toBeNull();
      vi.setSystemTime(Date.now() + 30_000);
      session.onUsage?.("soniox", 1_000);
      expect(socket.last("error")).toMatchObject({ code: "screen_invalid" });
      expect(session.stopReasons).toEqual(["screen_invalid"]);
    });

    it("stops a screen's session when its languages change or it is deleted", () => {
      setup();
      const s = screen();
      const changed = readyPage({ screen: { guid: s.guid } });
      const other = screen();
      const deleted = readyPage({ screen: { guid: other.guid } });
      // Hand-edited languages (the portal cannot change them).
      const file = root.path("screens.yaml");
      const doc = parse(readFileSync(file, "utf8")) as {
        screens: Array<{ id: string; to: string }>;
      };
      for (const entry of doc.screens) if (entry.id === s.id) entry.to = "en";
      root.write("screens.yaml", stringify(doc));
      screens.reload(true);
      screens.remove(other.id);
      vi.setSystemTime(Date.now() + 30_000);
      changed.session.onUsage?.("soniox", 1_000);
      deleted.session.onUsage?.("soniox", 1_000);
      expect(changed.socket.last("error")).toMatchObject({ code: "screen_invalid" });
      expect(deleted.socket.last("error")).toMatchObject({ code: "screen_invalid" });
    });

    it("stops every session of a deleted organisation", async () => {
      setup();
      const { socket, session } = readyPage();
      const { socket: gone, session: goneSession } = readyPage({ to: "en" });
      manager.sessions.delete(goneSession.id);
      expect(await pages.stopOrg("other-org")).toBe(0);
      expect(socket.sent.some((m) => m.type === "error")).toBe(false);
      expect(await pages.stopOrg("local")).toBe(1);
      expect(session.stopReasons).toEqual(["organisation deleted"]);
      for (const s of [socket, gone]) {
        expect(s.last("error")).toEqual({
          type: "error",
          code: "unauthorized",
          message: "This organisation was deleted",
        });
      }
    });
  });

  describe("screens.yaml changed outside the app", () => {
    /** A parked page of a screen that is off. */
    function parkedPage(s: ScreenRecord): FakeSocket {
      const socket = connect();
      socket.text(hello({ screen: { guid: s.guid } }));
      expect(socket.last("screen")).toMatchObject({ state: "disabled" });
      return socket;
    }

    it("wakes a parked page whose screen was made and switched on since the last check", () => {
      setup();
      pages.syncScreens();
      // Both within one interval: the screen is new to the check, and already on.
      const s = screen({ enabled: false });
      const socket = parkedPage(s);
      screens.update(s.id, { enabled: true }, "enabled", actor);
      pages.syncScreens();
      expect(socket.last("screen")).toEqual({ type: "screen", state: "enabled", name: "Hall" });
      expect(logged("page: screen switched on outside the app")).toMatchObject({ screen: s.id });
      // Told once; its new hello makes it live.
      pages.syncScreens();
      expect(socket.types()).toEqual(["screen", "screen"]);
      socket.text(hello({ screen: { guid: s.guid } }));
      expect(socket.last("ready")).toMatchObject({ resumed: false });
      pages.syncScreens();
      expect(socket.types().filter((t) => t === "screen")).toHaveLength(2);
    });

    it("stops and parks a live page whose screen was switched on and off again since the last check", async () => {
      setup();
      const s = screen({ enabled: false });
      pages.syncScreens();
      screens.update(s.id, { enabled: true }, "enabled", actor);
      const { socket, session } = readyPage({ screen: { guid: s.guid } });
      screens.update(s.id, { enabled: false }, "disabled", actor);
      pages.syncScreens();
      await flush();
      expect(session.stopReasons).toEqual(["screen disabled"]);
      expect(socket.last("screen")).toEqual({ type: "screen", state: "disabled", name: "Hall" });
      expect(logged("page: screen switched off outside the app")).toMatchObject({ screen: s.id });
      // Parked now: nothing more to do.
      pages.syncScreens();
      await flush();
      expect(session.stopReasons).toEqual(["screen disabled"]);
    });

    it("wakes a page parked while its screen was off for a moment, and leaves the live one", () => {
      setup();
      const s = screen();
      const live = readyPage({ screen: { guid: s.guid } });
      screens.update(s.id, { enabled: false }, "disabled", actor);
      const parked = parkedPage(s);
      screens.update(s.id, { enabled: true }, "enabled", actor);
      pages.syncScreens();
      expect(parked.last("screen")).toMatchObject({ state: "enabled" });
      expect(live.session.stopReasons).toEqual([]);
      expect(live.socket.types()).toEqual(["ready", "snapshot", "mode"]);
    });

    it("closes the pages of a replaced link but not those of the new one, then all of a deleted screen", async () => {
      setup();
      const s = screen();
      const old = readyPage({ screen: { guid: s.guid } });
      const parkedOff = screen({ enabled: false });
      const parked = parkedPage(parkedOff);
      const renewed = screens.update(s.id, { regenerate: true }, "regenerated", actor);
      const fresh = readyPage({ screen: { guid: renewed.guid } });
      pages.syncScreens();
      expect(old.session.stopReasons).toEqual(["screen link revoked"]);
      expect(old.socket.last("error")).toEqual({
        type: "error",
        code: "screen_invalid",
        message: "This link is no longer valid",
      });
      expect(logged("page: screen link changed outside the app")).toMatchObject({ screen: s.id });
      expect(fresh.socket.sent.some((m) => m.type === "error")).toBe(false);
      await flush();
      screens.remove(s.id);
      screens.remove(parkedOff.id);
      pages.syncScreens();
      expect(fresh.socket.last("error")).toMatchObject({ code: "screen_invalid" });
      expect(fresh.session.stopReasons).toEqual(["screen link revoked"]);
      expect(parked.last("error")).toMatchObject({ code: "screen_invalid" });
      expect(logged("page: screen deleted outside the app")).toBeDefined();
      await flush();
      expect(hub.list(s.id)).toEqual([]);
    });

    it("also stops a session waiting for its page to come back (resume grace)", async () => {
      setup();
      manager.removeOnStop = false;
      const off = screen();
      const gone = screen({ to: "en" });
      const kept = screen();
      const a = readyPage({ screen: { guid: off.guid } });
      const b = readyPage({ screen: { guid: gone.guid }, to: "en" });
      const c = readyPage({ screen: { guid: kept.guid } });
      const stopping = readyPage({ screen: { guid: kept.guid } });
      const forgotten = readyPage({ screen: { guid: off.guid } });
      for (const page of [a, b, c, stopping, forgotten]) page.socket.terminate();
      stopping.session.state = "stopping";
      manager.sessions.delete(forgotten.session.id);
      screens.update(off.id, { enabled: false }, "disabled", actor);
      screens.remove(gone.id);
      pages.syncScreens();
      await flush();
      expect(a.session.stopReasons).toEqual(["screen disabled"]);
      expect(b.session.stopReasons).toEqual(["screen link revoked"]);
      expect(c.session.stopReasons).toEqual([]);
      expect(stopping.session.stopReasons).toEqual([]);
      expect(forgotten.session.stopReasons).toEqual([]);
    });

    it("leaves pages without a screen link and pages saying hello alone", () => {
      setup();
      const plain = readyPage();
      const s = screen({ enabled: false });
      const waking = parkedPage(s);
      screens.update(s.id, { enabled: true }, "enabled", actor);
      pages.enableScreen(s.id, "Hall"); // what the portal does right after saving
      const sent = [plain.socket.sent.length, waking.sent.length];
      pages.syncScreens();
      expect([plain.socket.sent.length, waking.sent.length]).toEqual(sent);
      expect(logged("page: screen switched on outside the app")).toBeUndefined();
    });

    it("ignores a broken or unreadable screens.yaml", () => {
      setup();
      const s = screen({ enabled: false });
      const socket = parkedPage(s);
      screens.update(s.id, { enabled: true }, "enabled", actor);
      root.write("screens.yaml", "screens: [ {");
      pages.syncScreens();
      expect(socket.types()).toEqual(["screen"]);
      vi.spyOn(screens, "list").mockImplementation(() => {
        throw new Error("EACCES");
      });
      pages.syncScreens();
      expect(logged("page: screens.yaml could not be read")).toBeDefined();
      expect(socket.types()).toEqual(["screen"]);
    });

    it("logs a change it could not apply", async () => {
      setup();
      const s = screen();
      const { session } = readyPage({ screen: { guid: s.guid } });
      session.stopError = new Error("stop broke");
      screens.remove(s.id);
      pages.syncScreens();
      await flush();
      expect(logged("page: applying a screens.yaml change failed")).toMatchObject({ screen: s.id });

      const other = screen();
      readyPage({ screen: { guid: other.guid } });
      vi.spyOn(pages, "disableScreen").mockRejectedValue(new Error("boom"));
      screens.update(other.id, { enabled: false }, "disabled", actor);
      pages.syncScreens();
      await flush();
      expect(
        lines.filter((l) => l.msg === "page: applying a screens.yaml change failed"),
      ).toHaveLength(2);
    });

    it("checks screens.yaml on a timer until it is closed", () => {
      setup("", { screenSyncMs: undefined });
      const sync = vi.spyOn(pages, "syncScreens");
      vi.advanceTimersByTime(2_000);
      expect(sync).toHaveBeenCalledTimes(1);
      pages.close();
      vi.advanceTimersByTime(10_000);
      expect(sync).toHaveBeenCalledTimes(1);
    });
  });

  describe("hosted mode", () => {
    it("needs a screen link or a login; access keys do not count", () => {
      setup(HOSTED);
      const { key } = keys.add({ label: "Ignored" });
      const socket = connect();
      socket.text(hello({ key }));
      expect(socket.sent[0]).toEqual({
        type: "error",
        code: "unauthorized",
        message: "Open this page with a screen link, or log in to the app first",
      });
    });

    it("runs a login's preview as its organisation and counts minutes per organisation", () => {
      setup(HOSTED);
      const org = orgs.create({ name: "Masjid" });
      viewer = user("imam", org.id);
      const { socket, session } = readyPage();
      expect(manager.pageRequests[0]).toMatchObject({ orgId: org.id, keyLabel: "account: imam" });
      session.onUsage?.("soniox", 60_000);
      expect(usage.minutesToday(`org:${org.id}`)).toBe(1);
      // The organisation is disabled by the operator: the session stops.
      orgs.setDisabled(org.id, true);
      session.onUsage?.("soniox", 1_000);
      expect(socket.last("error")).toEqual({
        type: "error",
        code: "unauthorized",
        message: "This organisation is disabled on this server",
      });
      // A disabled organisation's login no longer opens pages.
      const again = connect();
      again.text(hello());
      expect(again.sent[0]).toMatchObject({ code: "unauthorized" });
    });

    it("refuses the screens of a disabled or deleted organisation", () => {
      setup(HOSTED);
      const org = orgs.create({ name: "Masjid" });
      const s = screen({ orgId: org.id });
      const ok = readyPage({ screen: { guid: s.guid } });
      expect(manager.pageRequests[0]).toMatchObject({ orgId: org.id, keyLabel: "screen: Hall" });
      expect(ok.socket.closeCode).toBeNull();
      orgs.setDisabled(org.id, true);
      const refused = connect();
      refused.text(hello({ screen: { guid: s.guid } }));
      expect(refused.sent[0]).toEqual({
        type: "error",
        code: "unauthorized",
        message: "This organisation is disabled on this server",
      });
      expect(logged("page: organisation disabled")).toMatchObject({ org: org.id, screen: s.id });
    });

    it("does not resume a session that was stopped for its organisation", () => {
      setup(HOSTED);
      manager.removeOnStop = false;
      const org = orgs.create({ name: "Masjid" });
      const s = screen({ orgId: org.id });
      const { session } = readyPage({ screen: { guid: s.guid } });
      orgs.setDisabled(org.id, true);
      session.onUsage?.("soniox", 1_000);
      orgs.setDisabled(org.id, false);
      const again = connect();
      again.text(hello({ screen: { guid: s.guid }, resume: session.id }));
      expect(again.last("ready")).toMatchObject({ resumed: false });
    });

    it("works without an organisation store or an account store", () => {
      setup(HOSTED, { orgs: undefined });
      viewer = user("imam", "anything");
      expect(readyPage().socket.closeCode).toBeNull();
      pages.close();
      setup(HOSTED, { users: undefined });
      const socket = connect();
      socket.text(hello());
      expect(socket.sent[0]).toMatchObject({ code: "unauthorized" });
    });
  });

  it("forgets every session and screen socket on close", async () => {
    setup();
    const s = screen();
    const { socket } = readyPage({ screen: { guid: s.guid } });
    pages.close();
    expect(hub.list(s.id)).toEqual([]);
    socket.close();
    await flush();
    const again = connect();
    again.text(hello({ resume: "page1", screen: { guid: s.guid } }));
    expect(again.last("ready")).toMatchObject({ resumed: false });
  });
});
