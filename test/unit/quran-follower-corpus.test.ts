// The Quran follower on real verses: a synthetic Tanzil corpus with a few ayat
// (test/unit/quran-test-corpus.ts) and the real matcher, fed the way the pipeline feeds it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createQuranFollower } from "../../src/quran/follower.js";
import { QuranMatcher } from "../../src/quran/matcher.js";
import { type TestAyah, testCorpus } from "./quran-test-corpus.js";

interface SpanVerse {
  uthmani: string;
  simple: string;
  nl: string;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/quran-spans.json", import.meta.url), "utf8"),
) as Record<string, SpanVerse>;

const AYAT: Record<string, TestAyah> = {
  "3:102": {
    simple: "يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون",
    translations: { nl: "O jullie die geloven, vreest Allah met ware vrees." },
  },
  // "خلق السماوات والأرض بالحق" opens or continues many ayat: a generic phrase.
  "6:73": {
    simple:
      "وهو الذي خلق السماوات والأرض بالحق ويوم يقول كن فيكون قوله الحق وله الملك يوم ينفخ في الصور عالم الغيب والشهادة وهو الحكيم الخبير",
  },
  "14:19": { simple: "ألم تر أن الله خلق السماوات والأرض بالحق إن يشأ يذهبكم ويأت بخلق جديد" },
  "16:3": { simple: "خلق السماوات والأرض بالحق تعالى عما يشركون" },
  "112:1": { simple: "قل هو الله أحد" },
  "112:2": { simple: "الله الصمد" },
};
for (const [ref, v] of Object.entries(fixtures)) {
  AYAT[ref] = { simple: v.simple, uthmani: v.uthmani, translations: { nl: v.nl } };
}

const matcher = new QuranMatcher(testCorpus(AYAT), { minWords: 5, minCoverage: 0.6 });

function fixture(ref: string): SpanVerse {
  const v = fixtures[ref];
  if (v === undefined) throw new Error(`fixture ${ref} missing`);
  return v;
}

/** 57:25's first waqf segment and its translation sentence. */
const FIRST_SEGMENT_57_25 = {
  uthmani: fixture("57:25").uthmani.split(" ۖ ")[0],
  nl: `${fixture("57:25").nl.split("). ")[0]}).`,
};

describe("Quran follower without Quran data", () => {
  it("only counts words and decides them at once", () => {
    const f = createQuranFollower(null);
    expect(f.ready).toBe(false);
    expect(f.push("بسم الله الرحمن الرحيم", 0)).toEqual({ added: 4, decidedTo: 4, verses: [] });
    expect(f.push("، الحمد لله", 10)).toEqual({ added: 2, decidedTo: 6, verses: [] });
    expect(f.flush(20)).toEqual({ decidedTo: 6, verses: [] });
    f.reset();
    expect(f.push("قل هو الله أحد", 30)).toEqual({ added: 4, decidedTo: 4, verses: [] });
  });

  it("is the same for a matcher whose corpus did not load", () => {
    const f = createQuranFollower(new QuranMatcher(null, { minWords: 5, minCoverage: 0.6 }), {
      targetLang: "en",
    });
    expect(f.ready).toBe(false);
    expect(f.push("يا أيها الذين آمنوا اتقوا الله", 0)).toEqual({
      added: 6,
      decidedTo: 6,
      verses: [],
    });
  });
});

describe("Quran follower on real verses", () => {
  it("follows 3:102 after a verse-intro cue; the khatib's own words stay plain", () => {
    const f = createQuranFollower(matcher);
    expect(f.ready).toBe(true);
    expect(f.push("عباد الله قال الله تعالى", 0)).toEqual({ added: 5, decidedTo: 5, verses: [] });
    const verse = {
      ref: "3:102",
      complete: true,
      approved: "O jullie die geloven, vreest Allah met ware vrees.",
      uthmani: `${AYAT["3:102"]?.simple} ۝١٠٢`,
      partial: false,
    };
    expect(f.push("يا أيها الذين آمنوا اتقوا الله", 500)).toEqual({
      added: 6,
      decidedTo: 11,
      verses: [{ ...verse, from: 5, to: 11, isNew: true }],
    });
    expect(f.push("حق تقاته ولا تموتن إلا وأنتم مسلمون", 1000)).toEqual({
      added: 7,
      decidedTo: 18,
      verses: [{ ...verse, from: 5, to: 18, isNew: false }],
    });
    expect(f.push("فاتقوا الله عباد الله", 1500)).toEqual({ added: 4, decidedTo: 22, verses: [] });
  });

  it("shows the approved sentence of the recited waqf segment of 57:25 at once, then extends it", () => {
    const f = createQuranFollower(matcher);
    const part = {
      ref: "57:25",
      complete: false,
      approved: FIRST_SEGMENT_57_25.nl,
      uthmani: FIRST_SEGMENT_57_25.uthmani,
      partial: true,
    };
    expect(f.push("قال تعالى لقد أرسلنا رسلنا بالبينات وأنزلنا معهم الكتاب والميزان", 0)).toEqual({
      added: 10,
      decidedTo: 10,
      verses: [{ ...part, from: 2, to: 10, isNew: true }],
    });
    expect(f.push("ليقوم الناس بالقسط", 1000)).toEqual({
      added: 3,
      decidedTo: 13,
      verses: [{ ...part, from: 2, to: 13, isNew: false }],
    });
  });

  it("joins a recited word the recognizer moved into the next segment (… الكتاب وال | بالقسط)", () => {
    const f = createQuranFollower(matcher);
    const first = f.push(
      'وأنزل سبحانه وتعالى الكتاب والميزان ليقوم الناس بالقسط، كما بين سبحانه وتعالى: "لقد أرسلنا رسلنا بالبينات، وأنزلنا معهم الكتاب وال.',
      0,
    );
    expect(first.added).toBe(20);
    expect(first.decidedTo).toBe(19); // the paraphrase before the cue is plain; "وال" waits
    expect(first.verses).toMatchObject([{ ref: "57:25", from: 12, to: 19, isNew: true }]);
    const next = f.push('بالقسط". وسمى الله سبحانه وتعالى العدل ميزانًا.', 3000);
    expect(next.decidedTo).toBe(27);
    expect(next.verses).toMatchObject([{ ref: "57:25", from: 12, to: 21, isNew: false }]);
  });

  it("a generic Quranic phrase without a cue is held only briefly", () => {
    const f = createQuranFollower(matcher);
    expect(f.push("الله سبحانه وتعالى خلق السماوات والأرض", 0).decidedTo).toBe(3);
    expect(f.flush(500).decidedTo).toBe(3);
    expect(f.flush(800)).toEqual({ decidedTo: 6, verses: [] });
  });

  it("holds two words that begin a Quran 3-gram until the speaker pauses", () => {
    const f = createQuranFollower(matcher);
    expect(f.push("وقل هو", 0).decidedTo).toBe(0);
    expect(f.flush(300).decidedTo).toBe(0);
    expect(f.flush(700).decidedTo).toBe(2);
    expect(f.push("قل هو.", 1000).decidedTo).toBe(4);
  });
});
