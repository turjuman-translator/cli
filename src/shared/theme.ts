// Caption themes: every part of the look can be customized, starting from a preset.
// Browser-safe and DOM-free (the server imports it too): built-in presets, the URL parameter
// mapping (?preset= + short per-variable overrides + display options), strict value sanitizing,
// applyTheme (CSSOM only) and themeQuery (the minimal query string for "Copy URL").
//
// Security: every value that reaches CSS goes through a whitelist parser (colours, simple
// gradients, lengths, numbers, allow-listed font stacks, keywords). Anything else is dropped,
// whether it comes from the URL, a custom preset (presets.yaml) or a caller of applyTheme.
// The full parameter reference lives in docs/presets.md.
import { type DisplayOptions, THEME_VARS, type ThemePreset, type ThemeVar } from "./theme-vars.js";

export type ThemeVars = Partial<Record<ThemeVar, string>>;

export const DEFAULT_PRESET_ID = "mosque-dark";

/** On narrow screens (phones, tablets) the caption text is capped at this share of the screen
 *  width so lines stay readable: --cap-font-size = min(<size>px, 5vw). No effect from ~1040 px
 *  wide up (OBS sources, TVs) for the default sizes. */
export const FONT_FIT_VW = 5;

/** The --cap-font-size value for a base size in px. */
export function fontSizeVar(size: number): string {
  return `min(${fmtNum(size)}px, ${FONT_FIT_VW}vw)`;
}

// --- fonts ---------------------------------------------------------------------------------------

export interface FontChoice {
  /** Short URL value, e.g. `font=georgia`. */
  key: string;
  label: string;
  /** The CSS font stack. Latin stacks keep "Noto Naskh Arabic" before the generic family so ﷺ
   *  (U+FDFA) and Arabic always render with the bundled font. */
  stack: string;
  /** Suitable for Arabic text (source lines, Quran). */
  arabic: boolean;
}

const NOTO = '"Noto Sans", "Noto Naskh Arabic", system-ui, sans-serif';
const SYSTEM = 'system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Naskh Arabic", sans-serif';
const GEORGIA = 'Georgia, "Times New Roman", "Noto Naskh Arabic", serif';
const NASKH = '"Noto Naskh Arabic", "Noto Sans", serif';
const AMIRI = '"Amiri Quran", "Noto Naskh Arabic", serif';

export const FONT_CHOICES: readonly FontChoice[] = [
  { key: "noto-sans", label: "Noto Sans", stack: NOTO, arabic: false },
  { key: "system", label: "System UI", stack: SYSTEM, arabic: false },
  {
    key: "segoe",
    label: "Segoe UI",
    stack: '"Segoe UI", system-ui, "Noto Sans", "Noto Naskh Arabic", sans-serif',
    arabic: false,
  },
  {
    key: "sans-serif",
    label: "Sans-serif",
    stack: '"Helvetica Neue", Arial, "Noto Sans", "Noto Naskh Arabic", sans-serif',
    arabic: false,
  },
  { key: "georgia", label: "Georgia", stack: GEORGIA, arabic: false },
  {
    key: "serif",
    label: "Serif",
    stack: '"Times New Roman", Times, "Noto Naskh Arabic", serif',
    arabic: false,
  },
  { key: "naskh", label: "Noto Naskh Arabic", stack: NASKH, arabic: true },
  { key: "amiri-quran", label: "Amiri Quran", stack: AMIRI, arabic: true },
];

// --- shadow keywords -----------------------------------------------------------------------------

/** Named box shadows (panel, blocks): `panelShadow=soft`. */
export const BOX_SHADOWS: Readonly<Record<string, string>> = {
  none: "none",
  soft: "0 4px 14px rgba(0, 0, 0, 0.22)",
  medium: "0 10px 30px rgba(0, 0, 0, 0.35)",
  strong: "0 18px 50px rgba(0, 0, 0, 0.5)",
  glow: "0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 40px rgba(0, 0, 0, 0.45)",
};

const SOFT_TEXT = "0 1px 3px rgba(0, 0, 0, 0.55)";
const STRONG_TEXT = "0 0 3px #000000, 0 2px 6px rgba(0, 0, 0, 0.9), 0 0 14px rgba(0, 0, 0, 0.6)";

/** Named text shadows: `shadow=strong`. */
export const TEXT_SHADOWS: Readonly<Record<string, string>> = {
  none: "none",
  soft: SOFT_TEXT,
  strong: STRONG_TEXT,
  outline:
    "-1px -1px 0 #000000, 1px -1px 0 #000000, -1px 1px 0 #000000, 1px 1px 0 #000000, 0 2px 8px rgba(0, 0, 0, 0.8)",
  glow: "0 0 10px rgba(0, 0, 0, 0.85), 0 0 24px rgba(0, 0, 0, 0.6)",
};

// --- value kinds ---------------------------------------------------------------------------------

export type VarKind =
  | { type: "color" }
  /** colour | none | linear-/radial-gradient(…) */
  | { type: "paint" }
  | {
      type: "length";
      unit: "px" | "vw" | "vh" | "em";
      min: number;
      max: number;
      /** Accepted units (default: all CSS length units). */
      units?: readonly string[];
    }
  /** 1–2 lengths ("14px 22px"), px by default */
  | { type: "padding"; max: number }
  | { type: "percent"; max: number }
  | { type: "number"; min: number; max: number }
  | { type: "weight" }
  | { type: "font" }
  | { type: "shadow"; text: boolean }
  | { type: "border" }
  | { type: "justify" }
  | { type: "align" }
  /** line length in ch, or none */
  | { type: "measure" }
  | { type: "time" }
  /** --cap-font-size: always derived from the `size` option */
  | { type: "fontSize" };

export interface VarSpec {
  /** Short URL parameter name. */
  param: string;
  kind: VarKind;
}

