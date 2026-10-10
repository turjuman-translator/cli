// Caption look presets: every part of the look can be customized, starting from a preset.
// Built-in presets ship with the web theme (src/shared/theme.ts); custom presets live in
// CONFIG_DIR/presets.yaml, managed from /customize through the API (hand edits are re-read when
// the file's mtime changes; invalid entries are skipped and reported, never fatal). Each custom
// preset belongs to an organisation (`orgId`, "local" when absent); ids are unique per
// organisation.
// Values pass two gates: a CSS-injection guard, then the theme's own per-variable parser
// (parseVarValue), whose canonical value is what gets stored, so a saved preset renders exactly
// as the browser-side sanitizer will accept it.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "./paths.js";
import { parseVarValue } from "./shared/theme.js";
import {
  type DisplayOptions,
  REMOVED_THEME_VARS,
  THEME_VARS,
  type ThemePreset,
  type ThemeVar,
} from "./shared/theme-vars.js";
import { formatIssues } from "./validation.js";

const ID = /^[a-z0-9-]{1,48}$/;
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOCAL_ORG = "local";
const MAX_VALUE_LENGTH = 300;
export const MAX_CUSTOM_PRESETS = 100;
const THEME_VAR_SET: ReadonlySet<string> = new Set(THEME_VARS);
/** CSS functions that load resources (CSP blocks foreign ones anyway; defence in depth). */
const LOADING_FUNCTION =
  /(?:^|[^a-z-])(?:url|image|image-set|cross-fade|element|src|expression)\s*\(/i;

/**
 * Why a CSS custom-property value is unsafe, or null when it is fine. Values may hold any normal
 * CSS (colours, lengths, quoted font names, gradients, calc()) but can never end the
 * declaration, open/close a block, contain markup or escapes, or load a resource.
 */
export function cssValueProblem(value: string): string | null {
  if (value.trim() === "") return "is empty";
  if (value.length > MAX_VALUE_LENGTH) return `is longer than ${MAX_VALUE_LENGTH} characters`;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "contains a control character";
  }
  if (/[;{}<>\\@]/.test(value)) return "must not contain ; { } < > \\ or @";
  if (LOADING_FUNCTION.test(value)) return "must not load resources (url(), image(), …)";
  return null;
}

const OptionsSchema = z.strictObject({
  layout: z.enum(["blocks", "rollup"]).optional(),
  bg: z.enum(["panel", "none", "band", "shadow"]).optional(),
  show: z.enum(["both", "target", "source"]).optional(),
  history: z.boolean().optional(),
  quranAccent: z.boolean().optional(),
  quranArabic: z.boolean().optional(),
  partial: z.boolean().optional(),
  maxBlocks: z.number().int().min(1).max(500).optional(),
  visibleBlocks: z.number().int().min(0).max(100).optional(),
  pos: z.enum(["bottom", "top", "middle"]).optional(),
  lines: z.number().int().min(1).max(20).optional(),
  size: z.number().int().min(8).max(300).optional(),
  toolbar: z.enum(["auto", "on", "off"]).optional(),
});

// The schema must cover DisplayOptions exactly (compile-time check both ways).
type SchemaOptions = Required<z.output<typeof OptionsSchema>>;
const _optionsCoverContract: [SchemaOptions, DisplayOptions] extends [DisplayOptions, SchemaOptions]
  ? true
  : never = true;
void _optionsCoverContract;

const PresetSchema = z.object({
  id: z.string().regex(ID, "use 1-48 lowercase letters, digits or -"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(""),
  vars: z
    .record(z.string(), z.string())
    .default({})
    .superRefine((vars, ctx) => {
      for (const [name, value] of Object.entries(vars)) {
        if (REMOVED_THEME_VARS.has(name)) continue;
        if (!isThemeVar(name)) {
          ctx.addIssue({ code: "custom", path: [name], message: "unknown theme variable" });
          continue;
        }
        const problem = cssValueProblem(value);
        if (problem !== null) {
          ctx.addIssue({ code: "custom", path: [name], message: problem });
        } else if (parseVarValue(name, value) === null) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `"${value.slice(0, 60)}" is not an accepted value for this variable`,
          });
        }
      }
    }),
  options: OptionsSchema.default({}),
});

function isThemeVar(name: string): name is ThemeVar {
  return THEME_VAR_SET.has(name);
}

export type PresetResult = { ok: true; preset: ThemePreset } | { ok: false; errors: string[] };

/** Validate untrusted preset input (API body or a presets.yaml entry); values canonicalised. */
export function parsePreset(input: unknown): PresetResult {
  const result = PresetSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  const { id, name, description } = result.data;
  const vars: Partial<Record<ThemeVar, string>> = {};
  for (const v of THEME_VARS) {
    const value = result.data.vars[v];
    const canonical = value === undefined ? null : parseVarValue(v, value);
    if (canonical !== null) vars[v] = canonical;
  }
  const options: Partial<DisplayOptions> = { ...result.data.options };
  return { ok: true, preset: { id, name, description, vars, options } };
}

export type StoreResult =
  | { ok: true; preset: ThemePreset; created: boolean }
  | { ok: false; status: 400 | 404 | 409; errors: string[] };

const HEADER = `# Custom caption presets. Managed from /customize (POST/DELETE /api/presets);
# hand edits are fine. vars: CSS custom properties from src/shared/theme-vars.ts; options:
# display options (layout, bg, show, size, …). Built-in presets ship with the app.
`;

interface Stored {
  orgId: string;
  preset: ThemePreset;
}

export class PresetStore {
  private presets: Stored[] = [];
  private loadedMtimeMs: number | null = null;
  private fileProblems: string[] = [];

