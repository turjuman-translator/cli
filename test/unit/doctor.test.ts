import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { KeyResolver } from "../../src/accounts/key-resolver.js";
import { MasterKey } from "../../src/accounts/keystore.js";
import { OrgStore } from "../../src/accounts/orgs.js";
import {
  type DoctorDeps,
  exitCodeFor,
  formatResults,
  hostedChecks,
  httpsCheck,
  runDoctor,
} from "../../src/cli/doctor.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";

const SONIOX_KEY = "snx_test_key_value_123";

/** A config dir with the shipped glossaries + languages copied in by path reference. */
function load(yaml: string, env: Record<string, string> = {}): LoadedConfig {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const repo = process.cwd();
  writeFileSync(
    join(dir, "config.yaml"),
    `${yaml}\nlanguagesFile: ${join(repo, "languages.yaml")}\nglossariesDir: ${join(repo, "glossaries")}\n`,
  );
  return loadConfig({
    env: {
      CONFIG_DIR: dir,
      DATA_DIR: dir,
      SONIOX_API_KEY: SONIOX_KEY,
      ...env,
    },
    cwd: dir,
  });
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "24.20.0",
    platform: "darwin",
    runFfmpeg: async (args) => ({
      code: 0,
      stdout: args.includes("-devices")
        ? "Devices:\n D. = Demuxing supported\n ---\n D  avfoundation    AVFoundation input device\n D  lavfi           Libavfilter virtual input device\n"
        : "Supported file protocols:\nInput:\n  file\n  tcp\n",
      stderr: "",
    }),
    portFree: async () => true,
    healthOk: async () => false,
    tlsReachable: async () => ({ ok: true, detail: "TLS ok" }),
    ...over,
  };
}

function byName(results: Awaited<ReturnType<typeof runDoctor>>, name: RegExp) {
  return results.filter((r) => name.test(r.name));
}

