import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { corpusWords, type QuranCorpus } from "../../src/quran/corpus.js";
import { TrigramIndex } from "../../src/quran/index.js";
import {
  formatRef,
  loadQuranMatcher,
  parseRef,
  QuranMatcher,
  sourceExcerpt,
} from "../../src/quran/matcher.js";
import spanFixtures from "../fixtures/quran-spans.json" with { type: "json" };
import { type TestAyah, tanzilContents, testCorpus } from "./quran-test-corpus.js";

const fixture = (ref: keyof typeof spanFixtures): TestAyah => {
  const v = spanFixtures[ref];
  return { simple: v.simple, uthmani: v.uthmani, translations: { nl: v.nl } };
};

const AYAT: Record<string, TestAyah> = {
  "1:1": { simple: "بسم الله الرحمن الرحيم" },
  "1:2": { simple: "الحمد لله رب العالمين", translations: { nl: "Alle lof zij Allah." } },
  "1:3": { simple: "الرحمن الرحيم", translations: { nl: "De Barmhartige." } },
  "1:4": { simple: "مالك يوم الدين" },
  "1:5": { simple: "إياك نعبد وإياك نستعين" },
  "1:6": { simple: "اهدنا الصراط المستقيم" },
  "1:7": { simple: "صراط الذين أنعمت عليهم غير المغضوب عليهم ولا الضالين" },
  "2:255": {
    simple:
      "الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم له ما في السماوات وما في الأرض من ذا الذي يشفع عنده إلا بإذنه",
  },
  "3:2": { simple: "الله لا إله إلا هو الحي القيوم" },
  "3:102": {
    simple: "يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون",
    uthmani: "يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ ٱتَّقُوا۟ ٱللَّهَ حَقَّ تُقَاتِهِۦ وَلَا تَمُوتُنَّ إِلَّا وَأَنتُم مُّسْلِمُونَ",
    translations: { nl: "O jullie die geloven, vreest Allah met ware vrees." },
  },
  "5:8": fixture("5:8"),
  "6:152": fixture("6:152"),
  "16:90": fixture("16:90"),
  "57:25": fixture("57:25"),
  "54:17": { simple: "ولقد يسرنا القرآن للذكر فهل من مدكر" },
  "54:22": { simple: "ولقد يسرنا القرآن للذكر فهل من مدكر" },
  "108:1": {
    simple: "إنا أعطيناك الكوثر",
    translations: { nl: "Voorwaar, Wij hebben jou de Kauthar gegeven." },
  },
  "108:2": { simple: "فصل لربك وانحر", translations: { nl: "Verricht daarom de shalat." } },
  "108:3": { simple: "إن شانئك هو الأبتر" },
  // Constructed: three short words (no real ayah), see "hears no word right".
  "104:1": { simple: "قل لن كن" },
  "112:1": { simple: "قل هو الله أحد", translations: { nl: "Zeg: Hij is Allah, de Ene." } },
  "112:2": { simple: "الله الصمد", translations: { nl: "Allah is de Behoeftenloze." } },
  "112:3": {
    simple: "لم يلد ولم يولد",
    translations: { nl: "Hij verwekt niet en is niet verwekt." },
  },
  "112:4": { simple: "ولم يكن له كفوا أحد", translations: { nl: "En niemand is aan Hem gelijk." } },
};

const corpus = testCorpus(AYAT);
const OPTS = { minWords: 5, minCoverage: 0.6 };
const matcher = new QuranMatcher(corpus, OPTS);
const NL = { targetLang: "nl", ignoreStoplist: false };

const refs = (text: string, prevText?: string, opts = NL, m = matcher): string[] =>
  m.match(prevText === undefined ? { text } : { text, prevText }, opts).map((x) => x.ref);

afterEach(() => vi.restoreAllMocks());

