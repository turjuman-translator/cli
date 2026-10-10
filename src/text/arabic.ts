// Arabic normalization shared by the bench, the Quran matcher and the prayer-event detector.
// Internal use only: displayed text is never normalized.

const TASHKEEL = /[ً-ْٰ]/g; // harakat, tanween, sukun, shadda, superscript alef
const TATWEEL = /ـ/g;
const QURANIC_MARKS = /[ؐ-ؚۖ-ۭ]/g; // small high letters / waqf marks
const ALEF_VARIANTS = /[أإآٱ]/g;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const EXT_ARABIC_INDIC_DIGITS = /[۰-۹]/g;
// Arabic + Latin punctuation and symbols (kept: letters, digits, whitespace).
const PUNCTUATION = /[،؛؟٪-٭۔!-/:-@[-`{-~«»‐-‧‰-⁞﴾﴿]/g;

/**
 * Normalization: strip tashkeel and tatweel, fold أ إ آ ٱ → ا, ى → ي, ة → ه,
 * Arabic-Indic digits → ASCII, remove Arabic and Latin punctuation, collapse whitespace.
 */
export function normalizeArabic(text: string): string {
  return text
    .normalize("NFC")
    .replace(TASHKEEL, "")
    .replace(QURANIC_MARKS, "")
    .replace(TATWEEL, "")
    .replace(ALEF_VARIANTS, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words of the normalized text. */
export function arabicWords(text: string): string[] {
  const n = normalizeArabic(text);
  return n === "" ? [] : n.split(" ");
}

/**
 * Extra folding for matching ASR output against reference text: case-ending
 * variants the recognizer produces inconsistently, e.g. محمدا → محمد, plus hamza seats.
 */
export function foldAsrVariants(word: string): string {
  return word.replace(/[ؤئ]/g, "ء").replace(/^(.{3,})ا$/, "$1"); // accusative tanween alef: محمدا → محمد, شيئا → شيء(ا)
}

/** Normalized + ASR-folded words, for fuzzy matching. */
export function matchWords(text: string): string[] {
  return arabicWords(text).map(foldAsrVariants);
}

/**
 * Words (normalized) that cannot end an Arabic sentence: prepositions, conjunctions, particles,
 * relative pronouns. A recognizer segment that ends on one was cut by a pause mid-sentence
 * (e.g. «إذا كان لك دين، على.», and the khatib goes on with «آخر …»).
 */
const OPEN_END = new Set([
  "علي",
  "في",
  "من",
  "الي",
  "عن",
  "مع",
  "حتي",
  "منذ",
  "عند",
  "لدي",
  "بين",
  "دون",
  "نحو",
  "خلال",
  "و",
  "او",
  "ثم",
  "بل",
  "لكن",
  "ام",
  "ان",
  "وان",
  "فان",
  "لان",
  "كي",
  "لكي",
  "اذا",
  "واذا",
  "اذ",
  "لو",
  "ولو",
  "لولا",
  "كما",
  "مثل",
  "هل",
  "لم",
  "لن",
  "قد",
  "وقد",
  "الذي",
  "التي",
  "الذين",
  "اللذين",
  "اللتين",
  "اللاتي",
  "اللواتي",
  "ايها",
  "يا",
  "سواء",
  "حيث",
  "عندما",
  "بينما",
  "انه",
  "فانه",
  "وانه",
  "لانه",
  "انها",
  "فانها",
  "وهو",
  "وهي",
  "فهو",
  "فهي",
  "اي",
  "ليس",
  "كان",
  "وكان",
]);

/** True when the text's last word cannot end an Arabic sentence (see OPEN_END). */
export function endsMidSentence(text: string): boolean {
  const words = arabicWords(text);
  const last = words[words.length - 1];
  return last !== undefined && OPEN_END.has(last);
}
