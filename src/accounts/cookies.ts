// The portal login cookie: `captions_session=<payload>.<mac>`, where payload is
// base64url JSON {u: userId, v: sessionVersion, exp: unix seconds} and mac is base64url
// HMAC-SHA256(secret, "session:" + payload). Flags: HttpOnly; SameSite=Lax; Path=/; Max-Age;
// Secure on HTTPS. The Cookie header is parsed here (no cookie plugin). Cookies are never logged.
import { z } from "zod";
import { type SigningSecret, safeEqual } from "./secret.js";

export const SESSION_COOKIE = "captions_session";
const MAX_COOKIE_LENGTH = 512;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const PAYLOAD_RE = /^[A-Za-z0-9_-]{8,400}$/;

const ClaimsSchema = z.strictObject({
  u: z.string().min(1).max(64),
  v: z.number().int().min(0),
  exp: z.number().int().positive(),
});

export type SessionClaims = z.output<typeof ClaimsSchema>;

function mac(secret: SigningSecret, payload: string): string {
  return secret.sign(`session:${payload}`);
}

/** The signed cookie value for `claims`. */
export function signSession(secret: SigningSecret, claims: SessionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

/** The claims of a genuine, unexpired cookie value, or null. */
export function verifySession(
  secret: SigningSecret,
  value: string,
  nowSec: number,
): SessionClaims | null {
  if (value.length > MAX_COOKIE_LENGTH) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!PAYLOAD_RE.test(payload) || !MAC_RE.test(sig)) return null;
  if (!safeEqual(sig, mac(secret, payload))) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = ClaimsSchema.safeParse(raw);
  if (!claims.success || claims.data.exp <= nowSec) return null;
  return claims.data;
}

/** Every value of cookie `name` in a Cookie header (at most 4). */
export function readCookie(header: string | string[] | undefined, name: string): string[] {
  const text = Array.isArray(header) ? header.join("; ") : header;
  if (typeof text !== "string" || text === "") return [];
  const out: string[] = [];
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out.push(value);
    if (out.length >= 4) break;
  }
  return out;
}

/** Set-Cookie value for a login (`maxAgeSec` = accounts.sessionDays in seconds). */
export function loginCookie(value: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Set-Cookie value that removes the login cookie. */
export function logoutCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
