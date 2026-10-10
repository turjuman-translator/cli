import { type Logger, type LoggerOptions as PinoOptions, pino, stdSerializers } from "pino";

const MIN_SECRET_LENGTH = 6;
const QUERY_SECRET = /([?&](?:key|token|api_key)=)[^&\s"'#]*/gi;
const JSON_API_KEY = /("api_key"\s*:\s*")[^"]*(")/g;

/** Secrets that became known at runtime (decrypted organisation keys). */
const runtimeSecrets = new Set<string>();
/** The same, per slot ("<org>:<provider>"): a new value replaces the slot's old one. */
const slotSecrets = new Map<string, string>();

/**
 * Scrub `value` from everything scrubSecrets() cleans from now on, in this process (every logger,
 * error reply and status line). For keys decrypted after startup. With a `slot`, the value
 * replaces that slot's previous one, so a key that is replaced or removed is no longer scrubbed
 * and the list cannot grow without bound.
 */
export function addSecret(value: string | null | undefined, slot?: string): void {
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
  if (slot === undefined) runtimeSecrets.add(value);
  else slotSecrets.set(slot, value);
}

/** Forget a slot's secret (its key was removed). */
export function removeSecret(slot: string): void {
  slotSecrets.delete(slot);
}

/**
 * Remove secrets from free text before it reaches logs, status (`lastError`, `lastStderr`)
 * or files: literal secret values (given, or added with addSecret), `key=` / `token=` /
 * `api_key=` parameters, and JSON `api_key` fields.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[redacted]");
  }
  for (const secret of runtimeSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  for (const secret of slotSecrets.values()) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out.replace(QUERY_SECRET, "$1[redacted]").replace(JSON_API_KEY, "$1[redacted]$2");
}

export interface LoggerOptions {
  /** Human-readable output (dev only; uses pino-pretty, a devDependency). */
  pretty: boolean;
  /** One short line per entry (terminalLine), for a person at a terminal; else JSON lines. */
  terminal?: boolean;
  level?: string;
  /** Literal secret values to scrub from every logged message. */
  secrets?: readonly string[];
}

const LEVELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info ",
  40: "warn ",
  50: "error",
  60: "fatal",
};
/** Fields every entry has, or that the line shows in its own way. */
const OMITTED = new Set(["level", "time", "pid", "hostname", "msg", "reqId", "req", "res"]);

function fieldText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const one = (text ?? "").replace(/\s+/g, " ");
  return one.length > 160 ? `${one.slice(0, 159)}…` : one;
}

/**
 * A JSON log line as one short line for a terminal: "12:04:31 info  portal: login user=imam".
 * Requests become one line when they complete ("GET /app 200 3 ms"; `requests` remembers the
 * method and URL of each incoming one); an error's stack follows on indented lines.
 */
export function terminalLine(json: string, requests: Map<unknown, string>): string | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return json.endsWith("\n") ? json.slice(0, -1) : json;
  }
  const req = entry.req as { method?: string; url?: string } | undefined;
  if (entry.msg === "incoming request" && req !== undefined) {
    if (requests.size > 1000) requests.clear();
    requests.set(entry.reqId, `${req.method ?? "?"} ${req.url ?? "?"}`);
    return null;
  }
  const time = new Date(typeof entry.time === "number" ? entry.time : Date.now());
  const clock = time.toTimeString().slice(0, 8);
  const level = LEVELS[Number(entry.level)] ?? String(entry.level);
  let msg = typeof entry.msg === "string" ? entry.msg : "";
  const res = entry.res as { statusCode?: number } | undefined;
  if (msg === "request completed" && res !== undefined) {
    const what = requests.get(entry.reqId) ?? "request";
    requests.delete(entry.reqId);
    const ms =
      typeof entry.responseTime === "number" ? ` ${Math.round(entry.responseTime)} ms` : "";
    return `${clock} ${level} ${what} ${res.statusCode ?? "?"}${ms}`;
  }
  const fields: string[] = [];
  let stack = "";
  for (const [key, value] of Object.entries(entry)) {
    if (OMITTED.has(key) || value === undefined) continue;
    if (key === "err" && typeof value === "object" && value !== null) {
      const err = value as { type?: string; message?: string; stack?: string };
      fields.push(`err=${fieldText(err.message ?? err.type ?? value)}`);
      if (Number(entry.level) >= 50 && typeof err.stack === "string") {
        // One indented line per frame (none for a stack that is only its header line).
        stack = err.stack
          .split("\n")
          .slice(1)
          .map((l) => `\n         ${l.trim()}`)
          .join("");
      }
      continue;
    }
    fields.push(`${key}=${fieldText(value)}`);
  }
  if (msg === "" && fields.length === 0) msg = "(empty)";
  return `${clock} ${level} ${msg}${fields.length > 0 ? ` ${fields.join(" ")}` : ""}${stack}`;
}

/** A pino destination that writes terminalLine()s to stdout. */
function terminalStream(): { write(line: string): void } {
  const requests = new Map<unknown, string>();
  return {
    write(line: string) {
      const text = terminalLine(line, requests);
      if (text !== null) process.stdout.write(`${text}\n`);
    },
  };
}

/** Root logger. JSON lines to stdout in production (terminalLine() at a terminal); pino-pretty
 *  only with `--dev`. */
export function createLogger(opts: LoggerOptions): Logger {
  const secrets = opts.secrets ?? [];
  const options: PinoOptions = {
    level: opts.level ?? "info",
    ...(opts.pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } }
      : {}),
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a: unknown) =>
          typeof a === "string" ? scrubSecrets(a, secrets) : a,
        );
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (err: unknown) => {
        // `{ err: "text" }` (or any non-Error) must not crash the logger.
        if (!(err instanceof Error)) {
          return typeof err === "string" ? scrubSecrets(err, secrets) : err;
        }
        const e = stdSerializers.err(err);
        return {
          ...e,
          message: scrubSecrets(e.message, secrets),
          stack: scrubSecrets(e.stack, secrets),
        };
      },
    },
  };
  return opts.terminal === true && !opts.pretty ? pino(options, terminalStream()) : pino(options);
}
