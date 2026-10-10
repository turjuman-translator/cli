// Screens: named caption feeds that run 24/7 in an OBS
// Browser Source. screens.yaml in CONFIG_DIR (mode 0600) holds them; it is managed by the admin
// portal and re-read whenever its mtime changes. Every screen has a GUID (a random UUID): its
// feed link is <origin>/feed/<guid>, which redirects to /<from>/<to>?<query>&screen=<guid>. Only the
// portal hands the GUID out, so the GUID is the link's signature; "Regenerate" gives a new one
// (old links stop working at once). The stable `id` is the portal's handle, never in a link.
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../paths.js";
import type { ScreenAction } from "../shared/protocol.js";
import { formatIssues, ValidationError } from "../validation.js";
import { AccountError } from "./users.js";

/** A version-4 UUID (crypto.randomUUID), lower case. */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 10;
const MAX_NAME = 80;
export const MAX_QUERY = 2000;
/** Query parameters a screen never stores: the link adds screen itself; keys stay private. */
/** Never part of a screen's look; engine/translation: the removed engine choice of older links. */
const STRIPPED_PARAMS: ReadonlySet<string> = new Set([
  "screen",
  "sig",
  "key",
  "token",
  "engine",
  "translation",
]);

const ACTIONS = ["created", "enabled", "disabled", "reset", "regenerated", "edited"] as const;

const ScreenSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  /** Missing in screens.yaml from before feed links had GUIDs: given one (and saved) on load. */
  guid: z.string().regex(GUID_RE).optional(),
  name: z.string().min(1).max(200),
  ownerId: z.string().nullable().default(null),
  /** The organisation; screens from before organisations existed belong to "local". */
  orgId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default("local"),
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
  query: z.string().max(8000).default(""),
  enabled: z.boolean().default(false),
  ownerControl: z.boolean().default(false),
  version: z.number().int().min(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastChange: z
    .strictObject({
      action: z.enum(ACTIONS),
      by: z.string(),
      byId: z.string().nullable().default(null),
      at: z.string(),
    })
    .nullable()
    .default(null),
});

