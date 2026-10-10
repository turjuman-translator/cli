// Soniox real-time WebSocket protocol (raw, no SDK): session config, server frames, errors.
// Facts verified against the API on 2026-10-02; never set language_hints_strict.
import { z } from "zod";
import type { SonioxContext } from "../glossary.js";

export const SONIOX_URLS = {
  default: "wss://stt-rt.soniox.com/transcribe-websocket",
  eu: "wss://stt-rt.eu.soniox.com/transcribe-websocket",
} as const;

export type SonioxRegion = keyof typeof SONIOX_URLS;

/** Endpoint-detection marker token. */
export const SONIOX_END = "<end>";
/** Manual-finalization marker token (reply to {"type":"finalize"}). */
export const SONIOX_FIN = "<fin>";

export function isSonioxControlToken(text: string): boolean {
  return text === SONIOX_END || text === SONIOX_FIN;
}

// --- session config (first, text message) ----------------------------------------------------

export interface SonioxSessionConfig {
  api_key: string;
  model: string;
  audio_format: "pcm_s16le";
  sample_rate: 16000;
  num_channels: 1;
  language_hints?: string[];
  enable_endpoint_detection: boolean;
  max_endpoint_delay_ms?: number;
  /** 0–3, higher = faster endpoints (Soniox docs). */
  endpoint_latency_adjustment_level?: number;
  /** −1.0…1.0, higher = endpoints more likely. */
  endpoint_sensitivity?: number;
  translation?: { type: "one_way"; target_language: string };
  context?: SonioxContext;
  client_reference_id: string;
}

export interface SonioxConfigInput {
  apiKey: string;
  model: string;
  /** Source language code, or "auto" (no language hints). */
  from: string;
  /** Extra hints; `from` is always first. Ignored when `from` is "auto". */
  languageHints?: readonly string[] | undefined;
  /** Native one-way translation target, or null (no translation block). */
  targetLanguage: string | null;
  context: SonioxContext | null;
  endpointDetection: boolean;
  /** 500–3000; null = Soniox default. */
  maxEndpointDelayMs: number | null;
  /** 0–3; null = Soniox default (0). */
  endpointLatencyLevel?: number | null;
  /** −1.0…1.0; null = Soniox default (0.0). */
  endpointSensitivity?: number | null;
  sessionId: string;
}

const MAX_CLIENT_REFERENCE_ID = 256;

/**
 * Context as sent: empty parts removed, `translation_terms` only with native translation.
 * Returns null when nothing is left (the `context` field is then omitted).
 */
