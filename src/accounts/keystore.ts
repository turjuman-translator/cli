// Stored API keys are encrypted at rest: AES-256-GCM with a 32-byte master key
// from TURJUMAN_MASTER_KEY (base64 or base64url) or CONFIG_DIR/master.key (created with mode 0600
// the first time a key is stored, like secret.key). Each value is bound to its organisation and
// provider as additional authenticated data, so a ciphertext copied to another organisation or
// provider never decrypts. Losing the master key makes the stored keys unreadable (owners paste
// them again).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { addSecret } from "../log.js";
import { writeFileAtomic } from "../paths.js";
import type { KeyProvider } from "../shared/protocol.js";

export const MASTER_KEY_ENV = "TURJUMAN_MASTER_KEY";
const PREFIX = "enc:v1:";
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

function aad(orgId: string, provider: KeyProvider): Buffer {
  return Buffer.from(`turjuman:${orgId}:${provider}`, "utf8");
}

export class MasterKey {
  private cached: { key: Buffer; mtimeMs: number | null } | null = null;
  private readonly envValue: string;

  constructor(
    readonly file: string,
    envValue: string | undefined = process.env[MASTER_KEY_ENV],
  ) {
    this.envValue = (envValue ?? "").trim();
    addSecret(this.envValue);
  }

  get source(): "env" | "file" {
    return this.envValue !== "" ? "env" : "file";
  }

  /**
   * The 32 key bytes, re-read when master.key's mtime changes. `create`: make master.key when it
   * is missing (storing a key); decrypting never creates one. Throws KeyStoreError on a missing
   * or malformed key.
   */
  key(create = false): Buffer {
    if (this.envValue !== "") {
      if (this.cached === null) {
        this.cached = { key: decodeKey(this.envValue, MASTER_KEY_ENV), mtimeMs: null };
      }
      return this.cached.key;
    }
    let mtimeMs = mtime(this.file);
    if (this.cached !== null && mtimeMs !== null && this.cached.mtimeMs === mtimeMs) {
      return this.cached.key;
    }
    if (mtimeMs === null) {
      if (!create) throw new KeyStoreError(`the master key ${this.file} is missing`);
      this.createFile();
      mtimeMs = mtime(this.file);
    }
    const key = decodeKey(readFileSync(this.file, "utf8").trim(), this.file);
    this.cached = { key, mtimeMs };
    return key;
  }

  /** Whether a master key exists already (env set or the file present). */
  exists(): boolean {
    return this.envValue !== "" || existsSync(this.file);
  }

  encrypt(orgId: string, provider: KeyProvider, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(true), iv);
    cipher.setAAD(aad(orgId, provider));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
  }

  /** The plaintext; throws KeyStoreError for a malformed, tampered or foreign value. */
  decrypt(orgId: string, provider: KeyProvider, sealed: string): string {
    if (!sealed.startsWith(PREFIX)) throw new KeyStoreError("not an encrypted key");
    const parts = sealed.slice(PREFIX.length).split(":");
    if (parts.length !== 3) throw new KeyStoreError("malformed encrypted key");
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url"));
    if (
      iv === undefined ||
      tag === undefined ||
      ct === undefined ||
      iv.length !== 12 ||
      tag.length !== 16
    ) {
      throw new KeyStoreError("malformed encrypted key");
    }
    const key = this.key();
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad(orgId, provider));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      throw new KeyStoreError("the key cannot be decrypted (wrong master key or tampered value)");
    }
  }

  private createFile(): void {
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

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function decodeKey(text: string, where: string): Buffer {
  const key = B64.test(text)
    ? Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new KeyStoreError(
      `${where} must hold 32 random bytes in base64 (e.g. \`openssl rand -base64 32\`)`,
    );
  }
  return key;
}
