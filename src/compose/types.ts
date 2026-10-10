// Contracts for caption blocks: the Quran matcher, the block output and the Quran follower.
import type { Block, PrayerEvent, SessionMode } from "../shared/protocol.js";

// --- Quran matcher ---------------------------------------------------------------------------

export interface QuranMatch {
  /** "2:286" or a merged range "2:285-286". */
  ref: string;
  /** True when only part of the ayah (range) was quoted. */
  partial: boolean;
  /** The matched ayah text (simple-clean). */
  arabic: string;
  /** Approved translation of the whole ayah (range) in the target language, or null. */
  approved: string | null;
  /** Matched word span in `text` (words as `arabicWords(text)` splits them): [start, end). */
  span: { start: number; end: number };
  /** Alignment similarity 0..1 of the matched span. */
  score: number;
}

export interface QuranMatcherApi {
  /** True once the Tanzil corpus is loaded (false = matching disabled, e.g. data missing). */
  readonly ready: boolean;
  /**
   * Find verified Quran quotes in a text window (carry + segment, optionally preceded by the
   * previous segment for quotes that span a boundary). `ignoreStoplist` during Salah.
   */
  match(
    window: { text: string; prevText?: string },
    opts: { targetLang: string; ignoreStoplist: boolean },
  ): QuranMatch[];
  /** Uthmani text of a ref ("2:286" / "2:285-286") for display, or null. */
  verseText(ref: string): string | null;
  /** Approved translation of a ref in `lang`, or null. */
  approvedText(ref: string, lang: string): string | null;
}

// --- caption blocks -----------------------------------------------------------------------------

/** Card labels of a prayer event in the target language (config events.labels). */
export interface EventLabel {
  ar: string;
  title: string;
  subtitle: string;
}

export type EventLabels = Record<PrayerEvent, EventLabel>;

/** Messages the block pipeline emits; the session forwards them to subscribers. */
export type PipelineOutput =
  | { type: "block.add"; block: Block }
  | { type: "block.update"; block: Block }
  | { type: "mode"; mode: SessionMode }
  | { type: "listening"; active: boolean; partial?: string };

// --- Quran follower (incremental, word level) --------------------------------------------------

/** A recited Quran span in the session's word stream. */
export interface FollowerVerse {
  /** One ayah, e.g. "2:286". */
  ref: string;
  /** Word-stream indices [from, to) of the recited words. */
  from: number;
  to: number;
  /** Coverage of the ayah ≥ 0.8 (or every waqf segment recited). */
  complete: boolean;
  /** Approved translation (target language) of the recited part (whole waqf segments, verbatim)
   *  or of the whole ayah; null when unknown (then the live chunks are quoted). */
  approved: string | null;
  /** Uthmani text of the recited part (for quranArabic), or null. */
  uthmani: string | null;
  /** `approved`/`uthmani` cover only part of the ayah (the recited waqf segments). */
  partial?: boolean;
  /** First report of this ayah in this recitation (emit a block); false = extension/repeat. */
  isNew: boolean;
}

export interface FollowerResult {
  /** Every word with index < decidedTo has its final disposition (in a verse range, or plain). */
  decidedTo: number;
  /** Verse ranges confirmed or extended by this call. */
  verses: FollowerVerse[];
}

/**
 * Follows the khatib word by word. Words that may be a Quran quote stay
 * undecided (the caller holds their translation) until confirmed or released (≤ ~8 words / 3 s).
 */
export interface QuranFollowerApi {
  readonly ready: boolean;
  /** Append newly finalized Arabic source text (any amount, in order). */
  push(text: string, at: number): FollowerResult & { added: number };
  /** The speaker paused (endpoint) or time passed: resolve pending candidates where possible. */
  flush(at: number): FollowerResult;
  /** Forget all state (reset/clear). */
  reset(): void;
}
