import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  cssValueProblem,
  MAX_CUSTOM_PRESETS,
  PresetStore,
  parsePreset,
} from "../../src/presets.js";

const BUILTIN = new Set(["mosque-dark", "obs-clean"]);

describe("cssValueProblem: the CSS-injection guard", () => {
  it("accepts ordinary CSS values", () => {
    for (const ok of [
      "#0b3d2e",
      "rgb(1, 2, 3)",
      "'Amiri Quran', serif",
      "linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 100%)",
      "calc(100% - 2px)",
      "0 2px 8px rgba(0, 0, 0, 0.6)",
      "x".repeat(300),
    ]) {
      expect(cssValueProblem(ok), ok).toBeNull();
    }
  });

  it("refuses empty, overlong and control-character values", () => {
    expect(cssValueProblem("")).toBe("is empty");
    expect(cssValueProblem("   ")).toBe("is empty");
    expect(cssValueProblem("x".repeat(301))).toBe("is longer than 300 characters");
    expect(cssValueProblem("red\nblue")).toBe("contains a control character");
    expect(cssValueProblem("red\u007f")).toBe("contains a control character");
  });

  it("refuses anything that could end the declaration, open a block or hold markup", () => {
    for (const bad of ["red; color: blue", "a{", "}", "<b>", "a>b", "\\66 oo", "@import x"]) {
      expect(cssValueProblem(bad), bad).toBe("must not contain ; { } < > \\ or @");
    }
  });

  it("refuses functions that load resources, in any case and spacing", () => {
    for (const bad of [
      "url(x.png)",
      "URL (x.png)",
      "red image(x)",
      "image-set('a.png' 1x)",
      "cross-fade(a, b)",
      "element(#id)",
      "src(x)",
      "expression(alert(1))",
      "linear-gradient(red, blue), url(x)",
    ]) {
      expect(cssValueProblem(bad), bad).toBe("must not load resources (url(), image(), …)");
    }
    // Only whole function names count.
    expect(cssValueProblem("myurl(x)")).toBeNull();
  });
});

describe("parsePreset", () => {
  it("stores the canonical value of each variable and drops removed ones", () => {
    const result = parsePreset({
      id: "hall",
      name: " Hall ",
      vars: { "--cap-text-color": "#FFF", "--cap-font-size": "48PX", "--cap-hadith-accent": "red" },
      options: { size: 40, layout: "rollup" },
    });
    expect(result).toEqual({
      ok: true,
      preset: {
        id: "hall",
        name: "Hall",
        description: "",
        vars: { "--cap-text-color": "#ffffff", "--cap-font-size": "48px" },
        options: { size: 40, layout: "rollup" },
      },
    });
  });

  it("lists every problem: id, name, unknown and unsafe variables, values, options", () => {
    expect(
      parsePreset({
        id: "Hall!",
        name: "",
        vars: {
          "--nope": "red",
          "--cap-text-color": "url(x)",
          "--cap-font-size": "banana",
          "--cap-page-bg": "",
        },
        options: { size: 4, extra: 1 },
      }),
    ).toEqual({
      ok: false,
      errors: [
        "id: use 1-48 lowercase letters, digits or -",
        "name: Too small: expected string to have >=1 characters",
        "vars.--nope: unknown theme variable",
        "vars.--cap-text-color: must not load resources (url(), image(), …)",
        'vars.--cap-font-size: "banana" is not an accepted value for this variable',
        "vars.--cap-page-bg: is empty",
        "options.size: Too small: expected number to be >=8",
        'options: Unrecognized key: "extra" (extra)',
      ],
    });
    expect(parsePreset(null)).toEqual({
      ok: false,
      errors: ["(root): Invalid input: expected object, received null"],
    });
  });
});

