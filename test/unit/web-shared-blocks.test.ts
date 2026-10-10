// @vitest-environment happy-dom
// The caption blocks renderer (web/shared/blocks.ts) in happy-dom: what a block, a Quran verse and
// a prayer-event card look like, how blocks arrive (next frame, FLIP glide), grow and change, are
// hidden, the listening dots and the end of a session, the follow-mode caps, and history mode
// (scrolling, the "↓ Live" pill, loading older blocks). Layout is faked where the view measures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../src/shared/protocol.js";
import {
  type BlocksPage,
  BlockView,
  type BlockViewOptions,
  formatRef,
  parseBlocksPage,
  quoted,
} from "../../web/shared/blocks.js";
import { clockTime } from "../../web/shared/i18n.js";
import { block, settle } from "./helpers/web-shared-fakes.js";

const OPTS: BlockViewOptions = {
  show: "target",
  quranAccent: true,
  quranArabic: true,
  partial: false,
  history: false,
  maxBlocks: 60,
  visibleBlocks: 0,
  pos: "bottom",
  bg: "panel",
  targetLang: "nl",
  sourceLang: "ar",
  live: true,
};

/** ResizeObserver whose callbacks the test fires by hand. */
class FakeResizeObserver {
  static callbacks: Array<() => void> = [];
  readonly observed: Element[] = [];
  constructor(cb: () => void) {
    FakeResizeObserver.callbacks.push(cb);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function resized(): void {
  for (const cb of FakeResizeObserver.callbacks) cb();
}

function make(over: Partial<BlockViewOptions> = {}): { v: BlockView; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const v = new BlockView(host, { ...OPTS, ...over });
  return { v, host };
}

function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`${sel} not found`);
  return node;
}

function frame(): void {
  vi.advanceTimersByTime(20);
}

/** The motion duration the view reads from --cap-anim-duration. */
function motion(v: BlockView, value: string): void {
  v.root.style.setProperty("--cap-anim-duration", value);
}

function articles(v: BlockView): HTMLElement[] {
  return [...v.root.querySelectorAll<HTMLElement>(".blk-list > .blk")];
}

function bodies(v: BlockView): string[] {
  return articles(v).map((a) => a.querySelector(".blk-body")?.textContent ?? "");
}

function list(v: BlockView): HTMLDivElement {
  return q<HTMLDivElement>(v.root, ".blk-list");
}

interface ScrollModel {
  el: HTMLDivElement;
  top: number;
  smooth: ScrollToOptions[];
  /** Extra content height (e.g. growing text) on top of 100 px per block. */
  extra: number;
}

/** Scroll geometry of the view's scroller: 100 px per block, a 300 px window. */
function fakeScroll(v: BlockView, client = 300): ScrollModel {
  const el = q<HTMLDivElement>(v.root, ".blk-scroll");
  const m: ScrollModel = { el, top: 0, smooth: [], extra: 0 };
  const height = (): number => el.querySelectorAll(".blk, .blk-end").length * 100 + m.extra;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => client });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => m.top,
    set: (y: number) => {
      m.top = Math.max(0, Math.min(y, height() - client));
    },
  });
  Object.defineProperty(el, "scrollTo", {
    configurable: true,
    value: (opts: ScrollToOptions) => {
      m.smooth.push(opts);
      el.scrollTop = opts.top ?? 0;
    },
  });
  return m;
}

/** The reader scrolls to `y`. */
function scrollTo(m: ScrollModel, y: number): void {
  m.el.scrollTop = y;
  m.el.dispatchEvent(new Event("scroll"));
}

function many(n: number, from = 1): Block[] {
  return Array.from({ length: n }, (_, i) => block(from + i));
}

