// @vitest-environment happy-dom
// The look editor (web/customize.ts, /app/look): the looks, every group of controls with the live
// preview and the links it makes, the remembered work, and a link's look opened for editing.
// Saving, the preview tools and the hosted page have their own files.
import { afterEach, describe, expect, it } from "vitest";
import {
  $,
  all,
  byId,
  change,
  closeBrowser,
  doc,
  fire,
  input,
  win,
} from "./helpers/builder-dom.js";
import {
  bootLook,
  card,
  control,
  frame,
  group,
  modified,
  part,
  readout,
  themeParams,
  themeQs,
} from "./helpers/builder-look.js";

const value = (id: string): string => byId<{ value: string }>(id).value;
const text = (id: string): string => (byId(id).textContent ?? "").trim();

type Row = ReturnType<typeof control>;

/** Move a control's (first) slider. */
function slide(row: Row, v: string, selector = "input[type=range]:not(.range-alpha)"): void {
  input(part(row, selector), v);
  frame();
}

function pick(row: Row, hex: string): void {
  input(part(row, "input[type=color]"), hex);
  frame();
}

function alpha(row: Row, pct: string): void {
  input(part(row, ".range-alpha"), pct);
  frame();
}

function typeColour(row: Row, v: string): void {
  change(part(row, ".sw-text"), v);
  frame();
}

function choose(row: Row, v: string): void {
  change(part(row, "select"), v);
  frame();
}

function toggle(row: Row, on: boolean): void {
  change(part(row, "input[type=checkbox]"), on);
  frame();
}

function segment(row: Row, label: string): void {
  const b = [...row.querySelectorAll(".seg-btn")].find((x) => x.textContent === label);
  if (b === undefined) throw new Error(`no "${label}" button`);
  (b as unknown as { click(): void }).click();
  frame();
}

function pressed(row: Row): string | undefined {
  return (
    [...row.querySelectorAll(".seg-btn")].find((x) => x.getAttribute("aria-pressed") === "true")
      ?.textContent ?? undefined
  );
}

function reset(row: Row): void {
  part<{ click(): void }>(row, ".ctl-reset").click();
  frame();
}

function badge(title: string): string {
  return group(title).querySelector(".grp-badge")?.textContent ?? "";
}

afterEach(() => closeBrowser());

