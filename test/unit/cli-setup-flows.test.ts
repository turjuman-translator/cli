import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../../src/accounts/passwords.js";
import type { FetchLike } from "../../src/accounts/provider-check.js";
import { UserStore } from "../../src/accounts/users.js";
import type { Prompter } from "../../src/cli/prompt.js";
import { setupCommand } from "../../src/cli/setup.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

// `--soniox-key-file -` reads file descriptor 0: the tests answer that read themselves.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});

const { readFileSync: mockedRead } = await import("node:fs");

// Fake keys only: the injected fetch accepts them; nothing goes to the network.
const KEY = "fake-soniox-good-0000000000000000";
const PASSWORD = "a-good-password";

const accept: FetchLike = async () => ({ status: 200 });

const CTRL_C = Symbol("ctrl-c");

/** Answers in order: a string, null (end of input) or CTRL_C. */
function scripted(answers: Array<string | null | typeof CTRL_C>): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let interrupted = false;
  const next = (q: string): Promise<string | null> => {
    asked.push(q.trim());
    const a = answers.length === 0 ? null : answers.shift();
    if (a === CTRL_C) {
      interrupted = true;
      return Promise.resolve(null);
    }
    return Promise.resolve(a ?? null);
  };
  return {
    asked,
    ask: next,
    askSecret: next,
    get interrupted() {
      return interrupted;
    },
    close: () => {},
  };
}

beforeEach(() => {
  vi.stubEnv("CAPTIONS_CONTAINER", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(mockedRead).mockClear();
  removeTempDirs();
});

async function interactive(answers: Array<string | null | typeof CTRL_C>, yaml = "") {
  const { dir, loaded } = configured(yaml);
  const prompter = scripted(answers);
  const c = capture();
  const code = await setupCommand([], c.io, () => loaded, { fetch: accept, prompter });
  return { dir, loaded, prompter, c, code };
}

describe("turjuman setup: the key", () => {
  it("asks again when Enter is pressed without a current key", async () => {
    const { dir, c, code } = await interactive(["", KEY, "n"]);
    expect(code).toBe(0);
    expect(c.err).toContain("  The Soniox key is required.");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`SONIOX_API_KEY=${KEY}`);
  });

  it("reads `--soniox-key-file -` from standard input", async () => {
    const { dir, loaded } = configured();
    vi.mocked(mockedRead).mockImplementationOnce((file) => {
      expect(file).toBe(0);
      return `${KEY}\n`;
    });
    const c = capture();
    const code = await setupCommand(["--yes", "--soniox-key-file", "-"], c.io, () => loaded, {
      fetch: accept,
    });
    expect(code).toBe(0);
    expect(c.out).toContain("Soniox API key: from standard input");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`SONIOX_API_KEY=${KEY}`);
  });

  it("refuses an empty standard input as the key file", async () => {
    const { dir, loaded } = configured();
    const c = capture();
    const code = await setupCommand(["--yes", "--soniox-key-file", "-"], c.io, () => loaded, {
      fetch: accept,
      readStdin: () => "\n  \n",
    });
    expect(code).toBe(2);
    expect(c.err).toEqual(["setup: the key file (stdin) is empty"]);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("reports what goes wrong while saving with exit code 1", async () => {
    const { dir, loaded } = configured();
    mkdirSync(join(dir, ".env")); // a folder where the .env file should be
    const c = capture();
    const code = await setupCommand(["--yes"], c.io, () => loaded, { fetch: accept });
    expect(code).toBe(1);
    expect(c.err).toEqual([expect.stringMatching(/^setup: EISDIR/)]);
  });
});

describe("turjuman setup: the first admin account", () => {
  it("creates the admin after an invalid username, a short password and two different ones", async () => {
    const answers = [KEY, "", "x", "Imam", "short", PASSWORD, "different-one", PASSWORD, PASSWORD];
    const { loaded, c, code, prompter } = await interactive(answers);
    expect(code).toBe(0);
    const admin = new UserStore(loaded.paths.usersFile).byUsername("imam");
    expect(admin?.role).toBe("admin");
    expect(await verifyPassword(PASSWORD, admin?.passwordHash ?? "")).toBe(true);
    expect(c.out).toContain("  Created admin account imam.");
    expect(c.err).toContain("  The two passwords differ; try again.");
    expect(prompter.asked.filter((q) => q === "Username:")).toHaveLength(2);
    expect(prompter.asked.filter((q) => q.startsWith("Password (at least 8"))).toHaveLength(3);
  });

  it("refuses a username that is taken", async () => {
    const { loaded } = configured();
    const store = new UserStore(loaded.paths.usersFile);
    // Made by another process between the count and the question.
    const prompter = scripted([KEY, "y", "imam", "second", PASSWORD, PASSWORD]);
    const ask = prompter.ask;
    prompter.ask = async (q) => {
      if (q.includes("Username")) {
        if (store.byUsername("imam") === undefined) {
          store.insert({ username: "imam", role: "user", passwordHash: "scrypt$x" });
        }
      }
      return ask(q);
    };
    const c = capture();
    const code = await setupCommand([], c.io, () => loaded, { fetch: accept, prompter });
    expect(code).toBe(0);
    expect(c.err).toContain('  "imam" is taken.');
    expect(store.byUsername("second")?.role).toBe("admin");
  });

  it("warns about a users.yaml it cannot read and makes no account", async () => {
    const { dir, loaded } = configured();
    writeFileSync(join(dir, "users.yaml"), "users: 7\n");
    const c = capture();
    const code = await setupCommand(["--yes"], c.io, () => loaded, { fetch: accept });
    expect(code).toBe(2); // no key either: --yes without one stops first
    writeFileSync(join(dir, ".env"), `SONIOX_API_KEY=${KEY}\n`);
    const d = capture();
    expect(await setupCommand(["--yes"], d.io, () => loaded, { fetch: accept })).toBe(0);
    expect(d.err[0]).toMatch(/^Warning: Invalid .*users\.yaml/);
    expect(d.err[1]).toBe(
      "  Fix that file, then create the first admin: pnpm turjuman users add <name> --admin",
    );
    expect(d.out).toContain("Next steps:");
  });

  it("ends without an account when the input ends at any question", async () => {
    const cases: Array<Array<string | null>> = [
      [KEY, null], // create it?
      [KEY, "y", null], // username
      [KEY, "y", "imam", null], // password
      [KEY, "y", "imam", PASSWORD, null], // password again
    ];
    for (const answers of cases) {
      const { loaded, c, code } = await interactive(answers);
      expect(code).toBe(0);
      expect(c.out).toContain(
        "No admin account was made (the input ended). Later: pnpm turjuman users add <name> --admin, " +
          `or at http://127.0.0.1:${loaded.config.server.port}/login.`,
      );
      expect(c.out).toContain("Next steps:");
      expect(new UserStore(loaded.paths.usersFile).count()).toBe(0);
    }
  });

  it("stops with 130 on Ctrl-C at the account questions; the key stays saved", async () => {
    const { dir, loaded, c, code } = await interactive([KEY, "y", "imam", CTRL_C]);
    expect(code).toBe(130);
    expect(c.err).toContain("Cancelled: the keys are saved; no admin account was made.");
    expect(c.out).not.toContain("Next steps:");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(KEY);
    expect(new UserStore(loaded.paths.usersFile).count()).toBe(0);
  });
});
