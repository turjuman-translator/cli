import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { createFileOnce, resolveDirs, resolveIn } from "./paths.js";
import { formatIssues, ValidationError } from "./validation.js";

// Config schema (config.yaml).
// Every default here must equal config.example.yaml (a test enforces it).
// Nested objects use .prefault({}) so their own defaults apply (zod 4 .default() short-circuits).

const port = z.number().int().min(1).max(65535);
const dbfs = z.number().max(0);

const ServerSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: port.default(8765),
  exposure: z.enum(["local", "lan", "public"]).default("local"),
  /** Optional admin credential for CLI/API clients; empty = account logins only. */
  token: z.string().default(""),
  protectOverlay: z.boolean().default(false),
  trustProxy: z.boolean().default(false),
  /**
   * Also serve HTTPS on this port (null = off): microphones on phones and other PCs
   * need https://. Files relative to CONFIG_DIR; `make lan-cert` creates them.
   */
  https: z
    .strictObject({
      port: port.nullable().default(null),
      certFile: z.string().min(1).default("tls/server.crt"),
      keyFile: z.string().min(1).default("tls/server.key"),
      caFile: z.string().min(1).default("tls/ca.crt"),
    })
    .prefault({}),
});

const AudioSchema = z.strictObject({
  ffmpegPath: z.string().min(1).default("ffmpeg"),
  input: z
    .strictObject({
      kind: z.enum(["none", "device", "file", "network"]).default("none"),
      device: z.string().default("Line (USB Audio CODEC)"),
      path: z.string().optional(),
      loop: z.boolean().default(false),
      startAtSec: z.number().min(0).default(0),
      network: z
        .strictObject({
          port: port.default(7000),
          sampleRate: z.number().int().positive().default(48000),
          channels: z.number().int().min(1).max(8).default(2),
        })
        .prefault({}),
    })
    .prefault({}),
  monitorWhenIdle: z.boolean().default(true),
  channel: z.enum(["mix", "left", "right"]).default("left"),
  gainDb: z.number().default(0),
  highpassHz: z.number().min(0).default(0),
  silenceWarnDbfs: dbfs.default(-50),
});

const SttSchema = z.strictObject({
  soniox: z
    .strictObject({
      region: z.enum(["default", "eu"]).default("default"),
      model: z.string().min(1).default("stt-rt-v5"),
      languageHints: z.array(z.string().min(1)).default(["ar"]),
      endpointDetection: z.boolean().default(true),
      maxEndpointDelayMs: z.number().int().min(500).max(3000).nullable().default(null),
      /** Endpoint latency level, 0–3 (null = Soniox default; fast blocks use 1, src/core/engines.ts). */
      endpointLatencyLevel: z.number().int().min(0).max(3).nullable().default(null),
      /** Endpoint sensitivity, −1…1 (null = Soniox default; fast blocks use 0, src/core/engines.ts). */
      endpointSensitivity: z.number().min(-1).max(1).nullable().default(null),
      pauseFinalizeMs: z.number().int().min(0).max(3000).nullable().default(null),
      forceFinalizeAfterWords: z.number().int().positive().nullable().default(null),
      forceFinalizeAfterMs: z.number().int().positive().nullable().default(null),
    })
    .prefault({}),
});

/** Soniox translates (its own translation, in the same stream as the speech recognition). */
const TranslationSchema = z.strictObject({
  targetLanguage: z.string().min(1).default("nl"),
});

const VadSchema = z.strictObject({
  thresholdDbfs: dbfs.default(-45),
  minSpeechMs: z.number().int().positive().default(200),
  minSilenceMs: z.number().int().positive().default(400),
});

