// Prayer-call marker phrases and fuzzy phrase matching.
//
// Matching runs on the words of src/text/arabic.ts (normalized, ASR-folded) with sung elongations
// collapsed (اكبااار → اكبار, اللللاه → اللاه) and one-letter tokens (a split-off و) ignored.
// A phrase matches a window of whole words (up to two words shorter or longer than the phrase)
// when either similarity is ≥ 0.8:
//   - letters, spaces removed (1 − Levenshtein / longer length): tolerant of merged and split words
//     and misspellings ("اللهو اكبر", "الله وأكبر", "قد قامتصلاة");
//   - a word-level alignment (1 − edit cost / longer word count, a substitution costing
//     1 − the letter similarity of the two words): tolerant of a dropped word in long phrases
//     ("أشهد أن محمدا رسول" without "الله").
// Overlapping candidates are resolved by weighted interval scheduling (similarity × phrase words),
// so "أشهد أن لا إله إلا الله" is one SHAHADA1, not a TAHLIL plus two stray words.
//
// Soniox cuts the sung Athan mid-phrase ("الله." | "أكبر، الله." | "أكبر." | "أشهد أن لا." | "إله."),
// so the formula share also counts words of the call's vocabulary (الله اكبر اشهد ان لا اله الا محمد
// رسول حي على الصلاه الفلاح قد قامت خير من النوم, with sung spellings): a fragment is formula-only
// without a whole phrase in it. Phrase markers (`markers`) still need whole phrases; the detector
// finds phrases cut across segments by analyzing the joined text of a formula run.
import { foldAsrVariants, matchWords } from "../text/arabic.js";
import type { MarkerId } from "./types.js";

/** Prayer formulas suppressed during Salah, besides the takbir (TAKBIR). */
export type SalahFormulaId = "SAMI" | "RABBANA" | "TASLEEM" | "TASLEEM_SHORT" | "AMIN";
/** Al-Fatiha verses 2–7 (7 in two halves), and the basmala (no evidence of a prayer by itself). */
export type FatihaId = "BASMALA" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7A" | "F7B";
export type PhraseId = MarkerId | SalahFormulaId | FatihaId;
/** "athan": the prayer-call marker phrases. "salah": takbir + the Salah formulas. */
export type PhraseSet = "athan" | "salah";

/** Fuzzy ≥ 0.8 per phrase. */
export const PHRASE_MIN_SIMILARITY = 0.8;
/** A segment is formula-only when ≥ 80 % of its words belong to marker phrases. */
export const FORMULA_ONLY_SHARE = 0.8;

export const MARKER_IDS: readonly MarkerId[] = [
  "TAKBIR",
  "SHAHADA1",
  "SHAHADA2",
  "HAYYA_SALAH",
  "HAYYA_FALAH",
  "QAD_QAMAT",
  "FAJR",
  "TAHLIL",
];

/** A phrase's forms: the canonical one first, then variants. */
type Forms = readonly [string, ...string[]];

/** Canonical form first; further entries are common sung renderings (contracted article). */
const MARKER_FORMS: Readonly<Record<MarkerId, Forms>> = {
  TAKBIR: ["الله أكبر"],
  SHAHADA1: ["أشهد أن لا إله إلا الله"],
  SHAHADA2: ["أشهد أن محمدا رسول الله"],
  HAYYA_SALAH: ["حي على الصلاة", "حي علصلاة"],
  HAYYA_FALAH: ["حي على الفلاح", "حي علفلاح"],
  QAD_QAMAT: ["قد قامت الصلاة"],
  FAJR: ["الصلاة خير من النوم"],
  TAHLIL: ["لا إله إلا الله"],
};

const SALAH_FORMS: Readonly<Record<SalahFormulaId, Forms>> = {
  SAMI: ["سمع الله لمن حمده"],
  RABBANA: ["ربنا ولك الحمد"],
  TASLEEM: ["السلام عليكم ورحمة الله"],
  TASLEEM_SHORT: ["السلام عليكم"],
  AMIN: ["آمين"],
};
const SALAH_IDS: readonly SalahFormulaId[] = [
  "SAMI",
  "RABBANA",
  "TASLEEM",
  "TASLEEM_SHORT",
  "AMIN",
];

