// The look editor (GET /app/look): pick a preset, fine-tune every theme variable and display option
// with a live preview, then save the look as a custom preset (POST/DELETE /api/presets: the login
// cookie; a legacy ?token= is sent as Bearer) or, on a local install, copy a caption / overlay
// link. In English, Dutch and Arabic (web/shared/app-i18n.ts).
// The preview is resolved exactly like a caption page resolves its URL:
// themeQuery(state) → resolveTheme(that query), so what you see is what the link shows.
// `?view=preview&<theme params>` renders only the stage, full window (the "Full preview" link).
// Hosted mode: no overlay link and no server default (both belong to the server's operator).
import "./customize.css";
import {
  alphaOf,
  applyTheme,
  BOX_SHADOWS,
  BUILTIN_PRESETS,
  colorToRgba,
  DEFAULT_PRESET_ID,
  FONT_CHOICES,
  findPreset,
  isBuiltinPresetId,
  parseVarValue,
  presetTheme,
  type ResolvedTheme,
  resolveTheme,
  rgbaToHex,
  sameVarValue,
  sanitizeOptions,
  sanitizePreset,
  sanitizeVars,
  TEXT_SHADOWS,
  type ThemeVars,
  themeQuery,
  withAlpha,
} from "../src/shared/theme.js";
import type { DisplayOptions, ThemePreset, ThemeVar } from "../src/shared/theme-vars.js";
import { type AppMode, authStateOnce, fetchMe, loginUrl, waitText } from "./admin-api.js";
import { copyText as copyToClipboard, toast as showToast } from "./admin-ui.js";
import { isMsgKey, type MsgKey, onLangChange, t, tn } from "./shared/app-i18n.js";
import {
  fillNodes,
  initPage,
  isAdminRole,
  mountFooter,
  mountHeader,
  setTitle,
} from "./shared/app-shell.js";
import { byId, el, storageGet, storageSet } from "./shared/dom.js";
import {
  appPlacementLabels,
  type HPos,
  lengthPct,
  placementAdjust,
  placementPicker,
} from "./shared/placement-picker.js";
import {
  buildStage,
  fitStage,
  renderPresetPreview,
  type StageBackdrop,
  type StageSample,
  stageVars,
  withHonorifics,
} from "./shared/preset-preview.js";

// --- state -------------------------------------------------------------------------------------

type Aspect = "hd" | "lower" | "phone";
type OptKey = keyof DisplayOptions;
type BoolKey = { [K in OptKey]: DisplayOptions[K] extends boolean ? K : never }[OptKey];
type IntKey = { [K in OptKey]: DisplayOptions[K] extends number ? K : never }[OptKey];

const ASPECTS: Readonly<Record<Aspect, { w: number; h: number; label: MsgKey; caption: MsgKey }>> =
  {
    hd: { w: 1920, h: 1080, label: "lk.aspectHd", caption: "lk.capHd" },
    lower: { w: 1920, h: 400, label: "lk.aspectLower", caption: "lk.capLower" },
    phone: { w: 390, h: 844, label: "lk.aspectPhone", caption: "lk.capPhone" },
  };
const BACKDROPS: readonly StageBackdrop[] = ["video", "dark", "light", "checker"];
const SAMPLES: readonly StageSample[] = ["khutbah", "events"];

interface Work {
  presetId: string;
  overrides: ThemeVars;
  options: Partial<DisplayOptions>;
  from: string;
  to: string;
  aspect: Aspect;
  backdrop: StageBackdrop;
  sample: StageSample;
  browser: boolean;
  open: string[];
  /** Width/height set automatically by a placement pick (undone by the opposite pick). */
  auto: { width: boolean; height: boolean };
}

const STORE = "captions.customize.v1";
const query = new URLSearchParams(window.location.search);
const token = query.get("token");

let custom: ThemePreset[] = [];
let defaultPreset = DEFAULT_PRESET_ID;
let serverOk = true;
/** Hosted mode: the server default and the overlay belong to the operator (hidden here). */
let mode: AppMode = "local";
/** Owners and admins save looks (and a local page without a login); a user only looks. */
let canSave = true;
/** The caption language the builder opened this page with (?to=), for the sample text. */
const linkTo = query.get("to");
let w: Work = {
  presetId: DEFAULT_PRESET_ID,
  overrides: {},
  options: {},
  from: "ar",
  to: "nl",
  aspect: "hd",
  backdrop: "video",
  sample: "khutbah",
  browser: false,
  open: ["layout", "panel", "text"],
  auto: { width: false, height: false },
};

function oneOf<T extends string>(v: unknown, list: readonly T[], def: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : def;
}

function langCode(v: unknown, def: string): string {
  return typeof v === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$|^auto$/.test(v) ? v : def;
}

function restore(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(storageGet(STORE) ?? "null");
  } catch {
    raw = null;
  }
  if (typeof raw !== "object" || raw === null) return;
  const r = raw as Record<string, unknown>;
  w = {
    presetId: typeof r.presetId === "string" ? r.presetId : w.presetId,
    overrides: sanitizeVars(r.overrides),
    options: sanitizeOptions(r.options),
    from: langCode(r.from, w.from),
    to: langCode(r.to, w.to),
    aspect: oneOf(r.aspect, ["hd", "lower", "phone"] as const, w.aspect),
    backdrop: oneOf(r.backdrop, BACKDROPS, w.backdrop),
    sample: oneOf(r.sample, SAMPLES, w.sample),
    browser: r.browser === true,
    open: Array.isArray(r.open) ? r.open.filter((x): x is string => typeof x === "string") : w.open,
    auto: autoFlags(r.auto),
  };
}

function autoFlags(raw: unknown): { width: boolean; height: boolean } {
  const a = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { width: a.width === true, height: a.height === true };
}

/** A slider moved by the user: its value is no longer an automatic placement size. */
function userTouched(v: ThemeVar): void {
  if (v === "--cap-panel-width") w.auto.width = false;
  if (v === "--cap-panel-height") w.auto.height = false;
}

function persist(): void {
  storageSet(STORE, JSON.stringify(w));
}

/** mosque-dark, a built-in: the default when the server names none it has. */
const BUILTIN_DEFAULT = findPreset(DEFAULT_PRESET_ID) as ThemePreset;

/** The look being edited, else the server's default (defaultPreset always names a known look). */
function currentPreset(): ThemePreset {
  return findPreset(w.presetId, custom) ?? findPreset(defaultPreset, custom) ?? BUILTIN_DEFAULT;
}

function ctx(): { custom: ThemePreset[]; defaultPreset: string } {
  return { custom, defaultPreset };
}

/** The theme query of the current state (only differences from the preset). */
function themeQs(): string {
  return themeQuery(currentPreset().id, w.overrides, w.options, ctx());
}

/** Exactly what a caption page resolves from the theme query. */
function effective(): ResolvedTheme {
  return resolveTheme(new URLSearchParams(themeQs()), custom, defaultPreset);
}

function baseTheme(): ReturnType<typeof presetTheme> {
  return presetTheme(currentPreset());
}

function isVarModified(v: ThemeVar): boolean {
  const o = w.overrides[v];
  return o !== undefined && !sameVarValue(v, o, baseTheme().vars[v]);
}

/** What option `k` shows without a value of its own: the look's, or its layout's default
 *  (rolling captions show both languages and live words unless told otherwise). */
function shownWithout(
  k: OptKey,
  options: Partial<DisplayOptions> = w.options,
): DisplayOptions[OptKey] {
  const rest = { ...options };
  delete rest[k];
  const q = themeQuery(currentPreset().id, w.overrides, rest, ctx());
  return resolveTheme(new URLSearchParams(q), custom, defaultPreset).options[k];
}

function isOptModified(k: OptKey): boolean {
  const o = w.options[k];
  return o !== undefined && o !== shownWithout(k);
}

/** The colour (RGB) differs from the preset, ignoring opacity. */
function isRgbModified(v: ThemeVar): boolean {
  const cur = colorToRgba(effective().vars[v] ?? "");
  const base = colorToRgba(baseTheme().vars[v]);
  if (cur === null || base === null) return isVarModified(v);
  return cur.r !== base.r || cur.g !== base.g || cur.b !== base.b;
}

/** Any of the background colours has another opacity than in the preset. */
function isAlphaModified(names: readonly ThemeVar[]): boolean {
  const cur = effective().vars;
  const base = baseTheme().vars;
  return names.some((n) => {
    const a = alphaOf(cur[n]);
    const b = alphaOf(base[n]);
    return a !== null && b !== null && Math.abs(a - b) > 0.004;
  });
}

function changeCount(): number {
  const base = baseTheme();
  let n = 0;
  for (const [k, v] of Object.entries(w.overrides) as Array<[ThemeVar, string]>) {
    if (!sameVarValue(k, v, base.vars[k])) n++;
  }
  for (const [k, v] of Object.entries(w.options) as Array<[OptKey, unknown]>) {
    if (v !== shownWithout(k)) n++;
  }
  return n;
}