describe("refs", () => {
  it("parseRef: single ayat and ranges (hyphen or en dash)", () => {
    expect(parseRef("2:286")).toEqual({ sura: 2, from: 286, to: 286 });
    expect(parseRef(" 2:285 - 286 ")).toEqual({ sura: 2, from: 285, to: 286 });
    expect(parseRef("2:285–286")).toEqual({ sura: 2, from: 285, to: 286 });
  });

  it("parseRef: anything else is null", () => {
    for (const bad of ["", "2", "2:x", "0:1", "1:0", "2:5-3", "1234:1"]) {
      expect(parseRef(bad)).toBeNull();
    }
  });

  it("formatRef", () => {
    expect(formatRef(2, 286, 286)).toBe("2:286");
    expect(formatRef(2, 285, 286)).toBe("2:285-286");
  });
});

describe("sourceExcerpt", () => {
  const text = "قال تعالى ، «قل هو الله أحد» صدق الله";
  it("returns the original words of a span, punctuation-only tokens not counted", () => {
    expect(sourceExcerpt(text, { start: 2, end: 6 })).toBe("«قل هو الله أحد»");
    expect(sourceExcerpt(text, { start: 0, end: 1 })).toBe("قال");
  });

  it("is empty for a span outside the text or a reversed span", () => {
    expect(sourceExcerpt(text, { start: 20, end: 22 })).toBe("");
    expect(sourceExcerpt(text, { start: 2, end: 0 })).toBe("");
    expect(sourceExcerpt(text, { start: 4, end: 1 })).toBe("");
  });
});

