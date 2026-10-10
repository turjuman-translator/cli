import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountError,
  cleanDisplayName,
  isAdminRole,
  type NewUser,
  normalizeEmail,
  normalizeUsername,
  toMe,
  toUserView,
  type UserRecord,
  UserStore,
  usernameProblem,
} from "../../src/accounts/users.js";

const T0 = Date.UTC(2026, 9, 9, 8, 0, 0);
const HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
const LAST_ADMIN = {
  status: 409,
  message: "This is the last enabled admin account; make another admin first",
};

function user(req: Partial<NewUser> & { username: string }): NewUser {
  return { role: "user", passwordHash: HASH, ...req };
}

/** The AccountError a call throws (status and message), or null. */
function accountError(fn: () => unknown): { status: number; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof AccountError)) throw err;
    expect(err.name).toBe("AccountError");
    return { status: err.status, message: err.message };
  }
}

describe("account helpers", () => {
  it("normalizes usernames and e-mail addresses as stored", () => {
    expect(normalizeUsername("  Imam.Ali ")).toBe("imam.ali");
    expect(normalizeEmail("  Imam@Example.ORG ")).toBe("imam@example.org");
  });

  it("explains which usernames are allowed", () => {
    for (const ok of ["ab", "imam", "a.b-c_d", "0x", "x".repeat(32)]) {
      expect(usernameProblem(ok), ok).toBeNull();
    }
    for (const bad of ["a", "-imam", ".imam", "Imam", "imam ali", "x".repeat(33), "émile"]) {
      expect(usernameProblem(bad), bad).toBe(
        "A username has 2–32 characters: a–z, 0–9, dot, dash or underscore (starting with a letter or digit)",
      );
    }
  });

  it("cleans display names (control characters, spaces, 60 characters) with a fallback", () => {
    expect(cleanDisplayName("  Imam\u0000  Ali‏ ", "imam")).toBe("Imam Ali");
    expect(cleanDisplayName("   ", "imam")).toBe("imam");
    expect(cleanDisplayName(undefined, "imam")).toBe("imam");
    expect([...cleanDisplayName("ع".repeat(100), "x")]).toHaveLength(60);
  });

  it("owners and admins manage their organisation; users do not", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("user")).toBe(false);
  });

  it("shows an account to the app without its password hash, times in milliseconds", () => {
    const record: UserRecord = {
      id: "u1abc",
      username: "imam",
      displayName: "Imam",
      role: "admin",
      orgId: "local",
      email: "imam@example.org",
      passwordHash: HASH,
      sessionVersion: 4,
      disabled: false,
      createdAt: "2026-10-09T08:00:00.000Z",
      lastLoginAt: "2026-10-09T09:00:00.000Z",
    };
    expect(toMe(record)).toEqual({
      id: "u1abc",
      username: "imam",
      displayName: "Imam",
      role: "admin",
      orgId: "local",
      email: "imam@example.org",
    });
    const view = toUserView(record, 3);
    expect(view).toEqual({
      ...toMe(record),
      disabled: false,
      createdAt: T0,
      lastLoginAt: T0 + 3_600_000,
      screens: 3,
    });
    expect(JSON.stringify(view)).not.toContain("scrypt");
    // A hand-edited time that is not a date shows as 0 / never.
    expect(toUserView({ ...record, createdAt: "yesterday", lastLoginAt: "soon" }, 0)).toMatchObject(
      { createdAt: 0, lastLoginAt: null },
    );
    expect(toUserView({ ...record, lastLoginAt: null }, 0).lastLoginAt).toBeNull();
  });
});