const PagesSchema = z.strictObject({
  enabled: z.boolean().default(true),
  defaultFrom: z.string().min(1).default("ar"),
  defaultTo: z.string().min(1).default("nl"),
  defaultShow: z.enum(["both", "target", "source"]).default("both"),
  resumeGraceSec: z.number().min(0).default(15),
  closeAfterSilenceSec: z.number().min(1).default(30),
  vad: z
    .strictObject({
      thresholdDbfs: dbfs.default(-45),
      minSpeechMs: z.number().int().positive().default(200),
      // A short pause ends the utterance sooner (speech end → finalize → text).
      minSilenceMs: z.number().int().positive().default(300),
      // Audio keeps flowing through a pause up to ≈1.8 s, so Soniox decides
      // sentence ends itself (a finalize at every breath cut sentences into scraps).
      hangoverMs: z.number().int().min(0).default(1500),
      prerollMs: z.number().int().min(0).default(500),
    })
    .prefault({}),
  /** Finalize the engine at every speech end of the page VAD (a measured trade-off). */
  finalizeOnSpeechEnd: z.boolean().default(true),
  savePageSessions: z.boolean().default(true),
  allowedOrigins: z.array(z.string().min(1)).default([]),
  /** true = only signed screen links (made in /admin) can start captions. */
  requireScreen: z.boolean().default(false),
});

/** Portal accounts (users.yaml) and login sessions. */
const AccountsSchema = z.strictObject({
  /** Login cookie lifetime. */
  sessionDays: z.number().int().min(1).max(365).default(30),
});

const SessionSchema = z.strictObject({
  autoStopAfterSilenceMin: z.number().positive().default(10),
  maxDurationMin: z.number().positive().default(90),
  resumeAfterRestart: z.boolean().default(true),
  resumeWindowMin: z.number().positive().default(10),
});

const TranscriptsSchema = z.strictObject({
  dir: z.string().min(1).default("transcripts"),
  srt: z.boolean().default(true),
  recordProviderMessages: z.boolean().default(false),
});

const price = z.number().min(0);
const PricingSchema = z.strictObject({
  sonioxSttPerHour: price.default(0.12),
  sonioxTranslationPerHour: price.default(0.06),
});

// Caption blocks, verified Quran references, prayer events.
const DisplaySchema = z.strictObject({
  layout: z.enum(["blocks", "rollup"]).default("blocks"),
  history: z.boolean().default(true),
  quranAccent: z.boolean().default(true),
  quranArabic: z.boolean().default(true),
  preset: z.string().min(1).default("mosque-dark"),
});

const QuranSchema = z.strictObject({
  enabled: z.boolean().default(true),
  textFile: z.string().min(1).default("quran/quran-simple-clean.txt"),
  uthmaniFile: z.string().min(1).default("quran/quran-uthmani.txt"),
  translations: z.record(z.string(), z.string().min(1)).default({ nl: "quran/nl.siregar.txt" }),
  minWords: z.number().int().min(3).default(5),
  minCoverage: z.number().min(0).max(1).default(0.6),
  stoplist: z.array(z.string()).default(["الحمد لله رب العالمين", "بسم الله الرحمن الرحيم"]),
});

const EventLabelSchema = z.strictObject({
  ar: z.string(),
  title: z.string(),
  subtitle: z.string(),
});
const EventLabelsSchema = z.strictObject({
  athan: EventLabelSchema,
  iqama: EventLabelSchema,
  salah: EventLabelSchema,
});

const EventsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  silenceBeforeSec: z.number().min(0).default(5),
  holdMaxSec: z.number().positive().default(75),
  endSilenceSec: z.number().positive().default(20),
  salahMode: z.boolean().default(true),
  salahMaxMin: z.number().positive().default(12),
  labels: z.record(z.string(), EventLabelsSchema).default({
    nl: {
      athan: { ar: "الأذان", title: "Athan", subtitle: "Oproep tot het gebed" },
      iqama: { ar: "الإقامة", title: "Iqama", subtitle: "Het gebed begint" },
      salah: { ar: "الصلاة", title: "Gebed", subtitle: "" },
    },
    en: {
      athan: { ar: "الأذان", title: "Athan", subtitle: "Call to prayer" },
      iqama: { ar: "الإقامة", title: "Iqama", subtitle: "The prayer begins" },
      salah: { ar: "الصلاة", title: "Prayer", subtitle: "" },
    },
  }),
});