describe("QuranMatcher.match", () => {
  it("finds a whole ayah quoted inside the khatib's words", () => {
    const text =
      "أما بعد فيقول الله تبارك وتعالى يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون";
    const [m, ...rest] = matcher.match({ text }, NL);
    expect(rest).toEqual([]);
    expect(m).toEqual({
      ref: "3:102",
      partial: false,
      arabic: AYAT["3:102"]?.simple,
      approved: "O jullie die geloven, vreest Allah met ware vrees.",
      span: { start: 6, end: 19 },
      score: 1,
    });
    expect(
      matcher.match({ text }, { targetLang: "en", ignoreStoplist: false })[0]?.approved,
    ).toBeNull();
  });

  it("a long ayah quoted in part is partial; recognizer errors lower the score", () => {
    const [m] = matcher.match(
      { text: "إن الله يأمر بالعدل والإحسن وإيتاء ذي القربى وينهى عن الفحشاء" },
      NL,
    );
    expect(m?.ref).toBe("16:90");
    expect(m?.partial).toBe(true);
    expect(m?.score).toBeLessThan(1);
    expect(m?.score).toBeGreaterThan(0.9);
  });

  it("a quote spanning prevText and text is reported once, for the part in text", () => {
    const words = (AYAT["3:102"]?.simple ?? "").split(" ");
    const prevText = `قال تعالى ${words.slice(0, 6).join(" ")}`;
    const text = `${words.slice(6).join(" ")} عباد الله`;
    const [m] = matcher.match({ text, prevText }, NL);
    expect(m?.ref).toBe("3:102");
    expect(m?.span).toEqual({ start: 0, end: 7 });
    expect(m?.partial).toBe(true); // judged on the part in text
    // The whole quote in prevText: reported with the previous segment, not again.
    expect(refs("عباد الله اتقوا الله", AYAT["3:102"]?.simple)).toEqual([]);
  });

  it("only a word or two of a quote in text: still the ayah it belongs to", () => {
    const words = (AYAT["3:102"]?.simple ?? "").split(" ");
    const [m] = matcher.match(
      { text: `${words.slice(11).join(" ")} عباد الله`, prevText: words.slice(0, 11).join(" ") },
      NL,
    );
    expect(m?.ref).toBe("3:102");
    expect(m?.span).toEqual({ start: 0, end: 2 });
  });

  it("several quotes in one window, in text order; consecutive ayat merge into a range", () => {
    const text = `قال الله ${AYAT["112:1"]?.simple} ${AYAT["112:2"]?.simple} ${AYAT["112:3"]?.simple} ${AYAT["112:4"]?.simple} وقال ${AYAT["3:102"]?.simple}`;
    const ms = matcher.match({ text }, NL);
    expect(ms.map((m) => m.ref)).toEqual(["112:1-4", "3:102"]);
    expect(ms[0]?.approved).toBe(
      "Zeg: Hij is Allah, de Ene. Allah is de Behoeftenloze. Hij verwekt niet en is niet verwekt. En niemand is aan Hem gelijk.",
    );
  });

  it("a quote two locations explain equally well is ambiguous: no ref", () => {
    expect(refs("الله لا إله إلا هو الحي القيوم")).toEqual([]);
    // A refrain repeated close together in one sura.
    expect(refs("عباد الله ولقد يسرنا القرآن للذكر فهل من مدكر")).toEqual([]);
    expect(
      refs(
        "اسمعوا يا عباد الله ما يقول ربنا في كتابه العزيز ولقد يسرنا القرآن للذكر فهل من مدكر فاتقوا الله يا عباد الله واعلموا أن الدنيا دار ممر",
      ),
    ).toEqual([]);
  });

  it("stoplist phrases are no quote, except during Salah", () => {
    const khutbah = new QuranMatcher(corpus, { ...OPTS, stoplist: ["الحمد لله رب العالمين", "،"] });
    const text = "بسم الله الرحمن الرحيم الحمد لله رب العالمين";
    expect(refs(text, undefined, NL, khutbah)).toEqual([]);
    const salah = { targetLang: "nl", ignoreStoplist: true };
    expect(refs(text, undefined, salah, khutbah)).toEqual(["1:1-2"]);
    // A stoplist phrase still being said at the end of the window counts too.
    expect(refs("بسم الله الرحمن الرحيم الحمد لله رب", undefined, NL, khutbah)).toEqual([]);
    // Only the basmala is built in; other words make it a quote.
    expect(refs(text)).toEqual(["1:1-2"]);
  });

  it("too few words, or the khatib's own words, are no quote", () => {
    expect(refs("قل هو الله")).toEqual([]);
    expect(refs("اتقوا الله عباد الله واعلموا أن الله خبير")).toEqual([]);
    expect(refs("")).toEqual([]);
    expect(refs("، . !")).toEqual([]);
  });

  it("a short ayah counts when all of it was recited; a stray matching word does not", () => {
    // 108:2 (3 words) is complete: 108:1-3. The khatib's "إن" after the sura adds nothing.
    expect(refs("إنا أعطيناك الكوثر فصل لربك وانحر إن شانئك هو الأبتر")).toEqual(["108:1-3"]);
  });

  it("the same quote twice is reported twice", () => {
    const sura = "قل هو الله أحد الله الصمد لم يلد ولم يولد ولم يكن له كفوا أحد";
    const ms = matcher.match({ text: `${sura} عباد الله ${sura}` }, NL);
    expect(ms.map((m) => [m.ref, m.span.start, m.span.end])).toEqual([
      ["112:1-4", 0, 15],
      ["112:1-4", 17, 32],
    ]);
  });

  it("a word the speaker skipped stays inside the quote (lower score)", () => {
    const [m] = matcher.match(
      { text: "يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن وأنتم مسلمون" },
      NL,
    );
    expect(m).toMatchObject({ ref: "3:102", partial: false, span: { start: 0, end: 12 } });
    expect(m?.score).toBe(0.923);
  });

  it("commentary between two parts of a recitation splits it into two quotes", () => {
    expect(
      refs(
        "قل هو الله أحد الله الصمد واعلموا يا عباد أن الدنيا دار ممر والآخرة دار لم يلد ولم يولد ولم يكن له كفوا أحد",
      ),
    ).toEqual(["112:1-2", "112:3-4"]);
  });

  it("edge ayat with only a few matched words are not part of the ref", () => {
    expect(refs("ولم يولد ولم يكن")).toEqual([]); // 2 + 2 words of two longer ayat
    expect(refs("الله الصمد لم يلد")).toEqual([]); // 112:2 whole, but only 2 words
    const tail = matcher.match({ text: "قل هو الله أحد الله الصمد عباد لم يلد" }, NL);
    expect(tail.map((m) => [m.ref, m.span.end])).toEqual([["112:1-2", 6]]);
    const head = matcher.match({ text: "ولم يولد عباد ولم يكن له كفوا أحد" }, NL);
    expect(head.map((m) => [m.ref, m.span.start])).toEqual([["112:4", 3]]);
    // A lone word after the quote, cut off by a skipped word, is the khatib's.
    const [m] = matcher.match(
      { text: "ولا يجرمنكم شنآن قوم على ألا تعدلوا اعدلوا هو أقرب للتقوى والله سبحانه وتعالى" },
      NL,
    );
    expect(m?.ref).toBe("5:8");
    expect(m?.span).toEqual({ start: 0, end: 11 });
    expect(m?.approved).toContain("er niet toe brengen"); // errata applied
  });

  it("a recognizer that hears no word right is no quote, even with a 3-gram hit", () => {
    // Same retrieval keys as 104:1 ("قل لن كن"), but every word is one edit off.
    expect(refs("قال لان كان")).toEqual([]);
  });

  it("thresholds: minWords, minCoverage, longMatchWords and distinctRunWords", () => {
    const part = "لقد أرسلنا رسلنا بالبينات وأنزلنا معهم الكتاب"; // 7 of 33 words of 57:25
    expect(refs(part)).toEqual(["57:25"]); // a distinctive run of ≥ 6 words
    const strict = new QuranMatcher(corpus, { ...OPTS, distinctRunWords: 8 });
    expect(refs(part, undefined, NL, strict)).toEqual([]);
    const longer = `${part} والميزان`; // 8 words
    expect(refs(longer, undefined, NL, strict)).toEqual(["57:25"]);
    const noLong = new QuranMatcher(corpus, { ...OPTS, distinctRunWords: 99, longMatchWords: 99 });
    expect(refs(longer, undefined, NL, noLong)).toEqual([]);
    const short = AYAT["112:1"]?.simple ?? ""; // a whole 4-word ayah
    expect(refs(short)).toEqual([]);
    expect(
      refs(short, undefined, NL, new QuranMatcher(corpus, { minWords: 3, minCoverage: 1 })),
    ).toEqual(["112:1"]);
  });

  it("word similarity: a dropped conjunction still matches, a misheard short word does not", () => {
    expect(refs("يا أيها الذين آمنوا اتقوا الله حق تقاته فلا تموتن إلا وأنتم مسلمون")).toEqual([
      "3:102",
    ]);
    const exact = new QuranMatcher(corpus, { ...OPTS, wordSimilarity: 1 });
    expect(
      refs(
        "يا أيها الذين آمنوا اتقوا الله حق تقاته فلا تموتن إلا وأنتم مسلمون",
        undefined,
        NL,
        exact,
      ),
    ).toEqual(["3:102"]);
  });

  it("ambiguity margin: how much better the best location must explain the quote", () => {
    // 2:255 explains two more words than 3:2 (≈ 4 points).
    const text = "الله لا إله إلا هو الحي القيوم لا تأخذه";
    expect(refs(text)).toEqual(["2:255"]);
    const wide = new QuranMatcher(corpus, { ...OPTS, ambiguityMargin: 5 });
    expect(refs(text, undefined, NL, wide)).toEqual([]);
  });

  it("never throws: an internal error means no matches", () => {
    vi.spyOn(TrigramIndex.prototype, "candidates").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(refs(AYAT["3:102"]?.simple ?? "")).toEqual([]);
  });

  it("without a corpus nothing matches", () => {
    const none = new QuranMatcher(null, OPTS);
    expect(none.ready).toBe(false);
    expect(refs(AYAT["3:102"]?.simple ?? "", undefined, NL, none)).toEqual([]);
    expect(matcher.ready).toBe(true);
  });
});