/** Take a URL's theme as the working state (so a copied link can be edited again). */
function adoptQuery(q: URLSearchParams): void {
  const th = resolveTheme(q, custom, defaultPreset);
  // resolveTheme names a known look: the link's, else the default.
  const p = findPreset(th.presetId, custom) ?? BUILTIN_DEFAULT;
  const base = presetTheme(p);
  const overrides: ThemeVars = {};
  for (const [k, v] of Object.entries(th.vars) as Array<[ThemeVar, string]>) {
    if (k !== "--cap-font-size" && !sameVarValue(k, v, base.vars[k])) overrides[k] = v;
  }
  const options: Partial<DisplayOptions> = {};
  for (const k of Object.keys(th.options) as OptKey[]) {
    if (th.options[k] !== base.options[k]) Object.assign(options, { [k]: th.options[k] });
  }
  w.presetId = p.id;
  w.overrides = overrides;
  w.options = options;
  w.auto = { width: false, height: false };
}

// --- mutations ---------------------------------------------------------------------------------

function setVar(v: ThemeVar, raw: string): boolean {
  const canon = parseVarValue(v, raw);
  if (canon === null) return false;
  if (sameVarValue(v, canon, baseTheme().vars[v])) delete w.overrides[v];
  else w.overrides[v] = canon;
  commit();
  return true;
}

function resetVar(v: ThemeVar): void {
  delete w.overrides[v];
  commit();
}

/** The controls only offer valid values; sanitizeOptions would drop any other. A value the look
 *  shows anyway is not kept as a change of its own. */
function setOption(k: OptKey, value: unknown): void {
  const parsed = sanitizeOptions({ [k]: value });
  const rest = { ...w.options };
  delete rest[k];
  // A layout switch brings that layout's natural background.
  if (k === "layout") delete rest.bg;
  w.options = parsed[k] === shownWithout(k, rest) ? rest : { ...rest, ...parsed };
  commit();
}

function resetOption(k: OptKey): void {
  delete w.options[k];
  commit();
}

function selectPreset(id: string): void {
  w.presetId = id;
  w.overrides = {};
  w.options = {};
  w.auto = { width: false, height: false };
  commit();
  renderGalleries();
}

// --- tiny UI helpers ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS: Readonly<Record<string, readonly string[]>> = {
  layout: [
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M3 9h18",
    "M9 21V9",
  ],
  panel: ["M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M7 15h10"],
  blocks: ["M4 4h16v6H4z", "M4 14h16v6H4z"],
  text: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
  source: [
    "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z",
    "M3 12h18",
    "M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9",
    "M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9",
  ],
  hon: ["M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"],
  accents: ["M6 3h12v18l-6-4-6 4z"],
  events: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  motion: ["M3 8h11a3 3 0 1 0-3-3", "M3 12h16a3 3 0 1 1-3 3", "M3 16h7"],
  toolbar: [
    "M4 21v-7",
    "M4 10V3",
    "M12 21v-9",
    "M12 8V3",
    "M20 21v-5",
    "M20 12V3",
    "M1 14h6",
    "M9 8h6",
    "M17 16h6",
  ],
  reset: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 15h10l1-15"],
  check: ["M5 12l5 5L20 7"],
  chevron: ["M6 9l6 6 6-6"],
};

function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

let uid = 0;
function nextId(prefix: string): string {
  uid++;
  return `${prefix}-${uid}`;
}

function toast(message: string, kind: "ok" | "error" = "ok"): void {
  showToast(message, kind);
}

async function copyText(text: string, input: HTMLInputElement | null): Promise<void> {
  const ok = await copyToClipboard(text);
  if (!ok && input) {
    input.focus();
    input.select();
  }
  toast(ok ? t("common.copied") : t("lk.copyFailed"), ok ? "ok" : "error");
}

/** "Name" of a preset in the app language (built-in names are translated; yours are yours). */
function presetName(p: ThemePreset): string {
  const key = `preset.${p.id}`;
  return isBuiltinPresetId(p.id) && isKey(key) ? t(key) : p.name;
}

function presetDesc(p: ThemePreset): string {
  const key = `presetDesc.${p.id}`;
  return isBuiltinPresetId(p.id) && isKey(key) ? t(key) : p.description;
}

function isKey(key: string): key is MsgKey {
  return isMsgKey(key);
}

// --- controls ----------------------------------------------------------------------------------

type Choice = readonly [string, string];

interface Ctl {
  root: HTMLElement;
  sync(th: ResolvedTheme): void;
}

interface RowParts {
  root: HTMLDivElement;
  value: HTMLSpanElement;
  body: HTMLDivElement;
  setModified(on: boolean): void;
}

function row(
  label: string,
  forId: string | null,
  hint: string | undefined,
  onReset: () => void,
): RowParts {
  const reset = el("button", {
    class: "ctl-reset",
    attrs: { type: "button", title: t("lk.resetOne"), "aria-label": t("lk.resetLabel", { label }) },
  });
  reset.append(icon("reset", 14));
  reset.addEventListener("click", onReset);
  const labelEl = forId
    ? el("label", { class: "ctl-label", text: label, attrs: { for: forId } })
    : el("span", { class: "ctl-label", text: label });
  const value = el("span", { class: "ctl-value" });
  const head = el("div", { class: "ctl-head" }, [
    el("span", { class: "ctl-dot" }),
    labelEl,
    value,
    reset,
  ]);
  const body = el("div", { class: "ctl-body" });
  const root = el("div", { class: "ctl" }, [head, body]);
  if (hint) root.append(el("p", { class: "ctl-hint", text: hint }));
  return {
    root,
    value,
    body,
    setModified(on: boolean) {
      root.classList.toggle("is-mod", on);
    },
  };
}

