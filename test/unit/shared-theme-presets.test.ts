import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESETS,
  DEFAULT_OPTIONS,
  DEFAULT_PRESET_ID,
  DEFAULT_VARS,
  FONT_CHOICES,
  findPreset,
  fontSizeVar,
  isBuiltinPresetId,
  OPTION_SPECS,
  presetTheme,
  sanitizeOptions,
  sanitizePreset,
  sanitizeVars,
  TEXT_SHADOWS,
  VAR_SPECS,
} from "../../src/shared/theme.js";
import { THEME_VARS, type ThemePreset } from "../../src/shared/theme-vars.js";

function custom(id: string, extra: Partial<ThemePreset> = {}): ThemePreset {
  return { id, name: id, description: "", vars: {}, options: {}, ...extra };
}

function builtin(id: string): ThemePreset {
  const p = findPreset(id);
  if (p === undefined) throw new Error(`no preset ${id}`);
  return p;
}

describe("built-in presets", () => {
  it("are the ten documented looks, mosque-dark first and the default", () => {
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual([
      "mosque-dark",
      "mosque-light",
      "midnight-gold",
      "high-contrast",
      "minimal-transparent",
      "glass",
      "sidebar-pip",
      "large-print",
      "lower-third",
      "cinema",
    ]);
    expect(DEFAULT_PRESET_ID).toBe("mosque-dark");
    expect(DEFAULT_VARS).toEqual(builtin("mosque-dark").vars);
  });

  it("set every variable, with a font size that follows their size option", () => {
    for (const p of BUILTIN_PRESETS) {
      expect(Object.keys(p.vars).sort(), p.id).toEqual([...THEME_VARS].sort());
      expect(p.options.size, p.id).toBeDefined();
      expect(p.vars["--cap-font-size"], p.id).toBe(fontSizeVar(p.options.size ?? 0));
      expect(sanitizeOptions(p.options), p.id).toEqual(p.options);
    }
    expect(builtin("large-print").vars["--cap-font-size"]).toBe("min(76px, 5vw)");
  });

  it("use the named text shadows and the allow-listed fonts", () => {
    expect(builtin("minimal-transparent").vars["--cap-text-shadow"]).toBe(TEXT_SHADOWS.strong);
    expect(builtin("cinema").vars["--cap-text-shadow"]).toBe(TEXT_SHADOWS.strong);
    expect(builtin("lower-third").vars["--cap-text-shadow"]).toBe(TEXT_SHADOWS.soft);
    const stacks = FONT_CHOICES.map((f) => f.stack);
    for (const p of BUILTIN_PRESETS) {
      for (const name of THEME_VARS) {
        if (VAR_SPECS[name].kind.type === "font")
          expect(stacks, `${p.id} ${name}`).toContain(p.vars[name]);
      }
    }
    expect(builtin("midnight-gold").vars["--cap-font-family"]).toContain("Georgia");
    expect(builtin("glass").vars["--cap-font-family"]).toContain("system-ui");
  });

  it("have a URL parameter per variable and per option, with no name used twice", () => {
    const params = [
      ...THEME_VARS.filter((v) => VAR_SPECS[v].kind.type !== "fontSize").map(
        (v) => VAR_SPECS[v].param,
      ),
      ...Object.values(OPTION_SPECS).flatMap((o) => [o.param, ...(o.aliases ?? [])]),
    ].map((p) => p.toLowerCase());
    expect(new Set(params).size).toBe(params.length);
  });
});

describe("isBuiltinPresetId", () => {
  it("knows exactly the built-in ids", () => {
    for (const p of BUILTIN_PRESETS) expect(isBuiltinPresetId(p.id)).toBe(true);
    expect(isBuiltinPresetId("friday-glass")).toBe(false);
    expect(isBuiltinPresetId("")).toBe(false);
  });
});

