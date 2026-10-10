// @vitest-environment happy-dom
// "Position on the screen" (web/shared/placement-picker.ts): the 3×3 grid on a mini screen with a
// live outline of the caption panel, its labels in English or the app's language, theme lengths
// as a share of the screen, and the size changes a pick brings (room for a camera picture, a
// shorter panel at the top or in the middle) with the reason shown.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../web/shared/app-i18n.js";
import {
  appPlacementLabels,
  ENGLISH_PLACEMENT,
  lengthPct,
  PIP_WIDTH_VW,
  type PlacementView,
  placementAdjust,
  placementLabel,
  placementPicker,
} from "../../web/shared/placement-picker.js";

beforeEach(() => {
  localStorage.clear();
  setLang("en");
});

function view(over: Partial<PlacementView> = {}): PlacementView {
  return { pos: "bottom", justify: "center", widthPct: 90, heightPct: 100, rollup: false, ...over };
}

describe("placement: words", () => {
  it("names each place in English by default", () => {
    expect(placementLabel("top", "flex-start")).toBe("Top · Left");
    expect(placementLabel("middle", "center")).toBe("Middle · Center");
    expect(placementLabel("bottom", "flex-end")).toBe("Bottom · Right");
    expect(ENGLISH_PLACEMENT.readout("Top · Left", 65)).toBe("Top · Left · 65 % wide");
    expect(ENGLISH_PLACEMENT.pipWidth(65, "right")).toBe(
      "Width set to 65 % so a picture-in-picture camera fits on the right.",
    );
    expect(ENGLISH_PLACEMENT.shortHeight(50, "middle")).toBe(
      "Height set to 50 % so the panel can sit at the middle.",
    );
  });

  it("speaks the app's language in the builder and the look editor", () => {
    setLang("nl");
    const nl = appPlacementLabels();
    expect(nl.group).toBe("Positie op het scherm");
    expect(placementLabel("top", "flex-end", nl)).toBe("Boven · Rechts");
    expect([nl.middle, nl.bottom, nl.left, nl.center]).toEqual([
      "Midden",
      "Onder",
      "Links",
      "Midden",
    ]);
    expect(nl.readout("Boven · Rechts", 65)).toBe("Boven · Rechts · 65 % breed");
    expect(nl.pipWidth(65, "right")).toBe(
      "Breedte op 65 % gezet, zodat er rechts een camerabeeld past.",
    );
    expect(nl.pipWidth(65, "left")).toBe(
      "Breedte op 65 % gezet, zodat er links een camerabeeld past.",
    );
    expect(nl.shortHeight(50, "top")).toBe(
      "Hoogte op 50 % gezet, zodat het paneel bovenaan kan staan.",
    );
    expect(nl.shortHeight(50, "middle")).toBe(
      "Hoogte op 50 % gezet, zodat het paneel in het midden kan staan.",
    );
    expect(nl.widthBack).toBe("Breedte terug naar de eigen maat van de stijl.");
    expect(nl.heightBack).toBe("Hoogte terug naar de eigen maat van de stijl.");
  });
});

describe("placement: theme lengths as a share of a 1920 × 1080 screen", () => {
  it("converts every unit", () => {
    expect(lengthPct("92vw", "w")).toBe(92);
    expect(lengthPct("54vw", "h")).toBeCloseTo(96, 5);
    expect(lengthPct("50vh", "h")).toBe(50);
    expect(lengthPct("96vh", "w")).toBeCloseTo(54, 5);
    expect(lengthPct("1200px", "w")).toBe(62.5);
    expect(lengthPct("540px", "h")).toBe(50);
    expect(lengthPct("960", "w")).toBe(50);
    expect(lengthPct(" 80% ", "w")).toBe(80);
    expect(lengthPct("70vmin", "w")).toBe(70);
    expect(lengthPct(".5vmax", "h")).toBe(0.5);
  });

  it("counts anything else as the full screen", () => {
    expect(lengthPct(undefined, "w")).toBe(100);
    expect(lengthPct("none", "w")).toBe(100);
    expect(lengthPct("calc(100vw - 2px)", "h")).toBe(100);
    expect(lengthPct("12em", "w")).toBe(100);
  });
});

