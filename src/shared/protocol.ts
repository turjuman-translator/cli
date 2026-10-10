// Wire protocol shared by the server and the browser pages (overlay, control, caption page).
// Browser-safe: no Node imports.

/** The speech engine of a track: Soniox (speech recognition and its own translation). */
export type TrackId = "soniox";
export const TRACK_IDS: readonly TrackId[] = ["soniox"];
export type SessionKind = "device" | "file" | "page";

/** Text assembled from tokens: `text.slice(0, finalLen)` is final, the rest is non-final. */
export interface TextState {
  text: string;
  finalLen: number;
  final: boolean;
}

export interface Segment {
  id: string; // `${sessionId}:${track}:${seq}`
  sessionId: string;
  track: TrackId;
  seq: number;
  kind: "speech"; // future: "ayah" | "formula"
  meta?: Record<string, unknown>;
  /** Wall-clock ms since session start (frame capture times; see FrameTimeline). */
  startMs: number | null;
  endMs: number | null;
  /** `lang` is the session's source language, or the detected one when from=auto. */
  source: { lang: string } & TextState;
  translations: Record<string, TextState>; // e.g. { nl: {...} }
  closed: boolean; // endpoint reached
  timing: {
    source: "provider" | "arrival";
    firstTokenAt: number;
    sourceFinalAt?: number;
    translationFinalAt?: Record<string, number>;
  };
}

export type SessionState = "idle" | "starting" | "live" | "reconnecting" | "stopping" | "error";
export type ProviderState = "idle" | "connecting" | "live" | "reconnecting" | "error";
export type AudioState =
  | "none"
  | "idle"
  | "waiting-for-bridge"
  | "ok"
  | "stalled"
  | "restarting"
  | "ended"
  | "error";

export interface LatencyStats {
  p50Ms: number | null;
  p95Ms: number | null;
  n: number;
}

export interface TrackStatus {
  track: TrackId;
  active: boolean;
  provider: ProviderState;
  /** Source and translation latency (null for arrival-timed tracks). */
  latency: { source: LatencyStats; translation: LatencyStats };
  /** Latency from the local VAD's speech end (null until computed). */
  vadLatency: { final: LatencyStats; translation: LatencyStats } | null;
  costUsd: number;
  segments: number;
  lastError?: string;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  startedAt: number;
  from: string; // language code or "auto"
  to: string;
  source: "device" | "file" | "page";
  inputKind: "device" | "network" | "file" | "page";
  file?: string;
  keyLabel?: string;
}

export interface Status {
  state: SessionState;
  primary: TrackId;
  /** = primary track's provider state (the original single-track field). */
  provider: ProviderState;
  audio: {
    state: AudioState;
    rmsDbfs: number | null;
    lastFrameAgoMs: number | null;
    noSignal: boolean;
    lastStderr?: string;
  };
  /** = primary track's Dutch/target latency (the original single-track field). */
  latency: LatencyStats;
  tracks: TrackStatus[];
  session?: SessionInfo;
  error?: string;
  recording?: { path: string; startedAt: number };
  /** Page sessions only. */
  page?: { speaking: boolean; engineOpen: boolean; streamedMinutes: number };
  /** Caption layout of the session and its prayer-event mode. */
  layout?: CaptionLayout;
  eventMode?: SessionMode;
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  from: string;
  to: string;
  engines: TrackId[];
  keyLabel?: string;
  startedAt: number;
  durationMs: number;
  streamedMinutes: number;
  latency: LatencyStats;
  state: SessionState;
  /** Caption layout and prayer-event mode (control-page badges). */
  layout?: CaptionLayout;
  eventMode?: SessionMode;
}

export interface Health {
  ok: true;
  version: string;
  uptimeMs: number;
  exposure: "local" | "lan" | "public";
  /** The local (device/file) session's status, if one exists. */
  local: Status | null;
  sessions: SessionSummary[];
}

// --- caption blocks ----------------------------------------------------------------------------

export type BlockKind = "speech" | "quran" | "dua" | "event";
export type PrayerEvent = "athan" | "iqama" | "salah";
/** "held": formula-only segments are held back while an Athan/Iqama may be starting. */
export type SessionMode = "speech" | "held" | "athan" | "iqama" | "salah";
export type CaptionLayout = "blocks" | "rollup";

