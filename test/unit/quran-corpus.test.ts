import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AYAH_COUNT,
  buildCorpus,
  corpusWords,
  isSuspectTranslation,
  keyForm,
  loadCorpus,
  matchForm,
  parseTanzilText,
  parseTranslation,
} from "../../src/quran/corpus.js";
import { allRefs, loadTestCorpus, tanzilContents, testCorpus } from "./quran-test-corpus.js";

const BOM = "﻿";

/** ayahIndex for the real sura sizes (as buildCorpus computes it). */
const corpus = testCorpus({});
const ayahIndex = (s: number, a: number) => corpus.ayahIndex(s, a);

/** A plain Tanzil translation file: one line per ayah (text from `rows`, else "t<i>"). */
function plainTranslation(rows: Record<number, string> = {}): string[] {
  return Array.from({ length: AYAH_COUNT }, (_, i) => rows[i] ?? `t${i}`);
}

describe("parseTanzilText", () => {
  it("parses sura|aya|text, skipping a BOM, comments and blank lines", () => {
    expect(parseTanzilText(`${BOM}1|1|بسم الله \r\n# comment\n\n1|2|الحمد لله\n2|1|`)).toEqual([
      { sura: 1, aya: 1, text: "بسم الله" },
      { sura: 1, aya: 2, text: "الحمد لله" },
      { sura: 2, aya: 1, text: "" },
    ]);
  });

  it("rejects any other line", () => {
    expect(() => parseTanzilText("1|1|ok\nnot a tanzil line")).toThrow(
      'unexpected line (want "sura|aya|text"): not a tanzil line',
    );
  });
});

describe("parseTranslation", () => {
  it("plain format: one line per ayah, then a # footer (a BOM and trailing blanks ignored)", () => {
    const lines = plainTranslation({ 0: "  In de naam van Allah  " });
    const out = parseTranslation(`${BOM}${lines.join("\n")}\n\n# footer\n# more`, ayahIndex);
    expect(out).toHaveLength(AYAH_COUNT);
    expect(out[0]).toBe("In de naam van Allah");
    expect(out[AYAH_COUNT - 1]).toBe(`t${AYAH_COUNT - 1}`);
  });

  it("plain format: blank lines are kept when the file has exactly one line per ayah", () => {
    const lines = plainTranslation({ 5: "" });
    const out = parseTranslation(lines.join("\r\n"), ayahIndex);
    expect(out[5]).toBe("");
    expect(out[6]).toBe("t6");
  });

  it("plain format: stray blank lines between ayat are dropped", () => {
    const lines = plainTranslation();
    lines.splice(3, 0, "", "");
    const out = parseTranslation(lines.join("\n"), ayahIndex);
    expect(out[3]).toBe("t3");
  });

  it("plain format: the wrong number of lines is an error", () => {
    expect(() => parseTranslation("een\ntwee\n", ayahIndex)).toThrow(
      `expected ${AYAH_COUNT} lines, found 2`,
    );
    expect(() => parseTranslation("", ayahIndex)).toThrow(`expected ${AYAH_COUNT} lines, found 0`);
  });

  it("numbered format (Text with aya numbers)", () => {
    const { translations } = tanzilContents({
      "2:255": { simple: "x", translations: { nl: " Allah " } },
    });
    const out = parseTranslation(`${translations.nl}`, ayahIndex);
    expect(out[ayahIndex(2, 255)]).toBe("Allah");
    expect(out[0]).toBe("");
  });

  it("numbered format: blank lines are skipped, missing ayat and bad refs are errors", () => {
    const rows = allRefs().map((r) => `${r.replace(":", "|")}|x`);
    expect(parseTranslation(["", ...rows].join("\n"), ayahIndex)).toHaveLength(AYAH_COUNT);
    expect(() => parseTranslation(rows.slice(1).join("\n"), ayahIndex)).toThrow(
      `expected ${AYAH_COUNT} ayat, found ${AYAH_COUNT - 1}`,
    );
    expect(() => parseTranslation([...rows, "115|1|x"].join("\n"), ayahIndex)).toThrow(
      "bad translation line: 115|1|x",
    );
    // A line separator inside the text: the line no longer matches "sura|aya|text" as a whole.
    expect(() => parseTranslation([...rows, "1|1|a b"].join("\n"), ayahIndex)).toThrow(
      "bad translation line",
    );
  });
});

describe("matching forms", () => {
  it("matchForm drops the hamza on the line, unless nothing would be left", () => {
    expect(matchForm("السماء")).toBe("السما");
    expect(matchForm("ء")).toBe("ء");
  });

  it("corpusWords: normalized, ASR-folded, hamza dropped", () => {
    expect(corpusWords("إِنَّ السَّمَاءَ، شَيْئًا")).toEqual(["ان", "السما", "شي"]);
  });

  it("keyForm drops a leading و/ف (words of 3+ letters) and inner alefs", () => {
    expect(keyForm("ومن")).toBe("من");
    expect(keyForm("فالكتاب")).toBe("الكتب");
    expect(keyForm("الرحمان")).toBe("الرحمن");
    expect(keyForm("وا")).toBe("و");
    expect(keyForm("ا")).toBe("ا");
    expect(keyForm("")).toBe("");
  });
});