/** Canonical marker phrases (unnormalized), e.g. for docs and tests. */
export const MARKER_PHRASES: Readonly<Record<MarkerId, string>> = Object.fromEntries(
  MARKER_IDS.map((id) => [id, MARKER_FORMS[id][0]]),
) as Record<MarkerId, string>;

/**
 * Vocabulary of the call (fragments). Words of ≥ 4 letters also match sung/ASR spellings (letter
 * similarity ≥ VOCAB_MIN_SIMILARITY); shorter ones only exactly or as listed (else "له" would pass
 * for "إله"). A leading conjunction و is ignored ("وأشهد", "ولا").
 */
const ATHAN_VOCAB =
  "الله أكبر أشهد أن لا إله إلا محمد رسول حي على الصلاة الفلاح قد قامت خير من النوم";
const ATHAN_VOCAB_SPELLINGS = "علا عل حيا إلاه قامة الصلا السلاة الفلا صلاة";
/** Salah formula words; not الحمد / ربنا (Al-Fatiha's "الحمد لله" must never be suppressed). */
const SALAH_VOCAB = "الله أكبر سمع لمن حمده ولك السلام عليكم ورحمة آمين";
const VOCAB_FUZZY_MIN_LETTERS = 4;
/** Stricter than phrases: "رسوله" (0.8) is not "رسول", "اللهم" (0.8) is not "الله". */
const VOCAB_MIN_SIMILARITY = 0.85;

/** Longest phrase head/tail (in words) counted at a segment edge. */
const MAX_FRAGMENT_WORDS = 4;
/**
 * Word-level alignment only forgives near-identical words: below this letter similarity a
 * substituted word costs a full word (else "قد قامت الساعة" would pass for "قد قامت الصلاة").
 */
const WORD_SUB_FLOOR = 0.75;

export interface PhraseMatch {
  id: PhraseId;
  /** Word span [start, end) in `FormulaAnalysis.words`. */
  start: number;
  end: number;
  /** Similarity 0..1 (≥ PHRASE_MIN_SIMILARITY). */
  sim: number;
}

export interface FormulaAnalysis {
  /** Matching words: normalized, ASR-folded, elongation-collapsed; one-letter tokens dropped. */
  words: string[];
  /** Whole-phrase matches, non-overlapping, in text order. */
  matches: PhraseMatch[];
  /** Words covered by matches, a phrase cut off at either edge, or the call's vocabulary. */
  covered: number;
  /** covered / words (0 for an empty text). */
  share: number;
  /** share ≥ FORMULA_ONLY_SHARE. */
  formulaOnly: boolean;
}

interface Phrase {
  id: PhraseId;
  words: readonly string[];
  letters: string;
  /** Word count of the canonical form: a match's weight (variants weigh the same). */
  size: number;
  canonical: boolean;
}

interface Candidate extends PhraseMatch {
  weight: number;
}

function collapseElongation(word: string): string {
  return word.replace(/([اوي])\1+/g, "$1").replace(/(.)\1{2,}/g, "$1$1");
}

/** The words formula matching runs on (see the file header). */
export function formulaWords(text: string): string[] {
  const out: string[] = [];
  for (const w of matchWords(text)) {
    const f = foldAsrVariants(collapseElongation(w));
    if (f.length >= 2) out.push(f);
  }
  return out;
}

function compile<Id extends PhraseId>(
  forms: Readonly<Record<Id, Forms>>,
  ids: readonly Id[],
): Phrase[] {
  const out: Phrase[] = [];
  for (const id of ids) {
    const all = forms[id];
    const size = formulaWords(all[0]).length;
    all.forEach((form, i) => {
      const words = formulaWords(form);
      out.push({ id, words, letters: words.join(""), size, canonical: i === 0 });
    });
  }
  return out;
}

