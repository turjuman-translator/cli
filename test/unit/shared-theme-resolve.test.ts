import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  DEFAULT_VARS,
  FONT_CHOICES,
  resolveTheme,
  sameVarValue,
  type ThemeVars,
  themeQuery,
} from "../../src/shared/theme.js";
import { type DisplayOptions, THEME_VARS, type ThemePreset } from "../../src/shared/theme-vars.js";

const resolve = (query: string, custom: ThemePreset[] = [], defaultId?: string) =>
  resolveTheme(new URLSearchParams(query), custom, defaultId);

function custom(id: string, extra: Partial<ThemePreset> = {}): ThemePreset {
  return { id, name: id, description: "", vars: {}, options: {}, ...extra };
}

const georgia = FONT_CHOICES.find((f) => f.key === "georgia")?.stack;

describe("resolveTheme: which preset", () => {
  it("is mosque-dark with the default options when the link has no parameters", () => {
    const t = resolve("");
    expect(t.presetId).toBe("mosque-dark");
    expect(t.vars).toEqual(DEFAULT_VARS);
    expect(t.options).toEqual({ ...DEFAULT_OPTIONS, partial: false, show: "target" });
  });

  it("uses ?preset=, else the server default, else mosque-dark", () => {
    expect(resolve("preset=cinema", [], "glass").presetId).toBe("cinema");
    expect(resolve("", [], "glass").presetId).toBe("glass");
    expect(resolve("preset=nope", [], "glass").presetId).toBe("glass");
    expect(resolve("preset=nope", [], "gone").presetId).toBe("mosque-dark");
    expect(resolve("preset=", [], "gone").presetId).toBe("mosque-dark");
  });

  it("finds custom presets, sanitizes them and never lets them replace a built-in", () => {
    const mine = custom("friday", {
      vars: { "--cap-text-color": "#ffe08a", "--cap-block-bg": "red;}" },
      options: { size: 56, pos: "top" },
    });
    const t = resolve("preset=friday", [
      mine,
      custom("glass", { vars: { "--cap-text-color": "red" } }),
    ]);
    expect(t.presetId).toBe("friday");
    expect(t.vars["--cap-text-color"]).toBe("#ffe08a");
    expect(t.vars["--cap-block-bg"]).toBe(DEFAULT_VARS["--cap-block-bg"]);
    expect(t.vars["--cap-font-size"]).toBe("min(56px, 5vw)");
    expect(t.options.pos).toBe("top");
    expect(resolve("", [mine], "friday").presetId).toBe("friday");
    expect(
      resolve("preset=glass", [custom("glass", { vars: { "--cap-text-color": "red" } })]).vars,
    ).toMatchObject({
      "--cap-text-color": "#ffffff",
    });
  });
});

describe("resolveTheme: URL parameters", () => {
  it("reads parameter names case-insensitively and lets the first value win", () => {
    const t = resolve("PRESET=Glass&FG=FFCC00&fg=00ff00&Size=60&size=70");
    expect(t.presetId).toBe("glass");
    expect(t.vars["--cap-text-color"]).toBe("#ffcc00");
    expect(t.options.size).toBe(60);
    expect(t.vars["--cap-font-size"]).toBe("min(60px, 5vw)");
  });

  it("reads the display options, with the visible alias, and drops invalid ones", () => {
    const t = resolve(
      "visible=2&history=0&quranArabic=no&pos=top&lines=3&maxBlocks=9999&layout=grid&size=abc&toolbar=yes",
    );
    expect(t.options).toMatchObject({
      visibleBlocks: 2,
      history: false,
      quranArabic: false,
      pos: "top",
      lines: 3,
      maxBlocks: 500,
      layout: "blocks",
      size: 52,
      toolbar: "on",
    });
    expect(resolve("visibleBlocks=3&visible=2").options.visibleBlocks).toBe(3);
  });

  it("canonicalizes the look parameters and silently drops invalid ones", () => {
    const t = resolve(
      "fg=ffcc00&radius=16&font=georgia&pad=10+20&shadow=outline&maxChars=none&blockBg=javascript:alert(1)&width=900",
    );
    expect(t.vars).toMatchObject({
      "--cap-text-color": "#ffcc00",
      "--cap-block-radius": "16px",
      "--cap-font-family": georgia,
      "--cap-block-padding": "10px 20px",
      "--cap-max-chars": "none",
      "--cap-block-bg": DEFAULT_VARS["--cap-block-bg"],
      "--cap-panel-width": DEFAULT_VARS["--cap-panel-width"],
    });
  });

  it("sets the font size only through the size option", () => {
    expect(resolve("size=min(10px,5vw)").vars["--cap-font-size"]).toBe("min(52px, 5vw)");
    expect(resolve("size=1000").vars["--cap-font-size"]).toBe("min(300px, 5vw)");
  });
});

