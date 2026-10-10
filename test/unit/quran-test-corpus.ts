// A synthetic Tanzil corpus for the Quran tests: every one of the 6,236 ayat exists (with the real
// sura sizes, so refs like "5:8" are real positions), but only the ayat a test names have text;
// the others are empty. Matching then runs over a few verses instead of the whole Quran.
import { buildCorpus, type LoadedCorpus, type QuranCorpus } from "../../src/quran/corpus.js";

/** Ayat per sura (Hafs), index 0 = sura 1; 114 suras, 6,236 ayat. */
export const SURA_SIZES: readonly number[] = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135, 112,
  78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37,
  35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52,
  44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8,
  8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

export interface TestAyah {
  /** Simple-clean text (what the matcher aligns to). */
  simple: string;
  /** Uthmani text (display); defaults to `simple`. */
  uthmani?: string;
  /** lang → approved translation. */
  translations?: Record<string, string>;
}

export interface TanzilContents {
  simple: string;
  uthmani: string;
  /** lang → translation file in the numbered "sura|aya|text" format. */
  translations: Record<string, string>;
}

/** Every "sura:aya" ref in mushaf order. */
export function allRefs(): string[] {
  const out: string[] = [];
  SURA_SIZES.forEach((size, s) => {
    for (let a = 1; a <= size; a++) out.push(`${s + 1}:${a}`);
  });
  return out;
}

/** Tanzil file contents with the given ayat filled in ("sura:aya" → texts). */
export function tanzilContents(ayat: Record<string, TestAyah>): TanzilContents {
  const langs = new Set<string>();
  for (const a of Object.values(ayat))
    for (const l of Object.keys(a.translations ?? {})) langs.add(l);
  const simple: string[] = [];
  const uthmani: string[] = [];
  const translations: Record<string, string[]> = {};
  for (const l of langs) translations[l] = [];
  for (const ref of allRefs()) {
    const [s, a] = ref.split(":");
    const ayah = ayat[ref];
    simple.push(`${s}|${a}|${ayah?.simple ?? ""}`);
    uthmani.push(`${s}|${a}|${ayah?.uthmani ?? ayah?.simple ?? ""}`);
    for (const l of langs) translations[l]?.push(`${s}|${a}|${ayah?.translations?.[l] ?? ""}`);
  }
  return {
    simple: `${simple.join("\n")}\n`,
    uthmani: `${uthmani.join("\n")}\n`,
    translations: Object.fromEntries(
      Object.entries(translations).map(([l, rows]) => [l, `${rows.join("\n")}\n`]),
    ),
  };
}

/** buildCorpus() over the synthetic files. */
export function loadTestCorpus(
  ayat: Record<string, TestAyah>,
  opts: { uthmani?: boolean } = {},
): LoadedCorpus {
  const c = tanzilContents(ayat);
  return buildCorpus(c.simple, opts.uthmani === false ? null : c.uthmani, c.translations);
}

/** The corpus itself (throws when the synthetic files did not load). */
export function testCorpus(
  ayat: Record<string, TestAyah>,
  opts: { uthmani?: boolean } = {},
): QuranCorpus {
  const loaded = loadTestCorpus(ayat, opts);
  if (loaded.corpus === null) throw new Error(loaded.problems.join("; "));
  return loaded.corpus;
}