describe("custom preset store (presets.yaml)", () => {
  let dir: string;
  let file: string;
  let store: PresetStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "presets-"));
    file = join(dir, "config", "presets.yaml");
    store = new PresetStore(file, BUILTIN);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  let edits = 0;
  /** Write presets.yaml by hand (each edit a later mtime, so the store re-reads it). */
  function handEdit(text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    edits++;
    const later = new Date(Date.now() + edits * 10_000);
    utimesSync(file, later, later);
  }

  it("has no presets and no problems before presets.yaml exists", () => {
    expect(store.list()).toEqual([]);
    expect(store.problems).toEqual([]);
    expect(store.get("hall")).toBeUndefined();
    expect(new PresetStore(file).list()).toEqual([]);
  });

  it("creates, then replaces a preset, writing the canonical values", () => {
    const created = store.upsert({
      id: "hall",
      name: "Hall",
      vars: { "--cap-text-color": "#FFF" },
    });
    expect(created).toMatchObject({ ok: true, created: true, preset: { name: "Hall" } });
    expect(readFileSync(file, "utf8")).toMatch(/^# Custom caption presets/);
    expect(readFileSync(file, "utf8")).toContain('--cap-text-color: "#ffffff"');
    const replaced = store.upsert({ id: "hall", name: "Main hall", description: "Friday" });
    expect(replaced).toEqual({
      ok: true,
      created: false,
      preset: { id: "hall", name: "Main hall", description: "Friday", vars: {}, options: {} },
    });
    expect(store.list().map((p) => p.name)).toEqual(["Main hall"]);
    expect(new PresetStore(file).get("hall")?.description).toBe("Friday");
  });

  it("hands out copies: changing one changes nothing stored", () => {
    store.upsert({ id: "hall", name: "Hall", vars: { "--cap-text-color": "#000" } });
    const got = store.get("hall");
    if (got !== undefined) got.vars["--cap-text-color"] = "#fff";
    const listed = store.list()[0];
    if (listed !== undefined) listed.name = "Changed";
    expect(store.get("hall")).toMatchObject({
      name: "Hall",
      vars: { "--cap-text-color": "#000000" },
    });
  });

  it("refuses invalid input (400) and built-in ids (409)", () => {
    expect(store.upsert({ id: "", name: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(store.upsert({ id: "mosque-dark", name: "Mine" })).toEqual({
      ok: false,
      status: 409,
      errors: ['id: "mosque-dark" is a built-in preset; choose another id'],
    });
    expect(store.list()).toEqual([]);
  });

  it(`keeps at most ${MAX_CUSTOM_PRESETS} custom presets per organisation`, () => {
    const presets = Array.from({ length: MAX_CUSTOM_PRESETS }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    }));
    handEdit(stringify({ presets }));
    expect(store.list()).toHaveLength(MAX_CUSTOM_PRESETS);
    expect(store.upsert({ id: "one-more", name: "One more" })).toEqual({
      ok: false,
      status: 409,
      errors: [`at most ${MAX_CUSTOM_PRESETS} custom presets`],
    });
    // Replacing one is still fine, and another organisation has its own room.
    expect(store.upsert({ id: "p0", name: "First" })).toMatchObject({ ok: true, created: false });
    expect(store.upsert({ id: "one-more", name: "Theirs" }, "orgaaaaaaa")).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it("deletes a custom preset; unknown and built-in ones give a 404 that says which", () => {
    store.upsert({ id: "hall", name: "Hall" });
    expect(store.remove("nope")).toEqual({
      ok: false,
      status: 404,
      errors: ["nope: no such preset"],
    });
    expect(store.remove("mosque-dark")).toEqual({
      ok: false,
      status: 404,
      errors: ["mosque-dark: built-in presets cannot be deleted"],
    });
    expect(store.remove("hall", "orgaaaaaaa")).toMatchObject({ ok: false, status: 404 });
    expect(store.remove("hall")).toMatchObject({
      ok: true,
      created: false,
      preset: { id: "hall" },
    });
    expect(store.list()).toEqual([]);
    expect(store.removeOrg("orgaaaaaaa")).toBe(0);
  });

  it("re-reads hand edits, skipping and reporting every bad entry", () => {
    handEdit(
      stringify({
        presets: [
          { id: "good", name: "Good" },
          { id: "Bad!", name: "Bad" },
          { id: "good", name: "Again" },
          { id: "good", name: "Theirs", orgId: "orgaaaaaaa" },
          { id: "mosque-dark", name: "Shadow" },
          { id: "x", name: "X", orgId: 7 },
          { id: "y", name: "Y", orgId: "bad org!" },
          "not an object",
        ],
      }),
    );
    expect(store.list().map((p) => p.name)).toEqual(["Good"]);
    expect(store.list("orgaaaaaaa").map((p) => p.name)).toEqual(["Theirs"]);
    expect(store.problems).toEqual([
      `${file} presets[1]: id: use 1-48 lowercase letters, digits or -`,
      `${file} presets[2]: duplicate id "good"`,
      `${file} presets[4]: duplicate id "mosque-dark"`,
      `${file} presets[5]: invalid orgId`,
      `${file} presets[6]: invalid orgId`,
      `${file} presets[7]: (root): Invalid input: expected object, received string`,
    ]);
  });

  it("refuses to write while presets.yaml has problems (it would lose entries)", () => {
    handEdit("presets:\n  - { id: good, name: Good }\n  - { id: 'Bad!', name: Bad }\n");
    const blocked = {
      ok: false,
      status: 409,
      errors: [
        `fix ${file} first (it would lose entries):`,
        `${file} presets[1]: id: use 1-48 lowercase letters, digits or -`,
      ],
    };
    expect(store.upsert({ id: "new", name: "New" })).toEqual(blocked);
    expect(store.remove("good")).toEqual(blocked);
    expect(store.removeOrg("local")).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("Bad!");
  });

  it("reports a file that is not YAML, or whose presets are not a list", () => {
    handEdit("presets: [ {id: 1 ");
    expect(store.list()).toEqual([]);
    expect(store.problems).toHaveLength(1);
    expect(store.problems[0]).toMatch(
      new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `),
    );
    handEdit("presets:\n  id: hall\n");
    expect(store.problems).toEqual([`${file}: "presets" must be a list`]);
    expect(store.upsert({ id: "x", name: "X" })).toMatchObject({ ok: false, status: 409 });
  });

  it("reads a file without presets (empty, or other keys only) as none", () => {
    handEdit("");
    expect(store.list()).toEqual([]);
    expect(store.problems).toEqual([]);
    handEdit("# nothing here yet\nnote: hello\n");
    expect(store.list()).toEqual([]);
    expect(store.problems).toEqual([]);
    expect(store.upsert({ id: "first", name: "First" })).toMatchObject({ ok: true, created: true });
  });
});