function eventBlock(seq: number, ev: Partial<NonNullable<Block["event"]>> = {}): Block {
  return block(seq, {
    kind: "event",
    text: "",
    event: { type: "athan", active: true, startedAt: Date.UTC(2026, 9, 9, 12, 2), ...ev },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeResizeObserver.callbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("blocks: helpers", () => {
  it("writes verse ranges with an en dash", () => {
    expect(formatRef("2:285-286")).toBe("2:285–286");
    expect(formatRef("2:285 - 286")).toBe("2:285–286");
    expect(formatRef("49:13")).toBe("49:13");
  });

  it("quotes a verse unless the text brings its own quotes", () => {
    expect(quoted("  Allah is Kind ")).toBe('"Allah is Kind"');
    expect(quoted("“Allah is Kind”")).toBe("“Allah is Kind”");
    expect(quoted("«Allah»")).toBe("«Allah»");
  });

  it("parses a blocks page or a bare array, and refuses anything else", () => {
    const b = block(1);
    expect(parseBlocksPage({ blocks: [b, { id: 1 }, null], hasMore: true })).toEqual({
      blocks: [b],
      hasMore: true,
    });
    expect(parseBlocksPage({ blocks: [b], hasMore: "yes" })).toEqual({
      blocks: [b],
      hasMore: false,
    });
    expect(parseBlocksPage([b, { id: "x", seq: "1", kind: "speech" }])).toEqual({
      blocks: [b],
      hasMore: true,
    });
    expect(parseBlocksPage([])).toEqual({ blocks: [], hasMore: false });
    expect(parseBlocksPage({ blocks: "no" })).toBeNull();
    expect(parseBlocksPage(null)).toBeNull();
    expect(parseBlocksPage("text")).toBeNull();
  });
});

describe("blocks: the panel", () => {
  it("builds the panel with the position, background, show mode and listening dots", () => {
    const { v, host } = make({ pos: "top", bg: "none", show: "both", partial: true });
    expect(host.firstElementChild).toBe(v.root);
    expect(v.root.className).toBe("blk-root pos-top bg-none show-both quran-ar");
    const listen = q(v.root, ".blk-listen");
    expect(listen.title).toBe("Luistert…");
    expect(listen.classList.contains("with-partial")).toBe(true);
    expect(listen.querySelectorAll(".blk-dot")).toHaveLength(3);
    const partial = q(v.root, ".blk-partial");
    expect(partial.dir).toBe("rtl");
    expect(partial.lang).toBe("ar");
    expect(q<HTMLButtonElement>(v.root, ".blk-pill").hidden).toBe(true);
    expect(q(v.root, ".blk-top").hidden).toBe(true);
    expect(v.blockCount).toBe(0);
  });

  it("has no listening dots in the archive, and a history class in history mode", () => {
    const { v } = make({ live: false, history: true, quranArabic: false });
    expect(v.root.querySelector(".blk-listen")).toBeNull();
    expect(v.root.classList.contains("is-history")).toBe(true);
    expect(v.root.classList.contains("quran-ar")).toBe(false);
    // Listening messages are ignored without the indicator.
    v.listening(true, "…");
    expect(v.root.querySelector(".is-on")).toBeNull();
  });

  it("switches the show mode and the Quran Arabic toggle", () => {
    const { v } = make();
    v.setShow("source");
    expect(v.root.classList.contains("show-source")).toBe(true);
    expect(v.root.classList.contains("show-target")).toBe(false);
    v.setQuranArabic(false);
    expect(v.root.classList.contains("quran-ar")).toBe(false);
    v.setQuranArabic(true);
    expect(v.root.classList.contains("quran-ar")).toBe(true);
  });
});

describe("blocks: what a block looks like", () => {
  it("shows a speech block in the target language with its honorifics wrapped", () => {
    const { v } = make();
    v.snapshot([block(1, { text: "De Profeet ﷺ zei: wees geduldig. " })], false);
    const a = articles(v)[0];
    expect(a?.className).toBe("blk blk-speech is-new");
    expect(a?.lang).toBe("nl");
    expect(a?.dir).toBe("ltr");
    expect(a?.dataset.seq).toBe("1");
    expect(q(a as HTMLElement, ".blk-text").textContent).toBe("De Profeet ﷺ zei: wees geduldig.");
    expect(q(a as HTMLElement, ".cap-hon").lang).toBe("ar");
    expect(a?.querySelector(".blk-src")).toBeNull();
  });

  it("writes an Arabic target right to left", () => {
    const { v } = make({ targetLang: "ar" });
    v.snapshot([block(1, { text: "مرحبا", lang: "ar" })], false);
    expect(articles(v)[0]?.dir).toBe("rtl");
    expect(articles(v)[0]?.lang).toBe("ar");
  });

  it("quotes a Quran verse, adds the reference and the verse in Arabic, with the accent", () => {
    const { v } = make();
    v.snapshot(
      [
        block(1, {
          kind: "quran",
          text: " Allah belast niemand boven zijn vermogen. ",
          ref: "2:285-286",
          quranText: "لَا يُكَلِّفُ ٱللَّهُ نَفْسًا",
        }),
      ],
      false,
    );
    const a = articles(v)[0] as HTMLElement;
    expect(a.classList.contains("has-accent")).toBe(true);
    const ar = q(a, ".blk-quran-ar");
    expect(ar.textContent).toBe("لَا يُكَلِّفُ ٱللَّهُ نَفْسًا");
    expect(ar.dir).toBe("rtl");
    expect(q(a, ".blk-text").textContent).toBe(
      '"Allah belast niemand boven zijn vermogen." (2:285–286)',
    );
    expect(q(a, ".blk-body").textContent).toBe("Allah belast niemand boven zijn vermogen.");
  });

  it("leaves the quotes of a verse that brings its own, and the accent to the option", () => {
    const { v } = make({ quranAccent: false });
    v.snapshot([block(1, { kind: "quran", text: "“Wees geduldig.”" })], false);
    const a = articles(v)[0] as HTMLElement;
    expect(q(a, ".blk-text").textContent).toBe("“Wees geduldig.”");
    expect(a.classList.contains("has-accent")).toBe(false);
    expect(a.querySelector(".blk-quran-ar")).toBeNull();
  });

  it("gives a dua the accent", () => {
    const { v } = make();
    v.snapshot([block(1, { kind: "dua", text: "O Allah, vergeef ons." })], false);
    expect(articles(v)[0]?.classList.contains("has-accent")).toBe(true);
  });

  it("shows the source text in the source language, or with dir=auto for from=auto", () => {
    const fixed = make();
    fixed.v.snapshot([block(1, { src: "اصبروا" })], false);
    const src = q(fixed.v.root, ".blk-src");
    expect(src.textContent).toBe("اصبروا");
    expect(src.dir).toBe("rtl");
    expect(src.lang).toBe("ar");
    const auto = make({ sourceLang: "auto" });
    auto.v.snapshot([block(1, { src: "Be patient" })], false);
    const autoSrc = q(auto.v.root, ".blk-src");
    expect(autoSrc.dir).toBe("auto");
    expect(autoSrc.hasAttribute("lang")).toBe(false);
  });
});

describe("blocks: the snapshot", () => {
  it("shows the blocks in order, skips hidden ones and highlights the newest", () => {
    const { v } = make();
    v.snapshot([block(3), block(1), block(2, { hidden: true })], false);
    expect(bodies(v)).toEqual(["Block 1.", "Block 3."]);
    expect(articles(v).map((a) => a.classList.contains("is-new"))).toEqual([false, true]);
    expect(v.blockCount).toBe(2);
  });

  it("merges a resumed snapshot by id: shown blocks keep their DOM", () => {
    const { v } = make();
    v.snapshot([block(1), block(2)], false);
    const first = articles(v)[0];
    v.snapshot([block(1), block(2, { kind: "dua" }), block(3)], false);
    frame();
    expect(articles(v)[0]).toBe(first);
    expect(bodies(v)).toEqual(["Block 1.", "Block 2.", "Block 3."]);
    expect(articles(v)[1]?.classList.contains("blk-dua")).toBe(true);
  });

  it("keeps blocks of later sessions after the earlier session's", () => {
    const { v } = make();
    v.snapshot([block(1, {}, "s2")], false);
    v.snapshot([block(5, {}, "s1"), block(2, {}, "s2")], false);
    expect(bodies(v)).toEqual(["Block 1.", "Block 2.", "Block 5."]);
    // A block whose id carries no session sorts with the "" session.
    v.snapshot([{ ...block(9), id: "loose" }], false);
    expect(bodies(v).at(-1)).toBe("Block 9.");
  });

  it("takes hasMore from a snapshot that starts at the earliest block shown", () => {
    const { v } = make({ history: true });
    const top = q(v.root, ".blk-top");
    v.snapshot([block(5), block(6)], true);
    // More exists: no "Start of the session" marker.
    expect(top.hidden).toBe(true);
    // A resumed snapshot that starts later says nothing about older blocks.
    v.snapshot([block(6), block(7)], false);
    expect(top.hidden).toBe(true);
    v.snapshot([block(5)], false);
    expect(top.hidden).toBe(false);
    expect(top.textContent).toBe("Begin van de sessie");
  });

  it("takes hasMore from an empty snapshot", () => {
    const { v } = make({ history: true });
    v.snapshot([], false);
    // Nothing shown: no marker either.
    expect(q(v.root, ".blk-top").hidden).toBe(true);
  });
});

describe("blocks: adding blocks", () => {
  it("adds a block on the next frame, sliding in, and stops the listening dots", () => {
    const { v } = make();
    v.listening(true);
    const listen = q(v.root, ".blk-listen");
    expect(listen.classList.contains("is-on")).toBe(true);
    v.add(block(1));
    expect(listen.classList.contains("is-on")).toBe(false);
    expect(articles(v)).toHaveLength(0);
    frame();
    const a = articles(v)[0] as HTMLElement;
    expect(a.classList.contains("blk-enter")).toBe(true);
    a.dispatchEvent(new Event("animationend"));
    expect(a.classList.contains("blk-enter")).toBe(false);
    // Adding a shown block again only updates it; a hidden new block never shows.
    v.add(block(1, { text: "Block 1. More." }));
    v.add(block(2, { hidden: true }));
    frame();
    expect(bodies(v)).toEqual(["Block 1. More."]);
  });

  it("does nothing on an empty frame", () => {
    const { v } = make();
    v.add(block(1, { hidden: true }));
    frame();
    expect(articles(v)).toHaveLength(0);
  });

  it("glides the older blocks up (FLIP) and re-pins the bottom when the glide ends", () => {
    const { v } = make();
    const m = fakeScroll(v);
    v.snapshot(many(3), false);
    const l = list(v);
    vi.spyOn(l, "getBoundingClientRect")
      .mockReturnValueOnce(new DOMRect(0, 0, 100, 300))
      .mockReturnValueOnce(new DOMRect(0, -480, 100, 780));
    v.add(block(4));
    frame();
    // 480 px up: the glide takes 200 ms × √(480 / 120) = 400 ms.
    expect(l.style.transform).toBe("");
    expect(l.style.transition).toBe("transform 400ms cubic-bezier(0.3, 0.1, 0.2, 1)");
    expect(m.top).toBe(100);
    // While gliding, a resize does not pin (it would overshoot by the glide distance).
    m.extra = 50;
    resized();
    expect(m.top).toBe(100);
    vi.advanceTimersByTime(460);
    expect(m.top).toBe(150);
    // After the glide, resizes pin again.
    m.extra = 80;
    resized();
    expect(m.top).toBe(180);
  });

  it("restarts the glide timer when the next block comes during a glide", () => {
    const { v } = make();
    const m = fakeScroll(v);
    const l = list(v);
    vi.spyOn(l, "getBoundingClientRect")
      .mockReturnValueOnce(new DOMRect(0, 0, 100, 100))
      .mockReturnValueOnce(new DOMRect(0, -60, 100, 160))
      .mockReturnValueOnce(new DOMRect(0, 0, 100, 160))
      .mockReturnValueOnce(new DOMRect(0, -60, 100, 220));
    v.add(block(1));
    frame();
    // A short glide: at least the animation duration.
    expect(l.style.transition).toBe("transform 200ms cubic-bezier(0.3, 0.1, 0.2, 1)");
    v.add(block(2));
    frame();
    m.extra = 500;
    // The first glide's timer (at 276 ms) was replaced by the second one's (at 292 ms).
    vi.advanceTimersByTime(245);
    expect(m.top).toBe(0);
    vi.advanceTimersByTime(10);
    expect(m.top).toBe(400);
  });

  it("does not animate without motion", () => {
    const { v } = make();
    motion(v, "0ms");
    v.add(block(1));
    frame();
    expect(articles(v)[0]?.classList.contains("blk-enter")).toBe(false);
  });

  it("follows the newest block, also when the content grows (ResizeObserver)", () => {
    const { v } = make();
    const m = fakeScroll(v);
    v.snapshot(many(5), false);
    expect(m.top).toBe(200);
    m.extra = 40;
    resized();
    expect(m.top).toBe(240);
  });
});

describe("blocks: updates of shown blocks", () => {
  it("appends growing text as a fading span and unwraps it after the animation", () => {
    const { v } = make();
    v.snapshot([block(1, { text: "Broeders en zusters," })], false);
    const body = q(v.root, ".blk-body");
    const firstText = body.firstChild;
    v.update(block(1, { text: "Broeders en zusters, vandaag ﷺ" }));
    // Applied on the next frame, together with new blocks.
    expect(body.textContent).toBe("Broeders en zusters,");
    frame();
    expect(body.firstChild).toBe(firstText);
    const grow = q(body, ".blk-grow");
    expect(grow.textContent).toBe(" vandaag ﷺ");
    expect(grow.querySelector(".cap-hon")).not.toBeNull();
    grow.dispatchEvent(new Event("animationend"));
    expect(body.querySelector(".blk-grow")).toBeNull();
    expect(body.textContent).toBe("Broeders en zusters, vandaag ﷺ");
  });

  it("appends growing text at once without motion", () => {
    const { v } = make();
    motion(v, "0s");
    v.snapshot([block(1, { text: "Een" })], false);
    v.update(block(1, { text: "Een twee" }));
    frame();
    const body = q(v.root, ".blk-body");
    expect(body.querySelector(".blk-grow")).toBeNull();
    expect(body.textContent).toBe("Een twee");
  });

  it("replaces other text changes in place with a quick crossfade", () => {
    const { v } = make();
    v.snapshot([block(1, { text: "Het gebd begint." })], false);
    const body = q(v.root, ".blk-body");
    v.update(block(1, { text: "Het gebed begint." }));
    frame();
    expect(body.textContent).toBe("Het gebed begint.");
    expect(body.classList.contains("blk-swap")).toBe(true);
    expect(q(v.root, ".blk-body")).toBe(body);
  });

  it("changes the kind and the accent in place (speech → dua → speech)", () => {
    const { v } = make();
    v.snapshot([block(1)], false);
    const a = articles(v)[0] as HTMLElement;
    v.update(block(1, { kind: "dua" }));
    frame();
    expect(a.className).toContain("blk-dua");
    expect(a.classList.contains("blk-speech")).toBe(false);
    expect(a.classList.contains("has-accent")).toBe(true);
    v.update(block(1, { kind: "speech" }));
    frame();
    expect(a.classList.contains("has-accent")).toBe(false);
  });

  it("rebuilds once when a block becomes a quoted verse, with the option's accent", () => {
    const { v } = make({ quranAccent: false });
    v.snapshot([block(1, { text: "Allah zegt" })], false);
    v.update(block(1, { kind: "quran", text: "Allah zegt", ref: "2:1" }));
    frame();
    const a = articles(v)[0] as HTMLElement;
    expect(q(a, ".blk-text").textContent).toBe('"Allah zegt" (2:1)');
    expect(a.classList.contains("has-accent")).toBe(false);
  });

  it("adds, changes and removes the verse reference", () => {
    const { v } = make();
    v.snapshot([block(1, { kind: "quran", text: "Wees geduldig." })], false);
    const text = q(v.root, ".blk-text");
    v.update(block(1, { kind: "quran", text: "Wees geduldig.", ref: "2:153" }));
    frame();
    expect(text.textContent).toBe('"Wees geduldig." (2:153)');
    v.update(block(1, { kind: "quran", text: "Wees geduldig.", ref: "2:153-154" }));
    frame();
    expect(text.textContent).toBe('"Wees geduldig." (2:153–154)');
    // The same reference again changes nothing.
    v.update(block(1, { kind: "quran", text: "Wees geduldig. Echt.", ref: "2:153-154" }));
    frame();
    expect(text.textContent).toBe('"Wees geduldig. Echt." (2:153–154)');
    v.update(block(1, { kind: "quran", text: "Wees geduldig. Echt.", ref: null }));
    frame();
    expect(text.textContent).toBe('"Wees geduldig. Echt."');
    // No reference before or after.
    v.update(block(1, { kind: "quran", text: "Wees geduldig. Echt waar.", ref: null }));
    frame();
    expect(text.textContent).toBe('"Wees geduldig. Echt waar."');
  });

  it("adds, extends, replaces and removes the source text", () => {
    const { v } = make();
    v.snapshot([block(1)], false);
    const a = articles(v)[0] as HTMLElement;
    v.update(block(1, { src: "أيها" }));
    frame();
    const src = q(a, ".blk-src");
    expect(src.textContent).toBe("أيها");
    expect(src.lang).toBe("ar");
    const first = src.firstChild;
    v.update(block(1, { src: "أيها الإخوة" }));
    frame();
    expect(src.textContent).toBe("أيها الإخوة");
    expect(src.firstChild).toBe(first);
    v.update(block(1, { src: "يا أيها الإخوة" }));
    frame();
    expect(src.textContent).toBe("يا أيها الإخوة");
    v.update(block(1, { src: null }));
    frame();
    expect(a.querySelector(".blk-src")).toBeNull();
  });

  it("creates the source line with dir=auto for from=auto", () => {
    const { v } = make({ sourceLang: "auto" });
    v.snapshot([block(1)], false);
    v.update(block(1, { src: "Hello" }));
    frame();
    expect(q(v.root, ".blk-src").dir).toBe("auto");
  });

  it("adds the verse in Arabic late, and lets it grow", () => {
    const { v } = make();
    v.snapshot([block(1, { kind: "quran", text: "Allah is groot.", ref: "2:255" })], false);
    const a = articles(v)[0] as HTMLElement;
    v.update(block(1, { kind: "quran", text: "Allah is groot.", quranText: "ٱللَّهُ" }));
    frame();
    expect(a.firstElementChild?.className).toBe("blk-quran-ar");
    expect(q(a, ".blk-quran-ar").textContent).toBe("ٱللَّهُ");
    v.update(block(1, { kind: "quran", text: "Allah is groot.", quranText: "ٱللَّهُ لَآ إِلَـٰهَ" }));
    frame();
    expect(a.querySelectorAll(".blk-quran-ar")).toHaveLength(1);
    expect(q(a, ".blk-quran-ar").textContent).toBe("ٱللَّهُ لَآ إِلَـٰهَ");
  });

  it("renders the latest state of a block that is not on screen yet", () => {
    const { v } = make();
    v.add(block(1, { text: "Eerst" }));
    v.update(block(1, { text: "Eerst en daarna" }));
    v.add(eventBlock(2));
    v.update(eventBlock(2, { type: "iqama" }));
    frame();
    expect(bodies(v)[0]).toBe("Eerst en daarna");
    expect(q(articles(v)[1] as HTMLElement, ".ev-title").textContent).toBe("Iqama");
  });

  it("adds an unknown block on update, and ignores updates of a hidden one", () => {
    const { v } = make();
    v.update(block(1));
    v.update(block(2, { hidden: true }));
    frame();
    expect(bodies(v)).toEqual(["Block 1."]);
    motion(v, "0ms");
    v.update(block(1, { hidden: true }));
    v.update(block(1, { text: "Back?" }));
    frame();
    expect(articles(v)).toHaveLength(0);
  });

  it("ignores an update that names the end-of-session divider", () => {
    const { v } = make();
    v.snapshot([block(1)], false);
    v.ended(5_000, "s1");
    frame();
    v.update({ ...block(2), id: "end:s1" });
    frame();
    expect(v.blockCount).toBe(1);
  });
});

describe("blocks: hiding blocks", () => {
  it("collapses a hidden block smoothly and then removes it", () => {
    const { v } = make();
    v.snapshot(many(2), false);
    const l = list(v);
    l.style.rowGap = "12px";
    const second = articles(v)[1] as HTMLElement;
    v.update(block(2, { hidden: true }));
    expect(second.classList.contains("is-collapsing")).toBe(true);
    expect(second.style.height).toBe("0px");
    expect(second.style.paddingTop).toBe("0px");
    expect(second.style.marginBottom).toBe("-12px");
    // The previous block is the newest one at once.
    expect(articles(v)[0]?.classList.contains("is-new")).toBe(true);
    expect(v.blockCount).toBe(1);
    vi.advanceTimersByTime(260);
    expect(second.isConnected).toBe(false);
  });

  it("collapses without a gap when the list has none", () => {
    const { v } = make();
    v.snapshot(many(1), false);
    const a = articles(v)[0] as HTMLElement;
    v.update(block(1, { hidden: true }));
    expect(a.style.marginBottom).toBe("0px");
  });

  it("removes a hidden block at once with reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { v } = make();
    v.snapshot(many(2), false);
    v.update(block(2, { hidden: true }));
    expect(articles(v)).toHaveLength(1);
  });

  it("removes a hidden block at once when the view is not on the page", () => {
    const { v, host } = make();
    v.snapshot(many(2), false);
    host.remove();
    v.update(block(1, { hidden: true }));
    expect(bodies(v)).toEqual(["Block 2."]);
  });

  it("never shows a block hidden before its frame", () => {
    const { v } = make();
    v.add(block(1));
    v.update(block(1, { hidden: true }));
    frame();
    expect(articles(v)).toHaveLength(0);
  });
});

describe("blocks: prayer-event cards", () => {
  it("shows an active Athan card with the sound wave and the target-language labels", () => {
    const { v } = make();
    v.snapshot([eventBlock(1)], false);
    const a = articles(v)[0] as HTMLElement;
    expect(a.className).toBe("blk blk-event is-active is-new");
    expect(a.dataset.event).toBe("athan");
    expect(a.querySelectorAll(".ev-bar")).toHaveLength(5);
    expect(q(a, ".ev-ar").textContent).toBe("الأذان");
    expect(q(a, ".ev-title").textContent).toBe("Athan");
    expect(q(a, ".ev-sub").textContent).toBe("Oproep tot het gebed");
  });

  it("uses the labels the block brings, and no subtitle line for an empty one", () => {
    const { v } = make();
    v.snapshot(
      [eventBlock(1, { type: "salah", label: { ar: "الصلاة", title: "Gebed ﷺ", subtitle: "" } })],
      false,
    );
    const a = articles(v)[0] as HTMLElement;
    expect(q(a, ".ev-title").textContent).toBe("Gebed ﷺ");
    expect(a.querySelector(".ev-sub")).toBeNull();
  });

  it("shows an ended event as a compact line with its start time", () => {
    const { v } = make();
    const startedAt = Date.UTC(2026, 9, 9, 12, 2);
    v.snapshot([eventBlock(1, { active: false, startedAt })], false);
    const a = articles(v)[0] as HTMLElement;
    expect(a.classList.contains("is-ended")).toBe(true);
    expect(a.querySelector(".ev-card")).toBeNull();
    expect(q(a, ".ev-compact-ar").textContent).toBe("الأذان");
    expect(q(a, ".ev-compact").textContent).toBe(`الأذانAthan · ${clockTime(startedAt, "nl")}`);
  });

  it("shows an empty event block when the event data is missing", () => {
    const { v } = make();
    v.snapshot([block(1, { kind: "event", text: "" })], false);
    expect(articles(v)[0]?.childElementCount).toBe(0);
  });

  it("swaps Athan → Iqama in place with a crossfade, keeping the card", () => {
    const { v } = make();
    v.snapshot([eventBlock(1)], false);
    const a = articles(v)[0] as HTMLElement;
    const card = q(a, ".ev-card");
    v.update(eventBlock(1, { type: "iqama" }));
    expect(card.classList.contains("is-swapping")).toBe(true);
    expect(q(card, ".ev-title").textContent).toBe("Athan");
    vi.advanceTimersByTime(140);
    expect(card.classList.contains("is-swapping")).toBe(false);
    expect(q(a, ".ev-card")).toBe(card);
    expect(a.dataset.event).toBe("iqama");
    expect(q(card, ".ev-ar").textContent).toBe("الإقامة");
    expect(q(card, ".ev-title").textContent).toBe("Iqama");
    expect(q(card, ".ev-sub").textContent).toBe("Het gebed begint");
    // The same labels again: nothing to do.
    v.update(eventBlock(1, { type: "iqama" }));
    expect(card.classList.contains("is-swapping")).toBe(false);
  });

  it("swaps at once without motion, removing and adding the subtitle line", () => {
    const { v } = make();
    motion(v, "0ms");
    v.snapshot([eventBlock(1)], false);
    const card = q(v.root, ".ev-card");
    v.update(eventBlock(1, { type: "salah" }));
    expect(q(card, ".ev-title").textContent).toBe("Gebed");
    expect(card.querySelector(".ev-sub")).toBeNull();
    v.update(eventBlock(1, { type: "iqama" }));
    expect(q(card, ".ev-sub").textContent).toBe("Het gebed begint");
  });

  it("swaps a card whose Arabic title is missing", () => {
    const { v } = make();
    motion(v, "0ms");
    v.snapshot([eventBlock(1)], false);
    q(v.root, ".ev-ar").remove();
    v.update(eventBlock(1, { type: "iqama" }));
    expect(q(v.root, ".ev-title").textContent).toBe("Iqama");
  });

  it("relabels when only the labels change", () => {
    const { v } = make();
    motion(v, "0ms");
    v.snapshot([eventBlock(1)], false);
    v.update(eventBlock(1, { label: { ar: "الأذان", title: "Adhan", subtitle: "Call" } }));
    expect(q(v.root, ".ev-title").textContent).toBe("Adhan");
  });

  it("collapses an ended event to its compact line, animating the height", () => {
    const { v } = make();
    v.snapshot([eventBlock(1)], false);
    const a = articles(v)[0] as HTMLElement;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.querySelector(".ev-card") ? 120 : 40;
    });
    v.update(eventBlock(1, { active: false }));
    expect(a.classList.contains("is-resizing")).toBe(true);
    expect(a.style.height).toBe("40px");
    expect(a.querySelector(".ev-compact")).not.toBeNull();
    vi.advanceTimersByTime(250);
    expect(a.classList.contains("is-resizing")).toBe(false);
    expect(a.style.height).toBe("");
  });

  it("changes active ↔ ended without an animation when the height stays", () => {
    const { v } = make();
    v.snapshot([eventBlock(1, { active: false })], false);
    const a = articles(v)[0] as HTMLElement;
    v.update(eventBlock(1, { active: true }));
    expect(a.classList.contains("is-resizing")).toBe(false);
    expect(a.querySelector(".ev-card")).not.toBeNull();
    // Ended and relabelled at once.
    v.update(eventBlock(1, { active: false, type: "iqama" }));
    expect(q(a, ".ev-compact").textContent).toContain("Iqama");
  });

  it("turns a shown block into an event card and back", () => {
    const { v } = make();
    motion(v, "0ms");
    v.snapshot([block(1)], false);
    v.update(eventBlock(1));
    const a = articles(v)[0] as HTMLElement;
    expect(a.querySelector(".ev-card")).not.toBeNull();
    v.update(block(1, { kind: "speech", text: "Weer tekst.", event: undefined }));
    expect(q(a, ".blk-body").textContent).toBe("Weer tekst.");
  });

  it("draws the card when an event block gets its data late", () => {
    const { v } = make();
    motion(v, "0ms");
    v.snapshot([block(1, { kind: "event", text: "" })], false);
    v.update(eventBlock(1, { type: "iqama" }));
    expect(q(v.root, ".ev-title").textContent).toBe("Iqama");
  });

  it("leaves an ended event alone when nothing changed", () => {
    const { v } = make();
    v.snapshot([eventBlock(1, { active: false })], false);
    const compact = q(v.root, ".ev-compact");
    v.update(eventBlock(1, { active: false }));
    expect(q(v.root, ".ev-compact")).toBe(compact);
  });

  it("updates an event block that has no event data", () => {
    const { v } = make();
    v.snapshot([block(1, { kind: "event", text: "" })], false);
    v.update(block(1, { kind: "event", text: "" }));
    expect(articles(v)[0]?.childElementCount).toBe(0);
  });

  it("redraws the card when a queued text change had replaced it", () => {
    const { v } = make();
    motion(v, "0ms");
    v.snapshot([block(1, { text: "Een" })], false);
    // A text change waits for the next frame; the block becomes an event card meanwhile.
    v.update(block(1, { text: "Een twee" }));
    v.update(eventBlock(1));
    frame();
    const a = articles(v)[0] as HTMLElement;
    expect(a.querySelector(".ev-card")).toBeNull();
    v.update(eventBlock(1, { type: "iqama" }));
    expect(q(a, ".ev-title").textContent).toBe("Iqama");
  });
});

