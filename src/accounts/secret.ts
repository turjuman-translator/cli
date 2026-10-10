// The signing secret of login cookies: CAPTIONS_SECRET (env) or
// CONFIG_DIR/secret.key (32 random bytes, base64url), created with mode 0600 the first time it is
// needed. It is never logged. Deleting secret.key (or changing CAPTIONS_SECRET) rotates it: every
// login ends (screen feed links are GUIDs in screens.yaml and keep working).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../paths.js";

export const SECRET_ENV = "CAPTIONS_SECRET";
/** A CAPTIONS_SECRET shorter than this still works but is reported as weak. */
export const MIN_SECRET_LENGTH = 16;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Constant-time string comparison; strings of different length never match. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) {
    // Same amount of work as a real comparison, then a mismatch.
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export class SigningSecret {
  private cached: { key: Buffer; mtimeMs: number | null } | null = null;
  private readonly envValue: string;

  constructor(
    readonly file: string,
    envValue: string | undefined = process.env[SECRET_ENV],
  ) {
    this.envValue = (envValue ?? "").trim();
  }

  /** Where the secret comes from. */
  get source(): "env" | "file" {
    return this.envValue !== "" ? "env" : "file";
  }

  /** CAPTIONS_SECRET is set but short (worth a warning at startup). */
  get weak(): boolean {
    return this.envValue !== "" && this.envValue.length < MIN_SECRET_LENGTH;
  }

  /** The env value, for log scrubbing (empty when the file is used). */
  get envSecret(): string {
    return this.envValue;
  }

  /**
   * The key bytes. secret.key is created on first use and re-read when its mtime changes
   * (deleting it rotates the secret). Throws when the file exists but is not a valid secret.
   */
  key(): Buffer {
    if (this.envValue !== "") {
      if (this.cached === null)
        this.cached = { key: Buffer.from(this.envValue, "utf8"), mtimeMs: null };
      return this.cached.key;
    }
    let mtimeMs = this.mtime();
    if (this.cached !== null && mtimeMs !== null && this.cached.mtimeMs === mtimeMs) {
      return this.cached.key;
    }
    if (mtimeMs === null) {
      this.create();
      mtimeMs = this.mtime();
    }
    const text = readFileSync(this.file, "utf8").trim();
    const key = B64URL.test(text) ? Buffer.from(text, "base64url") : Buffer.alloc(0);
    if (key.length < 16) {
      throw new Error(
        `${this.file} is not a valid secret; delete it to create a new one ` +
          "(this signs everyone out and invalidates every screen link)",
      );
    }
    this.cached = { key, mtimeMs };
    return key;
  }

  /** base64url HMAC-SHA256 of `message` (43 characters). */
  sign(message: string): string {
    return createHmac("sha256", this.key()).update(message, "utf8").digest("base64url");
  }

  private mtime(): number | null {
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return null;
    }
  }

  private create(): void {
    if (existsSync(this.file)) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, `${randomBytes(32).toString("base64url")}\n`, 0o600);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // best effort (e.g. a filesystem without modes)
    }
  }
}
