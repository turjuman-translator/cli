import { describe, expect, it } from "vitest";
import {
  alphaOf,
  BOX_SHADOWS,
  BUILTIN_PRESETS,
  colorToRgba,
  FONT_CHOICES,
  FONT_FIT_VW,
  fontSizeVar,
  parseColor,
  parseVarValue,
  rgbaToHex,
  sameVarValue,
  shortVarValue,
  TEXT_SHADOWS,
  withAlpha,
} from "../../src/shared/theme.js";
import { THEME_VARS } from "../../src/shared/theme-vars.js";

function stack(key: string): string {
  const f = FONT_CHOICES.find((c) => c.key === key);
  if (f === undefined) throw new Error(`no font ${key}`);
  return f.stack;
}

describe("fontSizeVar", () => {
  it("caps the base size at a share of the screen width", () => {
    expect(FONT_FIT_VW).toBe(5);
    expect(fontSizeVar(52)).toBe("min(52px, 5vw)");
    expect(fontSizeVar(51.25)).toBe("min(51.25px, 5vw)");
  });
});

describe("parseColor", () => {
  it("lower-cases hex, adds the # and expands the short forms", () => {
    expect(parseColor("#FFCC00")).toBe("#ffcc00");
    expect(parseColor("ffcc00")).toBe("#ffcc00");
    expect(parseColor("#fc0")).toBe("#ffcc00");
    expect(parseColor("fc08")).toBe("#ffcc0088");
    expect(parseColor(" ffcc0080 ")).toBe("#ffcc0080");
  });

  it("accepts currentcolor and the named colours", () => {
    expect(parseColor("currentColor")).toBe("currentcolor");
    expect(parseColor(" White ")).toBe("white");
    expect(parseColor("transparent")).toBe("transparent");
    expect(parseColor("navy")).toBe("navy");
  });

  it("writes rgb()/hsl() in one canonical form, comma or slash syntax", () => {
    expect(parseColor("RGB(255,204,0)")).toBe("rgb(255, 204, 0)");
    expect(parseColor("rgba(0,0,0,.6)")).toBe("rgba(0, 0, 0, 0.6)");
    expect(parseColor("rgba(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(parseColor("rgb(1, 2, 3, 0.5)")).toBe("rgba(1, 2, 3, 0.5)");
    expect(parseColor("rgb(0 0 0 / 60%)")).toBe("rgba(0, 0, 0, 60%)");
    expect(parseColor("rgb(0 0 0)")).toBe("rgb(0, 0, 0)");
    expect(parseColor("rgb(-0, 0.50, 0)")).toBe("rgb(0, 0.5, 0)");
    expect(parseColor("hsl(42, 80%, 55%)")).toBe("hsl(42, 80%, 55%)");
    expect(parseColor("hsl(120deg 100% 50% / 0.5)")).toBe("hsla(120deg, 100%, 50%, 0.5)");
  });

  it("refuses empty, over-long and unsafe text", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("   ")).toBeNull();
    expect(parseColor(`rgb(${"1".repeat(80)}, 0, 0)`)).toBeNull();
    expect(parseColor("red;")).toBeNull();
    expect(parseColor('rgb(0,0,0)"')).toBeNull();
    expect(parseColor("url(x)")).toBeNull();
    expect(parseColor("#ggg")).toBeNull();
    expect(parseColor("chartreuse")).toBeNull();
  });

  it("refuses functions with the wrong arguments", () => {
    expect(parseColor("rgb(1, 2)")).toBeNull();
    expect(parseColor("rgb(1, 2, 3, 4, 5)")).toBeNull();
    expect(parseColor("rgb(1 2 3 / 0.5 / 1)")).toBeNull();
    expect(parseColor("rgb(a, b, c)")).toBeNull();
    expect(parseColor("rgb(1px, 2, 3)")).toBeNull();
    expect(parseColor("rgb(10deg, 0, 0)")).toBeNull();
    expect(parseColor("hsl(0, 10deg, 0)")).toBeNull();
    expect(parseColor("rgb(400, 0, 0)")).toBeNull();
    expect(parseColor("hsl(-361, 0%, 0%)")).toBeNull();
  });

  it("checks the alpha: 0–1, or 0–100 %", () => {
    expect(parseColor("rgba(0, 0, 0, 50%)")).toBe("rgba(0, 0, 0, 50%)");
    expect(parseColor("rgba(0, 0, 0, 2)")).toBeNull();
    expect(parseColor("rgba(0, 0, 0, 150%)")).toBeNull();
    expect(parseColor("rgba(0, 0, 0, -0.1)")).toBeNull();
    expect(parseColor("rgba(0, 0, 0, 1deg)")).toBeNull();
    expect(parseColor("rgba(0, 0, 0, x)")).toBeNull();
  });
});