/** URL parameter + value kind of every theme variable (docs/presets.md has the table). */
export const VAR_SPECS: Readonly<Record<ThemeVar, VarSpec>> = {
  "--cap-page-bg": { param: "pageBg", kind: { type: "paint" } },
  "--cap-panel-bg": { param: "panelBg", kind: { type: "paint" } },
  "--cap-panel-radius": {
    param: "panelRadius",
    kind: { type: "length", unit: "px", min: 0, max: 200 },
  },
  "--cap-panel-padding": {
    param: "panelPad",
    kind: { type: "length", unit: "px", min: 0, max: 200 },
  },
  "--cap-panel-width": { param: "width", kind: { type: "length", unit: "vw", min: 5, max: 100 } },
  "--cap-panel-height": { param: "height", kind: { type: "length", unit: "vh", min: 5, max: 100 } },
  "--cap-panel-justify": { param: "justify", kind: { type: "justify" } },
  "--cap-panel-shadow": { param: "panelShadow", kind: { type: "shadow", text: false } },
  "--cap-panel-blur": { param: "blur", kind: { type: "length", unit: "px", min: 0, max: 80 } },
  "--cap-fade-mask": { param: "fade", kind: { type: "percent", max: 80 } },
  "--cap-block-bg": { param: "blockBg", kind: { type: "paint" } },
  "--cap-block-bg-new": { param: "blockBgNew", kind: { type: "paint" } },
  "--cap-block-border": { param: "border", kind: { type: "border" } },
  "--cap-block-radius": { param: "radius", kind: { type: "length", unit: "px", min: 0, max: 200 } },
  "--cap-block-padding": { param: "pad", kind: { type: "padding", max: 200 } },
  "--cap-block-gap": { param: "gap", kind: { type: "length", unit: "px", min: 0, max: 200 } },
  "--cap-block-shadow": { param: "blockShadow", kind: { type: "shadow", text: false } },
  "--cap-old-opacity": { param: "oldOpacity", kind: { type: "number", min: 0, max: 1 } },
  "--cap-new-scale": { param: "newScale", kind: { type: "number", min: 0.9, max: 1.2 } },
  "--cap-font-family": { param: "font", kind: { type: "font" } },
  "--cap-font-size": { param: "size", kind: { type: "fontSize" } },
  "--cap-font-weight": { param: "weight", kind: { type: "weight" } },
  "--cap-line-height": { param: "lh", kind: { type: "number", min: 0.8, max: 3 } },
  "--cap-letter-spacing": { param: "ls", kind: { type: "length", unit: "px", min: -10, max: 20 } },
  "--cap-text-color": { param: "fg", kind: { type: "color" } },
  "--cap-text-color-new": { param: "fgNew", kind: { type: "color" } },
  "--cap-text-shadow": { param: "shadow", kind: { type: "shadow", text: true } },
  "--cap-text-align": { param: "align", kind: { type: "align" } },
  "--cap-max-chars": { param: "maxChars", kind: { type: "measure" } },
  "--cap-src-font-family": { param: "srcFont", kind: { type: "font" } },
  "--cap-src-scale": { param: "srcScale", kind: { type: "number", min: 0.3, max: 4 } },
  "--cap-src-color": { param: "srcColor", kind: { type: "color" } },
  "--cap-src-opacity": { param: "srcOpacity", kind: { type: "number", min: 0, max: 1 } },
  "--cap-arabic-font-family": { param: "arFont", kind: { type: "font" } },
  "--cap-quran-font-family": { param: "quranFont", kind: { type: "font" } },
  "--cap-accent-width": {
    param: "accentWidth",
    kind: { type: "length", unit: "px", min: 0, max: 40 },
  },
  "--cap-quran-accent": { param: "quranColor", kind: { type: "color" } },
  "--cap-dua-accent": { param: "duaColor", kind: { type: "color" } },
  "--cap-ref-color": { param: "refColor", kind: { type: "color" } },
  "--cap-ref-weight": { param: "refWeight", kind: { type: "weight" } },
  "--cap-hon-font": { param: "honFont", kind: { type: "font" } },
  "--cap-hon-scale": {
    param: "honScale",
    kind: { type: "length", unit: "em", min: 0.6, max: 2.5, units: ["em"] },
  },
  "--cap-hon-color": { param: "honColor", kind: { type: "color" } },
  "--cap-event-bg": { param: "eventBg", kind: { type: "paint" } },
  "--cap-event-color": { param: "eventColor", kind: { type: "color" } },
  "--cap-event-accent": { param: "eventAccent", kind: { type: "color" } },
  "--cap-toolbar-bg": { param: "toolbarBg", kind: { type: "paint" } },
  "--cap-toolbar-color": { param: "toolbarColor", kind: { type: "color" } },
  "--cap-listening-color": { param: "dotsColor", kind: { type: "color" } },
  "--cap-anim-duration": { param: "anim", kind: { type: "time" } },
};

// --- display options -----------------------------------------------------------------------------

type OptionKind =
  | { type: "enum"; values: readonly string[]; aliases?: Readonly<Record<string, string>> }
  | { type: "bool" }
  | { type: "int"; min: number; max: number };

export interface OptionSpec {
  param: string;
  /** Extra accepted URL names. */
  aliases?: readonly string[];
  kind: OptionKind;
}

export const OPTION_SPECS: Readonly<Record<keyof DisplayOptions, OptionSpec>> = {
  layout: { param: "layout", kind: { type: "enum", values: ["blocks", "rollup"] } },
  bg: { param: "bg", kind: { type: "enum", values: ["panel", "none", "band", "shadow"] } },
  show: { param: "show", kind: { type: "enum", values: ["both", "target", "source"] } },
  history: { param: "history", kind: { type: "bool" } },
  quranAccent: { param: "quranAccent", kind: { type: "bool" } },
  quranArabic: { param: "quranArabic", kind: { type: "bool" } },
  partial: { param: "partial", kind: { type: "bool" } },
  maxBlocks: { param: "maxBlocks", kind: { type: "int", min: 1, max: 500 } },
  visibleBlocks: {
    param: "visibleBlocks",
    aliases: ["visible"],
    kind: { type: "int", min: 0, max: 100 },
  },
  pos: { param: "pos", kind: { type: "enum", values: ["bottom", "top", "middle"] } },
  lines: { param: "lines", kind: { type: "int", min: 1, max: 20 } },
  size: { param: "size", kind: { type: "int", min: 8, max: 300 } },
  toolbar: {
    param: "toolbar",
    kind: {
      type: "enum",
      values: ["auto", "on", "off"],
      aliases: { "1": "on", true: "on", yes: "on", "0": "off", false: "off", no: "off" },
    },
  },
};

const OPTION_KEYS = Object.keys(OPTION_SPECS) as Array<keyof DisplayOptions>;

/** Defaults under every preset (a preset only lists what it changes). `partial` defaults to
 *  on for the roll-up layout and off for blocks when neither the preset nor the URL sets it. */
export const DEFAULT_OPTIONS: Readonly<DisplayOptions> = {
  layout: "blocks",
  bg: "panel",
  show: "target",
  history: true,
  quranAccent: true,
  quranArabic: true,
  partial: false,
  maxBlocks: 60,
  visibleBlocks: 0,
  pos: "bottom",
  lines: 2,
  size: 52,
  toolbar: "auto",
};

// --- built-in presets ----------------------------------------------------------------------------

/** The reference design ("mosque-dark"); every other preset starts from it. */
const DARK: Readonly<Record<ThemeVar, string>> = {
  "--cap-page-bg": "transparent",
  "--cap-panel-bg": "rgba(17, 17, 17, 0.92)",
  "--cap-panel-radius": "0px",
  "--cap-panel-padding": "28px",
  "--cap-panel-width": "100vw",
  "--cap-panel-height": "100vh",
  "--cap-panel-justify": "center",
  "--cap-panel-shadow": "none",
  "--cap-panel-blur": "0px",
  "--cap-fade-mask": "18%",
  "--cap-block-bg": "#1c1c20",
  "--cap-block-bg-new": "#2b2b30",
  "--cap-block-border": "1px solid rgba(255, 255, 255, 0.05)",
  "--cap-block-radius": "12px",
  "--cap-block-padding": "14px 22px",
  "--cap-block-gap": "10px",
  "--cap-block-shadow": "none",
  "--cap-old-opacity": "0.85",
  "--cap-new-scale": "1.02",
  "--cap-font-family": NOTO,
  "--cap-font-size": "min(52px, 5vw)",
  "--cap-font-weight": "400",
  "--cap-line-height": "1.35",
  "--cap-letter-spacing": "0px",
  "--cap-text-color": "#f2f2f4",
  "--cap-text-color-new": "#ffffff",
  "--cap-text-shadow": "none",
  "--cap-text-align": "start",
  "--cap-max-chars": "42ch",
  "--cap-src-font-family": NASKH,
  "--cap-src-scale": "0.72",
  "--cap-src-color": "#dcdce2",
  "--cap-src-opacity": "0.6",
  "--cap-arabic-font-family": NASKH,
  "--cap-quran-font-family": AMIRI,
  "--cap-accent-width": "4px",
  "--cap-quran-accent": "#d4a64a",
  "--cap-dua-accent": "#4caf7d",
  "--cap-ref-color": "#d4a64a",
  "--cap-ref-weight": "600",
  "--cap-hon-font": NASKH,
  "--cap-hon-scale": "1.25em",
  "--cap-hon-color": "#d4a64a",
  "--cap-event-bg": "#1d2621",
  "--cap-event-color": "#ffffff",
  "--cap-event-accent": "#d4a64a",
  "--cap-toolbar-bg": "rgba(24, 24, 28, 0.92)",
  "--cap-toolbar-color": "#e9e9ee",
  "--cap-listening-color": "#a6a6b0",
  "--cap-anim-duration": "200ms",
};

