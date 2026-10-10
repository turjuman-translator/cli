import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/accounts/keystore.js";
import {
  type CheckResult,
  type DoctorDeps,
  formatResults,
  hostedChecks,
  httpsCheck,
  runDoctor,
} from "../../src/cli/doctor.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";
import { configured, removeTempDirs, tempDir } from "./helpers/cli-env.js";
import { hasOpenssl, makeCert } from "./helpers/cli-tls.js";

beforeEach(() => {
  vi.stubEnv("CAPTIONS_CONTAINER", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDirs();
});

const KEY = "fake-soniox-key-for-doctor";

/** `ffmpeg -devices` with these demuxers. */
function devices(...formats: string[]): string {
  return `Devices:\n D. = Demuxing supported\n ---\n${formats.map((f) => ` D  ${f}    an input\n`).join("")}`;
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "24.20.0",
    platform: "linux",
    runFfmpeg: async (args) => ({
      code: 0,
      stdout: args.includes("-devices") ? devices("pulse", "alsa") : "Input:\n  file\n  tcp\n",
      stderr: "",
    }),
    portFree: async () => true,
    healthOk: async () => false,
    tlsReachable: async () => ({ ok: true, detail: "TLS ok" }),
    lan: null,
    container: false,
    ...over,
  };
}

async function check(loaded: LoadedConfig | Error, over: Partial<DoctorDeps> = {}, online = false) {
  return runDoctor(loaded, deps(over), { online });
}

function named(results: CheckResult[], name: string | RegExp): CheckResult[] {
  return results.filter((r) => (typeof name === "string" ? r.name === name : name.test(r.name)));
}

/** A config with the Soniox key set (the usual case). */
function withKey(yaml = ""): { dir: string; loaded: LoadedConfig } {
  return configured(yaml, { SONIOX_API_KEY: KEY });
}

describe("doctor: ffmpeg", () => {
  it("needs the input format of this platform for a device", async () => {
    const cases: Array<[NodeJS.Platform, string, string]> = [
      ["darwin", "Mic", "avfoundation"],
      ["linux", "hw:1,0", "alsa"],
      ["linux", "alsa_input.usb", "pulse"],
      ["win32", "Line", "dshow"],
    ];
    for (const [platform, device, format] of cases) {
      const { loaded } = withKey(`audio:\n  input:\n    kind: device\n    device: '${device}'\n`);
      const missing = named(
        await check(loaded, {
          platform,
          runFfmpeg: async () => ({ code: 0, stdout: devices("lavfi"), stderr: "" }),
        }),
        "ffmpeg",
      )[0];
      expect(missing).toEqual({
        name: "ffmpeg",
        severity: "fail",
        detail: `input format "${format}" missing (has: lavfi)`,
      });
      const found = named(
        await check(loaded, {
          platform,
          runFfmpeg: async () => ({ code: 0, stdout: devices(format), stderr: "" }),
        }),
        "ffmpeg",
      )[0];
      expect(found?.severity).toBe("ok");
    }
  });

  it("needs the tcp protocol for the audio bridge", async () => {
    const { loaded } = withKey("audio:\n  input:\n    kind: network\n");
    for (const protocols of [null, { code: 0, stdout: "Input:\n  file\n", stderr: "" }]) {
      const results = await check(loaded, {
        runFfmpeg: async (args) =>
          args.includes("-devices") ? { code: 0, stdout: devices(), stderr: "" } : protocols,
      });
      expect(named(results, "ffmpeg")[0]).toEqual({
        name: "ffmpeg",
        severity: "fail",
        detail: 'protocol "tcp" missing (needed for the audio bridge)',
      });
    }
    const ok = await check(loaded);
    expect(named(ok, "ffmpeg")[0]?.detail).toBe("found; input formats: pulse, alsa");
  });

  it("says when ffmpeg lists no input formats", async () => {
    const { loaded } = withKey();
    const results = await check(loaded, {
      runFfmpeg: async () => ({ code: 0, stdout: "Devices:\n", stderr: "" }),
    });
    expect(named(results, "ffmpeg")[0]?.detail).toBe("found; input formats: none");
  });
});

