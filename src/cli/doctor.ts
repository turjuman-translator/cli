import { spawn } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { connect } from "node:tls";
import { parse } from "yaml";
import { storedLocalKeys, storedLocalKeyValues } from "../accounts/key-resolver.js";
import { KeyStoreError, MasterKey } from "../accounts/keystore.js";
import { type Config, defaultConfig, type LoadedConfig } from "../config.js";
import { buildSonioxContext, loadGlossary, parseGlossary } from "../glossary.js";
import { inContainer, lanCertCmd, quranDataCmd, turjumanCmd } from "./hint.js";
import { lanAddress } from "./urls.js";

export type Severity = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  severity: Severity;
  detail: string;
}

export interface FfmpegRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface OnlineChecks {
  soniox(
    key: string,
    region: "default" | "eu",
    model: string,
  ): Promise<{ ok: boolean; detail: string }>;
}

/** Everything doctor touches outside its own logic, injected so the checks are testable. */
export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Run ffmpeg with args; null when the binary is not found. */
  runFfmpeg(args: string[]): Promise<FfmpegRun | null>;
  portFree(host: string, port: number): Promise<boolean>;
  /** Whether a Turjuman server already answers /health on host:port. */
  healthOk(host: string, port: number): Promise<boolean>;
  /** TLS handshake only: it never opens an STT session, so nothing is billed. */
  tlsReachable(host: string): Promise<{ ok: boolean; detail: string }>;
  online?: OnlineChecks;
  /** Hosted mode: the master key to check (default: TURJUMAN_MASTER_KEY or master.key). */
  masterKey?: MasterKey;
  /** This computer's LAN address, for the HTTPS certificate check (default: looked up). */
  lan?: string | null;
  /** Running in the Docker image (default: CAPTIONS_CONTAINER=1). */
  container?: boolean;
  now?: () => number;
}

const SONIOX_CONTEXT_BUDGET = 7000;

export function sonioxHost(region: "default" | "eu"): string {
  return region === "eu" ? "stt-rt.eu.soniox.com" : "stt-rt.soniox.com";
}

/** The Soniox key (local mode): .env, or stored in the app. Soniox is the speech engine. */
function sonioxKeyCheck(value: string | null, storedInApp: boolean): CheckResult {
  const name = "Soniox API key";
  if (value !== null) return { name, severity: "ok", detail: "set" };
  if (storedInApp) return { name, severity: "ok", detail: "set in the app (stored encrypted)" };
  return {
    name,
    severity: "fail",
    detail: `not set (required: Soniox is the speech engine); run ${turjumanCmd("setup")}, or add it in the app under Keys`,
  };
}

/** The ffmpeg input format a device capture needs on this platform. */
function deviceFormat(platform: NodeJS.Platform, device: string): string {
  if (platform === "win32") return "dshow";
  if (platform === "darwin") return "avfoundation";
  return device.startsWith("hw:") ? "alsa" : "pulse";
}

async function ffmpegCheck(config: Config, deps: DoctorDeps): Promise<CheckResult> {
  const kind = config.audio.input.kind;
  const needed = kind !== "none";
  const devices = await deps.runFfmpeg(["-hide_banner", "-devices"]);
  if (devices === null) {
    return {
      name: "ffmpeg",
      severity: needed ? "fail" : "warn",
      detail: `"${config.audio.ffmpegPath}" not found${needed ? "" : " (needed for file replay and record)"}`,
    };
  }
  // Device rows follow the " ---" separator; the legend above it (" D. = Demuxing supported") is skipped.
  const rows = devices.stdout.split(/^\s*---\s*$/m)[1] ?? "";
  const formats = [...rows.matchAll(/^\s*DE?\s+([\w-]+)/gm)].map((m) => m[1] ?? "");
  if (kind === "device") {
    const format = deviceFormat(deps.platform, config.audio.input.device);
    if (!formats.includes(format)) {
      return {
        name: "ffmpeg",
        severity: "fail",
        detail: `input format "${format}" missing (has: ${formats.join(", ")})`,
      };
    }
  }
  if (kind === "network") {
    const protocols = await deps.runFfmpeg(["-hide_banner", "-protocols"]);
    if (protocols === null || !/^\s*tcp\s*$/m.test(protocols.stdout)) {
      return {
        name: "ffmpeg",
        severity: "fail",
        detail: 'protocol "tcp" missing (needed for the audio bridge)',
      };
    }
  }
  return {
    name: "ffmpeg",
    severity: "ok",
    detail: `found; input formats: ${formats.join(", ") || "none"}`,
  };
}

