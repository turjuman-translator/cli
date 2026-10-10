// Shared roll-up caption renderer. Used by the caption page and the overlay.
//
// Model: one block per {role, lang}. A block is a flowing paragraph of segment spans; each
// segment span holds chunk spans of newly-final text (fade in over 150 ms, opacity only) and,
// for the first non-final segment, the single partial span (60 %). While a segment is open its
// stable text is snapped back to the last space so no word is half bright/half dim. The window
// shows the last `lines` lines (flex-end + overflow hidden); text is trimmed only to bound the DOM,
// at a line start ≥ 2 lines above the window, so visible lines never reflow. A bottom padding
// ratchet keeps the visible line count from dropping until the next final commit (anti-bounce).
import "./rollup.css";
import { dirFor, isArabicScript, isNoSpaceScript } from "../../src/shared/lang.js";
import type { Segment, TextState } from "../../src/shared/protocol.js";
import { el } from "./dom.js";
import { honNodes } from "./hon.js";
import type { DisplayParams } from "./params.js";

export interface BlockSpec {
  role: "source" | "translation";
  /** Language code; "auto" for a source block when from=auto. */
  lang: string;
}

const TRIM_ABOVE_CHARS = 1500;
const KEEP_HIDDEN_LINES = 2;
const FADE_OUT_MS = 400;
const FONT_TIMEOUT_MS = 3000;
export const ARABIC_FONT = '"Noto Naskh Arabic", serif';
export const LATIN_FONT = '"Noto Sans", "Noto Naskh Arabic", sans-serif';

/** Watermark per session: segments before `seq` are hidden, `seq` itself from `len` on. */
interface Mark {
  seq: number;
  len: number;
}

interface SegView {
  id: string;
  sessionId: string;
  seq: number;
  span: HTMLSpanElement;
  /** Committed (bright) text, including any part trimmed off the DOM. */
  committed: string;
  /** Text length of the segment's TextState at the last render (for watermarks). */
  lastLen: number;
  trimmed: boolean;
  gone: boolean;
}

export type RollupOptions = DisplayParams;

export interface BlockGeometry {
  fontPx: number;
  lineHeightPx: number;
  /** Arabic-script line: Noto Naskh / --cap-arabic-font-family and room for tashkeel. */
  arabic: boolean;
  family: string;
}

/**
 * Integer-px geometry (the trimming and anti-bounce math depend on it): Arabic-script lines use
 * line-height 1.55, other lines the theme's --cap-line-height (default 1.3). Fonts, colours and
 * shadows come from the theme variables in rollup.css.
 */
export function blockGeometry(
  spec: BlockSpec,
  p: Pick<DisplayParams, "size" | "srcScale" | "lineHeight">,
): BlockGeometry {
  const arabic = isArabicScript(spec.lang);
  const latinLh = p.lineHeight !== null && p.lineHeight >= 0.8 ? p.lineHeight : 1.3;
  if (spec.role === "source") {
    const scale = p.srcScale ?? (arabic ? 1.15 : 1);
    const fontPx = Math.max(6, Math.round(p.size * scale));
    // "auto" may well be Arabic: keep room for tashkeel.
    const tall = arabic || spec.lang === "auto";
    return {
      fontPx,
      lineHeightPx: Math.round(fontPx * (tall ? 1.55 : latinLh)),
      arabic,
      family: arabic ? ARABIC_FONT : LATIN_FONT,
    };
  }
  return {
    fontPx: p.size,
    lineHeightPx: Math.round(p.size * (arabic ? 1.55 : latinLh)),
    arabic,
    family: arabic ? ARABIC_FONT : LATIN_FONT,
  };
}

function lastSpace(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 0xa0 || c === 0x3000) return i;
  }
  return -1;
}

/** Split a segment's text into the committed part and the partial tail (pure; snaps to a word). */
export function splitText(
  ts: TextState,
  offset: number,
  noSpace: boolean,
): { commit: string; rest: string } {
  const text = ts.text;
  const start = Math.min(Math.max(0, offset), text.length);
  if (ts.final) return { commit: text.slice(start), rest: "" };
  const finalEnd = Math.max(start, Math.min(ts.finalLen, text.length));
  const stable = text.slice(start, finalEnd);
  const cut = noSpace ? stable.length : lastSpace(stable) + 1;
  return { commit: stable.slice(0, cut), rest: stable.slice(cut) + text.slice(finalEnd) };
}

class BlockView {
  readonly root: HTMLDivElement;
  private readonly window: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private readonly partial: HTMLSpanElement;
  private readonly views = new Map<string, SegView>();
  private readonly marks = new Map<string, Mark>();
  private readonly geo: BlockGeometry;
  private readonly noSpace: boolean;
  private ratchet = 0;
  private padLines = 0;