function setFill(range: HTMLInputElement): void {
  const min = Number(range.min);
  const max = Number(range.max);
  const pct = max > min ? ((Number(range.value) - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--fill", `${Math.max(0, Math.min(100, pct))}%`);
}

function makeRange(min: number, max: number, step: number, id: string): HTMLInputElement {
  const r = el("input", {
    class: "ui-range",
    attrs: { type: "range", min: String(min), max: String(max), step: String(step), id },
  });
  return r;
}

/** A slider value at the step's precision, without trailing zeros ("0.50" → "0.5", "2.0" → "2"). */
function fmtNumber(n: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const s = n.toFixed(decimals);
  return decimals === 0 ? s : s.replace(/\.?0+$/, "");
}

interface RangeVarSpec {
  t: "range";
  v: ThemeVar;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint?: string;
  /** Read-out for 0 (e.g. "No limit") … */
  zero?: string;
  /** … and the CSS value it stands for (default "none"). */
  zeroValue?: string;
}

function rangeVar(s: RangeVarSpec): Ctl {
  const id = nextId("r");
  const parts = row(s.label, id, s.hint, () => resetVar(s.v));
  const range = makeRange(s.min, s.max, s.step, id);
  parts.body.append(range);
  range.addEventListener("input", () => {
    const n = Number(range.value);
    setFill(range);
    const css =
      s.zero !== undefined && n === 0
        ? (s.zeroValue ?? "none")
        : `${fmtNumber(n, s.step)}${s.unit}`;
    userTouched(s.v);
    setVar(s.v, css);
  });
  return {
    root: parts.root,
    sync(th) {
      const css = th.vars[s.v] ?? "";
      const n = css === "none" ? 0 : Number.parseFloat(css);
      if (document.activeElement !== range) range.value = String(Number.isFinite(n) ? n : s.min);
      setFill(range);
      const unitOk = css.endsWith(s.unit) || s.unit === "";
      parts.value.textContent =
        s.zero !== undefined && (css === "none" || n === 0)
          ? s.zero
          : unitOk && Number.isFinite(n)
            ? `${fmtNumber(n, s.step)}${s.unit ? ` ${s.unit}` : ""}`
            : css;
      parts.setModified(isVarModified(s.v));
    },
  };
}

interface ColorSpec {
  t: "color";
  v: ThemeVar;
  label: string;
  hint?: string;
  /** Offer "Follow text" (currentcolor). */
  follow?: boolean;
  /** false: no opacity mini-slider (a separate opacity control owns the alpha); picks keep it. */
  alpha?: false;
}

function colorVar(s: ColorSpec): Ctl {
  const id = nextId("c");
  const parts = row(s.label, id, s.hint, () => {
    if (s.alpha !== false) {
      resetVar(s.v);
      return;
    }
    // Back to the preset's colour, keeping the opacity set with the opacity slider.
    const base = baseTheme().vars[s.v];
    const a = alphaOf(effective().vars[s.v]);
    setVar(s.v, a === null ? base : (withAlpha(base, a) ?? base));
  });
  const picker = el("input", {
    class: "sw-input",
    attrs: { type: "color", "aria-label": t("lk.colourOf", { label: s.label }) },
  });
  const fill = el("span", { class: "sw-fill" });
  const swatch = el("label", { class: "sw", attrs: { title: t("lk.pickColour") } }, [fill, picker]);
  const text = el("input", {
    class: "sw-text",
    attrs: {
      type: "text",
      id,
      spellcheck: "false",
      autocomplete: "off",
      dir: "ltr",
      "aria-label": t("lk.valueOf", { label: s.label }),
    },
  });
  const alpha = el("input", {
    class: "ui-range range-alpha",
    attrs: {
      type: "range",
      min: "0",
      max: "100",
      step: "1",
      "aria-label": t("lk.opacityOf", { label: s.label }),
    },
  });
  const alphaOut = el("span", { class: "sw-alpha" });
  const ownAlpha = s.alpha !== false;
  parts.body.classList.add("ctl-color");
  parts.body.classList.toggle("no-alpha", !ownAlpha);
  parts.body.append(swatch, text);
  if (ownAlpha) parts.body.append(el("span", { class: "sw-alpha-wrap" }, [alpha, alphaOut]));
  /** The alpha a new colour gets when this control has no opacity slider of its own. */
  const keptAlpha = (): number => {
    const a = alphaOf(effective().vars[s.v]);
    return a === null || a === 0 ? 1 : a;
  };
  let followBtn: HTMLButtonElement | null = null;
  if (s.follow) {
    const btn = el("button", {
      class: "ctl-chip",
      text: t("lk.follow"),
      attrs: { type: "button", title: t("lk.followTip"), "aria-pressed": "false" },
    });
    btn.addEventListener("click", () => setVar(s.v, "currentcolor"));
    parts.value.after(btn);
    followBtn = btn;
  }
  const apply = (): void => {
    const hex = picker.value;
    if (!ownAlpha) {
      setVar(s.v, withAlpha(hex, keptAlpha()) ?? hex);
      return;
    }
    // A colour input always holds #rrggbb (black when it couldn't read a value).
    const rgba = colorToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
    rgba.a = Number(alpha.value) / 100;
    setVar(s.v, rgbaToHex(rgba));
  };
  picker.addEventListener("input", apply);
  alpha.addEventListener("input", () => {
    setFill(alpha);
    apply();
  });
  text.addEventListener("change", () => {
    // Without an alpha slider, a plain "#rrggbb" keeps the current opacity.
    const plain = /^#?[0-9a-f]{6}$|^#?[0-9a-f]{3}$|^rgb\(|^hsl\(|^[a-z]+$/i.test(text.value.trim());
    const kept = !ownAlpha && plain ? withAlpha(text.value, keptAlpha()) : null;
    const ok = setVar(s.v, kept ?? text.value);
    text.classList.toggle("is-bad", !ok);
    if (!ok) toast(t("lk.badColour", { value: text.value }), "error");
  });
  return {
    root: parts.root,
    sync(th) {
      const css = th.vars[s.v] ?? "";
      const follows = css === "currentcolor";
      fill.style.setProperty("--sw", follows ? (th.vars["--cap-text-color"] ?? "#ffffff") : css);
      followBtn?.setAttribute("aria-pressed", String(follows));
      const rgba = colorToRgba(css);
      if (rgba !== null) {
        picker.value = rgbaToHex({ ...rgba, a: 1 });
        if (document.activeElement !== alpha) alpha.value = String(Math.round(rgba.a * 100));
        alpha.disabled = false;
        alphaOut.textContent = `${Math.round(rgba.a * 100)} %`;
        if (document.activeElement !== text) text.value = rgbaToHex({ ...rgba, a: 1 });
      } else {
        alpha.disabled = true;
        alphaOut.textContent = "–";
        if (document.activeElement !== text)
          text.value = css === "currentcolor" ? t("lk.textColourValue") : css;
      }
      setFill(alpha);
      text.classList.remove("is-bad");
      parts.setModified(ownAlpha ? isVarModified(s.v) : isRgbModified(s.v));
    },
  };
}

interface SelectVarSpec {
  t: "select";
  v: ThemeVar;
  label: string;
  choices: readonly Choice[];
  hint?: string;
}

function selectVar(s: SelectVarSpec): Ctl {
  const id = nextId("s");
  const parts = row(s.label, id, s.hint, () => resetVar(s.v));
  const sel = el("select", { class: "ui-select", attrs: { id } });
  parts.body.append(sel);
  sel.addEventListener("change", () => setVar(s.v, sel.value));
  return {
    root: parts.root,
    sync(th) {
      const css = th.vars[s.v] ?? "";
      const known = s.choices.some(([v]) => v === css);
      const opts = s.choices.map(([v, l]) => el("option", { text: l, attrs: { value: v } }));
      if (!known && css !== "") {
        const own = sameVarValue(s.v, css, baseTheme().vars[s.v]);
        opts.push(
          el("option", { text: own ? t("lk.presetOwn") : t("lk.custom"), attrs: { value: css } }),
        );
      }
      sel.replaceChildren(...opts);
      sel.value = css;
      parts.setModified(isVarModified(s.v));
    },
  };
}

function segButtons(
  choices: readonly Choice[],
  label: string,
  onPick: (v: string) => void,
): { root: HTMLDivElement; set(v: string): void } {
  const root = el("div", { class: "seg", attrs: { role: "group", "aria-label": label } });
  const buttons = choices.map(([v, l]) => {
    const b = el("button", {
      class: "seg-btn",
      text: l,
      attrs: { type: "button", "aria-pressed": "false" },
    });
    b.addEventListener("click", () => onPick(v));
    root.append(b);
    return [v, b] as const;
  });
  return {
    root,
    set(value: string) {
      for (const [v, b] of buttons) b.setAttribute("aria-pressed", String(v === value));
    },
  };
}

interface SegVarSpec {
  t: "seg";
  v: ThemeVar;
  label: string;
  choices: readonly Choice[];
  hint?: string;
}

function segVar(s: SegVarSpec): Ctl {
  const parts = row(s.label, null, s.hint, () => resetVar(s.v));
  const seg = segButtons(s.choices, s.label, (v) => setVar(s.v, v));
  parts.body.append(seg.root);
  return {
    root: parts.root,
    sync(th) {
      seg.set(th.vars[s.v] ?? "");
      parts.setModified(isVarModified(s.v));
    },
  };
}

interface BorderSpec {
  t: "border";
  v: ThemeVar;
  label: string;
}

function borderVar(s: BorderSpec): Ctl {
  const id = nextId("b");
  const parts = row(s.label, id, undefined, () => resetVar(s.v));
  const range = makeRange(0, 6, 0.5, id);
  const picker = el("input", {
    class: "sw-input",
    attrs: { type: "color", "aria-label": t("lk.colourOf", { label: s.label }) },
  });
  const fill = el("span", { class: "sw-fill" });
  const swatch = el("label", { class: "sw sw-small", attrs: { title: t("lk.borderColour") } }, [
    fill,
    picker,
  ]);
  const alpha = el("input", {
    class: "ui-range range-alpha",
    attrs: {
      type: "range",
      min: "0",
      max: "100",
      step: "1",
      "aria-label": t("lk.opacityOf", { label: s.label }),
    },
  });
  parts.body.classList.add("ctl-border");
  parts.body.append(range, swatch, alpha);
  let color = "rgba(255, 255, 255, 0.1)";
  const apply = (): void => {
    const width = Number(range.value);
    const rgba = colorToRgba(picker.value);
    if (rgba !== null) rgba.a = Number(alpha.value) / 100;
    const c = rgba === null ? color : rgbaToHex(rgba);
    setVar(s.v, width === 0 ? "none" : `${width}px solid ${c}`);
  };
  range.addEventListener("input", () => {
    setFill(range);
    apply();
  });
  picker.addEventListener("input", apply);
  alpha.addEventListener("input", () => {
    setFill(alpha);
    apply();
  });
  return {
    root: parts.root,
    sync(th) {
      const css = th.vars[s.v] ?? "none";
      let width = 0;
      if (css !== "none") {
        const [wTok, , ...rest] = css.split(" ");
        width = Number.parseFloat(wTok ?? "0") || 0;
        color = rest.join(" ") || color;
      }
      if (document.activeElement !== range) range.value = String(width);
      setFill(range);
      const rgba = colorToRgba(color);
      if (rgba !== null) {
        picker.value = rgbaToHex({ ...rgba, a: 1 });
        if (document.activeElement !== alpha) alpha.value = String(Math.round(rgba.a * 100));
      }
      setFill(alpha);
      fill.style.setProperty("--sw", color);
      parts.value.textContent = width === 0 ? t("lk.none") : `${fmtNumber(width, 0.5)} px`;
      parts.setModified(isVarModified(s.v));
    },
  };
}

interface PaddingSpec {
  t: "padding";
  v: ThemeVar;
  label: string;
}

function paddingVar(s: PaddingSpec): Ctl {
  const idV = nextId("pv");
  const parts = row(s.label, idV, undefined, () => resetVar(s.v));
  const rv = makeRange(0, 48, 1, idV);
  const rh = makeRange(0, 64, 1, nextId("ph"));
  rv.setAttribute("aria-label", t("lk.padV"));
  rh.setAttribute("aria-label", t("lk.padH"));
  parts.body.classList.add("ctl-pair");
  parts.body.append(
    el("span", { class: "ctl-pair-label", text: "↕" }),
    rv,
    el("span", { class: "ctl-pair-label", text: "↔" }),
    rh,
  );
  const apply = (): void => {
    setFill(rv);
    setFill(rh);
    setVar(s.v, `${rv.value}px ${rh.value}px`);
  };
  rv.addEventListener("input", apply);
  rh.addEventListener("input", apply);
  return {
    root: parts.root,
    sync(th) {
      const toks = (th.vars[s.v] ?? "0px").split(" ").map((x) => Number.parseFloat(x) || 0);
      const v = toks[0] ?? 0;
      const h = toks[1] ?? v;
      if (document.activeElement !== rv) rv.value = String(v);
      if (document.activeElement !== rh) rh.value = String(h);
      setFill(rv);
      setFill(rh);
      parts.value.textContent = `${fmtNumber(v, 1)} × ${fmtNumber(h, 1)} px`;
      parts.setModified(isVarModified(s.v));
    },
  };
}

interface OptSegSpec {
  t: "oseg";
  o: OptKey;
  label: string;
  choices: readonly Choice[];
  hint?: string;
}

function optSeg(s: OptSegSpec): Ctl {
  const parts = row(s.label, null, s.hint, () => resetOption(s.o));
  const seg = segButtons(s.choices, s.label, (v) => setOption(s.o, v));
  parts.body.append(seg.root);
  return {
    root: parts.root,
    sync(th) {
      seg.set(String(th.options[s.o]));
      parts.setModified(isOptModified(s.o));
    },
  };
}

interface OptSelectSpec {
  t: "oselect";
  o: OptKey;
  label: string;
  choices: readonly Choice[];
  hint?: string;
}

function optSelect(s: OptSelectSpec): Ctl {
  const id = nextId("os");
  const parts = row(s.label, id, s.hint, () => resetOption(s.o));
  const sel = el(
    "select",
    { class: "ui-select", attrs: { id } },
    s.choices.map(([v, l]) => el("option", { text: l, attrs: { value: v } })),
  );
  parts.body.append(sel);
  sel.addEventListener("change", () => setOption(s.o, sel.value));
  return {
    root: parts.root,
    sync(th) {
      sel.value = String(th.options[s.o]);
      parts.setModified(isOptModified(s.o));
    },
  };
}

interface OptToggleSpec {
  t: "otoggle";
  o: BoolKey;
  label: string;
  hint?: string;
}

function optToggle(s: OptToggleSpec): Ctl {
  const id = nextId("t");
  const parts = row(s.label, null, s.hint, () => resetOption(s.o));
  const input = el("input", {
    class: "ui-switch",
    attrs: { type: "checkbox", id, role: "switch" },
  });
  const state = el("span", { class: "switch-text", attrs: { "aria-hidden": "true" } });
  const sw = el("label", { class: "switch", attrs: { for: id } }, [state, input]);
  parts.root.classList.add("ctl-toggle");
  parts.body.append(sw);
  input.addEventListener("change", () => setOption(s.o, input.checked));
  return {
    root: parts.root,
    sync(th) {
      const on = th.options[s.o];
      input.checked = on;
      state.textContent = on ? t("lk.on") : t("lk.off");
      parts.setModified(isOptModified(s.o));
    },
  };
}

interface OptRangeSpec {
  t: "orange";
  o: IntKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  zero?: string;
  hint?: string;
}

function optRange(s: OptRangeSpec): Ctl {
  const id = nextId("or");
  const parts = row(s.label, id, s.hint, () => resetOption(s.o));
  const range = makeRange(s.min, s.max, s.step, id);
  parts.body.append(range);
  range.addEventListener("input", () => {
    setFill(range);
    setOption(s.o, Number(range.value));
  });
  return {
    root: parts.root,
    sync(th) {
      const n = th.options[s.o];
      if (document.activeElement !== range) range.value = String(n);
      setFill(range);
      parts.value.textContent =
        s.zero !== undefined && n === 0 ? s.zero : `${n}${s.unit ? ` ${s.unit}` : ""}`;
      parts.setModified(isOptModified(s.o));
    },
  };
}

interface HonSampleSpec {
  t: "hon-sample";
}

function honSample(): Ctl {
  // Dark base → panel colour → newest-block colour, so light text on translucent presets
  // (glass, minimal) stays visible on this white page.
  const block = el("div", { class: "cz-hon-block" });
  block.append(...withHonorifics("Mohammed ﷺ · Allah ﷾ · Musa ﵇ · Abu Bakr ﵁"));
  const panel = el("div", { class: "cz-hon-panel" }, [block]);
  const box = el("div", { class: "cz-hon-sample", attrs: { "aria-label": t("lk.honSample") } }, [
    panel,
  ]);
  const root = el("div", { class: "ctl ctl-sample" }, [box]);
  return {
    root,
    sync(th) {
      applyTheme(box, th.vars);
    },
  };
}

interface PlacementSpec {
  t: "placement";
}

interface OpacitySpec {
  t: "opacity";
  label: string;
  /** Background colours whose alpha this slider sets (RGB kept; transparent ones skipped). */
  vars: readonly ThemeVar[];
  hint?: string;
}

function pctText(a: number): string {
  return `${Math.round(a * 100)} %`;
}

/** Visible alphas (0–1) of `vars` in a theme; transparent / none / gradients are left out. */
function visibleAlphas(vars: ThemeVars, names: readonly ThemeVar[]): number[] {
  const out: number[] = [];
  for (const n of names) {
    const a = alphaOf(vars[n]);
    if (a !== null && a > 0) out.push(a);
  }
  return out;
}

function opacityCtl(s: OpacitySpec): Ctl {
  const id = nextId("op");
  const parts = row(s.label, id, s.hint, () => {
    // Back to the preset's alpha, keeping any colour change.
    const th = effective();
    const base = baseTheme().vars;
    for (const n of s.vars) {
      const cur = th.vars[n];
      const a = alphaOf(base[n]);
      if (cur !== undefined && a !== null) setVar(n, withAlpha(cur, a) ?? cur);
    }
  });
  const range = makeRange(0, 100, 1, id);
  parts.body.append(range);
  range.addEventListener("input", () => {
    setFill(range);
    const th = effective();
    const alpha = Number(range.value) / 100;
    for (const n of s.vars) {
      const cur = th.vars[n];
      const a = alphaOf(cur);
      if (cur === undefined || a === null || a === 0) continue;
      setVar(n, withAlpha(cur, alpha) ?? cur);
    }
  });
  return {
    root: parts.root,
    sync(th) {
      const alphas = visibleAlphas(th.vars, s.vars);
      const panelOff = s.vars.includes("--cap-panel-bg") && th.options.bg === "none";
      const first = alphas[0];
      range.disabled = first === undefined || panelOff;
      if (document.activeElement !== range) range.value = String(Math.round((first ?? 1) * 100));
      setFill(range);
      parts.value.textContent = panelOff
        ? t("lk.off")
        : first === undefined
          ? t("lk.noColour")
          : alphas.every((a) => Math.abs(a - first) < 0.004)
            ? pctText(first)
            : alphas.map(pctText).join(" · ");
      parts.setModified(isAlphaModified(s.vars));
    },
  };
}

const HPOS: readonly HPos[] = ["flex-start", "center", "flex-end"];

function placementCtl(): Ctl {
  const parts = row(t("plc.label"), null, t("lk.placeHint"), () => {
    resetOption("pos");
    resetVar("--cap-panel-justify");
  });
  const picker = placementPicker((pos, justify) => {
    const th = effective();
    const adj = placementAdjust(
      pos,
      justify,
      {
        widthPct: lengthPct(th.vars["--cap-panel-width"], "w"),
        heightPct: lengthPct(th.vars["--cap-panel-height"], "h"),
        rollup: th.options.layout === "rollup",
        autoWidth: w.auto.width,
        autoHeight: w.auto.height,
      },
      appPlacementLabels(),
    );
    setOption("pos", pos);
    setVar("--cap-panel-justify", justify);
    if (adj.width !== null) {
      setVar("--cap-panel-width", adj.width);
      w.auto.width = true;
    } else if (adj.resetWidth) {
      resetVar("--cap-panel-width");
      w.auto.width = false;
    }
    if (adj.height !== null) {
      setVar("--cap-panel-height", adj.height);
      w.auto.height = true;
    } else if (adj.resetHeight) {
      resetVar("--cap-panel-height");
      w.auto.height = false;
    }
    persist();
    picker.note(adj.note);
  }, appPlacementLabels);
  parts.root.classList.add("ctl-placement");
  parts.body.append(picker.root);
  return {
    root: parts.root,
    sync(th) {
      const j = th.vars["--cap-panel-justify"] ?? "center";
      picker.set({
        pos: th.options.pos,
        justify: oneOf(j, HPOS, "center"),
        widthPct: lengthPct(th.vars["--cap-panel-width"], "w"),
        heightPct: lengthPct(th.vars["--cap-panel-height"], "h"),
        rollup: th.options.layout === "rollup",
      });
      parts.setModified(isOptModified("pos") || isVarModified("--cap-panel-justify"));
    },
  };
}

type Spec =
  | RangeVarSpec
  | ColorSpec
  | SelectVarSpec
  | SegVarSpec
  | BorderSpec
  | PaddingSpec
  | OptSegSpec
  | OptSelectSpec
  | OptToggleSpec
  | OptRangeSpec
  | HonSampleSpec
  | PlacementSpec
  | OpacitySpec;

function build(s: Spec): Ctl {
  switch (s.t) {
    case "range":
      return rangeVar(s);
    case "color":
      return colorVar(s);
    case "select":
      return selectVar(s);
    case "seg":
      return segVar(s);
    case "border":
      return borderVar(s);
    case "padding":
      return paddingVar(s);
    case "oseg":
      return optSeg(s);
    case "oselect":
      return optSelect(s);
    case "otoggle":
      return optToggle(s);
    case "orange":
      return optRange(s);
    case "hon-sample":
      return honSample();
    case "placement":
      return placementCtl();
    case "opacity":
      return opacityCtl(s);
  }
}

const LATIN_FONTS: readonly Choice[] = FONT_CHOICES.map((f) => [f.stack, f.label] as const);
const ARABIC_FONTS: readonly Choice[] = FONT_CHOICES.filter((f) => f.arabic).map(
  (f) => [f.stack, f.label] as const,
);
/** Shadow names in the app language ("lk.sh.soft"), else the table's own key. */
const shadowChoices = (table: Readonly<Record<string, string>>): readonly Choice[] =>
  Object.entries(table).map(([k, v]) => {
    const key = `lk.sh.${k}`;
    return [v, isKey(key) ? t(key) : k.charAt(0).toUpperCase() + k.slice(1)] as const;
  });
const weights = (): readonly Choice[] => [
  ["400", t("lk.wRegular")],
  ["500", t("lk.wMedium")],
  ["600", t("lk.wSemibold")],
  ["700", t("lk.wBold")],
];

interface Group {
  id: string;
  title: string;
  icon: string;
  desc: string;
  items: readonly Spec[];
}

/** The control groups, in the app language (built again on a language switch). */
function groups(): readonly Group[] {
  const W = weights();
  return [
    {
      id: "layout",
      title: t("lk.g.layout"),
      icon: "layout",
      desc: t("lk.g.layoutDesc"),
      items: [
        {
          t: "oseg",
          o: "layout",
          label: t("lk.layout"),
          choices: [
            ["blocks", t("b.blocks")],
            ["rollup", t("b.rolling")],
          ],
          hint: t("lk.layoutHint"),
        },
        { t: "placement" },
        {
          t: "range",
          v: "--cap-panel-width",
          label: t("b.width"),
          min: 20,
          max: 100,
          step: 1,
          unit: "vw",
        },
        {
          t: "range",
          v: "--cap-panel-height",
          label: t("b.height"),
          min: 10,
          max: 100,
          step: 1,
          unit: "vh",
        },
        {
          t: "oseg",
          o: "show",
          label: t("lk.show"),
          choices: [
            ["target", t("lk.showTarget")],
            ["both", t("lk.showBoth")],
            ["source", t("lk.showSource")],
          ],
          hint: t("lk.showHint"),
        },
        {
          t: "orange",
          o: "visibleBlocks",
          label: t("lk.visibleBlocks"),
          min: 0,
          max: 8,
          step: 1,
          zero: t("lk.allFit"),
        },
        {
          t: "orange",
          o: "lines",
          label: t("lk.rollLines"),
          min: 1,
          max: 6,
          step: 1,
          hint: t("lk.rollLinesHint"),
        },
        {
          t: "oselect",
          o: "bg",
          label: t("b.background"),
          choices: [
            ["panel", t("lk.bgPanel")],
            ["none", t("lk.bgNone")],
            ["band", t("lk.bgBand")],
            ["shadow", t("lk.bgShadow")],
          ],
        },
        { t: "otoggle", o: "partial", label: t("lk.partial"), hint: t("lk.partialHint") },
        { t: "otoggle", o: "history", label: t("lk.history"), hint: t("lk.historyHint") },
        { t: "orange", o: "maxBlocks", label: t("lk.maxBlocks"), min: 10, max: 200, step: 5 },
      ],
    },
    {
      id: "panel",
      title: t("lk.g.panel"),
      icon: "panel",
      desc: t("lk.g.panelDesc"),
      items: [
        { t: "color", v: "--cap-panel-bg", label: t("lk.panelColour"), alpha: false },
        {
          t: "opacity",
          label: t("lk.panelOpacity"),
          vars: ["--cap-panel-bg"],
          hint: t("lk.panelOpacityHint"),
        },
        { t: "color", v: "--cap-page-bg", label: t("lk.pageBg"), hint: t("lk.pageBgHint") },
        {
          t: "range",
          v: "--cap-panel-radius",
          label: t("lk.radius"),
          min: 0,
          max: 60,
          step: 1,
          unit: "px",
        },
        {
          t: "range",
          v: "--cap-panel-padding",
          label: t("lk.innerSpacing"),
          min: 0,
          max: 80,
          step: 1,
          unit: "px",
        },
        {
          t: "select",
          v: "--cap-panel-shadow",
          label: t("lk.shadow"),
          choices: shadowChoices(BOX_SHADOWS),
        },
        {
          t: "range",
          v: "--cap-panel-blur",
          label: t("lk.blur"),
          min: 0,
          max: 40,
          step: 1,
          unit: "px",
          hint: t("lk.blurHint"),
        },
        {
          t: "range",
          v: "--cap-fade-mask",
          label: t("lk.fade"),
          min: 0,
          max: 60,
          step: 1,
          unit: "%",
          zero: t("lk.none"),
          zeroValue: "0%",
          hint: t("lk.fadeHint"),
        },
      ],
    },
    {
      id: "blocks",
      title: t("lk.g.blocks"),
      icon: "blocks",
      desc: t("lk.g.blocksDesc"),
      items: [
        { t: "color", v: "--cap-block-bg", label: t("lk.blockColour"), alpha: false },
        { t: "color", v: "--cap-block-bg-new", label: t("lk.newBlockColour"), alpha: false },
        {
          t: "opacity",
          label: t("lk.blockOpacity"),
          vars: ["--cap-block-bg", "--cap-block-bg-new"],
          hint: t("lk.blockOpacityHint"),
        },
        { t: "border", v: "--cap-block-border", label: t("lk.border") },
        {
          t: "range",
          v: "--cap-block-radius",
          label: t("lk.radius"),
          min: 0,
          max: 40,
          step: 1,
          unit: "px",
        },
        { t: "padding", v: "--cap-block-padding", label: t("lk.padding") },
        {
          t: "range",
          v: "--cap-block-gap",
          label: t("lk.blockGap"),
          min: 0,
          max: 40,
          step: 1,
          unit: "px",
        },
        {
          t: "select",
          v: "--cap-block-shadow",
          label: t("lk.shadow"),
          choices: shadowChoices(BOX_SHADOWS),
        },
        {
          t: "range",
          v: "--cap-old-opacity",
          label: t("lk.oldOpacity"),
          min: 0.2,
          max: 1,
          step: 0.05,
          unit: "",
          hint: t("lk.oldOpacityHint"),
        },
      ],
    },
    {
      id: "text",
      title: t("lk.g.text"),
      icon: "text",
      desc: t("lk.g.textDesc"),
      items: [
        { t: "select", v: "--cap-font-family", label: t("lk.typeface"), choices: LATIN_FONTS },
        {
          t: "orange",
          o: "size",
          label: t("lk.size"),
          min: 16,
          max: 140,
          step: 1,
          unit: "px",
          hint: t("lk.sizeHint"),
        },
        { t: "seg", v: "--cap-font-weight", label: t("lk.weight"), choices: W },
        {
          t: "range",
          v: "--cap-line-height",
          label: t("lk.lineHeight"),
          min: 1,
          max: 2,
          step: 0.05,
          unit: "",
        },
        {
          t: "range",
          v: "--cap-letter-spacing",
          label: t("lk.letterSpacing"),
          min: -1,
          max: 4,
          step: 0.1,
          unit: "px",
        },
        {
          t: "range",
          v: "--cap-max-chars",
          label: t("lk.lineLength"),
          min: 0,
          max: 80,
          step: 1,
          unit: "ch",
          zero: t("lk.noLimit"),
          hint: t("lk.lineLengthHint"),
        },
        {
          t: "seg",
          v: "--cap-text-align",
          label: t("lk.align"),
          choices: [
            ["start", t("lk.auto")],
            ["left", t("plc.left")],
            ["center", t("plc.center")],
            ["right", t("plc.right")],
          ],
        },
        { t: "color", v: "--cap-text-color", label: t("lk.textColour") },
        { t: "color", v: "--cap-text-color-new", label: t("lk.newText") },
        {
          t: "select",
          v: "--cap-text-shadow",
          label: t("lk.textShadow"),
          choices: shadowChoices(TEXT_SHADOWS),
        },
      ],
    },
    {
      id: "source",
      title: t("lk.g.source"),
      icon: "source",
      desc: t("lk.g.sourceDesc"),
      items: [
        {
          t: "select",
          v: "--cap-src-font-family",
          label: t("lk.srcFont"),
          choices: ARABIC_FONTS,
        },
        {
          t: "range",
          v: "--cap-src-scale",
          label: t("lk.srcScale"),
          min: 0.4,
          max: 1.5,
          step: 0.02,
          unit: "",
          hint: t("lk.srcScaleHint"),
        },
        { t: "color", v: "--cap-src-color", label: t("lk.srcColour") },
        {
          t: "range",
          v: "--cap-src-opacity",
          label: t("lk.srcOpacity"),
          min: 0,
          max: 1,
          step: 0.05,
          unit: "",
        },
        {
          t: "select",
          v: "--cap-arabic-font-family",
          label: t("lk.arabicFont"),
          choices: ARABIC_FONTS,
        },
        {
          t: "select",
          v: "--cap-quran-font-family",
          label: t("lk.quranFont"),
          choices: ARABIC_FONTS,
        },
      ],
    },
    {
      id: "hon",
      title: t("lk.g.hon"),
      icon: "hon",
      desc: t("lk.g.honDesc"),
      items: [
        { t: "hon-sample" },
        { t: "select", v: "--cap-hon-font", label: t("lk.typeface"), choices: ARABIC_FONTS },
        {
          t: "range",
          v: "--cap-hon-scale",
          label: t("lk.size"),
          min: 0.8,
          max: 1.8,
          step: 0.05,
          unit: "em",
        },
        {
          t: "color",
          v: "--cap-hon-color",
          label: t("lk.colour"),
          follow: true,
          hint: t("lk.honColourHint"),
        },
      ],
    },
    {
      id: "accents",
      title: t("lk.g.accents"),
      icon: "accents",
      desc: t("lk.g.accentsDesc"),
      items: [
        { t: "otoggle", o: "quranAccent", label: t("lk.quranAccent") },
        { t: "otoggle", o: "quranArabic", label: t("lk.quranArabic") },
        {
          t: "range",
          v: "--cap-accent-width",
          label: t("lk.accentWidth"),
          min: 0,
          max: 12,
          step: 1,
          unit: "px",
        },
        { t: "color", v: "--cap-quran-accent", label: t("lk.quranColour") },
        { t: "color", v: "--cap-dua-accent", label: t("lk.duaColour") },
        { t: "color", v: "--cap-ref-color", label: t("lk.refColour") },
        { t: "seg", v: "--cap-ref-weight", label: t("lk.refWeight"), choices: W },
      ],
    },
    {
      id: "events",
      title: t("lk.g.events"),
      icon: "events",
      desc: t("lk.g.eventsDesc"),
      items: [
        { t: "color", v: "--cap-event-bg", label: t("lk.cardColour") },
        { t: "color", v: "--cap-event-color", label: t("lk.cardText") },
        { t: "color", v: "--cap-event-accent", label: t("lk.cardAccent") },
      ],
    },
    {
      id: "motion",
      title: t("lk.g.motion"),
      icon: "motion",
      desc: t("lk.g.motionDesc"),
      items: [
        {
          t: "range",
          v: "--cap-anim-duration",
          label: t("lk.animDuration"),
          min: 0,
          max: 800,
          step: 10,
          unit: "ms",
          hint: t("lk.animHint"),
        },
        {
          t: "range",
          v: "--cap-new-scale",
          label: t("lk.newScale"),
          min: 1,
          max: 1.08,
          step: 0.005,
          unit: "",
        },
      ],
    },
    {
      id: "toolbar",
      title: t("lk.g.toolbar"),
      icon: "toolbar",
      desc: t("lk.g.toolbarDesc"),
      items: [
        {
          t: "oseg",
          o: "toolbar",
          label: t("lk.toolbar"),
          choices: [
            ["auto", t("lk.auto")],
            ["on", t("lk.on")],
            ["off", t("lk.off")],
          ],
          hint: t("lk.toolbarHint"),
        },
        { t: "color", v: "--cap-toolbar-bg", label: t("lk.toolbarColour") },
        { t: "color", v: "--cap-toolbar-color", label: t("lk.toolbarText") },
        { t: "color", v: "--cap-listening-color", label: t("lk.dots") },
      ],
    },
  ];
}

const controls: Array<{ group: string; ctl: Ctl }> = [];
/** The groups on the page now, with the badge that counts their changes (updateHeader). */
const groupBadges: Array<{ group: Group; badge: HTMLSpanElement }> = [];

function groupModCount(g: Group): number {
  let n = 0;
  for (const s of g.items) {
    if (s.t === "color" && s.alpha === false) {
      if (isRgbModified(s.v)) n++;
    } else if (s.t === "opacity") {
      if (isAlphaModified(s.vars)) n++;
    } else if ("v" in s && isVarModified(s.v)) n++;
    else if ("o" in s && isOptModified(s.o)) n++;
    else if (s.t === "placement") {
      n += (isOptModified("pos") ? 1 : 0) + (isVarModified("--cap-panel-justify") ? 1 : 0);
    }
  }
  return n;
}

function renderGroups(): void {
  const host = byId("groups", HTMLDivElement);
  host.replaceChildren();
  controls.length = 0;
  groupBadges.length = 0;
  for (const g of groups()) {
    const badge = el("span", { class: "grp-badge" });
    groupBadges.push({ group: g, badge });
    const summary = el("summary", { class: "grp-head" }, [
      el("span", { class: "grp-icon" }, [icon(g.icon, 18)]),
      el("span", { class: "grp-titles" }, [
        el("span", { class: "grp-title", text: g.title }),
        el("span", { class: "grp-desc", text: g.desc }),
      ]),
      badge,
      el("span", { class: "grp-chev" }, [icon("chevron", 18)]),
    ]);
    const body = el("div", { class: "grp-body" });
    const details = el("details", { class: "grp" }, [summary, body]);
    details.open = w.open.includes(g.id);
    details.addEventListener("toggle", () => {
      w.open = details.open ? [...new Set([...w.open, g.id])] : w.open.filter((x) => x !== g.id);
      persist();
    });
    for (const s of g.items) {
      const ctl = build(s);
      body.append(ctl.root);
      controls.push({ group: g.id, ctl });
    }
    host.append(details);
  }
}

// --- gallery -----------------------------------------------------------------------------------

/** The language of the sample text: the caption language when known (the Translation field on
 *  a local install, which the builder's ?to= fills; hosted: the builder's ?to=), else English. */
function previewLang(): string {
  if (mode === "local" && query.get("view") !== "preview") return w.to;
  return linkTo !== null && langCode(linkTo, "") !== "" ? linkTo : "en";
}

/** Two thumbnails per row, edge to edge in their card (the gap is 10–12 px). */
function thumbSize(host: HTMLElement): { width: number; height: number } {
  const avail = host.clientWidth > 0 ? host.clientWidth : 400;
  const width = Math.floor(Math.max(120, Math.min(260, (avail - 12) / 2)));
  return { width, height: Math.round((width * 9) / 16) };
}

function presetCard(
  p: ThemePreset,
  isCustom: boolean,
  size: { width: number; height: number },
): HTMLElement {
  const active = p.id === currentPreset().id;
  const name = presetName(p);
  const desc = presetDesc(p);
  const main = el("button", {
    class: "pcard-main",
    attrs: { type: "button", "aria-pressed": String(active), title: desc || name },
  });
  const meta = el("span", { class: "pcard-meta" }, [
    el("span", { class: "pcard-name", text: name, attrs: { dir: "auto" } }),
  ]);
  if (p.id === defaultPreset)
    meta.append(el("span", { class: "pcard-badge", text: t("b.default") }));
  else if (isCustom) {
    meta.append(el("span", { class: "pcard-badge is-custom", text: t("lk.yoursBadge") }));
  }
  main.append(
    el("span", { class: "pcard-thumb" }, [
      renderPresetPreview(p, { ...size, lang: previewLang() }),
    ]),
    meta,
    el("span", { class: "pcard-desc plain", text: desc }),
  );
  main.addEventListener("click", () => selectPreset(p.id));
  const card = el("div", { class: `pcard${active ? " is-active" : ""}` }, [main]);
  if (isCustom && canSave) {
    const del = el("button", {
      class: "pcard-del",
      attrs: {
        type: "button",
        title: t("lk.deleteNamed", { name }),
        "aria-label": t("lk.deleteNamed", { name }),
      },
    });
    del.append(icon("trash", 15));
    let armed = false;
    del.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        del.classList.add("is-armed");
        del.replaceChildren(el("span", { text: t("lk.deleteConfirm") }));
        window.setTimeout(() => {
          armed = false;
          del.classList.remove("is-armed");
          del.replaceChildren(icon("trash", 15));
        }, 3000);
        return;
      }
      void deletePreset(p);
    });
    card.append(del);
  }
  return card;
}

