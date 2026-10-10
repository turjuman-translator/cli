// Organisations: a mosque or institution that owns accounts, screens, custom
// presets and API keys. orgs.yaml in CONFIG_DIR (mode 0600) holds them; it is re-read whenever its
// mtime changes and written atomically. Keys are stored encrypted (keystore.ts) next to their last
// four characters and the time they were last checked; never in plain text. Local mode has one
// organisation, "local", which exists implicitly (its record is written the first time it changes).
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../paths.js";
import type { KeyProvider } from "../shared/protocol.js";
import { formatIssues, ValidationError } from "../validation.js";
import { AccountError } from "./users.js";

export const LOCAL_ORG_ID = "local";
export const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 10;
const MAX_NAME = 80;
const LOCAL_NAME = "Local";

const SEALED = z.string().startsWith("enc:v1:").max(4096);

const KeyMetaSchema = z.strictObject({
  last4: z.string().max(8),
  /** ISO time of the last successful check with the provider; null = not checked. */
  validatedAt: z.string().nullable().default(null),
  addedAt: z.string(),
  /** The account that stored it (null: the CLI or the server operator). */
  addedBy: z.string().nullable().default(null),
});

/**
 * An older orgs.yaml may also hold a key for the removed Gemini engine (Turjuman uses Soniox
 * only): it is read and ignored, and left out the next time the file is written.
 */
const LegacyGemini = z.unknown().optional();

const OrgSchema = z.strictObject({
  id: z.string().regex(ORG_ID_RE),
  name: z.string().min(1).max(200),
  createdAt: z.string(),
  disabled: z.boolean().default(false),
  keys: z
    .strictObject({ soniox: SEALED.optional(), gemini: LegacyGemini })
    .default({})
    .transform(({ gemini: _gemini, ...keys }) => keys),
  keyMeta: z
    .strictObject({ soniox: KeyMetaSchema.optional(), gemini: LegacyGemini })
    .default({})
    .transform(({ gemini: _gemini, ...meta }) => meta),
});

const FileSchema = z
  .object({ orgs: z.array(OrgSchema).nullable().default([]) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const o of file.orgs ?? []) {
      if (ids.has(o.id))
        ctx.addIssue({ code: "custom", message: `duplicate organisation ${o.id}` });
      ids.add(o.id);
    }
  });

export type OrgRecord = z.output<typeof OrgSchema>;
export type KeyMeta = z.output<typeof KeyMetaSchema>;

const HEADER = `# Organisations. Managed by the app (/app) and \`turjuman orgs\`; do not edit by hand.
# API keys are encrypted with master.key (or TURJUMAN_MASTER_KEY): without it they cannot
# be read, and with it anyone can. Keep both out of backups that leave this server.
`;

/** Trimmed organisation name without control characters (at most 80); null when empty. */
export function cleanOrgName(name: string): string | null {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean === "" ? null : [...clean].slice(0, MAX_NAME).join("");
}

function newOrgId(): string {
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
  return out;
}

function clone(o: OrgRecord): OrgRecord {
  return {
    ...o,
    keys: { ...o.keys },
    keyMeta: o.keyMeta.soniox === undefined ? {} : { soniox: { ...o.keyMeta.soniox } },
  };
}

