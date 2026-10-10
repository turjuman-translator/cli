// URL parameters of the caption page and the overlay.
// Unknown or out-of-range values fall back to the defaults instead of breaking the page. Older
// links may carry engine=, translation= (caption page) or track= (overlay): the removed engine
// choice, ignored.

export type Pos = "bottom" | "top" | "middle";
export type Bg = "band" | "shadow" | "none";
export type Show = "both" | "target" | "source";
export type Channel = "mix" | "left" | "right";

export interface DisplayParams {
  lines: number;
  /** Latin (translation) font size in px. */
  size: number;
  /** Source font scale; null = 1.15 for Arabic-script sources, else 1 (resolved by the renderer). */
  srcScale: number | null;
  /** Line-height factor of Latin-script lines (theme --cap-line-height); null = 1.3. */
  lineHeight: number | null;
  pos: Pos;
  /** Block width in % of the viewport. */
  width: number;
  bg: Bg;
  partial: boolean;
  /** Seconds without updates before the blocks fade out (0 = never). */
  idle: number;
  debug: boolean;
}

export interface PageParams extends DisplayParams {
  show: Show;
  mic: string | null;
  ch: Channel;
  dsp: boolean;
  key: string | null;
  /** Status bar visible (ui=auto → hidden inside OBS). */
  ui: boolean;
  /** Debug aid (`rate=native`): skip the 16 kHz AudioContext and resample in the worklet. */
  nativeRate: boolean;
}

export interface OverlayParams extends DisplayParams {
  /** Blocks top → bottom, e.g. ["ar", "nl"]. */
  langs: string[];
  session: string | null;
  token: string | null;
}

function int(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function num(q: URLSearchParams, name: string, min: number, max: number): number | null {
  const raw = q.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function oneOf<T extends string>(
  q: URLSearchParams,
  name: string,
  values: readonly T[],
  def: T,
): T {
  const raw = q.get(name)?.trim().toLowerCase();
  return (values as readonly string[]).includes(raw ?? "") ? (raw as T) : def;
}

function bool(q: URLSearchParams, name: string, def: boolean): boolean {
  const raw = q.get(name)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return def;
}

function str(q: URLSearchParams, name: string): string | null {
  const raw = q.get(name);
  return raw === null || raw.trim() === "" ? null : raw.trim();
}

export function parseDisplayParams(q: URLSearchParams): DisplayParams {
  return {
    lines: int(q, "lines", 2, 1, 12),
    size: int(q, "size", 46, 8, 300),
    srcScale: num(q, "srcScale", 0.3, 4) ?? num(q, "arScale", 0.3, 4),
    lineHeight: null,
    pos: oneOf(q, "pos", ["bottom", "top", "middle"] as const, "bottom"),
    width: int(q, "width", 90, 10, 100),
    bg: oneOf(q, "bg", ["band", "shadow", "none"] as const, "band"),
    partial: bool(q, "partial", true),
    idle: num(q, "idle", 0, 86_400) ?? 10,
    debug: bool(q, "debug", false),
  };
}

export function parsePageParams(q: URLSearchParams, inObs: boolean): PageParams {
  const ui = q.get("ui")?.trim().toLowerCase() ?? "auto";
  return {
    ...parseDisplayParams(q),
    show: oneOf(q, "show", ["both", "target", "source"] as const, "both"),
    mic: str(q, "mic"),
    ch: oneOf(q, "ch", ["mix", "left", "right"] as const, "mix"),
    dsp: bool(q, "dsp", false),
    key: str(q, "key"),
    ui: ui === "1" || ui === "true" ? true : ui === "0" || ui === "false" ? false : !inObs,
    nativeRate: q.get("rate")?.trim().toLowerCase() === "native",
  };
}

export function parseOverlayParams(q: URLSearchParams): OverlayParams {
  const langs = (q.get("lang") ?? "ar,nl")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    ...parseDisplayParams(q),
    langs: langs.length > 0 ? langs : ["ar", "nl"],
    session: str(q, "session"),
    token: str(q, "token"),
  };
}
