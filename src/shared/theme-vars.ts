// Theme contract: every part of the caption look is a CSS custom property.
// The renderer's CSS reads ONLY these custom properties (with sensible fallbacks); presets and URL
// overrides set them. Browser-safe: no imports. The theme module (src/shared/theme.ts) owns the
// presets, URL mapping and validation; the renderer owns how the variables are used.

/** Every customizable CSS custom property. Values are CSS strings. */
export const THEME_VARS = [
  // page + panel
  "--cap-page-bg", // page background (transparent for OBS)
  "--cap-panel-bg", // the panel behind the blocks ("none" → transparent)
  "--cap-panel-radius",
  "--cap-panel-padding",
  "--cap-panel-width", // e.g. "90vw" or "70vw"
  "--cap-panel-height", // e.g. "100vh"
  "--cap-panel-justify", // flex-start | center | flex-end (horizontal placement)
  "--cap-panel-shadow",
  "--cap-panel-blur", // backdrop blur, e.g. "0px" | "12px"
  "--cap-fade-mask", // height of the top gradient fade, e.g. "18%" ("0%" = none)
  // blocks
  "--cap-block-bg",
  "--cap-block-bg-new", // newest block
  "--cap-block-border",
  "--cap-block-radius",
  "--cap-block-padding",
  "--cap-block-gap",
  "--cap-block-shadow",
  "--cap-old-opacity", // older blocks' text opacity
  "--cap-new-scale", // newest-block scale-in, e.g. "1.02"
  // text
  "--cap-font-family",
  "--cap-font-size",
  "--cap-font-weight",
  "--cap-line-height",
  "--cap-letter-spacing",
  "--cap-text-color",
  "--cap-text-color-new",
  "--cap-text-shadow",
  "--cap-text-align",
  "--cap-max-chars", // line length in ch, e.g. "42ch"
  // source text + Arabic
  "--cap-src-font-family",
  "--cap-src-scale", // relative to --cap-font-size, e.g. "0.7"
  "--cap-src-color",
  "--cap-src-opacity",
  "--cap-arabic-font-family",
  "--cap-quran-font-family",
  // accents per block kind
  "--cap-accent-width",
  "--cap-quran-accent",
  "--cap-dua-accent",
  "--cap-ref-color",
  "--cap-ref-weight",
  // honorific ligatures (ﷺ ﷾ ﷿ ﵇ ﵁ …, see src/text/honorifics.ts), wrapped in `.cap-hon`
  "--cap-hon-font", // e.g. '"Noto Naskh Arabic", serif' (Noto Sans has no Arabic glyphs)
  "--cap-hon-scale", // e.g. "1.25em"
  "--cap-hon-color", // e.g. "currentColor" or a soft gold
  // event cards (Athan / Iqama / Salah)
  "--cap-event-bg",
  "--cap-event-color",
  "--cap-event-accent",
  // toolbar + listening indicator
  "--cap-toolbar-bg",
  "--cap-toolbar-color",
  "--cap-listening-color",
  // motion
  "--cap-anim-duration", // e.g. "200ms" ("0ms" disables)
] as const;

export type ThemeVar = (typeof THEME_VARS)[number];

/**
 * Variables of removed features that older presets.yaml entries and saved looks may still carry
 * (--cap-hadith-accent: hadith blocks came only from the removed caption composer): ignored.
 */
export const REMOVED_THEME_VARS: ReadonlySet<string> = new Set(["--cap-hadith-accent"]);

/** Non-CSS display options a preset may set (URL params of the caption page / overlay). */
export interface DisplayOptions {
  layout: "blocks" | "rollup";
  bg: "panel" | "none" | "band" | "shadow";
  show: "both" | "target" | "source";
  history: boolean;
  quranAccent: boolean;
  quranArabic: boolean;
  partial: boolean;
  /** Max blocks kept in the DOM (OBS ~60). */
  maxBlocks: number;
  /** Blocks visible at once (0 = as many as fit). */
  visibleBlocks: number;
  pos: "bottom" | "top" | "middle";
  lines: number; // rollup
  size: number; // base font px
  toolbar: "auto" | "on" | "off";
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  vars: Partial<Record<ThemeVar, string>>;
  options: Partial<DisplayOptions>;
}