describe("findPreset", () => {
  it("finds nothing for a missing or empty id", () => {
    expect(findPreset(null)).toBeUndefined();
    expect(findPreset(undefined)).toBeUndefined();
    expect(findPreset("")).toBeUndefined();
    expect(findPreset("nope")).toBeUndefined();
  });

  it("matches ids case-insensitively and ignores surrounding spaces", () => {
    expect(findPreset(" Glass ")?.id).toBe("glass");
  });

  it("finds custom presets, but never lets them shadow a built-in", () => {
    const mine = custom("friday-glass");
    const fake = custom("glass", { name: "Not the real glass" });
    expect(findPreset("friday-glass", [mine])).toBe(mine);
    expect(findPreset("glass", [fake])?.name).toBe("Glass");
  });
});

describe("sanitizeVars", () => {
  it("keeps only known variables with valid string values, canonicalized", () => {
    const input = {
      "--cap-text-color": "FFF",
      "--cap-block-radius": 12,
      "--cap-panel-bg": "url(https://evil.example/x.png)",
      "--cap-unknown": "red",
      "--cap-hadith-accent": "#4a90d9",
      "--cap-font-family": "georgia",
    };
    expect(sanitizeVars(input)).toEqual({
      "--cap-text-color": "#ffffff",
      "--cap-font-family": FONT_CHOICES.find((f) => f.key === "georgia")?.stack,
    });
  });

  it("gives nothing for input that is not an object", () => {
    expect(sanitizeVars(null)).toEqual({});
    expect(sanitizeVars("--cap-text-color: red")).toEqual({});
    expect(sanitizeVars(undefined)).toEqual({});
  });
});

describe("sanitizeOptions", () => {
  it("keeps known options with valid values and normalizes them", () => {
    expect(
      sanitizeOptions({
        layout: " ROLLUP ",
        bg: "nope",
        show: "both",
        history: "no",
        quranAccent: 1,
        quranArabic: false,
        partial: "maybe",
        maxBlocks: "1000",
        visibleBlocks: -3,
        pos: 5,
        lines: "",
        size: "52.6",
        toolbar: "yes",
        extra: true,
      }),
    ).toEqual({
      layout: "rollup",
      show: "both",
      history: false,
      quranAccent: true,
      quranArabic: false,
      maxBlocks: 500,
      visibleBlocks: 0,
      size: 53,
      toolbar: "on",
    });
  });

  it("reads switches from words and numbers", () => {
    expect(
      sanitizeOptions({ history: "ON", partial: "1", quranAccent: "true", quranArabic: 0 }),
    ).toEqual({
      history: true,
      partial: true,
      quranAccent: true,
      quranArabic: false,
    });
    expect(sanitizeOptions({ history: 2, partial: {}, quranAccent: null })).toEqual({});
  });

  it("drops numbers that are not finite and values of the wrong type", () => {
    expect(
      sanitizeOptions({
        size: "abc",
        lines: Number.POSITIVE_INFINITY,
        maxBlocks: true,
        visibleBlocks: "  ",
        layout: 1,
      }),
    ).toEqual({});
    expect(sanitizeOptions({ size: 7, lines: " 3 " })).toEqual({ size: 8, lines: 3 });
  });

  it("maps the toolbar's yes/no words to on/off", () => {
    for (const on of ["1", "true", "yes", "on"])
      expect(sanitizeOptions({ toolbar: on })).toEqual({ toolbar: "on" });
    for (const off of ["0", "false", "no", "off"]) {
      expect(sanitizeOptions({ toolbar: off })).toEqual({ toolbar: "off" });
    }
    expect(sanitizeOptions({ toolbar: "Auto" })).toEqual({ toolbar: "auto" });
  });

  it("gives nothing for input that is not an object", () => {
    expect(sanitizeOptions(null)).toEqual({});
    expect(sanitizeOptions(42)).toEqual({});
  });
});