describe("the look editor on a local install", () => {
  it("opens on the server's default look with the links to use it", async () => {
    const { b } = await bootLook();
    expect(doc.title).toBe("Look · Turjuman");
    expect(text("current-name")).toBe("Mosque dark");
    expect(byId<{ hidden: boolean }>("current-edited").hidden).toBe(true);
    expect(byId<{ disabled: boolean }>("reset").disabled).toBe(true);
    expect(all("#gallery .pcard")).toHaveLength(10);
    expect(card("Mosque dark").classList.contains("is-active")).toBe(true);
    expect(card("Mosque dark").textContent).toContain("Default");
    expect(value("url-caption")).toBe("http://127.0.0.1:8765/ar/nl");
    expect(value("url-overlay")).toBe("http://127.0.0.1:8765/overlay");
    expect(value("url-theme")).toBe("(the look as it is: nothing to add)");
    expect(themeQs()).toBe("");
    expect(byId<{ href: string }>("open-preview").href).toBe(
      "http://127.0.0.1:8765/app/look?view=preview&to=nl",
    );
    expect(text("default-note")).toBe(
      "The server’s default look: Mosque dark. Links without preset= use it.",
    );
    expect(text("make-default")).toBe("This is the default");
    expect(byId<{ disabled: boolean }>("make-default").disabled).toBe(true);
    expect(byId<{ hidden: boolean }>("use-local").hidden).toBe(false);
    expect(text("use-lead")).toBe(
      "Save it as a look and choose it for a screen (Screens → ⋯ → Change look), or copy a link.",
    );
    expect(byId<{ hidden: boolean }>("custom-note").hidden).toBe(false);
    expect(text("custom-note")).toBe(
      "Looks you save with “Save as a look…” appear here, ready for your screens.",
    );
    // Layout, panel and text are open to begin with.
    expect(all("#groups details.grp").map((d) => (d as unknown as { open: boolean }).open)).toEqual(
      [true, true, false, true, false, false, false, false, false, false],
    );
    expect($(".app-brand").getAttribute("href")).toBe("/app");
    expect($('a[data-nav="look"]').getAttribute("aria-current")).toBe("page");
    expect(all("#app-foot a").map((a) => a.getAttribute("href"))).toEqual([
      "/control",
      "/overlay",
      "/health",
    ]);
    expect(b.api.sent("GET", "/api/presets")).toHaveLength(1);
    // The login cookie does the work: no token header.
    expect(b.api.sent("GET", "/api/presets")[0]?.headers).toEqual({ Accept: "application/json" });
  });

  it("starts from another look when one is picked", async () => {
    await bootLook();
    part<{ click(): void }>(card("Glass"), ".pcard-main").click();
    frame();
    expect(text("current-name")).toBe("Glass");
    expect(card("Glass").classList.contains("is-active")).toBe(true);
    expect(card("Glass").querySelector(".pcard-main")?.getAttribute("aria-pressed")).toBe("true");
    expect(themeQs()).toBe("preset=glass");
    expect(value("url-caption")).toBe("http://127.0.0.1:8765/ar/nl?preset=glass");
    expect(text("make-default")).toBe("Make “Glass” the default");
    expect(byId<{ disabled: boolean }>("make-default").disabled).toBe(false);
    // Picking a look starts over from it.
    slide(control("Panel", "Corner radius"), "40");
    expect(themeQs()).toBe("preset=glass&panelRadius=40");
    expect(text("make-default")).toBe("Save it first to make it the default");
    part<{ click(): void }>(card("Cinema"), ".pcard-main").click();
    frame();
    expect(themeQs()).toBe("preset=cinema");
  });

  it("remembers the work between visits", async () => {
    await bootLook({
      storage: {
        "captions.customize.v1": JSON.stringify({
          presetId: "glass",
          // The panel padding is Glass's own: not a change.
          overrides: {
            "--cap-panel-radius": "12px",
            "--cap-panel-padding": "20px",
            "--cap-bogus": "1",
          },
          options: { size: 60, nonsense: true },
          from: "en",
          to: "fr",
          aspect: "phone",
          backdrop: "light",
          sample: "events",
          browser: true,
          open: ["blocks", 4],
          auto: { width: true },
        }),
      },
    });
    expect(text("current-name")).toBe("Glass");
    expect(themeParams()).toEqual({ preset: "glass", size: "60", panelRadius: "12" });
    expect(value("from")).toBe("en");
    expect(value("to")).toBe("fr");
    expect(value("url-caption")).toBe(
      "http://127.0.0.1:8765/en/fr?preset=glass&size=60&panelRadius=12",
    );
    expect(value("backdrop")).toBe("light");
    expect(value("sample")).toBe("events");
    expect(byId<{ checked: boolean }>("browser").checked).toBe(true);
    expect($('#aspect .seg-btn[aria-pressed="true"]').textContent).toBe("Phone");
    expect(all("#groups details.grp").map((d) => (d as unknown as { open: boolean }).open)).toEqual(
      [false, false, true, false, false, false, false, false, false, false],
    );
    expect(text("current-edited")).toBe("2 changes");
  });

  it("ignores saved work it can't read", async () => {
    for (const saved of [
      "{not json",
      "42",
      JSON.stringify({ presetId: 7, from: "xx-!", aspect: "tv" }),
    ]) {
      await bootLook({ storage: { "captions.customize.v1": saved } });
      expect(text("current-name")).toBe("Mosque dark");
      expect(themeQs()).toBe("");
      expect(value("from")).toBe("ar");
      expect($('#aspect .seg-btn[aria-pressed="true"]').textContent).toBe("Screen");
    }
  });

  it("forgets a saved look the server no longer has", async () => {
    await bootLook({
      storage: { "captions.customize.v1": JSON.stringify({ presetId: "deleted-one" }) },
    });
    expect(text("current-name")).toBe("Mosque dark");
    expect(JSON.parse(win.localStorage.getItem("captions.customize.v1") ?? "{}").presetId).toBe(
      "mosque-dark",
    );
  });

  it("opens a link's look for editing, with the builder's languages", async () => {
    await bootLook({
      url: "http://127.0.0.1:8765/app/look?from=en&to=tr&preset=glass&size=64&fg=ffcc00&layout=rollup&backdrop=dark",
    });
    expect(text("current-name")).toBe("Glass");
    expect(themeParams()).toEqual({
      preset: "glass",
      layout: "rollup",
      size: "64",
      fg: "ffcc00",
    });
    expect(value("from")).toBe("en");
    expect(value("to")).toBe("tr");
    expect(readout(control("Text", "Size"))).toBe("64 px");
    expect(modified(control("Text", "Text colour"))).toBe(true);
    expect(badge("Text")).toBe("2");
    // Rolling brings its own background, Show and live words: only the layout is a change.
    expect(badge("Layout and placement")).toBe("1");
    expect(text("current-edited")).toBe("3 changes");
  });
});

