// @vitest-environment happy-dom
// The roll-up renderer (web/shared/rollup.ts) in happy-dom: the line geometry, the split into
// committed and partial text, what the DOM shows after a frame (blocks, chunks, the one partial
// span, directions), the watermark of `clear` and the idle fade, the anti-bounce padding and the
// trimming of old text, with a fake layout (lines of a fixed number of characters).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Segment } from "../../src/shared/protocol.js";
import type { DisplayParams } from "../../web/shared/params.js";
import {
  ARABIC_FONT,
  type BlockSpec,
  blockGeometry,
  LATIN_FONT,
  loadFonts,
  RollupView,
  splitText,
} from "../../web/shared/rollup.js";
import { segment, settle, text } from "./helpers/web-shared-fakes.js";

const PARAMS: DisplayParams = {
  lines: 2,
  size: 40,
  srcScale: null,
  lineHeight: null,
  pos: "bottom",
  width: 90,
  bg: "band",
  partial: true,
  idle: 0,
  debug: false,
};
/** Line height of a Latin block at size 40 (40 × 1.3). */
const LH = 52;
const NL: BlockSpec[] = [{ role: "translation", lang: "nl" }];

async function view(
  specs: readonly BlockSpec[] = NL,
  over: Partial<DisplayParams> = {},
): Promise<RollupView> {
  const host = document.createElement("div");
  document.body.append(host);
  const v = new RollupView(host, { ...PARAMS, ...over });
  v.setBlocks(specs);
  await v.ready;
  return v;
}

/** Show `segs` and run the animation frame that renders them. */
function show(v: RollupView, segs: readonly Segment[]): void {
  v.update(segs);
  vi.advanceTimersByTime(20);
}

function nl(seq: number, t: string, finalLen = t.length, opts = {}): Segment {
  return segment(seq, text(`src ${seq}`), { nl: text(t, finalLen) }, opts);
}

function blockEl(v: RollupView, i = 0): HTMLDivElement {
  const b = v.root.querySelectorAll<HTMLDivElement>(".cap-block")[i];
  if (!b) throw new Error(`no block ${i}`);
  return b;
}

function textEl(v: RollupView, i = 0): HTMLDivElement {
  const t = blockEl(v, i).querySelector<HTMLDivElement>(".cap-text");
  if (!t) throw new Error("no .cap-text");
  return t;
}

function spans(v: RollupView, i = 0): HTMLSpanElement[] {
  return [...textEl(v, i).querySelectorAll<HTMLSpanElement>(".cap-seg")];
}

function partialOf(v: RollupView, i = 0): HTMLSpanElement | null {
  return textEl(v, i).querySelector<HTMLSpanElement>(".cap-partial");
}

// --- fake layout ------------------------------------------------------------------------------------

/** Characters per line of the fake layout; text height follows the text length. */
let cpl = 1000;
/** Characters without a box (collapsed spaces), by their index in the block's text. */
let boxless: (index: number) => boolean = () => false;

function lineHeightOf(node: HTMLElement): number {
  return Number.parseFloat(node.style.lineHeight) || LH;
}

function contentHeight(node: HTMLElement): number {
  const chars = (node.textContent ?? "").length;
  return Math.ceil(chars / cpl) * lineHeightOf(node);
}

function charIndex(container: Node, offset: number): number {
  const root = container.parentElement?.closest(".cap-text");
  if (!root) return -1;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let index = 0;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n === container) return index + offset;
    index += (n as Text).data.length;
  }
  return -1;
}

function fakeLayout(): void {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.classList.contains("cap-text")) return 0;
    const pad = Number.parseFloat(this.style.paddingBottom) || 0;
    return contentHeight(this) + pad;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, 1000, this.offsetHeight);
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const i = charIndex(this.startContainer, this.startOffset);
    const lh = LH;
    if (boxless(i)) return [] as unknown as DOMRectList;
    return [new DOMRect(0, Math.floor(i / cpl) * lh, 10, lh)] as unknown as DOMRectList;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  cpl = 1000;
  boxless = () => false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fonts");
  document.body.replaceChildren();
});

