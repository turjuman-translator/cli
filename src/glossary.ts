import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "./paths.js";
import { HONORIFIC_LIGATURES } from "./text/honorifics.js";
import { formatIssues, ValidationError } from "./validation.js";

const KeyValue = z.strictObject({ key: z.string().min(1), value: z.string() });
const TranslationTerm = z.strictObject({ source: z.string().min(1), target: z.string() });
const trimmed = z.string().transform((s) => s.trim());

// `context` is either the domain text alone, or Soniox-style general key/values plus text.
const Context = z.union([
  trimmed.transform((text) => ({ general: [] as Array<{ key: string; value: string }>, text })),
  z.strictObject({ general: z.array(KeyValue).default([]), text: trimmed.default("") }),
]);

const GlossarySchema = z
  .strictObject({
    context: Context.default({ general: [], text: "" }),
    terms: z.array(z.string().min(1)).default([]),
    translation_terms: z.array(TranslationTerm).default([]),
    /** Older glossaries: lines for the removed LLM translator and caption composer (ignored). */
    rules: z.unknown().optional(),
    phrases: z.unknown().optional(),
  })
  .transform(({ rules: _rules, phrases: _phrases, ...glossary }) => glossary);

/** Per-pair glossary: `glossaries/<from>-<to>.yaml`. */
export type Glossary = z.output<typeof GlossarySchema>;

export interface LoadedGlossary {
  glossary: Glossary;
  file: string;
  warnings: string[];
}

/** Soniox `context` object (field names as in the Soniox API). */
export interface SonioxContext {
  general?: Array<{ key: string; value: string }>;
  text?: string;
  terms?: string[];
  translation_terms?: Array<{ source: string; target: string }>;
}

const MAX_TRANSLATION_TERMS = 40;

export function parseGlossary(
  raw: unknown,
  file: string,
): { glossary: Glossary; warnings: string[] } {
  const result = GlossarySchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ValidationError(`Invalid glossary ${file}`, formatIssues(result.error));
  }
  const warnings: string[] = [];
  const count = result.data.translation_terms.length;
  if (count > MAX_TRANSLATION_TERMS) {
    warnings.push(
      `${file}: ${count} translation_terms (keep it under ~${MAX_TRANSLATION_TERMS}; review before growing)`,
    );
  }
  return { glossary: result.data, warnings };
}

/** Load `<glossariesDir>/<from>-<to>.yaml`, or null when the pair has no glossary. */
export function loadGlossary(
  glossariesDir: string,
  from: string,
  to: string,
): LoadedGlossary | null {
  const file = join(glossariesDir, `${from}-${to}.yaml`);
  if (!existsSync(file)) return null;
  const { glossary, warnings } = parseGlossary(parse(readFileSync(file, "utf8")), file);
  return { glossary, file, warnings };
}

export type MigrationResult = "migrated" | "skipped-target-exists" | "none";

/**
 * Move an older single-file `glossary.yaml` (general/text/terms/translation_terms) to
 * `glossaries/ar-nl.yaml` in the per-pair format. Never overwrites; the legacy file is
 * renamed to `glossary.yaml.migrated` so the move happens once.
 */
export function migrateLegacyGlossary(configDir: string, glossariesDir: string): MigrationResult {
  const legacy = join(configDir, "glossary.yaml");
  if (!existsSync(legacy)) return "none";
  const target = join(glossariesDir, "ar-nl.yaml");
  if (existsSync(target)) return "skipped-target-exists";

  const old = (parse(readFileSync(legacy, "utf8")) ?? {}) as Record<string, unknown>;
  const converted = {
    context: { general: old.general ?? [], text: old.text ?? "" },
    terms: old.terms ?? [],
    translation_terms: old.translation_terms ?? [],
  };
  const { glossary } = parseGlossary(converted, legacy);
  mkdirSync(glossariesDir, { recursive: true });
  const header = "# Migrated from glossary.yaml. DRAFT: review before production use.\n";
  writeFileAtomic(target, header + stringify(glossary));
  renameSync(legacy, `${legacy}.migrated`);
  return "migrated";
}

/**
 * Conservative token estimate for Soniox's 8,000-token context limit: Arabic and other
 * non-ASCII text tokenizes densely, so each non-ASCII character counts as one token and
 * ASCII counts at four characters per token.
 */
export function estimateTokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return other + Math.ceil(ascii / 4);
}

/** Arabic presentation forms (ligatures such as ﷺ, ornate brackets). */
const PRESENTATION_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * A translation-term target as Soniox gets it: a ligature target (ﷺ, ﷾, …) becomes its
 * transliteration, because Soniox garbles a requested ligature into other presentation forms
 * ("ﴊ ﴾"); the renderers turn the words back into the ligature. Other presentation-form targets
 * are dropped (null).
 */
function sonioxTarget(target: string): string | null {
  if (!PRESENTATION_FORMS.test(target)) return target;
  const lig = HONORIFIC_LIGATURES.find((h) => h.char === target.trim());
  return lig === undefined ? null : lig.name;
}

/**
 * Build the Soniox `context` from a glossary within a token budget. When over budget:
 * truncate `text` first, then drop trailing terms, translation terms and general pairs.
 */
export function buildSonioxContext(
  g: Glossary,
  opts: { nativeTranslation: boolean },
  budgetTokens = 7000,
): { context: SonioxContext; estimatedTokens: number; truncated: string[] } {
  const ctx: SonioxContext = {};
  if (g.context.general.length > 0) ctx.general = g.context.general.map((kv) => ({ ...kv }));
  if (g.context.text !== "") ctx.text = g.context.text;
  if (g.terms.length > 0) ctx.terms = [...g.terms];
  if (opts.nativeTranslation && g.translation_terms.length > 0) {
    const terms = g.translation_terms.flatMap((t) => {
      const target = sonioxTarget(t.target);
      return target === null ? [] : [{ source: t.source, target }];
    });
    if (terms.length > 0) ctx.translation_terms = terms;
  }

  const cost = (): number => estimateTokens(JSON.stringify(ctx));
  const truncated: string[] = [];

  if (cost() > budgetTokens && ctx.text !== undefined) {
    const full = ctx.text;
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      ctx.text = full.slice(0, mid);
      if (cost() <= budgetTokens) lo = mid;
      else hi = mid - 1;
    }
    ctx.text = full.slice(0, lo);
    if (ctx.text === "") delete ctx.text;
    truncated.push("text");
  }

  const dropTrailing = (key: "terms" | "translation_terms" | "general"): void => {
    const list = ctx[key];
    if (cost() <= budgetTokens || list === undefined) return;
    while (list.length > 0 && cost() > budgetTokens) list.pop();
    if (list.length === 0) delete ctx[key];
    truncated.push(key);
  };
  dropTrailing("terms");
  dropTrailing("translation_terms");
  dropTrailing("general");

  return { context: ctx, estimatedTokens: cost(), truncated };
}

/** sha256 of the glossary file bytes, recorded in bench reports. */
export function glossaryHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
