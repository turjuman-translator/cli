// The approved translation of the part of an ayah that was recited.
//
// A khatib often quotes part of an ayah and stops at a pause mark (waqf). The Uthmani text carries
// those marks, and an approved translation mostly has one sentence per waqf segment. The recited
// words (positions in the simple-clean text the matcher aligns to) are widened to whole waqf
// segments and mapped to whole translation sentences: one to one when the counts agree, otherwise
// by relative position (a sentence is taken when at least half of it falls inside the recited
// share). The result is always verbatim approved text, never a paraphrase.
import { arabicWords, foldAsrVariants } from "../text/arabic.js";
import { keyForm, matchForm } from "./corpus.js";

/** Pause marks that allow or recommend a stop (ۖ ۗ ۘ ۚ ۛ). ۙ means "do not stop": no boundary. */
const STOP_MARK = /^[ۖۗۘۚۛ]$/;
/** A token made only of Quranic annotation signs (no letters). */
const MARK_ONLY = /^[ۖ-ۭ࣓-ࣿ]+$/;
/** A segment counts as recited when this share of its words was (or it holds the most words). */
const SEGMENT_SHARE = 0.5;
/** A translation sentence belongs to the span when this share of it lies inside it (by position). */
const SENTENCE_SHARE = 0.5;

/** Abbreviations whose period does not end a sentence (Dutch/English approved translations). */
const ABBREVIATIONS = new Set([
  "bv",
  "bijv",
  "vgl",
  "dwz",
  "d.w.z",
  "o.a",
  "m.a.w",
  "enz",
  "etc",
  "nl",
  "resp",
  "ca",
  "e.g",
  "i.e",
  "cf",
  "vs",
  "st",
  "dr",
  "mr",
]);

export interface WaqfSegment {
  /** Uthmani words of the segment (no pause marks), as in the text. */
  words: string[];
  /** The segment as displayed: its words with any inner signs, without the closing stop mark. */
  display: string;
  /** The stop mark that closes the segment ("" for the last one). */
  stop: string;
}

export interface AyahSpan {
  /** The approved translation of the recited segments (whole sentences, verbatim). */
  text: string;
  /** Uthmani text of the recited segments, with the stop marks between them. */
  arabic: string;
  /** The span is the whole ayah. */
  full: boolean;
}

export interface SpanInput {
  uthmani: string;
  /** The ayah's simple-clean words in matching form (`corpusWords`), as the matcher counts them. */
  simpleWords: readonly string[];
  /** The approved translation of the whole ayah. */
  translation: string;
  /** First and last recited word (inclusive), positions in `simpleWords`. */
  from: number;
  to: number;
  /** Appended (after a space) when the span reaches the end of the ayah, e.g. "۝٢٥". */
  endMarker?: string;
}

/** Split an Uthmani ayah at its stop marks. */
export function waqfSegments(uthmani: string): WaqfSegment[] {
  const segs: WaqfSegment[] = [];
  let words: string[] = [];
  let shown: string[] = [];
  const close = (stop: string) => {
    if (words.length === 0) {
      // A mark before any word (never in Tanzil): keep it with the previous segment.
      const prev = segs[segs.length - 1];
      if (prev !== undefined && stop !== "") prev.stop = stop;
      return;
    }
    segs.push({ words, display: shown.join(" "), stop });
    words = [];
    shown = [];
  };
  for (const tok of uthmani.trim().split(/\s+/)) {
    if (tok === "") continue;
    if (STOP_MARK.test(tok)) {
      close(tok);
      continue;
    }
    shown.push(tok);
    if (!MARK_ONLY.test(tok) && arabicWords(tok).length > 0) words.push(tok);
  }
  close("");
  return segs;
}

/** Sentences of an approved translation (abbreviations and parentheses respected). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const s = text.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    if (depth > 0 || (ch !== "." && ch !== "!" && ch !== "?")) continue;
    // Closing quotes/brackets right after the end mark belong to the sentence.
    let end = i + 1;
    while (end < s.length && /["”’»)\]]/.test(s.charAt(end))) end++;
    if (end < s.length && !/\s/.test(s.charAt(end))) continue; // "3.5", "d.w.z"
    if (ch === ".") {
      const word = /([\p{L}.]+)$/u.exec(s.slice(start, i))?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(word)) continue;
      if (/^\p{L}$/u.test(word)) continue; // an initial
    }
    out.push(s.slice(start, end).trim()); // never empty: it holds the end mark
    start = end;
  }
  const rest = s.slice(start).trim();
  if (rest !== "") out.push(rest);
  return out;
}

function skeleton(word: string): string {
  const w = arabicWords(word)[0] ?? "";
  return keyForm(matchForm(foldAsrVariants(w)));
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return 1 - (prev[m] as number) / Math.max(n, m);
}

/**
 * Uthmani word index for every simple-clean word: a monotonic alignment where one Uthmani word
 * may stand for two simple-clean words (يَـٰٓأَيُّهَا = يا أيها) or the other way round.
 */