  constructor(
    readonly spec: BlockSpec,
    private readonly p: RollupOptions,
  ) {
    this.geo = blockGeometry(spec, p);
    this.noSpace = isNoSpaceScript(spec.lang);
    this.root = el("div", { class: `cap-block cap-${spec.role} is-empty` });
    if (spec.lang === "auto") this.root.dir = "auto";
    else {
      this.root.lang = spec.lang;
      this.root.dir = dirFor(spec.lang);
    }
    this.window = el("div", { class: "cap-window" });
    this.window.style.height = `${p.lines * this.geo.lineHeightPx}px`;
    // Room below the last line for descending honorific ligatures (ﷺ ﵇ …), which the window
    // would otherwise clip; the text stays anchored above it.
    this.window.style.paddingBottom = `${Math.round(this.geo.fontPx * 0.3)}px`;
    this.text = el("div", { class: this.geo.arabic ? "cap-text is-arabic" : "cap-text" });
    this.text.style.fontSize = `${this.geo.fontPx}px`;
    this.text.style.lineHeight = `${this.geo.lineHeightPx}px`;
    this.partial = el("span", { class: "cap-partial" });
    this.window.append(this.text);
    this.root.append(this.window);
  }

  private textOf(s: Segment): TextState | null {
    if (this.spec.role === "source") return s.source;
    return s.translations[this.spec.lang] ?? null;
  }

  /** Sync the DOM with `segs` (display order). Returns whether anything visible changed. */
  render(segs: readonly Segment[]): { changed: boolean; committed: boolean } {
    let changed = false;
    let committed = false;
    let seenOpen = false;
    let owner: SegView | null = null;
    let partialText = "";
    let lastLang: string | null = null;
    const present = new Set<string>();

    for (const [i, s] of segs.entries()) {
      present.add(s.id);
      const ts = this.textOf(s);
      if (!ts) continue;
      const mark = this.marks.get(s.sessionId);
      if (mark && s.seq < mark.seq) continue;
      const offset = mark && s.seq === mark.seq ? mark.len : 0;
      const ownsPartial = !ts.final && !seenOpen;
      if (!ts.final) seenOpen = true;
      let view = this.views.get(s.id);
      if (view?.gone) continue;
      const { commit, rest } = splitText(ts, offset, this.noSpace);
      const wantsPartial = ownsPartial && this.p.partial && rest.trim() !== "";
      if (!view) {
        if (commit.trim() === "" && !wantsPartial) continue;
        view = this.createView(s, segs, i);
        changed = true;
      }
      view.lastLen = ts.text.length;
      if (commit !== view.committed) {
        if (commit.startsWith(view.committed)) {
          this.appendChunk(view, commit.slice(view.committed.length));
        } else if (!view.trimmed) {
          this.rebuild(view, commit);
        }
        view.committed = commit;
        committed = true;
        changed = true;
      }
      if (wantsPartial) {
        owner = view;
        partialText = rest;
      }
      lastLang = s.source.lang || lastLang;
    }
    // from=auto: dir="auto" would skip the segment spans (they carry their own dir), so the
    // paragraph direction follows the most recent segment's detected language instead.
    if (this.spec.lang === "auto" && lastLang) {
      const dir = dirFor(lastLang);
      if (this.root.dir !== dir) this.root.dir = dir;
    }
    // Tombstones of segments the state no longer holds can go.
    for (const [id, v] of this.views) if (v.gone && !present.has(id)) this.views.delete(id);
    if (this.placePartial(owner, partialText)) changed = true;
    if (changed) this.root.classList.toggle("is-empty", !this.hasContent());
    return { changed, committed };
  }

  /** After DOM writes: anti-bounce ratchet, then trim to bound the DOM. */
  settle(committed: boolean): void {
    const lh = this.geo.lineHeightPx;
    const natural = this.text.offsetHeight - this.padLines * lh;
    const lines = Math.max(0, Math.round(natural / lh));
    if (committed || lines >= this.ratchet) this.ratchet = lines;
    this.setPad(this.ratchet - lines);
    this.maybeTrim();
  }

  /** Wipe now; with `watermark`, the wiped text never comes back (idle fade, `clear`). */
  wipe(watermark: boolean): void {
    if (watermark) {
      for (const v of this.views.values()) {
        const m = this.marks.get(v.sessionId);
        if (!m || v.seq > m.seq || (v.seq === m.seq && v.lastLen > m.len)) {
          this.marks.set(v.sessionId, { seq: v.seq, len: v.lastLen });
        }
      }
    } else {
      this.marks.clear();
    }
    this.views.clear();
    this.partial.textContent = "";
    this.text.replaceChildren();
    this.ratchet = 0;
    this.setPad(0);
    this.root.classList.add("is-empty");
  }