describe("resolveTheme: layouts", () => {
  it("switching to the roll-up brings its band, both languages and live partials", () => {
    expect(resolve("layout=rollup").options).toMatchObject({
      layout: "rollup",
      bg: "band",
      show: "both",
      partial: true,
    });
  });

  it("keeps a background, show and partial that the link sets with the layout", () => {
    expect(resolve("layout=rollup&bg=shadow&show=target&partial=0").options).toMatchObject({
      layout: "rollup",
      bg: "shadow",
      show: "target",
      partial: false,
    });
    expect(resolve("layout=rollup&bg=panel").options.bg).toBe("band");
  });

  it("switching a roll-up preset to blocks brings the panel, keeping what the preset set", () => {
    expect(resolve("preset=lower-third&layout=blocks").options).toMatchObject({
      layout: "blocks",
      bg: "panel",
      show: "both",
      partial: false,
    });
    expect(resolve("preset=cinema&layout=blocks&bg=shadow").options.bg).toBe("none");
    expect(resolve("preset=cinema&bg=none").options.bg).toBe("none");
  });

  it("leaves the preset's background alone when the link repeats the preset's layout", () => {
    expect(resolve("preset=minimal-transparent&layout=blocks").options.bg).toBe("none");
    expect(resolve("bg=band").options.bg).toBe("panel");
  });
});

describe("resolveTheme: background opacity", () => {
  it("panelOpacity sets only the alpha of the panel colour", () => {
    expect(resolve("panelOpacity=100").vars["--cap-panel-bg"]).toBe("rgba(17, 17, 17, 1)");
    expect(resolve("panelOpacity=80%25").vars["--cap-panel-bg"]).toBe("rgba(17, 17, 17, 0.8)");
    expect(resolve("panelOpacity=+12.5+").vars["--cap-panel-bg"]).toBe("rgba(17, 17, 17, 0.125)");
  });

  it("applies after the colour parameter", () => {
    expect(resolve("panelBg=203040&panelOpacity=80").vars["--cap-panel-bg"]).toBe(
      "rgba(32, 48, 64, 0.8)",
    );
  });

  it("blockOpacity reaches both block backgrounds", () => {
    const t = resolve("blockOpacity=50");
    expect(t.vars["--cap-block-bg"]).toBe("rgba(28, 28, 32, 0.5)");
    expect(t.vars["--cap-block-bg-new"]).toBe("rgba(43, 43, 48, 0.5)");
    expect(t.vars["--cap-panel-bg"]).toBe(DEFAULT_VARS["--cap-panel-bg"]);
  });

  it("leaves transparent, none and gradient backgrounds alone", () => {
    const t = resolve("preset=minimal-transparent&blockOpacity=50&panelOpacity=50");
    expect(t.vars["--cap-block-bg"]).toBe("transparent");
    expect(t.vars["--cap-panel-bg"]).toBe("transparent");
    expect(resolve("panelBg=none&panelOpacity=50").vars["--cap-panel-bg"]).toBe("none");
    expect(
      resolve("panelBg=linear-gradient(red,blue)&panelOpacity=50").vars["--cap-panel-bg"],
    ).toBe("linear-gradient(red, blue)");
  });

  it("ignores opacity values outside 0–100 or that are not numbers", () => {
    for (const bad of ["150", "-10", "abc", "", "1e2"]) {
      expect(resolve(`panelOpacity=${bad}`).vars["--cap-panel-bg"], bad).toBe(
        DEFAULT_VARS["--cap-panel-bg"],
      );
    }
  });
});