describe("QuranMatcher texts", () => {
  it("verseText: Uthmani text with ayah-end markers in Arabic-Indic digits", () => {
    expect(matcher.verseText("3:102")).toBe(`${AYAT["3:102"]?.uthmani} ۝١٠٢`);
    expect(matcher.verseText("112:1-2")).toBe("قل هو الله أحد ۝١ الله الصمد ۝٢");
    expect(matcher.verseText("112:5")).toBeNull();
    expect(matcher.verseText("nope")).toBeNull();
    expect(
      new QuranMatcher(testCorpus(AYAT, { uthmani: false }), OPTS).verseText("3:102"),
    ).toBeNull();
    expect(new QuranMatcher(null, OPTS).verseText("3:102")).toBeNull();
  });

  it("approvedText: the approved translation of every ayah of the ref, or null", () => {
    expect(matcher.approvedText("112:1-2", "nl")).toBe(
      "Zeg: Hij is Allah, de Ene. Allah is de Behoeftenloze.",
    );
    expect(matcher.approvedText("108:2-3", "nl")).toBeNull(); // 108:3 has none
    expect(matcher.approvedText("112:1", "en")).toBeNull();
    expect(matcher.approvedText("0:1", "nl")).toBeNull();
    expect(new QuranMatcher(null, OPTS).approvedText("112:1", "nl")).toBeNull();
  });

  it("ayahRef and ayahWordCount by ayah index", () => {
    const i = corpus.ayahIndex(112, 4);
    expect(matcher.ayahRef(i)).toBe("112:4");
    expect(matcher.ayahWordCount(i)).toBe(5);
    expect(matcher.ayahWordCount(corpus.ayahIndex(112, 5 - 1) + 1)).toBe(0);
    for (const bad of [-1, 6236]) {
      expect(matcher.ayahRef(bad)).toBeNull();
      expect(matcher.ayahWordCount(bad)).toBe(0);
    }
    expect(new QuranMatcher(null, OPTS).ayahRef(0)).toBeNull();
    expect(new QuranMatcher(null, OPTS).ayahWordCount(0)).toBe(0);
  });

  it("ayahNextPos: an exact word (≥ 4 letters) within reach in the ayah", () => {
    const i = corpus.ayahIndex(57, 25);
    const words = corpusWords(AYAT["57:25"]?.simple ?? "");
    const pos = words.indexOf("بالقسط");
    expect(matcher.ayahNextPos(i, "بالقسط", pos - 3, 6)).toBe(pos);
    expect(matcher.ayahNextPos(i, "بالقسط", pos - 6, 6)).toBe(-1); // out of reach
    expect(matcher.ayahNextPos(i, "بالقسط", -3, 99)).toBe(pos);
    expect(matcher.ayahNextPos(i, "الحديد", words.length - 2, 6)).toBe(-1); // end of the ayah
    expect(matcher.ayahNextPos(i, "لقد", 0, 6)).toBe(-1); // too short to be evidence
    expect(matcher.ayahNextPos(-1, "بالقسط", 0, 6)).toBe(-1);
    expect(matcher.ayahNextPos(6236, "بالقسط", 0, 6)).toBe(-1);
    expect(new QuranMatcher(null, OPTS).ayahNextPos(i, "بالقسط", 0, 99)).toBe(-1);
  });

  it("ayahSpan: the approved translation of the recited waqf segments", () => {
    const i = corpus.ayahIndex(57, 25);
    const span = matcher.ayahSpan(i, 0, 10, "nl");
    expect(span?.full).toBe(false);
    expect(span?.text.startsWith("Voorzeker, Wij hebben Onze Boodschappers")).toBe(true);
    const whole = matcher.ayahSpan(corpus.ayahIndex(3, 102), 0, 11, "nl");
    expect(whole).toEqual({
      text: "O jullie die geloven, vreest Allah met ware vrees.",
      arabic: `${AYAT["3:102"]?.uthmani} ۝١٠٢`,
      full: true,
    });
  });

  it("ayahSpan: null without data for it", () => {
    const i = corpus.ayahIndex(57, 25);
    expect(matcher.ayahSpan(i, 0, 10, "en")).toBeNull();
    expect(matcher.ayahSpan(corpus.ayahIndex(108, 3), 0, 1, "nl")).toBeNull();
    expect(matcher.ayahSpan(-1, 0, 1, "nl")).toBeNull();
    expect(matcher.ayahSpan(6236, 0, 1, "nl")).toBeNull();
    expect(
      new QuranMatcher(testCorpus(AYAT, { uthmani: false }), OPTS).ayahSpan(i, 0, 1, "nl"),
    ).toBeNull();
    expect(new QuranMatcher(null, OPTS).ayahSpan(i, 0, 1, "nl")).toBeNull();
  });

  it("ayahSpan never throws, even on malformed corpus data", () => {
    const i = corpus.ayahIndex(57, 25);
    const bad: QuranCorpus = {
      ...corpus,
      translations: new Map([["nl", corpus.simple.map(() => 42 as unknown as string)]]),
    };
    expect(new QuranMatcher(bad, OPTS).ayahSpan(i, 0, 1, "nl")).toBeNull();
  });
});

