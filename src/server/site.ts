// The website: static pages that scripts/build-site.ts writes to public/site/:
// for each mode (hosted/, local/) every page in every language (<lang>/<page>.html) and a
// routes.json that maps each route to its file; hashed bundles, fonts, icons and pictures are under
// public/site/assets, served at /site-assets/. Hosted mode serves the pages at / (/nl, /ar, and
// /self-host, /nl/self-host, …); local mode keeps the builder at / and previews the website under
// /site (its "Start for free" opens the builder). Every page is an explicit route, so Fastify's
// router takes /nl/self-host before the caption route /:from/:to. Pages get the same strict
// headers as every other page (no inline scripts or styles) and are never framed.
// What only this server knows is filled in when a page is served: the origin of the absolute URLs
// (hosted.publicUrl when it is set, else the request's own scheme and host), and in hosted mode
// the footer's links to the operator's privacy statement and contact (hosted.privacyUrl,
// hosted.contactUrl; a link that is not set is left out).
// The website's 404 page answers page addresses that do not exist: in hosted mode through
// app.siteNotFound (the app's not-found handler, and a mistyped /nl/<page> or /ar/<page> that the
// caption route caught), in local mode for every unknown address under /site.
// Search engines (docs/seo.md): /robots.txt in both modes, and in hosted mode /sitemap.xml (the
// build's, with this server's origin). The website's routes are marked (route config `website`):
// only they, and the website's files, are left without X-Robots-Tag: noindex (isWebsite).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppMode } from "../shared/protocol.js";
import { safeHost } from "./security.js";

export interface SiteOptions {
  mode: AppMode;
  publicDir: string;
  applyHtmlHeaders: (req: FastifyRequest, reply: FastifyReply) => void;
  /** hosted.publicUrl: the origin of the pages' absolute URLs (else the request's). */
  publicUrl?: string | null;
  /** hosted.privacyUrl and hosted.contactUrl: the footer's links (hosted mode only). */
  privacyUrl?: string | null;
  contactUrl?: string | null;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** A page (or file) of the public website: search engines may index it. */
    website?: boolean;
  }
  interface FastifyInstance {
    /** Sends the website's 404 page when the request is for a page (GET or HEAD, accepting HTML)
     *  that the website could have; `lang` overrides the language read from the path. Resolves to
     *  false when it is not a website address (the caller answers as before). */
    siteNotFound(req: FastifyRequest, reply: FastifyReply, lang?: string): Promise<boolean>;
  }
}

export const SITE_LANGS = ["en", "nl", "ar"] as const;
export type SiteLang = (typeof SITE_LANGS)[number];

/** URL prefix of the website's hashed assets. */
export const SITE_ASSETS_PREFIX = "/site-assets/";

/** What the build writes where an absolute URL's origin goes (site/render/page.ts). */
export const ORIGIN_TOKEN = "__TJ_ORIGIN__";
/** And where the operator's links go (site/render/page.ts, OPERATOR_TOKENS). */
export const OPERATOR_TOKENS = { privacy: "__TJ_PRIVACY__", contact: "__TJ_CONTACT__" } as const;

const ASSET_CACHE = "public, max-age=31536000, immutable";

/** X-Robots-Tag of every response that is not the public website's. */
export const NOINDEX = "noindex, nofollow";

/** Is the response to `req` part of the public website, which search engines may index? Its pages
 *  and files on a hosted server; nothing on a self-hosted one. */
export function isWebsite(mode: AppMode, req: FastifyRequest): boolean {
  if (mode !== "hosted") return false;
  return req.routeOptions.config.website === true || req.url.startsWith(SITE_ASSETS_PREFIX);
}

/**
 * robots.txt. The public website lets every crawler in and names its sitemap (an absolute URL, so
 * only when the origin is known). Nothing is disallowed: the app's pages, caption pages and API
 * answer with X-Robots-Tag: noindex, and a crawler only sees that when it may fetch them (a URL
 * that robots.txt blocks can still be indexed from links). A self-hosted server is not for search
 * engines at all: it disallows everything, and says noindex too.
 */
