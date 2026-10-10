// "Position on the screen": a mini 16:9 screen with a 3×3 grid (top/middle/bottom ×
// left/center/right) and a live outline of the caption panel. Shared by /customize and the
// picker's Fine-tune step. Picking a side with a very wide panel narrows it to PIP_WIDTH_VW so
// a picture-in-picture camera fits on the other side (placementAdjust); the caller applies it.
import "./placement-picker.css";
import { t } from "./app-i18n.js";
import { el } from "./dom.js";

export type VPos = "top" | "middle" | "bottom";
export type HPos = "flex-start" | "center" | "flex-end";

export interface PlacementView {
  pos: VPos;
  justify: HPos;
  /** Panel size in % of the screen (from --cap-panel-width / --cap-panel-height). */
  widthPct: number;
  heightPct: number;
  rollup: boolean;
}

export interface PlacementPicker {
  root: HTMLElement;
  set(v: PlacementView): void;
  /** A short explanation under the screen (null hides it). */
  note(text: string | null): void;
  /** Draw the labels again (after a language switch). */
  relabel(): void;
}

/** The words of the picker; English by default (the builder passes its own language). */
export interface PlacementLabels {
  group: string;
  top: string;
  middle: string;
  bottom: string;
  left: string;
  center: string;
  right: string;
  readout(place: string, widthPct: number): string;
  pipWidth(widthPct: number, cameraSide: "left" | "right"): string;
  widthBack: string;
  shortHeight(heightPct: number, pos: "top" | "middle"): string;
  heightBack: string;
}

export const ENGLISH_PLACEMENT: PlacementLabels = {
  group: "Position on the screen",
  top: "Top",
  middle: "Middle",
  bottom: "Bottom",
  left: "Left",
  center: "Center",
  right: "Right",
  readout: (place, w) => `${place} · ${w} % wide`,
  pipWidth: (w, side) => `Width set to ${w} % so a picture-in-picture camera fits on the ${side}.`,
  widthBack: "Width back to the look's own size.",
  shortHeight: (h, pos) => `Height set to ${h} % so the panel can sit at the ${pos}.`,
  heightBack: "Height back to the look's own size.",
};

/** The picker in the app language (web/shared/app-i18n.ts): the builder and the look editor. */
export function appPlacementLabels(): PlacementLabels {
  return {
    group: t("plc.label"),
    top: t("plc.top"),
    middle: t("plc.middle"),
    bottom: t("plc.bottom"),
    left: t("plc.left"),
    center: t("plc.center"),
    right: t("plc.right"),
    readout: (place, w) => t("plc.readout", { place, w }),
    pipWidth: (w, side) => t(side === "right" ? "plc.pipRight" : "plc.pipLeft", { w }),
    widthBack: t("plc.widthBack"),
    shortHeight: (h, pos) => t(pos === "top" ? "plc.heightTop" : "plc.heightMiddle", { h }),
    heightBack: t("plc.heightBack"),
  };
}

/** Panel width after picking left/right with a panel wider than SIDE_MAX_PCT. */
export const PIP_WIDTH_VW = 65;
const SIDE_MAX_PCT = 80;
/** Panel height after picking top/middle with a (nearly) full-height blocks panel. */
const SHORT_HEIGHT_VH = 50;

const ROWS: readonly VPos[] = ["top", "middle", "bottom"];
const COLS: ReadonlyArray<readonly [HPos, "left" | "center" | "right"]> = [
  ["flex-start", "left"],
  ["center", "center"],
  ["flex-end", "right"],
];

function colWord(justify: HPos, l: PlacementLabels): string {
  const k = COLS.find(([v]) => v === justify)?.[1] ?? "center";
  return l[k];
}

export function placementLabel(
  pos: VPos,
  justify: HPos,
  l: PlacementLabels = ENGLISH_PLACEMENT,
): string {
  return `${l[pos]} · ${colWord(justify, l)}`;
}

/** A theme length as % of a 1920×1080 screen ("92vw" → 92, "1200px" → 62.5, "none" → 100). */
export function lengthPct(css: string | undefined, axis: "w" | "h"): number {
  if (css === undefined) return 100;
  const m = /^(-?\d*\.?\d+)(vw|vh|%|px|vmin|vmax)?$/.exec(css.trim());
  if (m?.[1] === undefined) return 100;
  const n = Number(m[1]);
  const unit = m[2] ?? "px";
  if (unit === "px") return (n / (axis === "w" ? 1920 : 1080)) * 100;
  if (unit === "vw") return axis === "w" ? n : (n * 1920) / 1080;
  if (unit === "vh") return axis === "h" ? n : (n * 1080) / 1920;
  return n;
}

export interface PlacementAdjust {
  /** New --cap-panel-width / --cap-panel-height, or null to keep. */
  width: string | null;
  height: string | null;
  /** Drop an automatic width/height again (back to the look's own value). */
  resetWidth: boolean;
  resetHeight: boolean;
  note: string | null;
}