export function alignToUthmani(
  uthmaniWords: readonly string[],
  simpleWords: readonly string[],
): number[] {
  const u = uthmaniWords.map(skeleton);
  const s = simpleWords.map((w) => keyForm(w));
  const n = u.length;
  const m = s.length;
  const NEG = Number.NEGATIVE_INFINITY;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(NEG));
  const move = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  (score[0] as Float64Array)[0] = 0;
  const GAP = -0.6;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      // Finite: the gap moves reach every cell from [0][0] before it is visited.
      const here = (score[i] as Float64Array)[j] as number;
      // Only called for moves that stay inside the matrix.
      const relax = (di: number, dj: number, gain: number, kind: number) => {
        const row = score[i + di] as Float64Array;
        if (here + gain > (row[j + dj] as number)) {
          row[j + dj] = here + gain;
          (move[i + di] as Int8Array)[j + dj] = kind;
        }
      };
      const ui = u[i];
      const sj = s[j];
      const sNext = s[j + 1];
      const uNext = u[i + 1];
      if (ui !== undefined && sj !== undefined) relax(1, 1, similarity(ui, sj), 1);
      if (ui !== undefined && sj !== undefined && sNext !== undefined) {
        relax(1, 2, similarity(ui, sj + sNext) * 1.6, 2);
      }
      if (ui !== undefined && sj !== undefined && uNext !== undefined) {
        relax(2, 1, similarity(ui + uNext, sj) * 1.6, 3);
      }
      if (ui !== undefined) relax(1, 0, GAP, 4);
      if (sj !== undefined) relax(0, 1, GAP, 5);
    }
  }
  const map = new Array<number>(m).fill(0);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    // Every cell but [0][0] got a move when it was first reached.
    const k = (move[i] as Int8Array)[j] as number;
    if (k === 1) {
      map[j - 1] = i - 1;
      i--;
      j--;
    } else if (k === 2) {
      map[j - 1] = i - 1;
      map[j - 2] = i - 1;
      i--;
      j -= 2;
    } else if (k === 3) {
      map[j - 1] = i - 2;
      i -= 2;
      j--;
    } else if (k === 4) {
      i--;
    } else {
      // k === 5
      map[j - 1] = Math.max(0, i - 1);
      j--;
    }
  }
  return map;
}

/** The approved translation (and Uthmani text) of the recited waqf segments of one ayah. */
export function ayahSpan(input: SpanInput): AyahSpan | null {
  const segs = waqfSegments(input.uthmani);
  const words = input.simpleWords;
  const total = words.length;
  if (segs.length === 0 || total === 0) return null;
  const translation = input.translation.trim();
  if (translation === "") return null;
  const endMarker =
    input.endMarker === undefined || input.endMarker === "" ? "" : ` ${input.endMarker}`;
  const whole: AyahSpan = {
    text: translation,
    arabic: `${input.uthmani.trim()}${endMarker}`,
    full: true,
  };
  if (segs.length === 1) return whole;

  // Segment of every simple-clean word, through the word alignment.
  const uthmaniWords = segs.flatMap((s) => s.words);
  const segOfU: number[] = [];
  segs.forEach((s, k) => {
    for (let x = 0; x < s.words.length; x++) segOfU.push(k);
  });
  // alignToUthmani maps every simple-clean word to an index into uthmaniWords.
  const toU = alignToUthmani(uthmaniWords, words);
  const segOfS = toU.map((ui) => segOfU[ui] as number);
  const size = new Array<number>(segs.length).fill(0);
  const hit = new Array<number>(segs.length).fill(0);
  const from = Math.max(0, Math.min(input.from, total - 1));
  const to = Math.max(from, Math.min(input.to, total - 1));
  segOfS.forEach((k, j) => {
    size[k] = (size[k] as number) + 1;
    if (j >= from && j <= to) hit[k] = (hit[k] as number) + 1;
  });
  let best = 0;
  for (let k = 1; k < segs.length; k++) if ((hit[k] as number) > (hit[best] as number)) best = k;
  let kFrom = best;
  let kTo = best;
  for (let k = 0; k < segs.length; k++) {
    const kSize = size[k] as number;
    if (kSize > 0 && (hit[k] as number) >= SEGMENT_SHARE * kSize) {
      kFrom = Math.min(kFrom, k);
      kTo = Math.max(kTo, k);
    }
  }
  if (kFrom === 0 && kTo === segs.length - 1) return whole;

  // Translation sentences of segments kFrom..kTo.
  const sentences = splitSentences(translation);
  let pick: string[];
  if (sentences.length === segs.length) {
    pick = sentences.slice(kFrom, kTo + 1);
  } else {
    let before = 0;
    for (let k = 0; k < kFrom; k++) before += size[k] as number;
    let inside = 0;
    for (let k = kFrom; k <= kTo; k++) inside += size[k] as number;
    const lo = before / total;
    const hi = (before + inside) / total;
    const lengths = sentences.map((s) => s.length + 1);
    const chars = lengths.reduce((a, b) => a + b, 0);
    let at = 0;
    let first = -1;
    let last = -1;
    let bestShare = 0;
    let bestIdx = 0;
    sentences.forEach((_, i) => {
      const len = lengths[i] as number;
      const a = at / chars;
      const b = (at + len) / chars;
      at += len;
      const share = Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a);
      if (share > bestShare) {
        bestShare = share;
        bestIdx = i;
      }
      if (share >= SENTENCE_SHARE) {
        if (first === -1) first = i;
        last = i;
      }
    });
    if (first === -1) {
      first = bestIdx;
      last = bestIdx;
    }
    pick = sentences.slice(first, last + 1);
    if (first === 0 && last === sentences.length - 1) {
      // Every sentence: the translation cannot be split here, so show the whole ayah's meaning,
      // with the Arabic of what was recited.
      pick = sentences;
    }
  }
  const arabicParts: string[] = [];
  for (let k = kFrom; k <= kTo; k++) {
    const s = segs[k] as WaqfSegment;
    arabicParts.push(s.display);
    if (k < kTo && s.stop !== "") arabicParts.push(s.stop);
  }
  let arabic = arabicParts.join(" ");
  if (kTo === segs.length - 1) arabic += endMarker;
  return { text: pick.join(" "), arabic, full: false };
}
