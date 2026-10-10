import { describe, expect, it } from "vitest";
import {
  analyzeFormulas,
  countTasleem,
  FORMULA_ONLY_SHARE,
  fatihaVerses,
  formulaShare,
  formulaWords,
  isFormulaOnly,
  isMarkerId,
  letterSimilarity,
  MARKER_IDS,
  MARKER_PHRASES,
  markerSequence,
  markers,
} from "../../src/events/markers.js";

describe("formulaWords", () => {
  it("normalizes, collapses sung elongations and drops one-letter tokens", () => {
    expect(formulaWords("اللّهُ أَكْبَرْ")).toEqual(["الله", "اكبر"]);
    expect(formulaWords("اكبااار اللللاه")).toEqual(["اكبار", "اللاه"]);
    // A split-off conjunction "و" is no word.
    expect(formulaWords("و الله")).toEqual(["الله"]);
    expect(formulaWords("")).toEqual([]);
  });
});

describe("letterSimilarity", () => {
  it("is 1 for identical words, also for two empty strings", () => {
    expect(letterSimilarity("", "")).toBe(1);
    expect(letterSimilarity("الله", "الله")).toBe(1);
  });

  it("is 1 − distance / longer length", () => {
    expect(letterSimilarity("abcd", "abce", false)).toBe(0.75);
    expect(letterSimilarity("", "abcd", false)).toBe(0);
  });

  it("discounts long-vowel edits unless told not to", () => {
    // Inserting one alef: half an edit with vowels, a whole one without.
    expect(letterSimilarity("قامت", "قاامت")).toBeCloseTo(1 - 0.5 / 5);
    expect(letterSimilarity("قامت", "قاامت", false)).toBeCloseTo(1 - 1 / 5);
    // Swapping one long vowel for another costs half as well.
    expect(letterSimilarity("حيا", "حيو")).toBeCloseTo(1 - 0.5 / 3);
  });
});

describe("analyzeFormulas", () => {
  it("finds the call's phrases, in order, with a share of 1", () => {
    const a = analyzeFormulas("الله أكبر الله أكبر، أشهد أن لا إله إلا الله");
    expect(a.matches.map((m) => m.id)).toEqual(["TAKBIR", "TAKBIR", "SHAHADA1"]);
    expect(a.covered).toBe(a.words.length);
    expect(a.share).toBe(1);
    expect(a.formulaOnly).toBe(true);
    for (const m of a.matches) expect(m.sim).toBeGreaterThanOrEqual(0.8);
  });

  it("an empty text has share 0 and is not formula-only", () => {
    const a = analyzeFormulas("");
    expect(a).toEqual({ words: [], matches: [], covered: 0, share: 0, formulaOnly: false });
    expect(analyzeFormulas("، . !").formulaOnly).toBe(false);
  });

  it("speech with a formula in it is not formula-only", () => {
    const text = "أيها الإخوة الكرام اتقوا الله في السر والعلن فإن الله أكبر من كل شيء";
    const a = analyzeFormulas(text);
    expect(a.formulaOnly).toBe(false);
    expect(a.share).toBeLessThan(FORMULA_ONLY_SHARE);
    expect(formulaShare(text)).toBe(a.share);
    expect(isFormulaOnly(text)).toBe(false);
  });

  it("counts fragments of the call by its vocabulary (the sung Athan cut mid-phrase)", () => {
    expect(analyzeFormulas("أكبر، الله.").formulaOnly).toBe(true);
    expect(analyzeFormulas("أكبر، الله.").matches).toEqual([]);
    expect(isFormulaOnly("وأشهد")).toBe(true);
    // A word of ≥ 4 letters also matches a sung spelling of the vocabulary.
    expect(isFormulaOnly("الفلااح")).toBe(true);
  });

  it("marks a phrase cut at either edge of the segment next to a whole match", () => {
    // "… الله" | "أكبر أشهد أن لا إله إلا الله" | "حي": edges of TAKBIR and HAYYA.
    const a = analyzeFormulas("أكبر أشهد أن لا إله إلا الله حي على");
    expect(markerSequence(a)).toEqual(["SHAHADA1"]);
    expect(a.formulaOnly).toBe(true);
  });

  it("the Salah set: takbir, tasleem and the other prayer formulas", () => {
    const a = analyzeFormulas("السلام عليكم ورحمة الله، السلام عليكم", "salah");
    expect(a.matches.map((m) => m.id)).toEqual(["TASLEEM", "TASLEEM_SHORT"]);
    expect(countTasleem(a)).toBe(2);
    expect(a.formulaOnly).toBe(true);
    // Salah formulas are no prayer-call markers.
    expect(markerSequence(a)).toEqual([]);
    const takbir = analyzeFormulas("الله أكبر سمع الله لمن حمده ربنا ولك الحمد", "salah");
    expect(takbir.matches.map((m) => m.id)).toEqual(["TAKBIR", "SAMI", "RABBANA"]);
    expect(markerSequence(takbir)).toEqual(["TAKBIR"]);
    expect(countTasleem(takbir)).toBe(0);
    // Al-Fatiha's "الحمد لله" is not a Salah formula.
    expect(analyzeFormulas("الحمد لله رب العالمين", "salah").formulaOnly).toBe(false);
  });
});

describe("markers", () => {
  it("lists each marker once, in order of first occurrence", () => {
    expect(markers("الله أكبر الله أكبر حي على الصلاة حي على الفلاح الله أكبر")).toEqual([
      "TAKBIR",
      "HAYYA_SALAH",
      "HAYYA_FALAH",
    ]);
    expect(markers("قد قامت الصلاة قد قامت الصلاة")).toEqual(["QAD_QAMAT"]);
    expect(markers("الصلاة خير من النوم")).toEqual(["FAJR"]);
    expect(markers("أشهد أن محمدا رسول الله")).toEqual(["SHAHADA2"]);
    expect(markers("كان النبي يحب الصدق")).toEqual([]);
  });

  it("canonical phrases match their own marker", () => {
    expect(Object.keys(MARKER_PHRASES)).toEqual([...MARKER_IDS]);
    for (const id of MARKER_IDS) expect(markers(MARKER_PHRASES[id]), id).toContain(id);
  });

  it("isMarkerId tells call markers from Salah formulas and Al-Fatiha verses", () => {
    for (const id of MARKER_IDS) expect(isMarkerId(id)).toBe(true);
    expect(isMarkerId("TASLEEM")).toBe(false);
    expect(isMarkerId("F2")).toBe(false);
  });
});

describe("fatihaVerses", () => {
  it("returns distinct verses 2–7, never the basmala", () => {
    expect(
      fatihaVerses("بسم الله الرحمن الرحيم الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين"),
    ).toEqual(["F2", "F3", "F4"]);
    expect(fatihaVerses("بسم الله الرحمن الرحيم")).toEqual([]);
    expect(fatihaVerses("اهدنا الصراط المستقيم اهدنا الصراط المستقيم")).toEqual(["F6"]);
    expect(fatihaVerses("ملك يوم الدين")).toEqual(["F4"]);
    expect(fatihaVerses("عباد الله اتقوا الله")).toEqual([]);
  });
});
