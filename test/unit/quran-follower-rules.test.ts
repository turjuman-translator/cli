// The Quran follower's decision rules, driven by a scripted matcher: the stream
// is made of tokens "w0 w1 w2 …" (token wN = stream word N), and every quote says which stream
// words recite which ayah. That pins down exactly what the matcher reports at each step, so every
// hold, release and report rule can be checked on its own.
import { describe, expect, it } from "vitest";
import type { FollowerVerse } from "../../src/compose/types.js";
import { createQuranFollower, type FollowerOptions } from "../../src/quran/follower.js";
import type { QuranMatcher, WindowAnalysis } from "../../src/quran/matcher.js";
import type { AyahSpan } from "../../src/quran/spans.js";

/** Stream words [from, to) recite ayah `ayah` (index), starting at its word `pos`. */
interface Quote {
  ayah: number;
  from: number;
  to: number;
  /** Ayah word position of stream word `from` (default 0). */
  pos?: number;
  /** Arrived words before the matcher verifies it (default 3; Infinity: an unverified alignment). */
  verifyAt?: number;
  /** Stream words the alignment leaves unpaired (extra words). */
  unpaired?: readonly number[];
  /** Stream words aligned below the similarity threshold. */
  mismatched?: readonly number[];
}

interface FakeConfig {
  quotes?: readonly Quote[];
  /** Ayah word counts (default 5). */
  wordCount?: (ayah: number) => number;
  span?: (ayah: number, from: number, to: number) => AyahSpan | null;
  nextPos?: (ayah: number, form: string, from: number, reach: number) => number;
  couldStart?: (words: readonly string[]) => boolean;
  /** Ref of an ayah (default "9:<ayah>"); null = unknown. */
  ref?: (ayah: number) => string | null;
}

interface Fake {
  matcher: QuranMatcher;
  /** analyzeWords() calls: window words and the stoplist flag. */
  analyses: Array<{ words: readonly string[]; ignoreStoplist: boolean }>;
  /** Languages asked of ayahSpan() / approvedText(). */
  langs: string[];
}

/** w(3, 6) = "w3 w4 w5". */
function w(from: number, to = from + 1): string {
  return Array.from({ length: to - from }, (_, i) => `w${from + i}`).join(" ");
}

function fakeMatcher(cfg: FakeConfig = {}): Fake {
  const analyses: Fake["analyses"] = [];
  const langs: string[] = [];
  const analyze = (words: readonly string[]): WindowAnalysis => {
    // Stream index of window word 0, from the first "wN" token (0 when there is none).
    let offset = 0;
    const anchor = words.findIndex((x) => /^w\d+$/.test(x));
    if (anchor >= 0) offset = Number(words[anchor]?.slice(1)) - anchor;
    const end = offset + words.length;
    const out: WindowAnalysis = { matches: [], live: [] };
    for (const q of cfg.quotes ?? []) {
      const arrived: number[] = [];
      for (let g = Math.max(q.from, offset); g < Math.min(q.to, end); g++) arrived.push(g);
      const first = arrived[0];
      const last = arrived[arrived.length - 1];
      if (first === undefined || last === undefined) continue;
      if (arrived.length >= (q.verifyAt ?? 3)) {
        out.matches.push({
          wStart: first - offset,
          wEnd: last + 1 - offset,
          firstAyah: q.ayah,
          lastAyah: q.ayah,
          pairs: arrived
            .filter((g) => !(q.unpaired ?? []).includes(g))
            .map((g) => ({
              w: g - offset,
              ayah: q.ayah,
              pos: (q.pos ?? 0) + g - q.from,
              ok: !(q.mismatched ?? []).includes(g),
            })),
        });
      }
      if (arrived.length >= 3) {
        out.live.push({
          wStart: first - offset,
          wEnd: last + 1 - offset,
          matched: arrived.length,
          ayah: q.ayah,
        });
      }
    }
    return out;
  };
  const fake = {
    ready: true,
    analyzeWords(words: readonly string[], opts: { ignoreStoplist: boolean }): WindowAnalysis {
      analyses.push({ words, ignoreStoplist: opts.ignoreStoplist });
      return analyze(words);
    },
    ayahRef: (ayah: number) => (cfg.ref === undefined ? `9:${ayah}` : cfg.ref(ayah)),
    ayahSpan(ayah: number, from: number, to: number, lang: string): AyahSpan | null {
      langs.push(lang);
      return cfg.span?.(ayah, from, to) ?? null;
    },
    ayahNextPos: (ayah: number, form: string, from: number, reach: number) =>
      cfg.nextPos?.(ayah, form, from, reach) ?? -1,
    ayahWordCount: (ayah: number) => cfg.wordCount?.(ayah) ?? 5,
    couldStartQuote: (words: readonly string[]) => cfg.couldStart?.(words) ?? false,
    approvedText(ref: string, lang: string): string {
      langs.push(lang);
      return `approved ${ref}`;
    },
    verseText: (ref: string) => `uthmani ${ref}`,
  };
  return { matcher: fake as unknown as QuranMatcher, analyses, langs };
}