describe("QuranMatcher follower support", () => {
  it("couldStartQuote: 1–2 words that begin a Quran 3-gram", () => {
    expect(matcher.couldStartQuote(corpusWords("قل هو"))).toBe(true);
    expect(matcher.couldStartQuote(corpusWords("هو قل"))).toBe(false);
    expect(new QuranMatcher(null, OPTS).couldStartQuote(corpusWords("قل هو"))).toBe(false);
  });

  it("analyzeWords: verified quotes with their word → ayah alignment, and live alignments", () => {
    const words = corpusWords(`قال تعالى ${AYAT["112:1"]?.simple} ${AYAT["112:2"]?.simple} سبحانه`);
    const a = matcher.analyzeWords(words, { ignoreStoplist: false });
    expect(a.matches).toHaveLength(1);
    const m = a.matches[0];
    const i1 = corpus.ayahIndex(112, 1);
    expect(m).toMatchObject({ wStart: 2, wEnd: 8, firstAyah: i1, lastAyah: i1 + 1 });
    expect(m?.pairs[0]).toEqual({ w: 2, ayah: i1, pos: 0, ok: true });
    expect(m?.pairs[4]).toEqual({ w: 6, ayah: i1 + 1, pos: 0, ok: true });
    expect(a.live.some((l) => l.ayah === i1 && l.matched === 6)).toBe(true);
  });

  it("analyzeWords: a quote still in progress is live but not verified", () => {
    const a = matcher.analyzeWords(corpusWords("عباد الله يا أيها الذين آمنوا"), {
      ignoreStoplist: false,
    });
    expect(a.matches).toEqual([]);
    expect(a.live.map((l) => [l.wStart, l.wEnd, l.matched])).toContainEqual([2, 6, 4]);
  });

  it("analyzeWords: nothing without data or words, or on an internal error", () => {
    const none = { matches: [], live: [] };
    expect(new QuranMatcher(null, OPTS).analyzeWords(["قل"], { ignoreStoplist: false })).toEqual(
      none,
    );
    expect(matcher.analyzeWords([], { ignoreStoplist: false })).toEqual(none);
    vi.spyOn(TrigramIndex.prototype, "candidates").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(matcher.analyzeWords(corpusWords("قل هو الله أحد"), { ignoreStoplist: false })).toEqual(
      none,
    );
  });
});