describe("doctor", () => {
  it("passes with a valid config, keys present and a reachable network", async () => {
    const results = await runDoctor(load(""), deps(), { online: false });
    expect(results.filter((r) => r.severity === "fail")).toEqual([]);
    expect(exitCodeFor(results)).toBe(0);
    expect(formatResults(results)).toMatch(/CONFIG_DIR/);
  });

  it("never prints key values", async () => {
    const text = formatResults(await runDoctor(load(""), deps(), { online: false }));
    expect(text).not.toContain(SONIOX_KEY);
  });

  it("fails when the key of the default engine is missing", async () => {
    const results = await runDoctor(load("", { SONIOX_API_KEY: "" }), deps(), { online: false });
    expect(byName(results, /Soniox API key/)[0]?.severity).toBe("fail");
    expect(exitCodeFor(results)).toBe(1);
  });

  it("checks only the Soniox key and host; an older config that asked for Gemini warns once per key", async () => {
    const loaded = load("stt:\n  provider: gemini\ntranslation:\n  engine: llm\n", {
      GEMINI_API_KEY: "",
    });
    const results = await runDoctor(loaded, deps(), { online: false });
    expect(results.filter((r) => /API key/.test(r.name)).map((r) => r.name)).toEqual([
      "Soniox API key",
    ]);
    expect(results.filter((r) => r.name.startsWith("TLS")).map((r) => r.name)).toEqual([
      "TLS stt-rt.soniox.com",
    ]);
    const warnings = byName(results, /^Config$/).filter((r) => r.severity === "warn");
    expect(warnings.map((r) => r.detail)).toEqual([
      'stt.provider is no longer used: Turjuman uses Soniox only (it asked for "gemini"; Soniox runs instead)',
      'translation.engine is no longer used: Turjuman uses Soniox only (it asked for "llm"; Soniox runs instead)',
    ]);
    expect(byName(results, /Caption layout/)[0]?.detail).toBe(
      "blocks (fast: Soniox streaming translation)",
    );
    expect(exitCodeFor(results)).toBe(0);
  });

  it("fails on a busy port unless our own service answers there", async () => {
    const busy = await runDoctor(load(""), deps({ portFree: async () => false }), {
      online: false,
    });
    expect(byName(busy, /Port/)[0]?.severity).toBe("fail");
    const ours = await runDoctor(
      load(""),
      deps({ portFree: async () => false, healthOk: async () => true }),
      { online: false },
    );
    expect(byName(ours, /Port/)[0]?.severity).toBe("ok");
  });

  it("reports an invalid config as a failure and still runs the other checks", async () => {
    const results = await runDoctor(
      new Error("Invalid config x:\n  - server.trustProxy: required for public exposure"),
      deps(),
      { online: false },
    );
    expect(byName(results, /Config/)[0]?.severity).toBe("fail");
    expect(byName(results, /Node/)[0]?.severity).toBe("ok");
    expect(exitCodeFor(results)).toBe(1);
  });

  it("treats a network (bridge) input as a warning, not a failure", async () => {
    const results = await runDoctor(load("audio:\n  input:\n    kind: network\n"), deps(), {
      online: false,
    });
    expect(byName(results, /bridge/i)[0]?.severity).toBe("warn");
    expect(exitCodeFor(results)).toBe(0);
  });

  it("only warns about a missing ffmpeg when device capture is off", async () => {
    const missing = deps({ runFfmpeg: async () => null });
    const off = await runDoctor(load(""), missing, { online: false });
    expect(byName(off, /ffmpeg/)[0]?.severity).toBe("warn");
    const device = await runDoctor(load("audio:\n  input:\n    kind: device\n"), missing, {
      online: false,
    });
    expect(byName(device, /ffmpeg/)[0]?.severity).toBe("fail");
  });

  it("lists only real input formats, not the legend lines of `ffmpeg -devices`", async () => {
    const results = await runDoctor(load(""), deps(), { online: false });
    expect(byName(results, /ffmpeg/)[0]?.detail).toBe("found; input formats: avfoundation, lavfi");
  });

  it("fails when ffmpeg lacks the input format this platform needs", async () => {
    const results = await runDoctor(
      load("audio:\n  input:\n    kind: device\n"),
      deps({ platform: "win32" }),
      { online: false },
    );
    expect(
      byName(results, /ffmpeg/).some((r) => r.severity === "fail" && /dshow/.test(r.detail)),
    ).toBe(true);
  });

  it("warns that caption pages on other machines need HTTPS in lan mode", async () => {
    const results = await runDoctor(
      load("server:\n  host: 0.0.0.0\n  exposure: lan\n  token: a-long-admin-token\n"),
      deps(),
      { online: false },
    );
    expect(byName(results, /Exposure/)[0]?.severity).toBe("warn");
    expect(byName(results, /Exposure/)[0]?.detail).toMatch(/server\.https\.port/);
    expect(byName(results, /^HTTPS$/)).toEqual([]);
  });

  it("describes the published port instead of probing it inside the container", async () => {
    const loaded = load("", { CAPTIONS_HTTP_PORT: "8860" });
    const results = await runDoctor(
      loaded,
      deps({ container: true, portFree: async () => false }),
      {
        online: false,
      },
    );
    expect(byName(results, /Port/)[0]).toMatchObject({ severity: "ok" });
    expect(byName(results, /Port/)[0]?.detail).toMatch(/^8860 on this computer/);
  });

  it("--online checks the key added in the app when .env has none", async () => {
    const loaded = load("", { SONIOX_API_KEY: "" });
    const master = new MasterKey(loaded.paths.masterKeyFile, "");
    new KeyResolver({
      mode: "local",
      env: { sonioxApiKey: null },
      orgs: new OrgStore(loaded.paths.orgsFile),
      master,
      log: pino({ level: "silent" }),
    }).store("local", "soniox", "soniox-added-in-the-app-0123", { validated: true, by: null });
    const seen: string[] = [];
    const results = await runDoctor(
      loaded,
      deps({
        masterKey: master,
        online: {
          soniox: async (key) => {
            seen.push(key);
            return { ok: true, detail: "accepted" };
          },
        },
      }),
      { online: true },
    );
    expect(seen).toEqual(["soniox-added-in-the-app-0123"]);
    expect(byName(results, /Soniox key \(online\)/)[0]?.severity).toBe("ok");
    expect(formatResults(results)).not.toContain("soniox-added-in-the-app-0123");
  });

  it("fails when an engine host is unreachable", async () => {
    const results = await runDoctor(
      load(""),
      deps({ tlsReachable: async (host) => ({ ok: !host.includes("soniox"), detail: "timeout" }) }),
      { online: false },
    );
    expect(byName(results, /stt-rt\.soniox\.com/)[0]?.severity).toBe("fail");
  });

  it("shows the Soniox context token estimate for the default pair", async () => {
    const results = await runDoctor(load(""), deps(), { online: false });
    const ctx = byName(results, /Glossary/)[0];
    expect(ctx?.severity).toBe("ok");
    expect(ctx?.detail).toMatch(/ar-nl.*tokens/);
  });
});

/** openssl on PATH (the HTTPS certificate tests make their certificates with it, like lan-cert.sh). */
const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A self-signed certificate + key (P-256) naming `ips`, valid `days` days, written to `dir`. */
function makeCert(dir: string, ips: string[], days = 400): { cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, "server.crt");
  const key = join(dir, "server.key");
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", key, "-out", cert, "-days", String(days), "-subj", "/CN=test"],
      ...["-addext", `subjectAltName=${ips.map((ip) => `IP:${ip}`).join(",")}`],
    ],
    { stdio: "ignore" },
  );
  return { cert, key };
}