const FileSchema = z
  .object({ screens: z.array(ScreenSchema).nullable().default([]) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const guids = new Set<string>();
    for (const s of file.screens ?? []) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate screen id ${s.id}` });
      ids.add(s.id);
      if (s.guid !== undefined && guids.has(s.guid)) {
        ctx.addIssue({ code: "custom", message: `duplicate screen guid on screen ${s.id}` });
      }
      if (s.guid !== undefined) guids.add(s.guid);
    }
  });

export type ScreenRecord = Omit<z.output<typeof ScreenSchema>, "guid"> & { guid: string };

const HEADER = `# Screens: caption feeds. Managed by the admin portal (/admin); do not
# edit by hand. Each guid is a secret: whoever has <origin>/feed/<guid> can show that feed.
`;

/** Who did something (lastChange.by is the display name at that moment). */
export interface Actor {
  id: string | null;
  name: string;
}

/** A new random screen id: 10 base32 characters (50 bits). */
export function newScreenId(): string {
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
  return out;
}

/** The feed link on `origin` (scheme://host[:port], no trailing slash): <origin>/feed/<guid>. */
export function screenUrl(origin: string, screen: ScreenRecord): string {
  return `${origin}/feed/${screen.guid}`;
}

/** Where /feed/<guid> sends the browser: the caption page with the screen's look and its GUID. */
export function screenTarget(screen: ScreenRecord): string {
  const params = new URLSearchParams(screen.query);
  // A screen saved before the engine choice was removed may still carry it: left out.
  params.delete("engine");
  params.delete("translation");
  params.set("screen", screen.guid);
  return `/${encodeURIComponent(screen.from)}/${encodeURIComponent(screen.to)}?${params.toString()}`;
}

/** The display query without a leading "?" and without STRIPPED_PARAMS. */
export function sanitizeQuery(raw: string): string {
  const params = new URLSearchParams(raw.trim().replace(/^\?/, ""));
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    if (!STRIPPED_PARAMS.has(k.toLowerCase())) out.append(k, v);
  }
  return out.toString();
}

/** Trimmed screen name without control characters; null when empty. */
export function cleanScreenName(name: string): string | null {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean === "" ? null : [...clean].slice(0, MAX_NAME).join("");
}

export interface NewScreen {
  name: string;
  from: string;
  to: string;
  query: string;
  ownerId: string | null;
  /** Default "local". */
  orgId?: string;
}

export interface ScreenPatch {
  name?: string;
  query?: string;
  enabled?: boolean;
  ownerControl?: boolean;
  /** Bump the version (regenerate: old links stop working). */
  regenerate?: boolean;
}

export class ScreenStore {
  private entries: ScreenRecord[] = [];
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
      let missing = false;
      this.entries = (result.data.screens ?? []).map((s) => {
        if (s.guid !== undefined) return { ...s, guid: s.guid };
        missing = true;
        return { ...s, guid: this.freshGuid() };
      });
      this.loadError = null;
      // screens.yaml from before feed GUIDs: the new GUIDs must survive the next load.
      if (missing) this.save();
    } catch (err) {
      // Keep the previous screens: a broken file must not switch every screen off (or on).
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  get error(): string | null {
    this.reload();
    return this.loadError;
  }

  list(): ScreenRecord[] {
    this.reload();
    return this.entries.map((s) => clone(s));
  }

  get(id: string): ScreenRecord | undefined {
    this.reload();
    const s = this.entries.find((x) => x.id === id);
    return s === undefined ? undefined : clone(s);
  }

  /** The screens of one organisation. */
  inOrg(orgId: string): ScreenRecord[] {
    return this.list().filter((s) => s.orgId === orgId);
  }

  /** The screen of a feed GUID, or null (malformed, unknown, or replaced by "regenerate"). */
  byGuid(guid: string): ScreenRecord | null {
    if (!GUID_RE.test(guid)) return null;
    this.reload();
    const s = this.entries.find((x) => x.guid === guid);
    return s === undefined ? null : clone(s);
  }

  create(req: NewScreen, actor: Actor): ScreenRecord {
    this.reloadForWrite();
    const name = cleanScreenName(req.name);
    if (name === null) throw new AccountError(400, "A screen needs a name");
    let id = newScreenId();
    while (this.entries.some((s) => s.id === id)) id = newScreenId();
    const at = new Date(this.now()).toISOString();
    const screen: ScreenRecord = {
      id,
      guid: this.freshGuid(),
      name,
      ownerId: req.ownerId,
      orgId: req.orgId ?? "local",
      from: req.from,
      to: req.to,
      query: req.query,
      enabled: false,
      ownerControl: false,
      version: 1,
      createdAt: at,
      updatedAt: at,
      lastChange: { action: "created", by: actor.name, byId: actor.id, at },
    };
    this.entries = [...this.entries, screen];
    this.save();
    return clone(screen);
  }

  /** Change a screen and record `action` as its lastChange. */
  update(id: string, patch: ScreenPatch, action: ScreenAction, actor: Actor): ScreenRecord {
    this.reloadForWrite();
    const current = this.entries.find((s) => s.id === id);
    if (current === undefined) throw new AccountError(404, "No such screen");
    const next = clone(current);
    if (patch.name !== undefined) {
      const name = cleanScreenName(patch.name);
      if (name === null) throw new AccountError(400, "A screen needs a name");
      next.name = name;
    }
    if (patch.query !== undefined) next.query = patch.query;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.ownerControl !== undefined) next.ownerControl = patch.ownerControl;
    if (patch.regenerate === true) {
      next.version = current.version + 1;
      next.guid = this.freshGuid();
    }
    const at = new Date(this.now()).toISOString();
    next.updatedAt = at;
    next.lastChange = { action, by: actor.name, byId: actor.id, at };
    this.entries = this.entries.map((s) => (s.id === id ? next : s));
    this.save();
    return clone(next);
  }

  remove(id: string): ScreenRecord {
    this.reloadForWrite();
    const current = this.entries.find((s) => s.id === id);
    if (current === undefined) throw new AccountError(404, "No such screen");
    this.entries = this.entries.filter((s) => s.id !== id);
    this.save();
    return clone(current);
  }

  /** Move every screen of `fromOwner` to `toOwner` (a deleted account); returns the count. */
  reassign(fromOwner: string, toOwner: string | null): number {
    this.reloadForWrite();
    let moved = 0;
    this.entries = this.entries.map((s) => {
      if (s.ownerId !== fromOwner) return s;
      moved++;
      return { ...s, ownerId: toOwner };
    });
    if (moved > 0) this.save();
    return moved;
  }

  /** Delete every screen of an organisation (the organisation is deleted); returns them. */
  removeOrg(orgId: string): ScreenRecord[] {
    this.reloadForWrite();
    const removed = this.entries.filter((s) => s.orgId === orgId);
    if (removed.length === 0) return [];
    this.entries = this.entries.filter((s) => s.orgId !== orgId);
    this.save();
    return removed.map((s) => clone(s));
  }

  /** Screens per owner id. */
  countByOwner(): Map<string, number> {
    this.reload();
    const out = new Map<string, number>();
    for (const s of this.entries) {
      if (s.ownerId !== null) out.set(s.ownerId, (out.get(s.ownerId) ?? 0) + 1);
    }
    return out;
  }

  /** A GUID no screen uses. */
  private freshGuid(): string {
    let guid = randomUUID();
    while (this.entries.some((s) => s.guid === guid)) guid = randomUUID();
    return guid;
  }

  private reloadForWrite(): void {
    this.reload(true);
    if (this.loadError !== null) throw new Error(this.loadError);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = stringify({ screens: this.entries }, { lineWidth: 0 });
    writeFileAtomic(this.file, HEADER + body, 0o600);
    this.loadedMtimeMs = existsSync(this.file) ? statSync(this.file).mtimeMs : null;
  }
}

function clone(s: ScreenRecord): ScreenRecord {
  return { ...s, lastChange: s.lastChange === null ? null : { ...s.lastChange } };
}
