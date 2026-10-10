// Browser-side hardening: per-request CSP and security headers,
// the WebSocket Origin check, the DNS-rebinding Host guard (exposure local) and log redaction.
import type { FastifyReply, FastifyRequest } from "fastify";
import { isLoopbackHost } from "../config.js";

/** A Host / X-Forwarded-Host value that is safe to echo into a header. */
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** URL without its query string or fragment (request logs must never carry ?key= / ?token=). */
export function stripQuery(url: string | undefined): string {
  if (url === undefined) return "";
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * A request URL safe to log: no query string (`?key=`, `?screen=<guid>`) and no feed GUID in a
 * `/feed/<guid>` path (the GUID is the feed's key).
 */
export function logUrl(url: string | undefined): string {
  return stripQuery(url).replace(/^\/feed\/[^/]+/, "/feed/[guid]");
}

/** The host:port the browser used, or null when it is missing or malformed. */
export function safeHost(host: string | undefined): string | null {
  return host !== undefined && SAFE_HOST.test(host) ? host.toLowerCase() : null;
}

/** Content-Security-Policy for our pages: self only, no inline code. */
export function contentSecurityPolicy(host: string | null): string {
  const ws = host === null ? "" : ` ws://${host} wss://${host}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self'${ws}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** Security headers for every HTML response; HTML is never cached. */
export function applyHtmlHeaders(req: FastifyRequest, reply: FastifyReply): void {
  reply.header("Content-Security-Policy", contentSecurityPolicy(safeHost(req.host)));
  reply.header("Permissions-Policy", "microphone=(self)");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Cache-Control", "no-store");
}

/** Normalised origin (scheme://host[:port], default ports dropped), or null if unparsable. */
export function normaliseOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export type OriginCheck = { ok: true } | { ok: false; reason: string };

/**
 * WebSocket upgrade Origin check: the Origin must be the page's own origin
 * (request.protocol/host, which honour X-Forwarded-Proto/-Host only when trustProxy is on) or
 * be listed in pages.allowedOrigins. A missing Origin (non-browser client) is allowed: the
 * check exists to stop other websites from opening sockets in a visitor's browser.
 */
export function checkOrigin(req: FastifyRequest, allowedOrigins: readonly string[]): OriginCheck {
  const header = req.headers.origin;
  if (header === undefined || header === "") return { ok: true };
  if (allowedOrigins.includes(header)) return { ok: true };
  const origin = normaliseOrigin(header);
  if (origin === null) return { ok: false, reason: `Origin "${header}" is not allowed` };
  if (allowedOrigins.some((o) => normaliseOrigin(o) === origin)) return { ok: true };
  const host = safeHost(req.host);
  const own = host === null ? null : normaliseOrigin(`${req.protocol}://${host}`);
  if (own !== null && own === origin) return { ok: true };
  return {
    ok: false,
    reason: `Origin ${origin} is not allowed (same origin only; see pages.allowedOrigins)`,
  };
}

function hostname(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * DNS-rebinding guard for exposure "local": the Host header must name this machine
 * (localhost, 127.x, [::1]) or the configured server.host; any port.
 */
export function isAllowedLocalHost(hostHeader: string | undefined, serverHost: string): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  const name = hostname(hostHeader);
  if (isLoopbackHost(name)) return true;
  const configured = serverHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return name.replace(/^\[|\]$/g, "") === configured;
}