function preset(
  id: string,
  name: string,
  description: string,
  vars: Partial<Record<ThemeVar, string>>,
  options: Partial<DisplayOptions> & Pick<DisplayOptions, "size">,
): ThemePreset {
  // Every built-in sets every variable; the font size always follows `size`.
  return {
    id,
    name,
    description,
    vars: { ...DARK, ...vars, "--cap-font-size": fontSizeVar(options.size) },
    options,
  };
}

/** mosque-dark: also the look for unknown preset ids. */
const DEFAULT_PRESET = preset(
  DEFAULT_PRESET_ID,
  "Mosque dark",
  "The reference design: a dark screen of rounded, readable blocks, the newest highlighted at the bottom, gold Quran and green dua accents.",
  {},
  { layout: "blocks", bg: "panel", size: 52 },
);

export const BUILTIN_PRESETS: readonly ThemePreset[] = [
  DEFAULT_PRESET,
  preset(
    "mosque-light",
    "Mosque light",
    "Dark text on warm white for bright rooms and projectors, where black backgrounds wash out.",
    {
      "--cap-page-bg": "#ece8df",
      "--cap-panel-bg": "rgba(250, 248, 243, 0.97)",
      "--cap-block-bg": "#efebe2",
      "--cap-block-bg-new": "#ffffff",
      "--cap-block-border": "1px solid rgba(70, 56, 24, 0.1)",
      "--cap-block-shadow": "0 2px 10px rgba(60, 48, 20, 0.08)",
      "--cap-old-opacity": "0.8",
      "--cap-font-weight": "600",
      "--cap-text-color": "#2b2a28",
      "--cap-text-color-new": "#111111",
      "--cap-src-color": "#3c3a36",
      "--cap-src-opacity": "0.7",
      "--cap-quran-accent": "#b07d1e",
      "--cap-dua-accent": "#2e8b57",
      "--cap-ref-color": "#9a6a10",
      "--cap-hon-color": "currentcolor",
      "--cap-event-bg": "#f4ecd9",
      "--cap-event-color": "#1c1a16",
      "--cap-event-accent": "#b07d1e",
      "--cap-toolbar-bg": "rgba(255, 255, 255, 0.94)",
      "--cap-toolbar-color": "#2b2a28",
      "--cap-listening-color": "#8a8478",
    },
    { layout: "blocks", bg: "panel", size: 52 },
  ),
  preset(
    "midnight-gold",
    "Midnight gold",
    "Deep navy with gold hairlines and an elegant serif, for a refined, festive screen.",
    {
      "--cap-page-bg": "#060a17",
      "--cap-panel-bg": "rgba(12, 19, 42, 0.96)",
      "--cap-panel-radius": "28px",
      "--cap-panel-padding": "26px",
      "--cap-panel-width": "88vw",
      "--cap-panel-height": "94vh",
      "--cap-panel-shadow": "0 0 0 1px rgba(224, 182, 90, 0.28), 0 22px 60px rgba(0, 0, 0, 0.55)",
      "--cap-block-bg": "#111a35",
      "--cap-block-bg-new": "#1a2650",
      "--cap-block-border": "1px solid rgba(224, 182, 90, 0.2)",
      "--cap-block-radius": "14px",
      "--cap-block-padding": "16px 24px",
      "--cap-old-opacity": "0.8",
      "--cap-font-family": GEORGIA,
      "--cap-line-height": "1.4",
      "--cap-text-color": "#ece6d4",
      "--cap-text-color-new": "#fffaf0",
      "--cap-src-color": "#e9dcb6",
      "--cap-quran-accent": "#e0b65a",
      "--cap-dua-accent": "#5fbf8f",
      "--cap-ref-color": "#e0b65a",
      "--cap-hon-color": "#e0b65a",
      "--cap-hon-scale": "1.3em",
      "--cap-event-bg": "#16214a",
      "--cap-event-color": "#fff4dc",
      "--cap-event-accent": "#e0b65a",
      "--cap-toolbar-bg": "rgba(12, 19, 42, 0.94)",
      "--cap-toolbar-color": "#ece6d4",
      "--cap-listening-color": "#e0b65a",
      "--cap-max-chars": "44ch",
    },
    { layout: "blocks", bg: "panel", size: 50, pos: "middle" },
  ),
  preset(
    "high-contrast",
    "High contrast",
    "Large bold text on pure black, the newest block in yellow. No dimming, no motion: for low vision.",
    {
      "--cap-panel-bg": "#000000",
      "--cap-panel-padding": "24px",
      "--cap-fade-mask": "0%",
      "--cap-block-bg": "#000000",
      "--cap-block-bg-new": "#141400",
      "--cap-block-border": "2px solid rgba(255, 255, 255, 0.35)",
      "--cap-block-radius": "6px",
      "--cap-block-padding": "16px 24px",
      "--cap-block-gap": "14px",
      "--cap-old-opacity": "1",
      "--cap-new-scale": "1",
      "--cap-font-weight": "600",
      "--cap-line-height": "1.4",
      "--cap-letter-spacing": "0.5px",
      "--cap-text-color": "#ffffff",
      "--cap-text-color-new": "#ffe600",
      "--cap-max-chars": "46ch",
      "--cap-src-color": "#ffffff",
      "--cap-src-opacity": "0.9",
      "--cap-src-scale": "0.8",
      "--cap-accent-width": "8px",
      "--cap-quran-accent": "#ffd400",
      "--cap-dua-accent": "#00e676",
      "--cap-ref-color": "#ffd400",
      "--cap-ref-weight": "700",
      "--cap-hon-color": "currentcolor",
      "--cap-hon-scale": "1.2em",
      "--cap-event-bg": "#000000",
      "--cap-event-color": "#ffe600",
      "--cap-event-accent": "#ffe600",
      "--cap-toolbar-bg": "#000000",
      "--cap-toolbar-color": "#ffffff",
      "--cap-listening-color": "#ffe600",
      "--cap-anim-duration": "0ms",
    },
    { layout: "blocks", bg: "panel", size: 60 },
  ),
  preset(
    "minimal-transparent",
    "Minimal transparent",
    "No panel and no boxes: centred white text with a strong shadow, straight over the video.",
    {
      "--cap-panel-bg": "transparent",
      "--cap-panel-shadow": "none",
      "--cap-panel-padding": "24px",
      "--cap-panel-height": "48vh",
      "--cap-fade-mask": "30%",
      "--cap-block-bg": "transparent",
      "--cap-block-bg-new": "transparent",
      "--cap-block-border": "none",
      "--cap-block-padding": "4px 12px",
      "--cap-block-gap": "6px",
      "--cap-old-opacity": "0.62",
      "--cap-new-scale": "1",
      "--cap-font-weight": "600",
      "--cap-text-shadow": STRONG_TEXT,
      "--cap-text-align": "center",
      "--cap-max-chars": "44ch",
      "--cap-accent-width": "0px",
      "--cap-src-color": "#ffffff",
      "--cap-src-opacity": "0.85",
      "--cap-ref-color": "#ffd77a",
      "--cap-hon-color": "currentcolor",
      "--cap-event-bg": "rgba(0, 0, 0, 0.55)",
      "--cap-toolbar-bg": "rgba(0, 0, 0, 0.6)",
      "--cap-listening-color": "#ffffff",
    },
    { layout: "blocks", bg: "none", size: 50, visibleBlocks: 3, quranAccent: false },
  ),
  preset(
    "glass",
    "Glass",
    "Frosted, translucent blocks with a soft blur: modern and light over a camera picture.",
    {
      "--cap-panel-bg": "rgba(255, 255, 255, 0.07)",
      "--cap-panel-radius": "30px",
      "--cap-panel-padding": "20px",
      "--cap-panel-width": "86vw",
      "--cap-panel-height": "60vh",
      "--cap-panel-shadow": "0 24px 60px rgba(0, 0, 0, 0.35)",
      "--cap-panel-blur": "22px",
      "--cap-fade-mask": "22%",
      "--cap-block-bg": "rgba(255, 255, 255, 0.1)",
      "--cap-block-bg-new": "rgba(255, 255, 255, 0.22)",
      "--cap-block-border": "1px solid rgba(255, 255, 255, 0.24)",
      "--cap-block-radius": "18px",
      "--cap-block-padding": "14px 24px",
      "--cap-block-shadow": "0 8px 24px rgba(0, 0, 0, 0.18)",
      "--cap-old-opacity": "0.88",
      "--cap-font-family": SYSTEM,
      "--cap-font-weight": "500",
      "--cap-text-color": "#ffffff",
      "--cap-text-shadow": "0 1px 2px rgba(0, 0, 0, 0.35)",
      "--cap-src-color": "#ffffff",
      "--cap-src-opacity": "0.75",
      "--cap-quran-accent": "#ffd27a",
      "--cap-dua-accent": "#86e3b0",
      "--cap-ref-color": "#ffe2a3",
      "--cap-hon-color": "currentcolor",
      "--cap-event-bg": "rgba(255, 255, 255, 0.16)",
      "--cap-event-accent": "#ffd27a",
      "--cap-toolbar-bg": "rgba(255, 255, 255, 0.16)",
      "--cap-toolbar-color": "#ffffff",
      "--cap-listening-color": "#ffffff",
      "--cap-anim-duration": "260ms",
      "--cap-max-chars": "46ch",
    },
    { layout: "blocks", bg: "panel", size: 46 },
  ),
  preset(
    "sidebar-pip",
    "Sidebar + PiP",
    "Blocks fill the left ~70 % at full height; the right side stays free for a picture-in-picture camera.",
    {
      "--cap-panel-width": "68vw",
      "--cap-panel-height": "100vh",
      "--cap-panel-justify": "flex-start",
      "--cap-panel-bg": "rgba(14, 14, 16, 0.94)",
      "--cap-panel-padding": "24px",
      "--cap-fade-mask": "22%",
      "--cap-max-chars": "60ch",
    },
    { layout: "blocks", bg: "panel", size: 46 },
  ),
  preset(
    "large-print",
    "Large print",
    "Very large text with only the last two blocks on screen, readable from the back of the hall.",
    {
      "--cap-block-padding": "18px 30px",
      "--cap-block-gap": "14px",
      "--cap-block-radius": "16px",
      "--cap-old-opacity": "0.6",
      "--cap-fade-mask": "0%",
      "--cap-font-weight": "600",
      "--cap-line-height": "1.28",
      "--cap-max-chars": "40ch",
      "--cap-accent-width": "6px",
      "--cap-src-scale": "0.6",
      "--cap-hon-scale": "1.2em",
    },
    { layout: "blocks", bg: "panel", size: 76, visibleBlocks: 2 },
  ),
  preset(
    "lower-third",
    "Lower third",
    "The classic roll-up band at the bottom: Arabic above, translation below, two lines each.",
    {
      "--cap-panel-bg": "transparent",
      "--cap-panel-width": "90vw",
      "--cap-panel-padding": "8px",
      "--cap-block-bg": "rgba(8, 8, 10, 0.72)",
      "--cap-block-bg-new": "rgba(8, 8, 10, 0.72)",
      "--cap-block-border": "none",
      "--cap-block-radius": "12px",
      "--cap-block-padding": "6px 28px",
      "--cap-block-gap": "8px",
      "--cap-font-weight": "600",
      "--cap-line-height": "1.3",
      "--cap-text-shadow": SOFT_TEXT,
      "--cap-text-align": "center",
      "--cap-max-chars": "none",
      "--cap-src-scale": "1.1",
      "--cap-src-color": "#ffffff",
      "--cap-src-opacity": "0.9",
      "--cap-hon-color": "currentcolor",
    },
    { layout: "rollup", bg: "band", show: "both", lines: 2, size: 44, partial: false },
  ),
  preset(
    "cinema",
    "Cinema",
    "Roll-up subtitles like a film: large white text with a deep shadow, no band at all.",
    {
      "--cap-panel-bg": "transparent",
      "--cap-panel-width": "86vw",
      "--cap-panel-padding": "12px",
      "--cap-block-bg": "transparent",
      "--cap-block-bg-new": "transparent",
      "--cap-block-border": "none",
      "--cap-block-padding": "0px 12px",
      "--cap-font-weight": "600",
      "--cap-line-height": "1.25",
      "--cap-letter-spacing": "0.3px",
      "--cap-text-shadow": STRONG_TEXT,
      "--cap-text-align": "center",
      "--cap-max-chars": "none",
      "--cap-src-scale": "1.1",
      "--cap-src-color": "#ffffff",
      "--cap-src-opacity": "0.9",
      "--cap-hon-color": "currentcolor",
    },
    { layout: "rollup", bg: "shadow", show: "target", lines: 2, size: 56, partial: false },
  ),
];