describe("sanitizePreset", () => {
  it("cleans up an untrusted preset", () => {
    expect(
      sanitizePreset({
        id: " Friday-Glass ",
        name: "  Friday glass  ",
        description: ` ${"d".repeat(400)} `,
        vars: { "--cap-text-color": "ffe08a", "--cap-panel-bg": "red;}" },
        options: { size: "56", layout: "grid" },
        extra: "ignored",
      }),
    ).toEqual({
      id: "friday-glass",
      name: "Friday glass",
      description: "d".repeat(300),
      vars: { "--cap-text-color": "#ffe08a" },
      options: { size: 56 },
    });
  });

  it("names a preset after its id when the name is missing or blank, and caps it at 60", () => {
    expect(sanitizePreset({ id: "a" })).toEqual({
      id: "a",
      name: "a",
      description: "",
      vars: {},
      options: {},
    });
    expect(sanitizePreset({ id: "b", name: "   ", description: 5 })?.name).toBe("b");
    expect(sanitizePreset({ id: "c", name: "n".repeat(80) })?.name).toBe("n".repeat(60));
  });

  it("refuses presets without a usable id", () => {
    expect(sanitizePreset(null)).toBeNull();
    expect(sanitizePreset("glass")).toBeNull();
    expect(sanitizePreset({ name: "No id" })).toBeNull();
    expect(sanitizePreset({ id: "" })).toBeNull();
    expect(sanitizePreset({ id: "bad id!" })).toBeNull();
    expect(sanitizePreset({ id: 7 })).toBeNull();
    expect(sanitizePreset({ id: "x".repeat(49) })).toBeNull();
    expect(sanitizePreset({ id: "x".repeat(48) })?.id).toBe("x".repeat(48));
  });
});

describe("presetTheme", () => {
  it("fills a built-in's options with the defaults", () => {
    const t = presetTheme(builtin("mosque-dark"));
    expect(t.options).toEqual({ ...DEFAULT_OPTIONS, partial: false, show: "target" });
    expect(t.vars).toEqual(DEFAULT_VARS);
  });

  it("fills a custom preset's gaps from the default look and sanitizes it", () => {
    const t = presetTheme(
      custom("warm", {
        vars: { "--cap-text-color": "gold", "--cap-block-radius": "huge" },
        options: { size: 40 },
      }),
    );
    expect(t.vars["--cap-text-color"]).toBe("gold");
    expect(t.vars["--cap-block-radius"]).toBe(DEFAULT_VARS["--cap-block-radius"]);
    expect(t.vars["--cap-font-size"]).toBe("min(40px, 5vw)");
    expect(t.options.size).toBe(40);
  });

  it("makes the font size follow the size option, whatever the preset's own value", () => {
    const t = presetTheme(custom("odd", { vars: { "--cap-font-size": "min(10px, 5vw)" } }));
    expect(t.vars["--cap-font-size"]).toBe(fontSizeVar(DEFAULT_OPTIONS.size));
  });

  it("gives the roll-up layout its band, both languages and live partials by default", () => {
    const t = presetTheme(custom("roll", { options: { layout: "rollup" } }));
    expect(t.options).toMatchObject({ layout: "rollup", bg: "band", show: "both", partial: true });
  });

  it("keeps show and partial when the preset sets them", () => {
    const t = presetTheme(builtin("lower-third"));
    expect(t.options).toMatchObject({ layout: "rollup", bg: "band", show: "both", partial: false });
    const c = presetTheme(builtin("cinema"));
    expect(c.options).toMatchObject({
      layout: "rollup",
      bg: "shadow",
      show: "target",
      partial: false,
    });
  });

  it("swaps a background that does not exist in the preset's layout", () => {
    expect(presetTheme(custom("a", { options: { layout: "blocks", bg: "band" } })).options.bg).toBe(
      "panel",
    );
    expect(
      presetTheme(custom("b", { options: { layout: "blocks", bg: "shadow" } })).options.bg,
    ).toBe("none");
    expect(
      presetTheme(custom("c", { options: { layout: "rollup", bg: "panel" } })).options.bg,
    ).toBe("band");
    expect(presetTheme(custom("d", { options: { layout: "rollup", bg: "none" } })).options.bg).toBe(
      "none",
    );
  });
});
