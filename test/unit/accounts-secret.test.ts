import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIN_SECRET_LENGTH,
  SECRET_ENV,
  SigningSecret,
  safeEqual,
} from "../../src/accounts/secret.js";

describe("safeEqual", () => {
  it("matches equal strings only, also when the lengths differ", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("é", "e")).toBe(false);
  });
});

describe("the signing secret of login cookies", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-"));
    file = join(dir, "config", "secret.key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates secret.key (0600, 32 random bytes) on first use, in a new folder", () => {
    const secret = new SigningSecret(file, "");
    expect(secret.source).toBe("file");
    expect(secret.envSecret).toBe("");
    expect(secret.weak).toBe(false);
    expect(existsSync(file)).toBe(false);
    const mac = secret.sign("session:abc");
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(file, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // The same secret signs the same way, also from another instance (another process).
    expect(secret.sign("session:abc")).toBe(mac);
    expect(new SigningSecret(file, "").sign("session:abc")).toBe(mac);
  });

  it("deleting secret.key rotates the secret", () => {
    const secret = new SigningSecret(file, "");
    const before = secret.sign("message");
    rmSync(file);
    const after = secret.sign("message");
    expect(after).not.toBe(before);
    expect(existsSync(file)).toBe(true);
  });

  it("re-reads secret.key when it changes on disk", () => {
    const secret = new SigningSecret(file, "");
    const before = secret.sign("message");
    writeFileSync(file, `${Buffer.alloc(32, 7).toString("base64url")}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(secret.sign("message")).not.toBe(before);
    expect(secret.sign("message")).toBe(new SigningSecret(file, "").sign("message"));
  });

  it("refuses a secret.key that is not a valid secret, and says how to fix it", () => {
    writeFileSync(join(dir, "short.key"), "abc\n");
    expect(() => new SigningSecret(join(dir, "short.key"), "").sign("m")).toThrow(
      /short\.key is not a valid secret; delete it to create a new one/,
    );
    writeFileSync(join(dir, "junk.key"), "not base64url at all!\n");
    expect(() => new SigningSecret(join(dir, "junk.key"), "").key()).toThrow(/not a valid secret/);
  });

  it("uses CAPTIONS_SECRET from the environment (no file), and calls a short one weak", () => {
    const strong = new SigningSecret(file, `  ${"s".repeat(MIN_SECRET_LENGTH)}  `);
    expect(strong.source).toBe("env");
    expect(strong.weak).toBe(false);
    expect(strong.envSecret).toBe("s".repeat(MIN_SECRET_LENGTH));
    expect(strong.key()).toEqual(Buffer.from("s".repeat(MIN_SECRET_LENGTH), "utf8"));
    expect(strong.key()).toBe(strong.key());
    expect(strong.sign("m")).toBe(new SigningSecret(file, "s".repeat(MIN_SECRET_LENGTH)).sign("m"));
    expect(existsSync(file)).toBe(false);
    const weak = new SigningSecret(file, "short");
    expect(weak.weak).toBe(true);
    expect(weak.sign("m")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("reads CAPTIONS_SECRET from process.env when no value is given", () => {
    vi.stubEnv(SECRET_ENV, "from-the-environment-0123456789");
    expect(new SigningSecret(file).source).toBe("env");
    expect(new SigningSecret(file).envSecret).toBe("from-the-environment-0123456789");
    vi.stubEnv(SECRET_ENV, undefined);
    expect(new SigningSecret(file).source).toBe("file");
  });
});