describe("account store", () => {
  let dir: string;
  let file: string;
  let users: UserStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "users-"));
    file = join(dir, "config", "users.yaml");
    users = new UserStore(file, () => T0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates accounts (mode 0600) with a normalized username and e-mail", () => {
    const u = users.insert(
      user({
        username: "  Imam ",
        displayName: " Imam  Ali ",
        role: "owner",
        email: " Imam@Example.org ",
        orgId: "abcdefghij",
      }),
    );
    expect(u).toEqual({
      id: u.id,
      username: "imam",
      displayName: "Imam Ali",
      role: "owner",
      orgId: "abcdefghij",
      email: "imam@example.org",
      passwordHash: HASH,
      sessionVersion: 1,
      disabled: false,
      createdAt: "2026-10-09T08:00:00.000Z",
      lastLoginAt: null,
    });
    expect(u.id).toMatch(/^[0-9a-f]{12}$/);
    const local = users.insert(user({ username: "helper" }));
    expect(local).toMatchObject({ orgId: "local", email: null, displayName: "helper" });
    expect(users.insert(user({ username: "third", email: "" })).email).toBeNull();
    expect(users.count()).toBe(3);
    expect(readFileSync(file, "utf8")).toMatch(/^# Accounts of the app/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(users.byUsername(" IMAM ")?.id).toBe(u.id);
    expect(users.byEmail("IMAM@example.org")?.id).toBe(u.id);
    expect(users.byUsername("nobody")).toBeUndefined();
    expect(users.byEmail("nobody@example.org")).toBeUndefined();
    expect(users.get("nope")).toBeUndefined();
    expect(users.inOrg("abcdefghij").map((x) => x.username)).toEqual(["imam"]);
  });

  it("refuses a bad or taken username and a taken e-mail address", () => {
    users.insert(user({ username: "imam", email: "imam@example.org" }));
    expect(accountError(() => users.insert(user({ username: "x" })))).toMatchObject({
      status: 400,
    });
    expect(accountError(() => users.insert(user({ username: " IMAM " })))).toEqual({
      status: 409,
      message: 'The username "imam" is already taken',
    });
    expect(
      accountError(() => users.insert(user({ username: "other", email: "IMAM@example.org" }))),
    ).toEqual({ status: 409, message: "An account with this e-mail address exists already" });
    expect(users.count()).toBe(1);
  });

  it("edits an account; a new password or disabling logs it out everywhere", () => {
    const admin = users.insert(user({ username: "imam", role: "admin" }));
    const u = users.insert(user({ username: "helper", displayName: "Helper" }));
    const renamed = users.update(u.id, { displayName: "  ", role: "admin" });
    expect(renamed).toMatchObject({ displayName: "Helper", role: "admin", sessionVersion: 1 });
    expect(users.update(u.id, { displayName: " Br. Yusuf " }).displayName).toBe("Br. Yusuf");
    expect(users.update(u.id, { lastLoginAt: T0 + 1000 }).lastLoginAt).toBe(
      "2026-10-09T08:00:01.000Z",
    );
    expect(users.update(u.id, { passwordHash: "scrypt$new" })).toMatchObject({
      passwordHash: "scrypt$new",
      sessionVersion: 2,
    });
    expect(users.update(u.id, { disabled: true })).toMatchObject({
      disabled: true,
      sessionVersion: 3,
    });
    // Disabling a disabled account again, or enabling it, keeps the logins as they are.
    expect(users.update(u.id, { disabled: true }).sessionVersion).toBe(3);
    expect(users.update(u.id, { disabled: false }).sessionVersion).toBe(3);
    expect(new UserStore(file).get(u.id)?.displayName).toBe("Br. Yusuf");
    expect(accountError(() => users.update("nope", {}))).toEqual({
      status: 404,
      message: "No such account",
    });
    expect(users.get(admin.id)?.sessionVersion).toBe(1);
  });

  it("never demotes, disables or deletes the last enabled admin of an organisation", () => {
    const owner = users.insert(user({ username: "owner", role: "owner" }));
    const helper = users.insert(user({ username: "helper" }));
    // Another organisation's admin does not count.
    users.insert(user({ username: "elsewhere", role: "admin", orgId: "abcdefghij" }));
    expect(accountError(() => users.update(owner.id, { role: "user" }))).toEqual(LAST_ADMIN);
    expect(accountError(() => users.update(owner.id, { disabled: true }))).toEqual(LAST_ADMIN);
    expect(accountError(() => users.remove(owner.id))).toEqual(LAST_ADMIN);
    // An owner may become an admin: still an admin.
    expect(users.update(owner.id, { role: "admin" }).role).toBe("admin");
    // With a second admin, the first may go.
    users.update(helper.id, { role: "owner" });
    expect(users.update(owner.id, { role: "user" }).role).toBe("user");
    expect(accountError(() => users.remove(helper.id))).toEqual(LAST_ADMIN);
    expect(users.remove(owner.id).username).toBe("owner");
    expect(users.get(owner.id)).toBeUndefined();
    expect(accountError(() => users.remove(owner.id))).toEqual({
      status: 404,
      message: "No such account",
    });
  });

  it("deletes disabled admins and plain users freely", () => {
    const owner = users.insert(user({ username: "owner", role: "owner" }));
    const second = users.insert(user({ username: "second", role: "admin" }));
    users.update(second.id, { disabled: true });
    const helper = users.insert(user({ username: "helper" }));
    expect(users.remove(second.id).username).toBe("second");
    expect(users.remove(helper.id).username).toBe("helper");
    expect(users.list().map((u) => u.id)).toEqual([owner.id]);
  });

  it("deletes every account of a deleted organisation and returns them", () => {
    const local = users.insert(user({ username: "imam", role: "owner" }));
    users.insert(user({ username: "aisha", role: "owner", orgId: "orgaaaaaaa" }));
    users.insert(user({ username: "bilal", orgId: "orgaaaaaaa" }));
    expect(users.removeOrg("orgbbbbbbb")).toEqual([]);
    expect(users.removeOrg("orgaaaaaaa").map((u) => u.username)).toEqual(["aisha", "bilal"]);
    expect(users.list().map((u) => u.id)).toEqual([local.id]);
    expect(new UserStore(file).count()).toBe(1);
  });

  it("reads an empty file, or one with no accounts, as none", () => {
    writeFileSync(join(dir, "empty.yaml"), "");
    expect(new UserStore(join(dir, "empty.yaml")).count()).toBe(0);
    writeFileSync(join(dir, "null.yaml"), "users:\n");
    const none = new UserStore(join(dir, "null.yaml"));
    expect(none.list()).toEqual([]);
    expect(none.error).toBeNull();
    expect(none.insert(user({ username: "first", role: "owner" })).username).toBe("first");
  });

  it("keeps the accounts it had when users.yaml breaks, and refuses to write", () => {
    const owner = users.insert(user({ username: "owner", role: "owner" }));
    const entry = (id: string, username: string): string =>
      `  - { id: ${id}, username: ${username}, displayName: X, role: user, passwordHash: h, createdAt: x }`;
    writeFileSync(file, ["users:", entry("u1abc", "same"), entry("u1abc", "same")].join("\n"));
    users.reload(true);
    expect(users.error).toContain("(root): duplicate user id u1abc");
    expect(users.error).toContain("(root): duplicate username same");
    expect(users.get(owner.id)?.username).toBe("owner");
    expect(() => users.insert(user({ username: "new" }))).toThrow(/duplicate user id/);
    expect(() => users.update(owner.id, {})).toThrow(/duplicate user id/);
    writeFileSync(file, "users:\n  - { id: u1abc, username: Bad Name }\n");
    users.reload(true);
    expect(users.error).toMatch(/^Invalid .*users\.yaml:/);
    expect(users.error).toContain("users.0.username:");
    writeFileSync(file, "users: [ {id: 1 ");
    users.reload(true);
    expect(users.error).not.toBeNull();
    expect(users.count()).toBe(1);
    rmSync(file);
    expect(users.count()).toBe(0);
    expect(users.error).toBeNull();
  });
});