describe("the controls", () => {
  it("layout and placement", async () => {
    await bootLook();
    const L = "Layout and placement";
    const layout = control(L, "Layout");
    expect(pressed(layout)).toBe("Blocks");
    segment(layout, "Rolling");
    expect(themeQs()).toBe("layout=rollup");
    expect(modified(layout)).toBe(true);
    expect(part<{ value: string }>(control(L, "Background"), "select").value).toBe("band");
    segment(layout, "Blocks");
    expect(themeQs()).toBe("");
    expect(modified(layout)).toBe(false);

    const place = control(L, "Position on the screen");
    part<{ click(): void }>(place, '.plc-cell[aria-label="Top · Right"]').click();
    frame();
    expect(themeParams()).toEqual({ pos: "top", width: "65", height: "50", justify: "right" });
    expect(place.querySelector(".plc-note")?.textContent).toBe(
      "Width set to 65 % so a camera picture fits on the left. Height set to 50 % so the panel can sit at the top.",
    );
    expect(modified(place)).toBe(true);
    expect(readout(control(L, "Width"))).toBe("65 vw");
    // The opposite pick gives the look its sizes back.
    part<{ click(): void }>(place, '.plc-cell[aria-label="Bottom · Center"]').click();
    frame();
    expect(themeQs()).toBe("");
    expect(place.querySelector(".plc-note")?.textContent).toBe(
      "Width back to the look’s own size. Height back to the look’s own size.",
    );
    // A size moved by hand is the user's: the next pick keeps it.
    part<{ click(): void }>(place, '.plc-cell[aria-label="Middle · Left"]').click();
    frame();
    slide(control(L, "Width"), "70");
    slide(control(L, "Height"), "60");
    part<{ click(): void }>(place, '.plc-cell[aria-label="Bottom · Center"]').click();
    frame();
    expect(themeParams()).toEqual({ width: "70", height: "60" });
    part<{ click(): void }>(place, '.plc-cell[aria-label="Top · Left"]').click();
    frame();
    // Not wide or tall enough to need room.
    expect(themeParams()).toEqual({ pos: "top", width: "70", height: "60", justify: "left" });
    expect(place.querySelector(".plc-note")?.hasAttribute("hidden")).toBe(true);
    reset(place);
    expect(themeParams()).toEqual({ width: "70", height: "60" });
    reset(control(L, "Width"));
    reset(control(L, "Height"));
    expect(themeQs()).toBe("");

    const show = control(L, "Show");
    segment(show, "Both");
    expect(themeQs()).toBe("show=both");
    reset(show);
    // Rolling captions show both languages and live words by themselves; both can be turned off.
    segment(layout, "Rolling");
    expect(pressed(show)).toBe("Both");
    segment(show, "Translation");
    expect(pressed(show)).toBe("Translation");
    const live = control(L, "Live words while listening");
    expect(live.querySelector(".switch-text")?.textContent).toBe("On");
    toggle(live, false);
    expect(live.querySelector(".switch-text")?.textContent).toBe("Off");
    expect(themeParams()).toEqual({ layout: "rollup", show: "target", partial: "0" });
    segment(show, "Both");
    expect(themeParams()).toEqual({ layout: "rollup", partial: "0" });
    reset(live);
    reset(show);
    segment(layout, "Blocks");
    expect(themeQs()).toBe("");
    const visible = control(L, "Blocks on screen");
    expect(readout(visible)).toBe("All that fit");
    slide(visible, "3");
    expect(readout(visible)).toBe("3");
    expect(themeQs()).toBe("visibleBlocks=3");
    slide(visible, "0");
    const lines = control(L, "Lines when rolling");
    slide(lines, "4");
    expect(themeQs()).toBe("lines=4");
    reset(lines);
    choose(control(L, "Background"), "none");
    expect(themeQs()).toBe("bg=none");
    reset(control(L, "Background"));
    const partial = control(L, "Live words while listening");
    expect(partial.querySelector(".switch-text")?.textContent).toBe("Off");
    toggle(partial, true);
    expect(partial.querySelector(".switch-text")?.textContent).toBe("On");
    expect(themeQs()).toBe("partial=1");
    toggle(partial, false);
    toggle(control(L, "Scroll back in a browser"), false);
    expect(themeQs()).toBe("history=0");
    reset(control(L, "Scroll back in a browser"));
    slide(control(L, "Blocks kept in OBS"), "100");
    expect(themeQs()).toBe("maxBlocks=100");
    expect(badge(L)).toBe("1");
    expect(text("current-edited")).toBe("1 change");
  });

  it("the panel: colour, opacity, background and the rest", async () => {
    await bootLook();
    const colour = control("Panel", "Panel colour");
    const opacity = control("Panel", "Panel opacity");
    expect(readout(opacity)).toBe("92 %");
    // The panel colour has no opacity of its own: a new colour keeps the panel's opacity.
    expect(colour.querySelector(".range-alpha")).toBeNull();
    pick(colour, "#336699");
    expect(themeQs()).toBe("panelBg=336699&panelOpacity=92");
    expect(modified(colour)).toBe(true);
    expect(modified(opacity)).toBe(false);
    expect(part<{ value: string }>(colour, ".sw-text").value).toBe("#336699");
    slide(opacity, "50");
    expect(readout(opacity)).toBe("50 %");
    expect(themeQs()).toBe("panelBg=336699&panelOpacity=50");
    expect(modified(opacity)).toBe(true);
    // Resetting the opacity keeps the colour, and resetting the colour keeps the opacity.
    reset(opacity);
    expect(themeQs()).toBe("panelBg=336699&panelOpacity=92");
    slide(opacity, "50");
    reset(colour);
    expect(themeQs()).toBe("panelOpacity=50");
    reset(opacity);
    // Typed colours: a plain one keeps the opacity; one with its own alpha is taken as it is.
    typeColour(colour, "#123");
    expect(themeQs()).toBe("panelBg=112233&panelOpacity=92");
    typeColour(colour, "rgba(10, 20, 30, 0.5)");
    expect(themeQs()).toBe("panelBg=0a141e&panelOpacity=50");
    typeColour(colour, "not a colour!");
    expect(part(colour, ".sw-text").classList.contains("is-bad")).toBe(true);
    expect($("#toast").textContent).toBe("“not a colour!” isn’t a colour this field accepts");
    expect($("#toast").classList.contains("is-error")).toBe(true);
    // A gradient is a background too; it counts as changed although it has no single colour.
    typeColour(colour, "linear-gradient(#000000, #333333)");
    expect(modified(colour)).toBe(true);
    expect(part(colour, ".sw-text").classList.contains("is-bad")).toBe(false);
    expect(readout(opacity)).toBe("No colour");
    reset(colour);
    reset(opacity);
    expect(themeQs()).toBe("");

    // A panel switched off has no opacity to set.
    choose(control("Layout and placement", "Background"), "none");
    expect(readout(opacity)).toBe("Off");
    expect(part<{ disabled: boolean }>(opacity, "input").disabled).toBe(true);
    reset(control("Layout and placement", "Background"));

    const page = control("Panel", "Page background");
    expect(readout(page)).toBe("");
    expect(part(page, ".sw-alpha").textContent).toBe("0 %");
    pick(page, "#ffffff");
    expect(themeQs()).toBe("pageBg=ffffff00");
    alpha(page, "100");
    expect(themeQs()).toBe("pageBg=ffffff");
    expect(part(page, ".sw-alpha").textContent).toBe("100 %");
    reset(page);
    slide(control("Panel", "Corner radius"), "24");
    slide(control("Panel", "Inner spacing"), "40");
    choose(control("Panel", "Shadow"), BOX.soft);
    slide(control("Panel", "Background blur"), "12");
    const fade = control("Panel", "Top fade");
    slide(fade, "0");
    expect(readout(fade)).toBe("None");
    expect(themeParams()).toEqual({
      panelRadius: "24",
      panelPad: "40",
      panelShadow: "soft",
      blur: "12",
      fade: "0",
    });
    expect(badge("Panel")).toBe("5");
  });

  it("the blocks: colours, opacity, border, padding and the rest", async () => {
    await bootLook();
    const B = "Blocks";
    const opacity = control(B, "Block opacity");
    expect(readout(opacity)).toBe("100 %");
    pick(control(B, "Block colour"), "#203040");
    expect(themeQs()).toBe("blockBg=203040");
    // A colour with its own opacity: the two blocks differ now.
    typeColour(control(B, "Newest block colour"), "rgba(1, 2, 3, 0.5)");
    expect(readout(opacity)).toBe("100 % · 50 %");
    expect(modified(opacity)).toBe(true);
    slide(opacity, "70");
    expect(readout(opacity)).toBe("70 %");
    expect(themeQs()).toBe("blockBg=203040&blockBgNew=010203&blockOpacity=70");
    reset(opacity);
    expect(readout(opacity)).toBe("100 %");
    reset(control(B, "Block colour"));
    // A see-through block keeps its transparency when the opacity moves.
    typeColour(control(B, "Newest block colour"), "transparent");
    slide(opacity, "40");
    expect(themeParams()).toEqual({
      blockBg: "rgba(28, 28, 32, 0.4)",
      blockBgNew: "transparent",
    });
    reset(control(B, "Newest block colour"));
    reset(opacity);
    expect(themeQs()).toBe("");

    const border = control(B, "Border");
    expect(readout(border)).toBe("1 px");
    slide(border, "2.5");
    expect(readout(border)).toBe("2.5 px");
    pick(border, "#ff0000");
    alpha(border, "50");
    expect(themeParams()).toEqual({ border: "2.5px solid #ff000080" });
    slide(border, "0");
    expect(readout(border)).toBe("None");
    expect(themeParams()).toEqual({ border: "none" });
    // From "none" the colour picked before comes back with the width.
    slide(border, "1");
    expect(themeParams()).toEqual({ border: "1px solid #ff000080" });
    reset(border);

    slide(control(B, "Corner radius"), "20");
    const padding = control(B, "Padding");
    expect(readout(padding)).toBe("14 × 22 px");
    slide(padding, "8", "input[aria-label='Top and bottom']");
    slide(padding, "30", "input[aria-label='Left and right']");
    expect(readout(padding)).toBe("8 × 30 px");
    reset(padding);
    expect(readout(padding)).toBe("14 × 22 px");
    slide(padding, "8", "input[aria-label='Top and bottom']");
    slide(padding, "30", "input[aria-label='Left and right']");
    slide(control(B, "Space between blocks"), "4");
    const shadow = control(B, "Shadow");
    choose(shadow, "0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 40px rgba(0, 0, 0, 0.45)");
    expect(themeParams()).toMatchObject({ blockShadow: "glow" });
    reset(shadow);
    expect(modified(shadow)).toBe(false);
    choose(shadow, "0 18px 50px rgba(0, 0, 0, 0.5)");
    const old = control(B, "Text of older blocks");
    slide(old, "0.6");
    expect(readout(old)).toBe("0.6");
    expect(themeParams()).toEqual({
      radius: "20",
      pad: "8 30",
      gap: "4",
      blockShadow: "strong",
      oldOpacity: "0.6",
    });
    expect(badge(B)).toBe("5");
  });

  it("the text", async () => {
    await bootLook();
    const T = "Text";
    choose(control(T, "Typeface"), FONT.georgia);
    const size = control(T, "Size");
    slide(size, "60");
    expect(readout(size)).toBe("60 px");
    const weight = control(T, "Weight");
    expect(pressed(weight)).toBe("Regular");
    segment(weight, "Bold");
    expect(pressed(weight)).toBe("Bold");
    const lh = control(T, "Line height");
    slide(lh, "1.5");
    expect(readout(lh)).toBe("1.5");
    const ls = control(T, "Letter spacing");
    slide(ls, "1.2");
    expect(readout(ls)).toBe("1.2 px");
    const measure = control(T, "Line length");
    expect(readout(measure)).toBe("42 ch");
    slide(measure, "0");
    expect(readout(measure)).toBe("No limit");
    const align = control(T, "Alignment");
    segment(align, "Right");
    reset(align);
    expect(pressed(align)).toBe("Auto");
    segment(align, "Center");
    const fg = control(T, "Text colour");
    pick(fg, "#ffee00");
    alpha(fg, "80");
    expect(part(fg, ".sw-alpha").textContent).toBe("80 %");
    pick(control(T, "Text of the newest block"), "#ffffff");
    choose(control(T, "Text shadow"), TEXT.outline);
    expect(themeParams()).toEqual({
      size: "60",
      font: "georgia",
      weight: "700",
      lh: "1.5",
      ls: "1.2",
      fg: "ffee00cc",
      shadow: "outline",
      align: "center",
      maxChars: "none",
    });
    // The newest block's text was white already: not a change.
    expect(badge(T)).toBe("9");
    expect(text("current-edited")).toBe("9 changes");
  });

  it("the original, the Arabic and the honorifics", async () => {
    await bootLook();
    const S = "Original and Arabic";
    choose(control(S, "Typeface of the original"), FONT.amiri);
    const scale = control(S, "Size of the original");
    slide(scale, "0.9");
    expect(readout(scale)).toBe("0.9");
    pick(control(S, "Colour of the original"), "#eeeeee");
    const op = control(S, "Opacity of the original");
    expect(readout(op)).toBe("0.6");
    slide(op, "0.75");
    expect(readout(op)).toBe("0.75");
    choose(control(S, "Arabic typeface"), FONT.amiri);
    choose(control(S, "Quran typeface"), FONT.naskh);
    expect(themeParams()).toEqual({
      srcFont: "amiri-quran",
      srcScale: "0.9",
      srcColor: "eeeeee",
      srcOpacity: "0.75",
      arFont: "amiri-quran",
      quranFont: "naskh",
    });

    const H = "Honorifics (ﷺ)";
    const sample = group(H).querySelector(".cz-hon-sample") as unknown as {
      style: { getPropertyValue(n: string): string };
    };
    expect(sample.style.getPropertyValue("--cap-hon-color")).toBe("#d4a64a");
    choose(control(H, "Typeface"), FONT.amiri);
    const size = control(H, "Size");
    expect(readout(size)).toBe("1.25 em");
    slide(size, "1.5");
    const colour = control(H, "Colour");
    const follow = part(colour, ".ctl-chip");
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    follow.click();
    frame();
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    expect(part<{ value: string }>(colour, ".sw-text").value).toBe("text colour");
    expect(part(colour, ".sw-alpha").textContent).toBe("–");
    expect(part<{ disabled: boolean }>(colour, ".range-alpha").disabled).toBe(true);
    expect(sample.style.getPropertyValue("--cap-hon-color")).toBe("currentcolor");
    expect(themeParams()).toMatchObject({
      honFont: "amiri-quran",
      honScale: "1.5",
      honColor: "currentcolor",
    });
    pick(colour, "#00aa00");
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    expect(themeParams()).toMatchObject({ honColor: "00aa00" });
  });

  it("the Quran and dua accents, the Athan and Iqama cards, motion and the toolbar", async () => {
    await bootLook();
    const Q = "Quran and dua";
    const accent = control(Q, "Accent bar on Quran blocks");
    toggle(accent, false);
    toggle(control(Q, "Arabic verse above the translation"), false);
    slide(control(Q, "Width of the accent bar"), "6");
    pick(control(Q, "Quran accent"), "#aa8800");
    pick(control(Q, "Dua accent"), "#00aa55");
    pick(control(Q, "Colour of the reference"), "#ffffff");
    segment(control(Q, "Weight of the reference"), "Medium");
    expect(themeParams()).toEqual({
      quranAccent: "0",
      quranArabic: "0",
      accentWidth: "6",
      quranColor: "aa8800",
      duaColor: "00aa55",
      refColor: "ffffff",
      refWeight: "500",
    });
    expect(badge(Q)).toBe("7");
    reset(accent);
    expect(badge(Q)).toBe("6");

    await bootLook();
    const E = "Athan and Iqama cards";
    pick(control(E, "Card colour"), "#102030");
    pick(control(E, "Card text"), "#eeeeee");
    pick(control(E, "Card accent"), "#ffcc00");
    const M = "Motion";
    const anim = control(M, "Slide-in time");
    slide(anim, "0");
    expect(readout(anim)).toBe("0 ms");
    const lift = control(M, "Lift of the newest block");
    expect(readout(lift)).toBe("1.02");
    slide(lift, "1.05");
    expect(readout(lift)).toBe("1.05");
    const R = "Toolbar and listening dots";
    const bar = control(R, "Toolbar");
    expect(pressed(bar)).toBe("Auto");
    segment(bar, "On");
    pick(control(R, "Toolbar colour"), "#000000");
    pick(control(R, "Toolbar text"), "#ffffff");
    pick(control(R, "Listening dots"), "#ff0000");
    expect(themeParams()).toEqual({
      toolbar: "on",
      eventBg: "102030",
      eventColor: "eeeeee",
      eventAccent: "ffcc00",
      // The toolbar keeps its own opacity (92 %) with the new colour.
      toolbarBg: "000000eb",
      toolbarColor: "ffffff",
      dotsColor: "ff0000",
      anim: "0",
      newScale: "1.05",
    });
    // The toolbar shows in the preview now (also outside a browser).
    expect($("#stage-frame .pp-stage .pp-tb").textContent).toContain("NL");
  });

  it("names a look's own value and a custom one in the lists", async () => {
    await bootLook({ url: "http://127.0.0.1:8765/app/look?preset=midnight-gold" });
    const shadow = control("Panel", "Shadow");
    const options = (): Array<string | null> =>
      [...shadow.querySelectorAll("option")].map((o) => o.textContent);
    expect(options().at(-1)).toBe("The look’s own");
    expect(part<{ value: string }>(shadow, "select").value).toBe(
      "0 0 0 1px rgba(224, 182, 90, 0.28), 0 22px 60px rgba(0, 0, 0, 0.55)",
    );
    await bootLook({
      url: "http://127.0.0.1:8765/app/look?panelShadow=0+2px+4px+rgba(0,0,0,0.5)",
    });
    expect(
      [...control("Panel", "Shadow").querySelectorAll("option")].map((o) => o.textContent).at(-1),
    ).toBe("Custom");
  });

  it("reads sizes from a link as they are", async () => {
    await bootLook({ url: "http://127.0.0.1:8765/app/look?width=1200px&pad=12" });
    // Pixels on a slider in vw: the read-out says what the link says.
    expect(readout(control("Layout and placement", "Width"))).toBe("1200px");
    expect(readout(control("Blocks", "Padding"))).toBe("12 × 12 px");
  });

  it("makes a see-through panel solid when a colour is picked", async () => {
    await bootLook({ url: "http://127.0.0.1:8765/app/look?preset=lower-third" });
    expect(readout(control("Panel", "Panel opacity"))).toBe("No colour");
    pick(control("Panel", "Panel colour"), "#202020");
    expect(themeParams()).toEqual({ preset: "lower-third", panelBg: "202020" });
    expect(readout(control("Panel", "Panel opacity"))).toBe("100 %");
  });

  it("leaves a field alone while the user is in it, and folds groups as asked", async () => {
    await bootLook();
    const radius = control("Panel", "Corner radius");
    const range = part<{ focus(): void; value: string }>(radius, "input[type=range]");
    range.focus();
    slide(radius, "33");
    expect(range.value).toBe("33");
    const fg = control("Text", "Text colour");
    const typed = part<{ focus(): void; value: string }>(fg, ".sw-text");
    typed.focus();
    typed.value = "#12";
    pick(fg, "#336699");
    expect(typed.value).toBe("#12");
    const fgAlpha = part<{ focus(): void; value: string }>(fg, ".range-alpha");
    fgAlpha.focus();
    alpha(fg, "55");
    expect(fgAlpha.value).toBe("55");
    const follow = control("Honorifics (ﷺ)", "Colour");
    part<{ click(): void }>(follow, ".ctl-chip").click();
    const honText = part<{ focus(): void; value: string }>(follow, ".sw-text");
    honText.focus();
    honText.value = "gold";
    frame();
    expect(honText.value).toBe("gold");
    const border = control("Blocks", "Border");
    for (const sel of ["input[type=range]:not(.range-alpha)", ".range-alpha"]) {
      part<{ focus(): void }>(border, sel).focus();
      slide(border, "3", sel);
      expect(part<{ value: string }>(border, sel).value).toBe("3");
    }
    const pad = control("Blocks", "Padding");
    for (const sel of [
      "input[aria-label='Top and bottom']",
      "input[aria-label='Left and right']",
    ]) {
      part<{ focus(): void }>(pad, sel).focus();
      slide(pad, "9", sel);
      expect(part<{ value: string }>(pad, sel).value).toBe("9");
    }
    for (const [g, label] of [
      ["Text", "Size"],
      ["Panel", "Panel opacity"],
    ] as const) {
      const row = control(g, label);
      part<{ focus(): void }>(row, "input[type=range]").focus();
      slide(row, "61");
      expect(part<{ value: string }>(row, "input[type=range]").value).toBe("61");
    }
    const panel = group("Panel") as unknown as { open: boolean };
    panel.open = false;
    fire(panel, "toggle");
    const blocks = group("Blocks") as unknown as { open: boolean };
    blocks.open = true;
    fire(blocks, "toggle");
    fire(blocks, "toggle");
    expect(JSON.parse(win.localStorage.getItem("captions.customize.v1") ?? "{}").open).toEqual([
      "layout",
      "text",
      "blocks",
    ]);
  });

  it("puts the whole look back with Reset", async () => {
    await bootLook();
    slide(control("Panel", "Corner radius"), "33");
    segment(control("Layout and placement", "Show"), "Both");
    expect(text("current-edited")).toBe("2 changes");
    expect(byId<{ disabled: boolean }>("reset").disabled).toBe(false);
    byId<{ click(): void }>("reset").click();
    frame();
    expect(themeQs()).toBe("");
    expect(byId<{ disabled: boolean }>("reset").disabled).toBe(true);
    expect($("#toast").textContent).toBe("Back to “Mosque dark”");
  });
});

const BOX = { soft: "0 4px 14px rgba(0, 0, 0, 0.22)" };
const TEXT = {
  outline:
    "-1px -1px 0 #000000, 1px -1px 0 #000000, -1px 1px 0 #000000, 1px 1px 0 #000000, 0 2px 8px rgba(0, 0, 0, 0.8)",
};
const FONT = {
  georgia: 'Georgia, "Times New Roman", "Noto Naskh Arabic", serif',
  amiri: '"Amiri Quran", "Noto Naskh Arabic", serif',
  naskh: '"Noto Naskh Arabic", "Noto Sans", serif',
};