export function robotsTxt(mode: AppMode, origin: string): string {
  if (mode !== "hosted") {
    return "# A self-hosted Turjuman server: not for search engines.\nUser-agent: *\nDisallow: /\n";
  }
  return [
    "# Turjuman. The website may be crawled; the app's pages answer with X-Robots-Tag: noindex.",
    "User-agent: *",
    "Allow: /",
    ...(origin === "" ? [] : ["", `Sitemap: ${origin}/sitemap.xml`]),
    "",
  ].join("\n");
}

/** The first path segments that are the app's, never a website page (src/server/app.ts). */
const APP_SEGMENTS: ReadonlySet<string> = new Set([
  "api",
  "ws",
  "overlay",
  "control",
  "customize",
  "health",
  "fonts",
  "assets",
  "s",
  "login",
  "admin",
  "app",
  "signup",
  "site-assets",
  "feed",
  "ca.crt",
]);

/** The home page's route in each language and mode (site/content/pages.ts makes the same). */
export function siteRoutes(mode: AppMode): Array<[string, SiteLang]> {
  return mode === "hosted"
    ? [
        ["/", "en"],
        ["/nl", "nl"],
        ["/ar", "ar"],
      ]
    : [
        ["/site", "en"],
        ["/site/nl", "nl"],
        ["/site/ar", "ar"],
      ];
}

/** The origin for the pages' absolute URLs: the configured public URL, else the request's;
 *  "" (root-relative URLs) when neither is usable. */
export function siteOrigin(
  publicUrl: string | null | undefined,
  protocol: string,
  host: string | undefined,
): string {
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      // not a URL: fall back to the request
    }
  }
  const h = safeHost(host);
  return h !== null && (protocol === "https" || protocol === "http") ? `${protocol}://${h}` : "";
}

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The footer's operator links: the URL put in, or the whole link taken out when it is unset. */
export function fillOperatorLinks(
  html: string,
  urls: { privacyUrl?: string | null | undefined; contactUrl?: string | null | undefined },
): string {
  let out = html;
  for (const [name, url] of [
    ["privacy", urls.privacyUrl],
    ["contact", urls.contactUrl],
  ] as const) {
    const token = OPERATOR_TOKENS[name];
    const link = new RegExp(`<a href="${token}" data-op="${name}">[^<]*</a>`, "g");
    out =
      url === null || url === undefined || url === ""
        ? out.replace(link, "")
        : out.replaceAll(token, escapeAttr(url));
  }
  return out;
}

/** A mistyped website page under a language, /nl/<x> or /ar/<x>: <x> looks like a page slug (4+
 *  characters [a-z0-9-]). The caller checks that <x> is not a caption language either. */
export function looksLikeSitePage(lang: string, rest: string): boolean {
  return (lang === "nl" || lang === "ar") && /^[a-z0-9-]{4,}$/.test(rest);
}

/** The language of a missing page's address: its prefix (after /site in local mode), else English. */
export function notFoundLang(mode: AppMode, path: string): SiteLang {
  const parts =
    path
      .split("?")[0]
      ?.split("/")
      .filter((p) => p !== "") ?? [];
  const first = mode === "local" ? parts[1] : parts[0];
  return first === "nl" || first === "ar" ? first : "en";
}

/** The routes the build wrote (route → file under the mode's directory), checked: a route is an
 *  absolute path of [a-z0-9-] segments, a file a .html path inside the directory. */
export function parseRoutes(json: string): Map<string, string> {
  const out = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return out;
  }
  const routes = (data as { routes?: unknown } | null)?.routes;
  if (typeof routes !== "object" || routes === null) return out;
  for (const [route, file] of Object.entries(routes)) {
    if (
      typeof file === "string" &&
      /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route) &&
      /^[a-z]{2}\/[a-z0-9-]+\.html$/.test(file)
    ) {
      out.set(route, file);
    }
  }
  return out;
}

