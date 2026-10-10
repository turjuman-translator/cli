// The Turjuman mark: a pointed arch that becomes a speech bubble, with two caption lines: the upper
// one starts from the right (Arabic), the lower from the left (the translation).
// Drawn on a 64-unit grid; one stroke weight, round ends.

export const ARCH_PATH =
  "M12 46V32A28 28 0 0 1 32 5.17A28 28 0 0 1 52 32V46A6 6 0 0 1 46 52H27L16 60L19 52H18A6 6 0 0 1 12 46Z";

export interface MarkColours {
  arch: string;
  arabic: string;
  translation: string;
}

export const PINE: MarkColours = { arch: "#0C3F31", arabic: "#399277", translation: "#0C3F31" };
export const ON_PINE: MarkColours = { arch: "#FFFFFF", arabic: "#8CCEB6", translation: "#FFFFFF" };

/** The bare mark as an SVG string (viewBox fits the drawing; size it with CSS height). */
export function markSvg(c: MarkColours = PINE, cls = ""): string {
  return (
    `<svg class="${cls}" viewBox="8 1 48 63" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${ARCH_PATH}" stroke="${c.arch}"/><path d="M31 33H43" stroke="${c.arabic}"/>` +
    `<path d="M21 42H39" stroke="${c.translation}"/></g></svg>`
  );
}

/** The wordmark: mark, "Turjuman", a hairline and ترجمان (order flips on an Arabic page via CSS). */
export function wordmarkHtml(cls = "tj-wordmark"): string {
  return (
    `<span class="${cls}">${markSvg(PINE)}<span class="tj-wm-lat">Turjuman</span>` +
    `<i aria-hidden="true"></i><span class="tj-wm-ar" lang="ar">ترجمان</span></span>`
  );
}