function follower(cfg: FakeConfig = {}, opts?: FollowerOptions) {
  const fake = fakeMatcher(cfg);
  return { ...fake, f: createQuranFollower(fake.matcher, opts) };
}

/** A complete, new, whole-ayah report (no known span). */
function wholeVerse(ayah: number, from: number, to: number, isNew = true): FollowerVerse {
  return {
    ref: `9:${ayah}`,
    from,
    to,
    complete: true,
    approved: `approved 9:${ayah}`,
    uthmani: `uthmani 9:${ayah}`,
    partial: false,
    isNew,
  };
}

describe("Quran follower: plain speech", () => {
  it("decides words without any Quran evidence at once; empty pushes add nothing", () => {
    const { f, analyses } = follower();
    expect(f.ready).toBe(true);
    expect(f.push(w(0, 3), 0)).toEqual({ added: 3, decidedTo: 3, verses: [] });
    expect(f.push("، ...", 10)).toEqual({ added: 0, decidedTo: 3, verses: [] });
    expect(f.flush(20)).toEqual({ decidedTo: 3, verses: [] });
    // Everything was decided: the later calls did not need the matcher.
    expect(analyses).toHaveLength(1);
  });

  it("passes the stoplist flag to the matcher (Salah ignores the stoplist)", () => {
    const salah = follower({}, { ignoreStoplist: true });
    salah.f.push(w(0, 2), 0);
    expect(salah.analyses[0]?.ignoreStoplist).toBe(true);
    const speech = follower();
    speech.f.push(w(0, 2), 0);
    expect(speech.analyses[0]?.ignoreStoplist).toBe(false);
  });

  it("analyzes the newest windowWords words only (at least 16)", () => {
    const { f, analyses } = follower(
      { quotes: [{ ayah: 1, from: 20, to: 23 }], wordCount: () => 3 },
      { windowWords: 4 },
    );
    expect(f.push(w(0, 20), 0).decidedTo).toBe(20);
    expect(analyses[0]?.words).toEqual(w(4, 20).split(" "));
    expect(f.push(w(20, 23), 100)).toEqual({
      added: 3,
      decidedTo: 23,
      verses: [wholeVerse(1, 20, 23)],
    });
    expect(analyses[1]?.words).toEqual(w(7, 23).split(" "));
  });
});

