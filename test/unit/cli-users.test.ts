import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../../src/accounts/passwords.js";
import { ScreenStore } from "../../src/accounts/screens.js";
import { UserStore } from "../../src/accounts/users.js";
import { runCli } from "../../src/cli/index.js";
import { readPipedPassword, USERS_HELP, usersCommand } from "../../src/cli/users.js";
import type { LoadedConfig } from "../../src/config.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

beforeEach(() => {
  // Hints name `pnpm turjuman …` (a checkout), whatever the caller's shell says.
  vi.stubEnv("CAPTIONS_CONTAINER", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

/** A stand-in for process.stdin: a pipe (or a terminal) the test writes to. */
function fakeStdin(tty = false): PassThrough & { isTTY?: boolean } {
  const stream: PassThrough & { isTTY?: boolean } = new PassThrough();
  if (tty) stream.isTTY = true;
  return stream;
}

function asStdin(stream: PassThrough): NodeJS.ReadStream {
  return stream as unknown as NodeJS.ReadStream;
}

const piped = (password: string | null) => ({ readPassword: async () => password });

function cells(line: string | undefined): string[] {
  return (line ?? "").split(/ {2,}/);
}

describe("readPipedPassword", () => {
  it("reads nothing from a terminal", async () => {
    expect(await readPipedPassword(asStdin(fakeStdin(true)))).toBeNull();
  });

  it("takes the first line of a pipe, trimmed, and stops reading there", async () => {
    const stdin = fakeStdin();
    const result = readPipedPassword(asStdin(stdin));
    stdin.write("  first-line-secret  \nsecond line\n");
    expect(await result).toBe("first-line-secret");
    expect(stdin.destroyed).toBe(true);
    for (const event of ["data", "end", "error"]) expect(stdin.listenerCount(event)).toBe(0);
  });

  it("takes text without a newline when the pipe ends, and text given as a string", async () => {
    const stdin = fakeStdin();
    const result = readPipedPassword(asStdin(stdin));
    stdin.emit("data", "no-newline");
    stdin.end();
    expect(await result).toBe("no-newline");
  });

  it("answers null for an empty pipe or a read error", async () => {
    const empty = fakeStdin();
    const first = readPipedPassword(asStdin(empty));
    empty.end();
    expect(await first).toBeNull();
    const broken = fakeStdin();
    const second = readPipedPassword(asStdin(broken));
    broken.emit("error", new Error("EIO"));
    expect(await second).toBeNull();
  });

  it("stops after 4 KiB without a newline", async () => {
    const stdin = fakeStdin();
    const result = readPipedPassword(asStdin(stdin));
    stdin.write("x".repeat(5000));
    expect(await result).toBe("x".repeat(5000));
  });

  it("gives up after five seconds of silence", async () => {
    vi.useFakeTimers();
    const stdin = fakeStdin();
    const result = readPipedPassword(asStdin(stdin));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBeNull();
  });
});

describe("turjuman users add", () => {
  it("creates an account with a piped password and says where to log in", async () => {
    const { loaded } = configured();
    const c = capture();
    const code = await usersCommand(
      ["add", " Abdullah ", "--admin", "--name", "Abdullah K."],
      c.io,
      loaded,
      piped("a-good-password"),
    );
    expect(code).toBe(0);
    expect(c.out).toEqual([
      "Created admin account abdullah (Abdullah K.).",
      "Log in at http://127.0.0.1:8765/login on this computer.",
    ]);
    const user = new UserStore(loaded.paths.usersFile).byUsername("abdullah");
    expect(user).toMatchObject({ role: "admin", displayName: "Abdullah K." });
    expect(await verifyPassword("a-good-password", user?.passwordHash ?? "")).toBe(true);
  });

  it("generates a password when none is piped and prints it once", async () => {
    const { loaded } = configured("hosted:\n  publicUrl: https://captions.example.org/\n");
    const c = capture();
    expect(await usersCommand(["add", "helper"], c.io, loaded, piped(null))).toBe(0);
    const password = /^ {2}Password: (\S+)$/.exec(c.out[2] ?? "")?.[1] ?? "";
    expect(password).toHaveLength(16);
    expect(c.out).toEqual([
      "Created user account helper (helper).",
      "",
      `  Password: ${password}`,
      "",
      "This is the only time the password is shown; users.yaml keeps only a hash.",
      "Log in at https://captions.example.org/login.",
    ]);
    const user = new UserStore(loaded.paths.usersFile).byUsername("helper");
    expect(user?.role).toBe("user");
    expect(await verifyPassword(password, user?.passwordHash ?? "")).toBe(true);
  });

  it("reads the password from standard input when no reader is given", async () => {
    const { loaded } = configured();
    const stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(asStdin(stdin) as typeof process.stdin);
    const c = capture();
    const done = usersCommand(["add", "piped"], c.io, loaded);
    stdin.write("from-standard-input\n");
    expect(await done).toBe(0);
    const user = new UserStore(loaded.paths.usersFile).byUsername("piped");
    expect(await verifyPassword("from-standard-input", user?.passwordHash ?? "")).toBe(true);
  });

  it("refuses a missing, extra or invalid username and a short password with exit code 2", async () => {
    const { loaded } = configured();
    const cases: Array<[string[], string | null, RegExp]> = [
      [
        ["add"],
        "a-good-password",
        /^users add: give exactly one username, e\.g\. pnpm turjuman users add abdullah --admin$/,
      ],
      [["add", "a", "b"], "a-good-password", /give exactly one username/],
      [["add", "x"], "a-good-password", /^users add: /],
      [["add", "Bad Name!"], "a-good-password", /^users add: /],
      [["add", "fine-name"], "short", /^users add: .*8/],
    ];
    for (const [args, password, message] of cases) {
      const c = capture();
      expect(await usersCommand(args, c.io, loaded, piped(password))).toBe(2);
      expect(c.errText()).toMatch(message);
    }
    expect(new UserStore(loaded.paths.usersFile).count()).toBe(0);
  });

  it("refuses a username that is taken with exit code 1", async () => {
    const { loaded } = configured();
    const c = capture();
    expect(await usersCommand(["add", "imam"], c.io, loaded, piped("a-good-password"))).toBe(0);
    expect(await usersCommand(["add", "IMAM"], c.io, loaded, piped("a-good-password"))).toBe(1);
    expect(c.err).toEqual(['users add: the username "imam" is already taken']);
  });

  it("reports a users.yaml it cannot write to with exit code 1", async () => {
    const { loaded } = configured();
    writeFileSync(loaded.paths.usersFile, "users: 7\n");
    const c = capture();
    expect(await usersCommand(["add", "imam"], c.io, loaded, piped("a-good-password"))).toBe(1);
    expect(c.err[0]).toMatch(/^users add: Invalid .*users\.yaml/);
  });
});

describe("turjuman users list", () => {
  it("says how to create the first admin when there are no accounts", async () => {
    const { loaded } = configured();
    const c = capture();
    expect(await usersCommand(["list"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([
      `No accounts (${loaded.paths.usersFile}). Create the first admin with: pnpm turjuman users add <name> --admin`,
    ]);
  });

  it("names the make target inside the Docker image", async () => {
    vi.stubEnv("CAPTIONS_CONTAINER", "1");
    const { loaded } = configured();
    const c = capture();
    expect(await usersCommand(["list"], c.io, loaded)).toBe(0);
    expect(c.out[0]).toMatch(/Create the first admin with: make user-add USERNAME=<name> ADMIN=1$/);
  });

  it("lists accounts with role, status, times and screens", async () => {
    const { loaded } = configured();
    const store = new UserStore(loaded.paths.usersFile, () => Date.parse("2026-03-04T05:06:00Z"));
    const admin = store.insert({ username: "admin", role: "admin", passwordHash: "scrypt$x" });
    const helper = store.insert({
      username: "helper",
      displayName: "The helper",
      role: "user",
      passwordHash: "scrypt$x",
    });
    store.update(helper.id, { disabled: true, lastLoginAt: Date.parse("2026-03-05T07:08:00Z") });
    const screens = new ScreenStore(loaded.paths.screensFile);
    screens.create(
      { name: "Hall", from: "ar", to: "nl", query: "", ownerId: admin.id },
      { name: "cli", id: null },
    );
    const c = capture();
    expect(await usersCommand(["list"], c.io, loaded)).toBe(0);
    const at = (iso: string) => {
      const d = new Date(iso);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    expect((c.out[0] ?? "").split("\n").map(cells)).toEqual([
      ["ID", "USERNAME", "NAME", "ROLE", "STATUS", "CREATED", "LAST LOGIN", "SCREENS"],
      [admin.id, "admin", "admin", "admin", "active", at("2026-03-04T05:06:00Z"), "-", "1"],
      [
        helper.id,
        "helper",
        "The helper",
        "user",
        "disabled",
        at("2026-03-04T05:06:00Z"),
        at("2026-03-05T07:08:00Z"),
        "0",
      ],
    ]);
  });

  it("shows - for an account without an e-mail address next to ones with one", async () => {
    const { loaded } = configured();
    const store = new UserStore(loaded.paths.usersFile);
    store.insert({ username: "admin", role: "admin", passwordHash: "scrypt$x" });
    store.insert({
      username: "imam",
      role: "user",
      passwordHash: "scrypt$x",
      email: "imam@example.nl",
    });
    const c = capture();
    expect(await usersCommand(["list"], c.io, loaded)).toBe(0);
    const rows = (c.out[0] ?? "").split("\n").map(cells);
    expect(rows[0]?.slice(0, 3)).toEqual(["ID", "USERNAME", "E-MAIL"]);
    expect(rows.slice(1).map((r) => r[2])).toEqual(["-", "imam@example.nl"]);
    expect(rows[0]).not.toContain("ORG");
  });

  it("prints a time it cannot read as it is, and warns about a broken file", async () => {
    const { loaded } = configured();
    writeFileSync(
      loaded.paths.usersFile,
      "users:\n  - id: abcd1234\n    username: old\n    displayName: Old\n    role: admin\n    passwordHash: x\n    createdAt: long ago\n",
    );
    const c = capture();
    expect(await usersCommand(["list"], c.io, loaded)).toBe(0);
    expect(cells((c.out[0] ?? "").split("\n")[1])).toContain("long ago");
    writeFileSync(loaded.paths.usersFile, "users: [1]\n");
    const d = capture();
    expect(await usersCommand(["list"], d.io, loaded)).toBe(0);
    expect(d.err[0]).toMatch(/^Warning: Invalid .*users\.yaml/);
  });
});

describe("turjuman users passwd and remove", () => {
  let loaded: LoadedConfig;
  let store: UserStore;

  beforeEach(() => {
    loaded = configured().loaded;
    store = new UserStore(loaded.paths.usersFile);
  });

  it("sets a piped password and logs the account out everywhere", async () => {
    const user = store.insert({ username: "imam", role: "admin", passwordHash: "scrypt$old" });
    const c = capture();
    expect(await usersCommand(["passwd", "Imam"], c.io, loaded, piped("the-new-password"))).toBe(0);
    expect(c.out).toEqual(["New password set for imam; it is logged out on every device."]);
    const after = store.get(user.id);
    expect(await verifyPassword("the-new-password", after?.passwordHash ?? "")).toBe(true);
    expect(after?.sessionVersion).toBe(user.sessionVersion + 1);
  });

  it("generates a new password when none is piped", async () => {
    const user = store.insert({ username: "imam", role: "admin", passwordHash: "scrypt$old" });
    const c = capture();
    expect(await usersCommand(["passwd", "imam"], c.io, loaded, piped(null))).toBe(0);
    const password = /^ {2}Password: (\S+)$/.exec(c.out[2] ?? "")?.[1] ?? "";
    expect(c.out[4]).toBe("This is the only time the password is shown.");
    expect(await verifyPassword(password, store.get(user.id)?.passwordHash ?? "")).toBe(true);
  });

  it("refuses a short password, a wrong count of names and an unknown account", async () => {
    store.insert({ username: "imam", role: "admin", passwordHash: "scrypt$old" });
    const c = capture();
    expect(await usersCommand(["passwd", "imam"], c.io, loaded, piped("short"))).toBe(2);
    expect(await usersCommand(["passwd"], c.io, loaded)).toBe(2);
    expect(await usersCommand(["passwd", "a", "b"], c.io, loaded)).toBe(2);
    expect(await usersCommand(["passwd", " Nobody "], c.io, loaded)).toBe(1);
    expect(await usersCommand(["passwd", " who@example.nl "], c.io, loaded)).toBe(1);
    expect(c.err.slice(1)).toEqual([
      "users passwd: give exactly one username or e-mail address",
      "users passwd: give exactly one username or e-mail address",
      'users passwd: no account "nobody"',
      'users passwd: no account "who@example.nl"',
    ]);
    expect(c.err[0]).toMatch(/^users passwd: /);
    expect(store.byUsername("imam")?.passwordHash).toBe("scrypt$old");
  });

  it("removes an account and hands its screens to the admins", async () => {
    const admin = store.insert({ username: "admin", role: "admin", passwordHash: "scrypt$x" });
    const helper = store.insert({ username: "helper", role: "user", passwordHash: "scrypt$x" });
    const screens = new ScreenStore(loaded.paths.screensFile);
    const actor = { name: "cli", id: null };
    screens.create({ name: "Hall", from: "ar", to: "nl", query: "", ownerId: helper.id }, actor);
    screens.create({ name: "Women", from: "ar", to: "en", query: "", ownerId: helper.id }, actor);
    const c = capture();
    expect(await usersCommand(["remove", "helper"], c.io, loaded)).toBe(0);
    expect(c.out).toEqual([
      "Removed account helper. Its 2 screen(s) keep running and are now managed by the admins.",
    ]);
    expect(screens.list().map((s) => s.ownerId)).toEqual([null, null]);
    expect(store.get(helper.id)).toBeUndefined();
    const other = store.insert({ username: "other", role: "user", passwordHash: "scrypt$x" });
    c.clear();
    expect(await usersCommand(["remove", other.username], c.io, loaded)).toBe(0);
    expect(c.out).toEqual(["Removed account other."]);
    expect(store.get(admin.id)).toBeDefined();
  });

  it("refuses a wrong count of names, an unknown account and the last admin", async () => {
    const admin = store.insert({ username: "admin", role: "admin", passwordHash: "scrypt$x" });
    const c = capture();
    expect(await usersCommand(["remove"], c.io, loaded)).toBe(2);
    expect(await usersCommand(["remove", "a", "b"], c.io, loaded)).toBe(2);
    expect(await usersCommand(["remove", "ghost"], c.io, loaded)).toBe(1);
    expect(c.err).toEqual([
      "users remove: give exactly one username or e-mail address",
      "users remove: give exactly one username or e-mail address",
      'users remove: no account "ghost"',
    ]);
    c.clear();
    expect(await usersCommand(["remove", "admin"], c.io, loaded)).toBe(1);
    expect(c.err[0]).toMatch(/^users remove: /);
    expect(store.get(admin.id)).toBeDefined();
  });

  it("prints its help, and refuses an unknown command or none with exit code 2", async () => {
    for (const sub of ["help", "--help", "-h"]) {
      const c = capture();
      expect(await usersCommand([sub], c.io, loaded)).toBe(0);
      expect(c.out).toEqual([USERS_HELP]);
    }
    const c = capture();
    expect(await usersCommand([], c.io, loaded)).toBe(2);
    expect(await usersCommand(["rename"], c.io, loaded)).toBe(2);
    expect(c.err).toEqual([USERS_HELP, `Unknown users command: rename\n\n${USERS_HELP}`]);
  });

  it("runCli refuses an option with the users usage", async () => {
    const { dir } = configured();
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["users", "add", "x", "--owner"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman users: Unknown option '--owner'.\n\n${USERS_HELP}`);
    c.clear();
    expect(await runCli(["users", "list"], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^No accounts/);
    // list takes no options, passwd and remove only a name.
    for (const argv of [
      ["users", "list", "--bogus"],
      ["users", "passwd", "imam", "--bogus"],
      ["users", "remove", "--all"],
    ]) {
      c.clear();
      expect(await runCli(argv, c.io), argv.join(" ")).toBe(2);
      expect(c.errText()).toMatch(/^turjuman users: Unknown option '--(bogus|all)'\.\n\n/);
      expect(c.errText()).toContain(USERS_HELP);
    }
  });
});
