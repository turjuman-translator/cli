// Pure Soniox frame → ProviderEvent mapping, shared by the live provider and the replay
// (FakeProvider): walk tokens in order, split runs at <end>/<fin>.
import {
  classifySonioxError,
  describeSonioxError,
  isSonioxControlToken,
  parseSonioxResponse,
  type SonioxResponse,
  type SonioxServerError,
  type SonioxToken,
  sonioxContextReductionSteps,
  targetLanguageFromConfig,
} from "./soniox-protocol.js";
import type { ProviderEvent, RecordingLine, ReplayMapperFactory, Token } from "./types.js";

export interface SonioxMapOptions {
  /** Native translation target (mirrors "none" tokens in that language), or null. */
  targetLanguage: string | null;
  receivedAt: number;
}

/** Arabic presentation forms (with the space before them) in a translation token. */
const STRAY_FORMS = /\s*[\uFB50-\uFDFF\uFE70-\uFEFF]+/g;

/**
 * One Soniox token → contract tokens.
 * - "original" / absent → source (with lang and session-relative ms);
 * - "translation" → translation;
 * - "none" (spoken, not translated) → source, plus a mirrored translation token with the same
 *   text when its language is the target language.
 */
export function mapSonioxToken(t: SonioxToken, targetLanguage: string | null): Token[] {
  const lang = t.language ?? undefined;
  if (t.translation_status === "translation") {
    // Soniox sometimes writes Arabic presentation forms into a translation ("en ﴊ ﴾ ﴾" for
    // «والصلاة والسلام على …»): never shown; the honorific rules add the right
    // ligature from the words.
    const text = t.text.replace(STRAY_FORMS, "");
    return [
      lang === undefined ? { text, kind: "translation" } : { text, kind: "translation", lang },
    ];
  }
  const source: Token = { text: t.text, kind: "source" };
  if (lang !== undefined) source.lang = lang;
  if (typeof t.start_ms === "number") source.startMs = t.start_ms;
  if (typeof t.end_ms === "number") source.endMs = t.end_ms;
  if (t.translation_status === "none" && targetLanguage !== null && lang === targetLanguage) {
    return [source, { text: t.text, kind: "translation", lang: targetLanguage }];
  }
  return [source];
}

/**
 * Token frame → events. Tokens are walked in order and split into runs at <end>/<fin>
 * (stripped from the text): each run becomes one `tokens` event and each marker an `endpoint`.
 * Every frame yields at least one `tokens` event, because non-final tokens are replaced by
 * every frame (an empty frame clears them). Error frames are not handled here.
 */
export function mapSonioxMessage(msg: SonioxResponse, opts: SonioxMapOptions): ProviderEvent[] {
  const { receivedAt, targetLanguage } = opts;
  const events: ProviderEvent[] = [];
  let final: Token[] = [];
  let nonFinal: Token[] = [];
  const flush = (): void => {
    events.push({ type: "tokens", final, nonFinal, receivedAt });
    final = [];
    nonFinal = [];
  };
  for (const t of msg.tokens) {
    if (isSonioxControlToken(t.text)) {
      // Both markers are always final; a non-final one would be noise, so it is dropped.
      if (t.is_final === true) {
        flush();
        events.push({ type: "endpoint", receivedAt });
      }
      continue;
    }
    const mapped = mapSonioxToken(t, targetLanguage);
    if (t.is_final === true) final.push(...mapped);
    else nonFinal.push(...mapped);
  }
  if (final.length > 0 || nonFinal.length > 0 || events.length === 0) flush();
  return events;
}

/**
 * Drops an `endpoint` that has no final token since the previous endpoint (or since the
 * session start). After finalize() Soniox sends both <fin> and <end> for the same utterance,
 * in either order and up to ~2 s apart (seen in recorded sessions), so the second marker
 * would close an empty segment. Stateful: one per provider session, in the live provider and
 * in the replay mapper alike.
 */
export class EndpointDeduper {
  private finalSinceEndpoint = false;

  apply(events: ProviderEvent[]): ProviderEvent[] {
    return events.filter((e) => {
      if (e.type === "tokens") {
        if (e.final.length > 0) this.finalSinceEndpoint = true;
        return true;
      }
      if (e.type !== "endpoint") return true;
      const keep = this.finalSinceEndpoint;
      this.finalSinceEndpoint = false;
      return keep;
    });
  }

  /** New provider session. */
  reset(): void {
    this.finalSinceEndpoint = false;
  }
}

/** Whether a provider session line starts with a `reconnected` event (live and replay agree). */
export function sessionStartsWithReconnect(index: number, audioOffsetMs: number): boolean {
  return index > 0 || audioOffsetMs > 0;
}

/**
 * Error event for an error frame. `retryNote` is set when the provider retries a 400 at
 * session start with less context: the event is then a non-fatal warning.
 */
export function sonioxErrorEvent(
  err: SonioxServerError,
  retryNote: string | null,
): Extract<ProviderEvent, { type: "error" }> {
  const message = describeSonioxError(err);
  if (retryNote !== null)
    return { type: "error", fatal: false, message: `${message} (${retryNote})` };
  return { type: "error", fatal: classifySonioxError(err.code, err.type) === "fatal", message };
}

/**
 * Replay mapper for Soniox `provider.jsonl` recordings: `msg` lines go through
 * mapSonioxMessage + EndpointDeduper, `session` lines of new provider sessions become
 * `reconnected`, error frames become `error` events (context retries as warnings, like the live
 * provider). `receivedAt` is the replay time (FakeProvider overwrites it with its own clock).
 */
export const sonioxReplayMapper: ReplayMapperFactory = (meta) => {
  const targetLanguage = targetLanguageFromConfig(meta.config);
  let reductionsLeft = sonioxContextReductionSteps(meta.config);
  let sessionHadTokens = false;
  const endpoints = new EndpointDeduper();
  return {
    onLine(line: Exclude<RecordingLine, { kind: "meta" }>): ProviderEvent[] {
      if (line.kind === "session") {
        sessionHadTokens = false;
        endpoints.reset();
        return sessionStartsWithReconnect(line.index, line.audioOffsetMs)
          ? [{ type: "reconnected", gapMs: line.gapMs ?? 0, audioOffsetMs: line.audioOffsetMs }]
          : [];
      }
      if (line.kind !== "msg") return [];
      const parsed = parseSonioxResponse(line.data);
      if (!parsed.ok) return [];
      const { msg } = parsed;
      if (msg.error !== null) {
        const retry = msg.error.code === 400 && !sessionHadTokens && reductionsLeft > 0;
        if (retry) reductionsLeft--;
        return [sonioxErrorEvent(msg.error, retry ? "retrying with less context" : null)];
      }
      sessionHadTokens = true;
      return endpoints.apply(mapSonioxMessage(msg, { targetLanguage, receivedAt: Date.now() }));
    },
  };
};
