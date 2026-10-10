// @vitest-environment happy-dom
// Live previews of a look (web/shared/preset-preview.ts): a stage laid out at a real screen size
// with the theme applied (viewport units turned into stage pixels), sample blocks or a roll-up in
// the caption language, prayer-event cards, the listening dots, the toolbar, and the scaled card
// of the picker's gallery.
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, DEFAULT_OPTIONS, DEFAULT_VARS } from "../../src/shared/theme.js";
import type { DisplayOptions, ThemePreset } from "../../src/shared/theme-vars.js";
import {
  buildStage,
  fitStage,
  PRESET_PREVIEW_READY,
  renderPresetPreview,
  type StageSpec,
  sampleLang,
  stageVars,
  withHonorifics,
} from "../../web/shared/preset-preview.js";

function options(over: Partial<DisplayOptions> = {}): DisplayOptions {
  return { ...DEFAULT_OPTIONS, ...over };
}

function stage(over: Partial<StageSpec> = {}, opts: Partial<DisplayOptions> = {}): HTMLElement {
  return buildStage({ width: 1920, height: 1080, vars: {}, options: options(opts), ...over });
}

function preset(id: string): ThemePreset {
  const p = BUILTIN_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
}

function texts(root: ParentNode, sel: string): Array<string | null> {
  return [...root.querySelectorAll(sel)].map((n) => n.textContent);
}

describe("preset preview: helpers", () => {
  it("is ready for the picker", () => {
    expect(PRESET_PREVIEW_READY).toBe(true);
  });

  it("has samples in English, Dutch and Arabic; other languages see English", () => {
    expect(sampleLang(undefined)).toBe("en");
    expect(sampleLang("")).toBe("en");
    expect(sampleLang("nl-BE")).toBe("nl");
    expect(sampleLang(" AR_eg ")).toBe("ar");
    expect(sampleLang("de")).toBe("en");
  });

  it("wraps honorific ligatures like the live captions", () => {
    const p = document.createElement("p");
    p.append(...withHonorifics("The Prophet ﷺ said"));
    expect(p.textContent).toBe("The Prophet ﷺ said");
    const hon = p.querySelector<HTMLElement>("span.cap-hon");
    expect(hon?.textContent).toBe("ﷺ");
    expect(hon?.lang).toBe("ar");
  });

  it("turns viewport units into pixels of the stage", () => {
    const out = stageVars(
      {
        "--cap-panel-width": "92vw",
        "--cap-panel-height": "50vh",
        "--cap-panel-padding": ".5vh 2.5vw",
        "--cap-block-radius": "10vmin",
        "--cap-block-gap": "1vmax",
        "--cap-font-size": "min(52px, 5vw)",
        "--cap-letter-spacing": "-0.1vw",
        "--cap-block-bg": "#123456",
        "--cap-text-color": undefined,
      },
      1920,
      1080,
    );
    expect(out).toEqual({
      "--cap-panel-width": "1766.4px",
      "--cap-panel-height": "540px",
      "--cap-panel-padding": "5.4px 48px",
      "--cap-block-radius": "108px",
      "--cap-block-gap": "19.2px",
      "--cap-font-size": "min(52px, 96px)",
      "--cap-letter-spacing": "-1.9px",
      "--cap-block-bg": "#123456",
    });
  });

  it("scales a stage into its box, never to nothing", () => {
    const s = document.createElement("div");
    expect(fitStage(s, 1920, 1080, 320, 180)).toBeCloseTo(1 / 6, 10);
    expect(s.style.getPropertyValue("transform")).toBe(`scale(${320 / 1920})`);
    // Contain: the narrower side decides.
    expect(fitStage(s, 1920, 1080, 960, 1080)).toBe(0.5);
    expect(fitStage(s, 1920, 1080, 1, 1)).toBe(0.01);
    expect(s.style.getPropertyValue("transform")).toBe("scale(0.01)");
  });
});

