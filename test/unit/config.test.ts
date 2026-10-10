import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type ConfigContext,
  dropRemovedKeys,
  isLoopbackHost,
  loadConfig,
  loadDotEnv,
  loadEnvFiles,
  parseConfig,
  redactConfig,
} from "../../src/config.js";

const native: ConfigContext = { inContainer: false, bindAddress: null };
const exampleRaw = parse(readFileSync(join(process.cwd(), "config.example.yaml"), "utf8"));

function errorsOf(raw: unknown, ctx: ConfigContext = native): string[] {
  const result = parseConfig(raw, ctx);
  return result.ok ? [] : result.errors;
}

describe("parseConfig", () => {
  it("parses config.example.yaml, and every default matches the example", () => {
    const fromExample = parseConfig(exampleRaw, native);
    const fromDefaults = parseConfig({}, native);
    expect(fromExample.ok).toBe(true);
    expect(fromDefaults.ok).toBe(true);
    if (fromExample.ok && fromDefaults.ok) {
      expect(fromDefaults.config).toEqual(fromExample.config);
      expect(fromDefaults.config.audio.input.kind).toBe("none");
      expect(fromDefaults.config.stt.soniox.region).toBe("default");
    }
  });

  it("rejects unknown keys and names their path", () => {
    const errors = errorsOf({ stt: { sonix: { model: "x" } } });
    expect(errors.join("\n")).toMatch(/stt.*sonix/);
  });

  it("allows account logins without a token for lan and public exposure", () => {
    expect(errorsOf({ server: { exposure: "lan" } })).toEqual([]);
    expect(errorsOf({ server: { exposure: "public", trustProxy: true } })).toEqual([]);
    expect(errorsOf({ server: { exposure: "lan", token: "s3cret-token-value" } })).toEqual([]);
  });

  it("requires trustProxy for public exposure", () => {
    expect(errorsOf({ server: { exposure: "public" } }).join("\n")).toMatch(/trustProxy/);
  });

  it("refuses a non-loopback host with local exposure when running natively", () => {
    expect(errorsOf({ server: { host: "0.0.0.0" } }).join("\n")).toMatch(/server\.host/);
    expect(
      errorsOf({ server: { host: "0.0.0.0" } }, { inContainer: true, bindAddress: null }),
    ).toEqual([]);
  });

  it("refuses a non-loopback CAPTIONS_BIND with local exposure", () => {
    const lanBind: ConfigContext = { inContainer: true, bindAddress: "0.0.0.0" };
    expect(errorsOf({ server: { host: "0.0.0.0" } }, lanBind).join("\n")).toMatch(/CAPTIONS_BIND/);
    const loopBind: ConfigContext = { inContainer: true, bindAddress: "127.0.0.1" };
    expect(errorsOf({ server: { host: "0.0.0.0" } }, loopBind)).toEqual([]);
  });
});

/**
 * A config.yaml from before Turjuman became Soniox-only, with every setting of the
 * removed Gemini engine, LLM translation, compare mode and caption composer.
 */
const OLDER_CONFIG = `
server:
  host: 127.0.0.1
  port: 8765
stt:
  mode: single
  provider: soniox
  primary: soniox
  soniox:
    model: stt-rt-v5
  gemini:
    model: gemini-3.5-transcribe-live
    languageCodes: []
    mode: VERBATIM
    customVocabularyFromGlossary: true
    rotateAfterSec: 480
    forceRotateAfterSec: 570
translation:
  engine: native
  targetLanguage: nl
  llm:
    provider: gemini
    model: gemini-3.5-flash-lite
    contextPairs: 3
pages:
  defaultEngine: soniox
  defaultTo: nl
pricing:
  sonioxSttPerHour: 0.12
  geminiTranscribeLivePerMin: 0.009
  llmInputPerMTok: 0.3
  llmOutputPerMTok: 2.5
composer:
  model: gemini-3.8-flash
  maxWords: 15
  maxSentences: 2
  maxCarryMs: 6000
  contextBlocks: 4
  timeoutMs: 8000
  promptFile: prompts/composer.md
display:
  layout: blocks
`;