describe("loadQuranMatcher", () => {
  const cfg = {
    enabled: true,
    textFile: "unused",
    uthmaniFile: "unused",
    translations: {},
    minWords: 5,
    minCoverage: 0.6,
    stoplist: ["الحمد لله رب العالمين"],
  };
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("loads the corpus from the data paths and reports problems", () => {
    dir = mkdtempSync(join(tmpdir(), "quran-matcher-"));
    const c = tanzilContents(AYAT);
    const textFile = join(dir, "simple.txt");
    writeFileSync(textFile, c.simple);
    const problems: string[] = [];
    const m = loadQuranMatcher(
      {
        quranTextFile: textFile,
        quranUthmaniFile: join(dir, "missing.txt"),
        quranTranslations: {},
      },
      cfg,
      { onProblem: (p) => problems.push(p) },
    );
    expect(m.ready).toBe(true);
    expect(problems).toEqual([`Uthmani text not found: ${join(dir, "missing.txt")}`]);
    expect(refs(AYAT["3:102"]?.simple ?? "", undefined, NL, m)).toEqual(["3:102"]);
    // Without an onProblem callback the problems are dropped.
    const quiet = loadQuranMatcher(
      { quranTextFile: join(dir, "nope.txt"), quranUthmaniFile: textFile, quranTranslations: {} },
      cfg,
    );
    expect(quiet.ready).toBe(false);
  });

  it("disabled: no data is read and nothing matches", () => {
    const m = loadQuranMatcher(
      { quranTextFile: "/nonexistent", quranUthmaniFile: "/nonexistent", quranTranslations: {} },
      { ...cfg, enabled: false },
    );
    expect(m.ready).toBe(false);
  });
});