describe("preset preview: the blocks stage", () => {
  it("lays the stage out at its real size with the theme on it", () => {
    const s = stage({ vars: { "--cap-block-bg": "#123456", "--cap-panel-height": "50vh" } });
    expect(s.className).toBe("pp-stage layout-blocks quran-ar");
    expect(s.style.getPropertyValue("width")).toBe("1920px");
    expect(s.style.getPropertyValue("height")).toBe("1080px");
    expect(s.style.getPropertyValue("--cap-block-bg")).toBe("#123456");
    expect(s.querySelector(".pp-page")).not.toBeNull();
    // The default backdrop: a mosque interior.
    const bd = s.querySelector(".pp-backdrop.pp-bd-video");
    expect(bd?.children).toHaveLength(5);
    expect(bd?.querySelector(".pp-bd-arch .pp-bd-arch-in")).not.toBeNull();
  });

  it("can stand on a plain backdrop", () => {
    for (const kind of ["dark", "light", "checker"] as const) {
      const bd = stage({ backdrop: kind }).querySelector(`.pp-backdrop.pp-bd-${kind}`);
      expect(bd).not.toBeNull();
      expect(bd?.children).toHaveLength(0);
    }
  });

  it("shows the English khutbah sample with the verse, accents and the source", () => {
    const s = stage();
    const root = s.querySelector(".pp-root");
    expect(root?.className).toBe("pp-root pos-bottom bg-panel show-target");
    const blocks = [...s.querySelectorAll<HTMLElement>("article.pp-blk")];
    expect(blocks.map((b) => b.className.split(" ")[1])).toEqual([
      "pp-blk-speech",
      "pp-blk-quran",
      "pp-blk-speech",
      "pp-blk-speech",
      "pp-blk-dua",
    ]);
    expect(blocks.every((b) => b.lang === "en" && b.dir === "ltr")).toBe(true);
    const quran = blocks[1];
    if (!quran) throw new Error("no quran block");
    expect(quran.classList.contains("has-accent")).toBe(true);
    expect(quran.querySelector(".pp-quran-ar")?.textContent).toContain("يَـٰٓأَيُّهَا");
    const text = quran.querySelector(".pp-text")?.textContent ?? "";
    expect(text.startsWith("“O mankind")).toBe(true);
    expect(text.endsWith("” (49:13)")).toBe(true);
    // The original under each block: Arabic, right to left.
    const src = quran.querySelector<HTMLElement>(".pp-src");
    expect(src?.dir).toBe("rtl");
    expect(src?.lang).toBe("ar");
    expect(blocks[4]?.classList.contains("has-accent")).toBe(true);
    expect(blocks[0]?.classList.contains("has-accent")).toBe(false);
    // Honorifics are wrapped, the newest block is marked.
    expect(blocks[3]?.querySelector(".pp-text .cap-hon")?.textContent).toBe("ﷺ");
    expect(blocks.map((b) => b.classList.contains("is-new"))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(blocks[4]?.classList.contains("pp-enter")).toBe(false);
  });

  it("follows the look's options: no verse Arabic, no Quran accent, the panel and position", () => {
    const s = stage(
      { animate: true },
      {
        quranArabic: false,
        quranAccent: false,
        bg: "none",
        pos: "top",
        show: "both",
      },
    );
    expect(s.classList.contains("quran-ar")).toBe(false);
    expect(s.querySelector(".pp-root")?.className).toBe("pp-root pos-top bg-none show-both");
    expect(s.querySelector(".pp-quran-ar")).toBeNull();
    expect(s.querySelector(".pp-blk-quran")?.classList.contains("has-accent")).toBe(false);
    expect(s.querySelector(".pp-blk.is-new")?.classList.contains("pp-enter")).toBe(true);
    expect(stage({}, { bg: "shadow" }).querySelector(".pp-root.bg-none")).not.toBeNull();
    expect(stage({}, { bg: "band" }).querySelector(".pp-root.bg-panel")).not.toBeNull();
  });

  it("shows the Dutch sample in Dutch and the Arabic one with English under it", () => {
    const nl = [...stage({ lang: "nl" }).querySelectorAll<HTMLElement>("article.pp-blk")];
    expect(nl).toHaveLength(6);
    expect(nl[1]?.querySelector(".pp-text")?.textContent).toBe(
      "“Allah belast niemand boven zijn vermogen.” (2:286)",
    );
    expect(nl[3]?.querySelectorAll(".cap-hon")).toHaveLength(2);

    const ar = [...stage({ lang: "ar" }).querySelectorAll<HTMLElement>("article.pp-blk")];
    expect(ar).toHaveLength(5);
    expect(ar.every((b) => b.lang === "ar" && b.dir === "rtl")).toBe(true);
    // No separate verse Arabic on an Arabic screen; the English sits under it, left to right.
    expect(ar[1]?.querySelector(".pp-quran-ar")).toBeNull();
    const src = ar[0]?.querySelector<HTMLElement>(".pp-src");
    expect(src?.dir).toBe("ltr");
    expect(src?.lang).toBe("en");
    expect(src?.textContent).toContain("Indeed, all praise is for Allah");
  });

  it("keeps only the visible number of blocks", () => {
    const blocks = stage({}, { visibleBlocks: 2 }).querySelectorAll("article.pp-blk");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.classList.contains("pp-blk-dua")).toBe(true);
    expect(blocks[1]?.classList.contains("is-new")).toBe(true);
  });

  it("shows prayer events as an active card and an ended line", () => {
    const s = stage({ sample: "events", lang: "en" });
    const blocks = [...s.querySelectorAll<HTMLElement>("article.pp-blk")];
    expect(blocks.map((b) => b.className.split(" ")[1])).toEqual([
      "pp-blk-event",
      "pp-blk-speech",
      "pp-blk-event",
    ]);
    const ended = blocks[0];
    expect(ended?.classList.contains("is-ended")).toBe(true);
    expect(ended?.querySelector(".pp-ev-compact-ar")?.textContent).toBe("الأذان");
    expect(ended?.querySelector(".pp-ev-compact")?.textContent).toBe("الأذانAthan · 13:02");
    const active = blocks[2];
    expect(active?.classList.contains("is-active")).toBe(true);
    expect(active?.querySelectorAll(".pp-ev-wave i")).toHaveLength(5);
    expect(active?.querySelector(".pp-ev-ar")?.textContent).toBe("الإقامة");
    expect(active?.querySelector(".pp-ev-title")?.textContent).toBe("Iqama");
    expect(active?.querySelector(".pp-ev-sub")?.textContent).toBe("The prayer begins");

    // Labels follow the caption language: a Turkish screen sees the English sample, Turkish cards.
    const tr = stage({ sample: "events", lang: "tr" });
    expect(texts(tr, ".pp-ev-title")).toEqual(["Kamet"]);
    expect(tr.querySelector(".pp-ev-compact")?.textContent).toBe("الأذانEzan · 13:02");
    expect(stage({ sample: "events", lang: "nl" }).querySelectorAll("article.pp-blk")).toHaveLength(
      4,
    );
    expect(stage({ sample: "events", lang: "ar" }).querySelectorAll("article.pp-blk")).toHaveLength(
      4,
    );
  });

  it("shows the listening dots unless switched off, with the live words when partial", () => {
    const on = stage().querySelector(".pp-listen");
    expect(on?.classList.contains("is-on")).toBe(true);
    expect(on?.classList.contains("with-partial")).toBe(false);
    expect(on?.querySelectorAll(".pp-dots i")).toHaveLength(3);
    expect(
      stage({ listening: false }).querySelector(".pp-listen")?.classList.contains("is-on"),
    ).toBe(false);

    const partial = stage({}, { partial: true }).querySelector(".pp-listen");
    expect(partial?.classList.contains("with-partial")).toBe(true);
    expect(partial?.querySelector(".pp-partial-box")?.className).toBe("pp-partial-box");
    const said = partial?.querySelector<HTMLElement>(".pp-partial");
    expect(said?.textContent).toBe("واعلموا عباد الله أن من أعظم أسباب");
    expect(said?.dir).toBe("rtl");
    expect(said?.lang).toBe("ar");

    // Under Arabic captions the live words are the English being said.
    const ar = stage({ lang: "ar" }, { partial: true }).querySelector(".pp-listen");
    expect(ar?.querySelector(".pp-partial-box")?.className).toBe("pp-partial-box is-ltr");
    expect(ar?.querySelector<HTMLElement>(".pp-partial")?.dir).toBe("ltr");
  });

  it("adds the caption toolbar in its language when the look or the browser shows it", () => {
    const on = stage({ lang: "nl" }, { toolbar: "on" }).querySelector(".pp-tb");
    expect(on?.querySelector(".pp-tb-live span")?.textContent).toBe("Live vertaling");
    expect(on?.querySelector(".pp-tb-chip")?.textContent).toBe("NL");
    expect(texts(on ?? document, ".pp-tb-btn")).toEqual(["A−", "A+"]);
    const browser = stage({ browser: true }, { toolbar: "auto" }).querySelector(".pp-tb");
    expect(browser?.querySelector(".pp-tb-chip")?.textContent).toBe("EN");
    expect(browser?.querySelector(".pp-tb-live span")?.textContent).toBe("Live translation");
    expect(stage({ browser: false }, { toolbar: "auto" }).querySelector(".pp-tb")).toBeNull();
    expect(stage({ browser: true }, { toolbar: "off" }).querySelector(".pp-tb")).toBeNull();
    // A roll-up has no toolbar.
    expect(stage({}, { layout: "rollup", toolbar: "on" }).querySelector(".pp-tb")).toBeNull();
  });
});

