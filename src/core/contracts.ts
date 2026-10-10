// Contracts between the session layer (src/core), the server (src/server), the engine
// (src/stt) and audio inputs (src/audio). Each side codes against these
// interfaces so the pieces can be built in parallel and wired in src/core/engines.ts / CLI.
import type { Secrets } from "../config.js";
import type { Glossary } from "../glossary.js";
import type {
  AudioState,
  Block,
  CaptionLayout,
  Health,
  PageErrorCode,
  PrayerEvent,
  ServerMessage,
  SessionInfo,
  SessionKind,
  SessionSummary,
  Status,
  TrackId,
} from "../shared/protocol.js";
import type { Level } from "../shared/vad.js";
import type { SttProvider } from "../stt/types.js";

// --- engines -------------------------------------------------------------------------------

export interface EngineRequest {
  track: TrackId;
  sessionId: string;
  /** Source language code, or "auto". */
  from: string;
  to: string;
  /** Glossary for the pair (null = no Soniox context). */
  glossary: Glossary | null;
  /** Where to write provider.jsonl, or null when recording is off. */
  recordFile: string | null;
  /** Fast blocks: Soniox gets the fast-blocks endpoint defaults (engines.ts). */
  fastBlocks?: boolean;
  /** The API keys of the session's organisation; default: the server's .env. */
  secrets?: Secrets;
}

export interface Engine {
  provider: SttProvider;
}

/** Builds providers from config and secrets (implemented in src/core/engines.ts). */
export type EngineFactory = (req: EngineRequest) => Engine;

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

// --- audio inputs (device / file / network via ffmpeg) -------------------------------------

export interface AudioInputHandlers {
  /** One 3,200-byte frame (100 ms, 16 kHz mono s16le) and the wall time it arrived. */
  onFrame(frame: Uint8Array, arrivalWallMs: number): void;
  onLevel?(level: Level): void;
  onState?(state: AudioState, detail: { lastStderr: string | null }): void;
  /** File input reached its end (no loop). */
  onEnded?(): void;
}

export interface AudioInputApi {
  start(handlers: AudioInputHandlers): void;
  stop(): Promise<void>;
  readonly state: AudioState;
  readonly lastStderr: string | null;
}

export type AudioInputSpec =
  | { kind: "device"; device: string }
  | { kind: "file"; path: string; loop: boolean; startAtSec: number }
  | { kind: "network"; port: number; sampleRate: number; channels: number };

// --- sessions (consumed by the server) ----------------------------------------------------

export class SessionError extends Error {
  constructor(
    readonly code: PageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export type SessionListener = (msg: ServerMessage) => void;

export interface CaptionSessionApi {
  readonly id: string;
  readonly kind: SessionKind;
  info(): SessionInfo;
  status(): Status;
  summary(): SessionSummary;
  /** One `snapshot` message per known track (sent on connect and after a clear). */
  snapshots(): ServerMessage[];
  /** Live segment/status/clear (and level, for local sessions) messages; returns unsubscribe. */
  subscribe(listener: SessionListener): () => void;

  // Page sessions: audio and VAD events from the browser.
  pushFrame(frame: Uint8Array): void;
  speech(state: "start" | "end"): void;
  /** The page's socket closed: keep the session for resumeGraceSec, then stop it. */
  detach(): void;
  /** The page resumed within the grace period. */
  attach(): void;

  clear(track?: TrackId | "all"): void;
  /** Block history (newest last); `before` = a block seq. */
  blocks(opts?: { before?: number; limit?: number }): { blocks: Block[]; hasMore: boolean };
  /** Prayer-event manual override (control page / POST /api/sessions/:id/event). */
  overrideEvent(event: PrayerEvent | "none"): void;
  stop(reason: string): Promise<void>;
}

export interface PageSessionRequest {
  from: string;
  to: string;
  keyId: string | null;
  keyLabel: string | null;
  client: { obs: boolean; ua: string };
  /** "blocks" (default) runs the fast-blocks pipeline; "rollup" only segments. */
  layout?: CaptionLayout;
  /** Called as engine-open time accrues, for usage accounting (ms, per engine). */
  onUsage?: (engine: TrackId, ms: number) => void;
  /** The organisation whose API keys the session uses; default "local". */
  orgId?: string;
}

export interface LocalStartRequest {
  source: "device" | "file";
  /** Absolute path (already validated by the server) for file sessions. */
  file?: string;
  loop?: boolean;
}

export interface SessionManagerApi {
  /** Throws SessionError("engine_unavailable"). */
  createPage(req: PageSessionRequest): CaptionSessionApi;
  get(id: string): CaptionSessionApi | undefined;
  list(): SessionSummary[];
  /** The local (device/file) session served on /ws, if any. */
  local(): CaptionSessionApi | null;
  startLocal(req: LocalStartRequest): Promise<{ ok: boolean; message: string }>;
  stopLocal(reason: string): Promise<{ ok: boolean; message: string }>;
  /** Level + status of the idle monitor (device/network inputs), for /control before Start. */
  subscribeMonitor(listener: SessionListener): () => void;
  health(): Health;
  stopAll(reason: string): Promise<void>;
  /** The organisation of a live session, or null when unknown. */
  orgOf?(id: string): string | null;
}