// --- pure parts ------------------------------------------------------------------------------------

describe("rollup: line geometry", () => {
  const p = { size: 40, srcScale: null, lineHeight: null };

  it("gives a Latin translation line the theme's line height (1.3 by default)", () => {
    expect(blockGeometry({ role: "translation", lang: "nl" }, p)).toEqual({
      fontPx: 40,
      lineHeightPx: 52,
      arabic: false,
      family: LATIN_FONT,
    });
    expect(blockGeometry({ role: "translation", lang: "nl" }, { ...p, lineHeight: 1.5 })).toEqual(
      expect.objectContaining({ lineHeightPx: 60 }),
    );
    // A line height below 0.8 would overlap the lines: ignored.
    expect(blockGeometry({ role: "translation", lang: "nl" }, { ...p, lineHeight: 0.5 })).toEqual(
      expect.objectContaining({ lineHeightPx: 52 }),
    );
  });

  it("gives Arabic-script lines room for tashkeel (1.55) and the Naskh font", () => {
    expect(blockGeometry({ role: "translation", lang: "ur" }, p)).toEqual({
      fontPx: 40,
      lineHeightPx: 62,
      arabic: true,
      family: ARABIC_FONT,
    });
  });

  it("scales an Arabic source by 1.15 unless srcScale says otherwise", () => {
    expect(blockGeometry({ role: "source", lang: "ar" }, p)).toEqual({
      fontPx: 46,
      lineHeightPx: 71,
      arabic: true,
      family: ARABIC_FONT,
    });
    expect(blockGeometry({ role: "source", lang: "ar" }, { ...p, srcScale: 0.5 })).toEqual(
      expect.objectContaining({ fontPx: 20, lineHeightPx: 31 }),
    );
    // Never below 6 px.
    expect(
      blockGeometry({ role: "source", lang: "en" }, { size: 8, srcScale: 0.3, lineHeight: null })
        .fontPx,
    ).toBe(6);
  });

  it("keeps a Latin source at scale 1, and an auto source tall (it may well be Arabic)", () => {
    expect(blockGeometry({ role: "source", lang: "en" }, p)).toEqual({
      fontPx: 40,
      lineHeightPx: 52,
      arabic: false,
      family: LATIN_FONT,
    });
    expect(blockGeometry({ role: "source", lang: "auto" }, p)).toEqual({
      fontPx: 40,
      lineHeightPx: 62,
      arabic: false,
      family: LATIN_FONT,
    });
  });
});

describe("rollup: committed and partial text", () => {
  it("commits all of a final text from the offset on", () => {
    expect(splitText(text("Hello world."), 0, false)).toEqual({ commit: "Hello world.", rest: "" });
    expect(splitText(text("Hello world."), 6, false)).toEqual({ commit: "world.", rest: "" });
    expect(splitText(text("Hi"), -3, false)).toEqual({ commit: "Hi", rest: "" });
    expect(splitText(text("Hi"), 10, false)).toEqual({ commit: "", rest: "" });
  });

  it("snaps the stable part of an open segment back to the last space", () => {
    // "Hello wor" is final but "wor" is half a word: it stays with the partial.
    expect(splitText(text("Hello world again", 9), 0, false)).toEqual({
      commit: "Hello ",
      rest: "world again",
    });
    expect(splitText(text("Hello big\tworld", 13), 0, false)).toEqual({
      commit: "Hello big\t",
      rest: "world",
    });
    // No space yet: nothing is committed.
    expect(splitText(text("Hello", 3), 0, false)).toEqual({ commit: "", rest: "Hello" });
  });

  it("commits the whole stable part in scripts without spaces", () => {
    expect(splitText(text("你好世界", 2), 0, true)).toEqual({ commit: "你好", rest: "世界" });
  });

  it("never lets finalLen point outside the text", () => {
    expect(splitText({ text: "ab cd", finalLen: 99, final: false }, 0, false)).toEqual({
      commit: "ab ",
      rest: "cd",
    });
    expect(splitText({ text: "ab cd", finalLen: 1, final: false }, 3, false)).toEqual({
      commit: "",
      rest: "cd",
    });
  });
});