describe("preset preview: the roll-up stage", () => {
  it("shows the original above the translation in two windows", () => {
    const s = stage({}, { layout: "rollup", bg: "band", show: "both", lines: 2, pos: "middle" });
    expect(s.className).toBe("pp-stage layout-rollup quran-ar");
    expect(s.querySelector(".pp-roll-area")?.className).toBe("pp-roll-area pos-middle");
    expect(s.querySelector(".pp-roll")?.className).toBe("pp-roll bg-band");
    const blocks = [...s.querySelectorAll<HTMLElement>(".pp-roll-block")];
    expect(blocks.map((b) => b.className)).toEqual([
      "pp-roll-block is-src",
      "pp-roll-block is-tgt",
    ]);
    expect(blocks[0]?.dir).toBe("rtl");
    expect(blocks[0]?.lang).toBe("ar");
    expect(blocks[1]?.dir).toBe("ltr");
    expect(blocks[1]?.lang).toBe("en");
    expect(blocks[1]?.querySelector(".cap-hon")?.textContent).toBe("ﷺ");
    const win = blocks[0]?.querySelector<HTMLElement>(".pp-roll-window");
    expect(win?.style.getPropertyValue("--pp-lines")).toBe("2");
    expect(s.querySelector(".pp-root")).toBeNull();
  });

  it("shows one side only, and keeps between one and six lines", () => {
    const target = stage({ lang: "ar" }, { layout: "rollup", show: "target", lines: 0 });
    const blocks = [...target.querySelectorAll<HTMLElement>(".pp-roll-block")];
    expect(blocks.map((b) => b.className)).toEqual(["pp-roll-block is-tgt"]);
    expect(blocks[0]?.dir).toBe("rtl");
    expect(
      blocks[0]
        ?.querySelector<HTMLElement>(".pp-roll-window")
        ?.style.getPropertyValue("--pp-lines"),
    ).toBe("1");

    const source = stage({ lang: "ar" }, { layout: "rollup", show: "source", lines: 9 });
    const src = [...source.querySelectorAll<HTMLElement>(".pp-roll-block")];
    expect(src.map((b) => b.className)).toEqual(["pp-roll-block is-src"]);
    // Under Arabic captions the original is the English, left to right.
    expect(src[0]?.dir).toBe("ltr");
    expect(src[0]?.lang).toBe("en");
    expect(
      src[0]?.querySelector<HTMLElement>(".pp-roll-window")?.style.getPropertyValue("--pp-lines"),
    ).toBe("6");
    expect(stage({ lang: "nl" }, { layout: "rollup" }).textContent).toContain(
      "Broeders en zusters",
    );
  });
});

