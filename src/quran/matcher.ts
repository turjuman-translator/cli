// Quran matcher: verified references.
//
// A text window (previous segment + carry + segment) is normalized, candidate regions are found
// with the word 3-gram index, and each region is aligned to the window with a word-level
// Smith–Waterman alignment (fuzzy word equality ≥ 0.85 character similarity). A quote is
// accepted when ≥ minWords consecutive words align AND it covers ≥ minCoverage of the ayah (range)
// or ≥ 8 words. Precision first, because a wrong reference is worse than none:
//   * a quote that another Quran location explains (almost) equally well is ambiguous → no ref
//     (e.g. "إن الله على كل شيء قدير", or the refrain repeated in sura 54);
//   * edge ayat with only 1–2 matched words are not part of the ref;
//   * a match made only of stoplist phrases is dropped (unless ignoreStoplist, during Salah); the
//     basmala always counts as a stoplist phrase, so a khutbah opening "بسم الله الرحمن الرحيم،
//     الحمد لله رب العالمين" is not labelled (1:1-2).
import type { QuranMatch, QuranMatcherApi } from "../compose/types.js";
import type { Config } from "../config.js";
import { arabicWords } from "../text/arabic.js";
import { corpusWords, keyForm, loadCorpus, type QuranCorpus } from "./corpus.js";
import { type Candidate, TrigramIndex } from "./index.js";
import { type AyahSpan, ayahSpan } from "./spans.js";

export interface QuranMatcherOptions {
  /** ≥ this many consecutive aligned words (config.quran.minWords, default 5). */
  minWords: number;
  /** … and ≥ this share of the ayah (range) (config.quran.minCoverage, default 0.6) … */
  minCoverage: number;
  /** … or ≥ this many matched words (default 8). */
  longMatchWords?: number;
  /** … or a run of ≥ this many consecutive matched words (default 6: a distinctive partial
   *  quote of a long ayah, e.g. the first waqf segment of 57:25; still subject to ambiguity). */
  distinctRunWords?: number;
  /** Per-word character similarity for a word to count as aligned (default 0.85). */
  wordSimilarity?: number;
  /** Two locations whose alignment scores differ by less than this are ambiguous (≈ ¾ word). */
  ambiguityMargin?: number;
  /** Ultra-common formula phrases (config.quran.stoplist). */
  stoplist?: readonly string[];
}

/** Paths as resolved by loadConfig() (loaded.paths). */
export interface QuranDataPaths {
  quranTextFile: string;
  quranUthmaniFile: string;
  quranTranslations: Record<string, string>;
}

/** A verified quote inside a window of words (for the Quran follower). */
export interface WindowMatch {
  /** Window words [wStart, wEnd) of the alignment (first..last matched word). */
  wStart: number;
  wEnd: number;
  /** Ayah indices (mushaf order, 0-based) of the quoted range. */
  firstAyah: number;
  lastAyah: number;
  /** Aligned window words in order with their ayah and word position in it (simple-clean
   *  words, 0-based); ok = matched (≥ threshold). Extra (inserted) window words are not listed. */
  pairs: Array<{ w: number; ayah: number; pos: number; ok: boolean }>;
}

export interface WindowAnalysis {
  /** Verified quotes: accepted, unambiguous and not stoplisted (the matching rules above). */
  matches: WindowMatch[];
  /** Every alignment with ≥ 3 matched words, verified or not (quotes possibly in progress),
   *  with the ayah it starts in (several ayat = a generic Quranic phrase). */
  live: Array<{ wStart: number; wEnd: number; matched: number; ayah: number }>;
}

const MATCH_BONUS = 1; // a matched word scores 1 + similarity (≈ 2)
const MISMATCH = -1.5;
const GAP = -1.2;
const CONJ_SIM = 0.9; // same word but for a leading و/ف (ومن / من)
const SPLIT_GAP = 4; // ≥ this many consecutive unaligned words split a quote in two
const MAX_ROUNDS = 6;
/** Formula phrases that always count as stoplist (opening formulas of every khutbah). */
const BUILTIN_STOPLIST = ["بسم الله الرحمن الرحيم"];

