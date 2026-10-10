import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { KeyResolver } from "../../src/accounts/key-resolver.js";
import { MasterKey } from "../../src/accounts/keystore.js";
import { OrgStore } from "../../src/accounts/orgs.js";
import { verifyPassword } from "../../src/accounts/passwords.js";
import type { FetchLike } from "../../src/accounts/provider-check.js";
import { UserStore } from "../../src/accounts/users.js";
import type { Prompter } from "../../src/cli/prompt.js";
import { setupCommand } from "../../src/cli/setup.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";

// Fake keys only: the injected fetch decides what each one "is"; nothing goes to the network.
const GOOD_SONIOX = "fake-soniox-good-0000000000000000";
const BAD_SONIOX = "fake-soniox-bad-11111111111111111";
const OLD_SONIOX = "fake-soniox-old-22222222222222222";
// An older .env may still hold a key for the removed Gemini engine: setup leaves that line alone.
const OLD_GEMINI = "fake-gemini-old-33333333333333333";
const ALL_KEYS = [GOOD_SONIOX, BAD_SONIOX, OLD_SONIOX, OLD_GEMINI];
const PORT = 8796;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setupDir(yaml = ""): { dir: string; loaded: LoadedConfig; envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "cli-setup-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "config.yaml"),
    `server:\n  port: ${PORT}\nlanguagesFile: ${join(process.cwd(), "languages.yaml")}\n${yaml}`,
  );
  const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
  return { dir, loaded, envFile: join(dir, ".env") };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) },
    out,
    err,
    all: () => [...out, ...err].join("\n"),
  };
}

/** Soniox's model list: 200 for the good and old keys, 401 for the bad ones; an Error = the network is down. */
function fakeFetch(down = false) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url.startsWith("https://api.soniox.com/") ? "soniox" : url);
    if (down) throw new Error("getaddrinfo ENOTFOUND");
    const key = (init.headers?.Authorization ?? "").replace(/^Bearer /, "");
    if (key.includes("-good-") || key.includes("-old-")) return { status: 200 };
    return { status: 401 };
  };
  return { fetch, calls };
}

const CTRL_C = Symbol("ctrl-c");

/** Answers in order: a string, null (end of input) or CTRL_C. Records what was asked. */
function scripted(answers: Array<string | null | typeof CTRL_C>) {
  const asked: string[] = [];
  let interrupted = false;
  const next = (q: string, secret: boolean): Promise<string | null> => {
    asked.push(`${secret ? "[secret] " : ""}${q.trim()}`);
    if (answers.length === 0) return Promise.resolve(null);
    const a = answers.shift();
    if (a === CTRL_C) {
      interrupted = true;
      return Promise.resolve(null);
    }
    return Promise.resolve(a ?? null);
  };
  const prompter: Prompter = {
    ask: (q) => next(q, false),
    askSecret: (q) => next(q, true),
    get interrupted() {
      return interrupted;
    },
    close: () => {},
  };
  return { prompter, asked };
}