describe("placement: what a pick changes", () => {
  it("narrows a wide panel on a side so a camera picture fits next to it", () => {
    expect(
      placementAdjust("bottom", "flex-start", { widthPct: 90, heightPct: 30, rollup: false }),
    ).toEqual({
      width: `${PIP_WIDTH_VW}vw`,
      height: null,
      resetWidth: false,
      resetHeight: false,
      note: "Width set to 65 % so a picture-in-picture camera fits on the right.",
    });
    expect(
      placementAdjust("bottom", "flex-end", { widthPct: 81, heightPct: 30, rollup: true }).note,
    ).toBe("Width set to 65 % so a picture-in-picture camera fits on the left.");
    // Already narrow enough: nothing to change.
    expect(
      placementAdjust("bottom", "flex-end", { widthPct: 80, heightPct: 30, rollup: false }),
    ).toEqual({
      width: null,
      height: null,
      resetWidth: false,
      resetHeight: false,
      note: null,
    });
  });

  it("gives the look its width back on Center when the width was automatic", () => {
    const r = placementAdjust("bottom", "center", {
      widthPct: 65,
      heightPct: 30,
      rollup: false,
      autoWidth: true,
    });
    expect(r.resetWidth).toBe(true);
    expect(r.width).toBeNull();
    expect(r.note).toBe("Width back to the look's own size.");
    expect(
      placementAdjust("bottom", "center", { widthPct: 65, heightPct: 30, rollup: false })
        .resetWidth,
    ).toBe(false);
  });

  it("shortens a full-height blocks panel at the top or in the middle", () => {
    const top = placementAdjust("top", "center", { widthPct: 90, heightPct: 100, rollup: false });
    expect(top.height).toBe("50vh");
    expect(top.note).toBe("Height set to 50 % so the panel can sit at the top.");
    const mid = placementAdjust("middle", "flex-start", {
      widthPct: 100,
      heightPct: 90,
      rollup: false,
    });
    expect(mid.width).toBe("65vw");
    expect(mid.height).toBe("50vh");
    expect(mid.note).toBe(
      "Width set to 65 % so a picture-in-picture camera fits on the right. Height set to 50 % so the panel can sit at the middle.",
    );
    // A roll-up strip or a short panel can sit anywhere.
    expect(
      placementAdjust("top", "center", { widthPct: 90, heightPct: 100, rollup: true }).height,
    ).toBeNull();
    expect(
      placementAdjust("top", "center", { widthPct: 90, heightPct: 89, rollup: false }).height,
    ).toBeNull();
  });

  it("gives the look its height back at the bottom when the height was automatic", () => {
    const r = placementAdjust("bottom", "center", {
      widthPct: 90,
      heightPct: 50,
      rollup: false,
      autoHeight: true,
    });
    expect(r.resetHeight).toBe(true);
    expect(r.note).toBe("Height back to the look's own size.");
    expect(
      placementAdjust("top", "center", {
        widthPct: 90,
        heightPct: 50,
        rollup: false,
        autoHeight: true,
      }).resetHeight,
    ).toBe(false);
  });

  it("explains in the given words", () => {
    setLang("nl");
    const r = placementAdjust(
      "top",
      "flex-end",
      { widthPct: 95, heightPct: 95, rollup: false },
      appPlacementLabels(),
    );
    expect(r.note).toBe(
      "Breedte op 65 % gezet, zodat er links een camerabeeld past. Hoogte op 50 % gezet, zodat het paneel bovenaan kan staan.",
    );
  });
});