export interface Block {
  id: string; // `${sessionId}:b${seq}`
  seq: number;
  kind: BlockKind;
  /** Translated text ("" for events). Never changes once emitted (except `hidden`/event end). */
  text: string;
  /** Verified Quran reference ("2:286", "2:285-286"), or null. */
  ref: string | null;
  /** Arabic source excerpt this block translates. */
  src: string | null;
  /** Uthmani text of the referenced ayah(s), for `quranArabic=1`. */
  quranText?: string | null;
  event?: {
    type: PrayerEvent;
    active: boolean;
    startedAt: number;
    endedAt?: number;
    /** Card labels in the target language (config events.labels). */
    label?: { ar: string; title: string; subtitle: string };
  };
  /** Target language of `text`. */
  lang: string;
  segmentIds: string[];
  createdAt: number;
  /** Session ms of the source speech (for SRT export). */
  startMs?: number | null;
  endMs?: number | null;
  hidden?: boolean;
}

/** Server → client messages on /ws (overlay, control) and, session-scoped, on /ws/page. */
export type ServerMessage =
  | {
      type: "hello";
      protocol: 1;
      serverTime: number;
      sessionId: string | null;
      langs: { source: string; targets: string[] };
      tracks: TrackId[];
      primary: TrackId;
    }
  | {
      type: "snapshot";
      track: TrackId;
      session: SessionInfo | null;
      segments: Segment[];
      status: Status;
    }
  | { type: "segment"; track: TrackId; segment: Segment }
  | { type: "clear"; track: TrackId | "all" }
  | { type: "status"; status: Status }
  | { type: "level"; rmsDbfs: number; peakDbfs: number }
  | { type: "blocks.snapshot"; blocks: Block[]; hasMore: boolean }
  | { type: "block.add"; block: Block }
  | { type: "block.update"; block: Block }
  | { type: "mode"; mode: SessionMode }
  | { type: "listening"; active: boolean; partial?: string }
  | { type: "session.ended"; endedAt: number };

/** Client → server on /ws: subscribe is the only message (actions go through HTTP). */
export type ClientMessage = { type: "subscribe"; topics: Array<"level"> };

// --- caption page protocol ---------------------------------------------------------------------

export interface VadParams {
  thresholdDbfs: number;
  minSpeechMs: number;
  minSilenceMs: number;
  hangoverMs: number;
  prerollMs: number;
}

export interface PageAudioFormat {
  codec: "pcm_s16le";
  sampleRate: 16000;
  channels: 1;
  frameMs: 100;
}

export type PageClientMessage =
  | {
      type: "hello";
      protocol: 1;
      from: string;
      to: string;
      key?: string;
      resume: string | null;
      client: { obs: boolean; ua: string };
      format: PageAudioFormat;
      /** "blocks" (default) or "rollup" (segment translations). */
      layout?: CaptionLayout;
      /** A screen feed (`?screen=<guid>` in the page URL, from /feed/<guid>). */
      screen?: ScreenLink;
    }
  | { type: "speech"; state: "start" | "end" };

export type PageErrorCode =
  | "bad_language"
  | "unauthorized"
  | "quota_exceeded"
  | "engine_unavailable"
  /** Unknown screen, bad/revoked signature, or the link's languages were changed. */
  | "screen_invalid"
  /** pages.requireScreen is on and the URL carries no screen link. */
  | "screen_required";

export type PageServerMessage =
  | {
      type: "ready";
      sessionId: string;
      resumed: boolean;
      vad: VadParams;
      limits: { maxFrameBytes: number; maxRealtimeFactor: number; dailyMinutesLeft: number | null };
    }
  | { type: "error"; code: PageErrorCode; message: string }
  /**
   * The screen's switch. "disabled": no session runs; the page releases the mic,
   * shows the waiting message and keeps the socket open. "enabled": the page sends a new hello.
   */
  | { type: "screen"; state: ScreenState; name: string }
  | Extract<
      ServerMessage,
      {
        type:
          | "snapshot"
          | "segment"
          | "clear"
          | "status"
          | "blocks.snapshot"
          | "block.add"
          | "block.update"
          | "mode"
          | "listening"
          | "session.ended";
      }
    >;

/** Bytes per 100 ms frame of 16 kHz mono s16le. */
export const PAGE_FRAME_BYTES = 3200;

// --- signed screen links, accounts, admin portal -----------------------------------------------

/**
 * A screen feed is identified by its GUID, a random UUID that only the portal hands
 * out (`/feed/<guid>` → `/<from>/<to>?<query>&screen=<guid>`), so the GUID itself is the signature.
 */
export interface ScreenLink {
  guid: string;
}

/** "reload": the look changed in the portal; the page reloads its feed link /feed/<guid>. */
export type ScreenState = "enabled" | "disabled" | "reload";

