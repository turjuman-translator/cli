// Islamic names and honorifics in translated captions:
// - Allah is never "God"; اللهم is "O Allah", never "My God".
// - Spoken honorifics are shown as their single Unicode ligature (ﷺ, ﷾, ﷿, ﵇, ﵁, …). All of
//   them are in the bundled Noto Naskh Arabic, and the renderers style them (`.cap-hon`).
// normalizeIslamicTerms() applies these rules to every translated caption, deterministically.
// Browser-safe (no Node imports): used by the block pipeline (server) and the renderers (web).

export interface HonorificLigature {
  /** As spoken (Arabic). */
  ar: string;
  char: string;
  /** Transliteration: the target Soniox gets for the ligature in its translation terms. */
  name: string;
}

/** Spoken honorific → ligature. Longer phrases first (عليه الصلاة والسلام before عليه السلام). */
export const HONORIFIC_LIGATURES: readonly HonorificLigature[] = [
  { ar: "صلى الله عليه وآله وسلم", char: "﵌", name: "sallallahu alayhi wa alihi wa sallam" },
  { ar: "صلى الله عليه وسلم", char: "ﷺ", name: "sallallahu alayhi wa sallam" },
  { ar: "عليه الصلاة والسلام", char: "﵊", name: "alayhi as-salatu was-salam" },
  { ar: "سبحانه وتعالى", char: "﷾", name: "subhanahu wa ta'ala" },
  { ar: "تبارك وتعالى", char: "﵎", name: "tabaraka wa ta'ala" },
  { ar: "عز وجل", char: "﷿", name: "azza wa jall" },
  { ar: "جل جلاله", char: "ﷻ", name: "jalla jalaluhu" },
  { ar: "رضي الله عنهما", char: "﵄", name: "radiyallahu anhuma" },
  { ar: "رضي الله عنهم", char: "﵃", name: "radiyallahu anhum" },
  { ar: "رضي الله عنها", char: "﵂", name: "radiyallahu anha" },
  { ar: "رضي الله عنه", char: "﵁", name: "radiyallahu anhu" },
  { ar: "عليهم السلام", char: "﵈", name: "alayhim as-salam" },
  { ar: "عليها السلام", char: "﵍", name: "alayha as-salam" },
  { ar: "عليه السلام", char: "﵇", name: "alayhi as-salam" },
  { ar: "رحمهم الله", char: "﵏", name: "rahimahumullah" },
  { ar: "رحمه الله", char: "﵀", name: "rahimahullah" },
];

export const SAW = "ﷺ"; // ﷺ
const ALAYHI_SALAM = "﵇"; // ﵇
const SWT = "﷾"; // ﷾
const AZZA_WA_JALL = "﷿"; // ﷿
const JALLA = "ﷻ"; // ﷻ

const HON = "\\uFD40-\\uFD4F\\uFDFA\\uFDFB\\uFDFE\\uFDFF";
const HON_CHAR = new RegExp(`^[${HON}]$`);

/** True for one honorific ligature character. */
export function isHonorific(ch: string): boolean {
  return HON_CHAR.test(ch);
}

export interface TextRun {
  text: string;
  honorific: boolean;
}

/** Plain runs and honorific characters, for renderers that style the latter (`.cap-hon`). */
export function splitHonorifics(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(`[${HON}]`, "g"))) {
    const i = m.index;
    if (i > last) runs.push({ text: text.slice(last, i), honorific: false });
    runs.push({ text: m[0], honorific: true });
    last = i + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), honorific: false });
  return runs;
}

/** Text right before a match refers to the Prophet ﷺ (decides ﷺ vs ﵇ for "peace be upon him"). */
const PROPHET_BEFORE =
  /(?:Mohammed|Muhammad|Mohammad|Muhammed|Mohamed|Profeet|Boodschapper(?: van Allah)?|Gezant(?: van Allah)?|Prophet|Messenger(?: of Allah)?)[\s,]*$/i;

type Replacer = (match: string, offset: number, whole: string) => string;

function byContext(match: string, offset: number, whole: string): string {
  void match;
  return PROPHET_BEFORE.test(whole.slice(Math.max(0, offset - 40), offset))
    ? ` ${SAW}`
    : ` ${ALAYHI_SALAM}`;
}

/** ﷺ only right after the Prophet; any other person keeps the phrase as written. */
function prophetOnly(match: string, offset: number, whole: string): string {
  return PROPHET_BEFORE.test(whole.slice(Math.max(0, offset - 40), offset)) ? ` ${SAW}` : match;
}

