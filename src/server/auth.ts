// Admin token and viewer credentials for exposure lan|public: `Authorization: Bearer`, `?token=`
// or (viewers) `?key=`. Tokens are compared as SHA-256 digests with timingSafeEqual (equal
// lengths always).
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of a presented token with the configured one (empty never matches). */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (expected === "") return false;
  const ok = timingSafeEqual(digest(presented ?? ""), digest(expected));
  return ok && presented !== null && presented !== "";
}

function bearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m?.[1] ?? null;
}

function queryParam(req: FastifyRequest, name: string): string | null {
  const query = req.query;
  if (typeof query !== "object" || query === null) return null;
  const value = (query as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The token a request presents: Bearer header first, then `?token=`. */
export function presentedToken(req: FastifyRequest): string | null {
  return bearer(req) ?? queryParam(req, "token");
}

/**
 * Every credential a viewer request presents (Bearer, `?key=`, `?token=`), deduplicated; each is
 * tried as the admin token and as an access key.
 */
export function presentedCredentials(req: FastifyRequest): string[] {
  const all = [bearer(req), queryParam(req, "key"), queryParam(req, "token")];
  return [...new Set(all.filter((c): c is string => c !== null))];
}

/**
 * - "admin": the admin token, or the login cookie of an admin account;
 * - "viewer": a valid access key, the admin token or any login (archive page + its
 *   blocks/export APIs);
 * - "open": nothing (or the route checks for itself: the portal API).
 */
export type Access = "open" | "admin" | "viewer";

/** Read-only session history: live caption pages and the archive page use these with their key. */
// The archive page itself (/s/:sessionId) is open: it holds no data and shows a key form when
// its blocks API answers 401.
const VIEWER_ROUTES: ReadonlySet<string> = new Set([
  "/api/sessions/:id/blocks",
  "/api/sessions/:id/export.txt",
  "/api/sessions/:id/export.md",
  "/api/sessions/:id/export.srt",
]);

/** Public reads the open pages need. */
const OPEN_API_READS: ReadonlySet<string> = new Set(["/api/languages", "/api/presets"]);

/**
 * The portal API (/api/auth/*, /api/users*, /api/screens*, /api/settings) and the organisation
 * API (/api/org*): these routes check the login cookie or the admin token
 * themselves, in every exposure mode.
 */
export function isPortalRoute(route: string): boolean {
  return (
    route.startsWith("/api/auth/") ||
    route === "/api/users" ||
    route.startsWith("/api/users/") ||
    route === "/api/screens" ||
    route.startsWith("/api/screens/") ||
    route === "/api/settings" ||
    route === "/api/org" ||
    route.startsWith("/api/org/")
  );
}

/**
 * Which requests need credentials (only for exposure lan|public), decided on the matched route
 * pattern (`request.routeOptions.url`), never the raw URL, so percent-encoded paths cannot slip
 * past it:
 * - viewer: the blocks/export APIs (GET); the /s/:sessionId page itself is open (no data);
 * - admin: every other /api/* (GET /api/languages and GET /api/presets are open, the portal
 *   API checks for itself), /control, /customize; /overlay and /ws only with
 *   server.protectOverlay;
 * - everything else (/, /:from/:to, /login, /admin, /ws/page, /health, /assets, /fonts, 404s) is
 *   open: caption pages authenticate with access keys or screen links in their WebSocket
 *   hello instead; /admin and /login hold no data.
 *
 * Hosted mode applies these rules in every exposure, and "admin" there means
 * the server operator's admin token only (organisation admins log in to the portal and /app). The
 * look editor and its preset writes are the organisations' own (the routes check the login), and
 * /overlay and /ws (the server's local session) are the operator's.
 */
export function accessFor(method: string, route: string | undefined, config: Config): Access {
  const hosted = config.mode === "hosted";
  if ((config.server.exposure === "local" && !hosted) || route === undefined) return "open";
  const read = method === "GET" || method === "HEAD";
  if (read && OPEN_API_READS.has(route)) return "open";
  if (read && VIEWER_ROUTES.has(route)) return "viewer";
  if (isPortalRoute(route)) return "open";
  if (hosted && (route === "/api/presets" || route === "/api/presets/:id")) return "open";
  if (hosted && route === "/customize") return "open";
  if (route === "/api" || route.startsWith("/api/")) return "admin";
  if (route === "/control" || route === "/customize") return "admin";
  if (route === "/overlay" || route === "/ws") {
    return config.server.protectOverlay || hosted ? "admin" : "open";
  }
  return "open";
}
