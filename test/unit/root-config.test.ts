import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../../src/config.js";
import { ValidationError } from "../../src/validation.js";

describe("loadConfig: an explicit file and SERVER_HOST", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfg-root-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads an explicitly given config file (relative to the working directory)", () => {
    mkdirSync(join(dir, "etc"));
    writeFileSync(join(dir, "etc", "mosque.yaml"), "server:\n  port: 9100\n");
    // Ignored: the explicit file wins over CONFIG_DIR/config.yaml.
    writeFileSync(join(dir, "config.yaml"), "server:\n  port: 9200\n");
    const loaded = loadConfig({
      configFile: "etc/mosque.yaml",
      env: { CONFIG_DIR: dir },
      cwd: dir,
    });
    expect(loaded.paths.configFile).toBe(join(dir, "etc", "mosque.yaml"));
    expect(loaded.config.server.port).toBe(9100);
    expect(loaded.warnings).toEqual([]);
  });

  it("SERVER_HOST replaces only the host of the server settings in config.yaml", () => {
    writeFileSync(join(dir, "config.yaml"), "server:\n  port: 9300\n  exposure: lan\n");
    const loaded = loadConfig({ env: { CONFIG_DIR: dir, SERVER_HOST: "0.0.0.0" }, cwd: dir });
    expect(loaded.config.server).toMatchObject({ host: "0.0.0.0", port: 9300, exposure: "lan" });
  });

  it("SERVER_HOST also applies when config.yaml has no server settings (or an empty one)", () => {
    writeFileSync(join(dir, "config.yaml"), "display:\n  layout: rollup\n");
    const env = { CONFIG_DIR: dir, SERVER_HOST: "localhost" };
    const loaded = loadConfig({ env, cwd: dir });
    expect(loaded.config.server.host).toBe("localhost");
    expect(loaded.config.display.layout).toBe("rollup");
    // An empty SERVER_HOST counts as unset.
    expect(
      loadConfig({ env: { CONFIG_DIR: dir, SERVER_HOST: "" }, cwd: dir }).config.server.host,
    ).toBe("127.0.0.1");
    writeFileSync(join(dir, "config.yaml"), "server:\n");
    expect(loadConfig({ env, cwd: dir }).config.server.host).toBe("localhost");
  });

  it("still refuses a config.yaml that is no config when SERVER_HOST is set", () => {
    const problems = (yaml: string): string[] => {
      writeFileSync(join(dir, "config.yaml"), yaml);
      try {
        loadConfig({ env: { CONFIG_DIR: dir, SERVER_HOST: "127.0.0.1" }, cwd: dir });
        return [];
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return err.problems;
      }
    };
    // The same problems as without SERVER_HOST: not "unrecognized keys 0, 1", not silently fixed.
    expect(problems("- just\n- a list\n")).toEqual([
      "(root): Invalid input: expected object, received array",
    ]);
    expect(problems("just text\n")).toEqual([
      "(root): Invalid input: expected object, received string",
    ]);
    expect(problems("server: lan\n")).toEqual([
      "server: Invalid input: expected object, received string",
    ]);
    expect(problems("server: [127.0.0.1]\n")).toEqual([
      "server: Invalid input: expected object, received array",
    ]);
  });

  it('names "(defaults)" when the environment alone makes the config invalid', () => {
    let error: unknown;
    try {
      loadConfig({ env: { CONFIG_DIR: dir, SERVER_HOST: "0.0.0.0" }, cwd: dir });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message.split("\n")[0]).toBe("Invalid config (defaults):");
    expect((error as ValidationError).problems).toEqual([
      'server.host: "0.0.0.0" is not loopback; use server.exposure "lan" to listen on the network',
    ]);
  });
});

describe("parseConfig: values that are not a config at all", () => {
  const ctx = { inContainer: false, bindAddress: null };

  it("reads null and undefined as an empty config (defaults)", () => {
    expect(parseConfig(null, ctx).ok).toBe(true);
    expect(parseConfig(undefined, ctx).ok).toBe(true);
  });

  it("refuses a scalar or a list, and still runs the cross-field checks on defaults", () => {
    const scalar = parseConfig(42, ctx);
    expect(scalar).toEqual({
      ok: false,
      errors: ["(root): Invalid input: expected object, received number"],
    });
    const list = parseConfig(["server"], { inContainer: false, bindAddress: "0.0.0.0" });
    expect(list).toEqual({
      ok: false,
      errors: [
        "(root): Invalid input: expected object, received array",
        'CAPTIONS_BIND: "0.0.0.0" publishes the server on the network; set server.exposure "lan"',
      ],
    });
  });

  it("reads the cross-field settings leniently when other settings are wrong", () => {
    const result = parseConfig(
      { mode: "hosted", server: { token: "short", exposure: "public", port: "x" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      "server.port: Invalid input: expected number, received string",
      "server.token: use at least 24 random characters on a hosted server (it opens every mosque's sessions), or leave it empty",
      'server.trustProxy: must be true when server.exposure is "public" (behind a proxy)',
    ]);
    // Not a mapping at all: the defaults are checked.
    const odd = parseConfig({ server: "lan", mode: 3 }, ctx);
    expect(odd.ok ? [] : odd.errors).toEqual([
      'mode: Invalid option: expected one of "local"|"hosted"',
      "server: Invalid input: expected object, received string",
    ]);
  });
});