export type UserRole = "owner" | "admin" | "user";

/** The logged-in account (GET /api/auth/me). */
export interface Me {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  /** The organisation (mosque) this account belongs to; "local" in local mode. */
  orgId: string;
  /** Hosted mode logs in by e-mail. */
  email: string | null;
}

// --- modes, organisations and keys -------------------------------------------------------------

/** local: one mosque per install, keys in .env. hosted: many mosques, sign-up, encrypted keys. */
export type AppMode = "local" | "hosted";

export type KeyProvider = "soniox";

/** What the browser may know about an API key: never the key itself. */
export interface KeyStatus {
  provider: KeyProvider;
  set: boolean;
  /** Last four characters, for recognising the key. */
  last4: string | null;
  /** ISO time of the last successful check with the provider, or null (never checked). */
  validatedAt: string | null;
  /** "stored": encrypted in orgs.yaml; "env": from the server's .env (local mode). */
  source: "stored" | "env" | null;
}

/** GET /api/org: the caller's organisation. */
export interface OrgView {
  id: string;
  name: string;
  mode: AppMode;
  role: UserRole;
  keys: Record<KeyProvider, KeyStatus>;
  /** Caption minutes this calendar month, and an estimate at Soniox list prices (USD). */
  usage: { monthMinutes: number; estimateUsd: number | null };
}

/** GET /api/auth/state. */
export interface AuthStateView {
  /** Local mode: no account exists yet (the first admin is created at /login). */
  setupRequired: boolean;
  mode: AppMode;
  /** Hosted mode with sign-up open. */
  signup: boolean;
  /** Whether this request carries a valid login (pages that work without one ask this first:
   *  no 401 from /api/auth/me in a logged-out browser's console). */
  loggedIn: boolean;
}

/** POST /api/auth/signup (hosted). `website` is a honeypot and must stay empty. */
export interface SignupBody {
  orgName: string;
  name: string;
  email: string;
  password: string;
  website?: string;
}

/** PUT /api/org/keys/:provider. */
export interface KeyPutBody {
  key: string;
}

/** The answer to PUT /api/org/keys/:provider: stored; `checked` false when the provider was unreachable. */
export interface KeyPutResult {
  status: KeyStatus;
  checked: boolean;
  warning?: string;
}

/** An account as the admin portal lists it (never contains the password hash). */
export interface UserView extends Me {
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** Number of screens this account owns. */
  screens: number;
}

export type ScreenAction = "created" | "enabled" | "disabled" | "reset" | "regenerated" | "edited";

/** A screen as the portal shows it (GET /api/screens). */
export interface ScreenView {
  id: string;
  name: string;
  from: string;
  to: string;
  /** Display query of the link (theme params etc.), without screen/key/token. */
  query: string;
  /** The feed's GUID (in `url`); a new one on "regenerate". */
  guid: string;
  enabled: boolean;
  /** The admin let the owner enable/disable/reset this screen. */
  ownerControl: boolean;
  owner: { id: string; displayName: string } | null;
  createdAt: number;
  updatedAt: number;
  lastChange: { action: ScreenAction; by: string; at: number } | null;
  /** The feed link `<origin>/feed/<guid>` (origin from the request). */
  url: string;
  /**
   * Local mode: the feed link for OBS or a browser on the computer that runs Turjuman
   * (`http://127.0.0.1:<port>/feed/<guid>`), where the microphone works without HTTPS. Null in
   * hosted mode, or when the server does not listen on this computer's loopback address.
   */
  localUrl: string | null;
  /**
   * Local mode: an HTTPS feed link for other computers and TVs (microphones need HTTPS there): the
   * request's own address when it is HTTPS, else server.https.port on the same host when its
   * certificate is in place. Null when there is none (and in hosted mode, where `url` is it).
   */
  secureUrl: string | null;
  /** Live state: caption pages connected with this link, sessions running, someone speaking, and
   *  the prayer event on screen. */
  live: {
    pages: number;
    sessions: number;
    speaking: boolean;
    since: number | null;
    event: PrayerEvent | null;
  };
  /** The requesting user may enable/disable/reset (admin, or owner with ownerControl). */
  canControl: boolean;
  /** The requesting user may rename/edit/regenerate/delete (admin or owner). */
  canEdit: boolean;
}

/** Admin-editable server settings shown in the portal (GET/PATCH /api/settings). */
export interface PortalSettings {
  /** Only signed screen links can start captions (pages.requireScreen). */
  requireScreen: boolean;
}