export function cleanSonioxContext(
  ctx: SonioxContext | null,
  nativeTranslation: boolean,
): SonioxContext | null {
  if (ctx === null) return null;
  const out: SonioxContext = {};
  if (ctx.general !== undefined && ctx.general.length > 0) {
    out.general = ctx.general.map((kv) => ({ ...kv }));
  }
  if (ctx.text !== undefined && ctx.text.trim() !== "") out.text = ctx.text;
  if (ctx.terms !== undefined && ctx.terms.length > 0) out.terms = [...ctx.terms];
  if (
    nativeTranslation &&
    ctx.translation_terms !== undefined &&
    ctx.translation_terms.length > 0
  ) {
    out.translation_terms = ctx.translation_terms.map((t) => ({ ...t }));
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function buildSonioxConfig(input: SonioxConfigInput): SonioxSessionConfig {
  const config: SonioxSessionConfig = {
    api_key: input.apiKey,
    model: input.model,
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    num_channels: 1,
    enable_endpoint_detection: input.endpointDetection,
    client_reference_id: input.sessionId.slice(0, MAX_CLIENT_REFERENCE_ID),
  };
  if (input.from !== "auto") {
    const hints = [input.from, ...(input.languageHints ?? [])].filter((h) => h !== "auto");
    config.language_hints = [...new Set(hints)];
  }
  if (input.endpointDetection && input.maxEndpointDelayMs !== null) {
    config.max_endpoint_delay_ms = input.maxEndpointDelayMs;
  }
  if (input.endpointDetection && input.endpointLatencyLevel != null) {
    config.endpoint_latency_adjustment_level = input.endpointLatencyLevel;
  }
  if (input.endpointDetection && input.endpointSensitivity != null) {
    config.endpoint_sensitivity = input.endpointSensitivity;
  }
  if (input.targetLanguage !== null) {
    config.translation = { type: "one_way", target_language: input.targetLanguage };
  }
  const context = cleanSonioxContext(input.context, input.targetLanguage !== null);
  if (context !== null) config.context = context;
  return config;
}

/** The config with the key replaced, for recordings and logs. */
export function redactSonioxConfig(config: SonioxSessionConfig): SonioxSessionConfig {
  return { ...config, api_key: "[redacted]" };
}

/**
 * Fallback after a 400 at session start while `context` is present: first drop
 * `context.translation_terms` (keeping the recognition context), then drop `context`.
 * Returns the next config to try and what was removed, or null when nothing is left to drop.
 */
export function reduceSonioxContext(
  config: SonioxSessionConfig,
): { config: SonioxSessionConfig; dropped: "translation_terms" | "context" } | null {
  const ctx = config.context;
  if (ctx === undefined) return null;
  const { context: _removed, ...rest } = config;
  if (ctx.translation_terms !== undefined) {
    const { translation_terms: _terms, ...others } = ctx;
    if (Object.keys(others).length > 0) {
      return { config: { ...rest, context: others }, dropped: "translation_terms" };
    }
  }
  return { config: rest, dropped: "context" };
}

/** How many context reductions a recorded (or live) config allows; mirrors reduceSonioxContext. */
export function sonioxContextReductionSteps(config: unknown): number {
  const ctx = isRecord(config) ? config.context : undefined;
  if (!isRecord(ctx)) return 0;
  const keys = Object.keys(ctx);
  const others = keys.filter((k) => k !== "translation_terms").length;
  return keys.includes("translation_terms") && others > 0 ? 2 : 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Native translation target from a recorded (redacted) config, or null. */
export function targetLanguageFromConfig(config: unknown): string | null {
  const parsed = z
    .object({ translation: z.object({ target_language: z.string().min(1) }).nullish() })
    .safeParse(config);
  return parsed.success ? (parsed.data.translation?.target_language ?? null) : null;
}

// --- server frames ---------------------------------------------------------------------------

const optNum = z.number().nullish();
const optStr = z.string().nullish();

/** One token. `translation_status`: "none" | "original" | "translation" (absent = original). */
export const SonioxTokenSchema = z.object({
  text: z.string(),
  start_ms: optNum,
  end_ms: optNum,
  confidence: optNum,
  is_final: z.boolean().nullish(),
  speaker: z.union([z.string(), z.number()]).nullish(),
  language: optStr,
  translation_status: optStr,
  source_language: optStr,
});

export type SonioxToken = z.output<typeof SonioxTokenSchema>;

const SonioxFrameSchema = z.object({
  tokens: z.array(z.unknown()).nullish(),
  final_audio_proc_ms: optNum,
  total_audio_proc_ms: optNum,
  finished: z.boolean().nullish(),
  error_code: z.union([z.number(), z.string()]).nullish(),
  error_type: optStr,
  error_message: optStr,
});

export interface SonioxResponse {
  tokens: SonioxToken[];
  finalAudioProcMs: number | null;
  totalAudioProcMs: number | null;
  finished: boolean;
  error: SonioxServerError | null;
}

export interface SonioxServerError {
  code: number | null;
  type: string | null;
  message: string | null;
}

export type SonioxParseResult =
  | { ok: true; msg: SonioxResponse; droppedTokens: number }
  | { ok: false; reason: string };

/**
 * Validate one parsed server frame. Lenient on purpose: malformed tokens are dropped (and
 * counted) instead of losing the whole frame.
 */
export function parseSonioxResponse(raw: unknown): SonioxParseResult {
  const frame = SonioxFrameSchema.safeParse(raw);
  if (!frame.success) {
    return { ok: false, reason: frame.error.issues.map((i) => i.message).join("; ") };
  }
  const tokens: SonioxToken[] = [];
  let droppedTokens = 0;
  for (const t of frame.data.tokens ?? []) {
    const token = SonioxTokenSchema.safeParse(t);
    if (token.success) tokens.push(token.data);
    else droppedTokens++;
  }
  const d = frame.data;
  const hasError = d.error_code !== null && d.error_code !== undefined;
  let code: number | null = null;
  if (hasError) {
    const n = typeof d.error_code === "number" ? d.error_code : Number(d.error_code);
    code = Number.isFinite(n) ? n : null;
  }
  return {
    ok: true,
    droppedTokens,
    msg: {
      tokens,
      finalAudioProcMs: d.final_audio_proc_ms ?? null,
      totalAudioProcMs: d.total_audio_proc_ms ?? null,
      finished: d.finished === true,
      error:
        hasError || (d.error_type ?? null) !== null
          ? { code, type: d.error_type ?? null, message: d.error_message ?? null }
          : null,
    },
  };
}

// --- errors ----------------------------------------------------------------------------------

const FATAL_CODES = new Set([400, 401, 402, 403]);
const FATAL_TYPES = new Set([
  "invalid_request",
  "model_not_available",
  "unauthenticated",
  "organization_balance_exhausted",
  "organization_monthly_budget_exhausted",
  "project_monthly_budget_exhausted",
  "permission_denied",
  "temp_api_key_session_expired",
]);

/**
 * Fatal = auth/config/quota (400–403 and their error types): no retry. Everything else
 * (408, 413 max_duration_reached, 429, 500, 503, unknown) is retried with backoff.
 */
export function classifySonioxError(code: number | null, type: string | null): "fatal" | "retry" {
  if (code !== null && FATAL_CODES.has(code)) return "fatal";
  if (type !== null && FATAL_TYPES.has(type)) return "fatal";
  return "retry";
}

export function describeSonioxError(err: SonioxServerError): string {
  const head = [err.code ?? "?", err.type].filter((p) => p !== null && p !== "").join(" ");
  return `Soniox error ${head}${err.message !== null && err.message !== "" ? `: ${err.message}` : ""}`;
}