describe("themeQuery", () => {
  it("is empty for the default look", () => {
    expect(themeQuery("mosque-dark", {}, {})).toBe("");
    expect(themeQuery("glass", {}, {}, { defaultPreset: "glass" })).toBe("");
    expect(themeQuery("nope", {}, {})).toBe("");
  });

  it("names the preset when it is not the server default", () => {
    expect(themeQuery("glass", {}, {})).toBe("preset=glass");
    expect(themeQuery("mosque-dark", {}, {}, { defaultPreset: "glass" })).toBe(
      "preset=mosque-dark",
    );
    expect(themeQuery("friday", {}, {}, { custom: [custom("friday")] })).toBe("preset=friday");
  });

  it("writes only the options that differ from the preset", () => {
    expect(themeQuery("glass", {}, { size: 46, layout: "blocks" })).toBe("preset=glass");
    expect(themeQuery("glass", {}, { size: 60, history: false })).toBe(
      "preset=glass&history=0&size=60",
    );
    expect(themeQuery("minimal-transparent", {}, { quranAccent: true })).toBe(
      "preset=minimal-transparent&quranAccent=1",
    );
    expect(
      themeQuery("mosque-dark", {}, { visibleBlocks: 3, toolbar: "off", size: Number.NaN }),
    ).toBe("visibleBlocks=3&toolbar=off");
  });

  it("compares with what the new layout brings when the layout changes", () => {
    expect(themeQuery("mosque-dark", {}, { layout: "rollup" })).toBe("layout=rollup");
    expect(
      themeQuery("mosque-dark", {}, { layout: "rollup", bg: "band", show: "both", partial: true }),
    ).toBe("layout=rollup");
    expect(themeQuery("mosque-dark", {}, { layout: "rollup", bg: "shadow", partial: false })).toBe(
      "layout=rollup&bg=shadow&partial=0",
    );
    expect(themeQuery("lower-third", {}, { layout: "blocks", show: "both" })).toBe(
      "preset=lower-third&layout=blocks",
    );
  });

  it("writes the look parameters that differ, in their short form", () => {
    const q = themeQuery(
      "mosque-dark",
      {
        "--cap-text-color": "#ffcc00",
        "--cap-block-radius": "16px",
        "--cap-font-family": georgia,
        "--cap-text-color-new": "#ffffff",
        "--cap-ref-color": "nope",
        "--cap-font-size": "min(80px, 5vw)",
      },
      {},
    );
    expect(q).toBe("radius=16&font=georgia&fg=ffcc00");
  });

  it("writes an alpha-only panel change as panelOpacity", () => {
    expect(themeQuery("mosque-dark", { "--cap-panel-bg": "rgba(17, 17, 17, 1)" }, {})).toBe(
      "panelOpacity=100",
    );
    expect(themeQuery("mosque-dark", { "--cap-panel-bg": "#111111" }, {})).toBe("panelOpacity=100");
  });

  it("writes a new panel colour as its RGB plus panelOpacity when it is not opaque", () => {
    expect(themeQuery("mosque-dark", { "--cap-panel-bg": "#203040cc" }, {})).toBe(
      "panelBg=203040&panelOpacity=80",
    );
    expect(themeQuery("mosque-dark", { "--cap-panel-bg": "#203040" }, {})).toBe("panelBg=203040");
    expect(themeQuery("mosque-dark", { "--cap-panel-bg": "transparent" }, {})).toBe(
      "panelBg=000000&panelOpacity=0",
    );
  });

  it("falls back to a colour parameter when an opacity parameter can't say it exactly", () => {
    const params = (overrides: ThemeVars) =>
      Object.fromEntries(new URLSearchParams(themeQuery("mosque-dark", overrides, {})));
    expect(params({ "--cap-panel-bg": "rgba(17, 17, 17, 0.925)" })).toEqual({
      panelBg: "rgba(17, 17, 17, 0.925)",
    });
    expect(params({ "--cap-panel-bg": "linear-gradient(red, blue)" })).toEqual({
      panelBg: "linear-gradient(red, blue)",
    });
    expect(params({ "--cap-panel-bg": "currentcolor" })).toEqual({ panelBg: "currentcolor" });
    // blockOpacity would also change the untouched newest-block colour.
    expect(params({ "--cap-block-bg": "#1c1c20cc" })).toEqual({ blockBg: "1c1c20cc" });
    // Two different alphas can't share one blockOpacity.
    expect(params({ "--cap-block-bg": "#ff000080", "--cap-block-bg-new": "#00ff00cc" })).toEqual({
      blockBg: "ff000080",
      blockBgNew: "00ff00cc",
    });
  });

  it("writes one blockOpacity for both block colours when they share the alpha", () => {
    expect(
      themeQuery(
        "mosque-dark",
        { "--cap-block-bg": "rgba(28, 28, 32, 0.5)", "--cap-block-bg-new": "rgb(43 43 48 / 50%)" },
        {},
      ),
    ).toBe("blockOpacity=50");
    expect(
      themeQuery(
        "mosque-dark",
        { "--cap-block-bg": "#ff0000", "--cap-block-bg-new": "#00ff00" },
        {},
      ),
    ).toBe("blockBg=ff0000&blockBgNew=00ff00");
  });

  it("gives a transparent block background a colour before its opacity", () => {
    expect(themeQuery("minimal-transparent", { "--cap-block-bg": "rgba(0, 0, 0, 0.5)" }, {})).toBe(
      "preset=minimal-transparent&blockBg=000000&blockOpacity=50",
    );
  });

  it("writes a colour over a gradient background as a plain colour parameter", () => {
    const grad = custom("grad", { vars: { "--cap-panel-bg": "linear-gradient(red, blue)" } });
    expect(themeQuery("grad", { "--cap-panel-bg": "#203040cc" }, {}, { custom: [grad] })).toBe(
      "preset=grad&panelBg=203040&panelOpacity=80",
    );
  });

  it("ignores overrides that are invalid or equal to the preset", () => {
    expect(
      themeQuery("mosque-dark", { "--cap-panel-bg": "nope", "--cap-block-bg": "#1C1C20" }, {}),
    ).toBe("");
  });
});