function renderGalleries(): void {
  const gallery = byId("gallery", HTMLDivElement);
  const size = thumbSize(gallery);
  gallery.replaceChildren(...BUILTIN_PRESETS.map((p) => presetCard(p, false, size)));
  const customGallery = byId("custom-gallery", HTMLDivElement);
  customGallery.replaceChildren(...custom.map((p) => presetCard(p, true, size)));
  const note = byId("custom-note", HTMLParagraphElement);
  note.hidden = custom.length > 0 && serverOk && canSave;
  note.textContent = !serverOk
    ? t("lk.serverDown")
    : canSave
      ? t("lk.yoursNote")
      : t("lk.adminOnly");
}

// --- preview -----------------------------------------------------------------------------------

let stage: HTMLElement | null = null;
let stageKey = "";

function renderStage(animate = false): void {
  const th = effective();
  const a = ASPECTS[w.aspect];
  const key = JSON.stringify([
    th.options,
    w.aspect,
    w.backdrop,
    w.sample,
    w.browser,
    previewLang(),
  ]);
  if (!animate && stage !== null && key === stageKey) {
    applyTheme(stage, stageVars(th.vars, a.w, a.h));
    return;
  }
  stage = buildStage({
    width: a.w,
    height: a.h,
    vars: th.vars,
    options: th.options,
    sample: w.sample,
    backdrop: w.backdrop,
    listening: true,
    browser: w.browser,
    animate,
    lang: previewLang(),
  });
  stageKey = key;
  byId("stage-frame", HTMLDivElement).replaceChildren(stage);
  fitPreview();
}

