import { describe, expect, it } from "vitest";
import {
  HONORIFIC_LIGATURES,
  isHonorific,
  normalizeIslamicTerms,
  SAW,
  splitHonorifics,
} from "../../src/text/honorifics.js";

interface Case {
  lang: string;
  input: string;
  want: string;
  quran?: boolean;
  /** The Arabic the caption translates (spoken honorifics). */
  src?: string;
}

const same = (lang: string, input: string, quran = false): Case => ({
  lang,
  input,
  want: input,
  quran,
});

/** Regression cases (also in scripts/eval-honorifics.ts), plus the rule paths it does not hit. */
const CASES: Case[] = [
  // salawat and honorifics
  {
    lang: "nl",
    input:
      'De Profeet, vrede en zegeningen zij met hem, zei: "Daden worden beoordeeld naar de intenties."',
    want: 'De Profeet ﷺ zei: "Daden worden beoordeeld naar de intenties."',
  },
  {
    lang: "nl",
    input: "Mohammed (vzmh) is de laatste profeet.",
    want: "Mohammed ﷺ is de laatste profeet.",
  },
  {
    lang: "nl",
    input: "Moesa (vrede zij met hem) sprak tot zijn volk.",
    want: "Moesa ﵇ sprak tot zijn volk.",
  },
  {
    lang: "nl",
    input: "Muhammad ﷺ ﷺ, de Boodschapper van Allah ﷺ , zei",
    want: "Mohammed ﷺ, de Boodschapper van Allah ﷺ, zei",
  },
  { lang: "nl", input: "Allah (swt) zegt", want: "Allah ﷾ zegt" },
  { lang: "nl", input: "Allah, subhanahu wa ta'ala, zegt", want: "Allah ﷾ zegt" },
  same("nl", "Abu Bakr ﵁ zei"),
  { lang: "nl", input: "De Profeet (sallallahu alayhi wa sallam) zei", want: "De Profeet ﷺ zei" },
  {
    lang: "nl",
    input: "En de Boodschapper van Allah, ṣallallāhu ʿalayhi wa sallam, zei:",
    want: "En de Boodschapper van Allah ﷺ zei:",
  },
  { lang: "nl", input: "Allah, subḥānahu wa taʿālā, zegt", want: "Allah ﷾ zegt" },
  { lang: "nl", input: "Allah ʿazza wa jalla zegt", want: "Allah ﷿ zegt" },
  { lang: "nl", input: "Allah, jalla jalaluhu, zegt", want: "Allah ﷻ zegt" },
  same("nl", 'Mohammed ﷺ "de Betrouwbare" werd hij genoemd.'),
  // "Moge Allah hem zegenen en vrede schenken": ﷺ only after the Prophet.
  same("nl", "Abu Bakr, moge Allah hem zegenen en vrede schenken, zei"),
  {
    lang: "nl",
    input: "De Profeet, moge Allah hem zegenen en vrede schenken, zei",
    want: "De Profeet ﷺ zei",
  },
  // addresses to Allah
  { lang: "nl", input: "Mijn God, zegen Mohammed.", want: "O Allah, zegen Mohammed." },
  {
    lang: "nl",
    input: "O God, vergeef ons onze zonden.",
    want: "O Allah, vergeef ons onze zonden.",
  },
  { lang: "nl", input: "God, vergeef ons.", want: "O Allah, vergeef ons." },
  { lang: "nl", input: "Wij smeken: oh God van genade.", want: "Wij smeken: O Allah van genade." },
  {
    lang: "nl",
    input: "God, de Barmhartige, ziet alles.",
    want: "Allah, de Barmhartige, ziet alles.",
  },
  // the name vs a deity
  { lang: "nl", input: "Er is geen God dan Allah.", want: "Er is geen god dan Allah." },
  {
    lang: "nl",
    input: 'God zegt in de Koran: "Vrees Mij."',
    want: 'Allah zegt in de Koran: "Vrees Mij."',
  },
  { lang: "nl", input: "Dit is Gods genade.", want: "Dit is Allahs genade." },
  { lang: "nl", input: "Hij aanbad een valse God.", want: "Hij aanbad een valse god." },
  same("nl", "Er is geen god dan Allah en Mohammed is Zijn Boodschapper."),
  same("nl", "Hij is één God."),
  same("nl", "Allah is de Enige God."),
  // Quran verse text (Siregar) is never rewritten
  same("nl", "En jullie god is één God. Geen god is er dan Hij, de Erbarmer.", true),
  same("nl", 'Om te waarschuwen: "Er is geen God dan Ik, dus vreest Mij."', true),
  // English
  { lang: "en", input: "The Prophet (peace be upon him) said", want: "The Prophet ﷺ said" },
  { lang: "en", input: "Musa (peace be upon him) said", want: "Musa ﵇ said" },
  { lang: "en", input: "Musa (as) said", want: "Musa ﵇ said" },
  {
    lang: "en",
    input: "The Messenger of Allah, peace and blessings be upon him, said",
    want: "The Messenger of Allah ﷺ said",
  },
  {
    lang: "en",
    input: "The Prophet, may Allah bless him and grant him peace, said",
    want: "The Prophet ﷺ said",
  },
  same("en", "Umar, may Allah bless him and grant him peace, said"),
  { lang: "en", input: "My God, bless Muhammad.", want: "O Allah, bless Muhammad." },
  { lang: "en", input: "Oh my Lord God, forgive us.", want: "O Allah, forgive us." },
  { lang: "en", input: "God, guide us.", want: "O Allah, guide us." },
  { lang: "en", input: "There is no God but Allah.", want: "There is no god but Allah." },
  { lang: "en", input: "God's mercy is vast.", want: "Allah's mercy is vast." },
  { lang: "en", input: "God sees all.", want: "Allah sees all." },
  { lang: "en", input: "Mohammed (saw) said", want: "Muhammad ﷺ said" },
  same("en", "He is but one God."),
  same("en", "We met (as) agreed."),
  // a region subtag counts as its language
  { lang: "EN-gb", input: "God sees all.", want: "Allah sees all." },
  // other languages: transliterations and tidy ligatures only, spacing as written
  same("fr", "Il a dit : « Allah est grand » !"),
  {
    lang: "fr",
    input: "Le Prophète (saws) a dit : « Dieu » !",
    want: "Le Prophète ﷺ a dit : « Dieu » !",
  },
  same("fr", "God est un mot anglais ."),
  // spoken honorifics in Soniox's Dutch, only where the Arabic says them
  {
    lang: "nl",
    src: "الله سبحانه وتعالى خلق السماوات والأرض.",
    input: "Allah, de Verhevene, schiep de hemelen en de aarde.",
    want: "Allah ﷾ schiep de hemelen en de aarde.",
  },
  {
    lang: "nl",
    src: "بالحق. وأنزل سبحانه وتعالى الكتاب والميزان",
    input: "Met waarheid. En Hij, de Verhevene, liet het Boek en de Weegschaal neerdalen",
    want: "Met waarheid. En Hij ﷾ liet het Boek en de Weegschaal neerdalen",
  },
  {
    lang: "nl",
    src: "قال الله تعالى",
    input: "Allah, de Allerhoogste, zei:",
    want: "Allah ﷾ zei:",
  },
  {
    lang: "nl",
    src: "يقول الله سبحانه وتعالى",
    input: "Allah, glorieus en verheven is Hij, zegt",
    want: "Allah ﷾ zegt",
  },
  {
    lang: "nl",
    src: "قال الله عز وجل",
    input: "Allah, de Almachtige en Majestueuze, zei:",
    want: "Allah ﷿ zei:",
  },
  {
    lang: "nl",
    src: "قال الله تبارك وتعالى",
    input: "Allah, gezegend en verheven is Hij, zei",
    want: "Allah ﵎ zei",
  },
  {
    lang: "nl",
    src: "قال الله جل جلاله",
    input: "Allah, verheven is Zijn majesteit, zei",
    want: "Allah ﷻ zei",
  },
  {
    lang: "nl",
    src: "وقال عمر بن الخطاب رضي الله عنه.",
    input: "En Umar ibn al-Khattab, moge Allah tevreden met hem zijn.",
    want: "En Umar ibn al-Khattab ﵁.",
  },
  {
    lang: "nl",
    src: "قالت عائشة رضي الله عنها",
    input: "Aisha, moge Allah tevreden met haar zijn, zei",
    want: "Aisha ﵂ zei",
  },
  {
    lang: "nl",
    src: "عن ابن عمر رضي الله عنهما",
    input: "Van Ibn Umar, moge Allah tevreden zijn met hen beiden, die zei",
    want: "Van Ibn Umar ﵄ die zei",
  },
  {
    lang: "nl",
    src: "الصحابة رضي الله عنهم",
    input: "De metgezellen, moge Allah tevreden met hen zijn, zeiden",
    want: "De metgezellen ﵃ zeiden",
  },
  {
    lang: "nl",
    src: "وقال الإمام أحمد رحمه الله.",
    input: "En imam Ahmad, moge Allah hem genadig zijn.",
    want: "En imam Ahmad ﵀.",
  },
  {
    lang: "nl",
    src: "قال العلماء رحمهم الله",
    input: "De geleerden, moge Allah zich over hen ontfermen, zeiden",
    want: "De geleerden ﵏ zeiden",
  },
  {
    lang: "nl",
    src: "وقال الله تبارك وتعالى.",
    input: "en Allah, de gezegende en verhevene, zei:",
    want: "en Allah ﵎ zei:",
  },
  // … never where the Arabic has no honorific (al-ʿAliyy, an attribute)
  same("nl", "En Hij is de Verhevene, de Grote."),
  {
    lang: "nl",
    src: "وهو العلي الكبير",
    input: "En Hij is de Verhevene, de Grote.",
    want: "En Hij is de Verhevene, de Grote.",
  },
  {
    lang: "nl",
    src: "سبحانه وتعالى",
    input: "En Hij is de Verhevene.",
    want: "En Hij is de Verhevene.",
  },
  // spoken honorifics are Dutch only: English keeps the words
  {
    lang: "en",
    src: "الله سبحانه وتعالى",
    input: "Allah, the Exalted, created",
    want: "Allah, the Exalted, created",
  },
];