describe("blocks: listening and the end of a session", () => {
  it("shows the live Arabic partial next to the dots only with partial=1", () => {
    const on = make({ partial: true });
    on.v.listening(true, "واعلموا");
    expect(q(on.v.root, ".blk-partial").textContent).toBe("واعلموا");
    on.v.listening(true);
    expect(q(on.v.root, ".blk-partial").textContent).toBe("");
    on.v.listening(false, "x");
    expect(q(on.v.root, ".blk-partial").textContent).toBe("");
    expect(q(on.v.root, ".blk-listen").classList.contains("is-on")).toBe(false);
    const off = make({ partial: false });
    off.v.listening(true, "واعلموا");
    expect(q(off.v.root, ".blk-partial").textContent).toBe("");
    expect(q(off.v.root, ".blk-listen").classList.contains("is-on")).toBe(true);
  });

  it("ends a session with a divider and the time, once", () => {
    const { v } = make();
    v.snapshot([block(1), block(2)], false);
    v.listening(true);
    const endedAt = Date.UTC(2026, 9, 9, 12, 41);
    v.ended(endedAt, null);
    v.ended(endedAt, "s1");
    frame();
    const end = v.root.querySelectorAll(".blk-end");
    expect(end).toHaveLength(1);
    expect(end[0]?.textContent).toBe(`Sessie beëindigd · ${clockTime(endedAt, "nl")}`);
    expect(end[0]?.querySelector(".blk-export")).toBeNull();
    expect(q(v.root, ".blk-listen").classList.contains("is-on")).toBe(false);
    // The newest block stays highlighted, not the divider.
    expect(articles(v)[1]?.classList.contains("is-new")).toBe(true);
    // A block of a newer session comes after the divider.
    v.snapshot([block(1, {}, "s2")], false);
    expect(list(v).lastElementChild?.textContent).toBe("Block 1.");
  });

  it("offers the exports under the divider in history mode", () => {
    const exportLinks = vi.fn((sid: string) => ({
      txt: `/x/${sid}.txt`,
      md: `/x/${sid}.md`,
      srt: `/x/${sid}.srt`,
    }));
    const { v } = make({ history: true, exportLinks });
    v.snapshot([block(1)], false);
    v.ended(Date.UTC(2026, 9, 9, 12, 41), "s1");
    frame();
    const row = q(v.root, ".blk-export");
    expect(row.textContent).toBe("Exporteren:TXTMDSRT");
    const links = [...row.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/x/s1.txt",
      "/x/s1.md",
      "/x/s1.srt",
    ]);
    expect(links.every((a) => a.hasAttribute("download"))).toBe(true);
    expect(exportLinks).toHaveBeenCalledWith("s1");
  });

  it("has no export row without a session id or without exports", () => {
    const noSession = make({ history: true, exportLinks: () => ({ txt: "", md: "", srt: "" }) });
    noSession.v.ended(1, null);
    frame();
    expect(noSession.v.root.querySelector(".blk-export")).toBeNull();
    const none = make({ history: true, exportLinks: () => null });
    none.v.ended(1, "s1");
    frame();
    expect(none.v.root.querySelector(".blk-export")).toBeNull();
    const noOption = make({ history: true });
    noOption.v.ended(1, "s1");
    frame();
    expect(noOption.v.root.querySelector(".blk-export")).toBeNull();
  });
});