/** Every theme variable of the default preset (fills gaps in custom presets). */
export const DEFAULT_VARS: Readonly<Record<ThemeVar, string>> = DARK;

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_PRESETS.map((p) => p.id));

export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** A preset by id: built-ins first (custom presets cannot shadow them), then custom ones. */
export function findPreset(
  id: string | null | undefined,
  custom: readonly ThemePreset[] = [],
): ThemePreset | undefined {
  if (id === null || id === undefined || id === "") return undefined;
  const key = id.trim().toLowerCase();
  return BUILTIN_PRESETS.find((p) => p.id === key) ?? custom.find((p) => p.id === key);
}

// --- low-level parsing -----------------------------------------------------------------------------

const NUM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const NUM_UNIT = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/i;
/** Characters any non-font value may contain (no quotes, ; { } \ @ < > : etc.). */
const SAFE_CHARS = /^[a-z0-9#%.,()\s/+-]*$/i;
const MAX_LEN = 300;

const NAMED_COLORS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  orange: [255, 165, 0, 1],
  gold: [255, 215, 0, 1],
  silver: [192, 192, 192, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  navy: [0, 0, 128, 1],
  teal: [0, 128, 128, 1],
  maroon: [128, 0, 0, 1],
  purple: [128, 0, 128, 1],
  lime: [0, 255, 0, 1],
  cyan: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1],
  ivory: [255, 255, 240, 1],
  beige: [245, 245, 220, 1],
};