function languagesCheck(file: string): CheckResult {
  if (!existsSync(file))
    return { name: "Languages", severity: "fail", detail: `${file} not found` };
  try {
    const doc = parse(readFileSync(file, "utf8")) as { languages?: Record<string, unknown> } | null;
    const count = Object.keys(doc?.languages ?? {}).length;
    if (count === 0)
      return { name: "Languages", severity: "fail", detail: `${file} has no languages` };
    return { name: "Languages", severity: "ok", detail: `${count} languages (${file})` };
  } catch (err) {
    return { name: "Languages", severity: "fail", detail: (err as Error).message };
  }
}

function glossaryChecks(loaded: LoadedConfig): CheckResult[] {
  const { config, paths } = loaded;
  const results: CheckResult[] = [];
  const dir = paths.glossariesDir;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
      try {
        const { warnings } = parseGlossary(parse(readFileSync(join(dir, f), "utf8")), f);
        for (const w of warnings) results.push({ name: "Glossary", severity: "warn", detail: w });
      } catch (err) {
        results.push({ name: "Glossary", severity: "fail", detail: (err as Error).message });
      }
    }
  }
  const pairs = new Set([
    `${config.stt.soniox.languageHints[0] ?? "auto"}-${config.translation.targetLanguage}`,
    `${config.pages.defaultFrom}-${config.pages.defaultTo}`,
  ]);
  for (const pair of pairs) {
    const [from = "auto", to = "nl"] = pair.split("-");
    const g = loadGlossary(dir, from, to);
    if (g === null) {
      results.push({
        name: "Glossary",
        severity: "warn",
        detail: `${pair}: no glossary (Soniox runs without context)`,
      });
      continue;
    }
    const { estimatedTokens } = buildSonioxContext(
      g.glossary,
      { nativeTranslation: true },
      Number.MAX_SAFE_INTEGER,
    );
    const over = estimatedTokens > SONIOX_CONTEXT_BUDGET;
    results.push({
      name: "Glossary",
      severity: over ? "warn" : "ok",
      detail: `${pair}: Soniox context ≈ ${estimatedTokens} est. tokens (budget ${SONIOX_CONTEXT_BUDGET}${over ? "; will be truncated" : ""})`,
    });
  }
  return results;
}

/** The caption layout (blocks come from Soniox's streaming translation). */
function layoutCheck(config: Config): CheckResult {
  return {
    name: "Caption layout",
    severity: "ok",
    detail:
      config.display.layout === "blocks" ? "blocks (fast: Soniox streaming translation)" : "rollup",
  };
}

/**
 * Hosted mode: each mosque brings its own keys (the .env keys are not used for
 * them), the master key that encrypts those keys must be readable, and the operator needs HTTPS
 * and an admin token.
 */
