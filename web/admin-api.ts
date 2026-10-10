// App API client shared by /login, /signup, /app, /app/keys and the builder's screen mode. JSON in
// and out; mutating requests always send `Content-Type: application/json` (the server's CSRF rule).
// Failures become ApiError with the server's own message when it sent one.
import type {
  AppMode,
  AuthStateView,
  KeyProvider,
  KeyPutResult,
  KeyStatus,
  Me,
  OrgView,
  PortalSettings,
  ScreenView,
  UserView,
} from "../src/shared/protocol.js";
import { lang, localeOf, t, tn } from "./shared/app-i18n.js";

export type {
  AppMode,
  AuthStateView,
  KeyProvider,
  KeyPutResult,
  KeyStatus,
  Me,
  OrgView,
  PortalSettings,
  ScreenView,
  UserView,
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds from a 429's Retry-After header. */
    readonly retryAfter: number | null = null,
    /** The server sent its own message (not our fallback). */
    readonly fromServer = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function messageOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  for (const k of ["message", "error"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

export function fallbackMessage(status: number): string {
  if (status === 401) return t("err.401");
  if (status === 403) return t("err.403");
  if (status === 404) return t("err.404");
  if (status === 429) return t("err.429");
  if (status >= 500) return t("err.500");
  return t("err.http", { status });
}

async function request(method: Method, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, headers, credentials: "same-origin", cache: "no-store" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, t("err.network"));
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const retry = Number(res.headers.get("Retry-After"));
    const own = messageOf(parsed);
    throw new ApiError(
      res.status,
      own ?? fallbackMessage(res.status),
      Number.isFinite(retry) && retry > 0 ? retry : null,
      own !== null,
    );
  }
  return parsed;
}

/** A JSON reply (the caller knows the shape: it comes from our own server). */
export async function apiJson<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return (await request(method, path, body)) as T;
}

/** A reply without a useful body (204). */
export async function apiVoid(method: Method, path: string, body?: unknown): Promise<void> {
  await request(method, path, body);
}

/** "a minute" / "5 minutes": the wait of a 429's Retry-After (seconds). */
export function waitText(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? t("common.minute") : tn("n.minutes", m);
}

/** A 429 in the app's language: "Too many attempts. Try again in 5 minutes." */
export function retryText(err: ApiError): string {
  return err.retryAfter !== null
    ? t("login.tooMany", { time: waitText(err.retryAfter) })
    : t("login.tooManyWait");
}

/** The user-facing text of any failure: our own words where the case is predictable (no
 *  connection, too many attempts, an internal error), else the server's message as it is. */
export function errText(err: unknown): string {
  if (!(err instanceof ApiError)) return t("err.generic");
  if (err.status === 429) return retryText(err);
  if (err.status >= 500 && (!err.fromServer || err.message === "Internal server error")) {
    return t("err.500");
  }
  return err.message;
}

/** The HTTP status a provider answered, as the server reported it ("… (HTTP 401)"). */
export function httpDetail(message: string): string | null {
  return /\bHTTP (\d{3})\b/.exec(message)?.[1] ?? null;
}

/** GET /api/auth/me → the account, or null when not logged in (401). */
export async function fetchMe(): Promise<Me | null> {
  try {
    const r = await apiJson<{ me?: Me } | Me>("GET", "/api/auth/me");
    return "me" in r && r.me ? r.me : (r as Me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Pages that work without a login (log-in, sign-up, a local install's builder and look editor)
 * ask GET /api/auth/me only when /api/auth/state says the request is logged in: a logged-out
 * visit has no 401 in the console. Without an answer from the server, ask anyway.
 */
export async function maybeLoggedIn(): Promise<boolean> {
  return (await authStateOnce())?.loggedIn ?? true;
}

/** GET /api/auth/state with safe defaults (older servers send only setupRequired). */
export async function fetchAuthState(): Promise<AuthStateView> {
  const r = await apiJson<Partial<AuthStateView> | null>("GET", "/api/auth/state");
  return {
    setupRequired: r?.setupRequired === true,
    mode: r?.mode === "hosted" ? "hosted" : "local",
    signup: r?.signup === true,
    // An older server without the field: assume a login may exist (ask /api/auth/me as before).
    loggedIn: r?.loggedIn !== false,
  };
}

let authState: Promise<AuthStateView | null> | null = null;

/** The server's mode, asked once per page (null when the server didn't answer). */
export function authStateOnce(): Promise<AuthStateView | null> {
  authState ??= fetchAuthState().catch(() => null);
  return authState;
}

/** GET /api/org → the caller's organisation, or null while the server has no such endpoint. */
export async function fetchOrg(): Promise<OrgView | null> {
  try {
    return await apiJson<OrgView>("GET", "/api/org");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
}

/** Only same-site paths are allowed as ?next= targets (no open redirects). */
export function safeNext(raw: string | null, fallback = "/app"): string {
  if (raw === null) return fallback;
  const v = raw.trim();
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  return v;
}

/** /login?next=<this page>, for pages that need an account. */
export function loginUrl(next: string = window.location.pathname + window.location.search): string {
  return `/login?next=${encodeURIComponent(next + window.location.hash)}`;
}

/** Language names for "Arabic → Dutch", in the app's own language (else the English name from
 *  GET /api/languages, else the code). The arrow points the reading way (← on Arabic pages). */
export class LangNames {
  private readonly en = new Map<string, string>();
  private display: Intl.DisplayNames | null = null;
  private displayLang = "";

  async load(): Promise<void> {
    try {
      const r = await apiJson<{ sources?: unknown; targets?: unknown }>("GET", "/api/languages");
      for (const list of [r.sources, r.targets]) {
        if (!Array.isArray(list)) continue;
        for (const item of list as unknown[]) {
          if (typeof item !== "object" || item === null) continue;
          const o = item as Record<string, unknown>;
          if (typeof o.code === "string" && typeof o.en === "string") this.en.set(o.code, o.en);
        }
      }
    } catch {
      // names fall back to the browser's or the code
    }
  }

  private names(): Intl.DisplayNames | null {
    const l = lang();
    if (this.displayLang !== l) {
      this.displayLang = l;
      try {
        this.display = new Intl.DisplayNames([localeOf(l), "en"], { type: "language" });
      } catch {
        this.display = null;
      }
    }
    return this.display;
  }

  name(code: string): string {
    if (code === "auto") return t("b.autoShort");
    let local: string | undefined;
    try {
      local = this.names()?.of(code);
    } catch {
      local = undefined;
    }
    if (local && local !== code) return local.charAt(0).toUpperCase() + local.slice(1);
    return this.en.get(code) ?? code.toUpperCase();
  }

  pair(from: string, to: string): string {
    return `${this.name(from)} ${t("common.arrow")} ${this.name(to)}`;
  }
}