describe("blocks: follow mode", () => {
  it("keeps at most maxBlocks in the DOM, dropping the oldest", () => {
    const { v } = make({ maxBlocks: 3 });
    v.snapshot(many(5), false);
    expect(bodies(v)).toEqual(["Block 3.", "Block 4.", "Block 5."]);
    v.add(block(6));
    frame();
    expect(bodies(v)).toEqual(["Block 4.", "Block 5.", "Block 6."]);
    // The dropped blocks are forgotten: they could come back as new.
    v.add(block(3));
    frame();
    expect(bodies(v)).toEqual(["Block 4.", "Block 5.", "Block 6."]);
  });

  it("caps at 60 blocks when maxBlocks is 0", () => {
    const { v } = make({ maxBlocks: 0 });
    v.snapshot(many(62), false);
    expect(v.blockCount).toBe(60);
  });

  it("hides all but the newest visibleBlocks", () => {
    const { v } = make({ visibleBlocks: 2 });
    v.snapshot(many(4), false);
    v.ended(1, "s1");
    frame();
    const off = articles(v).map((a) => a.classList.contains("is-off"));
    expect(off).toEqual([true, true, false, false]);
    expect(q(v.root, ".blk-end").classList.contains("is-off")).toBe(false);
  });

  it("ignores scrolling: the newest block always shows", () => {
    const { v } = make();
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    scrollTo(m, 0);
    v.add(block(7));
    frame();
    expect(m.top).toBe(400);
    expect(q<HTMLButtonElement>(v.root, ".blk-pill").hidden).toBe(true);
  });
});