describe("preset preview: the gallery card", () => {
  it("shows a preset scaled into a 320 × 180 card", () => {
    const card = renderPresetPreview(preset("mosque-dark"));
    expect(card.className).toBe("pp-card");
    expect(card.getAttribute("role")).toBe("img");
    expect(card.getAttribute("aria-label")).toBe("Mosque dark: preview");
    expect(card.style.getPropertyValue("width")).toBe("320px");
    expect(card.style.getPropertyValue("height")).toBe("180px");
    const s = card.querySelector<HTMLElement>(".pp-stage");
    expect(s?.style.getPropertyValue("width")).toBe("1920px");
    expect(s?.style.getPropertyValue("height")).toBe("1080px");
    expect(s?.style.getPropertyValue("transform")).toBe(`scale(${320 / 1920})`);
    expect(s?.classList.contains("layout-blocks")).toBe(true);
    expect(s?.querySelector(".pp-bd-video")).not.toBeNull();
    expect(s?.querySelector(".pp-listen.is-on")).not.toBeNull();
    // The preset's own variables, with viewport units in stage pixels.
    expect(s?.style.getPropertyValue("--cap-block-bg")).toBe(DEFAULT_VARS["--cap-block-bg"]);
    // In the gallery (browser: false) the toolbar of toolbar=auto stays hidden.
    expect(s?.querySelector(".pp-tb")).toBeNull();
    expect(s?.querySelectorAll("article.pp-blk")[0]?.getAttribute("lang")).toBe("en");
  });

  it("follows the preset's own layout, or the sample asked for", () => {
    const roll = renderPresetPreview(preset("lower-third"));
    expect(roll.querySelector(".pp-stage")?.classList.contains("layout-rollup")).toBe(true);
    expect(roll.querySelector(".pp-roll")?.className).toBe("pp-roll bg-band");

    // A blocks look shown as a roll-up: its panel becomes the roll-up's band.
    const asRoll = renderPresetPreview(preset("mosque-dark"), { sample: "rollup", lang: "nl" });
    expect(asRoll.querySelector(".pp-roll")?.className).toBe("pp-roll bg-band");
    expect(asRoll.textContent).toContain("Broeders en zusters");

    const asBlocks = renderPresetPreview(preset("cinema"), { sample: "blocks" });
    expect(asBlocks.querySelector(".pp-stage")?.classList.contains("layout-blocks")).toBe(true);
    expect(asBlocks.querySelector(".pp-root")?.classList.contains("bg-none")).toBe(true);
  });

  it("keeps the card at least 80 × 45 and the stage at the card's shape", () => {
    const tiny = renderPresetPreview(preset("glass"), { width: 20.4, height: 3 });
    expect(tiny.style.getPropertyValue("width")).toBe("80px");
    expect(tiny.style.getPropertyValue("height")).toBe("45px");
    expect(tiny.querySelector<HTMLElement>(".pp-stage")?.style.getPropertyValue("height")).toBe(
      "1080px",
    );
    const tall = renderPresetPreview(preset("glass"), { width: 200, height: 200 });
    const s = tall.querySelector<HTMLElement>(".pp-stage");
    expect(s?.style.getPropertyValue("height")).toBe("1920px");
    expect(s?.style.getPropertyValue("transform")).toBe(`scale(${200 / 1920})`);
  });
});