export async function registerSite(app: FastifyInstance, o: SiteOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: join(o.publicDir, "site", "assets"),
    prefix: SITE_ASSETS_PREFIX,
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: "deny",
    cacheControl: false,
    suppressWarning: true,
    setHeaders: (reply) => {
      reply.header("Cache-Control", ASSET_CACHE);
    },
  });

  const dir = join(o.publicDir, "site", o.mode === "hosted" ? "hosted" : "local");
  // The operator's links belong to a hosted server's own website.
  const operator = o.mode === "hosted" ? o : {};

  /** Sends one built page with this server's origin and links, or says the site isn't built. */
  async function send(
    req: FastifyRequest,
    reply: FastifyReply,
    file: string,
    status = 200,
  ): Promise<FastifyReply> {
    let html: string;
    try {
      html = await readFile(join(dir, file), "utf8");
    } catch {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("The website has not been built yet (run: pnpm build:site)\n");
    }
    o.applyHtmlHeaders(req, reply);
    reply.header("X-Frame-Options", "DENY");
    const origin = siteOrigin(o.publicUrl, req.protocol, req.host);
    const page = fillOperatorLinks(html.replaceAll(ORIGIN_TOKEN, origin), operator);
    return reply.code(status).type("text/html; charset=utf-8").send(page);
  }

  /** Is `req` for a website page that could exist (and does it want HTML)? */
  function wantsSitePage(req: FastifyRequest): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("text/html")) return false;
    const parts =
      req.url
        .split("?")[0]
        ?.split("/")
        .filter((p) => p !== "") ?? [];
    if (o.mode === "local") return parts[0] === "site";
    return parts[0] === undefined || (!APP_SEGMENTS.has(parts[0]) && parts[0] !== "site");
  }

  app.decorate(
    "siteNotFound",
    async (req: FastifyRequest, reply: FastifyReply, lang?: string): Promise<boolean> => {
      if (lang === undefined && !wantsSitePage(req)) return false;
      const l = SITE_LANGS.find((x) => x === lang) ?? notFoundLang(o.mode, req.url);
      await send(req, reply, `${l}/not-found.html`, 404);
      return true;
    },
  );

  // The home pages are always routed (they say so when the site is not built yet); the build's
  // routes.json adds the other pages.
  const routes = new Map<string, string>(
    siteRoutes(o.mode).map(([route, lang]) => [route, `${lang}/home.html`]),
  );
  try {
    for (const [route, file] of parseRoutes(await readFile(join(dir, "routes.json"), "utf8"))) {
      routes.set(route, file);
    }
  } catch {
    // not built yet
  }

  // The public website's routes; a self-hosted server's preview is not for search engines.
  const config = { website: o.mode === "hosted" };
  for (const [route, file] of routes) {
    app.get(route, { config }, (req, reply) => send(req, reply, file));
    // /nl/ → /nl (and /site/install/ → /site/install): one address per page.
    if (route !== "/") {
      app.get(`${route}/`, { config }, (req, reply) => {
        const q = req.url.indexOf("?");
        return reply.redirect(q === -1 ? route : `${route}${req.url.slice(q)}`, 301);
      });
    }
  }

  app.get("/robots.txt", { config }, (req, reply) =>
    reply
      .header("Cache-Control", "public, max-age=3600")
      .type("text/plain; charset=utf-8")
      .send(robotsTxt(o.mode, siteOrigin(o.publicUrl, req.protocol, req.host))),
  );
  if (o.mode === "hosted") {
    // Every page in every language with its alternates; its URLs need this server's origin.
    app.get("/sitemap.xml", { config }, async (req, reply) => {
      const origin = siteOrigin(o.publicUrl, req.protocol, req.host);
      let xml: string;
      try {
        xml = await readFile(join(dir, "sitemap.xml"), "utf8");
      } catch {
        xml = "";
      }
      if (xml === "" || origin === "") {
        return reply.code(404).type("text/plain; charset=utf-8").send("Not found\n");
      }
      return reply
        .header("Cache-Control", "public, max-age=3600")
        .type("application/xml; charset=utf-8")
        .send(xml.replaceAll(ORIGIN_TOKEN, origin));
    });
  }

  // Local mode: every other address under /site is a missing website page (the router takes the
  // pages above first). Hosted mode answers through app.siteNotFound instead, so that caption
  // pairs such as /nl/en keep reaching /:from/:to.
  if (o.mode === "local") {
    app.get("/site/*", (req, reply) =>
      send(req, reply, `${notFoundLang("local", req.url)}/not-found.html`, 404),
    );
  }
}
