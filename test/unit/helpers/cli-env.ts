// Test helpers for the CLI commands: throwaway config folders (never the repository's config/ or
// .env), captured output and free ports.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadedConfig, loadConfig } from "../../../src/config.js";

const roots: string[] = [];

/** A new empty folder in the system temp folder, removed by `removeTempDirs()`. */
export function tempDir(prefix = "cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The repository's languages.yaml (the app's default list, not a secret). */
export const LANGUAGES_FILE = join(process.cwd(), "languages.yaml");

/**
 * A temp CONFIG_DIR (= DATA_DIR) with this config.yaml (languagesFile: the repository's, unless the
 * YAML names one), loaded the way the CLI loads it but with an environment of its own: nothing of
 * the caller's environment or .env files is read.
 */
export function configured(
  yaml = "",
  env: NodeJS.ProcessEnv = {},
): { dir: string; loaded: LoadedConfig } {
  const dir = tempDir();
  const languages = /^languagesFile:/m.test(yaml) ? "" : `languagesFile: ${LANGUAGES_FILE}\n`;
  writeFileSync(join(dir, "config.yaml"), `${languages}${yaml}`);
  const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir, ...env }, cwd: dir });
  return { dir, loaded };
}

export interface Captured {
  io: { out(text: string): void; err(text: string): void };
  out: string[];
  err: string[];
  /** Everything written to out, one entry per line of text. */
  text(): string;
  errText(): string;
  clear(): void;
}

export function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t) },
    out,
    err,
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

/**
 * Remember the process's signal listeners; the returned function removes every one added since.
 * Commands that wait for Ctrl-C listen on the test process itself: none of them may outlive a test
 * (a left-over SIGTERM listener would keep the test worker from being stopped).
 */
export function trackSignalListeners(): () => void {
  const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
  return () => {
    for (const s of SIGNALS) {
      for (const listener of process.listeners(s)) {
        if (!before.get(s)?.has(listener)) process.off(s, listener);
      }
    }
  };
}

/** A TCP port that is free right now on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
