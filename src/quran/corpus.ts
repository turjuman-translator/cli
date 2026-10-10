// Tanzil Quran corpus: the "simple-clean" text for matching, the Uthmani text
// for display and the approved translations (one line per ayah). Normalization is internal and
// only used for matching; display text is served verbatim, except that the basmala Tanzil
// prefixes to the first ayah of every sura (but 1 and 9) is not part of that ayah and is dropped.
import { existsSync, readFileSync } from "node:fs";
import { arabicWords, matchWords } from "../text/arabic.js";
import { applyErrata } from "./errata.js";

export const AYAH_COUNT = 6236;
export const SURA_COUNT = 114;

const BASMALA = ["بسم", "الله", "الرحمن", "الرحيم"];

export interface TanzilLine {
  sura: number;
  aya: number;
  text: string;
}

/** Parse Tanzil "sura|aya|text" lines; comment ("#…") and blank lines are skipped. */
export function parseTanzilText(content: string): TanzilLine[] {
  const out: TanzilLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, "");
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = /^(\d{1,3})\|(\d{1,3})\|(.*)$/.exec(line);
    if (m === null) throw new Error(`unexpected line (want "sura|aya|text"): ${line.slice(0, 40)}`);
    out.push({ sura: Number(m[1]), aya: Number(m[2]), text: (m[3] as string).trim() });
  }
  return out;
}

/**
 * Parse a Tanzil translation file into one text per ayah (mushaf order). Accepts both Tanzil
 * formats: "Text" (one line per ayah, then a "#" footer) and "Text (with aya numbers)".
 */
export function parseTranslation(
  content: string,
  ayahIndex: (sura: number, aya: number) => number,
) {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  const footer = lines.findIndex((l) => l.startsWith("#"));
  const data = (footer === -1 ? lines : lines.slice(0, footer)).map((l) => l.trim());
  while (data.length > 0 && data[data.length - 1] === "") data.pop();
  const out: string[] = new Array<string>(AYAH_COUNT).fill("");
  const numbered = data.length > 0 && data.every((l) => l === "" || /^\d{1,3}\|\d{1,3}\|/.test(l));
  if (numbered) {
    let n = 0;
    for (const l of data) {
      if (l === "") continue;
      const m = /^(\d{1,3})\|(\d{1,3})\|(.*)$/.exec(l);
      const idx = m === null ? -1 : ayahIndex(Number(m[1]), Number(m[2]));
      if (m === null || idx < 0) throw new Error(`bad translation line: ${l.slice(0, 40)}`);
      out[idx] = (m[3] as string).trim();
      n++;
    }
    if (n !== AYAH_COUNT) throw new Error(`expected ${AYAH_COUNT} ayat, found ${n}`);
    return out;
  }
  const rows = data.length === AYAH_COUNT ? data : data.filter((l) => l !== "");
  if (rows.length !== AYAH_COUNT)
    throw new Error(`expected ${AYAH_COUNT} lines, found ${rows.length}`);
  rows.forEach((l, i) => {
    out[i] = l;
  });
  return out;
}

/**
 * Matching form of a word: `matchWords` folding (plus ASR variants) and dropping
 * the hamza on the line, which recognizers often omit (السماء / السما, شيء / شي).
 */
export function matchForm(word: string): string {
  const w = word.replace(/ء/g, "");
  return w === "" ? word : w;
}

/** Words of a text in matching form. Same count/order as `arabicWords(text)`. */
export function corpusWords(text: string): string[] {
  return matchWords(text).map(matchForm);
}

/**
 * Retrieval key of a word (3-gram index only; alignment uses `matchForm`): additionally drops a
 * leading conjunction و/ف and long-vowel alefs inside the word, so that recognizer variants
 * (ومن/من, الرحمان/الرحمن) still share 3-grams.
 */
export function keyForm(word: string): string {
  let w = word.length > 2 && /^[وف]/.test(word) ? word.slice(1) : word;
  w = w.length > 1 ? w.charAt(0) + w.slice(1).replace(/ا/g, "") : w;
  return w === "" ? word : w;
}

// --- translation sanity -------------------------------------------------------------------------

/** Legitimate Dutch words the OCR heuristics below would otherwise flag. */
const NL_LEGIT = new Set([
  "excuus",
  "dicteren",
  "gedicteerd",
  "succes",
  "correct",
  "correcte",
  "excellentie",
  "rancune",
  "extract",
  "respect",
  "respecteert",
  "gefabriceerd",
  "direct",
  "secte",
  "secten",
  "oceaan",
  "insecten",
  "contract",
  "transactie",
  "hypocrieten",
  "hypocriet",
  "discipelen",
  "asceet",
  "dakconstructies",
  "beoordelingscode",
  "jacob",
  "jacobs",
  "rebecca",
  "becca",
]);