export function hostedChecks(loaded: LoadedConfig, master: MasterKey): CheckResult[] {
  const { config, secrets } = loaded;
  const results: CheckResult[] = [
    {
      name: "Mode",
      severity: "ok",
      detail: `hosted (sign-up ${config.hosted.signup}; each mosque adds its own API keys)`,
    },
  ];
  if (config.server.exposure !== "public") {
    // On the LAN, passwords and API keys would cross the network in clear text.
    results.push({
      name: "Hosted",
      severity: config.server.exposure === "lan" ? "fail" : "warn",
      detail: `exposure ${config.server.exposure}: mosques need HTTPS to log in and use microphones; use exposure public behind an HTTPS proxy`,
    });
  }
  if (config.server.token === "") {
    results.push({
      name: "Admin token",
      severity: "warn",
      detail:
        "none (the config folder is not writable?): the operator's pages (/control, /api/sessions) stay closed",
    });
  } else if (loaded.tokenFile) {
    results.push({
      name: "Admin token",
      severity: "ok",
      detail: `generated, in ${loaded.tokenFile}`,
    });
  }
  if (secrets.sonioxApiKey !== null) {
    results.push({
      name: "API keys in .env",
      severity: "warn",
      detail: "not used in hosted mode: every mosque adds its own keys in the app",
    });
  }
  if (!master.exists()) {
    results.push({
      name: "Master key",
      severity: "ok",
      detail: `created with the first stored key (${master.file}); back it up apart from orgs.yaml`,
    });
    return results;
  }
  try {
    master.key();
    const open = master.source === "file" && (statSync(master.file).mode & 0o077) !== 0;
    results.push({
      name: "Master key",
      severity: open ? "warn" : "ok",
      detail:
        master.source === "env"
          ? "TURJUMAN_MASTER_KEY"
          : open
            ? `${master.file} can be read by other users of this computer: chmod 600 ${master.file}`
            : master.file,
    });
  } catch (err) {
    results.push({
      name: "Master key",
      severity: "fail",
      detail: err instanceof KeyStoreError ? err.message : String(err),
    });
  }
  return results;
}

/** Verified Quran references need the Tanzil text under DATA_DIR. */
function quranCheck(loaded: LoadedConfig): CheckResult[] {
  const { config, paths } = loaded;
  if (!config.quran.enabled) return [{ name: "Quran data", severity: "ok", detail: "disabled" }];
  const missing = [paths.quranTextFile, paths.quranUthmaniFile].filter((f) => !existsSync(f));
  if (missing.length > 0) {
    return [
      {
        name: "Quran data",
        severity: "warn",
        detail: `missing ${missing.join(", ")}: the server downloads it when it starts (by hand: ${quranDataCmd()}); Quran references are off until then`,
      },
    ];
  }
  const results: CheckResult[] = [
    { name: "Quran data", severity: "ok", detail: paths.quranTextFile },
  ];
  for (const [lang, file] of Object.entries(paths.quranTranslations)) {
    results.push(
      existsSync(file)
        ? { name: `Quran translation (${lang})`, severity: "ok", detail: file }
        : {
            name: `Quran translation (${lang})`,
            severity: "warn",
            detail: `${file} missing: recited verses show Soniox's live translation`,
          },
    );
  }
  return results;
}

function exposureCheck(config: Config): CheckResult {
  const { exposure, https } = config.server;
  if (exposure === "lan") {
    if (https.port !== null) {
      return {
        name: "Exposure",
        severity: "ok",
        detail: `lan, with HTTPS on port ${https.port} for microphones on other devices`,
      };
    }
    return {
      name: "Exposure",
      severity: "warn",
      detail:
        'lan without HTTPS: caption pages on other devices cannot use their microphone; set server.https.port (docs/guide.md, "HTTPS on the LAN")',
    };
  }
  if (exposure === "public")
    return {
      name: "Exposure",
      severity: "ok",
      detail: "public (behind an HTTPS proxy, trustProxy on)",
    };
  if (https.port !== null) {
    return {
      name: "Exposure",
      severity: "warn",
      detail: `local: HTTPS (port ${https.port}) answers on this computer only; other devices need exposure: lan`,
    };
  }
  return { name: "Exposure", severity: "ok", detail: "local (this machine only)" };
}

const DAY_MS = 86_400_000;

/**
 * server.https.port needs its certificate and key (a matching pair, not expired), and on the LAN
 * the certificate must name this computer's address, or browsers refuse it.
 */
