// Language helpers shared by the server and the browser pages (no Node or DOM imports).
// Text direction comes from a static RTL list.

/** Right-to-left languages. */
export const RTL_LANGS: ReadonlySet<string> = new Set([
  "ar",
  "he",
  "fa",
  "ur",
  "ps",
  "sd",
  "ug",
  "yi",
  "dv",
  "ckb",
]);

/** Languages normally written in Arabic script (rendered with Noto Naskh Arabic). */
export const ARABIC_SCRIPT_LANGS: ReadonlySet<string> = new Set([
  "ar",
  "fa",
  "ur",
  "ps",
  "sd",
  "ug",
  "ckb",
]);

/** Languages written without spaces between words (the renderer can't snap to a space). */
export const NO_SPACE_LANGS: ReadonlySet<string> = new Set([
  "zh",
  "ja",
  "th",
  "lo",
  "km",
  "my",
  "yue",
  "bo",
]);

/** Primary subtag, lower-cased: "ar-EG" → "ar", "zh_Hant" → "zh". */
export function baseLang(code: string): string {
  return code
    .toLowerCase()
    .replace(/[-_].*$/s, "")
    .trim();
}

export function dirFor(code: string): "rtl" | "ltr" {
  return RTL_LANGS.has(baseLang(code)) ? "rtl" : "ltr";
}

export function isArabicScript(code: string): boolean {
  return ARABIC_SCRIPT_LANGS.has(baseLang(code));
}

export function isNoSpaceScript(code: string): boolean {
  return NO_SPACE_LANGS.has(baseLang(code));
}
