// /ws/page: one WebSocket per caption page.
// Handshake: origin → hello (10 s) → signed screen link (or pages.requireScreen) → access key
// (lan|public, unless a screen link authorized the page; per-IP failure limit) → language pair →
// daily quota → resume or create → ready + snapshots (segments, blocks, mode). Then 3,200-byte
// binary frames (token bucket: 1.5× real time + pre-roll burst) and speech start/end events in;
// the session's snapshot/segment/clear/status and blocks.snapshot/block.add/block.update/mode/
// listening/session.ended out. A disabled screen gets {screen disabled} and no session: the socket
// is parked until the screen is enabled ({screen enabled} → the page sends a new hello on the
// same socket). Keys, links and signatures are never logged (screen ids are).
// Every session belongs to an organisation and runs with its API keys: the
// screen's organisation, else the logged-in account's (a preview from the app), else "local". In
// hosted mode access keys do not apply: a page needs a screen link or a login. In local mode a
// login also stands in for an access key (lan|public), so the app's own previews just work.
import type { FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { LOCAL_ORG_ID, type OrgStore } from "../accounts/orgs.js";
import type { ScreenRecord, ScreenStore } from "../accounts/screens.js";
import type { SigningSecret } from "../accounts/secret.js";
import type { UserRecord, UserStore } from "../accounts/users.js";
import type { AccessKeyInfo, KeyStore } from "../auth/keys.js";
import type { FailureRateLimiter } from "../auth/rate-limit.js";
import type { LoadedConfig } from "../config.js";
import { type CaptionSessionApi, SessionError, type SessionManagerApi } from "../core/contracts.js";
import { orgUsageKey, type UsageStore } from "../core/usage.js";
import type { Languages } from "../languages.js";
import {
  PAGE_FRAME_BYTES,
  type PageErrorCode,
  type PageServerMessage,
  type PrayerEvent,
  type ServerMessage,
  type TrackId,
} from "../shared/protocol.js";
import { keepAlive, rawToBuffer, sendJson, Throttle } from "./hub.js";
import type { ScreenConn, ScreenHub, ScreenLive } from "./screen-hub.js";
import { checkOrigin } from "./security.js";

export const MAX_REALTIME_FACTOR = 1.5;
const FRAME_MS = 100;
const HELLO_TIMEOUT_MS = 10_000;
const STATUS_INTERVAL_MS = 500;
const MAX_TEXT_BYTES = 8192;
const DROP_LOG_INTERVAL_MS = 10_000;
const KEY_RECHECK_MS = 30_000;
/** A parked page that was told its screen is on must say hello again within this time. */
const REHELLO_TIMEOUT_MS = 30_000;
/** How often the pages are checked against screens.yaml (CLI changes, hand edits). */
const SCREEN_SYNC_MS = 2000;
const LINK_INVALID = "This link is no longer valid";

const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(1),
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
  // A page loaded before an update may still send its engine choice (removed): ignored.
  engine: z.string().max(32).optional(),
  translation: z.string().max(32).optional(),
  key: z.string().max(512).optional(),
  resume: z.string().max(200).nullish(),
  client: z.object({
    obs: z.boolean(),
    ua: z.string().transform((s) => s.slice(0, 300)),
  }),
  format: z.object({
    codec: z.literal("pcm_s16le"),
    sampleRate: z.literal(16000),
    channels: z.literal(1),
    frameMs: z.literal(100),
  }),
  layout: z.enum(["blocks", "rollup"]).optional(),
  screen: z.object({ guid: z.string().min(1).max(64) }).optional(),
});
type Hello = z.output<typeof HelloSchema>;

const SpeechSchema = z.object({ type: z.literal("speech"), state: z.enum(["start", "end"]) });

/** Token bucket in frames: `rate` frames per ms, `capacity` frames of burst. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerMs: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.ratePerMs);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface PageSocketsDeps {
  loaded: LoadedConfig;
  manager: SessionManagerApi;
  keys: KeyStore;
  usage: UsageStore;
  languages: Languages;
  /** Per-IP access-key failure limiter. */
  limiter: FailureRateLimiter;
  /** screens.yaml, the signing secret, the sockets per screen, requireScreen (live). */
  screens: ScreenStore;
  secret: SigningSecret;
  hub: ScreenHub;
  requireScreen: () => boolean;
  log: Logger;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Launch: the logged-in account of the upgrade request (its cookie), or null. */
  userOf?: (req: FastifyRequest) => UserRecord | null;
  /** Launch: the accounts, to re-check a login when a page says hello and while it streams. */
  users?: UserStore;
  /** Launch: organisations (hosted mode refuses disabled ones). */
  orgs?: OrgStore;
  /** How often to check the pages against screens.yaml (0 = only on syncScreens()). */
  screenSyncMs?: number;
}

