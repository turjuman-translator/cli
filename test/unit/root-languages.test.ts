import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTO,
  engineLanguages,
  loadLanguages,
  parseLanguages,
  providerCode,
  validatePair,
} from "../../src/languages.js";
import { ValidationError } from "../../src/validation.js";

const SMALL = `
languages:
  ar: { en: Arabic, native: العربية, soniox: ar }
  nl: { en: Dutch, native: Nederlands, soniox: nl }
  zh: { en: Chinese, native: 中文, soniox: zh-hans }
  ber: { en: Berber, native: Tamaziɣt }
`;

function problemsOf(text: string): string[] {
  try {
    parseLanguages(text, "my-languages.yaml");
    return [];
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    expect(err.message.split("\n")[0]).toBe("Invalid my-languages.yaml:");
    return err.problems;
  }
}

describe("languages.yaml", () => {
  it("loads the shipped file: every language is a Soniox source and target", () => {
    const langs = loadLanguages(join(process.cwd(), "languages.yaml"));
    const { sources, targets } = langs.engineLanguages();
    expect(sources.length).toBeGreaterThan(50);
    expect(targets).toEqual(sources);
    expect(sources.find((l) => l.code === "ar")).toEqual({
      code: "ar",
      en: "Arabic",
      native: "العربية",
    });
    expect(langs.validatePair("ar", "nl")).toBeNull();
  });

  it("offers only the languages with a Soniox code (no engine code: not offered)", () => {
    const langs = parseLanguages(SMALL);
    expect(langs.get("ber")).toEqual({ code: "ber", en: "Berber", native: "Tamaziɣt" });
    expect(engineLanguages(langs).sources.map((l) => l.code)).toEqual(["ar", "nl", "zh"]);
    expect(langs.engineLanguages()).toEqual(engineLanguages(langs));
  });

  it("maps a source language to its Soniox hint; auto and unknown codes give none", () => {
    const langs = parseLanguages(SMALL);
    expect(langs.providerCode("zh")).toBe("zh-hans");
    expect(providerCode(langs, "ar")).toBe("ar");
    expect(providerCode(langs, AUTO)).toBeNull();
    expect(providerCode(langs, "ber")).toBeNull();
    expect(providerCode(langs, "xx")).toBeNull();
  });

  it("says what is wrong with a caption-page language pair", () => {
    const langs = parseLanguages(SMALL);
    expect(validatePair(langs, "auto", "nl")).toBeNull();
    expect(validatePair(langs, "xx", "nl")).toBe('Unknown source language "xx"');
    expect(validatePair(langs, "ber", "nl")).toBe(
      "Berber (ber) is not supported as a source by Soniox",
    );
    expect(validatePair(langs, "ar", "auto")).toBe('The target language cannot be "auto"');
    expect(validatePair(langs, "ar", "yy")).toBe('Unknown target language "yy"');
    expect(langs.validatePair("ar", "ber")).toBe("Berber (ber) is not a Soniox translation target");
    expect(validatePair(langs, "nl", "nl")).toBe("Source and target language must differ");
  });

  it("still reads an older file with Gemini codes (the removed engine), ignoring them", () => {
    const langs = parseLanguages(
      "languages:\n  ar: { en: Arabic, native: العربية, soniox: ar, gemini: ar-SA }\n",
    );
    expect(langs.get("ar")).toEqual({ code: "ar", en: "Arabic", native: "العربية", soniox: "ar" });
  });

  it("lists every problem of an invalid file", () => {
    expect(problemsOf("")).toEqual(["(root): Invalid input: expected object, received null"]);
    const problems = problemsOf(
      "languages:\n  AR: { en: Arabic, native: x }\n  auto: { en: Auto, native: x }\n  nl: { en: Dutch }\n",
    );
    // The reason a code is refused is shown, not zod's bare "Invalid key in record".
    expect(problems).toEqual([
      "languages.AR: language codes are 2-3 lowercase letters",
      "languages.auto: language codes are 2-3 lowercase letters",
      "languages.nl.native: Invalid input: expected string, received undefined",
    ]);
    expect(problemsOf("languages: {}\nextra: 1\n")).toEqual([
      '(root): Unrecognized key: "extra" (extra)',
    ]);
  });

  it("names the file it could not load", () => {
    const dir = mkdtempSync(join(tmpdir(), "langs-"));
    try {
      const file = join(dir, "languages.yaml");
      writeFileSync(file, "languages: 3\n");
      expect(() => loadLanguages(file)).toThrow(`Invalid ${file}:`);
      expect(() => loadLanguages(join(dir, "missing.yaml"))).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