describe("Quran follower: verified verses", () => {
  it("reports a complete ayah at once with its approved translation, in the target language", () => {
    const { f, langs } = follower(
      { quotes: [{ ayah: 7, from: 2, to: 7 }], wordCount: () => 5 },
      { targetLang: "en" },
    );
    expect(f.push(w(0, 2), 0)).toEqual({ added: 2, decidedTo: 2, verses: [] });
    expect(f.push(w(2, 7), 500)).toEqual({
      added: 5,
      decidedTo: 7,
      verses: [wholeVerse(7, 2, 7)],
    });
    expect(langs).toContain("en");
    expect(langs).not.toContain("nl");
    // The two words after the verse wait briefly (the recitation may go on), then are plain.
    expect(f.push(w(7, 9), 900)).toEqual({ added: 2, decidedTo: 7, verses: [] });
    expect(f.push(w(9), 1300)).toEqual({ added: 1, decidedTo: 10, verses: [] });
    expect(f.flush(1400)).toEqual({ decidedTo: 10, verses: [] });
  });

  it("holds a verified ayah until 80 % of it was recited, then extends the report", () => {
    const { f } = follower({
      quotes: [{ ayah: 3, from: 0, to: 10, verifyAt: 5 }],
      wordCount: () => 10,
    });
    expect(f.push(w(0, 5), 0)).toEqual({ added: 5, decidedTo: 0, verses: [] });
    expect(f.flush(250)).toEqual({ decidedTo: 0, verses: [] });
    expect(f.push(w(5, 8), 1000)).toEqual({
      added: 3,
      decidedTo: 8,
      verses: [wholeVerse(3, 0, 8)],
    });
    expect(f.push(w(8, 10), 1500)).toEqual({
      added: 2,
      decidedTo: 10,
      verses: [wholeVerse(3, 0, 10, false)],
    });
  });

  it("reports at once what cannot complete within completeWaitWords (approved text unknown)", () => {
    const { f } = follower(
      { quotes: [{ ayah: 3, from: 0, to: 5, verifyAt: 5 }], wordCount: () => 10 },
      { completeWaitWords: 2 },
    );
    expect(f.push(w(0, 5), 0)).toEqual({
      added: 5,
      decidedTo: 5,
      verses: [{ ...wholeVerse(3, 0, 5), complete: false, approved: null }],
    });
  });

  it("reports an incomplete ayah once the recitation stopped (three plain words after it)", () => {
    const { f } = follower({
      quotes: [{ ayah: 3, from: 0, to: 5, verifyAt: 5 }],
      wordCount: () => 10,
    });
    expect(f.push(w(0, 5), 0).verses).toEqual([]);
    expect(f.push(w(5, 7), 300)).toEqual({ added: 2, decidedTo: 0, verses: [] });
    expect(f.push(w(7), 600)).toEqual({
      added: 1,
      decidedTo: 8,
      verses: [{ ...wholeVerse(3, 0, 5), complete: false, approved: null }],
    });
  });

  it("reports an incomplete ayah after a pause of pauseReportMs", () => {
    const { f } = follower({
      quotes: [{ ayah: 3, from: 0, to: 5, verifyAt: 5 }],
      wordCount: () => 10,
    });
    f.push(w(0, 5), 0);
    expect(f.flush(2499)).toEqual({ decidedTo: 0, verses: [] });
    expect(f.flush(2500)).toEqual({
      decidedTo: 5,
      verses: [{ ...wholeVerse(3, 0, 5), complete: false, approved: null }],
    });
  });

  it("reports an incomplete ayah completeWaitMs after it was verified, also while speech goes on", () => {
    const { f } = follower(
      { quotes: [{ ayah: 3, from: 0, to: 5, verifyAt: 5 }], wordCount: () => 10 },
      { pauseReportMs: 10_000 },
    );
    f.push(w(0, 5), 0);
    expect(f.push(w(5), 1000).decidedTo).toBe(0);
    // The plain word after the verse is released after maxHoldMs; the verse still waits.
    expect(f.flush(5999)).toEqual({ decidedTo: 0, verses: [] });
    expect(f.flush(6000)).toEqual({
      decidedTo: 6,
      verses: [{ ...wholeVerse(3, 0, 5), complete: false, approved: null }],
    });
  });

  it("reports an incomplete ayah as soon as the next ayah is being recited", () => {
    const { f } = follower({
      quotes: [
        { ayah: 4, from: 0, to: 5, verifyAt: 5 },
        { ayah: 5, from: 5, to: 8, verifyAt: 1 },
      ],
      wordCount: (ayah) => (ayah === 4 ? 10 : 3),
    });
    expect(f.push(w(0, 5), 0).verses).toEqual([]);
    expect(f.push(w(5), 100)).toEqual({
      added: 1,
      decidedTo: 5,
      verses: [{ ...wholeVerse(4, 0, 5), complete: false, approved: null }],
    });
    expect(f.push(w(6, 8), 200)).toEqual({
      added: 2,
      decidedTo: 8,
      verses: [wholeVerse(5, 5, 8)],
    });
  });

  it("with a known span reports the recited part at once and extends it", () => {
    const { f } = follower({
      quotes: [{ ayah: 2, from: 0, to: 10 }],
      wordCount: () => 10,
      span: (_ayah, from, to) => ({
        text: `nl ${from}-${to}`,
        arabic: `ar ${from}-${to}`,
        full: to >= 9,
      }),
    });
    const part = (to: number, isNew: boolean): FollowerVerse => ({
      ref: "9:2",
      from: 0,
      to,
      complete: false,
      approved: `nl 0-${to - 1}`,
      uthmani: `ar 0-${to - 1}`,
      partial: true,
      isNew,
    });
    expect(f.push(w(0, 3), 0)).toEqual({ added: 3, decidedTo: 3, verses: [part(3, true)] });
    expect(f.push(w(3, 6), 500)).toEqual({ added: 3, decidedTo: 6, verses: [part(6, false)] });
    expect(f.push(w(6, 10), 900)).toEqual({
      added: 4,
      decidedTo: 10,
      verses: [{ ...part(10, false), complete: true, partial: false }],
    });
  });

  it("joins a verse's next word that the alignment missed (the tail), with the words in between", () => {
    const { f } = follower({
      quotes: [{ ayah: 6, from: 0, to: 5 }],
      wordCount: () => 6,
      nextPos: (_ayah, form, from, reach) =>
        reach === 6 && ((form === "w7" && from === 5) || (form === "w10" && from === 6))
          ? from
          : -1,
    });
    expect(f.push(w(0, 5), 0).verses).toEqual([wholeVerse(6, 0, 5)]);
    expect(f.push(w(5), 400).decidedTo).toBe(5);
    expect(f.push(w(6), 800).decidedTo).toBe(5);
    expect(f.push(w(7), 1200)).toEqual({
      added: 1,
      decidedTo: 8,
      verses: [wholeVerse(6, 0, 8, false)],
    });
    // Words shown plain stay plain, and the verse never reaches over them: a later tail word
    // is plain too (its meaning would otherwise appear twice).
    expect(f.push(w(8, 10), 1600)).toEqual({ added: 2, decidedTo: 10, verses: [] });
    expect(f.push(w(10), 2000)).toEqual({ added: 1, decidedTo: 11, verses: [] });
  });

  it("a tail word never joins across a word another verse owns", () => {
    const { f } = follower({
      quotes: [
        { ayah: 6, from: 0, to: 5 },
        { ayah: 7, from: 5, to: 8 },
      ],
      wordCount: () => 3,
      nextPos: (ayah, form) => (ayah === 6 && form === "w6" ? 5 : -1),
    });
    expect(f.push(w(0, 5), 0).verses).toEqual([wholeVerse(6, 0, 5)]);
    expect(f.push(w(5, 8), 400).verses).toEqual([wholeVerse(7, 5, 8)]);
  });

  it("a tail word after a long pause is not the old verse's tail", () => {
    const { f } = follower({
      quotes: [{ ayah: 6, from: 0, to: 5 }],
      wordCount: () => 6,
      nextPos: (_ayah, form, from) => (form === "w5" && from === 5 ? 5 : -1),
    });
    expect(f.push(w(0, 5), 0).verses).toEqual([wholeVerse(6, 0, 5)]);
    // Held like any word right after a live alignment, then plain: the verse is not extended.
    expect(f.push(w(5), 120_000)).toEqual({ added: 1, decidedTo: 5, verses: [] });
    expect(f.flush(122_000)).toEqual({ decidedTo: 6, verses: [] });
  });

  it("a verse without a single matched word never takes tail words", () => {
    const { f, langs } = follower(
      { quotes: [{ ayah: 1, from: 0, to: 4, mismatched: [0, 1, 2, 3] }], nextPos: () => 0 },
      { completeWaitWords: 0 },
    );
    expect(f.push(w(0, 4), 0).verses).toEqual([
      { ...wholeVerse(1, 0, 4), complete: false, approved: null },
    ]);
    expect(f.push(w(4, 8), 500)).toEqual({ added: 4, decidedTo: 8, verses: [] });
    expect(langs).toEqual([]); // no span is asked without a matched position
  });

  it("an ayah repeated within recentMs is reported again, but not as new", () => {
    const { f } = follower({
      quotes: [
        { ayah: 1, from: 0, to: 3 },
        { ayah: 2, from: 3, to: 6 },
        { ayah: 1, from: 10, to: 13 },
        { ayah: 1, from: 20, to: 23 },
      ],
      wordCount: () => 3,
    });
    expect(f.push(w(0, 3), 0).verses).toEqual([wholeVerse(1, 0, 3)]);
    expect(f.push(w(3, 6), 10).verses).toEqual([wholeVerse(2, 3, 6)]);
    expect(f.push(w(6, 10), 500).decidedTo).toBe(10);
    expect(f.push(w(10, 13), 1000).verses).toEqual([wholeVerse(1, 10, 13, false)]);
    expect(f.push(w(13, 20), 1500).decidedTo).toBe(20);
    expect(f.push(w(20, 23), 200_000).verses).toEqual([wholeVerse(1, 20, 23)]);
  });

  it("the same ayah recited again right after, but recentMs later, is a new quote", () => {
    const { f } = follower({
      quotes: [
        { ayah: 1, from: 0, to: 3 },
        { ayah: 1, from: 3, to: 6 },
      ],
      wordCount: () => 3,
    });
    expect(f.push(w(0, 3), 0).verses).toEqual([wholeVerse(1, 0, 3)]);
    // No word in between (a long silence): still not merged into the report of minutes ago.
    expect(f.push(w(3, 6), 200_000).verses).toEqual([wholeVerse(1, 3, 6)]);
  });

  it("the same ayah recited again within recentMs extends the report it continues", () => {
    const { f } = follower({
      quotes: [
        { ayah: 1, from: 0, to: 3 },
        { ayah: 1, from: 3, to: 6 },
      ],
      wordCount: () => 3,
    });
    expect(f.push(w(0, 3), 0).verses).toEqual([wholeVerse(1, 0, 3)]);
    expect(f.push(w(3, 6), 60_000).verses).toEqual([wholeVerse(1, 0, 6, false)]);
  });

  it("reset() forgets the stream and the reported ayat", () => {
    const { f, analyses } = follower({ quotes: [{ ayah: 1, from: 0, to: 3 }], wordCount: () => 3 });
    expect(f.push(w(0, 3), 0).verses).toEqual([wholeVerse(1, 0, 3)]);
    f.reset();
    expect(f.push(w(0, 3), 100)).toEqual({ added: 3, decidedTo: 3, verses: [wholeVerse(1, 0, 3)] });
    expect(analyses).toHaveLength(2);
  });

  it("keeps working with many verses (old reported ayat are forgotten)", () => {
    const quotes: Quote[] = Array.from({ length: 40 }, (_, k) => ({
      ayah: 100 + k,
      from: 3 * k,
      to: 3 * k + 3,
    }));
    const { f } = follower(
      { quotes, wordCount: (ayah) => (ayah === 133 ? 10 : 3) },
      { windowWords: 16 },
    );
    const reported: string[] = [];
    for (let k = 0; k < 40; k++) {
      const res = f.push(w(3 * k, 3 * k + 3), 1000 * k);
      reported.push(...res.verses.map((v) => `${v.ref}@${v.from}-${v.to}${v.isNew ? "" : "*"}`));
      // 9:133 (k = 33) waits for completion and is reported when the next ayah starts.
      expect(res.decidedTo).toBe(k === 33 ? 99 : 3 * k + 3);
    }
    expect(reported).toEqual(
      Array.from({ length: 40 }, (_, k) => `9:${100 + k}@${3 * k}-${3 * k + 3}`),
    );
  });
});

