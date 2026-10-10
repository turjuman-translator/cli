import { describe, expect, it } from "vitest";
import { corpusWords } from "../../src/quran/corpus.js";
import { alignToUthmani, ayahSpan, splitSentences, waqfSegments } from "../../src/quran/spans.js";

// A synthetic ayah of three waqf segments (three words each), separated by ۖ and ۚ.
const SEG1 = "قال ربكم ادعوني";
const SEG2 = "استجب لكم دائما";
const SEG3 = "ان الذين يستكبرون";
const SEG4 = "عن عبادتي سيدخلون";
const THREE = `${SEG1} ۖ ${SEG2} ۚ ${SEG3}`;
const FOUR = `${SEG1} ۖ ${SEG2} ۚ ${SEG3} ۗ ${SEG4}`;

function span(uthmani: string, translation: string, from: number, to: number, endMarker = "۝") {
  return ayahSpan({
    uthmani,
    simpleWords: corpusWords(uthmani.replace(/[ۖۗۚ]/g, " ")),
    translation,
    from,
    to,
    endMarker,
  });
}

describe("waqfSegments edge cases", () => {
  it("an empty ayah has no segments", () => {
    expect(waqfSegments("")).toEqual([]);
    expect(waqfSegments("   ")).toEqual([]);
  });

  it("a stop mark before any word is dropped; a trailing one closes the last segment", () => {
    expect(waqfSegments("ۖ قال ربكم")).toEqual([
      { words: ["قال", "ربكم"], display: "قال ربكم", stop: "" },
    ]);
    expect(waqfSegments("قال ربكم ۖ")).toEqual([
      { words: ["قال", "ربكم"], display: "قال ربكم", stop: "ۖ" },
    ]);
  });

  it("of two marks in a row the later one closes the segment", () => {
    const segs = waqfSegments("قال ربكم ۖ ۗ ادعوني");
    expect(segs.map((s) => s.stop)).toEqual(["ۗ", ""]);
    expect(segs.map((s) => s.words)).toEqual([["قال", "ربكم"], ["ادعوني"]]);
  });

  it("an annotation sign is displayed but is not a word", () => {
    const [seg] = waqfSegments("قال ۜ ربكم");
    expect(seg?.words).toEqual(["قال", "ربكم"]);
    expect(seg?.display).toBe("قال ۜ ربكم");
  });
});

describe("splitSentences edge cases", () => {
  it("returns nothing for empty text and keeps a last sentence without an end mark", () => {
    expect(splitSentences("  ")).toEqual([]);
    expect(splitSentences("Eerste zin. Tweede zonder punt")).toEqual([
      "Eerste zin.",
      "Tweede zonder punt",
    ]);
  });

  it("keeps closing quotes with their sentence", () => {
    expect(splitSentences('Hij zei: "Ga heen." Toen ging hij.')).toEqual([
      'Hij zei: "Ga heen."',
      "Toen ging hij.",
    ]);
  });

  it("does not split decimals, abbreviations or initials, but does split after a number", () => {
    expect(splitSentences("Het is 3.5 el lang. Klaar.")).toEqual(["Het is 3.5 el lang.", "Klaar."]);
    expect(splitSentences("Zie bv. de kameel. Einde.")).toEqual(["Zie bv. de kameel.", "Einde."]);
    expect(splitSentences("Door J. Smit vertaald. Einde.")).toEqual([
      "Door J. Smit vertaald.",
      "Einde.",
    ]);
    expect(splitSentences("Het getal is 7. Einde.")).toEqual(["Het getal is 7.", "Einde."]);
  });
});

describe("alignToUthmani", () => {
  it("maps two Uthmani words written as one simple-clean word to the first of them", () => {
    expect(alignToUthmani(["يا", "بني"], ["يابني"])).toEqual([0]);
  });

  it("skips an Uthmani word without a simple-clean counterpart", () => {
    expect(alignToUthmani(["من", "المستضعفين", "قال"], ["من", "قال"])).toEqual([0, 2]);
  });

  it("maps a simple-clean word missing from the Uthmani text to the word before it", () => {
    expect(alignToUthmani(["من", "قال"], ["من", "المستضعفين", "قال"])).toEqual([0, 0, 1]);
    expect(alignToUthmani(["قال"], ["المستضعفين", "قال"])).toEqual([0, 0]);
  });

  it("a word without letters matches nothing on its own: it joins the next word", () => {
    expect(alignToUthmani(["،", "قال"], ["قال"])).toEqual([0]);
  });
});

describe("ayahSpan edge cases", () => {
  it("is null without Uthmani words, simple-clean words or translation", () => {
    expect(span("", "Iets.", 0, 0)).toBeNull();
    expect(
      ayahSpan({ uthmani: THREE, simpleWords: [], translation: "Iets.", from: 0, to: 0 }),
    ).toBeNull();
    expect(span(THREE, "   ", 0, 2)).toBeNull();
  });

  it("an ayah without stop marks is always whole; the end marker is optional", () => {
    const one = span(SEG1, "Jullie Heer zegt: roept Mij aan.", 0, 0, "");
    expect(one).toEqual({ text: "Jullie Heer zegt: roept Mij aan.", arabic: SEG1, full: true });
    const noMarker = ayahSpan({
      uthmani: SEG1,
      simpleWords: corpusWords(SEG1),
      translation: "Roept Mij aan.",
      from: 0,
      to: 0,
    });
    expect(noMarker?.arabic).toBe(SEG1);
  });

  it("one sentence per segment: the last segment carries the end marker", () => {
    const s = span(
      THREE,
      "Jullie Heer zegt: roept Mij aan. Ik verhoor jullie. Wie zich verheft.",
      6,
      8,
    );
    expect(s).toEqual({ text: "Wie zich verheft.", arabic: `${SEG3} ۝`, full: false });
  });

  it("clamps the recited range to the ayah", () => {
    const s = span(THREE, "Een. Twee. Drie.", -5, 1);
    expect(s?.text).toBe("Een.");
    expect(s?.arabic).toBe(SEG1);
  });

  it("by position: no sentence half inside the span → the one with the largest share", () => {
    // Two sentences for three segments; the middle segment covers a third of the long one.
    const s = span(
      THREE,
      "Jullie Heer zegt: roept Mij aan en Ik verhoor jullie, waarlijk. Kort.",
      3,
      5,
    );
    expect(s?.text).toBe("Jullie Heer zegt: roept Mij aan en Ik verhoor jullie, waarlijk.");
    expect(s?.arabic).toBe(SEG2);
    expect(s?.full).toBe(false);
  });

  it("by position: every sentence inside the span → the whole translation, the recited Arabic", () => {
    const translation = "Roept Mij aan. Ik verhoor jullie, maar wie zich verheft gaat de Hel in.";
    const s = span(FOUR, translation, 0, 8);
    expect(s?.text).toBe(translation);
    expect(s?.arabic).toBe(`${SEG1} ۖ ${SEG2} ۚ ${SEG3}`);
    expect(s?.full).toBe(false);
  });
});