/** Canonical number text ("0.70" → "0.7", "-0" → "0"). */
function fmtNum(n: number): string {
  const r = Math.round(n * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
}

/** Split at top-level separators (commas or whitespace), respecting parentheses. */
function splitTop(s: string, sep: "," | " "): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return null;
    }
    const isSep = sep === "," ? ch === "," : /\s/.test(ch);
    if (isSep && depth === 0) {
      if (sep === ",") out.push(cur.trim());
      else if (cur !== "") out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (depth !== 0) return null;
  if (sep === ",") out.push(cur.trim());
  else if (cur !== "") out.push(cur);
  return out;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Parse a colour argument ("12", "50%", "120deg"). */
function colorArg(tok: string): { n: number; unit: string } | null {
  const m = NUM_UNIT.exec(tok);
  if (m === null || m[1] === undefined) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit !== "" && unit !== "%" && unit !== "deg") return null;
  return { n: Number(m[1]), unit };
}

/** Canonical colour (lower-case #hex, rgb()/rgba()/hsl()/hsla() with numeric arguments, a few
 *  named colours) or null. Hex may come without "#" (URL friendly: fg=ffffff). */
export function parseColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (s === "" || s.length > 80 || !SAFE_CHARS.test(s)) return null;
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex?.[1] !== undefined) {
    const h = hex[1];
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    return `#${full}`;
  }
  if (s === "currentcolor") return s;
  if (s in NAMED_COLORS) return s;
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (fn?.[1] === undefined || fn[2] === undefined) return null;
  const name = fn[1];
  const body = fn[2].trim();
  // "r g b / a", "r, g, b", "r, g, b, a"
  let parts: string[];
  let alpha: string | null = null;
  if (body.includes(",")) {
    parts = body.split(",").map((p) => p.trim());
    if (parts.length === 4) alpha = parts.pop() ?? null;
  } else {
    const [main, a, extra] = body.split("/").map((p) => p.trim());
    if (main === undefined || extra !== undefined) return null;
    parts = main.split(/\s+/);
    alpha = a ?? null;
  }
  if (parts.length !== 3) return null;
  const args: string[] = [];
  for (const [i, p] of parts.entries()) {
    const a = colorArg(p);
    if (a === null) return null;
    if (a.unit === "deg" && !(name.startsWith("hsl") && i === 0)) return null;
    if (a.n < -360 || a.n > 360) return null;
    args.push(fmtNum(a.n) + a.unit);
  }
  if (alpha !== null) {
    const a = colorArg(alpha);
    if (a === null || a.unit === "deg" || a.n < 0 || a.n > (a.unit === "%" ? 100 : 1)) return null;
    args.push(fmtNum(a.n) + a.unit);
  }
  const base = name.startsWith("rgb") ? "rgb" : "hsl";
  return `${base}${args.length === 4 ? "a" : ""}(${args.join(", ")})`;
}

/** RGBA components of a canonical (or raw) colour; null for gradients, currentcolor etc. */
export function colorToRgba(raw: string): Rgba | null {
  const c = parseColor(raw);
  if (c === null || c === "currentcolor") return null;
  const named = NAMED_COLORS[c];
  if (named !== undefined) return { r: named[0], g: named[1], b: named[2], a: named[3] };
  if (c.startsWith("#")) {
    const v = c.slice(1);
    const byte = (i: number): number => Number.parseInt(v.slice(i, i + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: v.length === 8 ? byte(6) / 255 : 1 };
  }
  // Anything else parseColor returns is "rgb(…)", "rgba(…)", "hsl(…)" or "hsla(…)" with 3–4
  // canonical arguments.
  const [x = "", y = "", z = "", alpha] = c.slice(c.indexOf("(") + 1, -1).split(", ");
  const num = (t: string, scale: number): number =>
    t.endsWith("%") ? (Number(t.slice(0, -1)) / 100) * scale : Number(t.replace("deg", ""));
  const a = Math.min(1, Math.max(0, alpha === undefined ? 1 : num(alpha, 1)));
  if (c.startsWith("rgb")) {
    const ch = (t: string): number => Math.round(Math.min(255, Math.max(0, num(t, 255))));
    return { r: ch(x), g: ch(y), b: ch(z), a };
  }
  const pct = (t: string): number =>
    Math.min(1, Math.max(0, t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t) / 100));
  const [r, g, b] = hslToRgb(num(x, 1), pct(y), pct(z));
  return { r, g, b, a };
}

/** "#rrggbb" (opaque) or "#rrggbbaa". */
export function rgbaToHex(c: Rgba): string {
  const h = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return c.a >= 0.999 ? base : `${base}${h(c.a * 255)}`;
}

const LENGTH_CAP: Readonly<Record<string, number>> = {
  px: 4000,
  em: 100,
  rem: 100,
  ch: 200,
  "%": 100,
  vw: 100,
  vh: 100,
  vmin: 100,
  vmax: 100,
};

/** A length with a unit; bare numbers get `defUnit`. `min`/`max` apply in `defUnit`. */
function parseLength(
  raw: string,
  defUnit: string,
  min: number,
  max: number,
  units: readonly string[] = Object.keys(LENGTH_CAP),
): string | null {
  const m = NUM_UNIT.exec(raw.trim());
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase() || defUnit;
  if (!units.includes(unit)) return null;
  const cap = LENGTH_CAP[unit] ?? 0;
  if (unit === defUnit ? n < min || n > max : n < Math.min(0, min) || Math.abs(n) > cap) {
    return null;
  }
  return `${fmtNum(n)}${unit}`;
}

function parseGradient(s: string): string | null {
  const m = /^(linear|radial)-gradient\((.*)\)$/.exec(s);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const args = splitTop(m[2], ",");
  if (args === null || args.length < 2 || args.length > 9) return null;
  const out: string[] = [];
  let first = args[0] ?? "";
  const side = "(?:left|right|top|bottom)";
  if (m[1] === "linear") {
    const angle = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(deg|turn)$/.exec(first);
    if (angle?.[1] !== undefined && angle[2] !== undefined) {
      out.push(`${fmtNum(Number(angle[1]))}${angle[2]}`);
      args.shift();
    } else if (new RegExp(`^to ${side}(?: ${side})?$`).test(first.replace(/\s+/g, " "))) {
      out.push(first.replace(/\s+/g, " "));
      args.shift();
    }
  } else {
    first = first.replace(/\s+/g, " ");
    const pos = "(?:center|top|bottom|left|right)";
    if (
      new RegExp(`^(?:circle|ellipse)?(?: ?at ${pos}(?: ${pos})?)?$`).test(first) &&
      first !== ""
    ) {
      out.push(first.trim());
      args.shift();
    }
  }
  // 2–8 colour stops (docs/presets.md), after the optional direction or shape.
  if (args.length < 2 || args.length > 8) return null;
  for (const stop of args) {
    const toks = splitTop(stop, " ");
    if (toks === null || toks.length < 1 || toks.length > 3) return null;
    const color = parseColor(toks[0] ?? "");
    if (color === null) return null;
    const rest: string[] = [];
    for (const t of toks.slice(1)) {
      const len = parseLength(t, "%", -100, 200, ["%", "px"]);
      if (len === null) return null;
      rest.push(len);
    }
    out.push([color, ...rest].join(" "));
  }
  return `${m[1]}-gradient(${out.join(", ")})`;
}

