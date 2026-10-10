import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpusWords } from "../../src/quran/corpus.js";
import { ayahSpan, splitSentences, waqfSegments } from "../../src/quran/spans.js";

interface Verse {
  uthmani: string;
  simple: string;
  nl: string;
}

const verses = JSON.parse(
  readFileSync(new URL("../fixtures/quran-spans.json", import.meta.url), "utf8"),
) as Record<string, Verse>;

/** Tanzil stores some combining marks in non-canonical order: compare Arabic in NFC. */
const nfc = (s: string | undefined) => (s ?? "").normalize("NFC");

function verse(ref: string): Verse {
  const v = verses[ref];
  if (v === undefined) throw new Error(`fixture ${ref} missing`);
  return v;
}

/** Positions [from, to] (inclusive) of a recited phrase in the ayah's simple-clean words. */
function recited(v: Verse, phrase: string): { from: number; to: number } {
  const words = corpusWords(v.simple);
  const want = corpusWords(phrase);
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, k) => words[i + k] === w)) return { from: i, to: i + want.length - 1 };
  }
  throw new Error(`phrase not in ayah: ${phrase}`);
}

function span(ref: string, phrase: string) {
  const v = verse(ref);
  const r = recited(v, phrase);
  return ayahSpan({
    uthmani: v.uthmani,
    simpleWords: corpusWords(v.simple),
    translation: v.nl,
    from: r.from,
    to: r.to,
    endMarker: "۝",
  });
}

describe("splitSentences", () => {
  it("keeps abbreviations and parentheses inside one sentence", () => {
    expect(
      splitSentences(
        "Opdat Allah zou doen weten wie Hem helpt, zonder dat hij (bv. Allah en het Paradijs) kan waarnemen. Voorwaar, Allah is Sterk, Geweldig.",
      ),
    ).toEqual([
      "Opdat Allah zou doen weten wie Hem helpt, zonder dat hij (bv. Allah en het Paradijs) kan waarnemen.",
      "Voorwaar, Allah is Sterk, Geweldig.",
    ]);
  });

  it("splits after ! and ?", () => {
    expect(splitSentences("O jullie die geloven! Weest standvastig. Wie is er?  Niemand.")).toEqual(
      ["O jullie die geloven!", "Weest standvastig.", "Wie is er?", "Niemand."],
    );
  });
});

describe("waqfSegments", () => {
  it("splits the Uthmani text at stop marks, not at ۙ (do not stop)", () => {
    const segs = waqfSegments(verse("57:25").uthmani);
    expect(segs.map((s) => s.words.length)).toEqual([11, 13, 4]);
    expect(nfc(segs[0]?.display)).toBe(
      nfc("لَقَدْ أَرْسَلْنَا رُسُلَنَا بِٱلْبَيِّنَـٰتِ وَأَنزَلْنَا مَعَهُمُ ٱلْكِتَـٰبَ وَٱلْمِيزَانَ لِيَقُومَ ٱلنَّاسُ بِٱلْقِسْطِ"),
    );
    expect(waqfSegments("كَلَّا ۙ بَلْ رَانَ")).toHaveLength(1);
  });
});

describe("ayahSpan", () => {
  it("57:25: the first waqf segment maps to the first sentence (ASR gap inside)", () => {
    const v = verse("57:25");
    const s = ayahSpan({
      uthmani: v.uthmani,
      simpleWords: corpusWords(v.simple),
      translation: v.nl,
      // لقد … الكتاب recited, والميزان ليقوم الناس lost by the recognizer, بالقسط heard again
      from: 0,
      to: 10,
      endMarker: "۝",
    });
    expect(s?.full).toBe(false);
    expect(s?.text).toBe(
      "Voorzeker, Wij hebben Onze Boodschappers met de duidelijke bewijzen gezonden en Wij hebben met hen het Boek en de wetgeving neergezonden, opdat de mens in het midden zou staan (rechtvaardig zou handelen).",
    );
    expect(s?.arabic).toBe(waqfSegments(v.uthmani)[0]?.display);
  });

  it("5:8: a quote from the middle maps by position when the counts differ (5 segments, 6 sentences)", () => {
    const s = span("5:8", "ولا يجرمنكم شنآن قوم على ألا تعدلوا اعدلوا هو أقرب للتقوى");
    expect(s?.full).toBe(false);
    expect(s?.text).toBe(
      "En laat de haat van een volk jullie er niet we brengen niet rechtvaardig te wezen. Weest rechtvaardig, dat is het dichtst bij Taqwa.",
    );
    expect(nfc(s?.arabic).startsWith(nfc("وَلَا يَجْرِمَنَّكُمْ"))).toBe(true);
    expect(nfc(s?.arabic).endsWith(nfc("لِلتَّقْوَىٰ"))).toBe(true);
    expect(s?.arabic).toContain("ۚ"); // the pause mark between the two segments stays
  });

  it("16:90: most of the first segment → its sentence only", () => {
    const s = span(
      "16:90",
      "إن الله يأمر بالعدل والإحسان وإيتاء ذي القربى وينهى عن الفحشاء والمنكر",
    );
    expect(s?.text).toBe(
      "Allah beveelt rechtvaardigheid en het goede en het geven aan de verwanten en Hij verbiedt de zedeloosheid en het verwerpelijke en de opstandigheid.",
    );
  });

  it("6:152: one segment in the middle, equal counts → that sentence", () => {
    const s = span("6:152", "وإذا قلتم فاعدلوا ولو كان ذا قربى");
    expect(s?.text).toBe(
      "En wanneer jullie rechtspreken, weest dan rechtvaardig, ook al betreft het een verwant.",
    );
    expect(nfc(s?.arabic)).toBe(nfc("وَإِذَا قُلْتُمْ فَٱعْدِلُوا۟ وَلَوْ كَانَ ذَا قُرْبَىٰ"));
  });

  it("a whole recitation is the whole ayah, with the end marker", () => {
    const v = verse("16:90");
    const words = corpusWords(v.simple);
    const s = ayahSpan({
      uthmani: v.uthmani,
      simpleWords: words,
      translation: v.nl,
      from: 0,
      to: words.length - 1,
      endMarker: "۝",
    });
    expect(s?.full).toBe(true);
    expect(s?.text).toBe(v.nl);
    expect(s?.arabic).toBe(`${v.uthmani} ۝`);
  });

  it("aligns Uthmani يَـٰٓأَيُّهَا (one word) with simple-clean يا أيها (two words)", () => {
    const s = span("5:8", "يا أيها الذين آمنوا كونوا قوامين لله شهداء بالقسط");
    expect(s?.text).toBe(
      "O jullie die geloven! Weest standvastig voor Allah als rechtvaardige getuigen.",
    );
    expect(nfc(s?.arabic).startsWith(nfc("يَـٰٓأَيُّهَا ٱلَّذِينَ"))).toBe(true);
    expect(nfc(s?.arabic).endsWith(nfc("بِٱلْقِسْطِ"))).toBe(true);
  });
});