interface Vocab {
  exact: ReadonlySet<string>;
  fuzzy: readonly string[];
}

function compileVocab(words: string, spellings: string): Vocab {
  const base = formulaWords(words);
  return {
    exact: new Set([...base, ...formulaWords(spellings)]),
    fuzzy: base.filter((w) => w.length >= VOCAB_FUZZY_MIN_LETTERS),
  };
}

const ATHAN_VOCAB_SET = compileVocab(ATHAN_VOCAB, ATHAN_VOCAB_SPELLINGS);
const SALAH_VOCAB_SET = compileVocab(SALAH_VOCAB, "");

const ATHAN_PHRASES: readonly Phrase[] = compile(MARKER_FORMS, MARKER_IDS);
/** Al-Fatiha: the prayer (Salah) has started. The basmala opens khutbahs too. */
const FATIHA_FORMS: Readonly<Record<FatihaId, Forms>> = {
  BASMALA: ["بسم الله الرحمن الرحيم"],
  F2: ["الحمد لله رب العالمين"],
  F3: ["الرحمن الرحيم"],
  F4: ["مالك يوم الدين", "ملك يوم الدين"],
  F5: ["إياك نعبد وإياك نستعين"],
  F6: ["اهدنا الصراط المستقيم"],
  F7A: ["صراط الذين أنعمت عليهم"],
  F7B: ["غير المغضوب عليهم ولا الضالين"],
};
const FATIHA_IDS: readonly FatihaId[] = ["BASMALA", "F2", "F3", "F4", "F5", "F6", "F7A", "F7B"];
const FATIHA_PHRASES: readonly Phrase[] = compile(FATIHA_FORMS, FATIHA_IDS);

const SALAH_PHRASES: readonly Phrase[] = [
  ...ATHAN_PHRASES.filter((p) => p.id === "TAKBIR"),
  ...compile(SALAH_FORMS, SALAH_IDS),
];

/** Long-vowel letters (and hamza): sung, elongated or swallowed, so editing them costs half. */
const VOWELISH: ReadonlySet<number> = new Set([0x0627, 0x0648, 0x064a, 0x0621]); // ا و ي ء

function vowelCost(code: number): number {
  return VOWELISH.has(code) ? 0.5 : 1;
}

function unitCost(): number {
  return 1;
}

/** Levenshtein distance; with `vowels`, inserting, deleting or swapping long-vowel letters costs 0.5. */
function levenshtein(a: string, b: string, vowels: boolean): number {
  if (a === b) return 0;
  const editCost = vowels ? vowelCost : unitCost;
  // Every index below is in bounds (rows have b.length + 1 cells): the casts only drop `undefined`.
  let prev: number[] = new Array<number>(b.length + 1).fill(0);
  let cur: number[] = new Array<number>(b.length + 1).fill(0);
  for (let j = 1; j <= b.length; j++) {
    prev[j] = (prev[j - 1] as number) + editCost(b.charCodeAt(j - 1));
  }
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    const del = editCost(ca);
    cur[0] = (prev[0] as number) + del;
    for (let j = 1; j <= b.length; j++) {
      const cb = b.charCodeAt(j - 1);
      const ins = editCost(cb);
      const swap = ca === cb ? 0 : del < 1 && ins < 1 ? 0.5 : 1;
      cur[j] = Math.min(
        (prev[j - 1] as number) + swap,
        (prev[j] as number) + del,
        (cur[j - 1] as number) + ins,
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] as number;
}

/**
 * 1 − Levenshtein / longer length. `vowels` (default) discounts long-vowel edits, for a window with
 * the phrase's word count; when words were dropped or added, a whole missing word must not come
 * cheap ("وأن محمدا رسول الله" is not "أشهد أن محمدا رسول الله").
 */
export function letterSimilarity(a: string, b: string, vowels = true): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - levenshtein(a, b, vowels) / longer;
}

