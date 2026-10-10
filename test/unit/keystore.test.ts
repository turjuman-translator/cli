import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyStoreError, MasterKey } from "../../src/accounts/keystore.js";
import type { KeyProvider } from "../../src/shared/protocol.js";

const KEY = "sk-test-0123456789abcdefghij";

describe("encrypted key store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystore-"));
    file = join(dir, "master.key");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips, with a fresh IV every time and no plaintext in the value", () => {
    const master = new MasterKey(file, "");
    const a = master.encrypt("org1", "soniox", KEY);
    const b = master.encrypt("org1", "soniox", KEY);
    expect(a).toMatch(/^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(KEY);
    expect(master.decrypt("org1", "soniox", a)).toBe(KEY);
    expect(master.decrypt("org1", "soniox", b)).toBe(KEY);
  });

  it("binds a value to its organisation and provider", () => {
    const master = new MasterKey(file, "");
    const sealed = master.encrypt("org1", "soniox", KEY);
    expect(() => master.decrypt("org2", "soniox", sealed)).toThrow(KeyStoreError);
    // Another provider id (the binding is generic; Soniox is the only provider today).
    expect(() => master.decrypt("org1", "other" as KeyProvider, sealed)).toThrow(KeyStoreError);
  });

  it("refuses tampered and malformed values", () => {
    const master = new MasterKey(file, "");
    const sealed = master.encrypt("org1", "soniox", KEY);
    const [prefix1, prefix2, iv, tag, ct] = sealed.split(":");
    const flip = (s: string | undefined): string => {
      const buf = Buffer.from(s ?? "", "base64url");
      buf[0] = (buf[0] ?? 0) ^ 1;
      return buf.toString("base64url");
    };
    const join4 = (parts: Array<string | undefined>): string => parts.join(":");
    expect(() =>
      master.decrypt("org1", "soniox", join4([prefix1, prefix2, iv, tag, flip(ct)])),
    ).toThrow(KeyStoreError);
    expect(() =>
      master.decrypt("org1", "soniox", join4([prefix1, prefix2, iv, flip(tag), ct])),
    ).toThrow(KeyStoreError);
    expect(() => master.decrypt("org1", "soniox", "plain-text-key")).toThrow(KeyStoreError);
    expect(() => master.decrypt("org1", "soniox", "enc:v1:abc")).toThrow(KeyStoreError);
  });

  it("creates master.key (0600) when a key is first stored, never when reading", () => {
    const master = new MasterKey(file, "");
    expect(master.exists()).toBe(false);
    expect(() =>
      master.decrypt("org1", "soniox", "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA"),
    ).toThrow(/missing/);
    expect(existsSync(file)).toBe(false);
    master.encrypt("org1", "soniox", KEY);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a new master key makes stored values unreadable", () => {
    const sealed = new MasterKey(file, "").encrypt("org1", "soniox", KEY);
    rmSync(file);
    const next = new MasterKey(file, "");
    next.encrypt("org1", "soniox", "another-key-0123456789");
    expect(() => next.decrypt("org1", "soniox", sealed)).toThrow(KeyStoreError);
  });

  it("uses TURJUMAN_MASTER_KEY (base64 or base64url of 32 bytes) and rejects a weak one", () => {
    const raw = randomBytes(32);
    const fromEnv = new MasterKey(file, raw.toString("base64"));
    expect(fromEnv.source).toBe("env");
    const sealed = fromEnv.encrypt("org1", "soniox", KEY);
    expect(new MasterKey(file, raw.toString("base64url")).decrypt("org1", "soniox", sealed)).toBe(
      KEY,
    );
    expect(existsSync(file)).toBe(false);
    expect(() => new MasterKey(file, "too-short").encrypt("org1", "soniox", KEY)).toThrow(
      /32 random bytes/,
    );
  });

  it("rejects a master.key file that holds no 32-byte key", () => {
    writeFileSync(file, "not a key\n", { mode: 0o600 });
    expect(() => new MasterKey(file, "").encrypt("org1", "soniox", KEY)).toThrow(KeyStoreError);
  });
});