interface Rule {
  re: RegExp;
  to: string | Replacer;
}

// Any language: transliterations and abbreviations.
const COMMON: Rule[] = [
  {
    // Also with transcription accents: "ṣallallāhu ʿalayhi wa sallam".
    re: /[,(]?\s*[sṣ][aāe]ll?[aāe]?\s*-?\s*[aā]?ll?[aā]{1,2}[hḥ](?:[uūo])?\s*['’‘`ʿʾ]?\s*[aā]?l[aā][iīy][hḥ][iīe]\s+wa\s*-?\s*[sṣ][aā]ll?[aā]m(?:\s*[,)])?/gi,
    to: ` ${SAW}`,
  },
  { re: /\(\s*(?:s\.?\s?a\.?\s?w\.?(?:\s?s\.?)?|saws?|sas)\s*\)/gi, to: ` ${SAW}` },
  { re: /\(\s*(?:swt|s\.\s?w\.\s?t\.?)\s*\)/gi, to: ` ${SWT}` },
  {
    re: /[,(]?\s*[sṣ]ub[hḥ][aā]+nahu\s+wa\s*-?\s*ta['’‘`ʿʾ]?[aā]+l[aā]+(?:\s*[,)])?/gi,
    to: ` ${SWT}`,
  },
  { re: /[,(]?\s*['’‘`ʿʾ]?[aā]zza\s+wa\s*-?\s*jall?[aā]?\b(?:\s*[,)])?/gi, to: ` ${AZZA_WA_JALL}` },
  { re: /[,(]?\s*jall?[aā]\s+jal[aā]+l(?:uhu|ūhu|ohu|uh)\b(?:\s*[,)])?/gi, to: ` ${JALLA}` },
];

// Words before "God" that make it a deity (إله: "een God", "één God", "de Enige God", "uw God")
// rather than the name الله. No \b: JS word boundaries don't see letters like "é".
const NL_DEITY_BEFORE =
  "(?<!(?:[Dd]e|[Hh]et|[Ee]en|[ÉéEe]én|[Ee]ne|[Ee]nige|[Ww]are|[Gg]een|[Ee]lke|[Ii]edere|[Oo]nze|[Uu]w|[Jj]ullie|[Hh]un|[Zz]ijn|[Hh]aar|[Mm]ijn|[Dd]ie|[Dd]eze|[Ww]elke|[Vv]alse|[Aa]ndere)\\s)";
const EN_DEITY_BEFORE =
  "(?<!(?:[Tt]he|[Aa]|[Aa]n|[Nn]o|[Aa]ny|[Ee]very|[Oo]ur|[Yy]our|[Tt]heir|[Hh]is|[Hh]er|[Mm]y|[Tt]hat|[Tt]his|[Ww]hich|[Ff]alse|[Oo]ther|[Oo]ne|[Oo]nly|[Tt]rue)\\s)";
const SENTENCE_START = '(^|[.!?…:;"“„«]\\s*)';
const NL_IMPERATIVE =
  "(?:zegen|vergeef|help|geef|leid|bescherm|maak|neem|schenk|wees|laat|red|aanvaard|ontferm)";
const EN_IMPERATIVE = "(?:bless|forgive|help|give|guide|protect|make|grant|accept|have)";

const DUTCH: Rule[] = [
  // Salawat paraphrases (only ever said for the Prophet ﷺ).
  {
    re: /[,(]?\s*(?:moge\s+)?(?:Allah['’]?s\s+)?(?:de\s+)?(?:vrede\s+en\s+(?:de\s+)?zegen(?:ingen|ing)?|zegen(?:ingen|ing)?\s+en\s+vrede)(?:\s+van\s+Allah)?\s+(?:(?:zij|zijn|rusten)\s+(?:met|op|over)\s+hem|(?:met|op|over)\s+hem\s+(?:zijn|zij|rusten))\s*[,)]?/gi,
    to: ` ${SAW}`,
  },
  // "Moge Allah hem zegenen en vrede schenken" can be said of anyone: ﷺ only after the Prophet.
  {
    re: /[,(]?\s*(?:moge\s+)?Allah\s+(?:hem\s+zegenen|zegene\s+hem)\s+en\s+(?:hem\s+)?(?:vrede\s+(?:schenken|geven|schenke)|schenke\s+hem\s+vrede|groeten)\s*[,)]?/gi,
    to: prophetOnly,
  },
  // "Vrede zij met hem" is said for every prophet: ﷺ after the Prophet, otherwise ﵇.
  {
    re: /[,(]?\s*(?:moge\s+)?(?:de\s+)?vrede\s+(?:(?:zij|zijn)\s+met\s+hem|met\s+hem\s+(?:zij|zijn))\s*[,)]?|\(\s*(?:vzmh|v\.\s?z\.\s?m\.\s?h\.?)\s*\)/gi,
    to: byContext,
  },
  // "Er is geen god dan Allah": a deity is lowercase god ("een God" / "één God" stay: إله واحد).
  { re: /\b(geen|elke|valse|andere)\s+God\b/g, to: "$1 god" },
  // Addresses to Allah (اللهم, إلهي, يا رب) need an explicit vocative or an imperative after them.
  {
    re: new RegExp(
      `${SENTENCE_START}(?:[Oo]h?\\s+)(?:mijn\\s+|onze\\s+|lieve\\s+)?(?:Heer\\s+)?God\\b`,
      "g",
    ),
    to: "$1O Allah",
  },
  {
    re: new RegExp(
      `${SENTENCE_START}(?:[Mm]ijn|[Oo]nze|[Ll]ieve)\\s+(?:Heer\\s+)?God\\b(?=\\s*[,!]|\\s+${NL_IMPERATIVE}\\b)`,
      "g",
    ),
    to: "$1O Allah",
  },
  {
    re: new RegExp(`${SENTENCE_START}God\\b(?=\\s*,?\\s*${NL_IMPERATIVE}\\b)`, "g"),
    to: "$1O Allah",
  },
  { re: /\b[Oo]h?\s+God\b/g, to: "O Allah" },
  // Any other "God" is the name: Allah.
  { re: new RegExp(`${NL_DEITY_BEFORE}\\bGod\\b`, "g"), to: "Allah" },
  { re: new RegExp(`${NL_DEITY_BEFORE}\\bGods\\b`, "g"), to: "Allahs" },
  { re: /\b(?:Muhammad|Mohammad|Muhammed|Mohamed|Mohamad)\b/g, to: "Mohammed" },
];

// Soniox translates a spoken honorific into words ("Allah, de Verhevene, …").
// Where the Arabic actually says it, the paraphrase right after Allah / Hij / Hem becomes the
// ligature ("Allah ﷾ …"). Without the Arabic phrase nothing changes: "Hij is de Verhevene"
// (العلي) is a name of Allah, not an honorific.
const AR_TASHKEEL = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const AFTER_ALLAH = "(?<=\\b(?:Allah|Allahs|Hij|Hem|Zijn|Heer|God|Schepper))";
const nlAfterAllah = (body: string) =>
  new RegExp(`${AFTER_ALLAH}\\s*,?\\s*(?:${body})\\s*,?`, "gi"); // Soniox writes "de gezegende en verhevene" in lower case too

interface SpokenRule {
  /** The Arabic phrase (without tashkeel) that must occur in the source. */
  ar: RegExp;
  char: string;
  nl: RegExp[];
}

const NL_SPOKEN: SpokenRule[] = [
  {
    ar: /عز\s+وجل/,
    char: AZZA_WA_JALL,
    nl: [
      nlAfterAllah(
        "(?:de\\s+)?(?:Al)?(?:machtige|Machtige|Geweldige|Verhevene|Geëerde|Edele)\\s+en\\s+(?:de\\s+)?(?:Majestueuze|Majesteitelijke|Verhevene|Glorieuze|Luisterrijke|Heerlijke|Geduchte|Groots?e)",
      ),
      nlAfterAllah(
        "(?:machtig|geweldig|verheven)\\s+en\\s+(?:majestueus|verheven|glorieus|groots?)\\s+(?:is|zij)\\s+Hij",
      ),
    ],
  },
  {
    ar: /تبارك\s+وتعال[ىي]/,
    char: "﵎",
    nl: [
      nlAfterAllah("(?:de\\s+)?Gezegende\\s+en\\s+(?:de\\s+)?(?:Verhevene|Allerhoogste)"),
      nlAfterAllah("gezegend\\s+en\\s+(?:verheven|hoog)\\s+(?:is|zij)\\s+Hij"),
    ],
  },
  {
    ar: /جل\s+(?:جلاله|وعلا|شأنه)/,
    char: JALLA,
    nl: [
      nlAfterAllah(
        "(?:verheven|groot|hoog)\\s+(?:is|zij)\\s+Zijn\\s+(?:majesteit|grootheid|luister)",
      ),
      nlAfterAllah("(?:de\\s+)?Majestueuze\\s+en\\s+(?:de\\s+)?(?:Verhevene|Allerhoogste)"),
    ],
  },
  {
    ar: /سبحانه|تعال[ىي]/,
    char: SWT,
    nl: [
      nlAfterAllah(
        "(?:de\\s+)?(?:Allerhoogste|Hoogverhevene|Verhevene|Geprezene|Glorieuze|Heilige)(?:\\s+en\\s+(?:de\\s+)?(?:Verhevene|Allerhoogste|Hoogverhevene|Geprezene|Glorieuze))?",
      ),
      nlAfterAllah(
        "(?:glorieus|geprezen|heilig|verheerlijkt|gezuiverd)\\s+(?:en\\s+(?:verheven|hoog(?:verheven)?)\\s+)?(?:is|zij)\\s+Hij",
      ),
      nlAfterAllah(
        "(?:glorie|lof)\\s+zij\\s+Hem(?:\\s*,?\\s*(?:en\\s+)?(?:de\\s+)?(?:Verhevene|Allerhoogste))?",
      ),
      nlAfterAllah("(?:verheven|hoogverheven)\\s+(?:is|zij)\\s+Hij"),
    ],
  },
];

/** Duas for a companion or a scholar, said after the name (no "Allah"/"Hij" before them). */
const afterName = (body: string) => new RegExp(`[,(]?\\s*(?:${body})\\s*[,)]?`, "gi");
const PLEASED =
  "(?:moge\\s+)?Allah\\s+(?:zij\\s+)?(?:tevreden\\s+(?:zijn\\s+)?met|welbehagen\\s+hebben\\s+in)";
const mercy = (who: string) =>
  `(?:moge\\s+)?Allah\\s+(?:zij\\s+)?(?:${who}\\s+genadig(?:\\s+zijn)?|zich\\s+over\\s+${who}\\s+ontfermen|${who}\\s+barmhartigheid\\s+schenken)`;

NL_SPOKEN.unshift(
  {
    ar: /رضي\s+الله\s+عنهما/,
    char: "﵄",
    nl: [afterName(`${PLEASED}\\s+(?:hen\\s+beiden|hen\\s+allebei|beiden)(?:\\s+zijn)?`)],
  },
  {
    ar: /رضي\s+الله\s+عنهم(?![\u0621-\u064A])/,
    char: "﵃",
    nl: [afterName(`${PLEASED}\\s+(?:hen|hen\\s+allen|allen)(?:\\s+zijn)?`)],
  },
  {
    ar: /رضي\s+الله\s+عنها/,
    char: "﵂",
    nl: [afterName(`${PLEASED}\\s+haar(?:\\s+zijn)?`)],
  },
  {
    ar: /رضي\s+الله\s+عنه(?![\u0621-\u064A])/,
    char: "﵁",
    nl: [afterName(`${PLEASED}\\s+hem(?:\\s+zijn)?`)],
  },
  // رحمهم الله → ﵏; رحمه الله → ﵀ (رحمها الله has no ligature: its words stay).
  { ar: /رحمهم\s+الله/, char: "﵏", nl: [afterName(mercy("hen"))] },
  { ar: /رحمه\s+الله/, char: "﵀", nl: [afterName(mercy("hem"))] },
);

function spokenHonorifics(text: string, src: string): string {
  const ar = src.replace(AR_TASHKEEL, "");
  let out = text;
  for (const rule of NL_SPOKEN) {
    if (!rule.ar.test(ar)) continue;
    for (const re of rule.nl) out = out.replace(re, ` ${rule.char} `);
  }
  return out;
}

const ENGLISH: Rule[] = [
  {
    re: /[,(]?\s*(?:may\s+)?(?:Allah['’]s\s+)?(?:the\s+)?(?:peace\s+and\s+blessings|blessings\s+and\s+peace|prayers\s+and\s+peace|salutations\s+and\s+peace)(?:\s+of\s+Allah)?\s+be\s+(?:upon|on|with)\s+him\s*[,)]?/gi,
    to: ` ${SAW}`,
  },
  {
    re: /[,(]?\s*(?:may\s+)?Allah\s+bless\s+him\s+and\s+grant\s+him\s+peace\s*[,)]?/gi,
    to: prophetOnly,
  },
  {
    re: /[,(]?\s*(?:may\s+)?peace\s+be\s+(?:upon|on|with)\s+him\s*[,)]?|\(\s*(?:pbuh|p\.\s?b\.\s?u\.\s?h\.?)\s*\)/gi,
    to: byContext,
  },
  // "(as)" only right after a name ("Musa (as)"), never in ordinary text.
  { re: /(?<=\b[A-Z][a-z'’]+)\s*\(\s*(?:as|a\.\s?s\.?)\s*\)/g, to: byContext },
  { re: /\b(no|any|every|false|other)\s+God\b/g, to: "$1 god" },
  {
    re: new RegExp(
      `${SENTENCE_START}(?:[Oo]h?\\s+)(?:my\\s+|our\\s+|dear\\s+)?(?:Lord\\s+)?God\\b`,
      "g",
    ),
    to: "$1O Allah",
  },
  {
    re: new RegExp(
      `${SENTENCE_START}(?:[Mm]y|[Oo]ur|[Dd]ear)\\s+(?:Lord\\s+)?God\\b(?=\\s*[,!]|\\s+${EN_IMPERATIVE}\\b)`,
      "g",
    ),
    to: "$1O Allah",
  },
  {
    re: new RegExp(`${SENTENCE_START}God\\b(?=\\s*,?\\s*${EN_IMPERATIVE}\\b)`, "g"),
    to: "$1O Allah",
  },
  { re: /\b[Oo]h?\s+God\b/g, to: "O Allah" },
  { re: new RegExp(`${EN_DEITY_BEFORE}\\bGod\\b(?!['’]s)`, "g"), to: "Allah" },
  { re: new RegExp(`${EN_DEITY_BEFORE}\\bGod['’]s\\b`, "g"), to: "Allah's" },
  { re: /\b(?:Mohammed|Mohammad|Muhammed|Mohamed|Mohamad)\b/g, to: "Muhammad" },
];

/** Spacing and duplicates around honorific ligatures: "Mohammed ﷺ, de …", never "ﷺ ﷺ". */
function tidy(text: string, punctuation: boolean): string {
  let out = text
    .replace(new RegExp(`\\(\\s*([${HON}])\\s*\\)`, "g"), " $1")
    .replace(new RegExp(`\\s*,?\\s*([${HON}])`, "g"), " $1")
    .replace(new RegExp(`([${HON}])(?:\\s*[,;]?\\s*\\1)+`, "g"), "$1")
    // Closing punctuation only: an opening quote after a ligature keeps its space.
    .replace(new RegExp(`([${HON}])\\s+([,.;:!?)\\]”’»])`, "g"), "$1$2")
    .replace(/[ \t]{2,}/g, " ");
  // Dutch/English spacing only (French puts a space before ; : ! ?).
  if (punctuation) out = out.replace(/\s+([,.;:!?])/g, "$1").replace(/,\s*,/g, ",");
  return out.trim();
}

/**
 * Deterministic fixes for a translated caption (idempotent). Dutch and English get the full
 * rules (God → Allah where it is the name, salawat paraphrases → ﷺ, prophet-name spelling);
 * every language gets the transliteration/abbreviation rules and tidy honorific spacing.
 * `quran: true` (a Quran block, often the approved translation verbatim): only honorific
 * spacing; verse wording is never rewritten (Siregar writes "God" for إله on purpose).
 * `src` (the Arabic being translated): Dutch paraphrases of honorifics the Arabic says become
 * their ligature ("Allah, de Verhevene," → "Allah ﷾").
 */
export function normalizeIslamicTerms(
  text: string,
  lang: string,
  opts: { quran?: boolean; src?: string } = {},
): string {
  if (opts.quran === true) return tidy(text, false);
  const base = lang.toLowerCase().split("-")[0];
  const full = base === "nl" || base === "en";
  const rules = [...COMMON, ...(base === "nl" ? DUTCH : base === "en" ? ENGLISH : [])];
  let out = base === "nl" && opts.src !== undefined ? spokenHonorifics(text, opts.src) : text;
  for (const rule of rules) {
    out =
      typeof rule.to === "string"
        ? out.replace(rule.re, rule.to)
        : out.replace(rule.re, rule.to as (substring: string, ...args: unknown[]) => string);
  }
  return tidy(out, full);
}