describe("doctor: languages and glossaries", () => {
  it("fails on a missing, empty or unreadable languages file", async () => {
    const dir = tempDir();
    const cases: Array<[string | null, RegExp]> = [
      [null, /languages\.yaml not found$/],
      ["languages: {}\n", /has no languages$/],
      ["", /has no languages$/],
      ["languages: [unclosed\n", /./],
    ];
    for (const [text, detail] of cases) {
      const file = join(dir, "languages.yaml");
      if (text === null) {
        const { loaded } = withKey(`languagesFile: ${file}\n`);
        const result = named(await check(loaded), "Languages")[0];
        expect(result?.severity).toBe("fail");
        expect(result?.detail).toMatch(detail);
        continue;
      }
      writeFileSync(file, text);
      const { loaded } = withKey(`languagesFile: ${file}\n`);
      const result = named(await check(loaded), "Languages")[0];
      expect(result?.severity).toBe("fail");
      expect(result?.detail).toMatch(detail);
    }
  });

  it("reports glossary files it cannot read, too many terms, and pairs without a glossary", async () => {
    const glossaries = tempDir();
    writeFileSync(join(glossaries, "broken.yaml"), "terms: 7\n");
    const terms = Array.from({ length: 41 }, (_, i) => `  - { source: "w${i}", target: "t${i}" }`);
    writeFileSync(join(glossaries, "ar-nl.yaml"), `translation_terms:\n${terms.join("\n")}\n`);
    writeFileSync(join(glossaries, "notes.txt"), "not a glossary");
    const { loaded } = withKey(
      `glossariesDir: ${glossaries}\npages:\n  defaultFrom: ar\n  defaultTo: en\n`,
    );
    const results = named(await check(loaded), "Glossary");
    expect(results.find((r) => r.severity === "fail")?.detail).toMatch(
      /^Invalid glossary broken\.yaml/,
    );
    expect(results.find((r) => /41 translation_terms/.test(r.detail))?.severity).toBe("warn");
    expect(results.find((r) => r.detail.startsWith("ar-nl: Soniox context"))?.severity).toBe("ok");
    expect(results.find((r) => r.detail.startsWith("ar-en"))).toEqual({
      name: "Glossary",
      severity: "warn",
      detail: "ar-en: no glossary (Soniox runs without context)",
    });
  });

  it("warns when a glossary is longer than Soniox's context budget", async () => {
    const glossaries = tempDir();
    writeFileSync(join(glossaries, "ar-nl.yaml"), `context:\n  text: "${"و".repeat(7500)}"\n`);
    const { loaded } = withKey(`glossariesDir: ${glossaries}\n`);
    const result = named(await check(loaded), "Glossary")[0];
    expect(result?.severity).toBe("warn");
    expect(result?.detail).toMatch(/budget 7000; will be truncated\)$/);
  });

  it("uses auto as the source when there is no language hint", async () => {
    const glossaries = tempDir();
    const { loaded } = withKey(
      `glossariesDir: ${glossaries}\nstt:\n  soniox:\n    languageHints: []\n`,
    );
    const details = named(await check(loaded), "Glossary").map((r) => r.detail);
    expect(details).toContain("auto-nl: no glossary (Soniox runs without context)");
  });
});

describe("doctor: Quran data", () => {
  function quran(dir: string, files: string[]): void {
    mkdirSync(join(dir, "quran"), { recursive: true });
    for (const f of files) writeFileSync(join(dir, "quran", f), "1|1|x\n");
  }

  it("is ok when disabled, and warns about missing text or translations", async () => {
    const off = withKey("quran:\n  enabled: false\n");
    expect(named(await check(off.loaded), "Quran data")).toEqual([
      { name: "Quran data", severity: "ok", detail: "disabled" },
    ]);

    const missing = withKey();
    const result = named(await check(missing.loaded), "Quran data")[0];
    expect(result?.severity).toBe("warn");
    expect(result?.detail).toMatch(
      /^missing .*quran-simple-clean\.txt, .*quran-uthmani\.txt: the server downloads it when it starts \(by hand: pnpm exec tsx scripts\/quran-data\.ts\); Quran references are off until then$/,
    );

    const partial = withKey(
      "quran:\n  translations:\n    nl: quran/nl.siregar.txt\n    en: quran/en.txt\n",
    );
    quran(partial.dir, ["quran-simple-clean.txt", "quran-uthmani.txt", "nl.siregar.txt"]);
    const results = await check(partial.loaded);
    expect(named(results, "Quran data")[0]).toEqual({
      name: "Quran data",
      severity: "ok",
      detail: partial.loaded.paths.quranTextFile,
    });
    expect(named(results, "Quran translation (nl)")[0]?.severity).toBe("ok");
    expect(named(results, "Quran translation (en)")[0]).toEqual({
      name: "Quran translation (en)",
      severity: "warn",
      detail: `${join(partial.dir, "quran", "en.txt")} missing: recited verses show Soniox's live translation`,
    });
  });
});