export function httpsCheck(
  loaded: LoadedConfig,
  opts: { lan: string | null; container: boolean; now: number },
): CheckResult | null {
  const { config, paths } = loaded;
  const port = config.server.https.port;
  if (port === null) return null;
  const name = "HTTPS";
  const remake = lanCertCmd(paths.tlsCertFile, opts.container);
  const missing = [paths.tlsCertFile, paths.tlsKeyFile].filter((f) => !existsSync(f));
  if (missing.length > 0) {
    return {
      name,
      severity: "fail",
      detail: `port ${port}, but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing; run ${remake}`,
    };
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(readFileSync(paths.tlsCertFile));
  } catch {
    return {
      name,
      severity: "fail",
      detail: `${paths.tlsCertFile} is not a certificate; run ${remake}`,
    };
  }
  try {
    if (!cert.checkPrivateKey(createPrivateKey(readFileSync(paths.tlsKeyFile)))) {
      return {
        name,
        severity: "fail",
        detail: `${paths.tlsKeyFile} does not belong to the certificate; run ${remake}`,
      };
    }
  } catch {
    return {
      name,
      severity: "fail",
      detail: `${paths.tlsKeyFile} is not a private key; run ${remake}`,
    };
  }
  const until = cert.validToDate;
  const day = until.toISOString().slice(0, 10);
  if (until.getTime() <= opts.now) {
    return { name, severity: "fail", detail: `the certificate expired on ${day}; run ${remake}` };
  }
  // Inside the container the address is the container's own; the host made the certificate.
  const lan = config.server.exposure === "lan" && !opts.container ? opts.lan : null;
  if (lan !== null && cert.checkIP(lan) === undefined) {
    return {
      name,
      severity: "warn",
      detail: `the certificate does not name this computer's address ${lan}, which may have changed; run ${remake} again`,
    };
  }
  const soon = until.getTime() - opts.now < 30 * DAY_MS;
  return {
    name,
    severity: soon ? "warn" : "ok",
    detail: `port ${port}${lan === null ? "" : `, certificate for ${lan}`}, valid until ${day}${soon ? `; run ${remake} again soon` : ""}`,
  };
}

async function portCheck(
  config: Config,
  deps: DoctorDeps,
  published: number | null,
  container: boolean,
): Promise<CheckResult> {
  const { host, port } = config.server;
  // A one-off container (make doctor) has its own network: its ports are always free.
  if (container) {
    return {
      name: "Port",
      severity: "ok",
      detail: `${published ?? port} on this computer (HTTP_PORT in .env; make status shows whether it runs)`,
    };
  }
  if (await deps.portFree(host, port))
    return { name: "Port", severity: "ok", detail: `${host}:${port} is free` };
  if (await deps.healthOk(host, port)) {
    return {
      name: "Port",
      severity: "ok",
      detail: `${host}:${port} is in use by a running Turjuman server`,
    };
  }
  return { name: "Port", severity: "fail", detail: `${host}:${port} is in use by another program` };
}

