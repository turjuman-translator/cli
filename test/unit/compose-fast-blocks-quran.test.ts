// FastBlocks and the Quran follower: a recited ayah is shown
// once, with its approved translation; without one, the live chunks become a quoted Quran block.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowerVerse } from "../../src/compose/types.js";
import { createQuranFollower } from "../../src/quran/follower.js";
import { QuranMatcher } from "../../src/quran/matcher.js";
import {
  appendOnly,
  pipeline,
  scriptedFollower,
  seg,
  verse,
} from "./helpers/compose-fast-blocks.js";
import { testCorpus } from "./quran-test-corpus.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const APPROVED_3_102 = "O jullie die geloven, vreest Allah met ware vrees.";

describe("FastBlocks: approved ayat", () => {
  it("shows a recited ayah once, with its approved translation, and drops its live chunks", () => {
    let reported: FollowerVerse | null = null;
    // Words 4.. of the stream are 3:102 (after a 4-word intro), undecided until confirmed.
    const follower = scriptedFollower({
      push: (count, from) => {
        if (reported === null && count >= 9) {
          reported = verse({
            ref: "3:102",
            from: 4,
            to: count,
            approved: APPROVED_3_102,
            uthmani: "يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟",
          });
          return { verses: [reported] };
        }
        if (reported !== null && from >= 4) {
          return { verses: [{ ...reported, to: count, isNew: false }] };
        }
        return { decidedTo: Math.min(count, 4) };
      },
    });
    const p = pipeline({ follower });
    p.fb.update(
      seg("s:1", "قال الله تعالى في", "Allah de Verhevene zei", { startMs: 0, endMs: 900 }),
    );
    p.fb.update(
      seg("s:1", "قال الله تعالى في يا أيها الذين", "Allah de Verhevene zei: O jullie die"),
    );
    expect(p.shown()).toEqual(["Allah ﷾ zei"]);
    p.fb.update(
      seg(
        "s:1",
        "قال الله تعالى في يا أيها الذين آمنوا اتقوا الله",
        "Allah de Verhevene zei: O jullie die geloven, vrees Allah",
      ),
    );
    p.fb.update(
      seg(
        "s:1",
        "قال الله تعالى في يا أيها الذين آمنوا اتقوا الله حق تقاته",
        "Allah de Verhevene zei: O jullie die geloven, vrees Allah zoals Hij gevreesd moet worden.",
        {
          closed: true,
        },
      ),
    );
    const blocks = p.blocks();
    expect(blocks.map((b) => [b.kind, b.text, b.ref])).toEqual([
      ["speech", "Allah ﷾ zei", null],
      ["quran", APPROVED_3_102, "3:102"],
    ]);
    expect(blocks[1]).toMatchObject({
      quranText: "يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟",
      src: null,
      segmentIds: ["s:1"],
    });
    expect(appendOnly(p.out)).toBe(true);
  });

  it("waits for the words before an ayah to be decided before showing it", () => {
    let decided = 1;
    const follower = scriptedFollower({
      push: (count) =>
        count >= 6
          ? {
              decidedTo: decided,
              verses: [
                verse({ ref: "112:1", from: 2, to: 6, approved: "Zeg: Hij is Allah, de Ene." }),
              ],
            }
          : { decidedTo: Math.min(count, decided) },
      flush: () => ({ decidedTo: decided }),
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "ثم قال", "Toen zei hij:"));
    p.fb.update(seg("s:1", "ثم قال قل هو الله أحد", "Toen zei hij: Zeg, Hij is Allah, één."));
    // The follower has decided only the first word: neither the intro nor the ayah shows yet.
    expect(p.blocks()).toEqual([]);
    decided = 6;
    vi.advanceTimersByTime(250); // the ticker flushes the follower
    expect(p.blocks().map((b) => b.kind)).toEqual(["speech", "quran"]);
    expect(p.shown()).toEqual(["Toen zei hij:", "Zeg: Hij is Allah, de Ene."]);
  });

  it("grows the ayah's block with each recited waqf segment", () => {
    let reported = 0;
    const span1 = "Voorzeker, Wij hebben Onze Boodschappers met de duidelijke bewijzen gezonden.";
    const span2 = `${span1} En Wij hebben het ijzer neergezonden.`;
    const follower = scriptedFollower({
      push: (count) => {
        if (reported === 0 && count >= 9) {
          reported = 1;
          return {
            verses: [
              verse({
                ref: "57:25",
                from: 3,
                to: count,
                complete: false,
                approved: span1,
                uthmani: "لَقَدْ أَرْسَلْنَا",
                partial: true,
              }),
            ],
          };
        }
        if (reported === 1 && count >= 13) {
          reported = 2;
          return {
            verses: [
              verse({
                ref: "57:25",
                from: 3,
                to: count,
                complete: false,
                approved: span2,
                uthmani: "لَقَدْ أَرْسَلْنَا … ٱلْحَدِيدَ",
                partial: true,
                isNew: false,
              }),
            ],
          };
        }
        if (reported === 2) {
          // The same text once more (with a stray space): nothing to update.
          return {
            verses: [
              verse({
                ref: "57:25",
                from: 3,
                to: count,
                approved: `${span2} `,
                uthmani: "لَقَدْ أَرْسَلْنَا … ٱلْحَدِيدَ",
                isNew: false,
              }),
            ],
          };
        }
        return { decidedTo: Math.min(count, reported === 0 ? 3 : count) };
      },
      flush: (count) => ({ decidedTo: reported === 0 ? Math.min(count, 3) : count }),
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "كما بين سبحانه", "Zoals Hij heeft uitgelegd:", { closed: true }));
    p.fb.update(
      seg(
        "s:2",
        "لقد أرسلنا رسلنا بالبينات وأنزلنا معهم",
        '"Wij hebben onze gezanten met duidelijke bewijzen gezonden, en samen met hen',
      ),
    );
    let q = p.blocks().filter((b) => b.kind === "quran");
    expect(q.map((b) => [b.ref, b.text, b.quranText])).toEqual([["57:25", span1, "لَقَدْ أَرْسَلْنَا"]]);
    p.fb.update(
      seg(
        "s:2",
        "لقد أرسلنا رسلنا بالبينات وأنزلنا معهم الكتاب والميزان وأنزلنا الحديد",
        '"Wij hebben onze gezanten met duidelijke bewijzen gezonden, en samen met hen het Boek en de Weegschaal. En Wij zonden het ijzer',
        {
          closed: true,
        },
      ),
    );
    q = p.blocks().filter((b) => b.kind === "quran");
    expect(q.map((b) => [b.text, b.quranText])).toEqual([[span2, "لَقَدْ أَرْسَلْنَا … ٱلْحَدِيدَ"]]);
    const id = q[0]?.id ?? "";
    p.fb.update(seg("s:3", "فيه بأس شديد", "Daarin is grote kracht"));
    expect(p.history(id).map((o) => o.type)).toEqual(["block.add", "block.update"]);
    const speech = p.blocks().filter((b) => b.kind !== "quran");
    expect(speech.map((b) => b.text)).toEqual(["Zoals Hij heeft uitgelegd:"]);
    expect(appendOnly(p.out)).toBe(true);
  });

  it("leaves an ayah's block as it is when the same text is reported again", () => {
    const follower = scriptedFollower({
      push: (count) =>
        count === 4
          ? { verses: [verse({ ref: "112:1", from: 0, to: 4, approved: "Zeg: Hij is Allah." })] }
          : {
              verses: [
                verse({
                  ref: "112:1",
                  from: 0,
                  to: count,
                  approved: " Zeg: Hij is Allah.",
                  isNew: false,
                }),
              ],
            },
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قل هو الله أحد", "Zeg: Hij is Allah, Eén."));
    p.fb.update(
      seg("s:1", "قل هو الله أحد الله", "Zeg: Hij is Allah, Eén. Allah", { closed: true }),
    );
    expect(p.blocks()).toMatchObject([
      { kind: "quran", text: "Zeg: Hij is Allah.", quranText: null },
    ]);
    expect(p.history("s:b1")).toHaveLength(1);
  });

  it("does not update an ayah's block that a reset took off the screens", () => {
    const follower = scriptedFollower({
      push: (count) =>
        count === 4
          ? { verses: [verse({ ref: "112:1", from: 0, to: 4, approved: "Zeg: Hij is Allah." })] }
          : {
              verses: [
                verse({
                  ref: "112:1",
                  from: 0,
                  to: count,
                  approved: "Zeg: Hij is Allah, de Ene.",
                  isNew: false,
                }),
              ],
            },
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قل هو الله أحد", "Zeg: Hij is Allah, Eén."));
    expect(p.shown()).toEqual(["Zeg: Hij is Allah."]);
    p.fb.clearHistory();
    const before = p.out.length;
    p.fb.update(
      seg("s:1", "قل هو الله أحد الله", "Zeg: Hij is Allah, Eén. Allah", { closed: true }),
    );
    expect(p.out.slice(before)).toEqual([]);
    expect(p.blocks()).toEqual([]);
  });

  it("shows a repeated ayah only once within two minutes", () => {
    // Each recitation is 4 words, each remark 3.
    const reports: Record<number, FollowerVerse> = {
      4: verse({ ref: "112:1", from: 0, to: 4, approved: "Zeg: Hij is Allah, de Ene." }),
      11: verse({ ref: "112:1", from: 7, to: 11, approved: "Zeg: Hij is Allah, de Ene." }),
      18: verse({ ref: "112:1", from: 14, to: 18, approved: "Zeg: Hij is Allah, de Ene." }),
    };
    const follower = scriptedFollower({
      push: (count) => (reports[count] === undefined ? {} : { verses: [reports[count]] }),
    });
    const p = pipeline({ follower });
    const recite = (k: number) =>
      p.fb.update(seg(`s:${k}`, "قل هو الله أحد", "Zeg: Hij is Allah, Eén.", { closed: true }));
    const speak = (k: number) =>
      p.fb.update(seg(`s:${k}`, "هذه سورة الإخلاص", "Dit is soera al-Ikhlas.", { closed: true }));
    recite(1);
    speak(2);
    vi.advanceTimersByTime(30_000);
    recite(3); // 30 s later: not again
    speak(4);
    expect(p.blocks().filter((b) => b.kind === "quran")).toHaveLength(1);
    vi.advanceTimersByTime(121_000);
    recite(5); // after two minutes: shown again
    expect(p.blocks().filter((b) => b.kind === "quran")).toHaveLength(2);
    // The live chunks of every recitation are dropped, the repeat's too.
    expect(p.shown()).toEqual([
      "Zeg: Hij is Allah, de Ene.",
      "Dit is soera al-Ikhlas.",
      "Dit is soera al-Ikhlas.",
      "Zeg: Hij is Allah, de Ene.",
    ]);
  });

  it("drops the live chunks of a known ayah reported without text", () => {
    const follower = scriptedFollower({
      push: (count) =>
        count === 4 ? { verses: [verse({ ref: "112:1", from: 0, to: 4, isNew: false })] } : {},
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قل هو الله أحد", "Zeg: Hij is Allah, Eén.", { closed: true }));
    expect(p.blocks()).toEqual([]);
  });

  it("shows the live chunks of a chunk that is mostly the khatib's own words", () => {
    const follower = scriptedFollower({
      push: (count) =>
        count === 6
          ? {
              verses: [
                verse({ ref: "112:2", from: 4, to: 6, approved: "Allah, de Behoefteloze." }),
                verse({ ref: "2:255", from: 5, to: 6, approved: null }),
              ],
            }
          : {},
    });
    const p = pipeline({ follower });
    p.fb.update(
      seg(
        "s:1",
        "وهذا ما نقوله دائما الله الصمد",
        "Dit is wat wij altijd zeggen: Allah, de Behoefteloze.",
        {
          closed: true,
        },
      ),
    );
    expect(p.blocks().map((b) => b.kind)).toEqual(["speech", "quran"]);
  });
});

describe("FastBlocks: quoted ayat without an approved translation", () => {
  it("quotes the live chunks with the verified reference, and closes the quote", () => {
    const follower = scriptedFollower({
      push: (count, from) =>
        from >= 2 && from < 8
          ? {
              verses: [
                verse({ ref: "2:255", from: 2, to: count, approved: null, isNew: from === 2 }),
              ],
            }
          : {},
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قال تعالى", "Hij zei:", { closed: true }));
    p.fb.update(seg("s:2", "الله لا إله إلا", "Allah, er is geen god"));
    p.fb.update(
      seg("s:2", "الله لا إله إلا هو الحي", "Allah, er is geen god dan Hij, de Levende", {
        closed: true,
      }),
    );
    let quran = p.blocks().filter((b) => b.kind === "quran");
    expect(quran.map((b) => [b.ref, b.text])).toEqual([
      ["2:255", '"Allah, er is geen god dan Hij, de Levende'],
    ]);
    // The khatib's own words after it: the quote is closed.
    p.fb.update(seg("s:3", "هذه آية الكرسي", "Dit is het Troonvers.", { closed: true }));
    quran = p.blocks().filter((b) => b.kind === "quran");
    expect(quran[0]?.text).toBe('"Allah, er is geen god dan Hij, de Levende"');
    expect(p.shown().at(-1)).toBe("Dit is het Troonvers.");
    expect(appendOnly(p.out)).toBe(true);
  });

  it("closes a quote at a pause, and does not add a quote the text already has", () => {
    const follower = scriptedFollower({
      push: (count, from) => ({ verses: [verse({ ref: "2:255", from, to: count })] }),
    });
    const p = pipeline({ follower });
    p.fb.update(
      seg("s:1", "الله لا إله إلا هو", 'Allah, er is geen god dan Hij"', { closed: true }),
    );
    vi.advanceTimersByTime(1500);
    expect(p.blocks()[0]?.text).toBe('"Allah, er is geen god dan Hij"');
    // A second quote of another ayah opens its own block (and its quote is closed at the pause).
    p.fb.update(seg("s:2", "الحي القيوم", "de Levende", { closed: true }));
    vi.advanceTimersByTime(1500);
    expect(p.blocks().map((b) => b.text)).toEqual([
      '"Allah, er is geen god dan Hij"',
      '"de Levende"',
    ]);
  });

  it("switches to the approved translation when it arrives before any chunk was shown", () => {
    let calls = 0;
    const follower = scriptedFollower({
      push: (count) => {
        calls++;
        if (calls === 1)
          return { decidedTo: 0, verses: [verse({ ref: "112:1", from: 0, to: count })] };
        return {
          verses: [
            verse({
              ref: "112:1",
              from: 0,
              to: count,
              approved: "Zeg: Hij is Allah, de Ene.",
              isNew: false,
            }),
          ],
        };
      },
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قل هو", "Zeg: Hij"));
    expect(p.blocks()).toEqual([]);
    p.fb.update(seg("s:1", "قل هو الله أحد", "Zeg: Hij is Allah, Eén.", { closed: true }));
    expect(p.blocks().map((b) => [b.kind, b.text])).toEqual([
      ["quran", "Zeg: Hij is Allah, de Ene."],
    ]);
  });

  it("keeps quoting live chunks once one was shown, even when the text arrives later", () => {
    let calls = 0;
    const follower = scriptedFollower({
      push: (count) => {
        calls++;
        if (calls === 1) return { verses: [verse({ ref: "112:1", from: 0, to: count })] };
        return {
          verses: [
            verse({
              ref: "112:1",
              from: 0,
              to: count,
              approved: "Zeg: Hij is Allah, de Ene.",
              isNew: false,
            }),
          ],
        };
      },
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قل هو", "Zeg: Hij"));
    p.fb.update(seg("s:1", "قل هو الله أحد", "Zeg: Hij is Allah, Eén.", { closed: true }));
    expect(p.blocks().map((b) => [b.kind, b.text])).toEqual([
      ["quran", '"Zeg: Hij is Allah, Eén.'],
    ]);
  });
});

describe("FastBlocks: a follower that fails or hesitates", () => {
  it("shows the words as plain speech when the follower throws", () => {
    const follower = scriptedFollower();
    follower.push = () => {
      throw new Error("index corrupt");
    };
    follower.flush = () => {
      throw new Error("index corrupt");
    };
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قال الله تعالى", "Allah de Verhevene zei.", { closed: true }));
    expect(p.shown()).toEqual(["Allah ﷾ zei."]);
    expect(p.log.messages("error")).toEqual([
      "quran follower failed; words shown as plain speech",
      "quran follower failed; words shown as plain speech",
    ]);
  });

  it("shows words the follower leaves undecided for 15 s as plain speech", () => {
    const follower = scriptedFollower({
      push: () => ({ decidedTo: 0 }),
      flush: () => ({ decidedTo: 0 }),
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قال الله تعالى", "Allah de Verhevene zei.", { closed: true }));
    vi.advanceTimersByTime(14_750);
    expect(p.blocks()).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(p.shown()).toEqual(["Allah ﷾ zei."]);
    expect(
      p.log.entries.find((e) => e.msg === "undecided words shown as plain speech")?.obj,
    ).toEqual({
      words: 3,
    });
  });

  it("forgets the oldest of many ayat", () => {
    const follower = scriptedFollower({
      push: (count, from) => ({
        verses: [verse({ ref: `2:${count}`, from, to: count, isNew: false })],
      }),
    });
    const p = pipeline({ follower });
    for (let k = 1; k <= 205; k++) p.fb.update(seg(`s:${k}`, "كلمة", "", { closed: true }));
    const verses = (p.fb as unknown as { verses: unknown[] }).verses;
    expect(verses).toHaveLength(200);
  });
});

describe("FastBlocks with the real Quran follower", () => {
  it("shows 3:102 with its approved translation after the khatib's intro", () => {
    const matcher = new QuranMatcher(
      testCorpus({
        "3:102": {
          simple: "يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون",
          uthmani: "يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ ٱتَّقُوا۟ ٱللَّهَ حَقَّ تُقَاتِهِۦ وَلَا تَمُوتُنَّ إِلَّا وَأَنتُم مُّسْلِمُونَ",
          translations: { nl: APPROVED_3_102 },
        },
      }),
      { minWords: 5, minCoverage: 0.6 },
    );
    const p = pipeline({ follower: createQuranFollower(matcher) });
    const intro = "أما بعد فيقول الله تبارك وتعالى في كتابه الكريم";
    const ayah = "يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون";
    p.fb.update(
      seg("s:1", intro, "En verder zegt Allah, de Gezegende en Verhevene, in Zijn edele Boek:"),
    );
    vi.advanceTimersByTime(500);
    p.fb.update(
      seg(
        "s:1",
        `${intro} ${ayah}`,
        "En verder zegt Allah, de Gezegende en Verhevene, in Zijn edele Boek: O gelovigen, vrees Allah zoals Hij gevreesd moet worden, en sterf niet anders dan als moslims.",
        {
          closed: true,
        },
      ),
    );
    vi.advanceTimersByTime(10_000);
    const quran = p.blocks().filter((b) => b.kind === "quran");
    expect(quran.map((b) => [b.ref, b.text])).toEqual([["3:102", APPROVED_3_102]]);
    expect(quran[0]?.quranText).toContain("ٱتَّقُوا۟ ٱللَّهَ");
    expect(p.shown().some((t) => t.includes("gelovigen"))).toBe(false);
    expect(p.shown()[0]).toMatch(/^En verder zegt Allah/);
  });
});
