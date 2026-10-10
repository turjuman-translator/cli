import { describe, expect, it } from "vitest";
import { corpusWords, keyForm } from "../../src/quran/corpus.js";
import { TrigramIndex } from "../../src/quran/index.js";
import { testCorpus } from "./quran-test-corpus.js";

const corpus = testCorpus({
  "1:7": { simple: "صراط الذين أنعمت عليهم غير المغضوب عليهم ولا الضالين" },
  "2:1": { simple: "الم" },
  "2:255": { simple: "الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم" },
  "3:2": { simple: "الله لا إله إلا هو الحي القيوم" },
  "55:13": { simple: "فبأي آلاء ربكما تكذبان" },
  "55:14": { simple: "خلق الإنسان من صلصال كالفخار" },
  "55:15": { simple: "وخلق الجان من مارج من نار" },
  "55:16": { simple: "فبأي آلاء ربكما تكذبان" },
  "112:1": { simple: "قل هو الله أحد" },
  "112:2": { simple: "الله الصمد" },
  "112:3": { simple: "لم يلد ولم يولد" },
});
const index = new TrigramIndex(corpus);

/** Retrieval keys of a text (as the matcher builds its window). */
const keys = (text: string): string[] => corpusWords(text).map(keyForm);
/** Global word position of word `k` of an ayah. */
const at = (sura: number, aya: number, k = 0): number =>
  (corpus.ayahStart[corpus.ayahIndex(sura, aya)] as number) + k;

describe("TrigramIndex", () => {
  it("indexes the retrieval key of every word and every 3-gram inside a sura", () => {
    expect(index.keys).toHaveLength(corpus.words.length);
    expect(index.keys[at(2, 255, 1)]).toBe("ل"); // لا: inner alef dropped
    const [a, b, c] = keys("فبأي آلاء ربكما");
    expect(index.positions(a ?? "", b ?? "", c ?? "")).toEqual([at(55, 13), at(55, 16)]);
    expect(index.positions("x", "y", "z")).toEqual([]);
    // 3-grams never cross a sura boundary ("ولا الضالين" | "الم").
    const [w1, w2, w3] = keys("ولا الضالين الم");
    expect(index.positions(w1 ?? "", w2 ?? "", w3 ?? "")).toEqual([]);
    expect(index.size).toBeGreaterThan(20);
  });

  it("startsGram: could one or two words begin a 3-gram?", () => {
    expect(index.startsGram(keys("قل"))).toBe(true);
    expect(index.startsGram(keys("قل هو"))).toBe(true);
    expect(index.startsGram(keys("هو قل"))).toBe(false);
    expect(index.startsGram(keys("الضالين"))).toBe(false); // last word of a sura
    expect(index.startsGram(keys("قل هو الله"))).toBe(false); // only 1–2 words are asked about
    expect(index.startsGram([])).toBe(false);
  });

  it("suraRange: global word range of a sura; empty outside the Quran", () => {
    expect(index.suraRange(1)).toEqual({ start: 0, end: 9 });
    expect(index.suraRange(112)).toEqual({ start: at(112, 1), end: at(112, 3, 4) });
    expect(index.suraRange(114)).toEqual({ start: corpus.words.length, end: corpus.words.length });
    expect(index.suraRange(0)).toEqual({ start: 0, end: 0 });
    expect(index.suraRange(115)).toEqual({ start: corpus.words.length, end: 0 });
  });

  describe("candidates", () => {
    it("none without a 3-gram hit", () => {
      expect(index.candidates([])).toEqual([]);
      expect(index.candidates(keys("اتقوا الله عباد الله"))).toEqual([]);
    });

    it("one region per sura and diagonal; equal hits → corpus order", () => {
      const w = keys("قال الله لا إله إلا هو الحي القيوم");
      const c = index.candidates(w);
      expect(c.map((x) => x.sura)).toEqual([2, 3]);
      expect(c[0]).toEqual({
        sura: 2,
        start: at(2, 1), // 1 window word before the first hit + slack 4, clamped to the sura
        end: at(2, 255, 7) + 4, // last hit + 3 (no window words after it) + slack 4
        wStart: 0,
        wEnd: w.length,
        hits: 5,
      });
      expect(c[1]?.sura).toBe(3);
      // The region is clamped to the sura (3:2 is all the text of sura 3 here).
      expect(c[1]?.start).toBe(at(3, 2));
      expect(c[1]?.end).toBe(at(3, 2, 7));
    });

    it("a repeated phrase far apart in one sura gives two regions", () => {
      const c = index.candidates(keys("فبأي آلاء ربكما تكذبان"));
      expect(c.map((x) => [x.sura, x.hits])).toEqual([
        [55, 2],
        [55, 2],
      ]);
      expect(c[0]?.start).toBeLessThan(c[1]?.start ?? 0);
    });

    it("hits a few words off the diagonal (inserted words) stay one region", () => {
      const c = index.candidates(keys("قل هو الله أحد سبحانه الله الصمد لم يلد ولم يولد"));
      expect(c).toHaveLength(1);
      expect(c[0]?.sura).toBe(112);
      expect(c[0]?.hits).toBe(6);
    });

    it("sorts by hits, then corpus position", () => {
      // 2:255's tail ("لا تأخذه سنة ولا نوم") adds hits only there.
      const c = index.candidates(keys("الله لا إله إلا هو الحي القيوم لا تأخذه سنة"));
      expect(c.map((x) => [x.sura, x.hits])).toEqual([
        [2, 8],
        [3, 5],
      ]);
    });

    it("masked words (null) break 3-grams", () => {
      const w: (string | null)[] = keys("قل هو الله أحد الله الصمد");
      w[1] = null;
      w[4] = null;
      // left: "الله احد" + null + "الصمد": no complete 3-gram
      expect(index.candidates(w)).toEqual([]);
      const tail: (string | null)[] = keys("قل هو الله");
      tail[2] = null;
      expect(index.candidates(tail)).toEqual([]);
    });

    it("options: band, extend, slack, maxCandidates, maxPositions", () => {
      const w = keys("قل هو الله أحد سبحانه وتعالى عما يشركون الله الصمد لم يلد ولم يولد");
      const split = index.candidates(w, { band: 1, extend: 0, slack: 0 });
      expect(split).toHaveLength(2);
      expect(split.map((x) => x.hits)).toEqual([4, 2]);
      expect(split[0]).toMatchObject({ start: at(112, 2), end: at(112, 3, 4) });
      expect(split[1]).toMatchObject({ start: at(112, 1), end: at(112, 1, 4), wStart: 0, wEnd: 4 });
      expect(index.candidates(w, { band: 1, maxCandidates: 1 })).toHaveLength(1);
      expect(index.candidates(w, { maxPositions: 0 })).toEqual([]);
    });
  });
});
