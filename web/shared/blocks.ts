// Caption blocks renderer, the default layout of the caption page, the overlay and the archive.
// A vertical list anchored to the bottom: blocks slide in while the older ones glide up (FLIP,
// transform/opacity only). Fast blocks GROW: a `block.update` whose text extends the shown text
// appends only the new words (fading in); the shown prefix is never re-rendered. Any other text
// change (a rare normalization fix-up) is replaced in place with a quick crossfade. Event cards
// swap type/labels in place (Athan → Iqama), collapse to a compact line when they end, and retract
// (collapse) when hidden.
//   history mode (browser): scrollable; follows the newest block while within 40 px of the
//     bottom, otherwise shows a "↓ Live · N nieuw" pill; loads older blocks at the top.
//   follow mode (OBS / history=0): no scrollbars, always the newest, ≤ maxBlocks in the DOM.
import "./blocks.css";
import { dirFor } from "../../src/shared/lang.js";
import type { Block } from "../../src/shared/protocol.js";
import { el } from "./dom.js";
import { honNodes } from "./hon.js";
import { clockTime, type EventLabel, eventLabel, type UiLabels, uiLabels } from "./i18n.js";

export interface BlocksPage {
  blocks: Block[];
  hasMore: boolean;
}

export interface ExportLinks {
  txt: string;
  md: string;
  srt: string;
}

export interface BlockViewOptions {
  show: "both" | "target" | "source";
  quranAccent: boolean;
  quranArabic: boolean;
  /** Show the live Arabic partial next to the listening dots. */
  partial: boolean;
  /** Scrollable history (browser) instead of always-follow (OBS). */
  history: boolean;
  /** DOM cap in follow mode. */
  maxBlocks: number;
  /** Blocks shown at once in follow mode (0 = as many as fit). */
  visibleBlocks: number;
  pos: "bottom" | "top" | "middle";
  bg: "panel" | "none";
  targetLang: string;
  sourceLang: string;
  /** false = archive: no listening indicator, no live pill. */
  live: boolean;
  loadOlder?: (sessionId: string, beforeSeq: number) => Promise<BlocksPage | null>;
  exportLinks?: (sessionId: string) => ExportLinks | null;
}

