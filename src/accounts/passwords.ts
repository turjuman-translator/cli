// Portal passwords: scrypt N=16384, r=8, p=1 with a 16-byte salt, stored as
// `scrypt$16384$8$1$<salt>$<hash>` (base64url). Verification is constant-time; an unknown
// username costs the same as a wrong password. Passwords are never logged.
import {
  type BinaryLike,
  randomBytes,
  randomInt,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const STORED =
  /^scrypt\$(\d{1,8})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9_-]{16,128})\$([A-Za-z0-9_-]{16,256})$/;
const DUMMY_SALT = randomBytes(SALT_BYTES);
/** No 0/O, 1/l/I: easy to read aloud and to type from a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const scryptAsync = promisify<BinaryLike, BinaryLike, number, ScryptOptions, Buffer>(scrypt);

function derive(
  password: string,
  salt: Buffer,
  params: { n: number; r: number; p: number },
  length: number,
): Promise<Buffer> {
  return scryptAsync(password.normalize("NFC"), salt, length, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.n * params.r + 128 * params.r * params.p + (1 << 20),
  });
}

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password needs at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password is too long (${MAX_PASSWORD_LENGTH} characters at most)`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, { n: N, r: R, p: P }, KEY_BYTES);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Constant-time check of a password against a stored hash (false for malformed hashes). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const m = STORED.exec(stored);
  const n = Number(m?.[1]);
  const r = Number(m?.[2]);
  const p = Number(m?.[3]);
  const sane =
    m !== null &&
    n >= 1024 &&
    n <= 1 << 16 &&
    (n & (n - 1)) === 0 &&
    r >= 1 &&
    r <= 16 &&
    // OpenSSL refuses N >= 2^(16·r) (N = 65536 with r = 1): scrypt would throw.
    n < 2 ** (16 * r) &&
    p >= 1 &&
    p <= 4;
  if (!sane) {
    await dummyVerify(password);
    return false;
  }
  const salt = Buffer.from(m[4] ?? "", "base64url");
  const expected = Buffer.from(m[5] ?? "", "base64url");
  if (expected.length < 16 || expected.length > 128) {
    await dummyVerify(password);
    return false;
  }
  const actual = await derive(password, salt, { n, r, p }, expected.length);
  return timingSafeEqual(actual, expected);
}

/** Spend the time of a real check (unknown usernames must not answer faster). */
export async function dummyVerify(password: string): Promise<void> {
  await derive(password.slice(0, MAX_PASSWORD_LENGTH), DUMMY_SALT, { n: N, r: R, p: P }, KEY_BYTES);
}

/** A random password (default 16 characters, ~94 bits). */
export function generatePassword(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET.charAt(randomInt(ALPHABET.length));
  return out;
}