  private hasContent(): boolean {
    for (const v of this.views.values()) if (!v.gone && v.committed.trim() !== "") return true;
    return this.partial.isConnected && (this.partial.textContent ?? "").trim() !== "";
  }

  private createView(s: Segment, segs: readonly Segment[], index: number): SegView {
    const span = el("span", { class: "cap-seg" });
    span.append(document.createTextNode(" "));
    if (this.spec.role === "source" && this.spec.lang === "auto" && s.source.lang) {
      span.lang = s.source.lang;
      span.dir = dirFor(s.source.lang);
      if (isArabicScript(s.source.lang)) span.classList.add("cap-arabic");
    }
    if (this.p.debug) span.dataset.seq = String(s.seq);
    // Insert before the view of the next listed segment that already has one (else append).
    let before: Node | null = null;
    for (let j = index + 1; j < segs.length && before === null; j++) {
      const next = segs[j];
      const v = next ? this.views.get(next.id) : undefined;
      if (v && !v.gone && v.span.parentNode === this.text) before = v.span;
    }
    this.text.insertBefore(span, before);
    const view: SegView = {
      id: s.id,
      sessionId: s.sessionId,
      seq: s.seq,
      span,
      committed: "",
      lastLen: 0,
      trimmed: false,
      gone: false,
    };
    this.views.set(s.id, view);
    return view;
  }

  private appendChunk(view: SegView, text: string): void {
    const chunk = el(
      "span",
      { class: this.p.partial ? "cap-chunk-p" : "cap-chunk" },
      honNodes(text),
    );
    chunk.addEventListener(
      "animationend",
      () => {
        if (chunk.parentNode) chunk.replaceWith(...Array.from(chunk.childNodes));
      },
      { once: true },
    );
    const before = this.partial.parentNode === view.span ? this.partial : null;
    view.span.insertBefore(chunk, before);
  }

  private rebuild(view: SegView, commit: string): void {
    const hadPartial = this.partial.parentNode === view.span;
    view.span.replaceChildren(document.createTextNode(" "), ...honNodes(commit));
    if (hadPartial) view.span.append(this.partial);
  }

  private placePartial(owner: SegView | null, text: string): boolean {
    if (!owner || text === "") {
      if (!this.partial.isConnected) return false;
      this.partial.remove();
      this.partial.textContent = "";
      return true;
    }
    let changed = false;
    if (this.partial.parentNode !== owner.span || owner.span.lastChild !== this.partial) {
      owner.span.append(this.partial);
      changed = true;
    }
    if (this.partial.textContent !== text) {
      this.partial.replaceChildren(...honNodes(text));
      changed = true;
    }
    return changed;
  }

  private setPad(lines: number): void {
    const n = Math.max(0, lines);
    if (n === this.padLines) return;
    this.padLines = n;
    this.text.style.paddingBottom = n > 0 ? `${n * this.geo.lineHeightPx}px` : "";
  }

  // --- trimming: bound DOM size without visible reflow ---------------------------------------

  private textNodes(): { nodes: Text[]; starts: number[]; total: number } {
    const nodes: Text[] = [];
    const starts: number[] = [];
    let total = 0;
    const walker = document.createTreeWalker(this.text, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const t = n as Text; // SHOW_TEXT: the walker yields Text nodes only
      nodes.push(t);
      starts.push(total);
      total += t.data.length;
    }
    return { nodes, starts, total };
  }

