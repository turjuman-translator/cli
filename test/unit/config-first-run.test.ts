// A first start needs nothing from the operator: config.yaml is made for the deployment, the admin
// token is generated once and kept in CONFIG_DIR, and settings that went away are dropped.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEPLOYMENT,
  defaultConfig,
  ensureConfigFile,
  generatedToken,
  loadConfig,
  needsToken,
  newConfigYaml,
  parseConfig,
  redactConfig,
  TOKEN_FILE,
} from "../../src/config.js";
import { createFileOnce } from "../../src/paths.js";
import type { ValidationError } from "../../src/validation.js";

const native = { inContainer: false, bindAddress: null };
const docker = { inContainer: true, bindAddress: "127.0.0.1" };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const isRoot = process.getuid?.() === 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-first-"));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const load = (opts: { create?: boolean; configFile?: string } = {}) =>
  loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir, ...opts });
const mode = (file: string): number => statSync(file).mode & 0o777;

describe("the config.yaml of a new install", () => {
  it("is a hosted server behind the operator's proxy in the hosted deployment", () => {
    const text = newConfigYaml("hosted");
    expect(parse(text)).toEqual({
      mode: "hosted",
      hosted: { signup: "open" },
      server: { exposure: "public", trustProxy: true },
    });
    // No hostname anywhere: links follow the request.
    expect(text).not.toMatch(/publicUrl|https?:\/\//);
    for (const ctx of [native, docker]) {
      const parsed = parseConfig(parse(text), ctx);
      expect(parsed.ok && parsed.config.hosted.publicUrl).toBeNull();
    }
  });

  it("is one mosque on this computer in the self-hosted deployment", () => {
    expect(parse(newConfigYaml("local"))).toEqual({
      mode: "local",
      server: { exposure: "local" },
    });
    for (const ctx of [native, docker]) {
      expect(parseConfig(parse(newConfigYaml("local")), ctx).ok).toBe(true);
    }
  });

  it("is made once, for this build's deployment, and never replaced", () => {
    const file = join(dir, "config.yaml");
    expect(ensureConfigFile(dir)).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(newConfigYaml(DEPLOYMENT));
    expect(mode(file)).toBe(0o644);
    writeFileSync(file, "server:\n  port: 9999\n");
    expect(ensureConfigFile(dir)).toBeNull();
    expect(ensureConfigFile(dir, "local")).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("server:\n  port: 9999\n");
  });

  it("makes its folder when it is missing", () => {
    const sub = join(dir, "new", "config");
    expect(ensureConfigFile(sub, "local")).toBe(join(sub, "config.yaml"));
    expect(parse(readFileSync(join(sub, "config.yaml"), "utf8")).mode).toBe("local");
  });

  it("is made by loadConfig({ create: true }) only, never with an explicit file", () => {
    const first = load();
    expect(first.paths.configFile).toBeNull();
    expect(first.createdConfigFile).toBeNull();
    expect(first.warnings).toContain(
      `No config.yaml in ${dir} yet; using the defaults (the server makes one when it starts)`,
    );
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);

    writeFileSync(join(dir, "other.yaml"), "server:\n  port: 9100\n");
    expect(load({ create: true, configFile: "other.yaml" }).createdConfigFile).toBeNull();
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);

    const created = load({ create: true });
    expect(created.createdConfigFile).toBe(join(dir, "config.yaml"));
    expect(created.paths.configFile).toBe(join(dir, "config.yaml"));
    expect(created.config.mode).toBe(DEPLOYMENT);
    expect(created.warnings.filter((w) => w.startsWith("No config.yaml"))).toEqual([]);
    expect(load({ create: true }).createdConfigFile).toBeNull();
  });
});