interface Step {
  /** Window position, or -1 for a corpus word the speaker skipped. */
  w: number;
  /** Corpus position, or -1 for an extra window word. */
  c: number;
  /** Similarity of an aligned pair (0 for gaps). */
  sim: number;
  /** True when sim ≥ threshold (a matched word). */
  ok: boolean;
}

interface Piece {
  steps: Step[];
  score: number;
  /** Matched window positions. */
  wSet: Set<number>;
  wStart: number;
  wEnd: number;
  cStart: number;
  cEnd: number;
  /** Another location inside the same region explains the window as well. */
  internalTie: boolean;
}

interface Evaluated {
  /** The alignment trimmed to the included ayat (scores, spans and ambiguity use this). */
  trimmed: Piece;
  firstAyah: number;
  lastAyah: number;
  accepted: boolean;
}

function levenshtein(a: string, b: string): number {
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] as number;
}

function stripConj(w: string): string {
  return w.length > 2 && (w.startsWith("و") || w.startsWith("ف")) ? w.slice(1) : w;
}

/** Character similarity of two words in matching form, 0..1 (0 = certainly below threshold). */
function wordSimilarity(a: string, b: string, threshold: number): number {
  if (a === b) return 1;
  if (stripConj(a) === stripConj(b)) return CONJ_SIM;
  const max = Math.max(a.length, b.length);
  // One edit already drops a short word below the threshold; so does a large length difference.
  if (1 / max > 1 - threshold || Math.abs(a.length - b.length) > max * (1 - threshold)) return 0;
  return 1 - levenshtein(a, b) / max;
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
function arabicIndic(n: number): string {
  return String(n).replace(/\d/g, (d) => ARABIC_INDIC.charAt(Number(d)));
}

/** "2:286" / "2:285-286" (also accepts an en dash) → parts, or null. */
export function parseRef(ref: string): { sura: number; from: number; to: number } | null {
  const m = /^\s*(\d{1,3}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$/.exec(ref);
  if (m === null) return null;
  const sura = Number(m[1]);
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  if (sura < 1 || from < 1 || to < from) return null;
  return { sura, from, to };
}

export function formatRef(sura: number, from: number, to: number): string {
  return from === to ? `${sura}:${from}` : `${sura}:${from}-${to}`;
}

/**
 * The original (un-normalized) excerpt of `text` covered by a match span. Spans count the words
 * of `arabicWords(text)` (= `matchWords(text)`), so punctuation-only tokens don't count.
 */
export function sourceExcerpt(text: string, span: { start: number; end: number }): string {
  let n = 0;
  let from = -1;
  let to = -1;
  for (const t of text.matchAll(/\S+/g)) {
    const k = arabicWords(t[0]).length;
    if (k === 0) continue;
    if (from === -1 && n + k > span.start) from = t.index;
    if (n < span.end) to = t.index + t[0].length;
    n += k;
  }
  return from === -1 || to === -1 || to <= from ? "" : text.slice(from, to);
}

export class QuranMatcher implements QuranMatcherApi {
  readonly ready: boolean;
  private readonly corpus: QuranCorpus | null;
  private readonly index: TrigramIndex | null;
  private readonly minWords: number;
  private readonly minCoverage: number;
  private readonly longMatchWords: number;
  private readonly distinctRunWords: number;
  private readonly threshold: number;
  private readonly margin: number;
  private readonly stoplist: string[][];

  constructor(corpus: QuranCorpus | null, opts: QuranMatcherOptions) {
    this.corpus = corpus;
    this.index = corpus === null ? null : new TrigramIndex(corpus);
    this.ready = corpus !== null;
    this.minWords = Math.max(2, opts.minWords);
    this.minCoverage = opts.minCoverage;
    this.longMatchWords = opts.longMatchWords ?? 8;
    this.distinctRunWords = opts.distinctRunWords ?? 6;
    this.threshold = opts.wordSimilarity ?? 0.85;
    this.margin = opts.ambiguityMargin ?? 1.5;
    this.stoplist = [...BUILTIN_STOPLIST, ...(opts.stoplist ?? [])]
      .map((p) => corpusWords(p).map(keyForm))
      .filter((p) => p.length > 0);
  }

  match(
    window: { text: string; prevText?: string },
    opts: { targetLang: string; ignoreStoplist: boolean },
  ): QuranMatch[] {
    const corpus = this.corpus;
    const index = this.index;
    if (corpus === null || index === null) return [];
    try {
      return this.run(corpus, index, window, opts);
    } catch {
      return []; // never let a matcher bug stall captions
    }
  }

  verseText(ref: string): string | null {
    const r = this.resolve(ref);
    const corpus = this.corpus;
    if (r === null || corpus === null || corpus.uthmani === null) return null;
    const parts: string[] = [];
    // resolve() only returns ayah indices of the corpus (one Uthmani text per ayah).
    for (let idx = r.first; idx <= r.last; idx++) {
      parts.push(`${corpus.uthmani[idx] as string} ۝${arabicIndic(corpus.aya[idx] as number)}`);
    }
    return parts.join(" ");
  }

  approvedText(ref: string, lang: string): string | null {
    const r = this.resolve(ref);
    const rows = this.corpus?.translations.get(lang);
    if (r === null || rows === undefined) return null;
    const parts: string[] = [];
    for (let idx = r.first; idx <= r.last; idx++) {
      const t = rows[idx];
      if (t === undefined || t === null) return null;
      parts.push(t);
    }
    return parts.join(" ");
  }

  private resolve(ref: string): { first: number; last: number } | null {
    const p = parseRef(ref);
    const corpus = this.corpus;
    if (p === null || corpus === null) return null;
    const first = corpus.ayahIndex(p.sura, p.from);
    const last = corpus.ayahIndex(p.sura, p.to);
    return first < 0 || last < 0 ? null : { first, last };
  }

  // --- matching ---------------------------------------------------------------------------------

  private run(
    corpus: QuranCorpus,
    index: TrigramIndex,
    window: { text: string; prevText?: string },
    opts: { targetLang: string; ignoreStoplist: boolean },
  ): QuranMatch[] {
    const prev = window.prevText === undefined ? [] : corpusWords(window.prevText);
    const cur = corpusWords(window.text);
    if (cur.length === 0) return [];
    const words = [...prev, ...cur];
    const offset = prev.length;
    const { found } = this.search(corpus, index, words, opts.ignoreStoplist);
    const out: QuranMatch[] = [];
    for (const ev of found) {
      const m = this.toMatch(corpus, ev, offset, opts.targetLang);
      if (m !== null) out.push(m);
    }
    return out.sort((a, b) => a.span.start - b.span.start);
  }

  /**
   * Detailed analysis of a window of words in matching form (`corpusWords`), for the
   * incremental Quran follower: verified quotes with their word→ayah alignment, plus every
   * alignment that may still grow into a quote. Never throws (returns nothing on errors).
   */
  analyzeWords(words: readonly string[], opts: { ignoreStoplist: boolean }): WindowAnalysis {
    const corpus = this.corpus;
    const index = this.index;
    if (corpus === null || index === null || words.length === 0) return { matches: [], live: [] };
    try {
      const { found, live } = this.search(corpus, index, words, opts.ignoreStoplist);
      return {
        matches: found.map((ev) => ({
          wStart: ev.trimmed.wStart,
          wEnd: ev.trimmed.wEnd,
          firstAyah: ev.firstAyah,
          lastAyah: ev.lastAyah,
          pairs: ev.trimmed.steps
            .filter((st) => st.w >= 0 && st.c >= 0)
            .map((st) => {
              const ayah = corpus.wordAyah[st.c] as number;
              const pos = st.c - (corpus.ayahStart[ayah] as number);
              return { w: st.w, ayah, pos, ok: st.ok };
            }),
        })),
        live: live.map((p) => ({
          wStart: p.wStart,
          wEnd: p.wEnd,
          matched: p.wSet.size,
          ayah: corpus.wordAyah[p.cStart] as number,
        })),
      };
    } catch {
      return { matches: [], live: [] };
    }
  }

  /** True when these 1–2 words (matching form) could begin a Quran quote (a 3-gram starts so). */
  couldStartQuote(words: readonly string[]): boolean {
    return this.index?.startsGram(words.map(keyForm)) ?? false;
  }

  /** "2:286" for a 0-based ayah index, or null. */
  ayahRef(ayah: number): string | null {
    const corpus = this.corpus;
    if (corpus === null || ayah < 0 || ayah >= corpus.simple.length) return null;
    return `${corpus.sura[ayah] as number}:${corpus.aya[ayah] as number}`;
  }

  /**
   * The approved translation and Uthmani text of the recited part of an ayah:
   * words [from, to] (positions in the ayah) widened to whole waqf segments. Null without an
   * approved translation (missing or suspect) or Uthmani text.
   */
  ayahSpan(ayah: number, from: number, to: number, lang: string): AyahSpan | null {
    const corpus = this.corpus;
    if (corpus === null || corpus.uthmani === null) return null;
    if (ayah < 0 || ayah >= corpus.simple.length) return null;
    const translation = corpus.translations.get(lang)?.[ayah];
    const uthmani = corpus.uthmani[ayah];
    if (translation === null || translation === undefined || uthmani === undefined) return null;
    const start = corpus.ayahStart[ayah] as number;
    const end = corpus.ayahStart[ayah + 1] as number;
    try {
      return ayahSpan({
        uthmani,
        simpleWords: corpus.words.slice(start, end),
        translation,
        from,
        to,
        endMarker: `۝${arabicIndic(corpus.aya[ayah] as number)}`,
      });
    } catch {
      return null;
    }
  }

  /**
   * Position of `form` (matching form) among the ayah's words [from, from + reach), exact and
   * at least 4 letters long, or -1: a recited word just after a verse that the recognizer cut off
   * from it ("… الكتاب وال | بالقسط").
   */
  ayahNextPos(ayah: number, form: string, from: number, reach: number): number {
    const corpus = this.corpus;
    if (corpus === null || ayah < 0 || ayah >= corpus.simple.length || form.length < 4) return -1;
    const start = corpus.ayahStart[ayah] as number;
    const end = corpus.ayahStart[ayah + 1] as number;
    for (let p = Math.max(0, from); p < from + reach && start + p < end; p++) {
      if (corpus.words[start + p] === form) return p;
    }
    return -1;
  }

  /** Words of an ayah in matching form (0 when unknown). */
  ayahWordCount(ayah: number): number {
    const corpus = this.corpus;
    if (corpus === null || ayah < 0 || ayah >= corpus.simple.length) return 0;
    return (corpus.ayahStart[ayah + 1] as number) - (corpus.ayahStart[ayah] as number);
  }

  /** The search: greedy rounds of candidate alignment, acceptance, ambiguity and stoplist. */
  private search(
    corpus: QuranCorpus,
    index: TrigramIndex,
    words: readonly string[],
    ignoreStoplist: boolean,
  ): { found: Evaluated[]; live: Piece[] } {
    const keys = words.map(keyForm);
    const masked = new Array<boolean>(words.length).fill(false);
    const stopCovered = this.stoplistCoverage(keys);
    const found: Evaluated[] = [];
    const live: Piece[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const windowKeys = keys.map((k, i) => (masked[i] ? null : k));
      const candidates = index.candidates(windowKeys);
      if (candidates.length === 0) break;
      const evaluated: Evaluated[] = [];
      for (const cand of candidates) {
        for (const piece of this.align(corpus, words, masked, cand)) {
          live.push(piece);
          const ev = this.evaluate(corpus, piece);
          if (ev !== null) evaluated.push(ev);
        }
      }
      const pieces = dedupe(evaluated);
      const accepted = pieces
        .filter((e) => e.accepted)
        .sort((a, b) => b.trimmed.score - a.trimmed.score);
      if (accepted.length === 0) break;

      // The best accepted piece is always taken (nothing is claimed yet and alignments never
      // include masked words), so every round with an accepted piece makes progress.
      const claimed = new Set<number>();
      for (const ev of accepted) {
        const p = ev.trimmed;
        if ([...p.wSet].some((w) => claimed.has(w) || masked[w])) continue;
        const ambiguous =
          p.internalTie ||
          pieces.some(
            (q) =>
              q !== ev &&
              !overlaps(p.cStart, p.cEnd, q.trimmed.cStart, q.trimmed.cEnd) &&
              q.trimmed.score >= p.score - this.margin &&
              shared(p.wSet, q.trimmed.wSet) >= 0.5 * p.wSet.size,
          );
        const stoplisted = !ignoreStoplist && [...p.wSet].every((w) => stopCovered[w] === true);
        for (let w = p.wStart; w < p.wEnd; w++) {
          claimed.add(w);
          masked[w] = true;
        }
        if (!ambiguous && !stoplisted) found.push(ev);
      }
    }
    return { found, live };
  }

  /** Window positions covered by an occurrence of a stoplist phrase. */
  private stoplistCoverage(keys: readonly string[]): boolean[] {
    const covered = new Array<boolean>(keys.length).fill(false);
    const n = keys.length;
    for (const phrase of this.stoplist) {
      for (let i = 0; i + phrase.length <= n; i++) {
        if (phrase.every((k, j) => keys[i + j] === k)) {
          for (let j = 0; j < phrase.length; j++) covered[i + j] = true;
        }
      }
      // A stoplist phrase still being spoken at the end of the window ("… الحمد لله رب"): the
      // follower sees words as they arrive, so a trailing prefix (≥ 2 words) counts as covered.
      for (let k = Math.min(phrase.length - 1, n); k >= 2; k--) {
        if (phrase.slice(0, k).every((p, j) => keys[n - k + j] === p)) {
          for (let j = n - k; j < n; j++) covered[j] = true;
          break;
        }
      }
    }
    return covered;
  }

  /** Smith–Waterman of the window rows against one corpus region → pieces (split at long gaps). */
  private align(
    corpus: QuranCorpus,
    words: readonly string[],
    masked: readonly boolean[],
    cand: Candidate,
  ): Piece[] {
    const r0 = cand.wStart;
    const rows = cand.wEnd - cand.wStart;
    const c0 = cand.start;
    const cols = cand.end - cand.start; // ≥ 3 each: a candidate holds a whole 3-gram hit
    const width = cols + 1;
    const H = new Float64Array((rows + 1) * width);
    const ptr = new Uint8Array((rows + 1) * width); // 0 stop, 1 diag, 2 up (window gap), 3 left
    const sims = new Float64Array((rows + 1) * width);
    const t = this.threshold;
    let best = 0;
    let bi = 0;
    let bj = 0;
    for (let i = 1; i <= rows; i++) {
      const wi = r0 + i - 1;
      if (masked[wi]) continue; // masked rows are barriers: H stays 0
      const w = words[wi] as string;
      for (let j = 1; j <= cols; j++) {
        const sim = wordSimilarity(w, corpus.words[c0 + j - 1] as string, t);
        const k = i * width + j;
        sims[k] = sim;
        const s = sim >= t ? MATCH_BONUS + sim : MISMATCH;
        const diag = (H[k - width - 1] as number) + s;
        const up = (H[k - width] as number) + GAP;
        const left = (H[k - 1] as number) + GAP;
        let v = 0;
        let p = 0;
        if (diag > v) {
          v = diag;
          p = 1;
        }
        if (up > v) {
          v = up;
          p = 2;
        }
        if (left > v) {
          v = left;
          p = 3;
        }
        H[k] = v;
        ptr[k] = p;
        if (v > best) {
          best = v;
          bi = i;
          bj = j;
        }
      }
    }
    if (best <= 0) return [];

    // Traceback.
    const rev: Step[] = [];
    let i = bi;
    let j = bj;
    while (i > 0 && j > 0) {
      const k = i * width + j;
      const p = ptr[k];
      if (p === 0 || (H[k] as number) <= 0) break;
      if (p === 1) {
        const sim = sims[k] as number;
        rev.push({ w: r0 + i - 1, c: c0 + j - 1, sim, ok: sim >= t });
        i--;
        j--;
      } else if (p === 2) {
        rev.push({ w: r0 + i - 1, c: -1, sim: 0, ok: false });
        i--;
      } else {
        rev.push({ w: -1, c: c0 + j - 1, sim: 0, ok: false });
        j--;
      }
    }
    const steps = rev.reverse();

    // Another location in this region that explains the same window end about as well
    // (repeated phrases close together, e.g. refrains) → tie.
    const span = steps.filter((s) => s.c >= 0).length;
    let internalTie = false;
    for (const row of [bi - 1, bi, bi + 1]) {
      if (row < 1 || row > rows) continue;
      for (let jj = 1; jj <= cols; jj++) {
        if (Math.abs(jj - bj) < Math.max(3, span)) continue;
        if ((H[row * width + jj] as number) >= best - this.margin) internalTie = true;
      }
    }

    // Split at long runs of unaligned words (commentary between two quotes, or a skip).
    const parts: Step[][] = [];
    let curPart: Step[] = [];
    let run = 0;
    let runKind = 0;
    for (const s of steps) {
      const kind = s.c === -1 ? 2 : s.w === -1 ? 3 : 1;
      if (kind === 1) {
        run = 0;
      } else if (kind === runKind) {
        run++;
      } else {
        run = 1;
      }
      runKind = kind;
      if (run >= SPLIT_GAP) {
        parts.push(curPart);
        curPart = [];
        run = 0;
        continue;
      }
      curPart.push(s);
    }
    parts.push(curPart);

    const out: Piece[] = [];
    for (const part of parts) {
      const piece = makePiece(trimIslands(trim(part)), internalTie);
      if (piece !== null) out.push(piece);
    }
    return out;
  }

  /** Ayat of a piece, trimmed to the ayat it really quotes, and the acceptance decision. */
  private evaluate(corpus: QuranCorpus, piece: Piece): Evaluated | null {
    const counts = new Map<number, number>();
    for (const s of piece.steps) {
      if (!s.ok) continue;
      const a = corpus.wordAyah[s.c] as number;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    // Steps follow the corpus, so `counts` holds the ayat in ascending order.
    let first = -1;
    let last = -1;
    for (const [a, n] of counts) {
      // An edge ayah needs ≥ 3 matched words or all of its words: the khatib's own words that
      // happen to continue the Quran text ("… فاتقوا الله" before 26:110) must not add an ayah.
      if (n >= 3 || n >= ayahLength(corpus, a)) {
        if (first === -1) first = a;
        last = a;
      }
    }
    if (first === -1) return null;
    const lo = corpus.ayahStart[first] as number;
    const hi = corpus.ayahStart[last + 1] as number;
    const steps = trimIslands(
      trim(
        piece.steps.filter((s) => s.c === -1 || (s.c >= lo && s.c < hi)),
        (s) => s.ok && s.c >= lo && s.c < hi,
      ),
    );
    let matched = 0;
    let runLen = 0;
    let longest = 0;
    for (const s of steps) {
      if (s.ok) {
        matched++;
        runLen++;
        longest = Math.max(longest, runLen);
      } else {
        runLen = 0;
      }
    }
    const coverage = matched / (hi - lo); // ≥ 1 word: the first ayah has matched words
    const accepted =
      longest >= this.minWords &&
      (coverage >= this.minCoverage ||
        matched >= this.longMatchWords ||
        longest >= this.distinctRunWords);
    const trimmed = makePiece(steps, piece.internalTie);
    if (trimmed === null) return null;
    return { trimmed, firstAyah: first, lastAyah: last, accepted };
  }

  /** Build the QuranMatch for the part of an accepted quote that lies in `text`. */
  private toMatch(
    corpus: QuranCorpus,
    ev: Evaluated,
    offset: number,
    targetLang: string,
  ): QuranMatch | null {
    const inText = ev.trimmed.steps.filter((s) => s.ok && s.w >= offset);
    if (inText.length === 0) return null; // the whole quote lies in prevText (reported before)
    // The trimmed steps lie in the ayat firstAyah..lastAyah, in ascending order.
    const counts = new Map<number, number>();
    for (const s of inText) {
      const a = corpus.wordAyah[s.c] as number;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    let first = -1;
    let last = -1;
    const pick = (strict: boolean): void => {
      for (const [a, n] of counts) {
        if (strict && n < 3 && n < ayahLength(corpus, a)) continue;
        if (first === -1) first = a;
        last = a;
      }
    };
    pick(true);
    if (first === -1) pick(false); // only a few words of the quote spill into `text`
    const lo = corpus.ayahStart[first] as number;
    const hi = corpus.ayahStart[last + 1] as number;
    // Non-empty: the picked ayat hold matched words of `text`.
    const kept = inText.filter((s) => s.c >= lo && s.c < hi);
    const firstStep = kept[0] as Step;
    const lastStep = kept[kept.length - 1] as Step;
    const sura = corpus.sura[first] as number;
    const ref = formatRef(sura, corpus.aya[first] as number, corpus.aya[last] as number);
    const extent = (lastStep.c - firstStep.c + 1) / (hi - lo);
    // Span over the text words between the first and last kept matched word (inclusive).
    const wStart = firstStep.w;
    const wEnd = lastStep.w + 1;
    const cLen = lastStep.c - firstStep.c + 1;
    const simSum = kept.reduce((acc, s) => acc + s.sim, 0);
    return {
      ref,
      partial: extent < 0.95,
      arabic: corpus.simple.slice(first, last + 1).join(" "),
      approved: this.approvedText(ref, targetLang),
      span: { start: wStart - offset, end: wEnd - offset },
      score: Math.round((simSum / Math.max(wEnd - wStart, cLen)) * 1000) / 1000,
    };
  }
}

function ayahLength(corpus: QuranCorpus, a: number): number {
  return Math.max(1, (corpus.ayahStart[a + 1] as number) - (corpus.ayahStart[a] as number));
}

/** Drop leading/trailing steps that are not matched words (or fail `keep`). */
function trim(steps: Step[], keep: (s: Step) => boolean = (s) => s.ok): Step[] {
  let a = 0;
  let b = steps.length;
  while (a < b && !keep(steps[a] as Step)) a++;
  while (b > a && !keep(steps[b - 1] as Step)) b--;
  return steps.slice(a, b);
}

/**
 * A lone matched word at either end, cut off from the rest of the alignment by a skipped or
 * mismatched word, is no evidence of the quote: in "… أقرب للتقوى | والله سبحانه", the khatib's
 * own words after 5:8 must not pull "والله" in as "(واتقوا) الله".
 */
function trimIslands(steps: Step[]): Step[] {
  let out = steps;
  for (;;) {
    const ok: number[] = [];
    out.forEach((s, i) => {
      if (s.ok) ok.push(i);
    });
    if (ok.length < 4) return out;
    const last = ok[ok.length - 1] as number;
    const beforeLast = ok[ok.length - 2] as number;
    const first = ok[0] as number;
    const afterFirst = ok[1] as number;
    if (last - beforeLast > 1) out = trim(out.slice(0, beforeLast + 1));
    else if (afterFirst - first > 1) out = trim(out.slice(afterFirst));
    else return out;
  }
}

function makePiece(steps: Step[], internalTie: boolean): Piece | null {
  const matched = steps.filter((s) => s.ok);
  const first = matched[0];
  const last = matched[matched.length - 1];
  if (first === undefined || last === undefined || matched.length < 3) return null;
  let score = 0;
  for (const s of steps) {
    if (s.ok) score += MATCH_BONUS + s.sim;
    else if (s.w >= 0 && s.c >= 0) score += MISMATCH;
    else score += GAP;
  }
  return {
    steps,
    score,
    wSet: new Set(matched.map((s) => s.w)),
    wStart: first.w,
    wEnd: last.w + 1,
    cStart: first.c,
    cEnd: last.c + 1,
    internalTie,
  };
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

function shared(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** The same location found via two regions → keep the better alignment. */
function dedupe(list: Evaluated[]): Evaluated[] {
  const sorted = [...list].sort((a, b) => b.trimmed.score - a.trimmed.score);
  const out: Evaluated[] = [];
  for (const e of sorted) {
    const dup = out.some(
      (o) =>
        overlaps(o.trimmed.cStart, o.trimmed.cEnd, e.trimmed.cStart, e.trimmed.cEnd) &&
        overlaps(o.trimmed.wStart, o.trimmed.wEnd, e.trimmed.wStart, e.trimmed.wEnd),
    );
    if (!dup) out.push(e);
  }
  return out;
}

/** Create a matcher from the resolved data paths and `config.quran`. Never throws. */
export function loadQuranMatcher(
  paths: QuranDataPaths,
  cfg: Config["quran"],
  opts: { onProblem?: (message: string) => void } = {},
): QuranMatcher {
  const options: QuranMatcherOptions = {
    minWords: cfg.minWords,
    minCoverage: cfg.minCoverage,
    stoplist: cfg.stoplist,
  };
  if (!cfg.enabled) return new QuranMatcher(null, options);
  const loaded = loadCorpus({
    textFile: paths.quranTextFile,
    uthmaniFile: paths.quranUthmaniFile,
    translations: paths.quranTranslations,
  });
  for (const p of loaded.problems) opts.onProblem?.(p);
  return new QuranMatcher(loaded.corpus, options);
}