  private maybeTrim(): void {
    const { nodes, starts, total } = this.textNodes();
    if (total <= TRIM_ABOVE_CHARS) return;
    const lh = this.geo.lineHeightPx;
    const rect = this.text.getBoundingClientRect();
    const visibleTop = rect.bottom - this.p.lines * lh;
    const cutTop = visibleTop - KEEP_HIDDEN_LINES * lh;
    if (cutTop - rect.top < lh / 2) return;

    // The text node holding character `i` (0 ≤ i < total): the last one starting at or before
    // it. There is one, since total > 0; and i < its start + length (the next one starts after i).
    const locate = (i: number): { node: Text; off: number } => {
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] ?? 0) <= i) lo = mid;
        else hi = mid - 1;
      }
      return { node: nodes[lo] as Text, off: i - (starts[lo] ?? 0) };
    };
    const range = document.createRange();
    const topAt = (i: number): number | null => {
      // Collapsed spaces have no box: use the next character that has one.
      for (let k = i; k < Math.min(total, i + 8); k++) {
        const at = locate(k);
        range.setStart(at.node, at.off);
        range.setEnd(at.node, at.off + 1);
        const r = range.getClientRects()[0];
        if (r) return r.top;
      }
      return null;
    };
    const threshold = cutTop - lh / 2;
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const top = topAt(mid);
      if (top !== null && top >= threshold) hi = mid;
      else lo = mid + 1;
    }
    const cut = lo;
    if (cut <= 0 || cut >= total) return;
    const at = locate(cut);
    if (this.partial.contains(at.node)) return; // never inside the partial

    const before = this.text.offsetHeight;
    let remaining = cut;
    for (const node of nodes) {
      if (remaining <= 0) break;
      const len = node.data.length;
      if (len <= remaining) {
        node.remove();
        remaining -= len;
      } else {
        node.deleteData(0, remaining);
        remaining = 0;
      }
    }
    for (const v of this.views.values()) {
      if (v.gone) continue;
      for (const chunk of Array.from(v.span.querySelectorAll("span"))) {
        if (chunk !== this.partial && (chunk.textContent ?? "") === "") chunk.remove();
      }
      const holdsPartial = v.span.contains(this.partial);
      if (!holdsPartial && (v.span.textContent ?? "") === "") {
        v.span.remove();
        v.gone = true;
        continue;
      }
      // Untouched spans hold " " + the committed text (+ the partial, when it is theirs).
      const partial = holdsPartial ? this.partial.textContent : "";
      if (v.span.textContent !== ` ${v.committed}${partial}`) v.trimmed = true;
    }
    const removedLines = Math.round((before - this.text.offsetHeight) / lh);
    if (removedLines > 0) this.ratchet = Math.max(0, this.ratchet - removedLines);
  }
}

export class RollupView {
  readonly root: HTMLDivElement;
  private blocks: BlockView[] = [];
  private specsKey = "";
  private segs: readonly Segment[] = [];
  private raf = 0;
  private fontsReady = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly ready: Promise<void>;

  constructor(
    host: HTMLElement,
    private readonly p: RollupOptions,
  ) {
    this.root = el("div", { class: `cap-root pos-${p.pos} bg-${p.bg}` });
    if (p.debug) this.root.classList.add("is-debug");
    host.append(this.root);
    this.ready = loadFonts().then(() => {
      this.fontsReady = true;
      this.schedule();
    });
  }

  /** (Re)configure the blocks; a change wipes the view (no watermark). */
  setBlocks(specs: readonly BlockSpec[]): void {
    const key = JSON.stringify(specs);
    if (key === this.specsKey) return;
    this.specsKey = key;
    this.blocks = specs.map((s) => new BlockView(s, this.p));
    this.root.replaceChildren(...this.blocks.map((b) => b.root));
    this.schedule();
  }

  get blockSpecs(): BlockSpec[] {
    return this.blocks.map((b) => b.spec);
  }

  /** New segment list for the shown track (display order); rendered on the next frame. */
  update(segs: readonly Segment[]): void {
    this.segs = segs;
    this.schedule();
  }

  /** `clear` message: wipe immediately; wiped text never returns. */
  clear(): void {
    this.cancelFade();
    for (const b of this.blocks) b.wipe(true);
  }

  /** Fade out over 400 ms, then clear (a screen was switched off). */
  fadeAway(): void {
    if (this.fadeTimer !== null) return;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.fadeOut();
  }

  /** Track switch / new configuration: wipe without a watermark. */
  reset(): void {
    this.cancelFade();
    this.segs = [];
    for (const b of this.blocks) b.wipe(false);
  }

  private schedule(): void {
    if (this.raf !== 0 || !this.fontsReady) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  private flush(): void {
    const results = this.blocks.map((b) => b.render(this.segs));
    const changed = results.some((r) => r.changed);
    this.blocks.forEach((b, i) => {
      b.settle(results[i]?.committed ?? false);
    });
    if (changed) this.touch();
  }

  private touch(): void {
    this.cancelFade();
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.p.idle > 0) this.idleTimer = setTimeout(() => this.fadeOut(), this.p.idle * 1000);
  }

  private fadeOut(): void {
    this.idleTimer = null;
    this.root.classList.add("is-fading");
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      for (const b of this.blocks) b.wipe(true);
      this.root.classList.remove("is-fading");
    }, FADE_OUT_MS);
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.root.classList.remove("is-fading");
  }
}

/** Load the bundled caption fonts before the first render (stable line math), with a timeout. */
export function loadFonts(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== "function") return Promise.resolve();
  const loads = [
    fonts.load('600 48px "Noto Naskh Arabic"', "بسم الله ﷺ"),
    fonts.load('600 48px "Noto Sans"', "Allah AaZz"),
    fonts.load('400 48px "Noto Sans"', "AaZz"),
  ];
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS));
  return Promise.race([Promise.allSettled(loads).then(() => undefined), timeout]);
}