/** Word-level alignment similarity (insert/delete a word: 1; substitute: 1 − letter similarity). */
function wordSimilarity(win: readonly string[], phrase: readonly string[]): number {
  // At least 1: two empty lists are identical (distance 0 → similarity 1).
  const longer = Math.max(1, win.length, phrase.length);
  // Every index below is in bounds: the casts only drop `undefined`.
  let prev: number[] = Array.from({ length: phrase.length + 1 }, (_, j) => j);
  for (let i = 1; i <= win.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= phrase.length; j++) {
      const s = letterSimilarity(win[i - 1] as string, phrase[j - 1] as string);
      const sub = (prev[j - 1] as number) + (s >= WORD_SUB_FLOOR ? 1 - s : 1);
      cur[j] = Math.min(sub, (prev[j] as number) + 1, (cur[j - 1] as number) + 1);
    }
    prev = cur;
  }
  return 1 - (prev[phrase.length] as number) / longer;
}

function findCandidates(words: readonly string[], phrases: readonly Phrase[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of phrases) {
    const minLen = Math.max(1, p.words.length - 2);
    const maxLen = p.words.length + 2;
    for (let start = 0; start < words.length; start++) {
      for (let len = minLen; len <= maxLen && start + len <= words.length; len++) {
        const win = words.slice(start, start + len);
        const letters = letterSimilarity(win.join(""), p.letters, len === p.words.length);
        const sim = Math.max(letters, wordSimilarity(win, p.words));
        if (sim >= PHRASE_MIN_SIMILARITY) {
          out.push({ id: p.id, start, end: start + len, sim, weight: sim * p.size });
        }
      }
    }
  }
  return out;
}

/** Non-overlapping candidates with the highest total weight (weighted interval scheduling). */
function selectMatches(n: number, cands: readonly Candidate[]): PhraseMatch[] {
  const byStart: Candidate[][] = Array.from({ length: n }, () => []);
  for (const c of cands) byStart[c.start]?.push(c);
  const best: number[] = new Array<number>(n + 1).fill(0);
  const choice: Array<Candidate | null> = new Array<Candidate | null>(n + 1).fill(null);
  for (let i = n - 1; i >= 0; i--) {
    // In bounds (i < n, c.end ≤ n): the casts only drop `undefined`.
    let top = best[i + 1] as number;
    let pick: Candidate | null = null;
    for (const c of byStart[i] as Candidate[]) {
      const w = c.weight + (best[c.end] as number);
      if (w > top + 1e-9) {
        top = w;
        pick = c;
      }
    }
    best[i] = top;
    choice[i] = pick;
  }
  const out: PhraseMatch[] = [];
  for (let i = 0; i < n; ) {
    const c = choice[i];
    if (c === null || c === undefined) {
      i++;
      continue;
    }
    out.push({ id: c.id, start: c.start, end: c.end, sim: c.sim });
    i = c.end;
  }
  return out;
}

function fragmentOf(
  letters: string,
  k: number,
  side: "head" | "tail",
  phrases: readonly Phrase[],
): boolean {
  if (letters.length < 3) return false;
  for (const p of phrases) {
    if (!p.canonical || p.words.length <= k) continue;
    const part = side === "head" ? p.words.slice(0, k) : p.words.slice(p.words.length - k);
    if (letterSimilarity(letters, part.join("")) >= PHRASE_MIN_SIMILARITY) return true;
  }
  return false;
}

/**
 * Marks words at the segment edges that belong to a phrase cut by the segmentation ("الله أكبر
 * الله" | "أكبر أشهد …"): the tail of a phrase at the start, the head of one at the end. Only next
 * to whole matches (at least one).
 */
