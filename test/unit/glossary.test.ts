import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildSonioxContext,
  estimateTokens,
  type Glossary,
  glossaryHash,
  loadGlossary,
  migrateLegacyGlossary,
  parseGlossary,
} from "../../src/glossary.js";

const SHIPPED_DIR = join(process.cwd(), "glossaries");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gloss-"));
}

describe("loadGlossary", () => {
  it("loads the shipped ar-nl glossary", () => {
    const loaded = loadGlossary(SHIPPED_DIR, "ar", "nl");
    expect(loaded).not.toBeNull();
    const g = loaded?.glossary;
    expect(g?.context.general).toHaveLength(3);
    expect(g?.terms).toHaveLength(11);
    expect(g?.translation_terms).toHaveLength(34);
    const target = (source: string) =>
      g?.translation_terms.find((t) => t.source === source)?.target;
    expect(target("الله")).toBe("Allah");
    expect(target("اللهم")).toBe("O Allah");
    expect(target("صلى الله عليه وسلم")).toBe("\uFDFA");
    expect(target("سبحانه وتعالى")).toBe("\uFDFE");
    expect(loaded?.warnings).toEqual([]);
  });

  it("still loads an older glossary with rules and phrases (for the removed LLM/composer)", () => {
    const { glossary } = parseGlossary(
      {
        terms: ["التقوى"],
        rules: ['Translate الله as "Allah"'],
        phrases: { prophet_said: "De Profeet ﷺ zei" },
      },
      "old.yaml",
    );
    expect(glossary).toEqual({
      context: { general: [], text: "" },
      terms: ["التقوى"],
      translation_terms: [],
    });
  });

  it("returns null when the pair has no glossary", () => {
    expect(loadGlossary(SHIPPED_DIR, "ar", "en")).toBeNull();
  });

  it("rejects a translation term without a target, naming the path", () => {
    expect(() => parseGlossary({ translation_terms: [{ source: "الله" }] }, "x.yaml")).toThrow(
      /translation_terms\.0\.target/,
    );
  });

  it("warns (but accepts) more than 40 translation terms", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ source: `s${i}`, target: `t${i}` }));
    const { warnings } = parseGlossary({ translation_terms: many }, "big.yaml");
    expect(warnings.join(" ")).toMatch(/41 translation_terms/);
  });

  it("accepts a plain-string context as the domain text", () => {
    const { glossary } = parseGlossary({ context: "Medical lecture" }, "x.yaml");
    expect(glossary.context).toEqual({ general: [], text: "Medical lecture" });
  });
});

