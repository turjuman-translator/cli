import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loginCookie,
  logoutCookie,
  readCookie,
  SESSION_COOKIE,
  signSession,
  verifySession,
} from "../../src/accounts/cookies.js";
import { SigningSecret } from "../../src/accounts/secret.js";

const NOW = 1_790_000_000;
const claims = { u: "u1abc", v: 3, exp: NOW + 3600 };

/** A cookie value with a genuine signature over any payload text. */
function signed(secret: SigningSecret, payloadText: string): string {
  const payload = Buffer.from(payloadText, "utf8").toString("base64url");
  return `${payload}.${secret.sign(`session:${payload}`)}`;
}

describe("login cookies", () => {
  let dir: string;
  let secret: SigningSecret;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cookies-"));
    secret = new SigningSecret(join(dir, "secret.key"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips the claims of a signed cookie until it expires", () => {
    const value = signSession(secret, claims);
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifySession(secret, value, NOW)).toEqual(claims);
    expect(verifySession(secret, value, NOW + 3599)).toEqual(claims);
    expect(verifySession(secret, value, NOW + 3600)).toBeNull();
  });

  it("refuses a cookie signed with another secret (a rotated secret.key ends every login)", () => {
    const value = signSession(secret, claims);
    const other = new SigningSecret(join(dir, "other.key"), "");
    expect(verifySession(other, value, NOW)).toBeNull();
  });

  it("refuses tampered, malformed and oversized values", () => {
    const value = signSession(secret, claims);
    const [payload, mac] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, u: "admin" })).toString("base64url");
    for (const bad of [
      "",
      "no-dot-at-all",
      `.${mac}`,
      `${forged}.${mac}`,
      `${payload}.${(mac ?? "").slice(0, 42)}`,
      `${payload}.${(mac ?? "").replace(/^./, (c) => (c === "A" ? "B" : "A"))}`,
      `ab.${mac}`, // payload shorter than 8 characters
      `${payload}!.${mac}`,
      `${"A".repeat(500)}.${mac}`, // longer than 512 characters altogether
    ]) {
      expect(verifySession(secret, bad, NOW), bad).toBeNull();
    }
  });

  it("refuses a genuinely signed payload that is not JSON or not session claims", () => {
    expect(verifySession(secret, signed(secret, "not json at all"), NOW)).toBeNull();
    expect(verifySession(secret, signed(secret, JSON.stringify({ u: "x", v: 1 })), NOW)).toBeNull();
    expect(
      verifySession(secret, signed(secret, JSON.stringify({ ...claims, role: "owner" })), NOW),
    ).toBeNull();
    expect(
      verifySession(secret, signed(secret, JSON.stringify({ ...claims, v: -1 })), NOW),
    ).toBeNull();
    // The same text, as proper claims, is accepted: only the content was wrong above.
    expect(verifySession(secret, signed(secret, JSON.stringify(claims)), NOW)).toEqual(claims);
  });

  it("reads every value of the cookie from one or more Cookie headers (at most 4)", () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toEqual([]);
    expect(readCookie("", SESSION_COOKIE)).toEqual([]);
    expect(readCookie("theme=dark; flag", SESSION_COOKIE)).toEqual([]);
    expect(readCookie(`theme=dark; ${SESSION_COOKIE}=abc.def; x=1`, SESSION_COOKIE)).toEqual([
      "abc.def",
    ]);
    expect(
      readCookie([`${SESSION_COOKIE}=one`, `a=b; ${SESSION_COOKIE}=two`], SESSION_COOKIE),
    ).toEqual(["one", "two"]);
    // Quoted values are unquoted; a lone quote is kept as it is.
    expect(readCookie(`${SESSION_COOKIE}="abc"; ${SESSION_COOKIE}="`, SESSION_COOKIE)).toEqual([
      "abc",
      '"',
    ]);
    const many = Array.from({ length: 6 }, (_, i) => `${SESSION_COOKIE}=v${i}`).join("; ");
    expect(readCookie(many, SESSION_COOKIE)).toEqual(["v0", "v1", "v2", "v3"]);
    // A cookie whose name only starts the same is another cookie.
    expect(readCookie(`${SESSION_COOKIE}_old=zzz`, SESSION_COOKIE)).toEqual([]);
  });

  it("sets and clears the cookie with HttpOnly, SameSite=Lax and Secure on HTTPS", () => {
    expect(loginCookie("v.m", 2_592_000, false)).toBe(
      "captions_session=v.m; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(loginCookie("v.m", 60, true)).toBe(
      "captions_session=v.m; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
    expect(logoutCookie(false)).toBe(
      "captions_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(logoutCookie(true)).toBe(
      "captions_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
  });
});