  /** `builtinIds` cannot be reused by custom presets. */
  constructor(
    readonly file: string,
    private readonly builtinIds: ReadonlySet<string> = new Set(),
  ) {}

  /** Re-read presets.yaml when its mtime changed. */
  reload(force = false): void {
    let mtimeMs: number | null;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (!force && mtimeMs === this.loadedMtimeMs) return;
    this.loadedMtimeMs = mtimeMs;
    this.presets = [];
    this.fileProblems = [];
    if (mtimeMs === null) return;
    let raw: unknown;
    try {
      raw = parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      this.fileProblems.push(`${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const list =
      typeof raw === "object" && raw !== null && "presets" in raw
        ? (raw as { presets: unknown }).presets
        : [];
    if (!Array.isArray(list)) {
      this.fileProblems.push(`${this.file}: "presets" must be a list`);
      return;
    }
    const seen = new Set<string>();
    list.forEach((entry, i) => {
      const rawOrg =
        typeof entry === "object" && entry !== null && "orgId" in entry
          ? (entry as { orgId: unknown }).orgId
          : LOCAL_ORG;
      if (typeof rawOrg !== "string" || !ORG_ID.test(rawOrg)) {
        this.fileProblems.push(`${this.file} presets[${i}]: invalid orgId`);
        return;
      }
      const parsed = parsePreset(entry);
      const key = parsed.ok ? `${rawOrg}\u0000${parsed.preset.id}` : "";
      if (!parsed.ok) {
        this.fileProblems.push(`${this.file} presets[${i}]: ${parsed.errors.join("; ")}`);
      } else if (seen.has(key) || this.builtinIds.has(parsed.preset.id)) {
        this.fileProblems.push(`${this.file} presets[${i}]: duplicate id "${parsed.preset.id}"`);
      } else {
        seen.add(key);
        this.presets.push({ orgId: rawOrg, preset: parsed.preset });
      }
    });
  }

  /** Problems found in presets.yaml (those entries are skipped). */
  get problems(): readonly string[] {
    this.reload();
    return this.fileProblems;
  }

  /** The custom presets of an organisation (default: the local one). */
  list(orgId: string = LOCAL_ORG): ThemePreset[] {
    this.reload();
    return this.presets.filter((p) => p.orgId === orgId).map((p) => structuredClone(p.preset));
  }

  get(id: string, orgId: string = LOCAL_ORG): ThemePreset | undefined {
    this.reload();
    const p = this.presets.find((x) => x.orgId === orgId && x.preset.id === id);
    return p === undefined ? undefined : structuredClone(p.preset);
  }

  /** Writing would drop entries that failed validation: refuse until the file is fixed. */
  private writeBlocked(): StoreResult | null {
    this.reload(true);
    if (this.fileProblems.length === 0) return null;
    return {
      ok: false,
      status: 409,
      errors: [`fix ${this.file} first (it would lose entries):`, ...this.fileProblems],
    };
  }

  /** Create or replace a custom preset of an organisation. */
  upsert(input: unknown, orgId: string = LOCAL_ORG): StoreResult {
    const parsed = parsePreset(input);
    if (!parsed.ok) return { ok: false, status: 400, errors: parsed.errors };
    const { preset } = parsed;
    if (this.builtinIds.has(preset.id)) {
      return {
        ok: false,
        status: 409,
        errors: [`id: "${preset.id}" is a built-in preset; choose another id`],
      };
    }
    const blocked = this.writeBlocked();
    if (blocked !== null) return blocked;
    const index = this.presets.findIndex((p) => p.orgId === orgId && p.preset.id === preset.id);
    const count = this.presets.filter((p) => p.orgId === orgId).length;
    if (index === -1 && count >= MAX_CUSTOM_PRESETS) {
      return { ok: false, status: 409, errors: [`at most ${MAX_CUSTOM_PRESETS} custom presets`] };
    }
    const next = [...this.presets];
    if (index === -1) next.push({ orgId, preset });
    else next[index] = { orgId, preset };
    this.save(next);
    return { ok: true, preset: structuredClone(preset), created: index === -1 };
  }

  /** Delete a custom preset of an organisation. */
  remove(id: string, orgId: string = LOCAL_ORG): StoreResult {
    const blocked = this.writeBlocked();
    if (blocked !== null) return blocked;
    const existing = this.presets.find((p) => p.orgId === orgId && p.preset.id === id);
    if (existing === undefined) {
      const why = this.builtinIds.has(id) ? "built-in presets cannot be deleted" : "no such preset";
      return { ok: false, status: 404, errors: [`${id}: ${why}`] };
    }
    this.save(this.presets.filter((p) => p !== existing));
    return { ok: true, preset: existing.preset, created: false };
  }

  /** Delete every custom preset of an organisation (the organisation is deleted). */
  removeOrg(orgId: string): number {
    if (this.writeBlocked() !== null) return 0;
    const next = this.presets.filter((p) => p.orgId !== orgId);
    const removed = this.presets.length - next.length;
    if (removed > 0) this.save(next);
    return removed;
  }

  private save(next: Stored[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // The local organisation's presets are written without orgId, as in files from before
    // organisations existed.
    const entries = next.map((p) =>
      p.orgId === LOCAL_ORG ? p.preset : { ...p.preset, orgId: p.orgId },
    );
    const body = stringify({ presets: entries }, { lineWidth: 0 });
    writeFileAtomic(this.file, HEADER + body, 0o644);
    this.presets = next;
    this.loadedMtimeMs = existsSync(this.file) ? statSync(this.file).mtimeMs : null;
  }
}