function fitPreview(): void {
  if (stage === null) return;
  const box = byId("stage-box", HTMLDivElement);
  const frame = byId("stage-frame", HTMLDivElement);
  const a = ASPECTS[w.aspect];
  const pad = 28;
  const k = fitStage(
    stage,
    a.w,
    a.h,
    Math.max(80, box.clientWidth - pad),
    Math.max(80, box.clientHeight - pad),
  );
  frame.style.setProperty("width", `${Math.round(a.w * k)}px`);
  frame.style.setProperty("height", `${Math.round(a.h * k)}px`);
  // A phone shows the short read-out ("1920 × 1080 · 18 %").
  const pct = Math.round(k * 100);
  byId("stage-caption", HTMLParagraphElement).replaceChildren(
    el("span", { class: "cz-cap-long", text: t("lk.shownAt", { caption: t(a.caption), pct }) }),
    el("span", { class: "cz-cap-short ltr", text: `${a.w} × ${a.h} · ${pct} %` }),
  );
}

// --- links -------------------------------------------------------------------------------------

/** w.from / w.to are always language codes (langCode gives every assignment a default). */
function captionUrl(qs: string): string {
  const from = encodeURIComponent(w.from);
  const to = encodeURIComponent(w.to);
  return `${window.location.origin}/${from}/${to}${qs === "" ? "" : `?${qs}`}`;
}

