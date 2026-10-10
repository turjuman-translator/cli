import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Logger } from "pino";
import { KeyResolver } from "../accounts/key-resolver.js";
import { MasterKey } from "../accounts/keystore.js";
import { OrgStore } from "../accounts/orgs.js";
import { listDevices } from "../audio/devices.js";
import { createAudioSource } from "../audio/ffmpeg.js";
import { type LoadedConfig, loadConfig, type Secrets } from "../config.js";
import type { AudioInputApi, AudioInputSpec } from "../core/contracts.js";
import { createEngineFactory } from "../core/engines.js";
import { clearMarker, readMarker, shouldResume, writeMarker } from "../core/resume.js";
import { type SessionBlocksDeps, SessionManager } from "../core/sessions.js";
import { SilentAudioInput } from "../core/silent-input.js";
import { regenerateMissingSrts } from "../core/transcripts.js";
import { UsageStore } from "../core/usage.js";
import { EventDetector } from "../events/detector.js";
import { migrateLegacyGlossary } from "../glossary.js";
import { loadLanguages } from "../languages.js";
import { createLogger } from "../log.js";
import { createQuranFollower } from "../quran/follower.js";
import { loadQuranMatcher, type QuranMatcher } from "../quran/matcher.js";
import {
  type BackgroundDownload,
  type BackgroundDownloadOptions,
  downloadInBackground,
  missingQuranFiles,
} from "../quran/tanzil.js";
import { buildApp } from "../server/app.js";
import { type HttpsListener, listenHttps } from "../server/https.js";
import type { ServerMessage } from "../shared/protocol.js";
import { packageVersion } from "../version.js";
import { inContainer, lanCertCmd, quranDataCmd, turjumanCmd } from "./hint.js";
import type { CliIo } from "./index.js";
import { runDryCommand } from "./run-dry.js";
import { serverAddresses } from "./urls.js";
import { COMMAND_USAGE } from "./usage.js";

export interface ServeOptions {
  loaded: LoadedConfig;
  io: CliIo;
  dev: boolean;
  print: boolean;
  /** Replay this provider.jsonl for every engine (no network, no API cost). */
  fakeProviderFile: string | null;
  fakeSpeed: number;
  fakeLoop: boolean;
  /** Use silent audio instead of ffmpeg for local sessions (replay). */
  silentAudio: boolean;
  /** Start the local session right away. */
  autoStart: { source: "device" | "file"; file?: string; loop?: boolean } | null;
  /** Download missing Quran data in the background (`run` and `start`); absent or null: never. */
  quranDownload?: Pick<
    BackgroundDownloadOptions,
    "fetch" | "baseUrl" | "retryMs" | "timeoutMs"
  > | null;
}

/** Print closed segments of the local session to the console (`--print`). */
export function printer(io: CliIo): (msg: ServerMessage) => void {
  const printed = new Set<string>();
  return (msg) => {
    if (msg.type !== "segment") return;
    const s = msg.segment;
    const translations = Object.entries(s.translations);
    const allFinal = s.closed && translations.every(([, t]) => t.final);
    if (!allFinal || printed.has(s.id)) return;
    printed.add(s.id);
    // Only the sides that have text: a caption can be all source or all translation.
    const source = s.source.text.trim();
    const lines = translations
      .map(([lang, t]) => [lang, t.text.trim()] as const)
      .filter(([, text]) => text !== "")
      .map(([lang, text]) => `        ${lang}: ${text}`);
    if (source === "" && lines.length === 0) return;
    io.out(`[${msg.track} #${s.seq}]${source === "" ? "" : ` ${source}`}`);
    for (const line of lines) io.out(line);
  };
}

/**
 * Caption blocks: the Quran matcher (Tanzil text) behind one Quran follower per session, and one
 * prayer-event detector per session. Missing Quran data is downloaded in the
 * background when `download` is set: the sessions that start after it arrived follow the Quran.
 */
