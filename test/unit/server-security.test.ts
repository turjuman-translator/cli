import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { type Config, parseConfig } from "../../src/config.js";
import {
  accessFor,
  isPortalRoute,
  presentedCredentials,
  presentedToken,
  tokenMatches,
} from "../../src/server/auth.js";
import {
  applyHtmlHeaders,
  checkOrigin,
  contentSecurityPolicy,
  isAllowedLocalHost,
  logUrl,
  normaliseOrigin,
  safeHost,
  stripQuery,
} from "../../src/server/security.js";

function config(raw: Record<string, unknown>): Config {
  const result = parseConfig(raw, { inContainer: false, bindAddress: null });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.config;
}

function request(opts: {
  authorization?: string;
  query?: unknown;
  origin?: string;
  host?: string;
  protocol?: string;
}): FastifyRequest {
  return {
    headers: {
      ...(opts.authorization === undefined ? {} : { authorization: opts.authorization }),
      ...(opts.origin === undefined ? {} : { origin: opts.origin }),
    },
    query: opts.query,
    host: opts.host ?? "127.0.0.1:8765",
    protocol: opts.protocol ?? "http",
  } as unknown as FastifyRequest;
}

describe("server security helpers", () => {
  it("drops query strings and feed GUIDs from logged URLs", () => {
    expect(stripQuery(undefined)).toBe("");
    expect(stripQuery("/ar/nl?key=secret")).toBe("/ar/nl");
    expect(stripQuery("/page#frag?x")).toBe("/page");
    expect(stripQuery("/plain")).toBe("/plain");
    expect(logUrl(undefined)).toBe("");
    expect(logUrl("/feed/1b4e28ba-2fa1-11d2-883f-0016d3cca427?debug=1")).toBe("/feed/[guid]");
    expect(logUrl("/feed/abc/more")).toBe("/feed/[guid]/more");
    expect(logUrl("/api/sessions?token=t")).toBe("/api/sessions");
  });

  it("accepts only well-formed hosts, lower-cased", () => {
    expect(safeHost(undefined)).toBeNull();
    expect(safeHost("Mosque.Example:8080")).toBe("mosque.example:8080");
    expect(safeHost("[::1]:8765")).toBe("[::1]:8765");
    expect(safeHost('evil.test"><script>')).toBeNull();
    expect(safeHost("a b")).toBeNull();
  });

  it("builds a self-only CSP that allows the page's own WebSocket host", () => {
    const csp = contentSecurityPolicy("mosque.lan:8765");
    expect(csp).toContain("connect-src 'self' ws://mosque.lan:8765 wss://mosque.lan:8765");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(contentSecurityPolicy(null)).toContain("connect-src 'self';");
  });

  it("sets the page headers, without a WebSocket host when the Host header is malformed", () => {
    const headers = new Map<string, string>();
    const reply = {
      header(name: string, value: string) {
        headers.set(name, value);
        return reply;
      },
    } as unknown as FastifyReply;
    applyHtmlHeaders(request({ host: "bad host" }), reply);
    expect(headers.get("Content-Security-Policy")).toContain("connect-src 'self';");
    expect(headers.get("Permissions-Policy")).toBe("microphone=(self)");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cache-Control")).toBe("no-store");
  });

  it("normalises http(s) origins and refuses everything else", () => {
    expect(normaliseOrigin("https://Mosque.Example:443/path")).toBe("https://mosque.example");
    expect(normaliseOrigin("http://a.test:8080")).toBe("http://a.test:8080");
    expect(normaliseOrigin("ftp://a.test")).toBeNull();
    expect(normaliseOrigin("not a url")).toBeNull();
  });

  it("allows a WebSocket from the page's own origin or a listed one only", () => {
    expect(checkOrigin(request({}), [])).toEqual({ ok: true });
    expect(checkOrigin(request({ origin: "" }), [])).toEqual({ ok: true });
    expect(checkOrigin(request({ origin: "null" }), ["null"])).toEqual({ ok: true });
    expect(checkOrigin(request({ origin: "http://127.0.0.1:8765" }), [])).toEqual({ ok: true });
    expect(
      checkOrigin(request({ origin: "https://obs.example" }), ["https://OBS.example:443/"]),
    ).toEqual({ ok: true });
    const garbage = checkOrigin(request({ origin: "garbage" }), []);
    expect(garbage).toEqual({ ok: false, reason: 'Origin "garbage" is not allowed' });
    const foreign = checkOrigin(request({ origin: "https://evil.example" }), []);
    expect(foreign.ok).toBe(false);
    expect(foreign.ok ? "" : foreign.reason).toContain("pages.allowedOrigins");
    // Without a usable Host header the page's own origin is unknown: refused.
    expect(checkOrigin(request({ origin: "http://x.test", host: "bad host" }), []).ok).toBe(false);
    // Behind a TLS proxy the page's origin is https.
    expect(
      checkOrigin(
        request({ origin: "https://mosque.example", host: "mosque.example", protocol: "https" }),
        [],
      ).ok,
    ).toBe(true);
  });

  it("accepts only this machine's names (or server.host) in the Host header for exposure local", () => {
    expect(isAllowedLocalHost(undefined, "127.0.0.1")).toBe(false);
    expect(isAllowedLocalHost("", "127.0.0.1")).toBe(false);
    expect(isAllowedLocalHost("localhost:1234", "127.0.0.1")).toBe(true);
    expect(isAllowedLocalHost("127.0.0.5", "127.0.0.1")).toBe(true);
    expect(isAllowedLocalHost("[::1]:8765", "127.0.0.1")).toBe(true);
    expect(isAllowedLocalHost("[::1", "127.0.0.1")).toBe(true);
    expect(isAllowedLocalHost(" Studio.LAN:8765 ", "studio.lan")).toBe(true);
    expect(isAllowedLocalHost("[fe80::1]:80", "[FE80::1]")).toBe(true);
    expect(isAllowedLocalHost("evil.example", "127.0.0.1")).toBe(false);
    expect(isAllowedLocalHost("evil.example:80", "studio.lan")).toBe(false);
  });
});