describe("themeQuery → resolveTheme", () => {
  const looks: Array<[string, ThemeVars, Partial<DisplayOptions>]> = [
    [
      "mosque-dark",
      { "--cap-text-color": "#ffcc00", "--cap-panel-bg": "rgba(17, 17, 17, 1)" },
      { size: 60 },
    ],
    [
      "glass",
      { "--cap-panel-bg": "#203040cc", "--cap-block-border": "none" },
      { layout: "rollup" },
    ],
    [
      "lower-third",
      { "--cap-block-bg": "#000000b3", "--cap-block-bg-new": "#000000b3" },
      { lines: 3 },
    ],
    [
      "minimal-transparent",
      { "--cap-block-bg": "rgba(0, 0, 0, 0.5)", "--cap-text-shadow": "outline" },
      { show: "both" },
    ],
    [
      "cinema",
      { "--cap-panel-bg": "linear-gradient(to top, black, transparent 60%)" },
      { layout: "blocks", bg: "none" },
    ],
    [
      "high-contrast",
      { "--cap-block-bg": "#ff000080", "--cap-block-bg-new": "#00ff00cc" },
      { partial: true },
    ],
  ];

  it("reproduces every override and option of the look", () => {
    for (const [id, overrides, options] of looks) {
      const t = resolveTheme(new URLSearchParams(themeQuery(id, overrides, options)));
      expect(t.presetId, id).toBe(id);
      for (const name of THEME_VARS) {
        const want = overrides[name];
        if (want !== undefined)
          expect(sameVarValue(name, t.vars[name], want), `${id} ${name}: ${t.vars[name]}`).toBe(
            true,
          );
      }
      expect(t.options, id).toMatchObject(options);
    }
  });
});