/** Run every check. `loaded` is the loaded config, or the error that loading raised. */
export async function runDoctor(
  loaded: LoadedConfig | Error,
  deps: DoctorDeps,
  opts: { online: boolean },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const major = Number.parseInt(deps.nodeVersion.split(".")[0] ?? "0", 10);
  results.push({
    name: "Node.js",
    severity: major >= 24 ? "ok" : "fail",
    detail: `v${deps.nodeVersion}${major >= 24 ? "" : " (need >= 24)"}`,
  });

  const container = deps.container ?? inContainer();
  let config: Config;
  if (loaded instanceof Error) {
    results.push({ name: "Config", severity: "fail", detail: loaded.message });
    config = defaultConfig();
  } else {
    config = loaded.config;
    const { paths } = loaded;
    results.push({
      name: "Config",
      severity: "ok",
      detail: paths.configFile ?? "defaults (no config.yaml)",
    });
    // config.yaml is optional: the line above already says "defaults (no config.yaml)".
    for (const w of loaded.warnings) {
      if (paths.configFile === null && w.startsWith("No config.yaml")) continue;
      results.push({ name: "Config", severity: "warn", detail: w });
    }
    results.push({
      name: "Paths",
      severity: "ok",
      detail: `CONFIG_DIR=${paths.configDir}  DATA_DIR=${paths.dataDir}`,
    });
    results.push(exposureCheck(config));
    const https = httpsCheck(loaded, {
      lan: deps.lan === undefined ? lanAddress() : deps.lan,
      container,
      now: deps.now?.() ?? Date.now(),
    });
    if (https !== null) results.push(https);
    // Hosted: every mosque adds its own key in the app; local: .env or stored in the app.
    if (config.mode === "hosted") {
      results.push(...hostedChecks(loaded, deps.masterKey ?? new MasterKey(paths.masterKeyFile)));
    } else {
      const stored = storedLocalKeys(loaded, deps.masterKey ?? new MasterKey(paths.masterKeyFile));
      results.push(sonioxKeyCheck(loaded.secrets.sonioxApiKey, stored.soniox));
    }
    results.push(languagesCheck(paths.languagesFile));
    results.push(...glossaryChecks(loaded));
    results.push(layoutCheck(config));
    results.push(...quranCheck(loaded));
  }

  results.push(await ffmpegCheck(config, deps));
  if (config.audio.input.kind === "network") {
    results.push({
      name: "Audio bridge",
      severity: "warn",
      detail: `audio.input.kind is network, so "waiting for bridge" is normal until the host bridge connects to port ${config.audio.input.network.port}`,
    });
  }
  const published = loaded instanceof Error ? null : (loaded.context.publishedPort ?? null);
  results.push(await portCheck(config, deps, published, container));

  const host = sonioxHost(config.stt.soniox.region);
  const tls = await deps.tlsReachable(host);
  results.push({ name: `TLS ${host}`, severity: tls.ok ? "ok" : "fail", detail: tls.detail });

  // The key the server would use: .env first, else the one added in the app (local mode; a
  // hosted server's keys belong to the mosques and are checked when they are added).
  if (
    opts.online &&
    deps.online !== undefined &&
    !(loaded instanceof Error) &&
    config.mode === "local"
  ) {
    const inApp = storedLocalKeyValues(
      loaded,
      deps.masterKey ?? new MasterKey(loaded.paths.masterKeyFile),
    );
    const sonioxApiKey = loaded.secrets.sonioxApiKey ?? inApp.soniox;
    if (sonioxApiKey !== null) {
      const r = await deps.online.soniox(
        sonioxApiKey,
        config.stt.soniox.region,
        config.stt.soniox.model,
      );
      results.push({
        name: "Soniox key (online)",
        severity: r.ok ? "ok" : "fail",
        detail: r.detail,
      });
    }
  }
  return results;
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.severity === "fail") ? 1 : 0;
}

const TAG: Record<Severity, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };

export function formatResults(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map(
    (r) =>
      `${TAG[r.severity]} ${r.name.padEnd(width)}  ${r.detail.split("\n").join("\n         ")}`,
  );
  const count = (s: Severity): number => results.filter((r) => r.severity === s).length;
  lines.push("", `${count("ok")} ok, ${count("warn")} warnings, ${count("fail")} failures`);
  return lines.join("\n");
}

// --- real dependencies -------------------------------------------------------------------

function clientHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function realDoctorDeps(ffmpegPath: string): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    runFfmpeg: (args) =>
      new Promise((resolveRun) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill(), 10_000);
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolveRun(null);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolveRun({ code, stdout, stderr });
        });
      }),
    portFree: (host, port) =>
      new Promise((resolvePort) => {
        const server = createServer();
        server.once("error", () => resolvePort(false));
        server.listen(port, host, () => server.close(() => resolvePort(true)));
      }),
    healthOk: async (host, port) => {
      try {
        const res = await fetch(`http://${clientHost(host)}:${port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    tlsReachable: (host) =>
      new Promise((resolveTls) => {
        const socket = connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
          resolveTls({ ok: true, detail: `TLS handshake ok (${socket.getProtocol() ?? "tls"})` });
          socket.end();
        });
        socket.on("timeout", () => {
          resolveTls({ ok: false, detail: "timeout after 5 s" });
          socket.destroy();
        });
        socket.on("error", (err) => resolveTls({ ok: false, detail: err.message }));
      }),
    online: {
      soniox: async (key, region, model) => {
        const url = `https://api${region === "eu" ? ".eu" : ""}.soniox.com/v1/models`;
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${url}` };
          const body = (await res.json()) as { models?: Array<{ id?: string }> };
          const found = (body.models ?? []).some((m) => m.id === model);
          return {
            ok: found,
            detail: found
              ? `key accepted; ${model} available`
              : `key accepted, but ${model} not listed`,
          };
        } catch (err) {
          return { ok: false, detail: (err as Error).message };
        }
      },
    },
  };
}
