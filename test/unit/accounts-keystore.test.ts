import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyStoreError, MASTER_KEY_ENV, MasterKey } from "../../src/accounts/keystore.js";
import { scrubSecrets } from "../../src/log.js";

const KEY = "sk-test-0123456789abcdefghij";
const b64u = (bytes: number): string => Buffer.alloc(bytes, 1).toString("base64url");

describe("the master key of stored API keys", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "master-"));
    file = join(dir, "config", "master.key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates master.key in a folder that does not exist yet", () => {
    const master = new MasterKey(file, "");
    expect(master.source).toBe("file");
    expect(master.exists()).toBe(false);
    const sealed = master.encrypt("org1", "soniox", KEY);
    expect(master.exists()).toBe(true);
    expect(new MasterKey(file, "").decrypt("org1", "soniox", sealed)).toBe(KEY);
  });

  it("re-reads master.key when it is replaced on disk", () => {
    const master = new MasterKey(file, "");
    const sealed = master.encrypt("org1", "soniox", KEY);
    expect(master.decrypt("org1", "soniox", sealed)).toBe(KEY);
    writeFileSync(file, `${randomBytes(32).toString("base64")}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(() => master.decrypt("org1", "soniox", sealed)).toThrow(
      "the key cannot be decrypted (wrong master key or tampered value)",
    );
  });

  it("keeps using TURJUMAN_MASTER_KEY (decoded once) and never writes master.key", () => {
    const env = randomBytes(32).toString("base64url");
    const master = new MasterKey(file, `  ${env}\n`);
    expect(master.source).toBe("env");
    expect(master.exists()).toBe(true);
    const a = master.encrypt("org1", "soniox", KEY);
    const b = master.encrypt("org2", "soniox", KEY);
    expect(master.decrypt("org1", "soniox", a)).toBe(KEY);
    expect(master.decrypt("org2", "soniox", b)).toBe(KEY);
    expect(existsSync(file)).toBe(false);
    // The variable's value is scrubbed from logs from now on.
    expect(scrubSecrets(`master=${env}`, [])).toBe("master=[redacted]");
  });

  it("reads TURJUMAN_MASTER_KEY from process.env when no value is given", () => {
    const env = randomBytes(32).toString("base64");
    vi.stubEnv(MASTER_KEY_ENV, env);
    const sealed = new MasterKey(file).encrypt("org1", "soniox", KEY);
    expect(new MasterKey(file, env).decrypt("org1", "soniox", sealed)).toBe(KEY);
    vi.stubEnv(MASTER_KEY_ENV, undefined);
    expect(new MasterKey(file).source).toBe("file");
  });

  it("names the variable or the file when the key is not 32 bytes of base64", () => {
    expect(() => new MasterKey(file, b64u(16)).key()).toThrow(
      `${MASTER_KEY_ENV} must hold 32 random bytes in base64 (e.g. \`openssl rand -base64 32\`)`,
    );
    expect(() => new MasterKey(file, "not base64 at all!").key()).toThrow(KeyStoreError);
    const master = new MasterKey(file, "");
    master.encrypt("org1", "soniox", KEY);
    writeFileSync(file, `${b64u(31)}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(() => master.key()).toThrow(`${file} must hold 32 random bytes in base64`);
  });

  it("refuses a value whose IV or tag has the wrong length", () => {
    const master = new MasterKey(file, "");
    const sealed = master.encrypt("org1", "soniox", KEY);
    const [, , , tag, ct] = sealed.split(":");
    const iv = randomBytes(12).toString("base64url");
    expect(() => master.decrypt("org1", "soniox", `enc:v1:${b64u(8)}:${tag}:${ct}`)).toThrow(
      "malformed encrypted key",
    );
    expect(() => master.decrypt("org1", "soniox", `enc:v1:${iv}:${b64u(15)}:${ct}`)).toThrow(
      "malformed encrypted key",
    );
    expect(() => master.decrypt("org1", "soniox", `enc:v1:${iv}:${tag}:${ct}:extra`)).toThrow(
      "malformed encrypted key",
    );
    expect(() => master.decrypt("org1", "soniox", KEY)).toThrow("not an encrypted key");
  });
});