// --- the view ---------------------------------------------------------------------------------------

describe("rollup: the blocks", () => {
  it("lays out one block per spec with the position, background and direction", async () => {
    const v = await view(
      [
        { role: "source", lang: "ar" },
        { role: "translation", lang: "nl" },
      ],
      { pos: "top", bg: "shadow" },
    );
    expect(v.root.className).toBe("cap-root pos-top bg-shadow");
    expect(v.blockSpecs).toEqual([
      { role: "source", lang: "ar" },
      { role: "translation", lang: "nl" },
    ]);
    const src = blockEl(v, 0);
    expect(src.className).toBe("cap-block cap-source is-empty");
    expect(src.lang).toBe("ar");
    expect(src.dir).toBe("rtl");
    expect(textEl(v, 0).className).toBe("cap-text is-arabic");
    expect(textEl(v, 0).style.fontSize).toBe("46px");
    expect(textEl(v, 0).style.lineHeight).toBe("71px");
    const win = src.querySelector<HTMLDivElement>(".cap-window");
    expect(win?.style.height).toBe("142px");
    expect(win?.style.paddingBottom).toBe("14px");
    const tr = blockEl(v, 1);
    expect(tr.className).toBe("cap-block cap-translation is-empty");
    expect(tr.lang).toBe("nl");
    expect(tr.dir).toBe("ltr");
    expect(textEl(v, 1).className).toBe("cap-text");
  });

  it("keeps the DOM when the same blocks are set again, and rebuilds on a change", async () => {
    const v = await view();
    const first = blockEl(v);
    v.setBlocks([{ role: "translation", lang: "nl" }]);
    expect(blockEl(v)).toBe(first);
    v.setBlocks([{ role: "translation", lang: "de" }]);
    expect(blockEl(v)).not.toBe(first);
    expect(blockEl(v).lang).toBe("de");
  });

  it("marks debug pages and numbers the segment spans", async () => {
    const v = await view(NL, { debug: true });
    expect(v.root.classList.contains("is-debug")).toBe(true);
    show(v, [nl(4, "Four.")]);
    expect(spans(v)[0]?.dataset.seq).toBe("4");
  });

  it("renders nothing before the fonts are loaded, then the latest state", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let resolveFont: () => void = () => undefined;
    const fontsLoaded = new Promise<void>((r) => {
      resolveFont = r;
    });
    const load = vi.fn(() => fontsLoaded);
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    try {
      const v = new RollupView(host, PARAMS);
      v.setBlocks(NL);
      v.update([nl(1, "Early.")]);
      vi.advanceTimersByTime(20);
      expect(textEl(v).textContent).toBe("");
      expect(load).toHaveBeenCalledTimes(3);
      resolveFont();
      await v.ready;
      vi.advanceTimersByTime(20);
      expect(textEl(v).textContent).toBe(" Early.");
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });
});