describe("placement: the picker", () => {
  function parts(p: ReturnType<typeof placementPicker>) {
    const root = p.root;
    const cells = [...root.querySelectorAll<HTMLButtonElement>("button.plc-cell")];
    const panel = root.querySelector<HTMLElement>(".plc-panel");
    const readout = root.querySelector<HTMLElement>(".plc-readout");
    const note = root.querySelector<HTMLElement>(".plc-note");
    if (!panel || !readout || !note) throw new Error("picker incomplete");
    return { root, cells, panel, readout, note };
  }

  it("draws a mini screen with a labelled 3 × 3 grid", () => {
    const p = parts(placementPicker(() => undefined));
    expect(p.cells).toHaveLength(9);
    expect(p.cells.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Top · Left",
      "Top · Center",
      "Top · Right",
      "Middle · Left",
      "Middle · Center",
      "Middle · Right",
      "Bottom · Left",
      "Bottom · Center",
      "Bottom · Right",
    ]);
    expect(p.cells.every((c) => c.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(p.root.querySelector(".plc-grid")?.getAttribute("aria-label")).toBe(
      "Position on the screen",
    );
    expect([...p.root.querySelectorAll(".plc-cols span")].map((n) => n.textContent)).toEqual([
      "Left",
      "Center",
      "Right",
    ]);
    expect([...p.root.querySelectorAll(".plc-rows span")].map((n) => n.textContent)).toEqual([
      "Top",
      "Middle",
      "Bottom",
    ]);
    expect(p.readout.textContent).toBe("");
    expect(p.note.hidden).toBe(true);
  });

  it("reports the clicked place", () => {
    const onPick = vi.fn();
    const p = parts(placementPicker(onPick));
    p.cells[0]?.click();
    p.cells[5]?.click();
    p.cells[7]?.click();
    expect(onPick.mock.calls).toEqual([
      ["top", "flex-start"],
      ["middle", "flex-end"],
      ["bottom", "center"],
    ]);
  });

  it("outlines the panel where it sits and presses that cell", () => {
    const picker = placementPicker(() => undefined);
    const q = parts(picker);
    picker.set(view({ pos: "top", justify: "flex-start", widthPct: 65, heightPct: 50 }));
    expect(q.cells.map((c) => c.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    const box = (): string[] =>
      ["left", "top", "width", "height"].map((k) => q.panel.style.getPropertyValue(k));
    expect(box()).toEqual(["0%", "0%", "65%", "50%"]);
    expect(q.readout.textContent).toBe("Top · Left · 65 % wide");

    picker.set(view({ pos: "middle", justify: "center", widthPct: 60, heightPct: 40 }));
    expect(box()).toEqual(["20%", "30%", "60%", "40%"]);

    picker.set(view({ pos: "bottom", justify: "flex-end", widthPct: 70, heightPct: 30 }));
    expect(box()).toEqual(["30%", "70%", "70%", "30%"]);
    expect(q.cells[8]?.getAttribute("aria-pressed")).toBe("true");
    expect(q.panel.classList.contains("is-rollup")).toBe(false);
  });

  it("draws a roll-up as a strip and keeps sizes within the screen", () => {
    const picker = placementPicker(() => undefined);
    const q = parts(picker);
    picker.set(
      view({ pos: "bottom", justify: "center", widthPct: 140, heightPct: 2, rollup: true }),
    );
    const box = ["left", "top", "width", "height"].map((k) => q.panel.style.getPropertyValue(k));
    expect(box).toEqual(["0%", "76%", "100%", "24%"]);
    expect(q.panel.classList.contains("is-rollup")).toBe(true);
    expect(q.readout.textContent).toBe("Bottom · Center · 100 % wide");
    picker.set(view({ pos: "top", justify: "center", widthPct: 3, heightPct: 2 }));
    expect(q.panel.style.getPropertyValue("width")).toBe("8%");
    expect(q.panel.style.getPropertyValue("height")).toBe("8%");
    expect(q.readout.textContent).toBe("Top · Center · 8 % wide");
  });

  it("shows and hides the explanation", () => {
    const picker = placementPicker(() => undefined);
    const q = parts(picker);
    picker.note("Width set to 65 %.");
    expect(q.note.hidden).toBe(false);
    expect(q.note.textContent).toBe("Width set to 65 %.");
    picker.note(null);
    expect(q.note.hidden).toBe(true);
    expect(q.note.textContent).toBe("");
  });

  it("relabels in the current words after a language switch", () => {
    const picker = placementPicker(() => undefined, appPlacementLabels);
    const q = parts(picker);
    picker.set(view({ pos: "top", justify: "flex-end", widthPct: 64.6 }));
    expect(q.readout.textContent).toBe("Top · Right · 65 % wide");
    setLang("nl");
    picker.relabel();
    expect(q.readout.textContent).toBe("Boven · Rechts · 65 % breed");
    expect(q.cells[0]?.getAttribute("aria-label")).toBe("Boven · Links");
    expect(q.root.querySelector(".plc-grid")?.getAttribute("aria-label")).toBe(
      "Positie op het scherm",
    );
  });
});