function markEdgeFragments(
  words: readonly string[],
  matches: readonly PhraseMatch[],
  phrases: readonly Phrase[],
  covered: boolean[],
): void {
  const first = (matches[0] as PhraseMatch).start;
  const last = (matches[matches.length - 1] as PhraseMatch).end;
  for (let k = Math.min(first, MAX_FRAGMENT_WORDS); k >= 1; k--) {
    if (fragmentOf(words.slice(0, k).join(""), k, "tail", phrases)) {
      covered.fill(true, 0, k);
      break;
    }
  }
  for (let k = Math.min(words.length - last, MAX_FRAGMENT_WORDS); k >= 1; k--) {
    if (fragmentOf(words.slice(words.length - k).join(""), k, "head", phrases)) {
      covered.fill(true, words.length - k, words.length);
      break;
    }
  }
}

function inVocab(word: string, vocab: Vocab): boolean {
  const forms = word.length > 2 && word.startsWith("و") ? [word, word.slice(1)] : [word];
  for (const f of forms) {
    if (vocab.exact.has(f)) return true;
    for (const v of vocab.fuzzy) if (letterSimilarity(f, v) >= VOCAB_MIN_SIMILARITY) return true;
  }
  return false;
}

/** Phrase matches and the formula share of a text. */
export function analyzeFormulas(text: string, set: PhraseSet = "athan"): FormulaAnalysis {
  const words = formulaWords(text);
  const phrases = set === "athan" ? ATHAN_PHRASES : SALAH_PHRASES;
  const vocab = set === "athan" ? ATHAN_VOCAB_SET : SALAH_VOCAB_SET;
  const matches = selectMatches(words.length, findCandidates(words, phrases));
  const cov: boolean[] = new Array<boolean>(words.length).fill(false);
  for (const m of matches) cov.fill(true, m.start, m.end);
  if (matches.length > 0) markEdgeFragments(words, matches, phrases, cov);
  words.forEach((w, i) => {
    if (cov[i] !== true && inVocab(w, vocab)) cov[i] = true;
  });
  const covered = cov.filter((c) => c).length;
  const share = words.length === 0 ? 0 : covered / words.length;
  return {
    words,
    matches,
    covered,
    share,
    formulaOnly: words.length > 0 && share >= FORMULA_ONLY_SHARE,
  };
}

const MARKER_ID_SET: ReadonlySet<PhraseId> = new Set<PhraseId>(MARKER_IDS);

export function isMarkerId(id: PhraseId): id is MarkerId {
  return MARKER_ID_SET.has(id);
}

/** Marker occurrences of an analysis, in spoken order (repeats included). */
export function markerSequence(a: FormulaAnalysis): MarkerId[] {
  const out: MarkerId[] = [];
  for (const m of a.matches) if (isMarkerId(m.id)) out.push(m.id);
  return out;
}

/** Markers found in a text (fuzzy ≥ 0.8 per phrase), each once, in order of first occurrence. */
export function markers(text: string): MarkerId[] {
  return [...new Set(markerSequence(analyzeFormulas(text, "athan")))];
}

/** Fraction of the words that belong to marker phrases or the call's vocabulary. */
export function formulaShare(text: string): number {
  return analyzeFormulas(text, "athan").share;
}

/** Formula-only: ≥ 80 % of the words belong to marker phrases (or the call's vocabulary). */
export function isFormulaOnly(text: string): boolean {
  return analyzeFormulas(text, "athan").formulaOnly;
}

/**
 * Distinct Al-Fatiha verses (2–7) recited in a text, e.g. ["F2", "F3"]. The basmala is matched (so
 * its "الرحمن الرحيم" is not taken for verse 3) but not returned: khutbahs open with it too.
 */
export function fatihaVerses(text: string): string[] {
  const words = formulaWords(text);
  const ids = selectMatches(words.length, findCandidates(words, FATIHA_PHRASES)).map((m) => m.id);
  return [...new Set(ids.filter((id) => id !== "BASMALA"))];
}

/** Tasleem phrases in a Salah-set analysis ("السلام عليكم ورحمة الله", or its short form). */
export function countTasleem(a: FormulaAnalysis): number {
  return a.matches.filter((m) => m.id === "TASLEEM" || m.id === "TASLEEM_SHORT").length;
}
