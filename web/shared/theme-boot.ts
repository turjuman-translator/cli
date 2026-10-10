// Theme bootstrap for the caption views: custom presets + the server default from
// GET /api/presets, then resolveTheme(URL params) → applyTheme(<html>), plus the reader's A−/A+
// font scale (localStorage). The theme module (src/shared/theme.ts) owns presets and validation.
import { applyTheme, findPreset, resolveTheme } from "../../src/shared/theme.js";
import type { DisplayOptions, ThemePreset, ThemeVar } from "../../src/shared/theme-vars.js";
import { storageGet, storageSet } from "./dom.js";

export interface BootedTheme {
  presetId: string;
  vars: Partial<Record<ThemeVar, string>>;
  options: DisplayOptions;
}

const PRESETS_TIMEOUT_MS = 1500;

/** Used only if the theme module fails: captions must render no matter what. */
const FALLBACK_OPTIONS: DisplayOptions = {
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
  size: 46,
  toolbar: "auto",
};

function fallbackTheme(query: URLSearchParams): BootedTheme {
  const layout = query.get("layout") === "rollup" ? "rollup" : "blocks";
  const size = Number(query.get("size"));
  const options: DisplayOptions = {
    ...FALLBACK_OPTIONS,
    layout,
    bg: layout === "rollup" ? "band" : "panel",
    partial: layout === "rollup",
    size: Number.isFinite(size) && size >= 8 && size <= 300 ? Math.round(size) : 46,
  };
  return { presetId: "fallback", vars: { "--cap-font-size": `${options.size}px` }, options };
}

/** Preset a roll-up starts from when ?layout=rollup is put on top of a blocks preset. */
const ROLLUP_BASE_PRESET = "lower-third";

/** Numeric value of a theme variable ("1.1" → 1.1), or null. */
export function themeNumber(
  vars: Partial<Record<ThemeVar, string>>,
  name: ThemeVar,
): number | null {
  const v = Number.parseFloat(vars[name] ?? "");
  return Number.isFinite(v) ? v : null;
}

function resolveSafely(
  query: URLSearchParams,
  custom: ThemePreset[],
  defaultId: string | null,
): BootedTheme {
  try {
    let t = defaultId ? resolveTheme(query, custom, defaultId) : resolveTheme(query, custom);
    // ?layout=rollup over a blocks preset (no ?preset= given): that preset's variables are meant
    // for blocks (e.g. a 0.72 source scale, left-aligned text), so the roll-up starts from the
    // lower-third preset instead; the URL's own overrides still apply.
    if (
      t.options.layout === "rollup" &&
      !hasParam(query, "preset") &&
      findPreset(t.presetId, custom)?.options.layout !== "rollup" &&
      findPreset(ROLLUP_BASE_PRESET) !== undefined
    ) {
      const q = new URLSearchParams(query);
      q.set("preset", ROLLUP_BASE_PRESET);
      t = resolveTheme(q, custom);
    }
    return { presetId: t.presetId, vars: { ...t.vars }, options: t.options };
  } catch {
    return fallbackTheme(query);
  }
}
const SCALE_KEY = "captions.fontScale";
const SCALES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7, 2] as const;

function isPreset(v: unknown): v is ThemePreset {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.vars === "object" &&
    p.vars !== null &&
    typeof p.options === "object" &&
    p.options !== null
  );
}

/** Custom presets and the server's default preset id (best effort; [] / null on failure). */
export async function fetchPresets(
  auth: URLSearchParams,
): Promise<{ custom: ThemePreset[]; defaultId: string | null }> {
  const q = new URLSearchParams();
  // screen: hosted servers answer with the custom presets of the screen's organisation.
  for (const k of ["key", "token", "screen"]) {
    const v = auth.get(k);
    if (v) q.set(k, v);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRESETS_TIMEOUT_MS);
  try {
    const qs = q.toString();
    const res = await fetch(qs ? `/api/presets?${qs}` : "/api/presets", {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { custom: [], defaultId: null };
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return { custom: [], defaultId: null };
    const d = data as { custom?: unknown; default?: unknown };
    return {
      custom: Array.isArray(d.custom) ? d.custom.filter(isPreset) : [],
      defaultId: typeof d.default === "string" && d.default ? d.default : null,
    };
  } catch {
    return { custom: [], defaultId: null };
  } finally {
    clearTimeout(timer);
  }
}

function isClear(paint: string | undefined): boolean {
  if (!paint) return true;
  const v = paint.trim().toLowerCase();
  return v === "transparent" || v === "none" || /^rgba\(.*,\s*0(\.0+)?\s*\)$/.test(v);
}

function hasParam(query: URLSearchParams, name: string): boolean {
  const lower = name.toLowerCase();
  for (const k of query.keys()) if (k.trim().toLowerCase() === lower) return true;
  return false;
}

/**
 * Resolve and apply the theme for this page (URL params win over the preset). `opaque`: in a
 * normal browser a transparent page around the panel shows the browser's white canvas, so the
 * page takes the panel colour (default: outside OBS with bg=panel, unless ?pageBg= is given).
 */
export async function bootTheme(
  query: URLSearchParams,
  opts: { opaque?: boolean } = {},
): Promise<BootedTheme> {
  const { custom, defaultId } = await fetchPresets(query);
  const theme = resolveSafely(query, custom, defaultId);
  // Always has --cap-font-size: resolveTheme derives it from `size`, and so does the fallback.
  const vars: Partial<Record<ThemeVar, string>> = { ...theme.vars };
  const opaque = opts.opaque ?? (window.obsstudio === undefined && theme.options.bg === "panel");
  if (opaque && !hasParam(query, "pageBg") && isClear(vars["--cap-page-bg"])) {
    const panel = vars["--cap-panel-bg"];
    vars["--cap-page-bg"] = panel && !isClear(panel) ? panel : "#0b0b0d";
  }
  try {
    applyTheme(document.documentElement, vars);
  } catch {
    // invalid theme module state: the CSS fallbacks still give the default look
  }
  applyFontScale(vars["--cap-font-size"] ?? `${theme.options.size}px`, fontScale());
  return { presetId: theme.presetId, vars, options: theme.options };
}

export function fontScale(): number {
  const v = Number(storageGet(SCALE_KEY));
  return Number.isFinite(v) && v >= 0.5 && v <= 2.5 ? v : 1;
}

/** Scale --cap-font-size relative to the theme's base size. */
export function applyFontScale(base: string, scale: number): void {
  const root = document.documentElement;
  root.style.setProperty("--cap-font-size", scale === 1 ? base : `calc(${base} * ${scale})`);
}

/** A−/A+: next step in SCALES, remembered in localStorage. Returns the new scale. */
export function stepFontScale(base: string, dir: -1 | 1): number {
  const current = fontScale();
  let idx = SCALES.findIndex((s) => s >= current - 0.001);
  if (idx < 0) idx = SCALES.length - 1;
  const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, idx + dir))] ?? 1;
  storageSet(SCALE_KEY, String(next));
  applyFontScale(base, next);
  return next;
}

/** Toolbar visibility: an explicit ?ui=1|0 wins, then the theme's toolbar option (auto = not OBS). */
export function toolbarVisible(query: URLSearchParams, toolbar: string, inObs: boolean): boolean {
  const ui = query.get("ui")?.trim().toLowerCase();
  if (ui === "1" || ui === "true") return true;
  if (ui === "0" || ui === "false") return false;
  if (toolbar === "on") return true;
  if (toolbar === "off") return false;
  return !inObs;
}
