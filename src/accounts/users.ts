// Portal accounts: users.yaml in CONFIG_DIR (mode 0600) holds usernames,
// roles and scrypt password hashes. Managed in the app and with `turjuman users`; re-read
// whenever its mtime changes. `sessionVersion` is part of every login cookie: bumping it (new
// password, disabled account) logs the account out on every device.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../paths.js";
import type { Me, UserRole, UserView } from "../shared/protocol.js";
import { formatIssues, ValidationError } from "../validation.js";

/** A portal request that cannot be done; `status` is the HTTP status to answer with. */
export class AccountError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const MAX_DISPLAY_NAME = 60;

const UserSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  username: z.string().regex(USERNAME_RE),
  displayName: z.string().min(1).max(200),
  role: z.enum(["owner", "admin", "user"]),
  /** The organisation; files from before organisations existed migrate to "local". */
  orgId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default("local"),
  /** Hosted mode logs in by e-mail; lower-case. */
  email: z.string().email().max(254).nullable().default(null),
  passwordHash: z.string().min(1),
  sessionVersion: z.number().int().min(0).default(1),
  disabled: z.boolean().default(false),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable().default(null),
});

const FileSchema = z
  .object({ users: z.array(UserSchema).nullable().default([]) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const u of file.users ?? []) {
      if (ids.has(u.id)) ctx.addIssue({ code: "custom", message: `duplicate user id ${u.id}` });
      if (names.has(u.username)) {
        ctx.addIssue({ code: "custom", message: `duplicate username ${u.username}` });
      }
      ids.add(u.id);
      names.add(u.username);
    }
  });

export type UserRecord = z.output<typeof UserSchema>;

const HEADER = `# Accounts of the app. Managed in the app (/app) and with \`turjuman users\`;
# do not edit by hand. Passwords are stored as scrypt hashes only.
`;

/** Lower-case, trimmed username as stored. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Why a (normalized) username is not acceptable, or null. */
export function usernameProblem(username: string): string | null {
  if (USERNAME_RE.test(username)) return null;
  return "A username has 2–32 characters: a–z, 0–9, dot, dash or underscore (starting with a letter or digit)";
}

/** Trimmed display name without control characters, at most 60 characters; `fallback` when empty. */
export function cleanDisplayName(name: string | undefined, fallback: string): string {
  const clean = (name ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...(clean === "" ? fallback : clean)].slice(0, MAX_DISPLAY_NAME).join("");
}

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function toMe(user: UserRecord): Me {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    orgId: user.orgId,
    email: user.email,
  };
}

/** Owners and admins manage their organisation. */
export function isAdminRole(role: UserRole): boolean {
  return role === "owner" || role === "admin";
}

/** Lower-case, trimmed e-mail as stored. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toUserView(user: UserRecord, screens: number): UserView {
  return {
    ...toMe(user),
    disabled: user.disabled,
    createdAt: ms(user.createdAt) ?? 0,
    lastLoginAt: ms(user.lastLoginAt),
    screens,
  };
}

export interface NewUser {
  username: string;
  displayName?: string;
  role: UserRole;
  passwordHash: string;
  /** Defaults to "local". */
  orgId?: string;
  email?: string | null;
}

export interface UserPatch {
  displayName?: string;
  role?: UserRole;
  disabled?: boolean;
  passwordHash?: string;
  lastLoginAt?: number;
}