describe("the admin token", () => {
  it("is needed on a hosted server and when other devices reach the server", () => {
    const defaults = defaultConfig();
    const server = (exposure: "local" | "lan" | "public") => ({
      mode: "local" as const,
      server: { ...defaults.server, exposure },
    });
    expect(needsToken(server("local"))).toBe(false);
    expect(needsToken(server("lan"))).toBe(true);
    expect(needsToken(server("public"))).toBe(true);
    expect(needsToken({ ...server("local"), mode: "hosted" })).toBe(true);
  });

  it("is generated once for a hosted server, kept in CONFIG_DIR with mode 0600, and reused", () => {
    writeFileSync(join(dir, "config.yaml"), newConfigYaml("hosted"));
    const first = load();
    const file = join(dir, TOKEN_FILE);
    expect(first.tokenFile).toBe(file);
    expect(first.config.server.token).toMatch(TOKEN);
    expect(readFileSync(file, "utf8")).toBe(`${first.config.server.token}\n`);
    expect(mode(file)).toBe(0o600);
    // After a restart or an update: the same token.
    const again = load();
    expect(again.config.server.token).toBe(first.config.server.token);
    expect(again.warnings).toEqual([]);
    // Logged configs never show it.
    expect(JSON.stringify(redactConfig(again))).not.toContain(first.config.server.token);
  });

  it("differs per install", () => {
    const a = generatedToken(join(dir, "a", TOKEN_FILE));
    const b = generatedToken(join(dir, "b", TOKEN_FILE));
    expect(a).toMatch(TOKEN);
    expect(b).toMatch(TOKEN);
    expect(a).not.toBe(b);
  });

  it("is generated for exposure lan and public, not for a local server on this computer", () => {
    writeFileSync(join(dir, "config.yaml"), "server:\n  host: 0.0.0.0\n  exposure: lan\n");
    expect(load().config.server.token).toMatch(TOKEN);
    rmSync(join(dir, TOKEN_FILE));
    writeFileSync(join(dir, "config.yaml"), "server:\n  exposure: local\n");
    const local = load();
    expect(local.config.server.token).toBe("");
    expect(local.tokenFile).toBeNull();
    expect(existsSync(join(dir, TOKEN_FILE))).toBe(false);
  });

  it("set in config.yaml wins: nothing is generated", () => {
    const own = "my-own-token-for-this-hosted-server";
    writeFileSync(join(dir, "config.yaml"), `mode: hosted\nserver:\n  token: ${own}\n`);
    const loaded = load();
    expect(loaded.config.server.token).toBe(own);
    expect(loaded.tokenFile).toBeNull();
    expect(existsSync(join(dir, TOKEN_FILE))).toBe(false);
  });

  it("is not used when its file holds no token: a warning, and no token", () => {
    writeFileSync(join(dir, "config.yaml"), "mode: hosted\n");
    writeFileSync(join(dir, TOKEN_FILE), "short\n");
    const loaded = load();
    expect(loaded.config.server.token).toBe("");
    expect(loaded.tokenFile).toBeNull();
    expect(loaded.warnings).toEqual([
      `No admin token: ${join(dir, TOKEN_FILE)} holds no valid admin token; delete it to make a new one`,
    ]);
    // Deleting it makes a new one.
    rmSync(join(dir, TOKEN_FILE));
    expect(load().config.server.token).toMatch(TOKEN);
  });

  it.skipIf(isRoot)("warns, and runs without a token, when the config folder is read-only", () => {
    writeFileSync(join(dir, "config.yaml"), "mode: hosted\n");
    chmodSync(dir, 0o500);
    const loaded = load();
    expect(loaded.config.server.token).toBe("");
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toMatch(/^No admin token: EACCES/);
  });
});

describe("SERVER_PORT", () => {
  const env = (port: string) => ({ CONFIG_DIR: dir, DATA_DIR: dir, SERVER_PORT: port });

  it("sets the port, with or without a config.yaml, and keeps the other server settings", () => {
    expect(loadConfig({ env: env("18765"), cwd: dir }).config.server.port).toBe(18765);
    writeFileSync(join(dir, "config.yaml"), "server:\n  port: 9000\n  exposure: local\n");
    const loaded = loadConfig({ env: { ...env("9100"), SERVER_HOST: "localhost" }, cwd: dir });
    expect(loaded.config.server).toMatchObject({
      port: 9100,
      host: "localhost",
      exposure: "local",
    });
    // Empty counts as unset.
    expect(loadConfig({ env: env(""), cwd: dir }).config.server.port).toBe(9000);
  });

  it("is reported like a wrong server.port", () => {
    expect(() => loadConfig({ env: env("http"), cwd: dir })).toThrow(/Invalid config/);
    try {
      loadConfig({ env: env("70000"), cwd: dir });
    } catch (err) {
      expect((err as ValidationError).problems.join("\n")).toMatch(/server\.port/);
    }
    expect.assertions(2);
  });
});

describe("settings that went away", () => {
  it("drops pages.maxSessions with one warning: caption pages have no server-wide limit", () => {
    writeFileSync(join(dir, "config.yaml"), "pages:\n  maxSessions: 2\n  defaultTo: en\n");
    const loaded = load();
    expect(loaded.config.pages.defaultTo).toBe("en");
    expect("maxSessions" in loaded.config.pages).toBe(false);
    expect(loaded.warnings).toEqual([
      "pages.maxSessions is no longer used: caption pages have no server-wide limit any more",
    ]);
  });

  it("config.example.yaml has none of them", () => {
    const example = parse(readFileSync(join(process.cwd(), "config.example.yaml"), "utf8"));
    const parsed = parseConfig(example, native);
    expect(parsed.ok && parsed.warnings).toEqual([]);
  });
});

describe("createFileOnce", () => {
  it("creates a file with its folder once, and reports other errors", () => {
    const file = join(dir, "a", "b", "f.txt");
    expect(createFileOnce(file, "one", 0o600)).toBe(true);
    expect(createFileOnce(file, "two")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("one");
    expect(mode(file)).toBe(0o600);
  });

  it.skipIf(isRoot)('reports an error other than "it exists"', () => {
    const locked = join(dir, "locked");
    createFileOnce(join(locked, "keep.txt"), "");
    chmodSync(locked, 0o500);
    try {
      expect(() => createFileOnce(join(locked, "new.txt"), "x")).toThrow(/EACCES/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
