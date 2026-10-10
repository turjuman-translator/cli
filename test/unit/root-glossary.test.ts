import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildSonioxContext,
  type Glossary,
  loadGlossary,
  migrateLegacyGlossary,
} from "../../src/glossary.js";

describe("glossaries: empty files and the edges of the token budget", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gloss-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads an empty glossary file as an empty glossary", () => {
    writeFileSync(join(dir, "ar-en.yaml"), "# nothing yet\n");
    expect(loadGlossary(dir, "ar", "en")).toEqual({
      glossary: { context: { general: [], text: "" }, terms: [], translation_terms: [] },
      file: join(dir, "ar-en.yaml"),
      warnings: [],
    });
  });

  it("migrates an empty or partial legacy glossary.yaml", () => {
    const glossaries = join(dir, "glossaries");
    writeFileSync(join(dir, "glossary.yaml"), "");
    expect(migrateLegacyGlossary(dir, glossaries)).toBe("migrated");
    const target = join(glossaries, "ar-nl.yaml");
    expect(readFileSync(target, "utf8")).toMatch(/^# Migrated from glossary\.yaml/);
    expect(parse(readFileSync(target, "utf8"))).toEqual({
      context: { general: [], text: "" },
      terms: [],
      translation_terms: [],
    });
    expect(existsSync(join(dir, "glossary.yaml.migrated"))).toBe(true);

    const other = mkdtempSync(join(tmpdir(), "gloss-"));
    try {
      writeFileSync(join(other, "glossary.yaml"), "terms: [التقوى]\n");
      expect(migrateLegacyGlossary(other, join(other, "glossaries"))).toBe("migrated");
      expect(loadGlossary(join(other, "glossaries"), "ar", "nl")?.glossary).toEqual({
        context: { general: [], text: "" },
        terms: ["التقوى"],
        translation_terms: [],
      });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("leaves translation_terms out when every target is an unknown presentation form", () => {
    const g: Glossary = {
      context: { general: [], text: "" },
      terms: [],
      translation_terms: [
        { source: "كلمة", target: "ﴊ" },
        { source: "أخرى", target: "﴾" },
      ],
    };
    expect(buildSonioxContext(g, { nativeTranslation: true }).context).toEqual({});
  });

  it("drops whole fields when even one entry is over budget, and says which", () => {
    const g: Glossary = {
      context: { general: [{ key: "domain", value: "khutbah" }], text: "Friday sermon." },
      terms: ["التقوى", "الصحابة"],
      translation_terms: [{ source: "الله", target: "Allah" }],
    };
    const { context, estimatedTokens, truncated } = buildSonioxContext(
      g,
      { nativeTranslation: true },
      1,
    );
    expect(context).toEqual({});
    expect(truncated).toEqual(["text", "terms", "translation_terms", "general"]);
    expect(estimatedTokens).toBe(1);
  });

  it("only names the fields it had to shorten", () => {
    const g: Glossary = {
      context: { general: [], text: "" },
      terms: Array.from({ length: 50 }, (_, i) => `مصطلح${i}`),
      translation_terms: [],
    };
    const { context, truncated } = buildSonioxContext(g, { nativeTranslation: false }, 100);
    expect(truncated).toEqual(["terms"]);
    expect(context.terms?.length).toBeGreaterThan(0);
    expect(context.terms?.length).toBeLessThan(50);
    expect(context.text).toBeUndefined();
  });
});
