// @vitest-environment happy-dom
// The app's API client (web/admin-api.ts): what it sends, how a failure becomes words a person
// understands, the log-in helpers (who is logged in, where to go next) and language names.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiJson,
  apiVoid,
  errText,
  fallbackMessage,
  fetchAuthState,
  fetchMe,
  fetchOrg,
  httpDetail,
  LangNames,
  loginUrl,
  maybeLoggedIn,
  retryText,
  safeNext,
  waitText,
} from "../../web/admin-api.js";
import { message, setLang } from "../../web/shared/app-i18n.js";
import { setUrl } from "./helpers/web-app-page.js";
import { FakeServer } from "./helpers/web-app-server.js";

let server: FakeServer;

beforeEach(() => {
  setLang("en");
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("no failure");
}

describe("app API: requests", () => {
  it("asks with GET, without a body, never from the cache", async () => {
    server.login(server.addUser({ username: "imam", role: "admin" }));
    await apiJson("GET", "/api/screens");
    expect(server.fetch).toHaveBeenCalledWith("/api/screens", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("sends changes as JSON (the server's CSRF rule), an empty object when there is no body", async () => {
    server.login(server.addUser({ username: "imam", role: "admin" }));
    server.addScreen({ name: "Hall" });
    await apiJson("POST", "/api/screens/s2/enable");
    await apiJson("PATCH", "/api/screens/s2", { name: "Hall 2" });
    const [enable, rename] = server.fetch.mock.calls.map((c) => c[1]);
    expect(enable).toMatchObject({
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(rename?.body).toBe('{"name":"Hall 2"}');
    expect(server.screens[0]?.name).toBe("Hall 2");
  });

  it("answers a reply without a body with null, and apiVoid with nothing", async () => {
    server.once("/api/x", { status: 204 });
    expect(await apiJson("GET", "/api/x")).toBeNull();
    server.once("/api/x", { status: 200, text: "not json" });
    expect(await apiJson("GET", "/api/x")).toBeNull();
    server.once("/api/x", { status: 200, body: { ok: true } });
    expect(await apiVoid("DELETE", "/api/x")).toBeUndefined();
  });

  it("takes the server's own message, from `message` or else `error`", async () => {
    server.once("/api/x", { status: 400, body: { message: "  Name: too long " } });
    let err = await failure(apiJson("GET", "/api/x"));
    expect([err.status, err.message, err.fromServer, err.retryAfter]).toEqual([
      400,
      "Name: too long",
      true,
      null,
    ]);
    expect(err.name).toBe("ApiError");
    server.once("/api/x", { status: 409, body: { message: " ", error: "Conflict" } });
    err = await failure(apiJson("GET", "/api/x"));
    expect([err.message, err.fromServer]).toEqual(["Conflict", true]);
  });

  it.each<[number, unknown, string]>([
    [401, { message: 5 }, message("en", "err.401")],
    [403, ["no"], message("en", "err.403")],
    [404, null, message("en", "err.404")],
    [429, "", message("en", "err.429")],
    [503, { error: "" }, message("en", "err.500")],
    [418, {}, message("en", "err.http", { status: 418 })],
  ])("words a %i without a message of its own", async (status, body, want) => {
    server.once("/api/x", body === "" ? { status } : { status, body });
    const err = await failure(apiJson("GET", "/api/x"));
    expect(err.message).toBe(want);
    expect(err.fromServer).toBe(false);
    expect(fallbackMessage(status)).toBe(want);
  });

  it("treats a body it can't read as no body", async () => {
    server.once("/api/x", "unreadable");
    const err = await failure(apiJson("GET", "/api/x"));
    expect([err.status, err.message]).toEqual([502, message("en", "err.500")]);
  });

  it("reports a lost connection as status 0", async () => {
    server.once("/api/x", "network");
    const err = await failure(apiJson("GET", "/api/x"));
    expect([err.status, err.message]).toEqual([0, message("en", "err.network")]);
  });

  it("reads the wait of a 429 from Retry-After, when it is a positive number", async () => {
    for (const [header, want] of [
      ["120", 120],
      ["0", null],
      ["soon", null],
    ] as const) {
      server.once("/api/x", { status: 429, headers: { "Retry-After": header } });
      expect((await failure(apiJson("GET", "/api/x"))).retryAfter).toBe(want);
    }
  });
});

describe("app API: words for failures", () => {
  it("says how long to wait", () => {
    expect(waitText(1)).toBe("a minute");
    expect(waitText(60)).toBe("a minute");
    expect(waitText(61)).toBe("2 minutes");
    expect(retryText(new ApiError(429, "x", 600))).toBe(
      "Too many attempts. Try again in 10 minutes.",
    );
    expect(retryText(new ApiError(429, "x"))).toBe(message("en", "login.tooManyWait"));
  });

  it("puts any failure in words: ours where predictable, else the server's", () => {
    expect(errText(new Error("boom"))).toBe(message("en", "err.generic"));
    expect(errText(new ApiError(429, "slow down", 30))).toBe(
      "Too many attempts. Try again in a minute.",
    );
    expect(errText(new ApiError(500, "fallback"))).toBe(message("en", "err.500"));
    expect(errText(new ApiError(500, "Internal server error", null, true))).toBe(
      message("en", "err.500"),
    );
    expect(errText(new ApiError(500, "The master key is not valid", null, true))).toBe(
      "The master key is not valid",
    );
    expect(errText(new ApiError(404, "No such screen", null, true))).toBe("No such screen");
  });

  it("finds the HTTP status a provider answered in the server's message", () => {
    expect(httpDetail("Soniox did not accept this key (HTTP 401).")).toBe("401");
    expect(httpDetail("Soniox answered HTTP 503; the key was not checked.")).toBe("503");
    expect(httpDetail("HTTP 99 or HTTP 1000")).toBeNull();
    expect(httpDetail("no status")).toBeNull();
  });

  it("speaks the app's language", () => {
    setLang("nl");
    expect(fallbackMessage(404)).toBe(message("nl", "err.404"));
    expect(waitText(300)).toBe("5 minuten");
  });
});

describe("app API: who is logged in", () => {
  it("returns the account, or null when nobody is logged in", async () => {
    const imam = server.addUser({ username: "imam", role: "admin", displayName: "Imam" });
    expect(await fetchMe()).toBeNull();
    server.login(imam);
    expect(await fetchMe()).toEqual({
      id: imam.id,
      username: "imam",
      displayName: "Imam",
      role: "admin",
      orgId: "local",
      email: null,
    });
  });

  it("understands an older server that sent the account bare", async () => {
    const bare = {
      id: "u1",
      username: "imam",
      displayName: "",
      role: "admin",
      orgId: "local",
      email: null,
    };
    server.once("GET /api/auth/me", { status: 200, body: bare });
    expect(await fetchMe()).toEqual(bare);
  });

  it("passes other failures on", async () => {
    server.once("GET /api/auth/me", { status: 500 });
    expect((await failure(fetchMe())).status).toBe(500);
  });

  it("fills in what an older server's state leaves out", async () => {
    server.once("GET /api/auth/state", { status: 200, body: { setupRequired: true } });
    expect(await fetchAuthState()).toEqual({
      setupRequired: true,
      mode: "local",
      signup: false,
      loggedIn: true,
    });
    server.once("GET /api/auth/state", { status: 200 });
    expect(await fetchAuthState()).toEqual({
      setupRequired: false,
      mode: "local",
      signup: false,
      loggedIn: true,
    });
    server.mode = "hosted";
    expect(await fetchAuthState()).toEqual({
      setupRequired: false,
      mode: "hosted",
      signup: true,
      loggedIn: false,
    });
  });

  it("asks the server's state once per page", async () => {
    vi.resetModules();
    const api = await import("../../web/admin-api.js");
    expect(await api.maybeLoggedIn()).toBe(false);
    expect(await api.authStateOnce()).toMatchObject({ loggedIn: false, mode: "local" });
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("assumes a login may exist when the state can't be asked", async () => {
    vi.resetModules();
    const api = await import("../../web/admin-api.js");
    server.once("GET /api/auth/state", "network");
    expect(await api.authStateOnce()).toBeNull();
    expect(await api.maybeLoggedIn()).toBe(true);
  });

  it("knows a logged-in visit", async () => {
    server.login(server.addUser({ username: "imam" }));
    expect(await maybeLoggedIn()).toBe(true);
  });
});

describe("app API: the organisation", () => {
  it("returns the organisation, or null on a server without one", async () => {
    server.login(server.addUser({ username: "imam", role: "admin" }));
    expect(await fetchOrg()).toMatchObject({ id: "local", mode: "local", role: "admin" });
    server.once("GET /api/org", { status: 404 });
    expect(await fetchOrg()).toBeNull();
    server.once("GET /api/org", { status: 405 });
    expect(await fetchOrg()).toBeNull();
    server.once("GET /api/org", { status: 500 });
    expect((await failure(fetchOrg())).status).toBe(500);
  });
});

describe("app API: where to go after logging in", () => {
  it("allows only paths on this site", () => {
    expect(safeNext(null)).toBe("/app");
    expect(safeNext(null, "/app/keys")).toBe("/app/keys");
    expect(safeNext(" /app/look?x=1 ")).toBe("/app/look?x=1");
    expect(safeNext("//evil.example")).toBe("/app");
    expect(safeNext("/\\evil.example")).toBe("/app");
    expect(safeNext("https://evil.example/")).toBe("/app");
    expect(safeNext("app")).toBe("/app");
  });

  it("comes back to this page, its query and its section after logging in", () => {
    setUrl("http://localhost:3000/app/new?screen=s1#step=3");
    expect(loginUrl()).toBe("/login?next=%2Fapp%2Fnew%3Fscreen%3Ds1%23step%3D3");
    setUrl("http://localhost:3000/app#accounts");
    expect(loginUrl("/app")).toBe("/login?next=%2Fapp%23accounts");
  });
});

describe("app API: language names", () => {
  it("names languages in the app's language, else in English from the server, else by code", async () => {
    server.languages = {
      sources: [{ code: "ar", en: "Arabic" }, null, "nl", { code: "xx" }],
      targets: [{ code: "qaa", en: "Our own" }],
    };
    const names = new LangNames();
    await names.load();
    expect(names.name("ar")).toBe("Arabic");
    expect(names.name("qaa")).toBe("Our own");
    expect(names.name("qab")).toBe("QAB");
    expect(names.name("not a code")).toBe("NOT A CODE");
    expect(names.name("auto")).toBe(message("en", "b.autoShort"));
    expect(names.pair("ar", "nl")).toBe("Arabic → Dutch");
    setLang("nl");
    expect(names.pair("ar", "en")).toBe("Arabisch → Engels");
    setLang("ar");
    expect(names.name("nl")).toBe("الهولندية");
  });

  it("keeps working when the server's list is missing or odd", async () => {
    server.once("GET /api/languages", "network");
    const names = new LangNames();
    await names.load();
    expect(names.name("qaa")).toBe("QAA");
    server.once("GET /api/languages", { status: 200, body: { sources: "ar", targets: null } });
    await names.load();
    expect(names.name("nl")).toBe("Dutch");
  });

  it("falls back to the server's English names when the browser has none", async () => {
    vi.spyOn(Intl, "DisplayNames").mockImplementation(() => {
      throw new RangeError("no display names");
    });
    const names = new LangNames();
    await names.load();
    expect(names.name("ar")).toBe("Arabic");
    expect(names.name("nl")).toBe("Dutch");
    expect(names.name("de")).toBe("DE");
  });
});