describe("rollup: final text and the partial", () => {
  it("shows final text as fading chunks and drops the chunk wrapper after its animation", async () => {
    const v = await view();
    show(v, [nl(1, "Hello world.")]);
    const seg = spans(v)[0];
    expect(seg?.textContent).toBe(" Hello world.");
    const chunk = seg?.querySelector<HTMLSpanElement>(".cap-chunk-p");
    expect(chunk?.textContent).toBe("Hello world.");
    expect(blockEl(v).classList.contains("is-empty")).toBe(false);
    chunk?.dispatchEvent(new Event("animationend"));
    expect(seg?.querySelector(".cap-chunk-p")).toBeNull();
    expect(seg?.textContent).toBe(" Hello world.");
    // A chunk that was already removed has nothing to unwrap.
    show(v, [nl(1, "Hello world. More.")]);
    const more = seg?.querySelector<HTMLSpanElement>(".cap-chunk-p");
    more?.remove();
    more?.dispatchEvent(new Event("animationend"));
    expect(seg?.textContent).toBe(" Hello world.");
  });

  it("uses plain chunks when partials are off, and shows only the snapped stable text", async () => {
    const v = await view(NL, { partial: false });
    show(v, [segment(1, text("x"), { nl: text("Hello wor", 9, false) })]);
    expect(spans(v)[0]?.textContent).toBe(" Hello ");
    expect(spans(v)[0]?.querySelector(".cap-chunk")).not.toBeNull();
    expect(partialOf(v)).toBeNull();
  });

  it("puts the one partial span in the first open segment, dimmed text after the stable words", async () => {
    const v = await view();
    show(v, [nl(1, "One two thr", 8), nl(2, "Later text", 0)]);
    const [one, two] = spans(v);
    expect(one?.textContent).toBe(" One two thr");
    expect(one?.lastElementChild?.className).toBe("cap-partial");
    expect(partialOf(v)?.textContent).toBe("thr");
    // The second open segment has nothing stable and no partial of its own: no span at all.
    expect(two).toBeUndefined();
    expect(textEl(v).querySelectorAll(".cap-partial")).toHaveLength(1);

    // The first segment ends: the partial moves on to the next open segment.
    show(v, [nl(1, "One two three."), nl(2, "Later text", 6)]);
    const all = spans(v);
    expect(all).toHaveLength(2);
    expect(all[0]?.textContent).toBe(" One two three.");
    expect(all[1]?.textContent).toBe(" Later text");
    expect(all[1]?.lastElementChild?.textContent).toBe("text");

    // Everything final: the partial goes away.
    show(v, [nl(1, "One two three."), nl(2, "Later text.")]);
    expect(partialOf(v)).toBeNull();
    expect(textEl(v).textContent).toBe(" One two three. Later text.");
  });

  it("keeps a block empty while only whitespace is open", async () => {
    const v = await view();
    show(v, [nl(1, "   ", 0)]);
    expect(spans(v)).toHaveLength(0);
    expect(blockEl(v).classList.contains("is-empty")).toBe(true);
  });

  it("shows a partial-only segment, and empties the block again when it disappears", async () => {
    const v = await view();
    show(v, [nl(1, "Hmm", 0)]);
    expect(spans(v)[0]?.textContent).toBe(" Hmm");
    expect(blockEl(v).classList.contains("is-empty")).toBe(false);
    show(v, [nl(1, "", 0)]);
    expect(partialOf(v)).toBeNull();
    expect(blockEl(v).classList.contains("is-empty")).toBe(true);
  });

  it("rebuilds a segment whose committed text changed in the middle, keeping its partial", async () => {
    const v = await view();
    show(v, [nl(1, "Hello wrld again", 11)]);
    expect(spans(v)[0]?.textContent).toBe(" Hello wrld again");
    show(v, [nl(1, "Hello world again", 12)]);
    const seg = spans(v)[0];
    expect(seg?.textContent).toBe(" Hello world again");
    expect(seg?.querySelector(".cap-chunk-p")).toBeNull();
    expect(seg?.lastElementChild).toBe(partialOf(v));
    // A final rewrite of a segment without a partial.
    show(v, [nl(1, "Hello, world.")]);
    expect(spans(v)[0]?.textContent).toBe(" Hello, world.");
  });

  it("does not snap scripts without spaces", async () => {
    const v = await view([{ role: "translation", lang: "zh" }]);
    show(v, [segment(1, text("x"), { zh: text("你好世界", 2) })]);
    expect(spans(v)[0]?.textContent).toBe(" 你好世界");
    expect(partialOf(v)?.textContent).toBe("世界");
  });

  it("skips segments without this block's language", async () => {
    const v = await view();
    show(v, [segment(1, text("src"), { de: text("Hallo.") })]);
    expect(spans(v)).toHaveLength(0);
  });

  it("wraps honorific ligatures for styling, in committed and partial text", async () => {
    const v = await view();
    show(v, [nl(1, "De Profeet ﷺ zei ﷺ", 17)]);
    const hon = textEl(v).querySelectorAll<HTMLSpanElement>(".cap-hon");
    expect(hon).toHaveLength(2);
    expect(hon[0]?.lang).toBe("ar");
    expect(hon[0]?.textContent).toBe("ﷺ");
    expect(partialOf(v)?.querySelector(".cap-hon")).not.toBeNull();
  });

  it("places a segment that gets text late before the later segments", async () => {
    const v = await view();
    const s1 = segment(1, text("a"), {});
    show(v, [s1, nl(2, "Second.")]);
    show(v, [nl(1, "First."), nl(2, "Second.")]);
    expect(spans(v).map((s) => s.textContent)).toEqual([" First.", " Second."]);
  });
});