describe("Quran follower: unverified holds", () => {
  it("look-ahead: the last two words may begin a quote until a pause or punctuation", () => {
    const { f } = follower({
      couldStart: (ws) => ws.join(" ") === "w1 w2" || ws.join(" ") === "w3 w4",
    });
    expect(f.push(w(0), 0).decidedTo).toBe(1); // one word: no look-ahead yet
    expect(f.push(w(1, 3), 100).decidedTo).toBe(1);
    expect(f.flush(699).decidedTo).toBe(1);
    expect(f.flush(700).decidedTo).toBe(3); // idleMs without a new word
    expect(f.push(`${w(3, 5)}.`, 800).decidedTo).toBe(5); // the text ended with punctuation
  });

  it("an alignment still growing holds its words ≤ maxHoldWords + 4 later words or maxHoldMs", () => {
    const { f } = follower({
      quotes: [{ ayah: 20, from: 0, to: 40, verifyAt: Number.POSITIVE_INFINITY }],
    });
    let decided = 0;
    for (let k = 0; k < 20; k++) decided = f.push(w(k), 400 * k).decidedTo;
    expect(decided).toBe(8); // word j waits until 12 words followed it
    expect(f.flush(400 * 19 + 1999).decidedTo).toBe(8);
    expect(f.flush(400 * 19 + 2000).decidedTo).toBe(20);
  });

  it("an alignment the matcher cannot place (unknown ayah) is never reported", () => {
    const { f } = follower({
      quotes: [{ ayah: 99, from: 0, to: 5 }],
      ref: (a) => (a === 99 ? null : `9:${a}`),
    });
    expect(f.push(w(0, 5), 0)).toEqual({ added: 5, decidedTo: 0, verses: [] });
    expect(f.flush(2000)).toEqual({ decidedTo: 5, verses: [] });
  });

  it("an unpaired first word stays out of the verse; inner extra and mismatched words join it", () => {
    const { f } = follower({
      quotes: [{ ayah: 1, from: 2, to: 9, unpaired: [2, 5], mismatched: [6] }],
      wordCount: () => 5,
    });
    expect(f.push(w(0, 2), 0).decidedTo).toBe(2);
    const res = f.push(w(2, 9), 100);
    expect(res.verses).toEqual([wholeVerse(1, 3, 9)]);
    expect(res.decidedTo).toBe(2); // word 2 waits while the verse may go on
    expect(f.push(w(9, 12), 200).decidedTo).toBe(12);
  });

  it("a generic Quranic phrase (found at ≥ 3 ayat) waits only genericHoldMs", () => {
    const generic: Quote[] = [11, 12, 13].map((ayah) => ({
      ayah,
      from: 2,
      to: 5,
      verifyAt: Number.POSITIVE_INFINITY,
    }));
    const { f } = follower({ quotes: generic });
    expect(f.push(w(0, 2), 0).decidedTo).toBe(2);
    expect(f.push(w(2, 5), 100).decidedTo).toBe(2);
    expect(f.flush(799).decidedTo).toBe(2);
    expect(f.flush(800).decidedTo).toBe(5);
    // Closed with punctuation (an endpoint): no wait at all.
    const closed = follower({ quotes: generic });
    closed.f.push(w(0, 2), 0);
    expect(closed.f.push(`${w(2, 5)}.`, 100).decidedTo).toBe(5);
  });
});