export interface PlacementNow {
  widthPct: number;
  heightPct: number;
  rollup: boolean;
  /** The current width/height was set by an earlier pick (not by the user's slider). */
  autoWidth?: boolean;
  autoHeight?: boolean;
}

/**
 * Sensible size changes for a pick, with the reason shown to the user. Automatic sizes are
 * provisional: picking Center again restores the look's width and Bottom its height, unless
 * the user moved that slider meanwhile (the caller then clears the auto flag).
 */
export function placementAdjust(
  pos: VPos,
  justify: HPos,
  cur: PlacementNow,
  l: PlacementLabels = ENGLISH_PLACEMENT,
): PlacementAdjust {
  const notes: string[] = [];
  let width: string | null = null;
  let height: string | null = null;
  let resetWidth = false;
  let resetHeight = false;
  if (justify !== "center" && cur.widthPct > SIDE_MAX_PCT) {
    width = `${PIP_WIDTH_VW}vw`;
    notes.push(l.pipWidth(PIP_WIDTH_VW, justify === "flex-start" ? "right" : "left"));
  } else if (justify === "center" && cur.autoWidth === true) {
    resetWidth = true;
    notes.push(l.widthBack);
  }
  if (!cur.rollup && pos !== "bottom" && cur.heightPct >= 90) {
    height = `${SHORT_HEIGHT_VH}vh`;
    notes.push(l.shortHeight(SHORT_HEIGHT_VH, pos === "top" ? "top" : "middle"));
  } else if (pos === "bottom" && cur.autoHeight === true) {
    resetHeight = true;
    notes.push(l.heightBack);
  }
  return {
    width,
    height,
    resetWidth,
    resetHeight,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

export function placementPicker(
  onPick: (pos: VPos, justify: HPos) => void,
  labels: () => PlacementLabels = () => ENGLISH_PLACEMENT,
): PlacementPicker {
  const panel = el("div", { class: "plc-panel", attrs: { "aria-hidden": "true" } }, [
    el("i"),
    el("i"),
    el("i"),
  ]);
  const grid = el("div", { class: "plc-grid", attrs: { role: "group" } });
  const cells: Array<{ pos: VPos; justify: HPos; btn: HTMLButtonElement }> = [];
  for (const pos of ROWS) {
    for (const [justify] of COLS) {
      const btn = el("button", {
        class: "plc-cell",
        attrs: { type: "button", "aria-pressed": "false" },
      });
      btn.append(el("span", { class: "plc-dot" }));
      btn.addEventListener("click", () => onPick(pos, justify));
      grid.append(btn);
      cells.push({ pos, justify, btn });
    }
  }
  const screen = el("div", { class: "plc-screen" }, [panel, grid]);
  const colLabels = COLS.map(() => el("span"));
  const rowLabels = ROWS.map(() => el("span"));
  const cols = el("div", { class: "plc-cols", attrs: { "aria-hidden": "true" } }, colLabels);
  const rows = el("div", { class: "plc-rows", attrs: { "aria-hidden": "true" } }, rowLabels);
  const readout = el("p", { class: "plc-readout" });
  const noteEl = el("p", { class: "plc-note", attrs: { role: "status" } });
  noteEl.hidden = true;
  const root = el("div", { class: "plc" }, [
    el("span", { class: "plc-corner" }),
    cols,
    rows,
    screen,
    readout,
    noteEl,
  ]);
  let last: PlacementView | null = null;
  const relabel = (): void => {
    const l = labels();
    grid.setAttribute("aria-label", l.group);
    COLS.forEach(([, k], i) => {
      const span = colLabels[i];
      if (span) span.textContent = l[k];
    });
    ROWS.forEach((pos, i) => {
      const span = rowLabels[i];
      if (span) span.textContent = l[pos];
    });
    for (const c of cells) {
      c.btn.setAttribute("aria-label", `${l[c.pos]} · ${colWord(c.justify, l)}`);
    }
    if (last) {
      const w = Math.max(8, Math.min(100, last.widthPct));
      readout.textContent = l.readout(placementLabel(last.pos, last.justify, l), Math.round(w));
    }
  };
  relabel();
  return {
    root,
    set(v) {
      last = v;
      for (const c of cells) {
        c.btn.setAttribute("aria-pressed", String(c.pos === v.pos && c.justify === v.justify));
      }
      const w = Math.max(8, Math.min(100, v.widthPct));
      const h = v.rollup ? 24 : Math.max(8, Math.min(100, v.heightPct));
      const left =
        v.justify === "flex-start" ? 0 : v.justify === "flex-end" ? 100 - w : (100 - w) / 2;
      const top = v.pos === "top" ? 0 : v.pos === "middle" ? (100 - h) / 2 : 100 - h;
      panel.style.setProperty("left", `${left}%`);
      panel.style.setProperty("top", `${top}%`);
      panel.style.setProperty("width", `${w}%`);
      panel.style.setProperty("height", `${h}%`);
      panel.classList.toggle("is-rollup", v.rollup);
      relabel();
    },
    note(text) {
      noteEl.textContent = text ?? "";
      noteEl.hidden = text === null;
    },
    relabel,
  };
}
