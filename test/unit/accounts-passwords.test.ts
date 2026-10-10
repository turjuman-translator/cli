import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dummyVerify,
  generatePassword,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  verifyPassword,
} from "../../src/accounts/passwords.js";

const b64 = (bytes: number): string => randomBytes(bytes).toString("base64url");

describe("portal passwords", () => {
  it("asks for 8 to 256 characters", () => {
    expect(passwordProblem("short")).toBe("The password needs at least 8 characters");
    expect(passwordProblem("x".repeat(257))).toBe(
      "The password is too long (256 characters at most)",
    );
    expect(passwordProblem("eight ch")).toBeNull();
    expect(passwordProblem("x".repeat(256))).toBeNull();
  });

  it("stores a salted scrypt hash that only the right password matches", async () => {
    const a = await hashPassword("bismillah-2026");
    const b = await hashPassword("bismillah-2026");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("bismillah");
    expect(await verifyPassword("bismillah-2026", a)).toBe(true);
    expect(await verifyPassword("bismillah-2026", b)).toBe(true);
    expect(await verifyPassword("Bismillah-2026", a)).toBe(false);
  });

  it("treats the composed and decomposed forms of a letter as the same password", async () => {
    const stored = await hashPassword("café-mosque");
    expect(await verifyPassword("café-mosque", stored)).toBe(true);
  });

  it("refuses a password longer than 256 characters without hashing it", async () => {
    const stored = await hashPassword("x".repeat(MAX_PASSWORD_LENGTH));
    expect(await verifyPassword("x".repeat(MAX_PASSWORD_LENGTH), stored)).toBe(true);
    expect(await verifyPassword("x".repeat(MAX_PASSWORD_LENGTH + 1), stored)).toBe(false);
  });

  it("answers false (never throws) for malformed or unsafe stored hashes", async () => {
    const salt = b64(16);
    const hash = b64(32);
    for (const stored of [
      "",
      "plain-text-password",
      `bcrypt$16384$8$1$${salt}$${hash}`,
      `scrypt$16384$8$1$${salt}`,
      `scrypt$512$8$1$${salt}$${hash}`, // N too small
      `scrypt$131072$8$1$${salt}$${hash}`, // N too large
      `scrypt$10000$8$1$${salt}$${hash}`, // N not a power of two
      `scrypt$16384$0$1$${salt}$${hash}`,
      `scrypt$16384$17$1$${salt}$${hash}`,
      `scrypt$16384$8$0$${salt}$${hash}`,
      `scrypt$16384$8$5$${salt}$${hash}`,
      `scrypt$16384$8$1$${salt}$${b64(12)}`, // a 12-byte hash
      `scrypt$16384$8$1$${salt}$${b64(192)}`, // a 192-byte hash
    ]) {
      expect(await verifyPassword("bismillah-2026", stored), stored).toBe(false);
    }
  });

  it("answers false for parameters scrypt itself refuses (N = 65536 with r = 1)", async () => {
    // Within the accepted ranges, but OpenSSL needs N < 2^(16·r): before the fix the check threw
    // ERR_CRYPTO_INVALID_SCRYPT_PARAMS, so a hand-edited users.yaml turned a login into a 500.
    const stored = `scrypt$65536$1$1$${b64(16)}$${b64(32)}`;
    await expect(verifyPassword("bismillah-2026", stored)).resolves.toBe(false);
    // The largest parameters that do run are still accepted.
    const salt = randomBytes(16);
    const key = scryptSync("bismillah-2026", salt, 32, {
      N: 65536,
      r: 2,
      p: 1,
      maxmem: 256 * 65536 * 2 + (1 << 21),
    });
    const strong = `scrypt$65536$2$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("bismillah-2026", strong)).toBe(true);
  });

  it("dummyVerify spends a real scrypt run (also on a very long password) and resolves", async () => {
    await expect(dummyVerify("whatever")).resolves.toBeUndefined();
    await expect(dummyVerify("x".repeat(10_000))).resolves.toBeUndefined();
  });

  it("generates readable random passwords: 16 characters by default, no 0/O/1/l/I", () => {
    const one = generatePassword();
    expect(one).toHaveLength(16);
    expect(generatePassword(24)).toHaveLength(24);
    expect(generatePassword(0)).toBe("");
    const many = Array.from({ length: 50 }, () => generatePassword()).join("");
    expect(many).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });
});