describe("normalizeIslamicTerms", () => {
  for (const c of CASES) {
    it(`[${c.lang}${c.quran === true ? " quran" : ""}${c.src === undefined ? "" : " src"}] ${c.input}`, () => {
      const opts = { quran: c.quran === true, ...(c.src === undefined ? {} : { src: c.src }) };
      const got = normalizeIslamicTerms(c.input, c.lang, opts);
      expect(got).toBe(c.want);
      // Idempotent: a second pass changes nothing.
      expect(normalizeIslamicTerms(got, c.lang, opts)).toBe(got);
    });
  }

  it("works without options", () => {
    expect(normalizeIslamicTerms("God sees all.", "en")).toBe("Allah sees all.");
  });

  it("only tidies ligature spacing in Quran blocks, keeping the language's punctuation spacing", () => {
    expect(normalizeIslamicTerms("Mohammed ( ﷺ ) , de God .", "nl", { quran: true })).toBe(
      "Mohammed ﷺ, de God .",
    );
  });
});

describe("honorific ligatures", () => {
  it("lists one ligature per spoken phrase, longer phrases first", () => {
    expect(HONORIFIC_LIGATURES.find((h) => h.char === SAW)?.ar).toBe("صلى الله عليه وسلم");
    const salawat = HONORIFIC_LIGATURES.findIndex((h) => h.ar === "عليه الصلاة والسلام");
    const salam = HONORIFIC_LIGATURES.findIndex((h) => h.ar === "عليه السلام");
    expect(salawat).toBeLessThan(salam);
    for (const h of HONORIFIC_LIGATURES) expect(isHonorific(h.char), h.name).toBe(true);
  });

  it("isHonorific is true for exactly one ligature character", () => {
    expect(isHonorific(SAW)).toBe(true);
    expect(isHonorific("ﷻ")).toBe(true);
    expect(isHonorific("a")).toBe(false);
    expect(isHonorific(`${SAW}${SAW}`)).toBe(false);
    expect(isHonorific("")).toBe(false);
  });

  it("splitHonorifics separates plain runs from ligatures", () => {
    expect(splitHonorifics("Mohammed ﷺ zei")).toEqual([
      { text: "Mohammed ", honorific: false },
      { text: SAW, honorific: true },
      { text: " zei", honorific: false },
    ]);
    // Leading, adjacent and trailing ligatures: no empty plain runs.
    expect(splitHonorifics("﷾﷿ Allah ﷻ")).toEqual([
      { text: "﷾", honorific: true },
      { text: "﷿", honorific: true },
      { text: " Allah ", honorific: false },
      { text: "ﷻ", honorific: true },
    ]);
    expect(splitHonorifics("")).toEqual([]);
    expect(splitHonorifics("geen")).toEqual([{ text: "geen", honorific: false }]);
  });
});