describe("doctor: exposure, HTTPS and mode", () => {
  it("describes each exposure", async () => {
    const cases: Array<[string, CheckResult]> = [
      [
        "server:\n  exposure: public\n  trustProxy: true\n",
        {
          name: "Exposure",
          severity: "ok",
          detail: "public (behind an HTTPS proxy, trustProxy on)",
        },
      ],
      [
        "server:\n  https:\n    port: 8443\n",
        {
          name: "Exposure",
          severity: "warn",
          detail:
            "local: HTTPS (port 8443) answers on this computer only; other devices need exposure: lan",
        },
      ],
      ["", { name: "Exposure", severity: "ok", detail: "local (this machine only)" }],
    ];
    for (const [yaml, expected] of cases) {
      expect(named(await check(withKey(yaml).loaded), "Exposure")[0]).toEqual(expected);
    }
  });

  it("checks the hosted server's own needs instead of a Soniox key", async () => {
    const { loaded } = withKey("mode: hosted\n");
    const results = await check(loaded, {
      masterKey: new MasterKey(loaded.paths.masterKeyFile, ""),
    });
    expect(named(results, "Mode")[0]?.detail).toBe(
      "hosted (sign-up open; each mosque adds its own API keys)",
    );
    expect(named(results, "API keys in .env")[0]?.severity).toBe("warn");
    expect(named(results, "Soniox API key")).toEqual([]);
    // The master key of the config folder by default.
    const plain = await check(loaded);
    expect(named(plain, "Master key")[0]?.detail).toMatch(/created with the first stored key/);
  });

  it("does not ask Soniox online on a hosted server, or without any key", async () => {
    const soniox = vi.fn(async () => ({ ok: true, detail: "accepted" }));
    await check(withKey("mode: hosted\n").loaded, { online: { soniox } }, true);
    await check(configured().loaded, { online: { soniox } }, true);
    await check(new Error("bad config"), { online: { soniox } }, true);
    expect(soniox).not.toHaveBeenCalled();
    const results = await check(
      withKey("stt:\n  soniox:\n    region: eu\n").loaded,
      {
        online: { soniox: async (_key, region) => ({ ok: false, detail: `refused in ${region}` }) },
      },
      true,
    );
    expect(named(results, "Soniox key (online)")[0]).toEqual({
      name: "Soniox key (online)",
      severity: "fail",
      detail: "refused in eu",
    });
    expect(named(results, /^TLS /)[0]?.name).toBe("TLS stt-rt.eu.soniox.com");
  });

  it("leaves out the line about a missing config.yaml (the Config line says it)", async () => {
    const dir = tempDir();
    const loaded = loadConfig({
      env: { CONFIG_DIR: dir, DATA_DIR: dir, SONIOX_API_KEY: KEY },
      cwd: dir,
    });
    expect(loaded.warnings[0]).toMatch(/^No config\.yaml/);
    const config = named(await check(loaded), "Config");
    expect(config).toEqual([
      { name: "Config", severity: "ok", detail: "defaults (no config.yaml)" },
    ]);
  });

  it("falls back to the defaults for the other checks when the config cannot be loaded", async () => {
    const results = await check(new Error("Invalid config: nope"));
    expect(named(results, "Config")[0]).toEqual({
      name: "Config",
      severity: "fail",
      detail: "Invalid config: nope",
    });
    expect(named(results, "Port")[0]?.detail).toBe("127.0.0.1:8765 is free");
    expect(formatResults(results)).toMatch(/1 failures$/);
  });

  it("fails on a certificate file that is no certificate", () => {
    const { dir, loaded } = withKey("server:\n  https:\n    port: 8443\n");
    mkdirSync(join(dir, "tls"));
    writeFileSync(loaded.paths.tlsCertFile, "garbage");
    writeFileSync(loaded.paths.tlsKeyFile, "garbage");
    const result = httpsCheck(loaded, { lan: null, container: false, now: Date.now() });
    expect(result?.severity).toBe("fail");
    expect(result?.detail).toMatch(
      /server\.crt is not a certificate; run bash scripts\/lan-cert\.sh /,
    );
  });

  it.skipIf(!hasOpenssl)("fails on a key file that is no private key", () => {
    const { dir, loaded } = withKey("server:\n  https:\n    port: 8443\n");
    makeCert(join(dir, "tls"), ["127.0.0.1"]);
    writeFileSync(loaded.paths.tlsKeyFile, "garbage");
    const result = httpsCheck(loaded, { lan: null, container: false, now: Date.now() });
    expect(result?.severity).toBe("fail");
    expect(result?.detail).toMatch(/server\.key is not a private key; run /);
  });

  it.skipIf(!hasOpenssl)(
    "runDoctor reports the HTTPS check with the computer's address",
    async () => {
      const { dir, loaded } = withKey(
        "server:\n  host: 0.0.0.0\n  exposure: lan\n  token: a-long-admin-token\n  https:\n    port: 8443\n",
      );
      makeCert(join(dir, "tls"), ["192.168.1.50"]);
      const results = await check(loaded, { lan: "192.168.1.50" });
      expect(named(results, "HTTPS")[0]?.detail).toMatch(
        /^port 8443, certificate for 192\.168\.1\.50, valid until/,
      );
      expect(named(results, "Exposure")[0]?.detail).toBe(
        "lan, with HTTPS on port 8443 for microphones on other devices",
      );
    },
  );
});