describe("migrateLegacyGlossary", () => {
  const legacy = `general:
  - { key: domain, value: "Islamic Friday sermon (khutbah)" }
text: Friday khutbah in Arabic.
terms: [التقوى]
translation_terms:
  - { source: "الله", target: "Allah" }
`;

  it("moves glossary.yaml to glossaries/ar-nl.yaml in the new format", () => {
    const dir = tmp();
    writeFileSync(join(dir, "glossary.yaml"), legacy);
    const result = migrateLegacyGlossary(dir, join(dir, "glossaries"));
    expect(result).toBe("migrated");
    const migrated = parse(readFileSync(join(dir, "glossaries", "ar-nl.yaml"), "utf8"));
    expect(migrated.context.general[0].value).toBe("Islamic Friday sermon (khutbah)");
    expect(migrated.context.text).toBe("Friday khutbah in Arabic.");
    expect(migrated.terms).toEqual(["التقوى"]);
    expect(migrated.translation_terms).toEqual([{ source: "الله", target: "Allah" }]);
    expect(existsSync(join(dir, "glossary.yaml"))).toBe(false);
    expect(existsSync(join(dir, "glossary.yaml.migrated"))).toBe(true);
  });

  it("is idempotent", () => {
    const dir = tmp();
    writeFileSync(join(dir, "glossary.yaml"), legacy);
    migrateLegacyGlossary(dir, join(dir, "glossaries"));
    const before = readFileSync(join(dir, "glossaries", "ar-nl.yaml"), "utf8");
    expect(migrateLegacyGlossary(dir, join(dir, "glossaries"))).toBe("none");
    expect(readFileSync(join(dir, "glossaries", "ar-nl.yaml"), "utf8")).toBe(before);
  });

  it("never overwrites an existing ar-nl.yaml", () => {
    const dir = tmp();
    mkdirSync(join(dir, "glossaries"));
    writeFileSync(join(dir, "glossaries", "ar-nl.yaml"), "terms: [keep]\n");
    writeFileSync(join(dir, "glossary.yaml"), legacy);
    expect(migrateLegacyGlossary(dir, join(dir, "glossaries"))).toBe("skipped-target-exists");
    expect(readFileSync(join(dir, "glossaries", "ar-nl.yaml"), "utf8")).toBe("terms: [keep]\n");
    expect(existsSync(join(dir, "glossary.yaml"))).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("counts non-ASCII characters as one token each and ASCII at four per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("الله")).toBe(4);
    expect(estimateTokens("ab الله")).toBe(1 + 4);
  });
});

describe("buildSonioxContext", () => {
  const base: Glossary = {
    context: { general: [{ key: "domain", value: "sermon" }], text: "Friday khutbah." },
    terms: ["التقوى", "الصحابة"],
    translation_terms: [{ source: "الله", target: "Allah" }],
  };

  it("maps the glossary to Soniox context fields", () => {
    const { context, truncated } = buildSonioxContext(base, { nativeTranslation: true });
    expect(context).toEqual({
      general: [{ key: "domain", value: "sermon" }],
      text: "Friday khutbah.",
      terms: ["التقوى", "الصحابة"],
      translation_terms: [{ source: "الله", target: "Allah" }],
    });
    expect(truncated).toEqual([]);
  });

  it("sends honorific ligature targets to Soniox as transliterations (it garbles the characters)", () => {
    const g: Glossary = {
      ...base,
      translation_terms: [
        { source: "الله", target: "Allah" },
        { source: "صلى الله عليه وسلم", target: "ﷺ" },
        { source: "سبحانه وتعالى", target: "﷾" },
        { source: "كلمة", target: "ﴊ" },
      ],
    };
    const { context } = buildSonioxContext(g, { nativeTranslation: true });
    expect(context.translation_terms).toEqual([
      { source: "الله", target: "Allah" },
      { source: "صلى الله عليه وسلم", target: "sallallahu alayhi wa sallam" },
      { source: "سبحانه وتعالى", target: "subhanahu wa ta'ala" },
    ]);
  });

  it("omits translation_terms when Soniox does not translate", () => {
    const { context } = buildSonioxContext(base, { nativeTranslation: false });
    expect(context.translation_terms).toBeUndefined();
  });

  it("truncates text first to stay within the token budget", () => {
    const huge: Glossary = { ...base, context: { ...base.context, text: "ب".repeat(9000) } };
    const { context, estimatedTokens, truncated } = buildSonioxContext(
      huge,
      { nativeTranslation: true },
      2000,
    );
    expect(estimatedTokens).toBeLessThanOrEqual(2000);
    expect(truncated).toEqual(["text"]);
    expect(context.terms).toEqual(["التقوى", "الصحابة"]);
  });

  it("drops trailing terms when the text alone is not enough", () => {
    const manyTerms = Array.from({ length: 400 }, (_, i) => `مصطلح${i}`);
    const g: Glossary = { ...base, terms: manyTerms };
    const { context, estimatedTokens, truncated } = buildSonioxContext(
      g,
      { nativeTranslation: true },
      1500,
    );
    expect(estimatedTokens).toBeLessThanOrEqual(1500);
    expect(truncated).toContain("terms");
    expect(context.terms?.[0]).toBe("مصطلح0");
    expect((context.terms ?? []).length).toBeLessThan(400);
  });

  it("omits empty fields", () => {
    const empty: Glossary = {
      context: { general: [], text: "" },
      terms: [],
      translation_terms: [],
    };
    expect(buildSonioxContext(empty, { nativeTranslation: true }).context).toEqual({});
  });
});

describe("glossaryHash", () => {
  it("is a stable sha256 of the file bytes", () => {
    const dir = tmp();
    const f = join(dir, "g.yaml");
    writeFileSync(f, "terms: [a]\n");
    expect(glossaryHash(f)).toMatch(/^[0-9a-f]{64}$/);
    expect(glossaryHash(f)).toBe(glossaryHash(f));
  });
});