/** Hosted mode serves many mosques (sign-up, organisations, encrypted keys). */
const HostedSchema = z.strictObject({
  /** "open": anyone can create an account at /signup; "closed": only existing accounts. */
  signup: z.enum(["open", "closed"]).default("open"),
  /** The public address of this server (https://…), for links shown in the app; optional. */
  publicUrl: z.string().url().nullable().default(null),
  /**
   * The operator's own privacy statement and contact (https://… or mailto:…), linked from the
   * website's footer when set. Every server runs the same website, so these are per server.
   */
  privacyUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "use an http(s) address")
    .nullable()
    .default(null),
  contactUrl: z
    .string()
    .url()
    .refine((u) => /^(https?:\/\/|mailto:)/i.test(u), "use an http(s) or mailto: address")
    .nullable()
    .default(null),
});

const ConfigSchema = z.strictObject({
  /** "local" (default): one mosque per install, keys in .env. "hosted": see HostedSchema. */
  mode: z.enum(["local", "hosted"]).default("local"),
  hosted: HostedSchema.prefault({}),
  server: ServerSchema.prefault({}),
  audio: AudioSchema.prefault({}),
  stt: SttSchema.prefault({}),
  translation: TranslationSchema.prefault({}),
  vad: VadSchema.prefault({}),
  pages: PagesSchema.prefault({}),
  languagesFile: z.string().min(1).default("languages.yaml"),
  glossariesDir: z.string().min(1).default("glossaries"),
  session: SessionSchema.prefault({}),
  transcripts: TranscriptsSchema.prefault({}),
  pricing: PricingSchema.prefault({}),
  display: DisplaySchema.prefault({}),
  quran: QuranSchema.prefault({}),
  events: EventsSchema.prefault({}),
  accounts: AccountsSchema.prefault({}),
});

export type Config = z.output<typeof ConfigSchema>;

/** Facts about the runtime environment that change what a valid config is. */
export interface ConfigContext {
  /** Running inside the Docker image (CAPTIONS_CONTAINER=1). */
  inContainer: boolean;
  /** Host address compose publishes the HTTP port on (CAPTIONS_BIND), if known. */
  bindAddress: string | null;
  /**
   * The host ports compose publishes the HTTP and HTTPS ports on (CAPTIONS_HTTP_PORT,
   * CAPTIONS_HTTPS_PORT), when they differ from server.port inside the container: links for this
   * computer (feed links, the app's addresses) use them.
   */
  publishedPort?: number | null;
  publishedHttpsPort?: number | null;
}

export type ParseResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; errors: string[] };

export interface Secrets {
  sonioxApiKey: string | null;
}

export interface ResolvedPaths {
  configDir: string;
  dataDir: string;
  /** The config file that was read, or null when running on defaults. */
  configFile: string | null;
  languagesFile: string;
  glossariesDir: string;
  keysFile: string;
  /** Accounts, screens and the signing secret (links + login cookies). */
  usersFile: string;
  screensFile: string;
  secretFile: string;
  /** Organisations: orgs.yaml in CONFIG_DIR. */
  orgsFile: string;
  /** The key that encrypts stored API keys, unless TURJUMAN_MASTER_KEY is set. */
  masterKeyFile: string;
  /** HTTPS certificate, key and the local CA certificate (served at /ca.crt). */
  tlsCertFile: string;
  tlsKeyFile: string;
  tlsCaFile: string;
  transcriptsDir: string;
  recordingsDir: string;
  benchDir: string;
  stateDir: string;
  usageDir: string;
  presetsFile: string;
  quranDir: string;
  quranTextFile: string;
  quranUthmaniFile: string;
  quranTranslations: Record<string, string>;
  exportsDir: string;
}