function overlayUrl(qs: string, th: ResolvedTheme): string {
  const q = new URLSearchParams(qs);
  if (th.options.layout === "rollup") {
    const langs =
      th.options.show === "target"
        ? [w.to]
        : th.options.show === "source"
          ? [w.from]
          : [w.from, w.to];
    q.set("lang", langs.join(","));
  }
  const s = q.toString();
  return `${window.location.origin}/overlay${s ? `?${s}` : ""}`;
}

function updateLinks(th: ResolvedTheme): void {
  const qs = themeQs();
  const cap = captionUrl(qs);
  const ov = overlayUrl(qs, th);
  byId("url-caption", HTMLInputElement).value = cap;
  byId("url-overlay", HTMLInputElement).value = ov;
  byId("url-theme", HTMLInputElement).value = qs === "" ? t("lk.nothingToAdd") : qs;
  byId("open-caption", HTMLAnchorElement).href = cap;
  byId("open-overlay", HTMLAnchorElement).href = ov;
  const pq = new URLSearchParams(qs);
  pq.set("view", "preview");
  if (w.backdrop !== "video") pq.set("backdrop", w.backdrop);
  if (w.sample !== "khutbah") pq.set("sample", w.sample);
  pq.set("to", previewLang());
  if (token) pq.set("token", token);
  byId("open-preview", HTMLAnchorElement).href = `/app/look?${pq.toString()}`;
}