export function createBlocksDeps(
  loaded: LoadedConfig,
  log: Logger,
  download: ServeOptions["quranDownload"],
): { deps: SessionBlocksDeps; background: BackgroundDownload | null } {
  const { config, paths } = loaded;
  let matcher: QuranMatcher | null = null;
  /** Load the Quran files in place; a session reads the matcher when it starts. */
  const load = (): void => {
    const t0 = Date.now();
    const next = loadQuranMatcher(paths, config.quran, {
      onProblem: (message) => log.warn({ quran: message }, "Quran data problem"),
    });
    if (!next.ready) return;
    matcher = next;
    log.info({ ms: Date.now() - t0 }, "Quran matcher ready");
  };
  let background: BackgroundDownload | null = null;
  if (config.quran.enabled) {
    const missing = missingQuranFiles(paths);
    if (missing.length === 0 || download === undefined || download === null) {
      load();
      if (matcher === null) {
        log.warn(`Quran data missing: run ${quranDataCmd()} (verse references are off until then)`);
      }
    } else {
      // What is there already works now (a translation may be the only file missing).
      if (existsSync(paths.quranTextFile)) load();
      log.info(
        `Quran data missing (${missing.length} file(s)): downloading it in the background; verse references start once it is in place`,
      );
      background = downloadInBackground({ files: paths, ...download, log, onSaved: load });
    }
  }
  return {
    background,
    deps: {
      // Fast blocks follow Quran quotes word by word (one follower per session). cueHoldMs 4500:
      // a quote that starts like many verses ("يا أيها الذين آمنوا…") is held until the words
      // that identify it arrive, so the whole ayah is shown as the Quran.
      followerFactory: (targetLang) =>
        createQuranFollower(matcher, { targetLang, maxHoldMs: 2000, cueHoldMs: 4500 }),
      detectorFactory: () => (config.events.enabled ? new EventDetector(config.events) : null),
    },
  };
}

