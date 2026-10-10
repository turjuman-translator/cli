// Speech-to-text provider contract.
import type { ProviderState, TrackId } from "../shared/protocol.js";

export type { ProviderState } from "../shared/protocol.js";

export interface Token {
  text: string;
  kind: "source" | "translation";
  /** Language of `text` (source tokens: spoken language; translation tokens: target). */
  lang?: string;
  /** Source tokens only: ms relative to the start of the current provider session's audio. */
  startMs?: number;
  endMs?: number;
}

export type ProviderEvent =
  | { type: "tokens"; final: Token[]; nonFinal: Token[]; receivedAt: number }
  | { type: "endpoint"; receivedAt: number }
  /**
   * A new provider session started after a gap (reconnect). `audioOffsetMs` is the position in
   * this provider's input audio (all frames passed to sendAudio, including dropped ones) where
   * the new session's audio starts; token ms of the new session are relative to it.
   */
  | { type: "reconnected"; gapMs: number; audioOffsetMs: number }
  | { type: "state"; state: ProviderState; detail?: string }
  | { type: "error"; fatal: boolean; message: string };

export interface ProviderCapabilities {
  /** Emits translation tokens itself (Soniox native translation). */
  nativeTranslation: boolean;
  /** "provider": tokens carry startMs/endMs; "arrival": timing comes from arrival times. */
  timing: "provider" | "arrival";
  /** Translation of an utterance is complete when its endpoint arrives (decided from logs). */
  translationFinalAtEndpoint: boolean;
}

// --- provider.jsonl recordings (debug + FakeProvider input) ---------------------------------

/** One line of provider.jsonl. Line 1 is `meta`; `t` is ms since the provider's start(). */
export type RecordingLine =
  | { kind: "meta"; provider: string; version: 1; startedAt: number; config?: unknown }
  | {
      t: number;
      kind: "session";
      index: number;
      audioOffsetMs: number;
      gapMs?: number;
      leg?: number;
    }
  | { t: number; kind: "msg"; session?: number; leg?: number; data: unknown }
  | { t: number; kind: "close"; session?: number; leg?: number; code?: number; reason?: string }
  | { t: number; kind: "switch"; from: number; to: number };

/** Stateful mapper that turns recorded lines back into the events the live provider emitted. */
export interface ReplayMapper {
  onLine(line: Exclude<RecordingLine, { kind: "meta" }>): ProviderEvent[];
}

/** Per-provider factory (Soniox: soniox-map.ts), injected into FakeProvider. */
export type ReplayMapperFactory = (meta: Extract<RecordingLine, { kind: "meta" }>) => ReplayMapper;

export interface SttProvider {
  readonly track: TrackId;
  readonly capabilities: ProviderCapabilities;
  readonly state: ProviderState;
  /** Connect. Audio sent before the connection is live is buffered and flushed. */
  start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void>;
  /** One 3,200-byte frame = 100 ms of 16 kHz mono s16le. */
  sendAudio(frame: Uint8Array): void;
  /** Force-close the current utterance (Soniox {"type":"finalize"}). */
  finalize(): void;
  /** Graceful: finalize + end of stream + wait (bounded), then close. */
  stop(opts?: { fast?: boolean }): Promise<void>;
}