// --- header + commit ---------------------------------------------------------------------------

function updateHeader(): void {
  const p = currentPreset();
  const n = changeCount();
  byId("current-name", HTMLSpanElement).textContent = presetName(p);
  const edited = byId("current-edited", HTMLSpanElement);
  edited.hidden = n === 0;
  edited.textContent = tn("n.changes", n);
  byId("reset", HTMLButtonElement).disabled = n === 0;
  const def = findPreset(defaultPreset, custom);
  byId("default-note", HTMLParagraphElement).replaceChildren(
    ...fillNodes(t("lk.defaultNote"), {
      name: el("strong", { text: def ? presetName(def) : defaultPreset, attrs: { dir: "auto" } }),
      param: el("code", { class: "ltr", text: "preset=" }),
    }),
  );
  const mk = byId("make-default", HTMLButtonElement);
  const isDefault = p.id === defaultPreset;
  mk.disabled = isDefault || n > 0 || !serverOk;
  mk.textContent = isDefault
    ? t("lk.isDefault")
    : n > 0
      ? t("lk.saveFirst")
      : t("lk.makeDefault", { name: presetName(p) });
  for (const { group, badge } of groupBadges) {
    const c = groupModCount(group);
    badge.textContent = c > 0 ? String(c) : "";
    badge.title = c > 0 ? tn("n.changes", c) : "";
    badge.hidden = c === 0;
  }
}

function syncControls(th: ResolvedTheme): void {
  for (const { ctl } of controls) ctl.sync(th);
}

let frame = 0;
function commit(): void {
  persist();
  if (frame !== 0) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    const th = effective();
    syncControls(th);
    renderStage();
    updateLinks(th);
    updateHeader();
  });
}

// --- server ------------------------------------------------------------------------------------

function authHeaders(json: boolean): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** A refused preset request in our words (log in again, admins only, wait), else the
 *  server's message. */
async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return t("lk.loginNeeded");
  if (res.status === 403) return t("lk.adminOnly");
  if (res.status === 429) {
    const after = Number(res.headers.get("Retry-After"));
    return Number.isFinite(after) && after > 0
      ? t("login.tooMany", { time: waitText(after) })
      : t("login.tooManyWait");
  }
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const m = (body as { message: unknown }).message;
      if (typeof m === "string" && res.status < 500) return m;
    }
  } catch {
    // not JSON
  }
  return res.status >= 500 ? t("err.500") : t("err.http", { status: res.status });
}

async function loadPresets(): Promise<void> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch("/api/presets", { headers: authHeaders(false), signal: ctrl.signal });
    if (!res.ok) throw new Error(await errorText(res));
    const data: unknown = await res.json();
    const d = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    custom = Array.isArray(d.custom)
      ? d.custom
          .map((p) => sanitizePreset(p))
          .filter((p): p is ThemePreset => p !== null && !isBuiltinPresetId(p.id))
      : [];
    const def = typeof d.default === "string" ? d.default : "";
    defaultPreset = findPreset(def, custom) ? def : DEFAULT_PRESET_ID;
    serverOk = true;
  } catch {
    serverOk = false;
  } finally {
    window.clearTimeout(timer);
  }
}

function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = s === "" ? "my-look" : s;
  return isBuiltinPresetId(base) ? `${base}-custom` : base;
}

async function savePreset(name: string, description: string): Promise<string | null> {
  const th = effective();
  const vars: ThemeVars = { ...th.vars };
  const preset: ThemePreset = {
    id: slug(name),
    name: name.trim(),
    description: description.trim(),
    vars,
    options: { ...th.options },
  };
  const res = await fetch("/api/presets", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ preset }),
  });
  if (!res.ok) return errorText(res);
  await loadPresets();
  selectPreset(preset.id);
  toast(t("lk.savedNamed", { name: preset.name }));
  return null;
}

async function deletePreset(p: ThemePreset): Promise<void> {
  const res = await fetch(`/api/presets/${encodeURIComponent(p.id)}`, {
    method: "DELETE",
    headers: authHeaders(false),
  });
  if (!res.ok) {
    toast(await errorText(res), "error");
    return;
  }
  await loadPresets();
  if (w.presetId === p.id) selectPreset(defaultPreset);
  else renderGalleries();
  commit();
  toast(t("lk.deletedNamed", { name: presetName(p) }));
}

async function makeDefault(): Promise<void> {
  const p = currentPreset();
  const res = await fetch("/api/config/save-default", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ preset: p.id }),
  });
  if (!res.ok) {
    toast(await errorText(res), "error");
    return;
  }
  defaultPreset = p.id;
  renderGalleries();
  commit();
  toast(t("lk.nowDefault", { name: presetName(p) }));
}