/**
 * True when a translation line is visibly corrupt and must not be shown verbatim as "approved":
 * editor notes left in the data (e.g. Tanzil nl.siregar 16:7 and 16:97 contain "THIS TEXT HAS
 * BEEN AUTOMATICALLY GENERATED (OCR) …"), mixed-case words and, for Dutch, typical OCR
 * confusions (e→c: "dc", "hct", "gcloven"; "ii": "aaiibidden"). Heuristic: a flagged ayah simply
 * gets no approved text, so the live translation of the recitation is quoted instead.
 */
export function isSuspectTranslation(text: string, lang: string): boolean {
  if (/\bOCR\b/.test(text)) return true;
  if (/\b\p{Lu}{3,}\b(?:[^\p{L}]+\b\p{Lu}{2,}\b){2,}/u.test(text)) return true; // ALL-CAPS runs
  for (const tok of text.split(/[^\p{L}]+/u)) {
    if (tok.length < 2) continue;
    if (/\p{Ll}\p{Lu}/u.test(tok)) return true; // "zÜij"
    if (lang !== "nl") continue;
    const w = tok.toLowerCase();
    if (NL_LEGIT.has(w)) continue;
    if (/^(dc|hct|ccn|cn|tc|bcn)$/.test(w)) return true;
    if (/\p{Ll}c(?![hk])/u.test(w)) return true; // c inside a word not as ch/ck: "bcstraffing"
    if (/ii/.test(w) && !/[aeou]iing/.test(w)) return true; // "aaiibidden" (not "voltooiing")
    if (/yw/.test(w)) return true; // "Marywn"
  }
  return false;
}

// --- corpus -------------------------------------------------------------------------------------

export interface QuranCorpusFiles {
  /** Tanzil simple-clean, "sura|aya|text" (required). */
  textFile: string;
  /** Tanzil Uthmani, "sura|aya|text" (display; optional). */
  uthmaniFile?: string;
  /** lang → translation file (one line per ayah). */
  translations?: Record<string, string>;
}

export interface QuranCorpus {
  /** Ayah count per sura, index 0 = sura 1. */
  readonly suraSizes: readonly number[];
  /** Index of the first ayah of each sura, index 0 = sura 1. */
  readonly suraFirst: readonly number[];
  /** Per ayah index (mushaf order): sura and aya numbers. */
  readonly sura: Uint8Array;
  readonly aya: Uint16Array;
  /** Simple-clean text per ayah (basmala prefix dropped). */
  readonly simple: readonly string[];
  /** Uthmani text per ayah (basmala prefix dropped), or null when the file is missing. */
  readonly uthmani: readonly string[] | null;
  /** lang → approved translation per ayah (null = missing or suspect). */
  readonly translations: ReadonlyMap<string, readonly (string | null)[]>;
  /** The whole Quran as one stream of words in matching form. */
  readonly words: readonly string[];
  /** Global word position → ayah index. */
  readonly wordAyah: Int32Array;
  /** First global word position of each ayah (length AYAH_COUNT + 1, last = words.length). */
  readonly ayahStart: Int32Array;
  /** Ayah index of (sura, aya), or -1. */
  ayahIndex(sura: number, aya: number): number;
}

export interface LoadedCorpus {
  corpus: QuranCorpus | null;
  /** Problems that made loading fail (corpus = null) or degraded it (missing translations). */
  problems: string[];
  /** lang → number of ayat whose approved translation was rejected as suspect. */
  suspect: Record<string, number>;
}

/** Drop the basmala Tanzil prefixes to the first ayah of suras 2–114 (but 9). */
function stripBasmala(sura: number, aya: number, text: string): string {
  if (aya !== 1 || sura === 1 || sura === 9) return text;
  const tokens = text.split(/\s+/);
  const head = arabicWords(tokens.slice(0, 4).join(" "));
  if (head.length === 4 && head.every((w, i) => w === BASMALA[i])) {
    return tokens.slice(4).join(" ");
  }
  return text;
}

function validate(lines: TanzilLine[], what: string): number[] {
  if (lines.length !== AYAH_COUNT) {
    throw new Error(`${what}: expected ${AYAH_COUNT} ayat, found ${lines.length}`);
  }
  const sizes: number[] = [];
  let prevSura = 0;
  let prevAya = 0;
  for (const l of lines) {
    if (l.sura === prevSura && l.aya === prevAya + 1) {
      prevAya = l.aya;
    } else if (l.sura === prevSura + 1 && l.aya === 1) {
      if (prevSura > 0) sizes.push(prevAya);
      prevSura = l.sura;
      prevAya = 1;
    } else {
      throw new Error(`${what}: out of order at ${l.sura}:${l.aya}`);
    }
  }
  sizes.push(prevAya);
  if (sizes.length !== SURA_COUNT) throw new Error(`${what}: expected ${SURA_COUNT} suras`);
  return sizes;
}