describe("blocks: history mode", () => {
  it("leaves follow mode when the reader scrolls up, counts new blocks, and rejoins", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    expect(m.top).toBe(300);
    const pill = q<HTMLButtonElement>(v.root, ".blk-pill");
    // Our own scroll to the bottom does not count as the reader scrolling.
    m.el.dispatchEvent(new Event("scroll"));
    expect(pill.hidden).toBe(true);
    scrollTo(m, 100);
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toBe("↓ Live");
    v.add(block(7));
    v.add(block(8));
    frame();
    expect(m.top).toBe(100);
    expect(pill.textContent).toBe("↓ Live · 2 nieuw");
    // Scrolling within 40 px of the bottom follows again.
    scrollTo(m, 480);
    expect(pill.hidden).toBe(true);
    v.add(block(9));
    frame();
    expect(m.top).toBe(600);
  });

  it("keeps the reader's place when a resumed snapshot arrives", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    scrollTo(m, 100);
    v.snapshot(many(8), false);
    expect(m.top).toBe(100);
  });

  it("does not pin when the reader scrolls up during a glide", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    vi.spyOn(list(v), "getBoundingClientRect")
      .mockReturnValueOnce(new DOMRect(0, 0, 100, 600))
      .mockReturnValueOnce(new DOMRect(0, -100, 100, 700));
    v.add(block(7));
    frame();
    expect(m.top).toBe(400);
    scrollTo(m, 100);
    vi.advanceTimersByTime(300);
    expect(m.top).toBe(100);
  });

  it("keeps following while scrolling within the bottom slack", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    scrollTo(m, 270);
    expect(q<HTMLButtonElement>(v.root, ".blk-pill").hidden).toBe(true);
  });

  it("jumps back to live smoothly over a short distance, ignoring the scrolls on the way", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    scrollTo(m, 100);
    const pill = q<HTMLButtonElement>(v.root, ".blk-pill");
    pill.click();
    expect(m.smooth).toEqual([{ top: 600, behavior: "smooth" }]);
    expect(pill.hidden).toBe(true);
    // An intermediate smooth-scroll event does not stop following.
    scrollTo(m, 150);
    expect(pill.hidden).toBe(true);
    vi.advanceTimersByTime(1_000);
    scrollTo(m, 100);
    expect(pill.hidden).toBe(false);
  });

  it("jumps back to live at once over a long distance or without motion", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(12), false);
    scrollTo(m, 0);
    v.jumpToLive();
    expect(m.smooth).toEqual([]);
    expect(m.top).toBe(900);
    motion(v, "0ms");
    scrollTo(m, 800);
    v.jumpToLive();
    expect(m.smooth).toEqual([]);
    expect(m.top).toBe(900);
  });

  it("scrolls to the top on request and stops following", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    v.scrollToTop();
    expect(m.top).toBe(0);
    expect(q<HTMLButtonElement>(v.root, ".blk-pill").hidden).toBe(false);
    v.add(block(7));
    frame();
    expect(m.top).toBe(0);
    // Re-fitting does not move the reader while not following.
    v.refit();
    expect(m.top).toBe(0);
  });

  it("shows no pill in the archive (not live)", () => {
    const { v } = make({ history: true, live: false });
    const m = fakeScroll(v);
    v.snapshot(many(6), false);
    scrollTo(m, 0);
    expect(q<HTMLButtonElement>(v.root, ".blk-pill").hidden).toBe(true);
  });
});