describe("doctor: the smaller cases", () => {
  it("fails on a Node.js older than 24", async () => {
    const results = await check(withKey().loaded, { nodeVersion: "22.11.0" });
    expect(named(results, "Node.js")[0]).toEqual({
      name: "Node.js",
      severity: "fail",
      detail: "v22.11.0 (need >= 24)",
    });
  });

  it("names the rollup layout, and copes with a glossaries folder that does not exist", async () => {
    const missing = join(tempDir(), "no-glossaries");
    const { loaded } = withKey(`display:\n  layout: rollup\nglossariesDir: ${missing}\n`);
    const results = await check(loaded);
    expect(named(results, "Caption layout")[0]?.detail).toBe("rollup");
    expect(named(results, "Glossary").map((r) => r.severity)).toEqual(["warn"]);
  });

  it("has nothing to add for a public hosted server with an admin token", async () => {
    const { loaded } = configured(
      `mode: hosted\nserver:\n  exposure: public\n  trustProxy: true\n  token: ${"t".repeat(24)}\n`,
    );
    const results = await check(loaded, {
      masterKey: new MasterKey(loaded.paths.masterKeyFile, ""),
    });
    expect(named(results, "Hosted")).toEqual([]);
    expect(named(results, "Admin token")).toEqual([]);
    expect(named(results, "API keys in .env")).toEqual([]);
  });

  it("says where a hosted server's generated admin token is, and when it has none", () => {
    const generated = configured("mode: hosted\nserver:\n  exposure: public\n  trustProxy: true\n");
    const master = new MasterKey(generated.loaded.paths.masterKeyFile, "");
    expect(named(hostedChecks(generated.loaded, master), "Admin token")).toEqual([
      {
        name: "Admin token",
        severity: "ok",
        detail: `generated, in ${join(generated.dir, "admin.token")}`,
      },
    ]);
    const broken = tempDir();
    writeFileSync(join(broken, "admin.token"), "not a token");
    writeFileSync(
      join(broken, "config.yaml"),
      "mode: hosted\nserver:\n  exposure: public\n  trustProxy: true\n",
    );
    const none = loadConfig({ env: { CONFIG_DIR: broken, DATA_DIR: broken }, cwd: broken });
    expect(none.config.server.token).toBe("");
    expect(named(hostedChecks(none, master), "Admin token")).toEqual([
      {
        name: "Admin token",
        severity: "warn",
        detail:
          "none (the config folder is not writable?): the operator's pages (/control, /api/sessions) stay closed",
      },
    ]);
  });

  it("names a master key that cannot be read at all", () => {
    const { loaded } = configured("mode: hosted\n");
    mkdirSync(loaded.paths.masterKeyFile); // a folder where the key file should be
    const result = named(
      hostedChecks(loaded, new MasterKey(loaded.paths.masterKeyFile, "")),
      "Master key",
    )[0];
    expect(result?.severity).toBe("fail");
    expect(result?.detail).toMatch(/EISDIR/);
  });

  it("says which one of the certificate pair is missing", () => {
    const { dir, loaded } = withKey("server:\n  https:\n    port: 8443\n");
    mkdirSync(join(dir, "tls"));
    writeFileSync(loaded.paths.tlsCertFile, "x");
    const result = httpsCheck(loaded, { lan: null, container: false, now: Date.now() });
    expect(result?.detail).toMatch(/^port 8443, but .*server\.key is missing; run /);
  });
});

describe("doctor: what it looks up itself", () => {
  it("looks up the LAN address and the time when they are not given", async () => {
    const { loaded } = withKey("server:\n  https:\n    port: 8443\n");
    const results = await runDoctor(
      loaded,
      { ...deps(), lan: undefined, now: undefined, container: undefined },
      { online: false },
    );
    expect(named(results, "HTTPS")[0]?.detail).toMatch(
      /are missing; run bash scripts\/lan-cert\.sh /,
    );
  });

  it("names the make targets inside the container", async () => {
    vi.stubEnv("CAPTIONS_CONTAINER", "1");
    const { loaded } = configured("server:\n  https:\n    port: 8443\n");
    const results = await runDoctor(loaded, { ...deps(), container: undefined }, { online: false });
    expect(named(results, "HTTPS")[0]?.detail).toMatch(/; run make lan-cert$/);
    expect(named(results, "Soniox API key")[0]?.detail).toMatch(
      /run make keys, or add it in the app/,
    );
    expect(named(results, "Port")[0]?.detail).toMatch(/^8765 on this computer/);
  });
});
