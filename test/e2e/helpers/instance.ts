// A Turjuman install for one end-to-end test: its own folder in the system temp folder, used as
// CONFIG_DIR and as the working folder (so no `.env` of the repository is ever read), with
// DATA_DIR inside it, and an environment without the caller's API keys.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Instance {
  /** CONFIG_DIR and the working folder of every process the test starts. */
  dir: string;
  /** DATA_DIR. */
  dataDir: string;
  /** The environment for the binary. */
  env: NodeJS.ProcessEnv;
  /** Write CONFIG_DIR/config.yaml. */
  writeConfig(yaml: string): void;
  remove(): void;
}

/** Variables of the caller's shell that must never reach a test install. */
const DROPPED = /^(SONIOX_API_KEY|TURJUMAN_|CAPTIONS_|CONFIG_DIR$|DATA_DIR$|SERVER_HOST$|TOKEN$)/;

export function makeInstance(opts: { yaml?: string; env?: NodeJS.ProcessEnv } = {}): Instance {
  const dir = mkdtempSync(join(tmpdir(), "turjuman-e2e-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROPPED.test(k)) env[k] = v;
  // A server downloads missing Quran data by itself: in a test install, from a closed port on
  // this computer, never tanzil.net (a test that wants the data passes a fake Tanzil's URL).
  Object.assign(
    env,
    {
      CONFIG_DIR: dir,
      DATA_DIR: dataDir,
      NO_COLOR: "1",
      TURJUMAN_TANZIL_URL: "http://127.0.0.1:9",
    },
    opts.env,
  );
  const inst: Instance = {
    dir,
    dataDir,
    env,
    writeConfig: (yaml) => writeFileSync(join(dir, "config.yaml"), yaml),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
  if (opts.yaml !== undefined) inst.writeConfig(opts.yaml);
  return inst;
}

/** A TCP port that is free right now on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** A random token long enough for a hosted server's server.token (at least 24 characters). */
export function randomToken(): string {
  return randomBytes(18).toString("base64url");
}

/** A 16 kHz mono 16-bit WAV for the fake microphone: silence, or a tone loud enough to count as speech. */
export function writeWav(path: string, opts: { seconds: number; tone?: boolean }): string {
  const rate = 16_000;
  const samples = Math.round(opts.seconds * rate);
  const data = Buffer.alloc(samples * 2);
  if (opts.tone === true) {
    for (let i = 0; i < samples; i++) {
      data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 9000), i * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}
