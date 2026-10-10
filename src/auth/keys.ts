// Access keys for remote caption pages. keys.yaml in CONFIG_DIR holds only
// SHA-256 hashes; a key is shown once at creation. The file is managed by `turjuman keys` and
// re-read by the server whenever its mtime changes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../paths.js";
import { TRACK_IDS, type TrackId } from "../shared/protocol.js";
import { formatIssues, ValidationError } from "../validation.js";

const EntrySchema = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/, "keyHash must be a sha256 hex digest"),
  dailyMinutes: z.number().positive().nullable().default(null),
  /**
   * The engines the key may use. An older keys.yaml may also name the removed Gemini engine:
   * every key uses Soniox now (Turjuman uses Soniox only).
   */
  engines: z
    .array(z.enum(["soniox", "gemini"]))
    .default([...TRACK_IDS])
    .transform((): TrackId[] => [...TRACK_IDS]),
  expires: z.string().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});

const FileSchema = z.object({ keys: z.array(EntrySchema).nullable().default([]) });

export type AccessKeyEntry = z.output<typeof EntrySchema>;
/** What `list()` returns: never the hash. */
export type AccessKeyInfo = Omit<AccessKeyEntry, "keyHash">;

export interface AddKeyRequest {
  label: string;
  dailyMinutes?: number | null;
  engines?: TrackId[];
  /** ISO date/time after which the key stops working. */
  expires?: string;
}

const HEADER = `# Access keys for remote caption pages. Managed by \`turjuman keys\`;
# do not edit by hand. Only SHA-256 hashes are stored: a key is shown once, at creation.
`;

/** lastUsedAt is persisted at most this often per key. */
const TOUCH_INTERVAL_MS = 60_000;

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A new access key: 32 random bytes, base64url (43 characters). */
export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}

export class KeyStore {
  private entries: AccessKeyEntry[] = [];
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
      this.entries = result.data.keys ?? [];
      this.loadError = null;
    } catch (err) {
      // Keep the previous entries: a half-edited file must not lock everyone out or in.
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  /** The last load problem (an invalid file keeps the previously loaded keys), if any. */
  get error(): string | null {
    this.reload();
    return this.loadError;
  }

  list(): AccessKeyInfo[] {
    this.reload();
    return this.entries.map(({ keyHash: _hash, ...info }) => ({ ...info }));
  }

  get(id: string): AccessKeyInfo | undefined {
    this.reload();
    const e = this.entries.find((x) => x.id === id);
    if (e === undefined) return undefined;
    const { keyHash: _hash, ...info } = e;
    return info;
  }

  /** Create a key. The returned `key` is the only time it exists in clear text. */
  add(req: AddKeyRequest): { id: string; key: string; entry: AccessKeyInfo } {
    this.reload(true);
    if (this.loadError !== null) throw new Error(this.loadError);
    const label = req.label.trim();
    if (label === "") throw new Error("A key needs a --label");
    const dailyMinutes = req.dailyMinutes ?? null;
    if (dailyMinutes !== null && !(dailyMinutes > 0)) {
      throw new Error("--daily-minutes must be a positive number");
    }
    const engines = req.engines ?? [...TRACK_IDS];
    if (engines.length === 0) throw new Error("--engines needs at least one engine");
    let expires: string | undefined;
    if (req.expires !== undefined) {
      const t = Date.parse(req.expires);
      if (Number.isNaN(t)) throw new Error(`--expires: not a date: ${req.expires}`);
      expires = new Date(t).toISOString();
    }
    let id = randomBytes(4).toString("hex");
    while (this.entries.some((e) => e.id === id)) id = randomBytes(4).toString("hex");
    const key = generateKey();
    const entry: AccessKeyEntry = {
      id,
      label,
      keyHash: hashKey(key),
      dailyMinutes,
      engines: [...new Set(engines)],
      ...(expires === undefined ? {} : { expires }),
      createdAt: new Date(this.now()).toISOString(),
    };
    // Saved first: a key that could not be written must not work until the next reload.
    this.save([...this.entries, entry]);
    const { keyHash: _hash, ...info } = entry;
    return { id, key, entry: info };
  }

  /** Remove a key; returns the removed entry, or undefined when the id is unknown. */
  revoke(id: string): AccessKeyInfo | undefined {
    this.reload(true);
    if (this.loadError !== null) throw new Error(this.loadError);
    const e = this.entries.find((x) => x.id === id);
    if (e === undefined) return undefined;
    // Saved first: when the file cannot be written, the key stays (and keeps working).
    this.save(this.entries.filter((x) => x.id !== id));
    const { keyHash: _hash, ...info } = e;
    return info;
  }

  /**
   * The entry for a valid, unexpired key, or null. The digest is compared against every stored
   * hash (no early exit) with timingSafeEqual; digests always have equal length.
   */
  verify(key: string): AccessKeyInfo | null {
    this.reload();
    const digest = createHash("sha256").update(key, "utf8").digest();
    let match: AccessKeyEntry | null = null;
    for (const e of this.entries) {
      const stored = Buffer.from(e.keyHash, "hex");
      if (stored.length === digest.length && timingSafeEqual(stored, digest) && match === null) {
        match = e;
      }
    }
    if (match === null || key === "") return null;
    if (match.expires !== undefined && Date.parse(match.expires) <= this.now()) return null;
    this.touch(match);
    const { keyHash: _hash, ...info } = match;
    return info;
  }

  /** Persist lastUsedAt (throttled; re-reads the file first so CLI edits are not lost). */
  private touch(entry: AccessKeyEntry): void {
    const now = this.now();
    const last = entry.lastUsedAt === undefined ? 0 : Date.parse(entry.lastUsedAt);
    if (now - last < TOUCH_INTERVAL_MS) return;
    try {
      this.reload();
      const current = this.entries.find((e) => e.id === entry.id);
      if (current === undefined) return;
      current.lastUsedAt = new Date(now).toISOString();
      this.save(this.entries);
    } catch {
      // Best effort: a read-only CONFIG_DIR must not break verification.
    }
  }

  /** Write `entries` to the file, then make them the loaded ones (a failed write changes nothing). */
  private save(entries: AccessKeyEntry[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = stringify({ keys: entries }, { lineWidth: 0 });
    writeFileAtomic(this.file, HEADER + body, 0o600);
    this.entries = entries;
    this.loadedMtimeMs = existsSync(this.file) ? statSync(this.file).mtimeMs : null;
  }
}