function parseShadow(s: string, text: boolean): string | null {
  const keyword = (text ? TEXT_SHADOWS : BOX_SHADOWS)[s];
  if (keyword !== undefined) return keyword;
  const layers = splitTop(s, ",");
  if (layers === null || layers.length > 6) return null;
  const out: string[] = [];
  for (const layer of layers) {
    const toks = splitTop(layer, " ");
    if (toks === null || toks.length === 0) return null;
    const lens: string[] = [];
    let color: string | null = null;
    let inset = false;
    for (const t of toks) {
      if (t === "inset" && !text && !inset) {
        inset = true;
        continue;
      }
      const len = parseLength(t, "px", -200, 200, ["px", "em", "rem"]);
      if (len !== null) {
        lens.push(len === "0px" ? "0" : len);
        continue;
      }
      const c = parseColor(t);
      if (c === null || color !== null) return null;
      color = c;
    }
    if (lens.length < 2 || lens.length > (text ? 3 : 4)) return null;
    out.push([inset ? "inset" : "", ...lens, color ?? ""].filter((x) => x !== "").join(" "));
  }
  return out.join(", ");
}

function parseBorder(s: string): string | null {
  if (s === "none" || s === "0" || s === "0px") return "none";
  const toks = splitTop(s, " ");
  if (toks === null || toks.length === 0 || toks.length > 3) return null;
  let width: string | null = null;
  let style: string | null = null;
  let color: string | null = null;
  for (const t of toks) {
    if (["solid", "dashed", "dotted", "double"].includes(t) && style === null) {
      style = t;
      continue;
    }
    const len = parseLength(t, "px", 0, 20, ["px", "em"]);
    if (len !== null && width === null) {
      width = len;
      continue;
    }
    const c = parseColor(t);
    if (c === null || color !== null) return null;
    color = c;
  }
  if (width === null) return null;
  return [width, style ?? "solid", color ?? "currentcolor"].join(" ");
}

function parseFont(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const f = FONT_CHOICES.find(
    (c) =>
      c.key === s ||
      c.label.toLowerCase() === s ||
      c.stack.toLowerCase() === s ||
      c.label.toLowerCase().replace(/ /g, "-") === s,
  );
  return f === undefined ? null : f.stack;
}

/**
 * Canonical CSS value for a theme variable, or null when the value isn't allowed. Accepts both
 * the URL-friendly short forms (fg=ffffff, radius=12, width=70, font=georgia, shadow=strong) and
 * normal CSS (#ffffff, 12px, 70vw, a full allow-listed font stack). Idempotent.
 */
export function parseVarValue(name: ThemeVar, raw: string): string | null {
  const spec = VAR_SPECS[name];
  const kind = spec.kind;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > MAX_LEN) return null;
  if (kind.type === "font") return parseFont(value);
  const s = value.toLowerCase().replace(/\s+/g, " ");
  if (!SAFE_CHARS.test(s)) return null;
  switch (kind.type) {
    case "color":
      return parseColor(s);
    case "paint":
      if (s === "none") return "none";
      return parseColor(s) ?? parseGradient(s);
    case "length":
      return parseLength(s, kind.unit, kind.min, kind.max, kind.units);
    case "padding": {
      const toks = s.split(" ");
      if (toks.length > 2) return null;
      const out: string[] = [];
      for (const t of toks) {
        const len = parseLength(t, "px", 0, kind.max, ["px", "em", "rem", "vw", "vh", "%"]);
        if (len === null) return null;
        out.push(len);
      }
      return out.join(" ");
    }
    case "percent":
      return parseLength(s, "%", 0, kind.max, ["%"]);
    case "number": {
      if (!NUM.test(s)) return null;
      const n = Number(s);
      return n >= kind.min && n <= kind.max ? fmtNum(n) : null;
    }
    case "weight": {
      const w = s === "normal" ? 400 : s === "bold" ? 700 : NUM.test(s) ? Number(s) : Number.NaN;
      return Number.isInteger(w) && w >= 100 && w <= 900 ? String(w) : null;
    }
    case "shadow":
      return parseShadow(s, kind.text);
    case "border":
      return parseBorder(s);
    case "justify":
      if (["left", "start", "flex-start"].includes(s)) return "flex-start";
      if (["center", "centre", "middle"].includes(s)) return "center";
      if (["right", "end", "flex-end"].includes(s)) return "flex-end";
      return null;
    case "align":
      return ["left", "center", "right", "justify", "start", "end"].includes(s) ? s : null;
    case "measure":
      if (s === "none" || s === "0" || s === "0ch") return "none";
      return parseLength(s, "ch", 10, 200, ["ch"]);
    case "time": {
      const m = /^((?:\d+(?:\.\d+)?|\.\d+))(ms|s)?$/.exec(s);
      if (m?.[1] === undefined) return null;
      const n = Number(m[1]);
      const ms = m[2] === "s" ? n * 1000 : n;
      return ms >= 0 && ms <= 5000 ? `${fmtNum(n)}${m[2] ?? "ms"}` : null;
    }
    case "fontSize": {
      const m = /^min\(([^,]+), ?([^,]+)\)$/.exec(s);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        const px = parseLength(m[1], "px", 8, 300, ["px"]);
        const fit = parseLength(m[2], "vw", 1, 100, ["vw", "px"]);
        return px === null || fit === null ? null : `min(${px}, ${fit})`;
      }
      return parseLength(s, "px", 8, 300, ["px"]);
    }
  }
}

/** Short URL form of a canonical value (#ffffff → ffffff, 12px → 12, a stack → its key …). */
export function shortVarValue(name: ThemeVar, css: string): string {
  const kind = VAR_SPECS[name].kind;
  switch (kind.type) {
    case "color":
    case "paint":
      return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(css) ? css.slice(1) : css;
    case "length":
      return css.endsWith(kind.unit) && NUM.test(css.slice(0, -kind.unit.length))
        ? css.slice(0, -kind.unit.length)
        : css;
    case "padding":
      return css
        .split(" ")
        .map((t) => (t.endsWith("px") ? t.slice(0, -2) : t))
        .join(" ");
    case "percent":
      return css.endsWith("%") ? css.slice(0, -1) : css;
    case "measure":
      return css.endsWith("ch") ? css.slice(0, -2) : css;
    case "time":
      return css.endsWith("ms") ? css.slice(0, -2) : css;
    case "font":
      return FONT_CHOICES.find((f) => f.stack === css)?.key ?? css;
    case "justify":
      return css === "flex-start" ? "left" : css === "flex-end" ? "right" : css;
    case "shadow": {
      const table = kind.text ? TEXT_SHADOWS : BOX_SHADOWS;
      return Object.entries(table).find(([, v]) => v === css)?.[0] ?? css;
    }
    default:
      return css;
  }
}

/** Values are equal for the theme (colours compared by RGBA, so rgba(17,17,17,.92) ≈ #111111eb). */
export function sameVarValue(
  name: ThemeVar,
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ca = parseVarValue(name, a);
  const cb = parseVarValue(name, b);
  if (ca === null || cb === null) return ca === cb;
  if (ca === cb) return true;
  const kind = VAR_SPECS[name].kind.type;
  if (kind === "color" || kind === "paint") {
    const x = colorToRgba(ca);
    const y = colorToRgba(cb);
    if (x === null || y === null) return false;
    return x.r === y.r && x.g === y.g && x.b === y.b && Math.abs(x.a - y.a) < 0.004;
  }
  return false;
}