export interface LoadedConfig {
  config: Config;
  paths: ResolvedPaths;
  secrets: Secrets;
  warnings: string[];
  context: ConfigContext;
  /** The file that keeps the generated admin token, when config.server.token comes from it. */
  tokenFile?: string | null;
  /** config.yaml, when this load created it (`loadConfig({ create: true })`). */
  createdConfigFile?: string | null;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The fields the cross-field rules read. */
interface CrossFieldView {
  mode: string;
  server: { host: string; exposure: string; trustProxy: boolean; token: string };
}

/** On a hosted server the admin token opens every mosque: it must not be guessable. */
export const HOSTED_MIN_TOKEN = 24;

/** Where the generated admin token is kept, in CONFIG_DIR. */
export const TOKEN_FILE = "admin.token";
/** A generated token: 32 random bytes in base64url (43 characters). */
const GENERATED_TOKEN = /^[A-Za-z0-9_-]{32,}$/;

/** A hosted server and a server that other devices reach need an admin token (the operator's
 *  pages and the API that the CLI and make call). */
export function needsToken(config: Pick<Config, "mode" | "server">): boolean {
  return config.mode === "hosted" || config.server.exposure !== "local";
}

/**
 * The generated admin token in `file`: made the first time (mode 0600), then the same on every
 * start and update. Throws when the file holds no token (deleting it makes a new one).
 */
export function generatedToken(file: string): string {
  createFileOnce(file, `${randomBytes(32).toString("base64url")}\n`, 0o600);
  const token = readFileSync(file, "utf8").trim();
  if (!GENERATED_TOKEN.test(token)) {
    throw new Error(`${file} holds no valid admin token; delete it to make a new one`);
  }
  return token;
}

export type Deployment = "hosted" | "local";

/**
 * What a new config.yaml is made for. In the website repository it is "hosted": the platform,
 * behind the operator's own HTTPS proxy. scripts/export-selfhost.ts rewrites this line to "local"
 * for the self-hosted edition: one mosque, on this computer only.
 */
export const DEPLOYMENT: Deployment = "local";

/** The config.yaml a new install starts with; every other setting keeps its default. */
export function newConfigYaml(deployment: Deployment): string {
  const head = [
    "# Turjuman: this server's settings, made on its first start. Every other setting keeps its",
    "# default (config.example.yaml lists them all). Restart Turjuman after a change.",
    "",
  ];
  const body =
    deployment === "hosted"
      ? [
          "mode: hosted          # many mosques: the website at /, sign-up at /signup",
          "hosted:",
          "  signup: open        # open | closed (only existing accounts can log in)",
          "server:",
          "  exposure: public    # behind your HTTPS reverse proxy (nginx), which owns the hostname",
          "  trustProxy: true    # links follow X-Forwarded-Host and X-Forwarded-Proto of each request",
        ]
      : [
          "mode: local           # one mosque",
          "server:",
          "  exposure: local     # this computer only | lan: other devices on the network",
        ];
  return `${[...head, ...body].join("\n")}\n`;
}

/**
 * Create CONFIG_DIR/config.yaml for this deployment when it is missing. An existing file is never
 * touched. Returns the file when this call created it, else null.
 */
export function ensureConfigFile(
  configDir: string,
  deployment: Deployment = DEPLOYMENT,
): string | null {
  const file = join(configDir, "config.yaml");
  return createFileOnce(file, newConfigYaml(deployment), 0o644) ? file : null;
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Best-effort view of raw values, so cross-field problems are reported alongside schema errors. */
function lenientView(raw: unknown): CrossFieldView {
  const server = field(raw, "server");
  return {
    mode: str(field(raw, "mode"), "local"),
    server: {
      host: str(field(server, "host"), "127.0.0.1"),
      exposure: str(field(server, "exposure"), "local"),
      trustProxy: field(server, "trustProxy") === true,
      token: str(field(server, "token"), ""),
    },
  };
}

/** Why most removed settings went: Turjuman uses Soniox only. */
const SONIOX_ONLY = "Turjuman uses Soniox only";

/**
 * Settings that were removed: those of the Gemini engine, LLM translation, compare mode, live
 * engine switching and the Gemini caption composer (Turjuman uses Soniox only), two that never
 * had an effect (transcripts.recordAudio, debug.faultInjection) and the server-wide cap on caption
 * pages (pages.maxSessions). An older config.yaml may still have them: each is dropped with one
 * warning, so it keeps loading. A value that asked for Gemini
 * (or the LLM, compare mode, the composer) runs on Soniox.
 */
const REMOVED_KEYS: ReadonlyArray<{
  path: readonly string[];
  asked?: (v: unknown) => boolean;
  /** Why it went (default: SONIOX_ONLY). */
  why?: string;
}> = [
  { path: ["stt", "mode"], asked: (v) => v === "compare" },
  { path: ["stt", "provider"], asked: (v) => v === "gemini" },
  { path: ["stt", "primary"], asked: (v) => v === "gemini" },
  { path: ["stt", "gemini"] },
  { path: ["translation", "engine"], asked: (v) => v === "llm" },
  { path: ["translation", "llm"] },
  { path: ["pages", "defaultEngine"], asked: (v) => v === "gemini" },
  { path: ["pricing", "geminiTranscribeLivePerMin"] },
  { path: ["pricing", "llmInputPerMTok"] },
  { path: ["pricing", "llmOutputPerMTok"] },
  { path: ["composer"], asked: (v) => field(v, "enabled") === true },
  { path: ["transcripts", "recordAudio"], why: "it had no effect" },
  { path: ["pages", "maxSessions"], why: "caption pages have no server-wide limit any more" },
  { path: ["debug"], why: "debug.faultInjection had no effect" },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A copy of a raw config without the REMOVED_KEYS, and one warning per key that was there. The
 * input is not changed.
 */
export function dropRemovedKeys(raw: unknown): { raw: unknown; warnings: string[] } {
  if (!isRecord(raw)) return { raw, warnings: [] };
  const out: Record<string, unknown> = { ...raw };
  const warnings: string[] = [];
  for (const { path, asked, why = SONIOX_ONLY } of REMOVED_KEYS) {
    const last = path[path.length - 1] ?? "";
    let parent: Record<string, unknown> = out;
    let found = true;
    for (const key of path.slice(0, -1)) {
      const child = parent[key];
      if (!isRecord(child)) {
        found = false;
        break;
      }
      // Copy each level on the way down, so the caller's object stays as it was.
      const copy = { ...child };
      parent[key] = copy;
      parent = copy;
    }
    if (!found || !(last in parent)) continue;
    const value = parent[last];
    delete parent[last];
    const name = path.join(".");
    warnings.push(
      `${name} is no longer used: ${why}` +
        (asked?.(value) === true ? ` (it asked for ${describe(value)}; Soniox runs instead)` : ""),
    );
  }
  return { raw: out, warnings };
}

function describe(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : "the composer";
}

/** The config of an empty config.yaml: every default. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

/** Validate a raw config object (parsed YAML). Cross-field rules need the runtime context. */
export function parseConfig(input: unknown, ctx: ConfigContext): ParseResult {
  const { raw, warnings } = dropRemovedKeys(input ?? {});
  const result = ConfigSchema.safeParse(raw);
  const errors = result.success ? [] : formatIssues(result.error);
  const view: CrossFieldView = result.success
    ? { mode: result.data.mode, server: result.data.server }
    : lenientView(raw);
  errors.push(...crossFieldErrors(view, ctx));
  if (!result.success || errors.length > 0) return { ok: false, errors };
  return { ok: true, config: result.data, warnings };
}

function crossFieldErrors(view: CrossFieldView, ctx: ConfigContext): string[] {
  const errors: string[] = [];
  const { server } = view;

  if (view.mode === "hosted" && server.token !== "" && server.token.length < HOSTED_MIN_TOKEN) {
    errors.push(
      `server.token: use at least ${HOSTED_MIN_TOKEN} random characters on a hosted server (it opens every mosque's sessions), or leave it empty`,
    );
  }

  if (server.exposure === "public" && !server.trustProxy) {
    errors.push(
      'server.trustProxy: must be true when server.exposure is "public" (behind a proxy)',
    );
  }
  if (server.exposure === "local") {
    if (!ctx.inContainer && !isLoopbackHost(server.host)) {
      errors.push(
        `server.host: "${server.host}" is not loopback; use server.exposure "lan" to listen on the network`,
      );
    }
    if (ctx.bindAddress !== null && !isLoopbackHost(ctx.bindAddress)) {
      errors.push(
        `CAPTIONS_BIND: "${ctx.bindAddress}" publishes the server on the network; set server.exposure "lan"`,
      );
    }
  }
  return errors;
}

/**
 * Load a `.env` file into `env` (default process.env), if it exists. A variable that already has
 * a value is never overridden; an empty one counts as unset, because docker compose passes the
 * root .env's `KEY=` lines into the container as empty variables.
 */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(file)) return false;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (value !== undefined && (env[key] === undefined || env[key] === "")) env[key] = value;
  }
  return true;
}