describe("blocks: loading older blocks", () => {
  function pageOf(blocks: Block[], hasMore: boolean): BlocksPage {
    return { blocks, hasMore };
  }

  it("loads older blocks near the top and keeps the reader's place", async () => {
    let resolve: (p: BlocksPage | null) => void = () => undefined;
    const loadOlder = vi.fn(
      () =>
        new Promise<BlocksPage | null>((r) => {
          resolve = r;
        }),
    );
    const { v } = make({ history: true, loadOlder });
    const m = fakeScroll(v);
    v.snapshot(many(6, 11), true);
    const top = q(v.root, ".blk-top");
    scrollTo(m, 200);
    expect(loadOlder).toHaveBeenCalledWith("s1", 11);
    expect(top.textContent).toBe("Laden…");
    expect(top.hidden).toBe(false);
    // No second request while one is running.
    scrollTo(m, 150);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    resolve(pageOf(many(3, 8), true));
    await settle();
    expect(bodies(v).slice(0, 4)).toEqual(["Block 8.", "Block 9.", "Block 10.", "Block 11."]);
    // Three blocks (300 px) above: the reader still sees the same block.
    expect(m.top).toBe(450);
    expect(top.hidden).toBe(true);
  });

  it("shows the start of the session when nothing older is left", async () => {
    const loadOlder = vi.fn(async () => pageOf([], true));
    const { v } = make({ history: true, loadOlder });
    const m = fakeScroll(v);
    v.snapshot(many(6, 11), true);
    scrollTo(m, 100);
    await settle();
    expect(q(v.root, ".blk-top").textContent).toBe("Begin van de sessie");
    scrollTo(m, 50);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("skips blocks it already has or that are hidden", async () => {
    const loadOlder = vi.fn(async () =>
      pageOf([block(9), block(10, { hidden: true }), block(11)], false),
    );
    const { v } = make({ history: true, loadOlder });
    const m = fakeScroll(v);
    v.snapshot(many(6, 11), true);
    scrollTo(m, 100);
    await settle();
    expect(bodies(v).slice(0, 2)).toEqual(["Block 9.", "Block 11."]);
  });

  it("backs off for 5 s after a failed or empty answer", async () => {
    const loadOlder = vi
      .fn<(sid: string, before: number) => Promise<BlocksPage | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(pageOf([], false));
    const { v } = make({ history: true, loadOlder });
    const m = fakeScroll(v);
    v.snapshot(many(6, 11), true);
    scrollTo(m, 100);
    await settle();
    expect(q(v.root, ".blk-top").hidden).toBe(true);
    scrollTo(m, 50);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    scrollTo(m, 100);
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(2);
    scrollTo(m, 50);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    scrollTo(m, 100);
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(3);
  });

  it("does not load while far from the top, without a loader or without blocks", () => {
    const loadOlder = vi.fn(async () => null);
    const far = make({ history: true, loadOlder });
    const m = fakeScroll(far.v);
    far.v.snapshot(many(8, 11), true);
    scrollTo(m, 300);
    expect(loadOlder).not.toHaveBeenCalled();
    const empty = make({ history: true, loadOlder });
    const e = fakeScroll(empty.v);
    empty.v.snapshot([], true);
    empty.v.ended(1, "s1");
    frame();
    e.extra = 1000;
    scrollTo(e, 100);
    scrollTo(e, 0);
    expect(loadOlder).not.toHaveBeenCalled();
    const without = make({ history: true });
    const w = fakeScroll(without.v);
    without.v.snapshot(many(6, 11), true);
    scrollTo(w, 100);
    expect(q(without.v.root, ".blk-top").hidden).toBe(true);
  });
});

describe("blocks: reset and fade", () => {
  it("drops everything on reset", () => {
    const { v } = make({ history: true });
    const m = fakeScroll(v);
    v.snapshot(many(6), true);
    scrollTo(m, 0);
    v.add(block(7));
    v.update(block(1, { text: "changed" }));
    v.listening(true);
    v.reset();
    frame();
    expect(articles(v)).toHaveLength(0);
    expect(v.blockCount).toBe(0);
    expect(q<HTMLButtonElement>(v.root, ".blk-pill").hidden).toBe(true);
    expect(q(v.root, ".blk-listen").classList.contains("is-on")).toBe(false);
    // The same blocks show again afterwards.
    v.snapshot(many(1), false);
    expect(bodies(v)).toEqual(["Block 1."]);
  });

  it("fades out, then resets (a screen switched off)", () => {
    const { v } = make();
    v.snapshot(many(2), false);
    v.listening(true);
    v.fadeAndReset();
    expect(v.root.classList.contains("is-clearing")).toBe(true);
    expect(q(v.root, ".blk-listen").classList.contains("is-on")).toBe(false);
    v.fadeAndReset();
    vi.advanceTimersByTime(449);
    expect(articles(v)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(articles(v)).toHaveLength(0);
    expect(v.root.classList.contains("is-clearing")).toBe(false);
  });

  it("stops a running fade on reset", () => {
    const { v } = make();
    v.snapshot(many(2), false);
    v.fadeAndReset();
    v.reset();
    v.snapshot(many(1), false);
    vi.advanceTimersByTime(500);
    expect(bodies(v)).toEqual(["Block 1."]);
  });

  it("resets at once with nothing shown or without motion", () => {
    const { v } = make();
    v.fadeAndReset();
    expect(v.root.classList.contains("is-clearing")).toBe(false);
    v.snapshot(many(1), false);
    motion(v, "0ms");
    v.fadeAndReset();
    expect(articles(v)).toHaveLength(0);
  });
});

describe("blocks: the animation duration", () => {
  /** Whether growing text gets its fading span (motion > 0) for a given duration value. */
  function animates(value: string | null): boolean {
    const { v } = make();
    if (value !== null) motion(v, value);
    v.snapshot([block(1, { text: "a" })], false);
    v.update(block(1, { text: "a b" }));
    frame();
    const animated = v.root.querySelector(".blk-grow") !== null;
    v.root.remove();
    return animated;
  }

  it("reads --cap-anim-duration in ms or s, clamped, with 200 ms as the default", () => {
    expect(animates(null)).toBe(true);
    expect(animates("150ms")).toBe(true);
    expect(animates("0.3s")).toBe(true);
    expect(animates("5s")).toBe(true);
    expect(animates("0ms")).toBe(false);
    expect(animates("-40ms")).toBe(false);
    expect(animates("fast")).toBe(true);
    expect(animates(".ms")).toBe(true);
  });

  it("swaps an event card with the clamped duration (5 s → 2 s)", () => {
    const { v } = make();
    motion(v, "5s");
    v.snapshot([eventBlock(1)], false);
    v.update(eventBlock(1, { type: "iqama" }));
    vi.advanceTimersByTime(1_399);
    expect(q(v.root, ".ev-title").textContent).toBe("Athan");
    vi.advanceTimersByTime(1);
    expect(q(v.root, ".ev-title").textContent).toBe("Iqama");
  });

  it("has no motion with prefers-reduced-motion, and some without matchMedia", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(animates(null)).toBe(false);
    vi.restoreAllMocks();
    vi.stubGlobal("matchMedia", undefined);
    expect(animates(null)).toBe(true);
  });
});