/** Server-side bookkeeping per page session (survives the socket for resume). */
interface PageRecord {
  sessionId: string;
  keyId: string | null;
  dailyMinutes: number | null;
  from: string;
  to: string;
  /** The socket currently feeding the session, and how to end it with an error. */
  owner: WebSocket | null;
  fail: ((code: PageErrorCode, message: string) => void) | null;
  /** Close the owner without an error (a newer connection resumed the session). */
  kick: (() => void) | null;
  quotaHit: boolean;
  keyCheckedAt: number;
  /** The screen whose signed link started the session, and its link version. */
  screenId: string | null;
  screenVersion: number | null;
  /** Launch: the organisation whose keys the session uses. */
  orgId: string;
  /** The login that authorized the session (no screen link, no access key), re-checked often. */
  viewer: ViewerRef | null;
}

/** A login as it was when the socket opened: revoked when disabled, deleted or logged out. */
interface ViewerRef {
  id: string;
  sessionVersion: number;
}

/** Close code for a socket whose session was resumed by a newer connection (do not reconnect). */
export const CLOSE_REPLACED = 4001;
/** Close code when the session ended server-side (stopped from /control, grace expired, …). */
export const CLOSE_SESSION_ENDED = 4000;

/**
 * hello: waiting for a hello; waiting: parked (screen disabled, no session); ready: feeding a
 * session; parking: its screen is being disabled (the session is stopping; the socket stays).
 */
type SocketState = "hello" | "waiting" | "ready" | "parking" | "closed";

/** A screen link as a page opened it: the screen, and its link version and languages then. */
interface ScreenLink {
  screenId: string;
  version: number;
  from: string;
  to: string;
}

/** A socket as syncScreens() sees it. */
interface PageConn extends ScreenConn {
  /** The screen link of its last hello, or null (none, or not said yet). */
  readonly link: ScreenLink | null;
  /** Parked: its screen was off. */
  readonly parked: boolean;
  /** Feeding a session (neither while it says hello, parks or closes). */
  readonly live: boolean;
}

type OpenResult =
  | { kind: "failed" }
  | { kind: "waiting"; screen: ScreenRecord }
  | {
      kind: "ready";
      session: CaptionSessionApi;
      record: PageRecord;
      resumed: boolean;
      keyInfo: AccessKeyInfo | null;
      screen: ScreenRecord | null;
    };