describe.skipIf(!hasOpenssl)("doctor: HTTPS on the LAN", () => {
  const LAN = "192.168.1.50";
  const lanConfig =
    "server:\n  host: 0.0.0.0\n  exposure: lan\n  token: a-long-admin-token\n  https:\n    port: 8443\n";
  const opts = { lan: LAN, container: false, now: Date.now() };

  /** A lan config with HTTPS, its certificate pair copied to where the config expects it. */
  function withCert(pair: { cert: string; key: string } | null): LoadedConfig {
    const loaded = load(lanConfig);
    if (pair !== null) {
      mkdirSync(dirname(loaded.paths.tlsCertFile), { recursive: true });
      copyFileSync(pair.cert, loaded.paths.tlsCertFile);
      copyFileSync(pair.key, loaded.paths.tlsKeyFile);
    }
    return loaded;
  }

  it("is ok with a matching certificate for this computer's address; exposure lan is then ok", async () => {
    const loaded = withCert(makeCert(mkdtempSync(join(tmpdir(), "cert-")), [LAN, "127.0.0.1"]));
    const results = await runDoctor(loaded, deps({ lan: LAN, container: false }), {
      online: false,
    });
    expect(byName(results, /Exposure/)[0]?.severity).toBe("ok");
    const https = byName(results, /^HTTPS$/)[0];
    expect(https?.severity).toBe("ok");
    expect(https?.detail).toMatch(
      /^port 8443, certificate for 192\.168\.1\.50, valid until \d{4}-/,
    );
  });

  it("fails when the certificate files are missing, with the command for this layout", () => {
    const loaded = withCert(null);
    const native = httpsCheck(loaded, opts);
    expect(native?.severity).toBe("fail");
    expect(native?.detail).toMatch(/missing; run bash scripts\/lan-cert\.sh /);
    expect(httpsCheck(loaded, { ...opts, container: true })?.detail).toMatch(/run make lan-cert$/);
  });

  it("fails on a key that does not belong to the certificate", () => {
    const a = makeCert(mkdtempSync(join(tmpdir(), "cert-")), [LAN]);
    const b = makeCert(mkdtempSync(join(tmpdir(), "cert-")), [LAN]);
    const loaded = withCert({ cert: a.cert, key: b.key });
    expect(httpsCheck(loaded, opts)).toMatchObject({ severity: "fail" });
    expect(httpsCheck(loaded, opts)?.detail).toMatch(/does not belong to the certificate/);
  });

  it("warns when the certificate does not name this computer's address (not in the container)", () => {
    const loaded = withCert(makeCert(mkdtempSync(join(tmpdir(), "cert-")), ["10.0.0.9"]));
    expect(httpsCheck(loaded, opts)).toMatchObject({ severity: "warn" });
    expect(httpsCheck(loaded, opts)?.detail).toMatch(/does not name this computer's address/);
    // Inside the container the address is the container's own: not checked.
    expect(httpsCheck(loaded, { ...opts, container: true })?.severity).toBe("ok");
  });

  it("fails after the certificate expired and warns in its last 30 days", () => {
    const loaded = withCert(makeCert(mkdtempSync(join(tmpdir(), "cert-")), [LAN], 40));
    const day = 86_400_000;
    expect(httpsCheck(loaded, { ...opts, now: Date.now() + 41 * day })?.detail).toMatch(
      /expired on/,
    );
    expect(httpsCheck(loaded, { ...opts, now: Date.now() + 20 * day })).toMatchObject({
      severity: "warn",
    });
    expect(httpsCheck(loaded, opts)?.severity).toBe("ok");
  });
});

describe("doctor in hosted mode", () => {
  it("checks the master key instead of .env keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-hosted-"));
    try {
      writeFileSync(join(dir, "config.yaml"), "mode: hosted\n");
      const loaded = loadConfig({
        env: { CONFIG_DIR: dir, DATA_DIR: dir, SONIOX_API_KEY: "env-key-0123456789" },
        cwd: dir,
      });
      const file = join(dir, "master.key");
      let results = hostedChecks(loaded, new MasterKey(file, ""));
      const byName = (name: string) => results.find((r) => r.name === name);
      expect(byName("Master key")?.severity).toBe("ok");
      expect(byName("API keys in .env")?.severity).toBe("warn");
      expect(byName("Hosted")?.severity).toBe("warn");
      // An open file mode is a warning; a hosted server on the LAN (no HTTPS) fails.
      writeFileSync(file, `${Buffer.alloc(32, 9).toString("base64")}\n`, { mode: 0o644 });
      results = hostedChecks(loaded, new MasterKey(file, ""));
      if (process.platform !== "win32") {
        expect(byName("Master key")).toMatchObject({ severity: "warn" });
      }
      writeFileSync(join(dir, "config.yaml"), "mode: hosted\nserver:\n  exposure: lan\n");
      const lan = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
      results = hostedChecks(lan, new MasterKey(file, ""));
      expect(byName("Hosted")?.severity).toBe("fail");
      writeFileSync(file, "not a key\n");
      results = hostedChecks(loaded, new MasterKey(file, ""));
      expect(byName("Master key")?.severity).toBe("fail");
      results = hostedChecks(loaded, new MasterKey(file, Buffer.alloc(32, 7).toString("base64")));
      expect(byName("Master key")).toMatchObject({ severity: "ok", detail: "TURJUMAN_MASTER_KEY" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
