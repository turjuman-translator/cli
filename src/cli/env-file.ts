// The `.env` file that `turjuman setup` writes: CONFIG_DIR/.env, the working
// directory unless CONFIG_DIR is set. It is read with Node's own parser (the one
// process.loadEnvFile uses), and an update changes only the given keys: every other line, comment
// and blank line stays as it was. Writes are atomic (temp file + rename) with mode 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { resolveDirs, writeFileAtomic } from "../paths.js";

/** `NAME=value`, optionally `export NAME=value`; group 1 keeps the indent and `export `. */
const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
/** Values that need no quotes in Node, docker compose and shells alike. */
const BARE = /^[A-Za-z0-9_\-.:/+=,@%]*$/;

/** The CONFIG_DIR/.env that setup writes and `turjuman start` reads. */
export function configEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return join(resolveDirs(env, cwd).configDir, ".env");
}

/** The variables of a .env file as the server reads them; {} when there is no file. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Copy a .env file's variables into `env`; variables that have a value already win, and an empty
 * one counts as unset (docker compose passes empty `KEY=` lines as empty variables).
 */
export function loadEnvInto(file: string, env: NodeJS.ProcessEnv): boolean {
  if (!existsSync(file)) return false;
  for (const [key, value] of Object.entries(readEnvFile(file))) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
  return true;
}

/** A value as .env text: bare when that is safe, otherwise quoted so it reads back unchanged. */
export function envValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("a .env value must be a single line");
  if (BARE.test(value)) return value;
  // Single quotes are literal for Node and docker compose (no $ interpolation, no escapes).
  if (!value.includes("'")) return `'${value}'`;
  if (!/["\\$`]/.test(value)) return `"${value}"`;
  throw new Error("this value mixes quote characters; a .env file cannot hold it safely");
}

interface Entry {
  /** The assignment's lines (a quoted value may span several), or one other line. */
  lines: string[];
  key: string | null;
  /** Indent and `export ` of an assignment. */
  prefix: string;
}

/** Split .env text into assignments and other lines, reading quoted values the way Node does. */
function entries(text: string): Entry[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = ASSIGNMENT.exec(line);
    if (m === null) {
      out.push({ lines: [line], key: null, prefix: "" });
      continue;
    }
    const value = m[3] ?? "";
    const quote = value[0];
    const span = [line];
    if ((quote === '"' || quote === "'" || quote === "`") && !value.slice(1).includes(quote)) {
      // An open quote runs on to the line that closes it; without one it ends at this line.
      let end = i + 1;
      while (end < lines.length && !(lines[end] ?? "").includes(quote)) end++;
      if (end < lines.length) {
        span.push(...lines.slice(i + 1, end + 1));
        i = end;
      }
    }
    out.push({ lines: span, key: m[2] ?? null, prefix: m[1] ?? "" });
  }
  return out;
}

/**
 * `text` with every key of `updates` set: the first assignment of a key is replaced where it is
 * (later ones are dropped, so the new value is the one that counts) and missing keys are added
 * at the end. Every other line is kept, with the file's line endings.
 */
export function mergeEnv(text: string, updates: Readonly<Record<string, string>>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const done = new Set<string>();
  const out: string[] = [];
  for (const entry of entries(text)) {
    const key = entry.key;
    if (key === null || !Object.hasOwn(updates, key)) {
      out.push(...entry.lines);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    out.push(`${entry.prefix}${key}=${envValue(updates[key] ?? "")}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!done.has(key)) out.push(`${key}=${envValue(value)}`);
  }
  return out.length === 0 ? "" : `${out.join(eol)}${eol}`;
}

/**
 * Create or update a .env file: only the keys in `updates` change. A new file starts with
 * `header`. Atomic (temp file in the same folder, then rename) and always mode 0600; a symlinked
 * .env is updated where it points.
 */
export function writeEnvFile(
  file: string,
  updates: Readonly<Record<string, string>>,
  header = "",
): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const before = existsSync(target) ? readFileSync(target, "utf8") : header;
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, mergeEnv(before, updates), 0o600);
  // The umask can only have removed bits; set exactly owner read/write.
  chmodSync(target, 0o600);
}