export class PageSockets {
  private readonly records = new Map<string, PageRecord>();
  /** Every open socket (syncScreens checks the ones with a screen link). */
  private readonly conns = new Set<PageConn>();
  private readonly syncTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PageSocketsDeps) {
    const interval = deps.screenSyncMs ?? SCREEN_SYNC_MS;
    if (interval > 0) {
      this.syncTimer = setInterval(() => this.syncScreens(), interval);
      this.syncTimer.unref();
    }
  }

  /** GET /ws/page handler; listeners are attached synchronously. */
  handle(socket: WebSocket, req: FastifyRequest): void {
    const { loaded, log, hub } = this.deps;
    const config = loaded.config;
    const ip = req.ip;
    // The login cookie of the upgrade request: previews from the app run as its organisation.
    // Only who it was is kept; open() looks the account up again at every hello.
    let viewer: ViewerRef | null = null;
    try {
      const user = this.deps.userOf?.(req) ?? null;
      if (user !== null) viewer = { id: user.id, sessionVersion: user.sessionVersion };
    } catch (err) {
      log.error({ err }, "page: login check failed");
    }
    let state: SocketState = "hello";
    /** Waiting for the new hello of a parked page whose screen was enabled. */
    let rehello = false;
    let session: CaptionSessionApi | null = null;
    let record: PageRecord | null = null;
    let unsubscribe: (() => void) | null = null;
    /** The screen this socket is registered under in the hub (null: no screen link). */
    let screenId: string | null = null;
    let link: ScreenLink | null = null;
    let dropped = 0;
    let lastDropLog = 0;
    // 1.5 frames per 100 ms; burst = the pre-roll flush + 2 frames.
    const bucket = new TokenBucket(
      MAX_REALTIME_FACTOR / FRAME_MS,
      Math.floor(config.pages.vad.prerollMs / FRAME_MS) + 2,
    );

    const send = (msg: PageServerMessage): void => {
      sendJson(socket, msg);
    };
    const status = new Throttle<PageServerMessage>(STATUS_INTERVAL_MS, send);
    const fail = (code: PageErrorCode, message: string): void => {
      if (state === "closed") return;
      state = "closed";
      send({ type: "error", code, message });
      socket.close(1008, code);
    };
    const kick = (): void => {
      if (state === "closed") return;
      state = "closed";
      socket.close(CLOSE_REPLACED, "resumed elsewhere");
    };
    const forward = (msg: ServerMessage): void => {
      switch (msg.type) {
        case "status":
          status.push(msg);
          return;
        case "snapshot":
          status.cancel();
          send(msg);
          return;
        case "segment":
        case "clear":
        case "blocks.snapshot":
        case "block.add":
        case "block.update":
        case "mode":
        case "listening":
          send(msg);
          return;
        case "session.ended":
          // The page keeps its history and shows the end divider; nothing more will come.
          // (A screen being disabled keeps its socket: "parking".)
          status.cancel();
          send(msg);
          if (state === "ready") {
            state = "closed";
            socket.close(CLOSE_SESSION_ENDED, "session ended");
          }
          return;
        case "hello":
        case "level":
          return; // not part of the page protocol
      }
    };

    let helloTimer: NodeJS.Timeout | null = null;
    const clearHelloTimer = (): void => {
      if (helloTimer !== null) clearTimeout(helloTimer);
      helloTimer = null;
    };
    const armHelloTimer = (ms: number): void => {
      clearHelloTimer();
      helloTimer = setTimeout(() => {
        helloTimer = null;
        if (state === "hello") {
          state = "closed";
          socket.close(1008, "hello timeout");
        }
      }, ms);
      helloTimer.unref();
    };
    armHelloTimer(this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    /** Stop feeding the current session (stopping it is the caller's business). */
    const leaveSession = (): void => {
      status.cancel();
      unsubscribe?.();
      unsubscribe = null;
      if (record !== null && session !== null) this.release(record, socket, session);
      record = null;
      session = null;
    };

    // The portal reaches this socket through the hub while it uses a screen link.
    const conn: PageConn = {
      connectedAt: Date.now(),
      get session(): CaptionSessionApi | null {
        return session;
      },
      get link(): ScreenLink | null {
        return link;
      },
      get parked(): boolean {
        return state === "waiting";
      },
      get live(): boolean {
        return state === "ready";
      },
      notifyEnabled: (name) => {
        if (state !== "waiting") return false;
        state = "hello";
        rehello = true;
        send({ type: "screen", state: "enabled", name });
        armHelloTimer(REHELLO_TIMEOUT_MS);
        return true;
      },
      beginPark: () => {
        if (state === "ready") state = "parking";
      },
      park: (name) => {
        if (state !== "parking") return;
        leaveSession();
        state = "waiting";
        send({ type: "screen", state: "disabled", name });
      },
      invalidate: () => {
        fail("screen_invalid", LINK_INVALID);
      },
      reload: () => {
        if (socket.readyState !== socket.OPEN) return false;
        const name = screenId === null ? undefined : this.deps.screens.get(screenId)?.name;
        send({ type: "screen", state: "reload", name: name ?? "" });
        return true;
      },
    };
    const register = (screen: ScreenRecord | null): void => {
      link =
        screen === null
          ? null
          : { screenId: screen.id, version: screen.version, from: screen.from, to: screen.to };
      const id = screen?.id ?? null;
      if (screenId === id) return;
      if (screenId !== null) hub.remove(screenId, conn);
      screenId = id;
      if (id !== null) hub.add(id, conn);
    };
    this.conns.add(conn);

    const onFrame = (data: RawData): void => {
      if (state !== "ready" || session === null) return;
      const buf = rawToBuffer(data);
      let reason: string | null = null;
      if (buf.length !== PAGE_FRAME_BYTES) reason = "size";
      else if (!bucket.take()) reason = "rate";
      if (reason !== null) {
        dropped++;
        const now = Date.now();
        if (now - lastDropLog >= DROP_LOG_INTERVAL_MS) {
          lastDropLog = now;
          log.warn(
            { sessionId: session.id, dropped, reason, bytes: buf.length },
            "page: frames dropped",
          );
        }
        return;
      }
      session.pushFrame(new Uint8Array(buf));
    };

    const onText = (data: RawData): void => {
      const buf = rawToBuffer(data);
      if (buf.length > MAX_TEXT_BYTES) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.toString("utf8"));
      } catch {
        return;
      }
      if (state === "waiting") {
        // A parked page may say hello again on its own: check the screen again.
        const again = HelloSchema.safeParse(parsed);
        if (again.success) onHelloParsed(again.data);
        return;
      }
      if (state !== "ready" || session === null) return;
      const speech = SpeechSchema.safeParse(parsed);
      if (speech.success) session.speech(speech.data.state);
    };

    const onHello = (data: RawData): void => {
      let hello: Hello;
      try {
        hello = HelloSchema.parse(JSON.parse(rawToBuffer(data).toString("utf8")));
      } catch {
        // After {screen enabled}, a stray message is ignored until the new hello (or timeout).
        if (rehello) return;
        clearHelloTimer();
        state = "closed";
        socket.close(1002, "invalid hello");
        return;
      }
      clearHelloTimer();
      onHelloParsed(hello);
    };

    const onHelloParsed = (hello: Hello): void => {
      rehello = false;
      const result = this.open(hello, ip, socket, fail, kick, viewer);
      if (result.kind === "failed") return; // fail() has closed the socket
      if (state === "closed" || socket.readyState !== socket.OPEN) {
        // The socket closed while its session was being made: let the session go again.
        if (result.kind === "ready") this.release(result.record, socket, result.session);
        return;
      }
      register(result.screen);
      if (result.kind === "waiting") {
        // No session, nothing billed: the page releases its microphone and shows the message.
        state = "waiting";
        send({ type: "screen", state: "disabled", name: result.screen.name });
        log.info(
          { screen: result.screen.id, obs: hello.client.obs, ip },
          "page: screen is off; waiting",
        );
        return;
      }
      ({ session, record } = result);
      const keyInfo = result.keyInfo;
      const daily = record.dailyMinutes;
      send({
        type: "ready",
        sessionId: session.id,
        resumed: result.resumed,
        vad: { ...config.pages.vad },
        limits: {
          maxFrameBytes: PAGE_FRAME_BYTES,
          maxRealtimeFactor: MAX_REALTIME_FACTOR,
          dailyMinutesLeft:
            daily === null ? null : Math.max(0, daily - this.deps.usage.minutesToday(record.keyId)),
        },
      });
      for (const m of session.snapshots()) forward(m);
      unsubscribe = session.subscribe(forward);
      state = "ready";
      log.info(
        {
          sessionId: session.id,
          resumed: result.resumed,
          from: hello.from,
          to: hello.to,
          keyId: keyInfo?.id ?? null,
          keyLabel: keyInfo?.label ?? null,
          screen: result.screen?.id ?? null,
          obs: hello.client.obs,
          ip,
        },
        "page: ready",
      );
    };

    socket.on("message", (data, isBinary) => {
      try {
        if (state === "closed") return;
        if (state === "hello") {
          if (isBinary) {
            if (rehello) return; // audio still in flight from before the screen was switched off
            clearHelloTimer();
            state = "closed";
            socket.close(1002, "expected hello");
            return;
          }
          onHello(data);
          return;
        }
        if (isBinary) onFrame(data);
        else onText(data);
      } catch (err) {
        log.error({ err }, "page: message handling failed");
        state = "closed";
        socket.close(1011, "internal error");
      }
    });

    socket.on("close", () => {
      clearHelloTimer();
      status.cancel();
      unsubscribe?.();
      unsubscribe = null;
      state = "closed";
      if (record !== null && session !== null) this.release(record, socket, session);
      register(null);
      this.conns.delete(conn);
      this.sweep();
    });

    keepAlive(socket, {
      ...(this.deps.pingIntervalMs === undefined ? {} : { intervalMs: this.deps.pingIntervalMs }),
      onTick: () => {
        if (state !== "ready" || session === null) return;
        if (this.deps.manager.get(session.id) === undefined) {
          state = "closed";
          socket.close(CLOSE_SESSION_ENDED, "session ended");
        }
      },
    });

    // Origin first: reject other websites before reading anything.
    const origin = checkOrigin(req, config.pages.allowedOrigins);
    if (!origin.ok) {
      log.warn({ ip, origin: req.headers.origin }, "page: origin rejected");
      fail("unauthorized", origin.reason);
      return;
    }
    if (!config.pages.enabled) {
      fail(
        "engine_unavailable",
        "Caption pages are disabled on this server (pages.enabled: false)",
      );
    }
  }

  /** Close the record's session hand-off for a socket that went away. */
  private release(record: PageRecord, socket: WebSocket, session: CaptionSessionApi): void {
    if (record.owner !== socket) return;
    record.owner = null;
    record.fail = null;
    record.kick = null;
    try {
      session.detach();
    } catch (err) {
      this.deps.log.error({ err, sessionId: session.id }, "page: detach failed");
    }
  }

  /** Forget records whose session is gone. */
  private sweep(): void {
    for (const [id, rec] of this.records) {
      if (rec.owner === null && this.deps.manager.get(id) === undefined) this.records.delete(id);
    }
  }

  /** Steps after the hello schema: screen link, key, pair, quota, resume/create. */
  private open(
    hello: Hello,
    ip: string,
    socket: WebSocket,
    fail: (code: PageErrorCode, message: string) => void,
    kick: () => void,
    viewerRef: ViewerRef | null,
  ): OpenResult {
    const { loaded, keys, limiter, usage, languages, manager, log } = this.deps;
    const config = loaded.config;
    const hosted = config.mode === "hosted";
    const failed: OpenResult = { kind: "failed" };
    // Still the same account: not disabled, deleted or logged out since the socket opened.
    const viewer = this.currentViewer(viewerRef);

    // 0. Screen feed: a known GUID → authorized in every exposure (no key
    // needed); the feed's languages must be the screen's; a disabled screen parks the socket.
    // The GUID is the link's key: it is never logged (the screen id is).
    let screen: ScreenRecord | null = null;
    if (hello.screen !== undefined) {
      let verified: ScreenRecord | null;
      try {
        verified = this.deps.screens.byGuid(hello.screen.guid);
      } catch (err) {
        log.error({ err }, "page: screen link check failed");
        fail("engine_unavailable", "The server could not check this screen link");
        return failed;
      }
      if (verified === null) {
        log.warn({ ip }, "page: screen link rejected (unknown or replaced GUID)");
        fail("screen_invalid", LINK_INVALID);
        return failed;
      }
      if (verified.from !== hello.from || verified.to !== hello.to) {
        log.warn(
          { ip, screen: verified.id, from: hello.from, to: hello.to },
          "page: screen link used with other languages",
        );
        fail("screen_invalid", LINK_INVALID);
        return failed;
      }
      if (!verified.enabled) return { kind: "waiting", screen: verified };
      screen = verified;
    } else if (this.deps.requireScreen()) {
      log.warn({ ip }, "page: refused, no screen link (pages.requireScreen)");
      fail(
        "screen_required",
        "This server only shows captions for signed screen links (made in the admin portal)",
      );
      return failed;
    }

    // Launch: the organisation. Hosted pages need a screen link or a login (no access keys).
    let orgId = screen?.orgId ?? LOCAL_ORG_ID;
    if (hosted && screen === null) {
      if (viewer === null) {
        log.warn({ ip }, "page: refused, no screen link and no login (hosted)");
        fail("unauthorized", "Open this page with a screen link, or log in to the app first");
        return failed;
      }
      orgId = viewer.orgId;
    }
    if (hosted && !this.orgActive(orgId)) {
      log.warn({ ip, org: orgId, screen: screen?.id ?? null }, "page: organisation disabled");
      fail("unauthorized", "This organisation is disabled on this server");
      return failed;
    }

    // 1. Access key: required for lan|public without a screen link or a login; optional
    // attribution else.
    let keyInfo: AccessKeyInfo | null = null;
    if (hosted) {
      // Hosted: the screen link or the login authorized the page; keys are not used.
    } else if (screen === null && config.server.exposure !== "local" && viewer === null) {
      const blockedMs = limiter.blockedFor(ip);
      if (blockedMs > 0) {
        fail(
          "unauthorized",
          `Too many failed key attempts from this address; try again in ${Math.ceil(blockedMs / 60_000)} min`,
        );
        return failed;
      }
      const presented = hello.key ?? "";
      keyInfo = presented === "" ? null : keys.verify(presented);
      if (keyInfo === null) {
        limiter.recordFailure(ip);
        log.warn({ ip, keyPresented: presented !== "" }, "page: access key rejected");
        fail(
          "unauthorized",
          presented === ""
            ? "This server needs an access key: add ?key=… to the page URL"
            : "Invalid or expired access key",
        );
        return failed;
      }
      limiter.recordSuccess(ip);
    } else if (screen === null && hello.key !== undefined && hello.key !== "") {
      keyInfo = keys.verify(hello.key);
    }
    // 2. Language pair.
    const pairError = languages.validatePair(hello.from, hello.to);
    if (pairError !== null) {
      fail("bad_language", pairError);
      return failed;
    }

    // 3. Daily quota (checked before creating anything).
    const keyId = keyInfo?.id ?? null;
    const daily = keyInfo?.dailyMinutes ?? null;
    if (daily !== null && usage.minutesToday(keyId) >= daily) {
      fail("quota_exceeded", `The daily limit of ${daily} min for this key is used up`);
      return failed;
    }

    // 4. Resume within the grace period: same key (or screen link), same pair; the newest
    // socket wins.
    const screenId = screen?.id ?? null;
    const screenVersion = screen?.version ?? null;
    if (typeof hello.resume === "string" && hello.resume !== "") {
      const rec = this.records.get(hello.resume);
      const existing = manager.get(hello.resume);
      if (
        rec !== undefined &&
        existing !== undefined &&
        existing.kind === "page" &&
        rec.keyId === keyId &&
        rec.screenId === screenId &&
        rec.screenVersion === screenVersion &&
        rec.orgId === orgId &&
        rec.from === hello.from &&
        rec.to === hello.to &&
        !rec.quotaHit
      ) {
        // A half-open old socket the server has not noticed yet: the newest connection wins.
        const previous = rec.kick;
        rec.owner = socket;
        rec.fail = fail;
        rec.kick = kick;
        previous?.();
        existing.attach();
        return { kind: "ready", session: existing, record: rec, resumed: true, keyInfo, screen };
      }
    }

    // 5. New session. A login that stood in for a screen link or an access key is re-checked.
    const byLogin =
      viewer !== null &&
      screen === null &&
      keyInfo === null &&
      (hosted || config.server.exposure !== "local");
    const record: PageRecord = {
      sessionId: "",
      keyId,
      dailyMinutes: daily,
      from: hello.from,
      to: hello.to,
      owner: socket,
      fail,
      kick,
      quotaHit: false,
      keyCheckedAt: Date.now(),
      screenId,
      screenVersion,
      orgId,
      viewer:
        byLogin && viewer !== null
          ? { id: viewer.id, sessionVersion: viewer.sessionVersion }
          : null,
    };
    let session: CaptionSessionApi;
    try {
      session = manager.createPage({
        from: hello.from,
        to: hello.to,
        keyId,
        keyLabel:
          screen !== null
            ? `screen: ${screen.name}`
            : (keyInfo?.label ?? (viewer === null ? null : `account: ${viewer.username}`)),
        client: { obs: hello.client.obs, ua: hello.client.ua },
        ...(hello.layout === undefined ? {} : { layout: hello.layout }),
        onUsage: (engine, ms) => this.onUsage(record, engine, ms),
        orgId,
      });
    } catch (err) {
      if (err instanceof SessionError) {
        fail(err.code, err.message);
      } else {
        log.error({ err }, "page: createPage failed");
        fail("engine_unavailable", "The server could not start a caption session");
      }
      return failed;
    }
    record.sessionId = session.id;
    this.records.set(session.id, record);
    return { kind: "ready", session, record, resumed: false, keyInfo, screen };
  }

  /** Usage accounting + mid-session enforcement (daily limit, revoked keys and screen links). */
  private onUsage(record: PageRecord, engine: TrackId, ms: number): void {
    const { usage, keys, manager, log } = this.deps;
    const hosted = this.deps.loaded.config.mode === "hosted";
    // Hosted mode counts minutes per organisation; local mode per access key.
    usage.add(hosted ? orgUsageKey(record.orgId) : record.keyId, engine, ms);
    if (record.quotaHit) return;
    let reason: { code: PageErrorCode; message: string } | null = null;
    if (hosted && !this.orgActive(record.orgId)) {
      reason = { code: "unauthorized", message: "This organisation is disabled on this server" };
    } else if (record.screenId !== null) {
      reason = this.screenRecheck(record);
    } else if (record.viewer !== null) {
      reason = this.viewerRecheck(record);
    } else if (record.keyId === null) {
      return;
    } else if (
      record.dailyMinutes !== null &&
      usage.minutesToday(record.keyId) >= record.dailyMinutes
    ) {
      reason = {
        code: "quota_exceeded",
        message: `The daily limit of ${record.dailyMinutes} min for this key is used up`,
      };
    } else if (Date.now() - record.keyCheckedAt >= KEY_RECHECK_MS) {
      record.keyCheckedAt = Date.now();
      if (
        keys.get(record.keyId) === undefined &&
        this.deps.loaded.config.server.exposure !== "local"
      ) {
        reason = { code: "unauthorized", message: "The access key was revoked" };
      }
    }
    if (reason === null) return;
    record.quotaHit = true;
    log.info(
      {
        sessionId: record.sessionId,
        keyId: record.keyId,
        screen: record.screenId,
        code: reason.code,
      },
      "page: stopping session",
    );
    record.fail?.(reason.code, reason.message);
    const session = manager.get(record.sessionId);
    if (session !== undefined) {
      session.stop(reason.code).catch((err: unknown) => {
        log.error({ err, sessionId: record.sessionId }, "page: stop failed");
      });
    }
  }

  /** The account of a login, if it is still valid (exists, enabled, not logged out); else null. */
  private currentViewer(ref: ViewerRef | null): UserRecord | null {
    if (ref === null || this.deps.users === undefined) return null;
    const user = this.deps.users.get(ref.id);
    if (user === undefined || user.disabled || user.sessionVersion !== ref.sessionVersion) {
      return null;
    }
    if (this.deps.loaded.config.mode === "hosted" && !this.orgActive(user.orgId)) return null;
    return user;
  }

  /** At every usage report (10 s): the login that started a session must still be valid. */
  private viewerRecheck(record: PageRecord): { code: PageErrorCode; message: string } | null {
    if (record.viewer === null || this.currentViewer(record.viewer) !== null) return null;
    return { code: "unauthorized", message: "This login is no longer valid: log in again" };
  }

  /** Hosted mode: the organisation exists and is not disabled (re-read when orgs.yaml changes). */
  private orgActive(orgId: string): boolean {
    const orgs = this.deps.orgs;
    if (orgs === undefined) return true;
    const org = orgs.get(orgId);
    return org !== undefined && !org.disabled;
  }

  /** Every 30 s: the screen link of a session must still exist with the same version. */
  private screenRecheck(record: PageRecord): { code: PageErrorCode; message: string } | null {
    if (record.screenId === null || Date.now() - record.keyCheckedAt < KEY_RECHECK_MS) return null;
    record.keyCheckedAt = Date.now();
    const screen = this.deps.screens.get(record.screenId);
    if (
      screen !== undefined &&
      screen.version === record.screenVersion &&
      screen.from === record.from &&
      screen.to === record.to
    ) {
      return null;
    }
    return { code: "screen_invalid", message: LINK_INVALID };
  }

  // --- screens: the admin portal's switch, reset and link changes ------------------------------

  /**
   * Bring every page of a screen link in line with screens.yaml as it is now: a page parked on a
   * screen that is on is woken, a page captioning a screen that is off is stopped and parked, and
   * the pages and sessions of a link that was deleted or replaced end. This applies changes made
   * outside the app (`turjuman screens enable|disable|rm`, a hand edit); the portal applies its
   * own at once, so here they find nothing left to do. The pages are checked, not the difference
   * with the previous read: a screen made and switched on, or switched on and off again, between
   * two checks still reaches its pages. A broken file changes nothing.
   */
  syncScreens(): void {
    const { screens, manager, log } = this.deps;
    let list: ScreenRecord[];
    try {
      list = screens.list();
      if (screens.error !== null) return;
    } catch (err) {
      log.error({ err }, "page: screens.yaml could not be read");
      return;
    }
    const byId = new Map(list.map((s) => [s.id, s]));
    /** The screen of a link that still works (same version and languages), else undefined. */
    const valid = (l: Omit<ScreenLink, "version"> & { version: number | null }) => {
      const s = byId.get(l.screenId);
      return s?.version === l.version && s.from === l.from && s.to === l.to ? s : undefined;
    };
    const failed = (screen: string) => (err: unknown) => {
      log.error({ err, screen }, "page: applying a screens.yaml change failed");
    };
    const wake = new Map<string, string>();
    const park = new Map<string, string>();
    const revoked: Array<{
      screenId: string;
      conn: PageConn | null;
      session: CaptionSessionApi | null;
    }> = [];
    for (const conn of this.conns) {
      const l = conn.link;
      if (l === null || !(conn.parked || conn.live)) continue;
      const s = valid(l);
      if (s === undefined) revoked.push({ screenId: l.screenId, conn, session: conn.session });
      else if (s.enabled && conn.parked) wake.set(s.id, s.name);
      else if (!s.enabled && conn.live) park.set(s.id, s.name);
    }
    // Sessions of a screen link whose page is away (resume grace).
    for (const rec of this.records.values()) {
      if (rec.screenId === null || rec.owner !== null) continue;
      const session = manager.get(rec.sessionId);
      if (session === undefined || session.status().state === "stopping") continue;
      const s = valid({ ...rec, screenId: rec.screenId, version: rec.screenVersion });
      if (s === undefined) revoked.push({ screenId: rec.screenId, conn: null, session });
      else if (!s.enabled) park.set(s.id, s.name);
    }
    for (const { screenId, conn, session } of revoked) {
      log.info(
        { screen: screenId },
        byId.has(screenId)
          ? "page: screen link changed outside the app"
          : "page: screen deleted outside the app",
      );
      // Stopping first: the socket's close then finds its session stopping (no resume grace).
      void session?.stop("screen link revoked").catch(failed(screenId));
      conn?.invalidate();
    }
    if (revoked.length > 0) this.sweep();
    for (const [id, name] of wake) {
      log.info({ screen: id }, "page: screen switched on outside the app");
      this.enableScreen(id, name);
    }
    for (const [id, name] of park) {
      log.info({ screen: id }, "page: screen switched off outside the app");
      void this.disableScreen(id, name).catch(failed(id));
    }
  }

  /** Page sessions started by a screen's link (live or in their resume grace). */
  private screenSessions(screenId: string, includeStopping: boolean): CaptionSessionApi[] {
    const out: CaptionSessionApi[] = [];
    for (const rec of this.records.values()) {
      if (rec.screenId !== screenId) continue;
      const session = this.deps.manager.get(rec.sessionId);
      if (session === undefined) continue;
      if (!includeStopping && session.status().state === "stopping") continue;
      out.push(session);
    }
    return out;
  }

  /** ScreenView.live: pages connected with the link, sessions running, speaking, since, and
   *  the prayer event on screen. */
  screenLive(screenId: string): ScreenLive {
    const sessions = this.screenSessions(screenId, false);
    let speaking = false;
    let since: number | null = null;
    let event: PrayerEvent | null = null;
    for (const s of sessions) {
      const status = s.status();
      if (status.page?.speaking === true) speaking = true;
      const mode = status.eventMode;
      if (mode === "athan" || mode === "iqama" || mode === "salah") event ??= mode;
      const started = s.info().startedAt;
      since = since === null ? started : Math.min(since, started);
    }
    return {
      pages: this.deps.hub.list(screenId).length,
      sessions: sessions.length,
      speaking,
      since,
      event,
    };
  }

  /** A prayer event (or "none") on every running session of the screen. */
  eventScreen(screenId: string, event: PrayerEvent | "none"): number {
    const sessions = this.screenSessions(screenId, false);
    for (const s of sessions) s.overrideEvent(event);
    return sessions.length;
  }

  /** The look changed: every page of the screen reloads its /feed/<guid> link. */
  reloadScreen(screenId: string): number {
    let told = 0;
    for (const conn of this.deps.hub.list(screenId)) {
      if (conn.reload()) told++;
    }
    return told;
  }

  /** Enable: every parked page of the screen gets {screen enabled} (it sends a new hello). */
  enableScreen(screenId: string, name: string): number {
    let notified = 0;
    for (const conn of this.deps.hub.list(screenId)) {
      if (conn.notifyEnabled(name)) notified++;
    }
    return notified;
  }

  /**
   * Disable: stop every session of the screen (transcripts written, session.ended sent), then
   * send {screen disabled} and park the sockets. Resolves when they are parked.
   */
  async disableScreen(screenId: string, name: string): Promise<number> {
    const conns = this.deps.hub.list(screenId);
    for (const conn of conns) conn.beginPark();
    const sessions = this.screenSessions(screenId, true);
    await Promise.allSettled(sessions.map((s) => s.stop("screen disabled")));
    for (const conn of conns) conn.park(name);
    this.sweep();
    // Switched on again while the sessions were stopping: wake the pages just parked.
    const current = this.deps.screens.get(screenId);
    if (current?.enabled === true) this.enableScreen(screenId, current.name);
    return sessions.length;
  }

  /** Reset: every running session of the screen clears its captions (segments and blocks). */
  resetScreen(screenId: string): number {
    const sessions = this.screenSessions(screenId, false);
    for (const s of sessions) s.clear("all");
    return sessions.length;
  }

  /** Regenerated or deleted: error screen_invalid + close for every page; sessions stop. */
  async invalidateScreen(screenId: string): Promise<number> {
    const sessions = this.screenSessions(screenId, true);
    // Stopping first: the sockets' close then finds the sessions stopping (no resume grace).
    const stopping = sessions.map((s) => s.stop("screen link revoked"));
    for (const conn of this.deps.hub.list(screenId)) conn.invalidate();
    await Promise.allSettled(stopping);
    this.sweep();
    return sessions.length;
  }

  /** Launch: stop every page session of an organisation (it was deleted); the count. */
  async stopOrg(orgId: string): Promise<number> {
    const sessions: CaptionSessionApi[] = [];
    for (const rec of this.records.values()) {
      if (rec.orgId !== orgId) continue;
      const session = this.deps.manager.get(rec.sessionId);
      if (session !== undefined) sessions.push(session);
      rec.fail?.("unauthorized", "This organisation was deleted");
    }
    await Promise.allSettled(sessions.map((s) => s.stop("organisation deleted")));
    this.sweep();
    return sessions.length;
  }

  /** Stop accepting resumes (server shutdown); the sockets are closed by the plugin. */
  close(): void {
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    this.records.clear();
    this.deps.hub.clear();
  }
}
