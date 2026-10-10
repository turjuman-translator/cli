// Supported languages: loads languages.yaml, lists sources/targets, maps codes to Soniox codes
// and validates caption-page language pairs.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { formatIssues, ValidationError } from "./validation.js";

/** Source code that asks the engine to detect the spoken language. */
export const AUTO = "auto";

const CODE = /^[a-z]{2,3}$/;

const EntrySchema = z
  .strictObject({
    en: z.string().min(1),
    native: z.string().min(1),
    soniox: z.string().min(1).optional(),
    /** An older languages.yaml also maps codes for the removed Gemini engine: ignored. */
    gemini: z.string().optional(),
  })
  .transform(({ gemini: _gemini, ...entry }) => entry);

const FileSchema = z.strictObject({
  languages: z.record(
    // Also keeps out "auto" (four letters), the source code that asks for language detection.
    z.string().regex(CODE, "language codes are 2-3 lowercase letters"),
    EntrySchema,
  ),
});

export interface LanguageEntry {
  code: string;
  en: string;
  native: string;
  /** The Soniox code; a language without one is not offered. */
  soniox?: string;
}

/** What GET /api/languages returns per language. */
export interface LanguageView {
  code: string;
  en: string;
  native: string;
}

export interface EngineLanguages {
  sources: LanguageView[];
  targets: LanguageView[];
}

/** Parsed languages.yaml with the helpers below bound to it. */
export interface Languages {
  readonly entries: ReadonlyMap<string, LanguageEntry>;
  get(code: string): LanguageEntry | undefined;
  engineLanguages(): EngineLanguages;
  providerCode(code: string): string | null;
  validatePair(from: string, to: string): string | null;
}

/** Parse the text of a languages file; throws ValidationError listing every problem. */
export function parseLanguages(text: string, source = "languages.yaml"): Languages {
  const result = FileSchema.safeParse(parse(text));
  if (!result.success) {
    throw new ValidationError(`Invalid ${source}`, formatIssues(result.error));
  }
  const entries = new Map<string, LanguageEntry>();
  for (const [code, e] of Object.entries(result.data.languages)) {
    entries.set(code, { code, ...e });
  }
  const langs: Languages = {
    entries,
    get: (code) => entries.get(code),
    engineLanguages: () => engineLanguages(langs),
    providerCode: (code) => providerCode(langs, code),
    validatePair: (from, to) => validatePair(langs, from, to),
  };
  return langs;
}

/** Load and validate languages.yaml (paths.languagesFile). */
export function loadLanguages(file: string): Languages {
  return parseLanguages(readFileSync(file, "utf8"), file);
}

function view(e: LanguageEntry): LanguageView {
  return { code: e.code, en: e.en, native: e.native };
}

/**
 * Sources and targets: the codes with a Soniox mapping ("auto" is always allowed as a source on
 * top). Soniox recognizes and translates the same set of languages.
 */
export function engineLanguages(langs: Languages): EngineLanguages {
  const supported = [...langs.entries.values()].filter((e) => e.soniox !== undefined).map(view);
  return { sources: supported, targets: supported };
}

/** Soniox language hint for a source language; "auto" (and unknown codes) → null = no hint. */
export function providerCode(langs: Languages, code: string): string | null {
  if (code === AUTO) return null;
  return langs.entries.get(code)?.soniox ?? null;
}

/** Validate a caption-page pair; returns an error message for the user, or null when valid. */
export function validatePair(langs: Languages, from: string, to: string): string | null {
  const { sources, targets } = engineLanguages(langs);
  if (from !== AUTO && !sources.some((l) => l.code === from)) {
    const known = langs.entries.get(from);
    return known === undefined
      ? `Unknown source language "${from}"`
      : `${known.en} (${from}) is not supported as a source by Soniox`;
  }
  if (to === AUTO) return `The target language cannot be "auto"`;
  if (!targets.some((l) => l.code === to)) {
    const known = langs.entries.get(to);
    return known === undefined
      ? `Unknown target language "${to}"`
      : `${known.en} (${to}) is not a Soniox translation target`;
  }
  if (from === to) return "Source and target language must differ";
  return null;
}