describe("Quran follower: verse-intro cues", () => {
  it("holds the words after قال الله تعالى for cueHoldMs without a new word", () => {
    const { f } = follower();
    expect(f.push("قال الله تعالى", 0).decidedTo).toBe(3); // nothing after the cue yet
    expect(f.push(w(3, 5), 100).decidedTo).toBe(3);
    expect(f.flush(2100).decidedTo).toBe(3); // maxHoldMs would have released them
    expect(f.flush(4599).decidedTo).toBe(3);
    expect(f.flush(4600).decidedTo).toBe(5);
  });

  it("releases a cue early when four words follow without any Quran alignment", () => {
    const { f } = follower();
    f.push("وقال تعالى", 0);
    expect(f.push(w(2, 5), 100).decidedTo).toBe(2);
    expect(f.push(w(5), 200).decidedTo).toBe(6);
  });

  it("a cue followed by an alignment waits maxHoldWords words; earlier words get no grow bonus", () => {
    const { f } = follower({
      quotes: [{ ayah: 30, from: 4, to: 40, verifyAt: Number.POSITIVE_INFINITY }],
    });
    f.push("قال تعالى", 0);
    expect(f.push(w(2, 4), 100).decidedTo).toBe(2);
    expect(f.push(w(4, 9), 200).decidedTo).toBe(2);
    expect(f.push(w(9), 300).decidedTo).toBe(4); // 8 words after the cue: the cue expired
    expect(f.push(w(10, 17), 400).decidedTo).toBe(5);
  });

  it("a generic phrase after a cue waits cueHoldMs", () => {
    const generic: Quote[] = [11, 12, 13].map((ayah) => ({
      ayah,
      from: 2,
      to: 5,
      verifyAt: Number.POSITIVE_INFINITY,
    }));
    const { f } = follower({ quotes: generic });
    f.push("قال تعالى", 0);
    expect(f.push(w(2, 5), 100).decidedTo).toBe(2);
    expect(f.flush(1000).decidedTo).toBe(2);
    expect(f.flush(4600).decidedTo).toBe(5);
  });

  it("custom cues replace the default ones; a cue without words is ignored", () => {
    const { f } = follower(
      { quotes: [{ ayah: 3, from: 0, to: 7, verifyAt: Number.POSITIVE_INFINITY }] },
      { cues: ["،", "abc def"] },
    );
    // The alignment started before the cue: the cue still holds the words after it.
    expect(f.push(`${w(0, 3)} abc def w5`, 0).decidedTo).toBe(0);
    const plain = follower({}, { cues: ["،", "abc def"] });
    expect(plain.f.push("abc def w2", 0).decidedTo).toBe(2);
    expect(plain.f.push("قال الله تعالى w6", 100).decidedTo).toBe(7); // not a cue any more
  });
});

describe("Quran follower: options and caching", () => {
  it("honours every option", () => {
    const { f, analyses } = follower(
      {
        quotes: [{ ayah: 3, from: 0, to: 5, verifyAt: 5 }],
        wordCount: () => 10,
        couldStart: () => true,
      },
      {
        targetLang: "en",
        maxHoldWords: 2,
        maxHoldMs: 100,
        cueHoldMs: 200,
        genericHoldMs: 50,
        completeWaitWords: 10,
        completeWaitMs: 300,
        pauseReportMs: 5000,
        recentMs: 1000,
        windowWords: 32,
        idleMs: 10,
        ignoreStoplist: false,
        cues: ["abc"],
      },
    );
    expect(f.push(w(0, 5), 0).verses).toEqual([]);
    expect(f.flush(5).verses).toEqual([]);
    expect(analyses).toHaveLength(1); // same words: the analysis is reused
    expect(f.flush(300).verses).toEqual([
      { ...wholeVerse(3, 0, 5), complete: false, approved: null },
    ]);
  });
});