/**
 * The .env files, in order: CONFIG_DIR/.env (where `turjuman setup` saves the keys) wins over
 * ./.env when CONFIG_DIR is set in the environment; otherwise ./.env comes first, since it may
 * set CONFIG_DIR itself. When both are one file it is read once.
 */
export function loadEnvFiles(env: NodeJS.ProcessEnv, cwd: string): void {
  const local = join(cwd, ".env");
  const explicit = nonEmpty(env.CONFIG_DIR) !== null;
  if (!explicit) loadDotEnv(local, env);
  const own = join(resolveDirs(env, cwd).configDir, ".env");
  if (resolve(own) !== resolve(local)) loadDotEnv(own, env);
  if (explicit) loadDotEnv(local, env);
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value !== "" ? value : null;
}

/** The folder the app runs from (the repository, or /app in the image; src/ and dist/ are one
 *  level down): its languages.yaml and glossaries/ are the defaults. */
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * A file of the config folder, or the app's own copy of a default one: a new CONFIG_DIR (an
 * empty folder) works without copying languages.yaml and glossaries/ into it first.
 */
function inConfigOrApp(configDir: string, value: string, defaultName: string): string {
  const resolved = resolveIn(configDir, value);
  if (value !== defaultName || existsSync(resolved)) return resolved;
  const own = join(APP_DIR, defaultName);
  return existsSync(own) ? own : resolved;
}