describe("rollup: the source block", () => {
  it("renders the source text of each segment", async () => {
    const v = await view([{ role: "source", lang: "ar" }]);
    show(v, [segment(1, text("بسم الله"), {})]);
    expect(textEl(v).textContent).toBe(" بسم الله");
  });

  it("follows the detected language with from=auto, per segment and for the paragraph", async () => {
    const v = await view([{ role: "source", lang: "auto" }]);
    const b = blockEl(v);
    expect(b.dir).toBe("auto");
    expect(b.hasAttribute("lang")).toBe(false);
    show(v, [segment(1, text("مرحبا"), {}, { lang: "ar" })]);
    const ar = spans(v)[0];
    expect(ar?.lang).toBe("ar");
    expect(ar?.dir).toBe("rtl");
    expect(ar?.classList.contains("cap-arabic")).toBe(true);
    expect(b.dir).toBe("rtl");
    show(v, [
      segment(1, text("مرحبا"), {}, { lang: "ar" }),
      segment(2, text("Hi."), {}, { lang: "en" }),
    ]);
    const en = spans(v)[1];
    expect(en?.lang).toBe("en");
    expect(en?.dir).toBe("ltr");
    expect(en?.classList.contains("cap-arabic")).toBe(false);
    expect(b.dir).toBe("ltr");
    // The same direction again: nothing to change.
    show(v, [
      segment(1, text("مرحبا"), {}, { lang: "ar" }),
      segment(2, text("Hi there."), {}, { lang: "en" }),
    ]);
    expect(b.dir).toBe("ltr");
  });

  it("leaves an auto block's direction alone while no language is known", async () => {
    const v = await view([{ role: "source", lang: "auto" }]);
    show(v, [segment(1, text("…"), {}, { lang: "" })]);
    expect(spans(v)[0]?.hasAttribute("lang")).toBe(false);
    expect(blockEl(v).dir).toBe("auto");
  });
});