describe("server credentials", () => {
  it("compares tokens in constant time; an empty token never matches", () => {
    expect(tokenMatches("abc", "")).toBe(false);
    expect(tokenMatches(null, "secret-token")).toBe(false);
    expect(tokenMatches("", "secret-token")).toBe(false);
    expect(tokenMatches("wrong-token!", "secret-token")).toBe(false);
    expect(tokenMatches("secret-token", "secret-token")).toBe(true);
  });

  it("reads the token from Bearer first, then ?token=", () => {
    expect(presentedToken(request({ authorization: "Bearer abc", query: { token: "q" } }))).toBe(
      "abc",
    );
    expect(presentedToken(request({ authorization: "bearer  xyz  " }))).toBe("xyz");
    expect(presentedToken(request({ authorization: "Basic abc", query: { token: "q" } }))).toBe(
      "q",
    );
    expect(presentedToken(request({ query: { token: "" } }))).toBeNull();
    expect(presentedToken(request({ query: { token: ["a", "b"] } }))).toBeNull();
    expect(presentedToken(request({ query: undefined }))).toBeNull();
    expect(presentedToken(request({ query: "token=x" }))).toBeNull();
  });

  it("lists every credential a viewer presents, once each", () => {
    expect(
      presentedCredentials(
        request({ authorization: "Bearer same", query: { key: "same", token: "other" } }),
      ),
    ).toEqual(["same", "other"]);
    expect(presentedCredentials(request({ query: {} }))).toEqual([]);
  });

  it("knows the portal routes", () => {
    for (const route of [
      "/api/auth/login",
      "/api/users",
      "/api/users/:id",
      "/api/screens",
      "/api/screens/:id/enable",
      "/api/settings",
      "/api/org",
      "/api/org/keys/:provider",
    ]) {
      expect([route, isPortalRoute(route)]).toEqual([route, true]);
    }
    for (const route of ["/api/sessions", "/api/usersx", "/api/organisation", "/admin"]) {
      expect([route, isPortalRoute(route)]).toEqual([route, false]);
    }
  });

  it("decides which routes need credentials, per exposure and mode", () => {
    const local = config({});
    expect(accessFor("POST", "/api/session/stop", local)).toBe("open");
    const lan = config({ server: { host: "0.0.0.0", exposure: "lan" } });
    expect(accessFor("GET", undefined, lan)).toBe("open");
    expect(accessFor("GET", "/api/languages", lan)).toBe("open");
    expect(accessFor("HEAD", "/api/presets", lan)).toBe("open");
    expect(accessFor("GET", "/api/sessions/:id/blocks", lan)).toBe("viewer");
    expect(accessFor("GET", "/api/sessions/:id/export.srt", lan)).toBe("viewer");
    expect(accessFor("POST", "/api/sessions/:id/blocks", lan)).toBe("admin");
    expect(accessFor("POST", "/api/auth/login", lan)).toBe("open");
    expect(accessFor("POST", "/api/presets", lan)).toBe("admin");
    expect(accessFor("GET", "/api", lan)).toBe("admin");
    expect(accessFor("GET", "/api/sessions", lan)).toBe("admin");
    expect(accessFor("GET", "/control", lan)).toBe("admin");
    expect(accessFor("GET", "/customize", lan)).toBe("admin");
    expect(accessFor("GET", "/overlay", lan)).toBe("open");
    expect(accessFor("GET", "/ws", lan)).toBe("open");
    expect(accessFor("GET", "/ar/nl", lan)).toBe("open");
    const guarded = config({ server: { host: "0.0.0.0", exposure: "lan", protectOverlay: true } });
    expect(accessFor("GET", "/overlay", guarded)).toBe("admin");
    expect(accessFor("GET", "/ws", guarded)).toBe("admin");

    // Hosted mode: the rules apply in every exposure; presets and the look editor are the
    // organisations' own; the overlay is the operator's.
    const hosted = config({ mode: "hosted" });
    expect(accessFor("POST", "/api/presets", hosted)).toBe("open");
    expect(accessFor("DELETE", "/api/presets/:id", hosted)).toBe("open");
    expect(accessFor("GET", "/customize", hosted)).toBe("open");
    expect(accessFor("GET", "/control", hosted)).toBe("admin");
    expect(accessFor("GET", "/overlay", hosted)).toBe("admin");
    expect(accessFor("GET", "/api/sessions", hosted)).toBe("admin");
  });
});