/**
 * A raw config with these server settings (SERVER_HOST, SERVER_PORT) in place. A value that is no
 * config (a list, a string, a server that is not a mapping) is left as it is: validation reports
 * it as it would without.
 */
function withServer(raw: unknown, fields: Record<string, unknown>): unknown {
  if (raw === null || raw === undefined) return { server: fields };
  if (!isRecord(raw)) return raw;
  const server = raw.server ?? {};
  return isRecord(server) ? { ...raw, server: { ...server, ...fields } } : raw;
}

/** A TCP port from the environment (1–65535), or null. */
function portNumber(value: string | undefined): number | null {
  const n = Number(nonEmpty(value) ?? Number.NaN);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Load config: `.env` and `<CONFIG_DIR>/.env` (when present), `<CONFIG_DIR>/config.yaml` (or an
 * explicit file), env overrides, validation, and path resolution against CONFIG_DIR / DATA_DIR.
 */
export function loadConfig(
  opts: { configFile?: string; env?: NodeJS.ProcessEnv; cwd?: string; create?: boolean } = {},
): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  if (opts.env === undefined) loadEnvFiles(env, cwd);

  const dirs = resolveDirs(env, cwd);
  const warnings: string[] = [];
  let configFile: string | null;
  let raw: unknown;
  const createdConfigFile =
    opts.create === true && opts.configFile === undefined ? ensureConfigFile(dirs.configDir) : null;

  if (opts.configFile !== undefined) {
    configFile = resolve(cwd, opts.configFile);
    if (!existsSync(configFile)) throw new Error(`Config file not found: ${configFile}`);
    raw = parse(readFileSync(configFile, "utf8"));
  } else {
    const candidate = join(dirs.configDir, "config.yaml");
    if (existsSync(candidate)) {
      configFile = candidate;
      raw = parse(readFileSync(candidate, "utf8"));
    } else {
      configFile = null;
      raw = {};
      warnings.push(
        `No config.yaml in ${dirs.configDir} yet; using the defaults (the server makes one when it starts)`,
      );
    }
  }

  // The environment can set where the server listens (Docker sets SERVER_HOST=0.0.0.0); a port
  // that is no port is reported by validation like one in config.yaml.
  const serverHost = nonEmpty(env.SERVER_HOST);
  if (serverHost !== null) raw = withServer(raw, { host: serverHost });
  const serverPort = nonEmpty(env.SERVER_PORT);
  if (serverPort !== null) raw = withServer(raw, { port: Number(serverPort) });

  const context: ConfigContext = {
    inContainer: env.CAPTIONS_CONTAINER === "1",
    bindAddress: nonEmpty(env.CAPTIONS_BIND),
    publishedPort: portNumber(env.CAPTIONS_HTTP_PORT),
    publishedHttpsPort: portNumber(env.CAPTIONS_HTTPS_PORT),
  };
  const result = parseConfig(raw, context);
  if (!result.ok) {
    throw new ValidationError(`Invalid config ${configFile ?? "(defaults)"}`, result.errors);
  }
  let config = result.config;
  warnings.push(...result.warnings);
  // A token set in config.yaml wins; else one is generated once and kept in CONFIG_DIR.
  let tokenFile: string | null = null;
  if (config.server.token === "" && needsToken(config)) {
    const file = join(dirs.configDir, TOKEN_FILE);
    try {
      config = { ...config, server: { ...config.server, token: generatedToken(file) } };
      tokenFile = file;
    } catch (err) {
      warnings.push(`No admin token: ${(err as Error).message}`);
    }
  }

  const paths: ResolvedPaths = {
    configDir: dirs.configDir,
    dataDir: dirs.dataDir,
    configFile,
    languagesFile: inConfigOrApp(dirs.configDir, config.languagesFile, "languages.yaml"),
    glossariesDir: inConfigOrApp(dirs.configDir, config.glossariesDir, "glossaries"),
    keysFile: join(dirs.configDir, "keys.yaml"),
    usersFile: join(dirs.configDir, "users.yaml"),
    screensFile: join(dirs.configDir, "screens.yaml"),
    secretFile: join(dirs.configDir, "secret.key"),
    orgsFile: join(dirs.configDir, "orgs.yaml"),
    masterKeyFile: join(dirs.configDir, "master.key"),
    tlsCertFile: resolveIn(dirs.configDir, config.server.https.certFile),
    tlsKeyFile: resolveIn(dirs.configDir, config.server.https.keyFile),
    tlsCaFile: resolveIn(dirs.configDir, config.server.https.caFile),
    transcriptsDir: resolveIn(dirs.dataDir, config.transcripts.dir),
    recordingsDir: join(dirs.dataDir, "recordings"),
    benchDir: join(dirs.dataDir, "bench"),
    stateDir: join(dirs.dataDir, "state"),
    usageDir: join(dirs.dataDir, "usage"),
    presetsFile: join(dirs.configDir, "presets.yaml"),
    quranDir: join(dirs.dataDir, "quran"),
    quranTextFile: resolveIn(dirs.dataDir, config.quran.textFile),
    quranUthmaniFile: resolveIn(dirs.dataDir, config.quran.uthmaniFile),
    quranTranslations: Object.fromEntries(
      Object.entries(config.quran.translations).map(([lang, file]) => [
        lang,
        resolveIn(dirs.dataDir, file),
      ]),
    ),
    exportsDir: join(dirs.dataDir, "exports"),
  };
  const secrets: Secrets = { sonioxApiKey: nonEmpty(env.SONIOX_API_KEY) };
  return { config, paths, secrets, warnings, context, tokenFile, createdConfigFile };
}

/** A copy of the loaded config that is safe to log: admin token and API keys are removed. */
export function redactConfig(loaded: LoadedConfig): unknown {
  const mark = (v: string | null): string | null => (v === null || v === "" ? v : "[redacted]");
  return {
    ...loaded,
    config: {
      ...loaded.config,
      server: { ...loaded.config.server, token: mark(loaded.config.server.token) },
    },
    secrets: { sonioxApiKey: mark(loaded.secrets.sonioxApiKey) },
  };
}