export class OrgStore {
  private entries: OrgRecord[] = [];
  private loadedMtimeMs: number | null = null;
  private loadError: string | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Re-read the file when its mtime changed (or it appeared/disappeared). */
  reload(force = false): void {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (!force && mtimeMs === this.loadedMtimeMs) return;
    this.loadedMtimeMs = mtimeMs;
    if (mtimeMs === null) {
      this.entries = [];
      this.loadError = null;
      return;
    }
    try {
      const raw: unknown = parse(readFileSync(this.file, "utf8")) ?? {};
      const result = FileSchema.safeParse(raw);
      if (!result.success) {
        throw new ValidationError(`Invalid ${this.file}`, formatIssues(result.error));
      }
      this.entries = result.data.orgs ?? [];
      this.loadError = null;
    } catch (err) {
      // Keep the previous organisations: a broken file must not lock every mosque out.
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  get error(): string | null {
    this.reload();
    return this.loadError;
  }

  /** Every stored organisation (the implicit "local" one only once it has a record). */
  list(): OrgRecord[] {
    this.reload();
    return this.entries.map(clone);
  }

  /** An organisation; "local" always exists (implicitly until it is changed). */
  get(id: string): OrgRecord | undefined {
    this.reload();
    const o = this.entries.find((x) => x.id === id);
    if (o !== undefined) return clone(o);
    return id === LOCAL_ORG_ID ? this.implicitLocal() : undefined;
  }

  create(req: { name: string }): OrgRecord {
    this.reloadForWrite();
    const name = cleanOrgName(req.name);
    if (name === null) throw new AccountError(400, "Give your mosque or organisation a name");
    let id = newOrgId();
    while (this.entries.some((o) => o.id === id)) id = newOrgId();
    const org: OrgRecord = {
      id,
      name,
      createdAt: new Date(this.now()).toISOString(),
      disabled: false,
      keys: {},
      keyMeta: {},
    };
    this.entries = [...this.entries, org];
    this.save();
    return clone(org);
  }

  rename(id: string, name: string): OrgRecord {
    const clean = cleanOrgName(name);
    if (clean === null) throw new AccountError(400, "Give your mosque or organisation a name");
    return this.change(id, (o) => {
      o.name = clean;
    });
  }

  setDisabled(id: string, disabled: boolean): OrgRecord {
    return this.change(id, (o) => {
      o.disabled = disabled;
    });
  }

  /** Store an encrypted key (replacing the previous one) with its metadata. */
  setKey(id: string, provider: KeyProvider, sealed: string, meta: KeyMeta): OrgRecord {
    if (!SEALED.safeParse(sealed).success) throw new Error("setKey expects an encrypted key");
    return this.change(id, (o) => {
      o.keys[provider] = sealed;
      o.keyMeta[provider] = { ...meta };
    });
  }

  removeKey(id: string, provider: KeyProvider): OrgRecord {
    return this.change(id, (o) => {
      delete o.keys[provider];
      delete o.keyMeta[provider];
    });
  }

  /** Delete an organisation record (its accounts, screens and presets are the caller's). */
  remove(id: string): OrgRecord {
    this.reloadForWrite();
    const current = this.entries.find((o) => o.id === id);
    if (current === undefined) throw new AccountError(404, "No such organisation");
    this.entries = this.entries.filter((o) => o.id !== id);
    this.save();
    return clone(current);
  }

  private change(id: string, edit: (org: OrgRecord) => void): OrgRecord {
    this.reloadForWrite();
    let current = this.entries.find((o) => o.id === id);
    if (current === undefined && id === LOCAL_ORG_ID) {
      current = this.implicitLocal();
      this.entries = [...this.entries, current];
    }
    if (current === undefined) throw new AccountError(404, "No such organisation");
    const next = clone(current);
    edit(next);
    this.entries = this.entries.map((o) => (o.id === id ? next : o));
    this.save();
    return clone(next);
  }

  private implicitLocal(): OrgRecord {
    return {
      id: LOCAL_ORG_ID,
      name: LOCAL_NAME,
      createdAt: new Date(0).toISOString(),
      disabled: false,
      keys: {},
      keyMeta: {},
    };
  }

  private reloadForWrite(): void {
    this.reload(true);
    if (this.loadError !== null) throw new Error(this.loadError);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = stringify({ orgs: this.entries }, { lineWidth: 0 });
    writeFileAtomic(this.file, HEADER + body, 0o600);
    this.loadedMtimeMs = existsSync(this.file) ? statSync(this.file).mtimeMs : null;
  }
}