/** Only the allowed variables with valid values (untrusted input: URL, presets.yaml, API). */
export function sanitizeVars(input: unknown): ThemeVars {
  const out: ThemeVars = {};
  if (typeof input !== "object" || input === null) return out;
  const rec = input as Record<string, unknown>;
  for (const name of THEME_VARS) {
    const v = rec[name];
    if (typeof v !== "string") continue;
    const canon = parseVarValue(name, v);
    if (canon !== null) out[name] = canon;
  }
  return out;
}

function parseOption<K extends keyof DisplayOptions>(
  key: K,
  raw: unknown,
): DisplayOptions[K] | undefined {
  const kind = OPTION_SPECS[key].kind;
  if (kind.type === "bool") {
    if (typeof raw === "boolean") return raw as DisplayOptions[K];
    if (typeof raw !== "string" && typeof raw !== "number") return undefined;
    const s = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true as DisplayOptions[K];
    if (["0", "false", "no", "off"].includes(s)) return false as DisplayOptions[K];
    return undefined;
  }
  if (kind.type === "int") {
    const n =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
    if (typeof raw === "string" && raw.trim() === "") return undefined;
    if (!Number.isFinite(n)) return undefined;
    return Math.min(kind.max, Math.max(kind.min, Math.round(n))) as DisplayOptions[K];
  }
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  const v = kind.aliases?.[s] ?? s;
  return kind.values.includes(v) ? (v as DisplayOptions[K]) : undefined;
}

/** Only known display options with valid values. */
export function sanitizeOptions(input: unknown): Partial<DisplayOptions> {
  const out: Partial<DisplayOptions> = {};
  if (typeof input !== "object" || input === null) return out;
  const rec = input as Record<string, unknown>;
  for (const key of OPTION_KEYS) {
    const v = parseOption(key, rec[key]);
    if (v !== undefined) Object.assign(out, { [key]: v });
  }
  return out;
}

/** A sanitized copy of an untrusted preset, or null when id/name are unusable. */
export function sanitizePreset(input: unknown): ThemePreset | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{1,48}$/.test(id)) return null;
  const name = typeof rec.name === "string" && rec.name.trim() !== "" ? rec.name.trim() : id;
  const description = typeof rec.description === "string" ? rec.description.trim() : "";
  return {
    id,
    name: name.slice(0, 60),
    description: description.slice(0, 300),
    vars: sanitizeVars(rec.vars),
    options: sanitizeOptions(rec.options),
  };
}

// --- background opacity (panelOpacity / blockOpacity) --------------------------------------------

/** URL parameters (0–100 %) that set only the alpha of the panel / block backgrounds. They are
 *  applied after the per-variable overrides and keep each colour's RGB; transparent, `none`
 *  and gradient backgrounds are left alone. */
export const OPACITY_GROUPS: ReadonlyArray<{ param: string; vars: readonly ThemeVar[] }> = [
  { param: "panelOpacity", vars: ["--cap-panel-bg"] },
  { param: "blockOpacity", vars: ["--cap-block-bg", "--cap-block-bg-new"] },
];

/** Alpha (0–1) of a plain colour (0 for transparent); null for none, gradients, currentcolor. */
export function alphaOf(css: string | undefined): number | null {
  if (css === undefined) return null;
  return colorToRgba(css)?.a ?? null;
}

/** `color` with its alpha set to `alpha` (0–1) as rgba(); "transparent" stays as it is;
 *  none, gradients, currentcolor and invalid colours give null. */
export function withAlpha(color: string, alpha: number): string | null {
  const c = parseColor(color);
  const rgba = c === null ? null : colorToRgba(c);
  if (rgba === null || !Number.isFinite(alpha)) return null;
  if (c === "transparent") return c;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${fmtNum(a)})`;
}

/** An opacity parameter (0–100, "%" allowed) as an alpha 0–1, or null. */
function parseOpacity(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(raw);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n / 100 : null;
}

/** Set the alpha of the variables that hold a visible plain colour. */
function applyOpacity(vars: ThemeVars, names: readonly ThemeVar[], alpha: number): void {
  for (const name of names) {
    const v = vars[name];
    const a = alphaOf(v);
    if (v === undefined || a === null || a === 0) continue;
    const c = withAlpha(v, alpha);
    if (c !== null) vars[name] = c;
  }
}

/** alpha × 100 when it is a whole percentage, else null. */
function wholePct(a: number): number | null {
  const p = Math.round(a * 100);
  return Math.abs(a * 100 - p) < 1e-6 ? p : null;
}

/**
 * Readable link params for one opacity group: `#rgb` colour params for RGB changes plus one
 * opacity param (e.g. `panelOpacity=100`). [] when nothing changed; null when the overrides
 * can't be written that way exactly (then the colour params are emitted as usual).
 */
function opacityGroupParams(
  group: { param: string; vars: readonly ThemeVar[] },
  overrides: ThemeVars,
  base: Readonly<Record<ThemeVar, string>>,
): Array<[string, string]> | null {
  let pct: number | null = null;
  const out: Array<[string, string]> = [];
  const unchangedAlphas: number[] = [];
  let needOpacity = false;
  for (const name of group.vars) {
    const b = base[name];
    const o = overrides[name];
    const canon = o === undefined ? null : parseVarValue(name, o);
    if (canon === null || sameVarValue(name, canon, b)) {
      const ba = alphaOf(b);
      if (ba !== null && ba > 0) unchangedAlphas.push(ba);
      continue;
    }
    const rgba = canon === "currentcolor" ? null : colorToRgba(canon);
    if (rgba === null) return null;
    const p = wholePct(rgba.a);
    if (p === null || (pct !== null && pct !== p)) return null;
    pct = p;
    const br = colorToRgba(b);
    const ba = alphaOf(b);
    const rgbSame =
      br !== null && ba !== null && ba > 0 && br.r === rgba.r && br.g === rgba.g && br.b === rgba.b;
    if (rgbSame) {
      needOpacity = true;
    } else {
      out.push([VAR_SPECS[name].param, shortVarValue(name, rgbaToHex({ ...rgba, a: 1 }))]);
      if (p !== 100) needOpacity = true;
    }
  }
  if (pct === null) return [];
  if (needOpacity) {
    // The opacity param also reaches the group's unchanged colours: they must already match.
    if (unchangedAlphas.some((a) => wholePct(a) !== pct)) return null;
    out.push([group.param, String(pct)]);
  }
  return out;
}

// --- resolve / apply / query -----------------------------------------------------------------------

export interface ResolvedTheme {
  presetId: string;
  vars: ThemeVars;
  options: DisplayOptions;
}

/** Options the preset or the URL set explicitly (others follow the layout's defaults). */
interface Explicit {
  partial: boolean;
  show: boolean;
}

/** Layout defaults when neither the preset nor the URL sets them: blocks → show=target,
 *  partial=0 (calm, complete blocks); rollup → show=both, partial=1 (live, growing text). */
function layoutDefaults(o: DisplayOptions, set: Explicit): void {
  if (!set.partial) o.partial = o.layout === "rollup";
  if (!set.show) o.show = o.layout === "rollup" ? "both" : "target";
}