describe("rollup: clear, reset and the idle fade", () => {
  it("wipes on clear, and wiped text never comes back; newer text continues after the mark", async () => {
    const v = await view();
    const segs = [nl(1, "Hello world."), nl(2, "Second part", 0)];
    show(v, segs);
    expect(textEl(v).textContent).toBe(" Hello world. Second part");
    v.clear();
    expect(textEl(v).textContent).toBe("");
    expect(blockEl(v).classList.contains("is-empty")).toBe(true);
    show(v, segs);
    expect(textEl(v).textContent).toBe("");
    // The open segment grows: only what came after the wipe shows.
    show(v, [nl(1, "Hello world."), nl(2, "Second part continues", 12)]);
    expect(textEl(v).textContent).toBe("  continues");
    show(v, [nl(1, "Hello world."), nl(2, "Second part continues."), nl(3, "Third.")]);
    expect(textEl(v).textContent).toBe("  continues. Third.");
  });

  it("keeps the furthest mark per session over repeated wipes", async () => {
    const v = await view();
    show(v, [nl(1, "One."), nl(2, "Two.")]);
    v.clear();
    // Nothing shown, nothing to mark: the earlier mark stays.
    v.clear();
    show(v, [nl(1, "One."), nl(2, "Two."), nl(3, "Three.")]);
    expect(textEl(v).textContent).toBe(" Three.");
    // A segment of another session is not affected by this session's mark.
    show(v, [nl(1, "One."), nl(1, "Other.", undefined, { session: "s2" })]);
    expect(textEl(v).textContent).toBe(" Three. Other.");
  });

  it("re-marks a segment that grew after an earlier wipe", async () => {
    const v = await view();
    show(v, [nl(1, "One two", 4)]);
    v.clear();
    // The wiped partial ("two") is gone too: only what came after the wipe shows.
    show(v, [nl(1, "One two three", 8)]);
    expect(textEl(v).textContent).toBe("  three");
    v.clear();
    show(v, [nl(1, "One two three four.")]);
    expect(textEl(v).textContent).toBe("  four.");
  });

  it("shows everything again after a reset (no watermark)", async () => {
    const v = await view();
    const segs = [nl(1, "Hello.")];
    show(v, segs);
    v.clear();
    v.reset();
    show(v, segs);
    expect(textEl(v).textContent).toBe(" Hello.");
  });

  it("fades out after `idle` seconds without updates, then wipes", async () => {
    const v = await view(NL, { idle: 5 });
    show(v, [nl(1, "Hello.")]);
    vi.advanceTimersByTime(4_900);
    expect(v.root.classList.contains("is-fading")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(v.root.classList.contains("is-fading")).toBe(true);
    expect(textEl(v).textContent).toBe(" Hello.");
    vi.advanceTimersByTime(400);
    expect(v.root.classList.contains("is-fading")).toBe(false);
    expect(textEl(v).textContent).toBe("");
    // The faded text stays away.
    show(v, [nl(1, "Hello.")]);
    expect(textEl(v).textContent).toBe("");
  });

  it("restarts the idle timer on new text and cancels a running fade", async () => {
    const v = await view(NL, { idle: 2 });
    show(v, [nl(1, "One.")]);
    vi.advanceTimersByTime(1_500);
    show(v, [nl(1, "One."), nl(2, "Two.")]);
    vi.advanceTimersByTime(1_500);
    expect(v.root.classList.contains("is-fading")).toBe(false);
    vi.advanceTimersByTime(600);
    expect(v.root.classList.contains("is-fading")).toBe(true);
    show(v, [nl(1, "One."), nl(2, "Two."), nl(3, "Three.")]);
    expect(v.root.classList.contains("is-fading")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(textEl(v).textContent).toBe(" One. Two. Three.");
  });

  it("never fades with idle=0", async () => {
    const v = await view(NL, { idle: 0 });
    show(v, [nl(1, "Stay.")]);
    vi.advanceTimersByTime(3_600_000);
    expect(textEl(v).textContent).toBe(" Stay.");
  });

  it("fades away on request (a screen switched off), once", async () => {
    const v = await view(NL, { idle: 30 });
    show(v, [nl(1, "Bye.")]);
    v.fadeAway();
    expect(v.root.classList.contains("is-fading")).toBe(true);
    vi.advanceTimersByTime(300);
    v.fadeAway();
    vi.advanceTimersByTime(100);
    expect(textEl(v).textContent).toBe("");
    expect(v.root.classList.contains("is-fading")).toBe(false);
    // The idle timer was stopped: nothing fades again later.
    vi.advanceTimersByTime(60_000);
    expect(v.root.classList.contains("is-fading")).toBe(false);
  });

  it("stops a fade when cleared or reset", async () => {
    const v = await view();
    show(v, [nl(1, "Bye.")]);
    v.fadeAway();
    v.clear();
    expect(v.root.classList.contains("is-fading")).toBe(false);
    v.fadeAway();
    v.reset();
    expect(v.root.classList.contains("is-fading")).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(v.root.classList.contains("is-fading")).toBe(false);
  });

  it("fades away with no idle timer running", async () => {
    const v = await view();
    v.fadeAway();
    expect(v.root.classList.contains("is-fading")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(v.root.classList.contains("is-fading")).toBe(false);
  });
});

describe("rollup: the anti-bounce padding", () => {
  it("keeps the line count until the next commit when the partial shrinks", async () => {
    fakeLayout();
    cpl = 10;
    const v = await view();
    const t = textEl(v);
    // " one two " + "three four five six": 28 characters = 3 lines.
    show(v, [nl(1, "one two three four five six", 8)]);
    expect(t.style.paddingBottom).toBe("");
    // The partial shrinks to one line less: padding keeps the third line.
    show(v, [nl(1, "one two three", 8)]);
    expect(t.style.paddingBottom).toBe(`${LH}px`);
    // A commit lets the text settle at its natural height.
    show(v, [nl(1, "one two three ok", 14)]);
    expect(t.style.paddingBottom).toBe("");
  });
});

describe("rollup: trimming old text", () => {
  const long = (n: number, ch: string): string => ch.repeat(n);

  it("drops text far above the window without moving the visible lines", async () => {
    fakeLayout();
    cpl = 100;
    const v = await view();
    // Two segments of 1,000 characters each (with the leading space): 20 lines.
    const segs = [nl(1, long(999, "a")), nl(2, long(999, "b"))];
    show(v, segs);
    // Window bottom 1040, visible from 936, cut 2 lines above that: from character 1,600 on.
    const all = spans(v);
    expect(all).toHaveLength(1);
    expect(all[0]?.textContent).toBe("b".repeat(400));
    expect(textEl(v).textContent?.length).toBe(400);
    // The trimmed segment keeps growing by appending; the dropped one never comes back.
    show(v, [segs[0] as Segment, nl(2, `${long(999, "b")} more.`)]);
    expect(textEl(v).textContent).toBe(`${"b".repeat(400)} more.`);
    // A fix-up in the middle of a trimmed segment is not rebuilt (its start is gone).
    show(v, [segs[0] as Segment, nl(2, `${long(998, "b")}c more.`)]);
    expect(textEl(v).textContent).toBe(`${"b".repeat(400)} more.`);
    // The dropped segment leaves the state: its tombstone goes too, nothing re-renders.
    show(v, [nl(2, `${long(998, "b")}c more.`), nl(3, "Next.")]);
    expect(textEl(v).textContent).toBe(`${"b".repeat(400)} more. Next.`);
  });

  it("still fixes up the open segment when the trim did not reach it", async () => {
    fakeLayout();
    cpl = 100;
    const v = await view();
    const old = [nl(1, long(999, "a")), nl(2, long(999, "b"))];
    // The cut (character 1,700) falls in segment 2; segment 3 is open and untouched.
    show(v, [...old, nl(3, "c d", 2)]);
    expect(spans(v)).toHaveLength(2);
    expect(spans(v)[1]?.textContent).toBe(" c d");
    // Its committed text is corrected in the middle: the span is rebuilt.
    show(v, [...old, nl(3, "x d e", 4)]);
    expect(spans(v)[1]?.textContent).toBe(" x d e");
    // Segment 2 lost its start: a fix-up there cannot be rebuilt (only appended to).
    show(v, [old[0] as Segment, nl(2, `${long(998, "b")}z`), nl(3, "x d e.")]);
    expect(spans(v)[0]?.textContent).toBe("b".repeat(300));
  });

  it("trims again later, passing over the segments it already dropped", async () => {
    fakeLayout();
    cpl = 100;
    const v = await view();
    const first = nl(1, long(999, "a"));
    show(v, [first, nl(2, long(999, "b"))]);
    expect(spans(v)).toHaveLength(1);
    // 400 + 1,600 more characters: 20 lines again, cut at 1,600 of them.
    show(v, [first, nl(2, long(999, "b")), nl(3, long(1599, "c"))]);
    expect(spans(v)).toHaveLength(1);
    expect(textEl(v).textContent).toBe("c".repeat(400));
  });

  it("lowers the anti-bounce ratchet by the lines it removed", async () => {
    fakeLayout();
    cpl = 100;
    const v = await view();
    show(v, [nl(1, long(999, "a")), nl(2, long(999, "b"))]);
    // 4 lines left; a shorter partial now pads only up to those 4 lines, not the old 20.
    show(v, [nl(1, long(999, "a")), nl(2, long(999, "b")), nl(3, "x y", 0)]);
    show(v, [nl(1, long(999, "a")), nl(2, long(999, "b")), nl(3, "", 0)]);
    expect(textEl(v).style.paddingBottom).toBe("");
  });

  it("skips characters without a box (collapsed spaces) when measuring", async () => {
    fakeLayout();
    cpl = 100;
    boxless = (i) => i % 2 === 1;
    const v = await view();
    show(v, [nl(1, long(999, "a")), nl(2, long(999, "b"))]);
    // Character 1,599 has no box: it is measured by the next one (1,600, below the cut line), so
    // the cut moves up by one.
    expect(textEl(v).textContent?.length).toBe(401);
  });

  it("does nothing while the text is short", async () => {
    fakeLayout();
    cpl = 10;
    const v = await view();
    show(v, [nl(1, long(500, "a"))]);
    expect(textEl(v).textContent?.length).toBe(501);
  });

  it("does nothing when there is not enough text above the window", async () => {
    fakeLayout();
    cpl = 1000;
    const v = await view();
    show(v, [nl(1, long(1999, "a"))]);
    expect(textEl(v).textContent?.length).toBe(2000);
  });

  it("does nothing when no character can be measured", async () => {
    fakeLayout();
    cpl = 100;
    boxless = () => true;
    const v = await view();
    show(v, [nl(1, long(1999, "a"))]);
    expect(textEl(v).textContent?.length).toBe(2000);
  });

  it("does nothing when every line is already near the window", async () => {
    fakeLayout();
    cpl = 100;
    vi.mocked(Range.prototype.getClientRects).mockImplementation(
      () => [new DOMRect(0, 99_999, 10, LH)] as unknown as DOMRectList,
    );
    const v = await view();
    show(v, [nl(1, long(1999, "a"))]);
    expect(textEl(v).textContent?.length).toBe(2000);
  });

  it("never cuts inside the partial", async () => {
    fakeLayout();
    cpl = 100;
    const v = await view();
    // The cut (character 1,600) falls in the open segment's partial text.
    show(v, [nl(1, long(999, "a")), nl(2, long(999, "b"), 0)]);
    expect(textEl(v).textContent?.length).toBe(2000);
    expect(partialOf(v)?.textContent).toBe("b".repeat(999));
  });

  it("keeps a segment whose span still holds the partial", async () => {
    fakeLayout();
    cpl = 100;
    const v = await view();
    // One open segment: 1,700 committed characters, then the partial after the cut.
    show(v, [nl(1, `${long(1700, "a")} ${long(300, "b")}`, 1701)]);
    const seg = spans(v)[0];
    expect(seg?.isConnected).toBe(true);
    expect(seg?.lastElementChild).toBe(partialOf(v));
    expect(partialOf(v)?.textContent).toBe("b".repeat(300));
  });
});

describe("rollup: loading the caption fonts", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  it("resolves at once without a font API", async () => {
    await expect(loadFonts()).resolves.toBeUndefined();
    Object.defineProperty(document, "fonts", { value: {}, configurable: true });
    await expect(loadFonts()).resolves.toBeUndefined();
  });

  it("loads the Arabic and Latin faces, failures included", async () => {
    const load = vi.fn((font: string) =>
      font.includes("Naskh") ? Promise.reject(new Error("blocked")) : Promise.resolve([]),
    );
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    await expect(loadFonts()).resolves.toBeUndefined();
    expect(load.mock.calls.map((c) => c[0])).toEqual([
      '600 48px "Noto Naskh Arabic"',
      '600 48px "Noto Sans"',
      '400 48px "Noto Sans"',
    ]);
  });

  it("gives up waiting after 3 s", async () => {
    const load = vi.fn(() => new Promise<never>(() => undefined));
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    let done = false;
    void loadFonts().then(() => {
      done = true;
    });
    vi.advanceTimersByTime(2_999);
    await settle();
    expect(done).toBe(false);
    vi.advanceTimersByTime(1);
    await settle();
    expect(done).toBe(true);
  });
});