describe("isSuspectTranslation", () => {
  it("accepts ordinary text in any language", () => {
    expect(isSuspectTranslation("En Allah is Vergevensgezind, Meest Barmhartig.", "nl")).toBe(
      false,
    );
    expect(isSuspectTranslation("Indeed, Allah is Forgiving and Merciful.", "en")).toBe(false);
    expect(isSuspectTranslation("Het succes is correct en direct, o Jacob.", "nl")).toBe(false);
    expect(isSuspectTranslation("de voltooiing van het werk", "nl")).toBe(false);
  });

  it("flags editor notes, all-caps runs and mixed-case words", () => {
    expect(isSuspectTranslation("THIS TEXT HAS BEEN AUTOMATICALLY GENERATED (OCR)", "nl")).toBe(
      true,
    );
    expect(isSuspectTranslation("text NOTE THAT IS ODD here", "en")).toBe(true);
    expect(isSuspectTranslation("en zÜij gingen", "en")).toBe(true);
  });

  it("Dutch only: typical OCR confusions", () => {
    expect(isSuspectTranslation("en dc mensen", "nl")).toBe(true);
    expect(isSuspectTranslation("en dc mensen", "en")).toBe(false);
    expect(isSuspectTranslation("een zware bcstraffing", "nl")).toBe(true);
    expect(isSuspectTranslation("zij aaiibidden", "nl")).toBe(true);
    expect(isSuspectTranslation("de zoon van Marywn", "nl")).toBe(true);
  });
});

describe("buildCorpus", () => {
  it("indexes ayat, words and translations; strips the Tanzil basmala prefix", () => {
    const loaded = loadTestCorpus({
      "1:1": { simple: "بسم الله الرحمن الرحيم", translations: { nl: "In de naam van Allah." } },
      "2:1": { simple: "بسم الله الرحمن الرحيم الم", uthmani: "بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ الٓمٓ" },
      "2:2": { simple: "بسم الله الرحمن الرحيم ذلك الكتاب" },
      "3:1": { simple: "الم" },
      "4:1": { simple: "بسم الله العظيم الكريم يا أيها الناس" },
      "9:1": { simple: "بسم الله الرحمن الرحيم براءة" },
    });
    expect(loaded.problems).toEqual([]);
    expect(loaded.suspect).toEqual({ nl: 0 });
    const c = loaded.corpus;
    if (c === null) throw new Error("no corpus");
    expect(c.suraSizes).toHaveLength(114);
    expect(c.suraFirst[1]).toBe(7);
    const i21 = c.ayahIndex(2, 1);
    expect(i21).toBe(7);
    expect(c.sura[i21]).toBe(2);
    expect(c.aya[i21]).toBe(1);
    expect(c.simple[0]).toBe("بسم الله الرحمن الرحيم"); // 1:1 is the basmala
    expect(c.simple[i21]).toBe("الم");
    expect(c.uthmani?.[i21]).toBe("الٓمٓ");
    expect(c.simple[i21 + 1]).toBe("بسم الله الرحمن الرحيم ذلك الكتاب"); // not the first ayah
    expect(c.simple[c.ayahIndex(3, 1)]).toBe("الم");
    expect(c.simple[c.ayahIndex(4, 1)]).toBe("بسم الله العظيم الكريم يا أيها الناس");
    expect(c.simple[c.ayahIndex(9, 1)]).toBe("بسم الله الرحمن الرحيم براءة");
    expect(c.translations.get("nl")?.[0]).toBe("In de naam van Allah.");
    expect(c.translations.get("nl")?.[1]).toBeNull();
    // Words: 1:1 (4), 2:1 (1), 2:2 (6), 3:1, 4:1 (7), 9:1 (5)
    expect(c.words.slice(0, 5)).toEqual(["بسم", "الله", "الرحمن", "الرحيم", "الم"]);
    expect(c.wordAyah[4]).toBe(i21);
    expect(c.ayahStart[i21]).toBe(4);
    expect(c.ayahStart[AYAH_COUNT]).toBe(c.words.length);
  });

  it("ayahIndex is -1 outside the Quran", () => {
    const c = testCorpus({});
    expect(c.ayahIndex(1, 7)).toBe(6);
    expect(c.ayahIndex(114, 6)).toBe(AYAH_COUNT - 1);
    expect(c.ayahIndex(0, 1)).toBe(-1);
    expect(c.ayahIndex(115, 1)).toBe(-1);
    expect(c.ayahIndex(1, 0)).toBe(-1);
    expect(c.ayahIndex(1, 8)).toBe(-1);
  });

  it("works without the Uthmani text", () => {
    expect(loadTestCorpus({}, { uthmani: false }).corpus?.uthmani).toBeNull();
  });

  it("fixes known errata and rejects suspect translation lines", () => {
    const loaded = loadTestCorpus({
      "5:8": { simple: "x", translations: { nl: "jullie er niet we brengen", en: "OK text." } },
      "16:7": { simple: "y", translations: { nl: "THIS TEXT HAS BEEN GENERATED (OCR)" } },
    });
    const nl = loaded.corpus?.translations.get("nl");
    const c = loaded.corpus;
    if (c === null || nl === undefined) throw new Error("no corpus");
    expect(nl[c.ayahIndex(5, 8)]).toBe("jullie er niet toe brengen");
    expect(nl[c.ayahIndex(16, 7)]).toBeNull();
    expect(loaded.suspect).toEqual({ nl: 1, en: 0 });
  });

  it("an unusable Uthmani text or translation degrades the corpus with a problem", () => {
    const c = tanzilContents({});
    const loaded = buildCorpus(c.simple, "1|1|x\n", { nl: "kort\n", en: c.simple });
    expect(loaded.corpus?.uthmani).toBeNull();
    expect(loaded.corpus?.translations.has("nl")).toBe(false);
    expect(loaded.problems).toEqual([
      `Uthmani text unusable: Uthmani text: expected ${AYAH_COUNT} ayat, found 1`,
      `translation "nl" unusable: expected ${AYAH_COUNT} lines, found 1`,
    ]);
    // A file in the numbered format works as a translation too.
    expect(loaded.corpus?.translations.get("en")?.[0]).toBeNull();
  });

  it("rejects a main text with the wrong ayat, order or suras", () => {
    const c = tanzilContents({});
    const lines = c.simple.trimEnd().split("\n");
    expect(() => buildCorpus(lines.slice(1).join("\n"), null)).toThrow(
      `simple-clean text: expected ${AYAH_COUNT} ayat, found ${AYAH_COUNT - 1}`,
    );
    const swapped = [lines[1], lines[0], ...lines.slice(2)].join("\n");
    expect(() => buildCorpus(swapped, null)).toThrow("simple-clean text: out of order at 1:2");
    const skipped = lines.map((l) => l.replace(/^2\|/, "3|")).join("\n");
    expect(() => buildCorpus(skipped, null)).toThrow("simple-clean text: out of order at 3:1");
    // 6,236 ayat in 7 suras of (at most) 999 ayat.
    const sevenSuras = Array.from(
      { length: AYAH_COUNT },
      (_, i) => `${Math.floor(i / 999) + 1}|${(i % 999) + 1}|`,
    ).join("\n");
    expect(() => buildCorpus(sevenSuras, null)).toThrow("simple-clean text: expected 114 suras");
  });
});