/** Make layout-dependent options consistent (bg values differ per layout; defaults above). */
function finishOptions(o: DisplayOptions, set: Explicit): DisplayOptions {
  const out = { ...o };
  if (out.layout === "rollup" && out.bg === "panel") out.bg = "band";
  if (out.layout === "blocks" && out.bg === "band") out.bg = "panel";
  if (out.layout === "blocks" && out.bg === "shadow") out.bg = "none";
  layoutDefaults(out, set);
  return out;
}

function presetExplicit(opts: Partial<DisplayOptions>): Explicit {
  return { partial: opts.partial !== undefined, show: opts.show !== undefined };
}

/** The full variables + options of a preset (defaults filled in, values sanitized). */
export function presetTheme(p: ThemePreset): {
  vars: Record<ThemeVar, string>;
  options: DisplayOptions;
} {
  const opts = sanitizeOptions(p.options);
  const options = finishOptions({ ...DEFAULT_OPTIONS, ...opts }, presetExplicit(opts));
  const vars: Record<ThemeVar, string> = { ...DEFAULT_VARS, ...sanitizeVars(p.vars) };
  vars["--cap-font-size"] = fontSizeVar(options.size);
  return { vars, options };
}

/** Case-insensitive first-value lookup of URL parameters. */
function paramMap(params: URLSearchParams): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of params) {
    const key = k.trim().toLowerCase();
    if (!map.has(key)) map.set(key, v);
  }
  return map;
}

/**
 * Theme of a caption page / overlay URL: `?preset=` (else `defaultId`, else mosque-dark), then
 * the display options (layout, bg, show, size, …) and the short per-variable overrides (fg,
 * blockBg, radius, font, …). Invalid values are dropped silently. `--cap-font-size` always
 * follows `size`.
 */
export function resolveTheme(
  params: URLSearchParams,
  custom: readonly ThemePreset[] = [],
  defaultId: string = DEFAULT_PRESET_ID,
): ResolvedTheme {
  const q = paramMap(params);
  const base =
    findPreset(q.get("preset"), custom) ?? findPreset(defaultId, custom) ?? DEFAULT_PRESET;
  const presetOpts = sanitizeOptions(base.options);
  const opts: DisplayOptions = { ...DEFAULT_OPTIONS, ...presetOpts };
  const set = presetExplicit(presetOpts);
  let bgSet = false;
  for (const key of OPTION_KEYS) {
    const spec = OPTION_SPECS[key];
    const names = [spec.param, ...(spec.aliases ?? [])].map((n) => n.toLowerCase());
    const raw = names.map((n) => q.get(n)).find((v) => v !== undefined);
    if (raw === undefined) continue;
    const v = parseOption(key, raw);
    if (v === undefined) continue;
    Object.assign(opts, { [key]: v });
    if (key === "partial") set.partial = true;
    if (key === "show") set.show = true;
    if (key === "bg") bgSet = true;
  }
  // A layout switch by URL brings that layout's natural background unless bg is given too.
  if (!bgSet && opts.layout !== (presetOpts.layout ?? DEFAULT_OPTIONS.layout)) {
    opts.bg = opts.layout === "rollup" ? "band" : "panel";
  }
  const options = finishOptions(opts, set);

  const vars: ThemeVars = { ...DEFAULT_VARS, ...sanitizeVars(base.vars) };
  for (const name of THEME_VARS) {
    const spec = VAR_SPECS[name];
    if (spec.kind.type === "fontSize") continue;
    const raw = q.get(spec.param.toLowerCase());
    if (raw === undefined) continue;
    const canon = parseVarValue(name, raw);
    if (canon !== null) vars[name] = canon;
  }
  for (const g of OPACITY_GROUPS) {
    const alpha = parseOpacity(q.get(g.param.toLowerCase()));
    if (alpha !== null) applyOpacity(vars, g.vars, alpha);
  }
  vars["--cap-font-size"] = fontSizeVar(options.size);
  return { presetId: base.id, vars, options };
}

/** Anything with a CSSOM style (an HTMLElement); kept structural so this module stays DOM-free. */
export interface StyleTarget {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

/** Set the theme variables on `root` via the CSSOM (CSP-safe). Values are re-validated; invalid
 *  ones are skipped. Variables not in `vars` are left as they are (see clearTheme). */
export function applyTheme(root: StyleTarget, vars: ThemeVars): void {
  for (const name of THEME_VARS) {
    const v = vars[name];
    if (v === undefined) continue;
    const canon = parseVarValue(name, v);
    if (canon !== null) root.style.setProperty(name, canon);
  }
}

/** Remove every theme variable from `root`. */
export function clearTheme(root: StyleTarget): void {
  for (const name of THEME_VARS) root.style.removeProperty(name);
}

export interface ThemeQueryContext {
  custom?: readonly ThemePreset[];
  /** The server's default preset; `preset=` is omitted when it matches. */
  defaultPreset?: string;
}

function optionText(v: DisplayOptions[keyof DisplayOptions]): string {
  return typeof v === "boolean" ? (v ? "1" : "0") : String(v);
}

/**
 * The minimal query string (without "?") that reproduces `presetId` + `overrides` + `options`
 * through resolveTheme: only values that differ from the preset are included, in short form.
 */
export function themeQuery(
  presetId: string,
  overrides: ThemeVars,
  options: Partial<DisplayOptions>,
  ctx: ThemeQueryContext = {},
): string {
  const custom = ctx.custom ?? [];
  const p = findPreset(presetId, custom) ?? DEFAULT_PRESET;
  const base = presetTheme(p);
  const q = new URLSearchParams();
  if (p.id !== (ctx.defaultPreset ?? DEFAULT_PRESET_ID)) q.set("preset", p.id);
  const want = sanitizeOptions(options);
  // Compare against what resolveTheme would derive once the earlier params are applied.
  const layoutChanged = want.layout !== undefined && want.layout !== base.options.layout;
  const effBase: DisplayOptions = { ...base.options };
  if (layoutChanged && want.layout !== undefined) {
    effBase.layout = want.layout;
    effBase.bg = want.layout === "rollup" ? "band" : "panel";
    layoutDefaults(effBase, presetExplicit(sanitizeOptions(p.options)));
  }
  for (const key of OPTION_KEYS) {
    const v = want[key];
    if (v === undefined) continue;
    if (v !== effBase[key] || (key === "layout" && layoutChanged)) {
      q.set(OPTION_SPECS[key].param, optionText(v));
    }
  }
  // Alpha-only changes of the panel / block backgrounds read best as panelOpacity / blockOpacity.
  const groupParams = new Map<ThemeVar, Array<[string, string]>>();
  const handled = new Set<ThemeVar>();
  for (const g of OPACITY_GROUPS) {
    const params = opacityGroupParams(g, overrides, base.vars);
    const first = g.vars[0];
    if (params === null || first === undefined) continue;
    for (const v of g.vars) handled.add(v);
    groupParams.set(first, params);
  }
  for (const name of THEME_VARS) {
    for (const [k, v] of groupParams.get(name) ?? []) q.set(k, v);
    const spec = VAR_SPECS[name];
    if (spec.kind.type === "fontSize" || handled.has(name)) continue;
    const v = overrides[name];
    if (v === undefined) continue;
    const canon = parseVarValue(name, v);
    if (canon === null || sameVarValue(name, canon, base.vars[name])) continue;
    q.set(spec.param, shortVarValue(name, canon));
  }
  return q.toString();
}