describe("colorToRgba", () => {
  it("reads hex, named and transparent colours", () => {
    expect(colorToRgba("#fc0")).toEqual({ r: 255, g: 204, b: 0, a: 1 });
    expect(colorToRgba("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
    expect(colorToRgba("gold")).toEqual({ r: 255, g: 215, b: 0, a: 1 });
    expect(colorToRgba("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("reads rgb() with percentages and clamps the channels", () => {
    expect(colorToRgba("rgba(17, 17, 17, 0.92)")).toEqual({ r: 17, g: 17, b: 17, a: 0.92 });
    expect(colorToRgba("rgb(300, -5, 50%)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
    expect(colorToRgba("rgb(0 0 0 / 60%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.6 });
  });

  it("converts hsl() to RGB, any hue and with or without %", () => {
    expect(colorToRgba("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(colorToRgba("hsl(120, 100%, 50%)")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(colorToRgba("hsl(240deg 100% 50%)")).toEqual({ r: 0, g: 0, b: 255, a: 1 });
    expect(colorToRgba("hsl(-120, 100%, 50%)")).toEqual({ r: 0, g: 0, b: 255, a: 1 });
    expect(colorToRgba("hsl(0, 100%, 25%)")).toEqual({ r: 128, g: 0, b: 0, a: 1 });
    expect(colorToRgba("hsl(0, 100, 50)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(colorToRgba("hsla(0, 0%, 100%, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
  });

  it("has no components for currentcolor, gradients and invalid text", () => {
    expect(colorToRgba("currentcolor")).toBeNull();
    expect(colorToRgba("linear-gradient(red, blue)")).toBeNull();
    expect(colorToRgba("none")).toBeNull();
  });
});

describe("rgbaToHex", () => {
  it("writes 6 digits when opaque and 8 with an alpha", () => {
    expect(rgbaToHex({ r: 255, g: 204, b: 0, a: 1 })).toBe("#ffcc00");
    expect(rgbaToHex({ r: 255, g: 204, b: 0, a: 0.9995 })).toBe("#ffcc00");
    expect(rgbaToHex({ r: 255, g: 204, b: 0, a: 0.5 })).toBe("#ffcc0080");
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 0 })).toBe("#00000000");
  });

  it("rounds and clamps the channels", () => {
    expect(rgbaToHex({ r: 300, g: -4, b: 12.4, a: 1 })).toBe("#ff000c");
  });
});

describe("parseVarValue: colours and backgrounds", () => {
  it("canonicalizes colours and refuses everything else", () => {
    expect(parseVarValue("--cap-text-color", "FFCC00")).toBe("#ffcc00");
    expect(parseVarValue("--cap-hon-color", "currentColor")).toBe("currentcolor");
    expect(parseVarValue("--cap-text-color", "none")).toBeNull();
    expect(parseVarValue("--cap-text-color", "inherit")).toBeNull();
  });

  it("accepts none, a colour or a gradient as a background", () => {
    expect(parseVarValue("--cap-panel-bg", "none")).toBe("none");
    expect(parseVarValue("--cap-panel-bg", "#000")).toBe("#000000");
    expect(
      parseVarValue("--cap-page-bg", "linear-gradient(to top, rgba(0,0,0,.8), transparent 70%)"),
    ).toBe("linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent 70%)");
  });

  it("accepts linear gradients with an angle, a side, a corner or no direction", () => {
    const bg = (v: string) => parseVarValue("--cap-block-bg", v);
    expect(bg("linear-gradient(45deg, red, blue)")).toBe("linear-gradient(45deg, red, blue)");
    expect(bg("linear-gradient(0.250turn, #fff 0, #000 100%)")).toBe(
      "linear-gradient(0.25turn, #ffffff 0%, #000000 100%)",
    );
    expect(bg("Linear-Gradient(to   bottom   right, red, blue)")).toBe(
      "linear-gradient(to bottom right, red, blue)",
    );
    expect(bg("linear-gradient(red, blue)")).toBe("linear-gradient(red, blue)");
    expect(bg("linear-gradient(red 10% 20%, blue 10px)")).toBe(
      "linear-gradient(red 10% 20%, blue 10px)",
    );
  });

  it("accepts radial gradients with a shape and a position", () => {
    const bg = (v: string) => parseVarValue("--cap-event-bg", v);
    expect(bg("radial-gradient(circle at top left, gold, transparent 60%)")).toBe(
      "radial-gradient(circle at top left, gold, transparent 60%)",
    );
    expect(bg("radial-gradient(ellipse, red, blue)")).toBe("radial-gradient(ellipse, red, blue)");
    expect(bg("radial-gradient(at center, red, blue)")).toBe(
      "radial-gradient(at center, red, blue)",
    );
    expect(bg("radial-gradient(red, blue)")).toBe("radial-gradient(red, blue)");
  });

  it("refuses gradients it cannot vouch for", () => {
    const bg = (v: string) => parseVarValue("--cap-toolbar-bg", v);
    const stops = (n: number) => Array.from({ length: n }, () => "red").join(", ");
    // At most 8 colour stops, with or without a direction.
    expect(bg(`linear-gradient(${stops(8)})`)).not.toBeNull();
    expect(bg(`linear-gradient(to top, ${stops(8)})`)).not.toBeNull();
    expect(bg(`radial-gradient(circle, ${stops(8)})`)).not.toBeNull();
    expect(bg(`linear-gradient(${stops(9)})`)).toBeNull();
    expect(bg(`linear-gradient(to top, ${stops(9)})`)).toBeNull();
    expect(bg(`linear-gradient(${stops(10)})`)).toBeNull();
    expect(bg("linear-gradient(red)")).toBeNull();
    expect(bg("linear-gradient(45deg, red)")).toBeNull();
    expect(bg("linear-gradient(red, blue 300%)")).toBeNull();
    expect(bg("linear-gradient(red, blue 5em)")).toBeNull();
    expect(bg("linear-gradient(red 1% 2% 3%, blue)")).toBeNull();
    expect(bg("linear-gradient(red, nope)")).toBeNull();
    expect(bg("linear-gradient(to middle, red, blue)")).toBeNull();
    expect(bg("linear-gradient(red, blue))")).toBeNull();
    expect(bg("linear-gradient((red, blue)")).toBeNull();
    expect(bg("radial-gradient(, red, blue)")).toBeNull();
    expect(bg("conic-gradient(red, blue)")).toBeNull();
    expect(bg("linear-gradient(red, url(x))")).toBeNull();
  });
});

describe("parseVarValue: lengths and numbers", () => {
  it("gives bare numbers the variable's unit and checks its range", () => {
    expect(parseVarValue("--cap-block-radius", "12")).toBe("12px");
    expect(parseVarValue("--cap-block-radius", "12PX")).toBe("12px");
    expect(parseVarValue("--cap-block-radius", "201")).toBeNull();
    expect(parseVarValue("--cap-block-radius", "-1")).toBeNull();
    expect(parseVarValue("--cap-panel-width", "70")).toBe("70vw");
    expect(parseVarValue("--cap-panel-width", "4")).toBeNull();
    expect(parseVarValue("--cap-panel-height", "+50.0")).toBe("50vh");
  });

  it("accepts other units up to a sane cap", () => {
    expect(parseVarValue("--cap-block-radius", "1.50em")).toBe("1.5em");
    expect(parseVarValue("--cap-block-radius", "101em")).toBeNull();
    expect(parseVarValue("--cap-panel-width", "800px")).toBe("800px");
    expect(parseVarValue("--cap-panel-width", "5000px")).toBeNull();
    expect(parseVarValue("--cap-block-radius", "12pt")).toBeNull();
    expect(parseVarValue("--cap-block-radius", "abc")).toBeNull();
  });

  it("allows negative letter spacing within the range", () => {
    expect(parseVarValue("--cap-letter-spacing", "-2")).toBe("-2px");
    expect(parseVarValue("--cap-letter-spacing", "-0.5em")).toBe("-0.5em");
    expect(parseVarValue("--cap-letter-spacing", "-11em")).toBeNull();
    expect(parseVarValue("--cap-letter-spacing", "21")).toBeNull();
  });

  it("keeps the honorific scale in em", () => {
    expect(parseVarValue("--cap-hon-scale", "1.3")).toBe("1.3em");
    expect(parseVarValue("--cap-hon-scale", "1.3px")).toBeNull();
    expect(parseVarValue("--cap-hon-scale", "3")).toBeNull();
  });

  it("takes one or two padding lengths", () => {
    expect(parseVarValue("--cap-block-padding", "14 22")).toBe("14px 22px");
    expect(parseVarValue("--cap-block-padding", "14")).toBe("14px");
    expect(parseVarValue("--cap-block-padding", "1em 2%")).toBe("1em 2%");
    expect(parseVarValue("--cap-block-padding", "1 2 3")).toBeNull();
    expect(parseVarValue("--cap-block-padding", "1 x")).toBeNull();
    expect(parseVarValue("--cap-block-padding", "300")).toBeNull();
  });

  it("reads percentages for the fade", () => {
    expect(parseVarValue("--cap-fade-mask", "18")).toBe("18%");
    expect(parseVarValue("--cap-fade-mask", "81")).toBeNull();
    expect(parseVarValue("--cap-fade-mask", "18px")).toBeNull();
  });

  it("reads plain numbers within their range", () => {
    expect(parseVarValue("--cap-old-opacity", ".5")).toBe("0.5");
    expect(parseVarValue("--cap-old-opacity", "0.850")).toBe("0.85");
    expect(parseVarValue("--cap-old-opacity", "1.5")).toBeNull();
    expect(parseVarValue("--cap-old-opacity", "1e0")).toBeNull();
    expect(parseVarValue("--cap-new-scale", "0.8")).toBeNull();
  });

  it("reads font weights as 100–900 or normal/bold", () => {
    expect(parseVarValue("--cap-font-weight", "bold")).toBe("700");
    expect(parseVarValue("--cap-font-weight", "Normal")).toBe("400");
    expect(parseVarValue("--cap-ref-weight", "650")).toBe("650");
    expect(parseVarValue("--cap-font-weight", "50")).toBeNull();
    expect(parseVarValue("--cap-font-weight", "950")).toBeNull();
    expect(parseVarValue("--cap-font-weight", "500.5")).toBeNull();
    expect(parseVarValue("--cap-font-weight", "heavy")).toBeNull();
  });

  it("reads the line length in ch, or none", () => {
    for (const none of ["none", "0", "0ch"])
      expect(parseVarValue("--cap-max-chars", none)).toBe("none");
    expect(parseVarValue("--cap-max-chars", "42")).toBe("42ch");
    expect(parseVarValue("--cap-max-chars", "9")).toBeNull();
    expect(parseVarValue("--cap-max-chars", "201")).toBeNull();
    expect(parseVarValue("--cap-max-chars", "42px")).toBeNull();
  });

  it("reads durations in ms (bare) or s, up to 5 seconds", () => {
    expect(parseVarValue("--cap-anim-duration", "200")).toBe("200ms");
    expect(parseVarValue("--cap-anim-duration", "0")).toBe("0ms");
    expect(parseVarValue("--cap-anim-duration", "0.2s")).toBe("0.2s");
    expect(parseVarValue("--cap-anim-duration", "5s")).toBe("5s");
    expect(parseVarValue("--cap-anim-duration", "6s")).toBeNull();
    expect(parseVarValue("--cap-anim-duration", "5001")).toBeNull();
    expect(parseVarValue("--cap-anim-duration", "-1")).toBeNull();
    expect(parseVarValue("--cap-anim-duration", "1m")).toBeNull();
  });

  it("reads the font size as px or as min(px, vw)", () => {
    expect(parseVarValue("--cap-font-size", "min(52px, 5vw)")).toBe("min(52px, 5vw)");
    expect(parseVarValue("--cap-font-size", "min(52,5)")).toBe("min(52px, 5vw)");
    expect(parseVarValue("--cap-font-size", "min(52px, 300px)")).toBe("min(52px, 300px)");
    expect(parseVarValue("--cap-font-size", "min(4px, 5vw)")).toBeNull();
    expect(parseVarValue("--cap-font-size", "min(52px, 5em)")).toBeNull();
    expect(parseVarValue("--cap-font-size", "52")).toBe("52px");
    expect(parseVarValue("--cap-font-size", "7")).toBeNull();
    expect(parseVarValue("--cap-font-size", "301px")).toBeNull();
  });
});

describe("parseVarValue: keywords, shadows, borders and fonts", () => {
  it("maps the horizontal placement words", () => {
    const justify = (v: string) => parseVarValue("--cap-panel-justify", v);
    for (const v of ["left", "start", "flex-start"]) expect(justify(v)).toBe("flex-start");
    for (const v of ["center", "centre", "Middle"]) expect(justify(v)).toBe("center");
    for (const v of ["right", "end", "flex-end"]) expect(justify(v)).toBe("flex-end");
    expect(justify("space-between")).toBeNull();
  });

  it("accepts the text-align keywords only", () => {
    expect(parseVarValue("--cap-text-align", "Center")).toBe("center");
    expect(parseVarValue("--cap-text-align", "justify")).toBe("justify");
    expect(parseVarValue("--cap-text-align", "middle")).toBeNull();
  });

  it("expands the text shadow keywords and canonicalizes raw text shadows", () => {
    const shadow = (v: string) => parseVarValue("--cap-text-shadow", v);
    expect(shadow("strong")).toBe(TEXT_SHADOWS.strong);
    expect(shadow("outline")).toBe(TEXT_SHADOWS.outline);
    expect(shadow("0 1px 3px rgba(0,0,0,.5)")).toBe("0 1px 3px rgba(0, 0, 0, 0.5)");
    expect(shadow("0px 0px 4px red, 1px 1px")).toBe("0 0 4px red, 1px 1px");
    expect(shadow("red 1em 2rem")).toBe("1em 2rem red");
  });

  it("refuses text shadows with box-only parts or the wrong number of lengths", () => {
    const shadow = (v: string) => parseVarValue("--cap-text-shadow", v);
    expect(shadow("inset 0 0 4px red")).toBeNull();
    expect(shadow("1 2 3 4")).toBeNull();
    expect(shadow("1px")).toBeNull();
    expect(shadow("1px 2px red blue")).toBeNull();
    expect(shadow("0 0 red,")).toBeNull();
    expect(shadow("0 0 red)")).toBeNull();
    expect(shadow("0 0 (red")).toBeNull();
    expect(shadow(Array.from({ length: 7 }, () => "0 0 red").join(", "))).toBeNull();
    expect(shadow("medium")).toBeNull();
  });

  it("accepts box shadows with inset and a spread", () => {
    const shadow = (v: string) => parseVarValue("--cap-panel-shadow", v);
    expect(shadow("soft")).toBe(BOX_SHADOWS.soft);
    expect(shadow("inset 0 2px 4px 1px #000")).toBe("inset 0 2px 4px 1px #000000");
    expect(shadow("inset inset 0 0")).toBeNull();
    expect(shadow("1 2 3 4 5")).toBeNull();
    expect(shadow("outline")).toBeNull();
  });

  it("reads borders as width, style and colour in any order", () => {
    const border = (v: string) => parseVarValue("--cap-block-border", v);
    for (const none of ["none", "0", "0px"]) expect(border(none)).toBe("none");
    expect(border("2px")).toBe("2px solid currentcolor");
    expect(border("2 dashed gold")).toBe("2px dashed gold");
    expect(border("red 1px")).toBe("1px solid red");
    expect(border("1em double red")).toBe("1em double red");
  });

  it("refuses borders with repeated or missing parts", () => {
    const border = (v: string) => parseVarValue("--cap-block-border", v);
    expect(border("1px solid red blue")).toBeNull();
    expect(border("1px 2px")).toBeNull();
    expect(border("solid red")).toBeNull();
    expect(border("solid dotted 1px")).toBeNull();
    expect(border("21px")).toBeNull();
    expect(border("1px solid red;")).toBeNull();
    expect(border("1px (")).toBeNull();
  });

  it("allows only the font stacks of the allow-list, by key, label or stack", () => {
    const font = (v: string) => parseVarValue("--cap-font-family", v);
    expect(font("georgia")).toBe(stack("georgia"));
    expect(font("  Noto   Sans ")).toBe(stack("noto-sans"));
    expect(font("noto-naskh-arabic")).toBe(stack("naskh"));
    expect(font(stack("amiri-quran"))).toBe(stack("amiri-quran"));
    expect(font("Comic Sans")).toBeNull();
    expect(font("url(evil)")).toBeNull();
  });

  it("keeps Noto Naskh Arabic in every Latin stack, ahead of the generic family", () => {
    for (const f of FONT_CHOICES) {
      const parts = f.stack.split(", ");
      expect(parts).toContain('"Noto Naskh Arabic"');
      expect(parts.indexOf('"Noto Naskh Arabic"')).toBeLessThan(parts.length - 1);
    }
  });
});

describe("parseVarValue: untrusted input", () => {
  it("refuses empty, over-long and unsafe values", () => {
    expect(parseVarValue("--cap-text-color", "")).toBeNull();
    expect(parseVarValue("--cap-text-color", "   ")).toBeNull();
    expect(parseVarValue("--cap-font-family", "g".repeat(301))).toBeNull();
    expect(parseVarValue("--cap-text-color", "red; background: url(x)")).toBeNull();
    expect(parseVarValue("--cap-panel-bg", "red}body{color:red")).toBeNull();
  });

  it("refuses values that are not strings (JSON from presets.yaml or the API)", () => {
    const fromJson = JSON.parse('{"v": 12}') as { v: string };
    expect(parseVarValue("--cap-block-radius", fromJson.v)).toBeNull();
  });

  it("is idempotent on every built-in value", () => {
    for (const p of BUILTIN_PRESETS) {
      for (const name of THEME_VARS) {
        const v = p.vars[name];
        expect(v, `${p.id} ${name}`).toBeDefined();
        expect(parseVarValue(name, v ?? ""), `${p.id} ${name}`).toBe(v);
      }
    }
  });
});

describe("shortVarValue", () => {
  it("drops the # of hex colours and keeps other colours", () => {
    expect(shortVarValue("--cap-text-color", "#ffcc00")).toBe("ffcc00");
    expect(shortVarValue("--cap-text-color", "#ffcc0080")).toBe("ffcc0080");
    expect(shortVarValue("--cap-text-color", "rgba(0, 0, 0, 0.5)")).toBe("rgba(0, 0, 0, 0.5)");
    expect(shortVarValue("--cap-panel-bg", "#000000")).toBe("000000");
    expect(shortVarValue("--cap-panel-bg", "linear-gradient(red, blue)")).toBe(
      "linear-gradient(red, blue)",
    );
  });

  it("drops the variable's own unit only", () => {
    expect(shortVarValue("--cap-block-radius", "12px")).toBe("12");
    expect(shortVarValue("--cap-block-radius", "1.5em")).toBe("1.5em");
    expect(shortVarValue("--cap-panel-width", "70vw")).toBe("70");
    expect(shortVarValue("--cap-panel-width", "800px")).toBe("800px");
    expect(shortVarValue("--cap-block-padding", "14px 22px")).toBe("14 22");
    expect(shortVarValue("--cap-block-padding", "1em 2px")).toBe("1em 2");
    expect(shortVarValue("--cap-fade-mask", "18%")).toBe("18");
    expect(shortVarValue("--cap-fade-mask", "18")).toBe("18");
    expect(shortVarValue("--cap-max-chars", "42ch")).toBe("42");
    expect(shortVarValue("--cap-max-chars", "none")).toBe("none");
    expect(shortVarValue("--cap-anim-duration", "200ms")).toBe("200");
    expect(shortVarValue("--cap-anim-duration", "0.2s")).toBe("0.2s");
  });

  it("uses font keys, placement words and shadow keywords", () => {
    expect(shortVarValue("--cap-font-family", stack("georgia"))).toBe("georgia");
    expect(shortVarValue("--cap-font-family", "Papyrus")).toBe("Papyrus");
    expect(shortVarValue("--cap-panel-justify", "flex-start")).toBe("left");
    expect(shortVarValue("--cap-panel-justify", "flex-end")).toBe("right");
    expect(shortVarValue("--cap-panel-justify", "center")).toBe("center");
    expect(shortVarValue("--cap-text-shadow", TEXT_SHADOWS.outline ?? "")).toBe("outline");
    expect(shortVarValue("--cap-panel-shadow", BOX_SHADOWS.glow ?? "")).toBe("glow");
    expect(shortVarValue("--cap-text-shadow", "0 0 4px red")).toBe("0 0 4px red");
  });

  it("leaves numbers, weights, borders and the font size as they are", () => {
    expect(shortVarValue("--cap-font-weight", "600")).toBe("600");
    expect(shortVarValue("--cap-line-height", "1.35")).toBe("1.35");
    expect(shortVarValue("--cap-block-border", "1px solid red")).toBe("1px solid red");
    expect(shortVarValue("--cap-font-size", "min(52px, 5vw)")).toBe("min(52px, 5vw)");
  });

  it("gives a short form that parses back to the same value, for every built-in value", () => {
    for (const p of BUILTIN_PRESETS) {
      for (const name of THEME_VARS) {
        const v = p.vars[name] ?? "";
        expect(parseVarValue(name, shortVarValue(name, v)), `${p.id} ${name}`).toBe(v);
      }
    }
  });
});

describe("sameVarValue", () => {
  it("compares colours by their RGBA", () => {
    expect(sameVarValue("--cap-panel-bg", "rgba(17, 17, 17, 0.92)", "#111111eb")).toBe(true);
    expect(sameVarValue("--cap-text-color", "#fff", "white")).toBe(true);
    expect(sameVarValue("--cap-text-color", "#fff", "#fffffe")).toBe(false);
    expect(sameVarValue("--cap-text-color", "#ffffff", "#ffffff00")).toBe(false);
    expect(sameVarValue("--cap-text-color", "currentColor", "currentcolor")).toBe(true);
    expect(sameVarValue("--cap-text-color", "currentcolor", "#000000")).toBe(false);
    expect(sameVarValue("--cap-panel-bg", "none", "transparent")).toBe(false);
    expect(sameVarValue("--cap-panel-bg", "linear-gradient(red, blue)", "red")).toBe(false);
  });

  it("compares other values in canonical form", () => {
    expect(sameVarValue("--cap-block-radius", "12", "12px")).toBe(true);
    expect(sameVarValue("--cap-block-radius", "12", "13")).toBe(false);
    expect(sameVarValue("--cap-font-family", "georgia", stack("georgia"))).toBe(true);
  });

  it("treats missing and invalid values alike", () => {
    expect(sameVarValue("--cap-block-radius", undefined, undefined)).toBe(true);
    expect(sameVarValue("--cap-block-radius", "12px", undefined)).toBe(false);
    expect(sameVarValue("--cap-block-radius", undefined, "12px")).toBe(false);
    expect(sameVarValue("--cap-block-radius", "abc", "12px")).toBe(false);
    // Both would be dropped, so the theme is the same either way.
    expect(sameVarValue("--cap-block-radius", "abc", "xyz")).toBe(true);
  });
});

describe("alphaOf", () => {
  it("is the alpha of a plain colour", () => {
    expect(alphaOf("rgba(17, 17, 17, 0.92)")).toBe(0.92);
    expect(alphaOf("#ffffff80")).toBe(128 / 255);
    expect(alphaOf("gold")).toBe(1);
    expect(alphaOf("transparent")).toBe(0);
  });

  it("is null for anything that is not a plain colour", () => {
    expect(alphaOf(undefined)).toBeNull();
    expect(alphaOf("none")).toBeNull();
    expect(alphaOf("currentcolor")).toBeNull();
    expect(alphaOf("linear-gradient(red, blue)")).toBeNull();
  });
});

describe("withAlpha", () => {
  it("keeps the RGB and sets the alpha", () => {
    expect(withAlpha("#203040", 0.8)).toBe("rgba(32, 48, 64, 0.8)");
    expect(withAlpha("rgba(17, 17, 17, 0.92)", 1)).toBe("rgba(17, 17, 17, 1)");
    expect(withAlpha("hsl(0, 100%, 50%)", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withAlpha("#fff", 0.12345)).toBe("rgba(255, 255, 255, 0.123)");
  });

  it("clamps the alpha to 0–1", () => {
    expect(withAlpha("#fff", 1.5)).toBe("rgba(255, 255, 255, 1)");
    expect(withAlpha("#fff", -1)).toBe("rgba(255, 255, 255, 0)");
  });

  it("leaves transparent alone and refuses what has no RGB or no finite alpha", () => {
    expect(withAlpha("transparent", 0.5)).toBe("transparent");
    expect(withAlpha("currentcolor", 0.5)).toBeNull();
    expect(withAlpha("none", 0.5)).toBeNull();
    expect(withAlpha("linear-gradient(red, blue)", 0.5)).toBeNull();
    expect(withAlpha("#fff", Number.NaN)).toBeNull();
    expect(withAlpha("transparent", Number.POSITIVE_INFINITY)).toBeNull();
  });
});