describe("loadCorpus", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quran-corpus-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, content: string): string {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  it("reads the text, the Uthmani text and the translations", () => {
    const c = tanzilContents({
      "1:1": { simple: "بسم الله", translations: { nl: "In de naam." } },
    });
    const loaded = loadCorpus({
      textFile: write("simple.txt", c.simple),
      uthmaniFile: write("uthmani.txt", c.uthmani),
      translations: { nl: write("nl.txt", c.translations.nl ?? "") },
    });
    expect(loaded.problems).toEqual([]);
    expect(loaded.corpus?.uthmani?.[0]).toBe("بسم الله");
    expect(loaded.corpus?.translations.get("nl")?.[0]).toBe("In de naam.");
  });

  it("only the main text is required", () => {
    const c = tanzilContents({});
    const loaded = loadCorpus({ textFile: write("simple.txt", c.simple) });
    expect(loaded.problems).toEqual([]);
    expect(loaded.corpus?.uthmani).toBeNull();
    expect(loaded.corpus?.translations.size).toBe(0);
  });

  it("missing optional files are problems, not failures", () => {
    const c = tanzilContents({});
    const uthmaniFile = join(dir, "missing-uthmani.txt");
    const nlFile = join(dir, "missing-nl.txt");
    const loaded = loadCorpus({
      textFile: write("simple.txt", c.simple),
      uthmaniFile,
      translations: { nl: nlFile, en: write("en.txt", "kort") },
    });
    expect(loaded.corpus).not.toBeNull();
    expect(loaded.problems).toEqual([
      `Uthmani text not found: ${uthmaniFile}`,
      `translation "nl" not found: ${nlFile}`,
      `translation "en" unusable: expected ${AYAH_COUNT} lines, found 1`,
    ]);
  });

  it("a missing or broken main text gives no corpus (never throws)", () => {
    const textFile = join(dir, "nope.txt");
    expect(loadCorpus({ textFile })).toEqual({
      corpus: null,
      problems: [`Quran text not found: ${textFile}`],
      suspect: {},
    });
    expect(loadCorpus({ textFile: write("bad.txt", "1|1|x\n") })).toEqual({
      corpus: null,
      problems: [`Quran text unusable: simple-clean text: expected ${AYAH_COUNT} ayat, found 1`],
      suspect: {},
    });
  });
});