function keyFile(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

function expectNoKeyShown(text: string): void {
  for (const key of ALL_KEYS) expect(text).not.toContain(key);
}

describe("turjuman setup (non-interactive)", () => {
  it("checks the Soniox key from a file and writes .env with mode 0600, keeping other lines", async () => {
    const { dir, loaded, envFile } = setupDir();
    writeFileSync(
      envFile,
      `# my settings\nDOMAIN=captions.example.org\n\nGEMINI_API_KEY=${OLD_GEMINI}\n`,
      { mode: 0o644 },
    );
    const file = keyFile(dir, "soniox.key", `\n  ${GOOD_SONIOX}  \n`);
    const { fetch, calls } = fakeFetch();
    const c = capture();
    const code = await setupCommand(["--soniox-key-file", file, "--yes"], c.io, () => loaded, {
      fetch,
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["soniox"]);
    expect(readFileSync(envFile, "utf8")).toBe(
      `# my settings\nDOMAIN=captions.example.org\n\nGEMINI_API_KEY=${OLD_GEMINI}\nSONIOX_API_KEY=${GOOD_SONIOX}\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const text = c.all();
    expect(text).toContain("OK: Soniox accepted the key.");
    expect(text).not.toMatch(/gemini/i);
    expect(text).toContain("No account yet");
    expect(text).toContain("pnpm turjuman start");
    expect(text).toContain(`http://127.0.0.1:${PORT}/app`);
    expectNoKeyShown(text);
  });

  it("saves a key it cannot check (no network) and says it is unchecked", async () => {
    const { dir, loaded, envFile } = setupDir();
    const file = keyFile(dir, "soniox.key", GOOD_SONIOX);
    const { fetch } = fakeFetch(true);
    const c = capture();
    const code = await setupCommand(["--soniox-key-file", file, "--yes"], c.io, () => loaded, {
      fetch,
    });
    expect(code).toBe(0);
    expect(c.err.join("\n")).toMatch(/Unchecked: Soniox could not be reached/);
    const env = parseEnv(readFileSync(envFile, "utf8"));
    // A new file holds the header and the Soniox key, nothing else.
    expect(env).toEqual({ SONIOX_API_KEY: GOOD_SONIOX });
    expect(readFileSync(envFile, "utf8")).toMatch(/^# Turjuman: the API key for the speech engine/);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expectNoKeyShown(c.all());
  });

  it("refuses a key the provider rejects and writes nothing", async () => {
    const { dir, loaded, envFile } = setupDir();
    const file = keyFile(dir, "soniox.key", BAD_SONIOX);
    const c = capture();
    const code = await setupCommand(["--soniox-key-file", file, "--yes"], c.io, () => loaded, {
      fetch: fakeFetch().fetch,
    });
    expect(code).toBe(1);
    expect(c.err.join("\n")).toMatch(/Not accepted: Soniox did not accept this key \(HTTP 401\)/);
    expect(existsSync(envFile)).toBe(false);
    expectNoKeyShown(c.all());
  });

  it("--yes without a key file keeps the current key, unchanged and unchecked", async () => {
    const { loaded, envFile } = setupDir();
    writeFileSync(envFile, `SONIOX_API_KEY=${OLD_SONIOX}\n`, { mode: 0o644 });
    const { fetch, calls } = fakeFetch();
    const c = capture();
    expect(await setupCommand(["--yes"], c.io, () => loaded, { fetch })).toBe(0);
    expect(calls).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(`SONIOX_API_KEY=${OLD_SONIOX}\n`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(c.out.join("\n")).toContain("keeping the current key …2222");
    expectNoKeyShown(c.all());
  });

  it("has no Gemini key option any more (the engine was removed)", async () => {
    const { dir, loaded, envFile } = setupDir();
    const c = capture();
    const file = keyFile(dir, "gemini.key", OLD_GEMINI);
    expect(await setupCommand(["--gemini-key-file", file, "--yes"], c.io, () => loaded)).toBe(2);
    expect(c.err.join("\n")).toMatch(/Unknown option '--gemini-key-file'/);
    expect(existsSync(envFile)).toBe(false);
  });

  it("reads a key file from standard input with -", async () => {
    const { loaded, envFile } = setupDir();
    const c = capture();
    const code = await setupCommand(["--soniox-key-file", "-", "-y"], c.io, () => loaded, {
      fetch: fakeFetch().fetch,
      readStdin: () => `${GOOD_SONIOX}\n`,
    });
    expect(code).toBe(0);
    expect(parseEnv(readFileSync(envFile, "utf8")).SONIOX_API_KEY).toBe(GOOD_SONIOX);
  });

  it("needs a Soniox key: --yes without one or with an empty file is an error", async () => {
    const { dir, loaded, envFile } = setupDir();
    let c = capture();
    expect(await setupCommand(["--yes"], c.io, () => loaded, { fetch: fakeFetch().fetch })).toBe(2);
    expect(c.err.join("\n")).toMatch(/no Soniox key: give --soniox-key-file/);
    c = capture();
    const empty = keyFile(dir, "empty.key", "\n\n");
    expect(
      await setupCommand(["--soniox-key-file", empty, "--yes"], c.io, () => loaded, {
        fetch: fakeFetch().fetch,
      }),
    ).toBe(2);
    expect(c.err.join("\n")).toMatch(/is empty/);
    c = capture();
    expect(
      await setupCommand(
        ["--soniox-key-file", join(dir, "missing.key"), "--yes"],
        c.io,
        () => loaded,
      ),
    ).toBe(2);
    expect(existsSync(envFile)).toBe(false);
  });

  it("never takes a key from the command line, and never echoes one", async () => {
    const { loaded } = setupDir();
    let c = capture();
    expect(await setupCommand([GOOD_SONIOX], c.io, () => loaded)).toBe(2);
    expect(c.err.join("\n")).toMatch(/never from the command line/);
    c = capture();
    expect(await setupCommand(["--soniox-key", GOOD_SONIOX], c.io, () => loaded)).toBe(2);
    c = capture();
    expect(await setupCommand([`--soniox-key=${GOOD_SONIOX}`], c.io, () => loaded)).toBe(2);
    expectNoKeyShown(c.all());
    c = capture();
    expect(
      await setupCommand(["--soniox-key-file", "-", "--gemini-key-file", "-"], c.io, () => loaded),
    ).toBe(2);
    expect(await setupCommand(["--check", "--soniox-key-file", "x"], c.io, () => loaded)).toBe(2);
  });

  it("prints help without loading the config", async () => {
    const c = capture();
    const code = await setupCommand(["--help"], c.io, () => {
      throw new Error("must not load");
    });
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("console.soniox.com");
    expect(c.out.join("\n")).not.toMatch(/gemini|aistudio/i);
    // `help` as the first argument too (not taken for a key on the command line).
    const h = capture();
    expect(
      await setupCommand(["help"], h.io, () => {
        throw new Error("must not load");
      }),
    ).toBe(0);
    expect(h.out).toEqual(c.out);
    expect(h.err).toEqual([]);
  });
});

describe("turjuman setup --check", () => {
  it("says OK, not accepted or unchecked, from the environment or .env", async () => {
    const { loaded, envFile } = setupDir();
    // An older Gemini key in .env is not checked or shown.
    writeFileSync(envFile, `GEMINI_API_KEY=${OLD_GEMINI}\nSONIOX_API_KEY=${BAD_SONIOX}\n`);
    let c = capture();
    const { fetch, calls } = fakeFetch();
    expect(
      await setupCommand(["--check"], c.io, () => loaded, {
        fetch,
        env: { SONIOX_API_KEY: GOOD_SONIOX },
      }),
    ).toBe(0);
    expect(calls).toEqual(["soniox"]);
    expect(c.out.join("\n")).toMatch(/Soniox\s+OK\s+key …0000/);
    expect(c.all()).not.toMatch(/gemini/i);
    expectNoKeyShown(c.all());

    // The environment wins; without it, the key in .env.
    c = capture();
    expect(
      await setupCommand(["--check"], c.io, () => loaded, { fetch: fakeFetch().fetch, env: {} }),
    ).toBe(1);
    expect(c.out.join("\n")).toMatch(
      /Soniox\s+not accepted\s+Soniox did not accept this key \(HTTP 401\)/,
    );
    expectNoKeyShown(c.all());

    c = capture();
    expect(
      await setupCommand(["--check"], c.io, () => loaded, {
        fetch: fakeFetch(true).fetch,
        env: { SONIOX_API_KEY: GOOD_SONIOX },
      }),
    ).toBe(0);
    expect(c.out.join("\n")).toMatch(/Soniox\s+unchecked\s+Soniox could not be reached/);
  });

  it("checks a key added in the app when the environment and .env have none", async () => {
    const { loaded } = setupDir();
    new KeyResolver({
      mode: "local",
      env: { sonioxApiKey: null },
      orgs: new OrgStore(loaded.paths.orgsFile),
      master: new MasterKey(loaded.paths.masterKeyFile, ""),
      log: pino({ level: "silent" }),
    }).store("local", "soniox", GOOD_SONIOX, { validated: true, by: null });
    const c = capture();
    expect(
      await setupCommand(["--check"], c.io, () => loaded, { fetch: fakeFetch().fetch, env: {} }),
    ).toBe(0);
    expect(c.out.join("\n")).toMatch(/Soniox\s+OK\s+key …0000 \(added in the app\)/);
    expectNoKeyShown(c.all());
  });

  it("fails when the required Soniox key is missing", async () => {
    const { loaded } = setupDir();
    const c = capture();
    const { fetch, calls } = fakeFetch();
    expect(await setupCommand(["--check"], c.io, () => loaded, { fetch, env: {} })).toBe(1);
    expect(c.out.join("\n")).toMatch(/Soniox\s+missing/);
    expect(calls).toEqual([]);
  });
});

describe("turjuman setup (interactive)", () => {
  it("asks again after a rejected key and creates the first admin", async () => {
    const { loaded, envFile } = setupDir();
    const { prompter, asked } = scripted([
      BAD_SONIOX, // rejected → asked again
      GOOD_SONIOX,
      "", // create the admin? (Enter = yes)
      "Bad Name!", // invalid username → asked again
      "Imam",
      "short", // too short
      "a long password 1",
      "a long password 2", // differs → both asked again
      "a long password 1",
      "a long password 1",
    ]);
    const c = capture();
    const code = await setupCommand([], c.io, () => loaded, { fetch: fakeFetch().fetch, prompter });
    expect(code).toBe(0);
    const env = parseEnv(readFileSync(envFile, "utf8"));
    expect(env).toEqual({ SONIOX_API_KEY: GOOD_SONIOX });
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const user = new UserStore(loaded.paths.usersFile).byUsername("imam");
    expect(user?.role).toBe("admin");
    expect(await verifyPassword("a long password 1", user?.passwordHash ?? "")).toBe(true);
    // Keys and passwords are asked without echo.
    expect(asked.filter((q) => q.startsWith("[secret]"))).toHaveLength(7);
    expect(asked.find((q) => q.includes("Username"))?.startsWith("[secret]")).toBe(false);
    const text = c.all();
    expect(text).toContain("Get one at https://console.soniox.com → API keys.");
    expect(text).not.toMatch(/gemini|aistudio/i);
    expect(text).toContain("Not accepted: Soniox did not accept this key (HTTP 401).");
    expect(text).toContain("The two passwords differ");
    expect(text).toContain("Created admin account imam.");
    expect(text).toContain(`http://127.0.0.1:${PORT}/app`);
    expect(text).not.toContain("a long password 1");
    expectNoKeyShown(text);
  });

  it("Enter keeps (and re-checks) the current key; no account is offered when one exists", async () => {
    const { loaded, envFile } = setupDir();
    writeFileSync(envFile, `# keep me\nSONIOX_API_KEY=${OLD_SONIOX}\n`, { mode: 0o644 });
    new UserStore(loaded.paths.usersFile).insert({
      username: "abdullah",
      role: "admin",
      passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA",
    });
    const { prompter, asked } = scripted(["", ""]);
    const { fetch, calls } = fakeFetch();
    const c = capture();
    expect(await setupCommand([], c.io, () => loaded, { fetch, prompter })).toBe(0);
    expect(calls).toEqual(["soniox"]);
    expect(asked[0]).toContain("Enter keeps the current key …2222");
    expect(readFileSync(envFile, "utf8")).toBe(`# keep me\nSONIOX_API_KEY=${OLD_SONIOX}\n`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(c.out.join("\n")).toContain("No key changed");
    expect(c.out.join("\n")).toContain("Accounts: 1 already");
  });

  it("asks for a new key when the provider rejects the current one", async () => {
    const { loaded, envFile } = setupDir();
    writeFileSync(envFile, `SONIOX_API_KEY=${BAD_SONIOX}\n`);
    const { prompter, asked } = scripted(["", GOOD_SONIOX, "n"]);
    const c = capture();
    expect(await setupCommand([], c.io, () => loaded, { fetch: fakeFetch().fetch, prompter })).toBe(
      0,
    );
    expect(asked[1]).not.toContain("Enter keeps");
    expect(parseEnv(readFileSync(envFile, "utf8")).SONIOX_API_KEY).toBe(GOOD_SONIOX);
    expect(c.out.join("\n")).toContain("Skipped. Later: pnpm turjuman users add <name> --admin");
    expect(new UserStore(loaded.paths.usersFile).count()).toBe(0);
  });

  it("Ctrl-C or the end of the input before a Soniox key saves nothing", async () => {
    const { loaded, envFile } = setupDir();
    let c = capture();
    expect(
      await setupCommand([], c.io, () => loaded, { prompter: scripted([CTRL_C]).prompter }),
    ).toBe(130);
    expect(c.err.join("\n")).toContain("Setup cancelled; nothing was saved.");
    c = capture();
    expect(
      await setupCommand([], c.io, () => loaded, { prompter: scripted([null]).prompter }),
    ).toBe(1);
    expect(c.err.join("\n")).toContain("the input ended");
    expect(existsSync(envFile)).toBe(false);
  });

  it("hosted mode asks nothing and makes no admin (mosques sign up)", async () => {
    const { loaded } = setupDir("mode: hosted\n");
    const c = capture();
    const { prompter } = scripted([GOOD_SONIOX]);
    expect(await setupCommand([], c.io, () => loaded, { fetch: fakeFetch().fetch, prompter })).toBe(
      0,
    );
    expect(c.out.join("\n")).toContain("Hosted mode");
    expect(new UserStore(loaded.paths.usersFile).count()).toBe(0);
  });
});

describe("setup in hosted mode", () => {
  it("explains that mosques add their own keys and asks nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-hosted-"));
    try {
      writeFileSync(join(dir, "config.yaml"), "mode: hosted\n");
      const out: string[] = [];
      const code = await setupCommand(
        [],
        { out: (t) => void out.push(t), err: (t) => void out.push(t) },
        () => loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir }),
      );
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("/app/keys");
      expect(existsSync(join(dir, ".env"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