const FOLLOW_SLACK_PX = 40;
const LOAD_OLDER_PX = 240;
const QUOTES = /^["“„«‘'‹「『]/;

type Key = readonly [number, number];

interface Item {
  id: string;
  key: Key;
  node: HTMLElement;
  block: Block | null;
  hidden: boolean;
}

function sessionOf(blockId: string): string {
  const i = blockId.lastIndexOf(":b");
  return i > 0 ? blockId.slice(0, i) : "";
}

function cmp(a: Key, b: Key): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** "2:285-286" → "2:285–286" (en dash). */
export function formatRef(ref: string): string {
  return ref.replace(/(\d)\s*-\s*(\d)/g, "$1–$2");
}

/** Quran blocks get quotes around the body unless the text brings its own. */
function quotedBody(b: Pick<Block, "kind" | "text">): boolean {
  return b.kind === "quran" && !QUOTES.test(b.text.trim());
}

/** The text as shown in `.blk-body` (no trailing space; no leading space when quoted). */
function shownText(b: Pick<Block, "kind" | "text">): string {
  return quotedBody(b) ? b.text.trim() : b.text.trimEnd();
}

/** Quran blocks are quoted: `"…" (2:286)`. */
export function quoted(text: string): string {
  const t = text.trim();
  return QUOTES.test(t) ? t : `"${t}"`;
}

export class BlockView {
  readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly top: HTMLDivElement;
  private readonly listen: HTMLDivElement | null = null;
  private readonly partialText: HTMLSpanElement | null = null;
  private readonly pill: HTMLButtonElement;
  private readonly items = new Map<string, Item>();
  private order: Item[] = [];
  private readonly sessionOrd = new Map<string, number>();
  private pending: Item[] = [];
  /** Text/label changes of shown blocks, applied in the next frame together with new blocks. */
  private ops: Array<() => void> = [];
  private raf = 0;
  /** End of the running FLIP glide (performance.now()). */
  private flipUntil = 0;
  private flipTimer: ReturnType<typeof setTimeout> | null = null;
  private following = true;
  /** scrollTop we set ourselves: its (async) scroll event must not count as the reader scrolling. */
  private autoTop = Number.NaN;
  /** While jumping back to live, intermediate (smooth) scroll events don't stop following. */
  private jumpUntil = 0;
  private newCount = 0;
  private hasMore = false;
  private loadingOlder = false;
  private olderBackoffUntil = 0;
  private newest: Item | null = null;
  private listenActive = false;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSession = "";
  private readonly labels: UiLabels;

  constructor(
    host: HTMLElement,
    private readonly o: BlockViewOptions,
  ) {
    this.labels = uiLabels(o.targetLang);
    this.root = el("div", { class: `blk-root pos-${o.pos} bg-${o.bg}` });
    this.root.classList.toggle("is-history", o.history);
    this.panel = el("div", { class: "blk-panel" });
    this.scroller = el("div", { class: "blk-scroll" });
    this.list = el("div", { class: "blk-list" });
    this.top = el("div", { class: "blk-marker blk-top", attrs: { hidden: "" } });
    this.list.append(this.top);
    this.scroller.append(this.list);
    this.panel.append(this.scroller);
    if (o.live) {
      this.partialText = el("span", { class: "blk-partial", attrs: { dir: "rtl", lang: "ar" } });
      const dots = el("span", { class: "blk-dots", attrs: { "aria-hidden": "true" } }, [
        el("i", { class: "blk-dot" }),
        el("i", { class: "blk-dot" }),
        el("i", { class: "blk-dot" }),
      ]);
      this.listen = el("div", { class: "blk-listen", attrs: { title: this.labels.listening } }, [
        dots,
        el("span", { class: "blk-partial-box" }, [this.partialText]),
      ]);
      this.listen.classList.toggle("with-partial", o.partial);
      this.panel.append(this.listen);
    }
    this.pill = el("button", { class: "blk-pill", attrs: { type: "button", hidden: "" } });
    this.pill.addEventListener("click", () => this.jumpToLive());
    this.panel.append(this.pill);
    this.root.append(this.panel);
    host.append(this.root);
    this.setShow(o.show);
    this.setQuranArabic(o.quranArabic);

    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    // Keep the newest block in view when sizes change (fonts loading, A−/A+, resize, collapse).
    const ro = new ResizeObserver(() => {
      // Not while a FLIP glide runs: the translated list counts as scrollable overflow, so
      // pinning now would overshoot by the glide distance (a one-frame jump); flush re-pins after.
      if (this.following && performance.now() >= this.flipUntil) this.scrollToBottom();
    });
    ro.observe(this.scroller);
    ro.observe(this.list);
  }

  get blockCount(): number {
    return this.order.reduce((n, it) => n + (it.block ? 1 : 0), 0);
  }

  // --- public API ------------------------------------------------------------------------------

  /** Initial / resumed history: merges by id (existing blocks keep their DOM, no animation). */
  snapshot(blocks: readonly Block[], hasMore: boolean): void {
    const sorted = [...blocks].sort((a, b) => a.seq - b.seq);
    const first = sorted[0];
    for (const b of sorted) {
      if (this.items.has(b.id)) this.update(b);
      else if (!b.hidden) this.insert(this.makeItem(b));
    }
    const earliest = this.order.find((it) => it.block);
    if (!first || !earliest || earliest.id === first.id) this.hasMore = hasMore;
    this.afterChange();
    if (this.following) this.scrollToBottom();
  }

  /** A new complete block: rendered on the next frame with the slide-in animation. */
  add(block: Block): void {
    if (this.items.has(block.id)) {
      this.update(block);
      return;
    }
    if (block.hidden) return;
    const item = this.makeItem(block);
    this.items.set(item.id, item);
    this.pending.push(item);
    // A block answers the speech: hide the dots until the server says "listening" again.
    this.listening(false);
    this.schedule();
  }

  /** Allowed changes only: hidden, event state, late ref validation, Quran text. */
  update(block: Block): void {
    const item = this.items.get(block.id);
    if (!item?.block) {
      if (!item && !block.hidden) this.add(block);
      return;
    }
    if (item.hidden) return;
    const prev = item.block;
    const next: Block = {
      ...prev,
      ...block,
      event: block.event ?? prev.event,
      quranText: block.quranText ?? prev.quranText,
    };
    item.block = next;
    if (block.hidden) {
      this.collapse(item);
      return;
    }
    // Not on screen yet (added in this frame): just render the latest state.
    if (this.pending.includes(item)) {
      if (next.kind === "event") this.fillEvent(item.node, next);
      else this.fillBlock(item.node, next);
      return;
    }
    if (prev.kind === "event" || next.kind === "event") {
      this.updateEvent(item, prev, next);
      return;
    }
    this.ops.push(() => this.applyTextChange(item, prev, next));
    this.schedule();
  }

  /** `listening` message (the server sends it after ~2 s of speech without a block, or while it
   *  holds prayer formulas): three dots, plus the faint Arabic partial when partial=1. */
  listening(active: boolean, partial?: string): void {
    if (!this.listen) return;
    this.listenActive = active;
    if (this.partialText) {
      const text = active && this.o.partial ? (partial ?? "") : "";
      if (this.partialText.textContent !== text) this.partialText.textContent = text;
    }
    this.refreshListening();
  }

  /** `session.ended`: divider "Sessie beëindigd · 13:41" (+ export links in history mode). */
  ended(endedAt: number, sessionId: string | null): void {
    const sid = sessionId ?? this.lastSession;
    const id = `end:${sid}`;
    if (this.items.has(id)) return;
    const node = el("div", { class: "blk-end" }, [
      el("div", {
        class: "blk-marker",
        text: `${this.labels.ended} · ${clockTime(endedAt, this.o.targetLang)}`,
      }),
    ]);
    const links = this.o.history && sid ? this.o.exportLinks?.(sid) : null;
    if (links) node.append(this.exportRow(links));
    const item: Item = {
      id,
      key: [this.ordOf(sid), Number.MAX_SAFE_INTEGER],
      node,
      block: null,
      hidden: false,
    };
    this.items.set(id, item);
    this.pending.push(item);
    this.listening(false);
    this.schedule();
  }

  setShow(show: BlockViewOptions["show"]): void {
    this.o.show = show;
    for (const s of ["both", "target", "source"])
      this.root.classList.toggle(`show-${s}`, s === show);
    this.refit();
  }

  setQuranArabic(on: boolean): void {
    this.o.quranArabic = on;
    this.root.classList.toggle("quran-ar", on);
    this.refit();
  }

  /** Re-anchor after a size change (font size step, toggles). */
  refit(): void {
    if (this.following) this.scrollToBottom();
  }

  scrollToTop(): void {
    this.following = false;
    this.scroller.scrollTop = 0;
    this.autoTop = this.scroller.scrollTop;
    this.updatePill();
  }

  jumpToLive(): void {
    const s = this.scroller;
    const distance = s.scrollHeight - s.scrollTop - s.clientHeight;
    // Smooth only for short distances; long jumps are instant (and can't be overtaken by blocks).
    const smooth = this.motionMs() > 0 && distance < 1.5 * s.clientHeight;
    this.following = true;
    this.newCount = 0;
    if (smooth) {
      this.jumpUntil = Date.now() + 900;
      s.scrollTo({ top: s.scrollHeight, behavior: "smooth" });
    } else {
      this.scrollToBottom();
    }
    this.updatePill();
  }

  /** Drop everything (e.g. the overlay switched to another session). */
  reset(): void {
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.root.classList.remove("is-clearing");
    this.pending = [];
    this.ops = [];
    for (const it of this.order) it.node.remove();
    this.order = [];
    this.items.clear();
    this.newest = null;
    this.hasMore = false;
    this.newCount = 0;
    this.following = true;
    this.listening(false);
    this.afterChange();
  }

  /** Fade everything out, then reset (a screen was switched off: the next session starts clean). */
  fadeAndReset(): void {
    if (this.fadeTimer !== null) return;
    const ms = this.motionMs();
    if (ms === 0 || this.order.length === 0) {
      this.reset();
      return;
    }
    this.listening(false);
    this.root.classList.add("is-clearing");
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      this.reset();
    }, 450);
  }

  // --- rendering ----------------------------------------------------------------------------------

  private makeItem(b: Block): Item {
    const node = el("article", { class: `blk blk-${b.kind}` });
    node.dataset.seq = String(b.seq);
    if (b.kind === "event") this.fillEvent(node, b);
    else this.fillBlock(node, b);
    const sid = sessionOf(b.id);
    this.lastSession = sid || this.lastSession;
    return { id: b.id, key: [this.ordOf(sid), b.seq], node, block: b, hidden: false };
  }

  private fillBlock(node: HTMLElement, b: Block): void {
    node.lang = b.lang;
    node.dir = dirFor(b.lang);
    const accent = b.kind === "quran" ? this.o.quranAccent : b.kind === "dua";
    node.classList.toggle("has-accent", accent);
    const parts: HTMLElement[] = [];
    if (b.kind === "quran" && b.quranText) {
      parts.push(
        el("p", { class: "blk-quran-ar", text: b.quranText, attrs: { dir: "rtl", lang: "ar" } }),
      );
    }
    // The body holds the (growing) text; quotes and the reference stay outside it.
    const text = el("p", { class: "blk-text" });
    const quote = quotedBody(b);
    const body = el("span", { class: "blk-body" }, honNodes(shownText(b)));
    if (quote) text.append('"', body, '"');
    else text.append(body);
    if (b.ref) text.append(" ", el("span", { class: "blk-ref", text: `(${formatRef(b.ref)})` }));
    parts.push(text);
    if (b.src) {
      const auto = this.o.sourceLang === "auto";
      parts.push(
        el("p", {
          class: "blk-src",
          text: b.src,
          attrs: auto
            ? { dir: "auto" }
            : { dir: dirFor(this.o.sourceLang), lang: this.o.sourceLang },
        }),
      );
    }
    node.replaceChildren(...parts);
  }

  private fillEvent(node: HTMLElement, b: Block): void {
    const ev = b.event;
    node.lang = b.lang;
    node.dir = dirFor(b.lang);
    if (!ev) {
      node.replaceChildren();
      return;
    }
    const label: EventLabel = ev.label ?? eventLabel(ev.type, this.o.targetLang);
    node.dataset.event = ev.type;
    node.classList.toggle("is-active", ev.active);
    node.classList.toggle("is-ended", !ev.active);
    if (ev.active) {
      const card = el("div", { class: "ev-card" }, [
        el("div", { class: "ev-wave", attrs: { "aria-hidden": "true" } }, [
          el("i", { class: "ev-bar" }),
          el("i", { class: "ev-bar" }),
          el("i", { class: "ev-bar" }),
          el("i", { class: "ev-bar" }),
          el("i", { class: "ev-bar" }),
        ]),
        el("div", { class: "ev-ar", text: label.ar, attrs: { dir: "rtl", lang: "ar" } }),
        el("div", { class: "ev-title" }, honNodes(label.title)),
      ]);
      if (label.subtitle) card.append(el("div", { class: "ev-sub" }, honNodes(label.subtitle)));
      node.replaceChildren(card);
    } else {
      node.replaceChildren(
        el("div", { class: "ev-compact" }, [
          el("span", { class: "ev-compact-ar", text: label.ar, attrs: { dir: "rtl", lang: "ar" } }),
          el(
            "span",
            {},
            honNodes(`${label.title} · ${clockTime(ev.startedAt, this.o.targetLang)}`),
          ),
        ]),
      );
    }
  }

  /**
   * A shown block changed. Text that extends the shown text is appended (only the new
   * words fade in; the prefix is never re-rendered); anything else is replaced in place with a
   * quick crossfade. Kind (e.g. speech → dua), ref, source text and Quran text update in place.
   */
  private applyTextChange(item: Item, prev: Block, next: Block): void {
    const node = item.node;
    if (prev.kind !== next.kind) {
      node.classList.remove(`blk-${prev.kind}`);
      node.classList.add(`blk-${next.kind}`);
      const accent = next.kind === "quran" ? this.o.quranAccent : next.kind === "dua";
      node.classList.toggle("has-accent", accent);
    }
    const text = node.querySelector(".blk-text");
    const body = text?.querySelector(".blk-body");
    if (!text || !body || quotedBody(prev) !== quotedBody(next)) {
      // Quoting changed (quran ↔ other): rebuild once.
      this.fillBlock(node, next);
      return;
    }
    const was = shownText(prev);
    const now = shownText(next);
    if (now !== was) {
      if (now.startsWith(was)) {
        const grow = el("span", { class: "blk-grow" }, honNodes(now.slice(was.length)));
        body.append(grow);
        if (this.motionMs() > 0) {
          grow.addEventListener(
            "animationend",
            () => grow.replaceWith(...Array.from(grow.childNodes)),
            {
              once: true,
            },
          );
        } else {
          grow.replaceWith(...Array.from(grow.childNodes));
        }
      } else {
        body.replaceChildren(...honNodes(now));
        this.restartAnimation(body, "blk-swap");
      }
    }
    this.syncRef(text, next);
    this.syncSrc(node, prev, next);
    // The Arabic of a verse block: added late, or longer when the khatib recites further.
    if (next.quranText && next.quranText !== prev.quranText) {
      const ar = node.querySelector(".blk-quran-ar");
      if (ar) ar.textContent = next.quranText;
      else {
        node.prepend(
          el("p", {
            class: "blk-quran-ar",
            text: next.quranText,
            attrs: { dir: "rtl", lang: "ar" },
          }),
        );
      }
    }
  }

  /** `text`: the block's `.blk-text` paragraph. */
  private syncRef(text: Element, b: Block): void {
    const span = text.querySelector(".blk-ref");
    const want = b.ref ? `(${formatRef(b.ref)})` : null;
    if (want === null) {
      if (span) {
        span.previousSibling?.remove();
        span.remove();
      }
    } else if (span) {
      if (span.textContent !== want) span.textContent = want;
    } else {
      text.append(" ", el("span", { class: "blk-ref", text: want }));
    }
  }

  private syncSrc(node: HTMLElement, prev: Block, next: Block): void {
    if (next.src === prev.src) return;
    let src = node.querySelector(".blk-src");
    if (!next.src) {
      src?.remove();
      return;
    }
    if (!src) {
      const auto = this.o.sourceLang === "auto";
      src = el("p", {
        class: "blk-src",
        attrs: auto ? { dir: "auto" } : { dir: dirFor(this.o.sourceLang), lang: this.o.sourceLang },
      });
      node.append(src);
    }
    if (prev.src && next.src.startsWith(prev.src) && src.textContent === prev.src) {
      src.append(next.src.slice(prev.src.length));
    } else {
      src.textContent = next.src;
    }
  }

  /** Event blocks: Athan → Iqama swaps the card's texts in place; active ↔ ended resizes. */
  private updateEvent(item: Item, prev: Block, next: Block): void {
    const pe = prev.event;
    const ne = next.event;
    if (!ne || prev.kind !== "event" || next.kind !== "event") {
      this.resize(item, () =>
        next.kind === "event" ? this.fillEvent(item.node, next) : this.fillBlock(item.node, next),
      );
      return;
    }
    const label = ne.label ?? eventLabel(ne.type, this.o.targetLang);
    const prevLabel = pe ? (pe.label ?? eventLabel(pe.type, this.o.targetLang)) : null;
    const relabel = pe?.type !== ne.type || JSON.stringify(label) !== JSON.stringify(prevLabel);
    if ((pe?.active ?? false) && ne.active) {
      if (relabel) this.swapEventCard(item, next, label);
      return;
    }
    if ((pe?.active ?? false) !== ne.active || relabel) {
      this.resize(item, () => this.fillEvent(item.node, next));
    }
  }

  /** Crossfade the card's Arabic title, title and subtitle (the sound wave keeps going). */
  private swapEventCard(item: Item, next: Block, label: EventLabel): void {
    const node = item.node;
    const card = node.querySelector(".ev-card");
    const ms = this.motionMs();
    const apply = (): void => {
      if (!card) {
        this.fillEvent(node, next);
        return;
      }
      node.dataset.event = next.event?.type ?? "";
      const ar = card.querySelector(".ev-ar");
      if (ar) ar.textContent = label.ar;
      card.querySelector(".ev-title")?.replaceChildren(...honNodes(label.title));
      let sub = card.querySelector(".ev-sub");
      if (label.subtitle) {
        if (!sub) {
          sub = el("div", { class: "ev-sub" });
          card.append(sub);
        }
        sub.replaceChildren(...honNodes(label.subtitle));
      } else {
        sub?.remove();
      }
    };
    if (!card || ms === 0 || !node.isConnected) {
      apply();
      this.refit();
      return;
    }
    card.classList.add("is-swapping");
    setTimeout(
      () => {
        this.resize(item, apply);
        card.classList.remove("is-swapping");
      },
      Math.round(ms * 0.7),
    );
  }

  private restartAnimation(node: Element, cls: string): void {
    node.classList.remove(cls);
    void (node as HTMLElement).offsetWidth;
    node.classList.add(cls);
  }

  private exportRow(links: ExportLinks): HTMLElement {
    const a = (label: string, href: string): HTMLAnchorElement =>
      el("a", { text: label, attrs: { href, download: "" } });
    return el("div", { class: "blk-export" }, [
      el("span", { text: `${this.labels.export}:` }),
      a("TXT", links.txt),
      a("MD", links.md),
      a("SRT", links.srt),
    ]);
  }

  // --- structure -----------------------------------------------------------------------------------

  private ordOf(sessionId: string): number {
    let o = this.sessionOrd.get(sessionId);
    if (o === undefined) {
      o = this.sessionOrd.size + 1;
      this.sessionOrd.set(sessionId, o);
    }
    return o;
  }

  private insert(item: Item): void {
    this.items.set(item.id, item);
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = this.order[mid];
      if (at && cmp(at.key, item.key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    const next = this.order[lo];
    this.list.insertBefore(item.node, next ? next.node : null);
    this.order.splice(lo, 0, item);
  }

  private schedule(): void {
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  /** Insert the pending blocks; FLIP the list so older blocks glide up and the new one slides in. */
  private flush(): void {
    const adds = this.pending;
    const ops = this.ops;
    this.pending = [];
    this.ops = [];
    if (adds.length === 0 && ops.length === 0) return;
    const ms = this.motionMs();
    const animate = ms > 0 && this.following;
    const before = animate ? this.list.getBoundingClientRect().top : 0;
    if (animate) {
      this.list.style.transition = "none";
      this.list.style.transform = "";
    }
    // Growing text first: a new line glides the list up exactly like a new block does.
    for (const op of ops) op();
    for (const it of adds) this.insert(it);
    if (!this.following) this.newCount += adds.filter((it) => it.block).length;
    this.afterChange();
    if (this.following) this.scrollToBottom();
    if (!animate) return;
    for (const it of adds) {
      it.node.classList.add("blk-enter");
      it.node.addEventListener("animationend", () => it.node.classList.remove("blk-enter"), {
        once: true,
      });
    }
    const delta = before - this.list.getBoundingClientRect().top;
    if (delta > 1) {
      // A new line glides in --cap-anim-duration; taller insertions (event cards) a bit longer.
      const dur = Math.round(Math.min(ms * 2.5, Math.max(ms, ms * Math.sqrt(delta / 120))));
      this.list.style.transform = `translateY(${delta.toFixed(1)}px)`;
      void this.list.offsetHeight;
      this.list.style.transition = `transform ${dur}ms cubic-bezier(0.3, 0.1, 0.2, 1)`;
      this.list.style.transform = "";
      this.flipUntil = performance.now() + dur + 40;
      if (this.flipTimer !== null) clearTimeout(this.flipTimer);
      this.flipTimer = setTimeout(() => {
        this.flipTimer = null;
        if (this.following) this.scrollToBottom();
      }, dur + 60);
    }
  }

  /** Newest highlight, follow-mode caps, top marker, pill. */
  private afterChange(): void {
    let last: Item | null = null;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const it = this.order[i];
      if (it?.block) {
        last = it;
        break;
      }
    }
    if (last !== this.newest) {
      this.newest?.node.classList.remove("is-new");
      last?.node.classList.add("is-new");
      this.newest = last;
    }
    if (!this.o.history) this.applyCaps();
    this.updateTop();
    this.updatePill();
  }

  private applyCaps(): void {
    const max = Math.max(1, this.o.maxBlocks || 60);
    for (const it of this.order.splice(0, Math.max(0, this.order.length - max))) {
      it.node.remove();
      this.items.delete(it.id);
    }
    const visible = this.o.visibleBlocks;
    let seen = 0;
    for (const it of [...this.order].reverse()) {
      if (it.block) seen++;
      it.node.classList.toggle("is-off", visible > 0 && seen > visible);
    }
  }

  private updateTop(): void {
    let text = "";
    if (this.o.history) {
      if (this.loadingOlder) text = this.labels.loading;
      else if (!this.hasMore && this.order.length > 0) text = this.labels.sessionStart;
    }
    this.top.textContent = text;
    this.top.hidden = text === "";
  }

  private updatePill(): void {
    const show = this.o.history && this.o.live && !this.following;
    this.pill.hidden = !show;
    if (show) {
      this.pill.textContent =
        this.newCount > 0 ? `↓ Live · ${this.newCount} ${this.labels.newItems}` : "↓ Live";
    }
  }

  private collapse(item: Item): void {
    item.hidden = true;
    // Hidden before it was even shown: just never insert it.
    const queued = this.pending.indexOf(item);
    if (queued >= 0) {
      this.pending.splice(queued, 1);
      return;
    }
    const idx = this.order.indexOf(item);
    if (idx >= 0) this.order.splice(idx, 1);
    const node = item.node;
    const ms = this.motionMs();
    if (ms === 0 || !node.isConnected) {
      node.remove();
      this.afterChange();
      return;
    }
    const gap = Number.parseFloat(getComputedStyle(this.list).rowGap) || 0;
    node.style.height = `${node.offsetHeight}px`;
    void node.offsetHeight;
    node.classList.add("is-collapsing");
    node.style.height = "0px";
    node.style.paddingTop = "0px";
    node.style.paddingBottom = "0px";
    node.style.marginBottom = `${-gap}px`;
    setTimeout(() => {
      node.remove();
      this.afterChange();
    }, ms + 50);
    this.afterChange();
  }

  /** Apply `mutate` and animate the block's height from old to new (event card ↔ compact). */
  private resize(item: Item, mutate: () => void): void {
    const node = item.node;
    const ms = this.motionMs();
    if (ms === 0 || !node.isConnected) {
      mutate();
      this.refit();
      return;
    }
    const h0 = node.offsetHeight;
    mutate();
    const h1 = node.offsetHeight;
    if (Math.abs(h1 - h0) < 1) return;
    node.style.height = `${h0}px`;
    void node.offsetHeight;
    node.classList.add("is-resizing");
    node.style.height = `${h1}px`;
    setTimeout(() => {
      node.classList.remove("is-resizing");
      node.style.height = "";
      this.refit();
    }, ms + 50);
  }

  // --- scrolling & history -------------------------------------------------------------------

  private scrollToBottom(): void {
    const s = this.scroller;
    s.scrollTop = s.scrollHeight;
    this.autoTop = s.scrollTop;
  }

  private onScroll(): void {
    // Follow mode (OBS / history=0) always follows; our own scrolls are not the reader's.
    if (!this.o.history) return;
    const s = this.scroller;
    if (Date.now() < this.jumpUntil) return;
    if (Math.abs(s.scrollTop - this.autoTop) < 2) return;
    this.autoTop = Number.NaN;
    const dist = s.scrollHeight - s.scrollTop - s.clientHeight;
    const follow = dist <= FOLLOW_SLACK_PX;
    if (follow !== this.following) {
      this.following = follow;
      if (follow) this.newCount = 0;
      this.updatePill();
    }
    if (
      this.o.history &&
      this.hasMore &&
      !this.loadingOlder &&
      s.scrollTop < LOAD_OLDER_PX &&
      Date.now() >= this.olderBackoffUntil
    ) {
      void this.loadOlder();
    }
  }

  private async loadOlder(): Promise<void> {
    const first = this.order.find((it) => it.block);
    if (!this.o.loadOlder || !first?.block) return;
    this.loadingOlder = true;
    this.updateTop();
    try {
      const page = await this.o.loadOlder(sessionOf(first.id), first.block.seq);
      if (page) {
        this.prepend(page.blocks);
        this.hasMore = page.hasMore && page.blocks.length > 0;
      } else {
        this.olderBackoffUntil = Date.now() + 5000;
      }
    } catch {
      this.olderBackoffUntil = Date.now() + 5000;
    } finally {
      this.loadingOlder = false;
      this.afterChange();
    }
  }

  /** Older blocks at the top without moving what the reader is looking at. */
  private prepend(blocks: readonly Block[]): void {
    const s = this.scroller;
    const oldHeight = s.scrollHeight;
    const oldTop = s.scrollTop;
    for (const b of blocks) {
      if (!this.items.has(b.id) && !b.hidden) this.insert(this.makeItem(b));
    }
    s.scrollTop = oldTop + (s.scrollHeight - oldHeight);
    this.autoTop = s.scrollTop;
  }

  // --- listening indicator -------------------------------------------------------------------

  private refreshListening(): void {
    this.listen?.classList.toggle("is-on", this.listenActive);
  }

  /** Animation duration from --cap-anim-duration; 0 with prefers-reduced-motion. */
  private motionMs(): number {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
    const raw = getComputedStyle(this.root).getPropertyValue("--cap-anim-duration").trim();
    const m = /^(-?[\d.]+)(ms|s)$/.exec(raw);
    if (!m?.[1]) return 200;
    const v = Number.parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1);
    return Number.isFinite(v) ? Math.max(0, Math.min(2000, v)) : 200;
  }
}

/** Parse a GET /api/sessions/:id/blocks response: `{blocks, hasMore}` or a bare array. */
export function parseBlocksPage(data: unknown): BlocksPage | null {
  const isBlock = (v: unknown): v is Block =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { seq?: unknown }).seq === "number" &&
    typeof (v as { kind?: unknown }).kind === "string";
  if (Array.isArray(data)) return { blocks: data.filter(isBlock), hasMore: data.length > 0 };
  if (typeof data !== "object" || data === null) return null;
  const d = data as { blocks?: unknown; hasMore?: unknown };
  if (!Array.isArray(d.blocks)) return null;
  return { blocks: d.blocks.filter(isBlock), hasMore: d.hasMore === true };
}