/** Build a corpus from already-read file contents (for tests and the loader). */
export function buildCorpus(
  simpleContent: string,
  uthmaniContent: string | null,
  translationContents: Record<string, string> = {},
): LoadedCorpus {
  const problems: string[] = [];
  const suspect: Record<string, number> = {};
  const simpleLines = parseTanzilText(simpleContent);
  const suraSizes = validate(simpleLines, "simple-clean text");
  const suraFirst: number[] = [];
  let acc = 0;
  for (const n of suraSizes) {
    suraFirst.push(acc);
    acc += n;
  }
  const ayahIndex = (s: number, a: number): number => {
    const first = suraFirst[s - 1];
    const size = suraSizes[s - 1];
    if (first === undefined || size === undefined || a < 1 || a > size) return -1;
    return first + a - 1;
  };

  const sura = new Uint8Array(AYAH_COUNT);
  const aya = new Uint16Array(AYAH_COUNT);
  const simple: string[] = [];
  const words: string[] = [];
  const wordAyahList: number[] = [];
  const ayahStart = new Int32Array(AYAH_COUNT + 1);
  simpleLines.forEach((l, i) => {
    sura[i] = l.sura;
    aya[i] = l.aya;
    const text = stripBasmala(l.sura, l.aya, l.text);
    simple.push(text);
    ayahStart[i] = words.length;
    for (const w of corpusWords(text)) {
      words.push(w);
      wordAyahList.push(i);
    }
  });
  ayahStart[AYAH_COUNT] = words.length;

  let uthmani: string[] | null = null;
  if (uthmaniContent !== null) {
    try {
      const lines = parseTanzilText(uthmaniContent);
      validate(lines, "Uthmani text");
      uthmani = lines.map((l) => stripBasmala(l.sura, l.aya, l.text));
    } catch (err) {
      problems.push(`Uthmani text unusable: ${(err as Error).message}`);
    }
  }

  const translations = new Map<string, (string | null)[]>();
  for (const [lang, content] of Object.entries(translationContents)) {
    try {
      const rows = parseTranslation(content, ayahIndex);
      let bad = 0;
      translations.set(
        lang,
        rows.map((raw, i) => {
          if (raw === "") return null;
          const t = applyErrata(lang, `${sura[i] as number}:${aya[i] as number}`, raw);
          if (isSuspectTranslation(t, lang)) {
            bad++;
            return null;
          }
          return t;
        }),
      );
      suspect[lang] = bad;
    } catch (err) {
      problems.push(`translation "${lang}" unusable: ${(err as Error).message}`);
    }
  }

  const corpus: QuranCorpus = {
    suraSizes,
    suraFirst,
    sura,
    aya,
    simple,
    uthmani,
    translations,
    words,
    wordAyah: Int32Array.from(wordAyahList),
    ayahStart,
    ayahIndex,
  };
  return { corpus, problems, suspect };
}

/** Read the Tanzil files from disk. Never throws: a missing/broken main text gives corpus = null. */
export function loadCorpus(files: QuranCorpusFiles): LoadedCorpus {
  const read = (file: string): string | null =>
    existsSync(file) ? readFileSync(file, "utf8") : null;
  try {
    const simple = read(files.textFile);
    if (simple === null) {
      return { corpus: null, problems: [`Quran text not found: ${files.textFile}`], suspect: {} };
    }
    const uthmaniFile = files.uthmaniFile;
    const uthmani = uthmaniFile === undefined ? null : read(uthmaniFile);
    const extra: string[] = [];
    if (uthmaniFile !== undefined && uthmani === null) {
      extra.push(`Uthmani text not found: ${uthmaniFile}`);
    }
    const contents: Record<string, string> = {};
    for (const [lang, file] of Object.entries(files.translations ?? {})) {
      const c = read(file);
      if (c === null) extra.push(`translation "${lang}" not found: ${file}`);
      else contents[lang] = c;
    }
    const loaded = buildCorpus(simple, uthmani, contents);
    return { ...loaded, problems: [...extra, ...loaded.problems] };
  } catch (err) {
    return {
      corpus: null,
      problems: [`Quran text unusable: ${(err as Error).message}`],
      suspect: {},
    };
  }
}
