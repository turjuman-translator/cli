import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Where user-editable config lives (CONFIG_DIR) and where runtime data goes (DATA_DIR). */
export interface Dirs {
  configDir: string;
  dataDir: string;
}

/** Resolve CONFIG_DIR / DATA_DIR. Both default to the working directory. */
export function resolveDirs(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): Dirs {
  const pick = (value: string | undefined): string =>
    value !== undefined && value !== "" ? resolve(cwd, value) : resolve(cwd);
  return { configDir: pick(env.CONFIG_DIR), dataDir: pick(env.DATA_DIR) };
}

/** Resolve `p` against `base` unless it is already absolute. */
export function resolveIn(base: string, p: string): string {
  return isAbsolute(p) ? p : join(base, p);
}

/**
 * Write a file atomically: temp file in the same directory, fsync, then rename.
 * The temp file must live in the same directory so the rename never crosses a mount.
 * Use mode 0o600 for files holding secrets (keys.yaml).
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o644): void {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Create `file` (and its folder) with `data` unless it exists: an existing file is never
 * overwritten, also when two processes try at once. True when this call created it.
 */
export function createFileOnce(file: string, data: string, mode = 0o644): boolean {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, data, { flag: "wx", mode });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