// --- save dialog -------------------------------------------------------------------------------

function wireSaveDialog(): void {
  const dialog = byId("save-dialog", HTMLDialogElement);
  const name = byId("save-name", HTMLInputElement);
  const desc = byId("save-desc", HTMLTextAreaElement);
  const text = byId("save-text", HTMLParagraphElement);
  const overwrite = byId("save-overwrite", HTMLParagraphElement);
  const error = byId("save-error", HTMLParagraphElement);
  const confirm = byId("save-confirm", HTMLButtonElement);
  const updateId = (): void => {
    const id = slug(name.value);
    // Hosted: a screen picks it in the builder, so no link parameter to show.
    text.replaceChildren(
      ...(mode === "hosted"
        ? [t("lk.saveTextHosted")]
        : fillNodes(t("lk.saveText"), {
            param: el("code", { class: "ltr", text: `preset=${id}` }),
          })),
    );
    overwrite.hidden = !custom.some((p) => p.id === id);
  };
  onLangChange(updateId);
  name.addEventListener("input", updateId);
  byId("save", HTMLButtonElement).addEventListener("click", () => {
    if (!canSave) return;
    const p = currentPreset();
    const isCustom = custom.some((c) => c.id === p.id);
    name.value = isCustom
      ? p.name
      : changeCount() > 0
        ? t("lk.mineName", { name: presetName(p) })
        : "";
    desc.value = isCustom ? p.description : "";
    error.hidden = true;
    updateId();
    dialog.showModal();
    name.focus();
    name.select();
  });
  byId("save-cancel", HTMLButtonElement).addEventListener("click", () => dialog.close());
  byId("save-close", HTMLButtonElement).addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  byId("save-form", HTMLFormElement).addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (name.value.trim() === "") {
      error.textContent = t("common.empty");
      error.hidden = false;
      name.focus();
      return;
    }
    confirm.disabled = true;
    error.hidden = true;
    void savePreset(name.value, desc.value)
      .then((problem) => {
        if (problem === null) dialog.close();
        else {
          error.textContent = problem;
          error.hidden = false;
        }
      })
      .catch(() => {
        error.textContent = t("err.network");
        error.hidden = false;
      })
      .finally(() => {
        confirm.disabled = false;
      });
  });
}

// --- preview-only view (?view=preview) ---------------------------------------------------------

function previewOnly(): void {
  document.body.classList.add("is-preview-only");
  const host = byId("preview-only", HTMLDivElement);
  host.hidden = false;
  const backdrop = oneOf(query.get("backdrop"), BACKDROPS, "video");
  const sample = oneOf(query.get("sample"), SAMPLES, "khutbah");
  const draw = (): void => {
    const th = resolveTheme(query, custom, defaultPreset);
    const width = window.innerWidth;
    const height = window.innerHeight;
    host.replaceChildren(
      buildStage({
        width,
        height,
        vars: th.vars,
        options: th.options,
        sample,
        backdrop,
        listening: true,
        browser: true,
        lang: previewLang(),
      }),
    );
    const p = findPreset(th.presetId, custom);
    document.title = t("lk.previewTitle", { name: p ? presetName(p) : th.presetId });
  };
  let timer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(draw, 80);
  });
  draw();
}

// --- init --------------------------------------------------------------------------------------

/** Screen · Lower third · Phone above the preview (drawn again on a language switch). */
function renderAspect(): void {
  const aspect = segButtons(
    (Object.keys(ASPECTS) as Aspect[]).map((k) => [k, t(ASPECTS[k].label)] as const),
    t("lk.aspectAria"),
    (v) => {
      w.aspect = oneOf(v, ["hd", "lower", "phone"] as const, "hd");
      aspect.set(w.aspect);
      commit();
    },
  );
  byId("aspect", HTMLDivElement).replaceWith(aspect.root);
  aspect.root.id = "aspect";
  aspect.set(w.aspect);
}

function wireWorkspace(): void {
  renderAspect();

  const backdrop = byId("backdrop", HTMLSelectElement);
  backdrop.value = w.backdrop;
  backdrop.addEventListener("change", () => {
    w.backdrop = oneOf(backdrop.value, BACKDROPS, "video");
    commit();
  });
  const sample = byId("sample", HTMLSelectElement);
  sample.value = w.sample;
  sample.addEventListener("change", () => {
    w.sample = oneOf(sample.value, SAMPLES, "khutbah");
    commit();
  });
  const browser = byId("browser", HTMLInputElement);
  browser.checked = w.browser;
  browser.addEventListener("change", () => {
    w.browser = browser.checked;
    commit();
  });
  byId("replay", HTMLButtonElement).addEventListener("click", () => renderStage(true));
  byId("reset", HTMLButtonElement).addEventListener("click", () => {
    w.overrides = {};
    w.options = {};
    w.auto = { width: false, height: false };
    commit();
    toast(t("lk.backTo", { name: presetName(currentPreset()) }));
  });
  byId("make-default", HTMLButtonElement).addEventListener("click", () => void makeDefault());

  const from = byId("from", HTMLInputElement);
  const to = byId("to", HTMLInputElement);
  from.value = w.from;
  to.value = w.to;
  const onLang = (): void => {
    const before = previewLang();
    w.from = langCode(from.value.trim(), "ar");
    w.to = langCode(to.value.trim(), "nl");
    // The thumbnails speak the caption language too.
    if (previewLang() !== before) renderGalleries();
    commit();
  };
  from.addEventListener("input", onLang);
  to.addEventListener("input", onLang);

  const copy = (btn: string, input: string): void => {
    byId(btn, HTMLButtonElement).addEventListener("click", () => {
      const i = byId(input, HTMLInputElement);
      void copyText(i.id === "url-theme" ? themeQs() : i.value, i);
    });
  };
  copy("copy-caption", "url-caption");
  copy("copy-overlay", "url-overlay");
  copy("copy-theme", "url-theme");

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => fitPreview()).observe(byId("stage-box", HTMLDivElement));
    // The thumbnails are drawn at a fixed size: draw them again when the column changes width.
    const gallery = byId("gallery", HTMLDivElement);
    let galleryWidth = gallery.clientWidth;
    new ResizeObserver(() => {
      if (Math.abs(gallery.clientWidth - galleryWidth) < 8) return;
      galleryWidth = gallery.clientWidth;
      renderGalleries();
    }).observe(gallery);
  } else {
    window.addEventListener("resize", fitPreview);
  }
}

/** Local installs offer links (caption page, overlay) and the server default; a hosted mosque
 *  saves presets and chooses them per screen. */
function applyMode(): void {
  const hosted = mode === "hosted";
  byId("use-lead", HTMLParagraphElement).textContent = !canSave
    ? t("lk.adminOnly")
    : t(hosted ? "lk.useHosted" : "lk.useLead");
  byId("use-local", HTMLDivElement).hidden = hosted;
  // A user sees the looks but can't save one: no Save (and no dialog), only the line above.
  byId("save", HTMLButtonElement).hidden = !canSave;
  byId("make-default", HTMLButtonElement).hidden = !canSave;
}

/** A language switch: every control, label and text drawn by this script, drawn again. */
function relabel(): void {
  setTitle("look.docTitle");
  applyMode();
  renderGroups();
  renderAspect();
  renderGalleries();
  stageKey = "";
  commit();
}

async function main(): Promise<void> {
  if (query.get("view") === "preview") {
    await loadPresets();
    previewOnly();
    return;
  }
  initPage(relabel);
  setTitle("look.docTitle");
  const header = mountHeader({ home: "/app", nav: true, active: "look" });
  const state = await authStateOnce();
  mode = state?.mode ?? "local";
  mountFooter({ local: mode !== "hosted" });
  // Hosted: the look editor belongs to a mosque's login (its presets are the mosque's own). A
  // local page without a login skips the question (no 401 in the console).
  const me =
    mode === "hosted" || state?.loggedIn !== false ? await fetchMe().catch(() => null) : null;
  if (me === null && mode === "hosted") {
    window.location.replace(loginUrl("/app/look"));
    return;
  }
  canSave = me === null || isAdminRole(me);
  applyMode();
  header.setAccount(me);
  restore();
  // The builder's languages (Fine-tune the look): the links and the sample follow them.
  const qFrom = langCode(query.get("from"), "");
  const qTo = langCode(linkTo, "");
  if (qFrom !== "") w.from = qFrom;
  if (qTo !== "") w.to = qTo;
  renderGroups();
  wireWorkspace();
  wireSaveDialog();
  renderGalleries();
  commit();
  await loadPresets();
  // A link with theme parameters (e.g. pasted from OBS) opens in the editor as its own state.
  const linkQ = new URLSearchParams(query);
  for (const k of ["token", "view", "backdrop", "sample", "from", "to"]) linkQ.delete(k);
  if ([...linkQ.keys()].length > 0) adoptQuery(linkQ);
  if (findPreset(w.presetId, custom) === undefined) w.presetId = defaultPreset;
  renderGalleries();
  commit();
}

void main();