export class UserStore {
  private entries: UserRecord[] = [];
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
      this.entries = result.data.users ?? [];
      this.loadError = null;
    } catch (err) {
      // Keep the previous entries: a half-edited file must not lock everyone out (or in).
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  /** The last load problem (the previously loaded accounts stay in use), if any. */
  get error(): string | null {
    this.reload();
    return this.loadError;
  }

  list(): UserRecord[] {
    this.reload();
    return this.entries.map((u) => ({ ...u }));
  }

  count(): number {
    this.reload();
    return this.entries.length;
  }

  get(id: string): UserRecord | undefined {
    this.reload();
    const u = this.entries.find((x) => x.id === id);
    return u === undefined ? undefined : { ...u };
  }

  byUsername(username: string): UserRecord | undefined {
    this.reload();
    const name = normalizeUsername(username);
    const u = this.entries.find((x) => x.username === name);
    return u === undefined ? undefined : { ...u };
  }

  byEmail(email: string): UserRecord | undefined {
    this.reload();
    const e = normalizeEmail(email);
    const u = this.entries.find((x) => x.email === e);
    return u === undefined ? undefined : { ...u };
  }

  /** The accounts of one organisation. */
  inOrg(orgId: string): UserRecord[] {
    return this.list().filter((u) => u.orgId === orgId);
  }

  /** Create an account (the password is already hashed). */
  insert(req: NewUser): UserRecord {
    this.reloadForWrite();
    const username = normalizeUsername(req.username);
    const problem = usernameProblem(username);
    if (problem !== null) throw new AccountError(400, problem);
    if (this.entries.some((u) => u.username === username)) {
      throw new AccountError(409, `The username "${username}" is already taken`);
    }
    const email = req.email ? normalizeEmail(req.email) : null;
    if (email !== null && this.entries.some((u) => u.email === email)) {
      throw new AccountError(409, "An account with this e-mail address exists already");
    }
    let id = randomBytes(6).toString("hex");
    while (this.entries.some((u) => u.id === id)) id = randomBytes(6).toString("hex");
    const user: UserRecord = {
      id,
      username,
      displayName: cleanDisplayName(req.displayName, username),
      role: req.role,
      orgId: req.orgId ?? "local",
      email,
      passwordHash: req.passwordHash,
      sessionVersion: 1,
      disabled: false,
      createdAt: new Date(this.now()).toISOString(),
      lastLoginAt: null,
    };
    this.entries = [...this.entries, user];
    this.save();
    return { ...user };
  }

  /**
   * Change an account. A new password or disabling bumps sessionVersion (logs out every
   * device). The last enabled admin cannot be demoted or disabled.
   */
  update(id: string, patch: UserPatch): UserRecord {
    this.reloadForWrite();
    const current = this.entries.find((u) => u.id === id);
    if (current === undefined) throw new AccountError(404, "No such account");
    const next: UserRecord = { ...current };
    if (patch.displayName !== undefined) {
      next.displayName = cleanDisplayName(patch.displayName, current.displayName);
    }
    if (patch.role !== undefined) next.role = patch.role;
    if (patch.disabled !== undefined) next.disabled = patch.disabled;
    if (patch.passwordHash !== undefined) next.passwordHash = patch.passwordHash;
    if (patch.lastLoginAt !== undefined)
      next.lastLoginAt = new Date(patch.lastLoginAt).toISOString();
    const wasAdmin = isAdminRole(current.role) && !current.disabled;
    const isAdmin = isAdminRole(next.role) && !next.disabled;
    if (wasAdmin && !isAdmin && this.enabledAdmins(current.orgId) <= 1) {
      throw new AccountError(
        409,
        "This is the last enabled admin account; make another admin first",
      );
    }
    if (patch.passwordHash !== undefined || (patch.disabled === true && !current.disabled)) {
      next.sessionVersion = current.sessionVersion + 1;
    }
    this.entries = this.entries.map((u) => (u.id === id ? next : u));
    this.save();
    return { ...next };
  }

  /** Delete an account (the last enabled admin cannot be deleted). */
  remove(id: string): UserRecord {
    this.reloadForWrite();
    const current = this.entries.find((u) => u.id === id);
    if (current === undefined) throw new AccountError(404, "No such account");
    if (isAdminRole(current.role) && !current.disabled && this.enabledAdmins(current.orgId) <= 1) {
      throw new AccountError(
        409,
        "This is the last enabled admin account; make another admin first",
      );
    }
    this.entries = this.entries.filter((u) => u.id !== id);
    this.save();
    return { ...current };
  }

  /** End every login of an account (a new sessionVersion), so a cookie copied before a logout
   *  stops working. Used when the account logs out itself. */
  endSessions(id: string): UserRecord {
    this.reloadForWrite();
    const current = this.entries.find((u) => u.id === id);
    if (current === undefined) throw new AccountError(404, "No such account");
    const next: UserRecord = { ...current, sessionVersion: current.sessionVersion + 1 };
    this.entries = this.entries.map((u) => (u.id === id ? next : u));
    this.save();
    return { ...next };
  }

  /** Delete every account of an organisation (the organisation is deleted); returns them. */
  removeOrg(orgId: string): UserRecord[] {
    this.reloadForWrite();
    const removed = this.entries.filter((u) => u.orgId === orgId);
    if (removed.length === 0) return [];
    this.entries = this.entries.filter((u) => u.orgId !== orgId);
    this.save();
    return removed.map((u) => ({ ...u }));
  }

  private enabledAdmins(orgId: string): number {
    return this.entries.filter((u) => u.orgId === orgId && isAdminRole(u.role) && !u.disabled)
      .length;
  }

  private reloadForWrite(): void {
    this.reload(true);
    if (this.loadError !== null) throw new Error(this.loadError);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = stringify({ users: this.entries }, { lineWidth: 0 });
    writeFileAtomic(this.file, HEADER + body, 0o600);
    this.loadedMtimeMs = existsSync(this.file) ? statSync(this.file).mtimeMs : null;
  }
}