/** Start the HTTP/WebSocket server and the session manager; resolves when the process should exit. */
export async function serve(opts: ServeOptions): Promise<number> {
  const { loaded, io } = opts;
  const { config, paths, secrets } = loaded;
  const secretValues = [secrets.sonioxApiKey, config.server.token].filter(
    (s): s is string => s !== null && s !== "",
  );
  // A person at a terminal gets one short line per entry; Docker and pipes get JSON lines.
  const log = createLogger({
    pretty: opts.dev,
    terminal: process.stdout.isTTY === true && !inContainer(),
    secrets: secretValues,
  });
  for (const w of loaded.warnings) log.warn(w);
  if (loaded.createdConfigFile) {
    log.info(
      `Created ${loaded.createdConfigFile} (mode ${config.mode}, exposure ${config.server.exposure}); edit it and restart to change a setting`,
    );
  }
  // Where the token is, never the token itself (the logger also scrubs it).
  if (loaded.tokenFile) {
    log.info(`Admin token: kept in ${loaded.tokenFile}; the CLI and make read it from there`);
  }
  const migration = migrateLegacyGlossary(paths.configDir, paths.glossariesDir);
  if (migration !== "none") log.info({ migration }, "legacy glossary.yaml");

  const regenerated = regenerateMissingSrts(paths.transcriptsDir, log);
  if (regenerated.length > 0) log.info({ regenerated }, "regenerated missing SRT files");
  const version = packageVersion();
  const languages = loadLanguages(paths.languagesFile);
  const usage = new UsageStore({ dir: paths.usageDir });
  const engineFactory = createEngineFactory({
    loaded,
    log,
    languages,
    fakeProviderFile: opts.fakeProviderFile,
    fakeSpeed: opts.fakeSpeed,
    fakeLoop: opts.fakeLoop,
  });
  const audioInputFactory = (spec: AudioInputSpec): AudioInputApi =>
    opts.silentAudio
      ? new SilentAudioInput()
      : createAudioSource(config.audio, spec, { log, secrets: secretValues });
  const quran = createBlocksDeps(loaded, log, opts.quranDownload);
  const blocks = quran.deps;
  // Organisations and their encrypted keys; sessions run with their
  // organisation's keys (local mode: .env first).
  const orgs = new OrgStore(paths.orgsFile);
  const keyResolver = new KeyResolver({
    mode: config.mode,
    env: secrets,
    orgs,
    master: new MasterKey(paths.masterKeyFile),
    log,
  });
  // A replayed provider log needs no API key (no network, no cost): its sessions start without one.
  const keys = (orgId: string): Secrets => {
    const resolved = keyResolver.resolve(orgId);
    return opts.fakeProviderFile !== null && resolved.sonioxApiKey === null
      ? { ...resolved, sonioxApiKey: "fake-provider" }
      : resolved;
  };
  const manager = new SessionManager({
    loaded,
    engineFactory,
    audioInputFactory,
    log,
    version,
    blocks,
    keys,
  });
  const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
  const app = await buildApp({
    loaded,
    manager,
    log,
    publicDir,
    version,
    usage,
    languages,
    orgs,
    keyResolver,
    listDevices: () =>
      listDevices({ platform: process.platform, ffmpegPath: config.audio.ffmpegPath }),
  });
  try {
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    await app.close();
    usage.close();
    quran.background?.stop();
    io.err(
      `Port ${config.server.port} is in use: is Turjuman running already? (${turjumanCmd("status")})\n` +
        "To use another port, set server.port in config.yaml (start from config.example.yaml).",
    );
    return 1;
  }
  const addresses = serverAddresses(loaded);
  const base = addresses.local;
  // HTTPS on a second port for microphones on other devices (https:// only).
  let https: HttpsListener | null = null;
  let httpsLine = "";
  const httpsPort = config.server.https.port;
  if (httpsPort !== null) {
    try {
      https = await listenHttps(app, {
        host: config.server.host,
        port: httpsPort,
        key: readFileSync(paths.tlsKeyFile),
        cert: readFileSync(paths.tlsCertFile),
      });
      // Other devices install the CA once, from the plain-http address they reach (exposure lan).
      httpsLine =
        `  HTTPS:            ${addresses.https ?? `https://127.0.0.1:${https.port}`}/` +
        (addresses.lan === null ? "" : `   (install ${addresses.lan}/ca.crt once per device)`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      log.error({ err, cert: paths.tlsCertFile }, "HTTPS not started");
      httpsLine =
        code === "ENOENT"
          ? `  HTTPS:            not started, no certificate in ${dirname(paths.tlsCertFile)}: run ${lanCertCmd(paths.tlsCertFile)}`
          : code === "EADDRINUSE"
            ? `  HTTPS:            not started, port ${httpsPort} is in use (server.https.port in config.yaml)`
            : "  HTTPS:            not started (see the log)";
    }
  }
  // Hosted: the website and the app (caption pages need a screen link or a login there, and the
  // overlay and control page the operator's token); local: the pages of this computer.
  const site = addresses.public ?? base;
  const pages =
    config.mode === "hosted"
      ? [`  Website:          ${site}/`, `  App:              ${site}/app`]
      : [
          `  Caption link:     ${base}/`,
          `  Caption page:     ${base}/${config.pages.defaultFrom}/${config.pages.defaultTo}`,
          `  Overlay / dock:   ${base}/overlay   ${base}/control`,
        ];
  io.out(
    [
      `Turjuman server running (v${version}, ${config.mode === "hosted" ? "hosted, " : ""}exposure ${config.server.exposure}${opts.fakeProviderFile ? ", FAKE provider" : ""})`,
      ...pages,
      `  Health:           ${base}/health`,
      ...(httpsLine === "" ? [] : [httpsLine]),
    ].join("\n"),
  );

  let webWatcher: ChildProcess | null = null;
  if (opts.dev) {
    webWatcher = spawn("pnpm", ["exec", "tsx", "scripts/build-web.ts", "--watch"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }

  manager.startMonitor();

  // Resume after restart.
  if (config.session.resumeAfterRestart && opts.autoStart === null) {
    const marker = readMarker(paths.stateDir);
    if (
      marker !== null &&
      shouldResume(marker, {
        now: Date.now(),
        windowMin: config.session.resumeWindowMin,
        dev: opts.dev,
      })
    ) {
      const r = await manager.startLocal({ source: "device", resume: true });
      log.info({ resumed: r }, "resumed the local session after a restart");
      if (r.ok)
        writeMarker(paths.stateDir, {
          ...marker,
          resumes: marker.resumes + 1,
          lastAliveAt: Date.now(),
        });
    } else if (marker !== null) {
      clearMarker(paths.stateDir);
    }
  }

  if (opts.autoStart !== null) {
    const r = await manager.startLocal(opts.autoStart);
    io.out(`Local session: ${r.message}`);
  }

  // --print follows the local session: the one started (or resumed) above at once, a later one
  // (started from the control page) at the next heartbeat.
  let unsubscribePrint: (() => void) | null = null;
  let printedSession: string | null = null;
  const followLocal = (): void => {
    const local = manager.local();
    if (!opts.print || local === null || printedSession === local.id) return;
    unsubscribePrint?.();
    unsubscribePrint = local.subscribe(printer(io));
    printedSession = local.id;
  };
  followLocal();

  let shuttingDown = false;
  const heartbeat = setInterval(() => {
    followLocal();
    const local = manager.local();
    if (shuttingDown || opts.dev) return;
    const status = local?.status() ?? null;
    if (local === null || status === null || status.state === "idle" || status.state === "error") {
      // No local session, or it was stopped (operator, cost guard, end of file): never resume it.
      clearMarker(paths.stateDir);
      return;
    }
    const info = local.info();
    if (status.state !== "live" && status.state !== "reconnecting") return;
    if (info.inputKind !== "device" && info.inputKind !== "network") return;
    const previous = readMarker(paths.stateDir);
    writeMarker(paths.stateDir, {
      sessionId: info.id,
      startedAt: previous?.sessionId === info.id ? previous.startedAt : info.startedAt,
      lastAliveAt: Date.now(),
      resumes: previous?.resumes ?? 0,
      inputKind: info.inputKind,
    });
  }, 5000);

  return new Promise<number>((resolveExit) => {
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(heartbeat);
      quran.background?.stop();
      // Native Ctrl-C at a terminal is a deliberate stop; SIGTERM/SIGHUP (docker restart) keep the marker.
      if (signal === "SIGINT" && process.stdin.isTTY) clearMarker(paths.stateDir);
      const budgetMs = signal === "SIGHUP" ? 4000 : 14_000;
      log.info({ signal }, "shutting down");
      const timeout = new Promise<void>((r) => setTimeout(r, budgetMs).unref());
      await Promise.race([manager.stopAll(`signal ${signal}`), timeout]);
      await Promise.race([
        Promise.all([app.close(), https?.close()]),
        new Promise<void>((r) => setTimeout(r, 1500).unref()),
      ]);
      usage.close();
      webWatcher?.kill();
      resolveExit(0);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      process.on(signal, () => {
        void shutdown(signal);
      });
    }
  });
}

/** The options of `turjuman run` (and `start`, which checks them before it loads the config). */
export const RUN_OPTIONS = {
  config: { type: "string" },
  file: { type: "string" },
  loop: { type: "boolean", default: false },
  start: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  print: { type: "boolean", default: false },
  dev: { type: "boolean", default: false },
  "fake-provider": { type: "string" },
} as const;

/** `turjuman run [--config f] [--file wav] [--start] [--dry-run] [--print] [--dev] [--fake-provider log]` */
export async function runCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: RUN_OPTIONS });
  // A first start makes config.yaml for this deployment (not with --config or --dry-run).
  const loaded = loadConfig(
    values.config === undefined ? { create: !values["dry-run"] } : { configFile: values.config },
  );
  if (values["dry-run"]) {
    return runDryCommand({
      loaded,
      io,
      ...(values.file === undefined ? {} : { file: values.file }),
    });
  }
  const autoStart =
    values.file !== undefined
      ? { source: "file" as const, file: resolve(values.file), loop: values.loop }
      : values.start
        ? { source: "device" as const }
        : null;
  return serve({
    loaded,
    io,
    dev: values.dev,
    print: values.print,
    fakeProviderFile:
      values["fake-provider"] === undefined ? null : resolve(values["fake-provider"]),
    fakeSpeed: 1,
    fakeLoop: false,
    silentAudio: false,
    autoStart,
    quranDownload: {},
  });
}

/** `turjuman replay <provider.jsonl> [--speed 1] [--loop]`: server + FakeProvider, no network. */
export async function replayCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      speed: { type: "string", default: "1" },
      loop: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
    },
  });
  const file = positionals[0];
  if (file === undefined) {
    io.err(COMMAND_USAGE.replay);
    return 2;
  }
  const loaded = loadConfig(values.config === undefined ? {} : { configFile: values.config });
  const speed = Number.parseFloat(values.speed);
  return serve({
    loaded,
    io,
    dev: false,
    print: values.print,
    fakeProviderFile: resolve(file),
    fakeSpeed: Number.isFinite(speed) && speed > 0 ? speed : 1,
    fakeLoop: values.loop,
    silentAudio: true,
    autoStart: { source: "file", file: resolve(file), loop: values.loop },
  });
}
