// Regression cases for normalizeIslamicTerms (src/text/honorifics.ts): Allah never "God", but
// إله ("a/one God") and Quran verse text stay exactly as written; honorific ligatures tidy.
// Usage: pnpm exec tsx scripts/eval-honorifics.ts   (exit 1 on any failure)
import { normalizeIslamicTerms, splitHonorifics } from "../src/text/honorifics.js";

interface Case {
  lang: string;
  input: string;
  want: string;
  quran?: boolean;
  /** The Arabic the caption translates (for spoken honorifics). */
  src?: string;
}

const same = (lang: string, input: string, quran = false): Case => ({
  lang,
  input,
  want: input,
  quran,
});

const cases: Case[] = [
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
  same("nl", 'Mohammed ﷺ "de Betrouwbare" werd hij genoemd.'),
  same("nl", "Abu Bakr, moge Allah hem zegenen en vrede schenken, zei"),
  // addresses to Allah
  { lang: "nl", input: "Mijn God, zegen Mohammed.", want: "O Allah, zegen Mohammed." },
  {
    lang: "nl",
    input: "O God, vergeef ons onze zonden.",
    want: "O Allah, vergeef ons onze zonden.",
  },
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
  same("nl", "In de godsdienst is geen dwang; goden en afgoden."),
  same("nl", "Hij is één God."),
  same("nl", "Allah is de Enige God."),
  same("nl", "Voorwaar, Hij is een God."),
  // Quran verse text (Siregar) is never rewritten
  same(
    "nl",
    "En jullie god is één God. Geen god is er dan Hij, de Erbarmer, de Meest Barmhartige.",
    true,
  ),
  same(
    "nl",
    'En Allah zei: "Neemt geen twee goden. Voorwaar, Hij is een God. Vreest daarom Mij alleen."',
    true,
  ),
  same("nl", 'Om te waarschuwen: "Er is geen God dan Ik, dus vreest Mij."', true),
  same("nl", "Wij zullen uw God aanbidden, de God van uw vaderen.", true),
  // English
  { lang: "en", input: "The Prophet (peace be upon him) said", want: "The Prophet ﷺ said" },
  { lang: "en", input: "Musa (peace be upon him) said", want: "Musa ﵇ said" },
  { lang: "en", input: "My God, bless Muhammad.", want: "O Allah, bless Muhammad." },
  { lang: "en", input: "There is no God but Allah.", want: "There is no god but Allah." },
  { lang: "en", input: "God's mercy is vast.", want: "Allah's mercy is vast." },
  { lang: "en", input: "Mohammed (saw) said", want: "Muhammad ﷺ said" },
  same("en", "He is but one God."),
  same("en", "We met (as) agreed."),
  // other languages: only ligature tidying
  same("fr", "Il a dit : « Allah est grand » !"),
  // Spoken honorifics in Soniox's Dutch, only where the Arabic says them
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
    src: "انظر إلى قول الله سبحانه وتعالى:",
    input: "Kijk naar de woorden van Allah, de Verhevene:",
    want: "Kijk naar de woorden van Allah ﷾:",
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
    src: "وقال الإمام أحمد رحمه الله.",
    input: "En imam Ahmad, moge Allah hem genadig zijn.",
    want: "En imam Ahmad ﵀.",
  },
  {
    lang: "nl",
    src: "وقال الله تبارك وتعالى.",
    input: "en Allah, de gezegende en verhevene, zei:",
    want: "en Allah ﵎ zei:",
  },
  // … never where the Arabic has no honorific (al-ʿAliyy, an attribute)
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
];

let fail = 0;
for (const c of cases) {
  const opts = { quran: c.quran === true, ...(c.src === undefined ? {} : { src: c.src }) };
  const got = normalizeIslamicTerms(c.input, c.lang, opts);
  const again = normalizeIslamicTerms(got, c.lang, opts);
  const ok = got === c.want && again === got;
  if (!ok) {
    fail += 1;
    console.log(`FAIL [${c.lang}${c.quran ? " quran" : ""}] ${c.input}`);
    console.log(`     got  ${got}${again !== got ? `\n     twice ${again}` : ""}`);
    console.log(`     want ${c.want}`);
  }
}
const runs = splitHonorifics("Mohammed ﷺ zei");
if (runs.length !== 3 || runs[1]?.honorific !== true) {
  fail += 1;
  console.log("FAIL splitHonorifics");
}
console.log(
  fail === 0 ? `all ${cases.length + 1} checks pass` : `${fail} of ${cases.length + 1} FAIL`,
);
process.exit(fail === 0 ? 0 : 1);
