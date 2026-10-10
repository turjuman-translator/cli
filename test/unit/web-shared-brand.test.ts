// @vitest-environment happy-dom
// The Turjuman mark and wordmark (web/shared/brand.ts) as the app header draws them: an arch with
// two caption lines in the given colours, and the wordmark "Turjuman | ترجمان".
import { describe, expect, it } from "vitest";
import { ARCH_PATH, markSvg, ON_PINE, PINE, wordmarkHtml } from "../../web/shared/brand.js";

function parse(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  const node = host.firstElementChild;
  if (!node || host.childElementCount !== 1) throw new Error("not one element");
  return node;
}

describe("brand: the mark", () => {
  it("draws the arch and the two caption lines in pine by default, hidden from readers", () => {
    const svg = parse(markSvg());
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("class")).toBe("");
    expect(svg.getAttribute("viewBox")).toBe("8 1 48 63");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    const paths = [...svg.querySelectorAll("path")];
    expect(paths.map((p) => p.getAttribute("d"))).toEqual([ARCH_PATH, "M31 33H43", "M21 42H39"]);
    expect(paths.map((p) => p.getAttribute("stroke"))).toEqual([
      PINE.arch,
      PINE.arabic,
      PINE.translation,
    ]);
    expect(svg.querySelector("g")?.getAttribute("stroke-linecap")).toBe("round");
  });

  it("takes other colours and a class (white on pine)", () => {
    const svg = parse(markSvg(ON_PINE, "tj-mark"));
    expect(svg.getAttribute("class")).toBe("tj-mark");
    expect([...svg.querySelectorAll("path")].map((p) => p.getAttribute("stroke"))).toEqual([
      "#FFFFFF",
      "#8CCEB6",
      "#FFFFFF",
    ]);
  });
});

describe("brand: the wordmark", () => {
  it("puts the mark, the Latin name, a hairline and the Arabic name in one span", () => {
    const wm = parse(wordmarkHtml());
    expect(wm.getAttribute("class")).toBe("tj-wordmark");
    expect(wm.querySelector("svg")).not.toBeNull();
    expect(wm.querySelector(".tj-wm-lat")?.textContent).toBe("Turjuman");
    expect(wm.querySelector("i")?.getAttribute("aria-hidden")).toBe("true");
    const ar = wm.querySelector<HTMLElement>(".tj-wm-ar");
    expect(ar?.textContent).toBe("ترجمان");
    expect(ar?.lang).toBe("ar");
    expect(wm.textContent).toBe("Turjumanترجمان");
  });

  it("takes another class", () => {
    expect(parse(wordmarkHtml("site-wordmark")).getAttribute("class")).toBe("site-wordmark");
  });
});