describe("settings of removed engines and features (Turjuman uses Soniox only)", () => {
  it("an older config.yaml still loads: each removed key dropped with one warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-old-"));
    writeFileSync(join(dir, "config.yaml"), OLDER_CONFIG);
    const loaded = loadConfig({ env: { CONFIG_DIR: dir }, cwd: dir });
    const used = "is no longer used: Turjuman uses Soniox only";
    expect(loaded.warnings).toEqual([
      `stt.mode ${used}`,
      `stt.provider ${used}`,
      `stt.primary ${used}`,
      `stt.gemini ${used}`,
      `translation.engine ${used}`,
      `translation.llm ${used}`,
      `pages.defaultEngine ${used}`,
      `pricing.geminiTranscribeLivePerMin ${used}`,
      `pricing.llmInputPerMTok ${used}`,
      `pricing.llmOutputPerMTok ${used}`,
      `composer ${used}`,
    ]);
    // The settings that are still there keep their values.
    expect(loaded.config.translation.targetLanguage).toBe("nl");
    expect(loaded.config.pricing.sonioxSttPerHour).toBe(0.12);
    expect(loaded.config.display.layout).toBe("blocks");
    expect(loaded.config).not.toHaveProperty("composer");
    expect(loaded.config.stt).not.toHaveProperty("gemini");
  });

  it("a setting that asked for Gemini, the LLM, compare mode or the composer runs on Soniox", () => {
    const r = parseConfig(
      {
        stt: { mode: "compare", provider: "gemini", primary: "gemini" },
        translation: { engine: "llm" },
        pages: { defaultEngine: "gemini" },
        composer: { enabled: true },
      },
      native,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([
      'stt.mode is no longer used: Turjuman uses Soniox only (it asked for "compare"; Soniox runs instead)',
      'stt.provider is no longer used: Turjuman uses Soniox only (it asked for "gemini"; Soniox runs instead)',
      'stt.primary is no longer used: Turjuman uses Soniox only (it asked for "gemini"; Soniox runs instead)',
      'translation.engine is no longer used: Turjuman uses Soniox only (it asked for "llm"; Soniox runs instead)',
      'pages.defaultEngine is no longer used: Turjuman uses Soniox only (it asked for "gemini"; Soniox runs instead)',
      "composer is no longer used: Turjuman uses Soniox only (it asked for the composer; Soniox runs instead)",
    ]);
    expect(r.config).toEqual((parseConfig({}, native) as { config: unknown }).config);
  });

  it("transcripts.recordAudio and debug.faultInjection, which had no effect, are dropped with a warning", () => {
    const r = parseConfig(
      {
        transcripts: { srt: false, recordAudio: true },
        debug: { faultInjection: false },
      },
      native,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([
      "transcripts.recordAudio is no longer used: it had no effect",
      "debug is no longer used: debug.faultInjection had no effect",
    ]);
    expect(r.config.transcripts.srt).toBe(false);
    expect(r.config.transcripts).not.toHaveProperty("recordAudio");
    expect(r.config).not.toHaveProperty("debug");
  });

  it("other mistakes are still errors, and the caller's object is not changed", () => {
    const raw = { stt: { gemini: { model: "x" }, sonix: {} }, composer: { enabled: true } };
    expect(errorsOf(raw).join("\n")).toMatch(/stt.*sonix/);
    expect(raw).toEqual({
      stt: { gemini: { model: "x" }, sonix: {} },
      composer: { enabled: true },
    });
    expect(dropRemovedKeys(raw).raw).toEqual({ stt: { sonix: {} } });
    expect(dropRemovedKeys(null)).toEqual({ raw: null, warnings: [] });
  });

  it("a GEMINI_API_KEY in the environment or .env is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(dir, ".env"), "SONIOX_API_KEY=snx\nGEMINI_API_KEY=gem-secret\n");
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir };
    loadEnvFiles(env, dir);
    const loaded = loadConfig({ env, cwd: dir });
    expect(loaded.secrets).toEqual({ sonioxApiKey: "snx" });
    expect(JSON.stringify(redactConfig(loaded))).not.toContain("gem-secret");
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback names and addresses", () => {
    for (const h of ["127.0.0.1", "127.0.1.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.10", "example.org"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("loadDotEnv", () => {
  const touched = ["KC_TEST_FROM_FILE", "KC_TEST_PRESET"];
  afterEach(() => {
    for (const k of touched) delete process.env[k];
  });

  it("returns false (and does not throw) when the file is missing", () => {
    expect(loadDotEnv(join(tmpdir(), "definitely-missing.env"))).toBe(false);
  });

  it("loads missing variables without overriding ones already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "KC_TEST_FROM_FILE=from-file\nKC_TEST_PRESET=from-file\n");
    process.env.KC_TEST_PRESET = "preset";
    expect(loadDotEnv(file)).toBe(true);
    expect(process.env.KC_TEST_FROM_FILE).toBe("from-file");
    expect(process.env.KC_TEST_PRESET).toBe("preset");
  });
});

describe("loadConfig", () => {
  function configDir(yaml?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    if (yaml !== undefined) writeFileSync(join(dir, "config.yaml"), yaml);
    return dir;
  }

  it("reads CONFIG_DIR/config.yaml and resolves paths against CONFIG_DIR and DATA_DIR", () => {
    const dir = configDir("server:\n  port: 9000\n");
    mkdirSync(join(dir, "glossaries"));
    writeFileSync(join(dir, "languages.yaml"), "languages: {}\n");
    const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: "/data" }, cwd: "/srv" });
    expect(loaded.config.server.port).toBe(9000);
    expect(loaded.paths.configFile).toBe(join(dir, "config.yaml"));
    expect(loaded.paths.glossariesDir).toBe(join(dir, "glossaries"));
    expect(loaded.paths.languagesFile).toBe(join(dir, "languages.yaml"));
    expect(loaded.paths.keysFile).toBe(join(dir, "keys.yaml"));
    expect(loaded.paths.transcriptsDir).toBe("/data/transcripts");
    expect(loaded.paths.recordingsDir).toBe("/data/recordings");
    expect(loaded.warnings).toEqual([]);
  });

  it("uses the app's own languages.yaml and glossaries/ when a new CONFIG_DIR has none", () => {
    const dir = configDir();
    const loaded = loadConfig({ env: { CONFIG_DIR: dir }, cwd: dir });
    expect(loaded.paths.languagesFile).toBe(join(process.cwd(), "languages.yaml"));
    expect(loaded.paths.glossariesDir).toBe(join(process.cwd(), "glossaries"));
    // A path set in config.yaml stays as given, also when it does not exist (doctor says so).
    const own = configDir("languagesFile: my-languages.yaml\n");
    expect(loadConfig({ env: { CONFIG_DIR: own }, cwd: own }).paths.languagesFile).toBe(
      join(own, "my-languages.yaml"),
    );
  });

  it("falls back to defaults with a warning when config.yaml is missing", () => {
    const dir = configDir();
    const loaded = loadConfig({ env: { CONFIG_DIR: dir }, cwd: dir });
    expect(loaded.paths.configFile).toBeNull();
    expect(loaded.config.server.port).toBe(8765);
    expect(loaded.warnings.join(" ")).toMatch(/config\.yaml/);
  });

  it("applies SERVER_HOST and reads secrets from the environment", () => {
    const dir = configDir("");
    const loaded = loadConfig({
      env: {
        CONFIG_DIR: dir,
        SERVER_HOST: "0.0.0.0",
        CAPTIONS_CONTAINER: "1",
        SONIOX_API_KEY: "snx-abc",
      },
      cwd: dir,
    });
    expect(loaded.config.server.host).toBe("0.0.0.0");
    expect(loaded.context.inContainer).toBe(true);
    expect(loaded.secrets).toEqual({ sonioxApiKey: "snx-abc" });
  });

  it("accepts only http(s) privacy and http(s)/mailto contact links for the website footer", () => {
    const ok = parseConfig(
      {
        hosted: {
          privacyUrl: "https://example.org/privacy",
          contactUrl: "mailto:info@example.org",
        },
      },
      { inContainer: false, bindAddress: null },
    );
    expect(ok.ok).toBe(true);
    for (const hosted of [
      { privacyUrl: "javascript:alert(1)" },
      { contactUrl: "javascript:alert(1)" },
      { privacyUrl: "mailto:x@example.org" },
    ]) {
      expect(parseConfig({ hosted }, { inContainer: false, bindAddress: null }).ok).toBe(false);
    }
  });

  it("needs a long admin token on a hosted server", () => {
    const short = parseConfig({ mode: "hosted", server: { token: "short-token" } }, native);
    expect(short.ok).toBe(false);
    expect(short.ok ? "" : short.errors.join(" ")).toMatch(/at least 24/);
    expect(parseConfig({ mode: "hosted", server: { token: "x".repeat(24) } }, native).ok).toBe(
      true,
    );
    expect(parseConfig({ mode: "hosted" }, native).ok).toBe(true);
    expect(parseConfig({ mode: "local", server: { token: "short" } }, native).ok).toBe(true);
  });

  it("reads the ports Docker publishes on this computer (links use them)", () => {
    const dir = configDir("");
    const loaded = loadConfig({
      env: { CONFIG_DIR: dir, CAPTIONS_HTTP_PORT: "8780", CAPTIONS_HTTPS_PORT: "nope" },
      cwd: dir,
    });
    expect(loaded.context.publishedPort).toBe(8780);
    expect(loaded.context.publishedHttpsPort).toBeNull();
  });

  it("throws a readable error listing every problem in an invalid config", () => {
    const dir = configDir("server:\n  port: 99999\n  exposure: public\n");
    expect(() => loadConfig({ env: { CONFIG_DIR: dir }, cwd: dir })).toThrow(
      /server\.port[\s\S]*server\.trustProxy/,
    );
  });

  it("reads CONFIG_DIR/.env (where turjuman setup saves the keys) before ./.env", () => {
    const cwd = configDir();
    const dir = configDir();
    writeFileSync(join(dir, ".env"), "SONIOX_API_KEY=from-config-dir\n");
    writeFileSync(join(cwd, ".env"), "SONIOX_API_KEY=from-cwd\nOTHER_KC_TEST=from-cwd\n");
    const saved = { ...process.env };
    try {
      delete process.env.SONIOX_API_KEY;
      process.env.CONFIG_DIR = dir;
      process.env.DATA_DIR = cwd;
      const loaded = loadConfig({ cwd });
      expect(loaded.secrets).toEqual({ sonioxApiKey: "from-config-dir" });
      expect(process.env.OTHER_KC_TEST).toBe("from-cwd");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("an empty variable (docker compose passes KEY= lines) does not block a key from a .env file", () => {
    const dir = configDir();
    writeFileSync(join(dir, ".env"), "SONIOX_API_KEY=from-make-keys\n");
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, SONIOX_API_KEY: "", TZ_KC_TEST: "" };
    loadEnvFiles(env, dir);
    expect(env.SONIOX_API_KEY).toBe("from-make-keys");
    expect(env.TZ_KC_TEST).toBe("");
    const set: NodeJS.ProcessEnv = { CONFIG_DIR: dir, SONIOX_API_KEY: "already-set" };
    loadEnvFiles(set, dir);
    expect(set.SONIOX_API_KEY).toBe("already-set");
  });

  it("requires an explicitly given config file to exist", () => {
    const dir = configDir();
    expect(() => loadConfig({ configFile: join(dir, "nope.yaml"), env: {}, cwd: dir })).toThrow(
      /nope\.yaml/,
    );
  });
});

describe("redactConfig", () => {
  it("removes the admin token and API keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(
      join(dir, "config.yaml"),
      "server:\n  exposure: lan\n  token: super-secret-token\n",
    );
    const loaded = loadConfig({
      env: { CONFIG_DIR: dir, SONIOX_API_KEY: "snx-secret-key" },
      cwd: dir,
    });
    const text = JSON.stringify(redactConfig(loaded));
    expect(text).not.toMatch(/super-secret-token|snx-secret-key/);
    expect(text).toMatch(/\[redacted\]/);
  });
});
