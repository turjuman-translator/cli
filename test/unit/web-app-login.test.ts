// @vitest-environment happy-dom
// The log-in page (web/login.ts): logging in, the first admin of a local install, hosted log-in
// by e-mail, where a login goes next, and every failure in the person's own language.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message } from "../../web/shared/app-i18n.js";
import {
  $,
  cleanup,
  click,
  fakeTimers,
  type Opened,
  openPage,
  settle,
  text,
  type,
} from "./helpers/web-app-page.js";
import { FakeServer, type Reply } from "./helpers/web-app-server.js";

const en = (key: Parameters<typeof message>[1], vars?: Record<string, string | number>) =>
  message("en", key, vars);

let server: FakeServer;

beforeEach(() => {
  fakeTimers();
  server = new FakeServer();
});
afterEach(cleanup);

function open(
  url = "http://localhost:3000/login",
  lang: "en" | "nl" | "ar" | null = null,
): Promise<Opened> {
  return openPage("login", server, () => import("../../web/login.js"), { url, lang });
}

const shown = (id: string): boolean => !$(`#${id}`).hidden;

async function logIn(username: string, password: string): Promise<void> {
  type("#username", username);
  type("#password", password);
  await click("#login-submit");
}

describe("log-in page: a local install", () => {
  beforeEach(() => {
    server.addUser({ username: "imam", role: "admin", password: "correct-horse" });
  });

  it("shows the form to a logged-out visitor without asking who is logged in", async () => {
    await open();
    expect(shown("login-form")).toBe(true);
    expect(shown("setup-form")).toBe(false);
    expect(shown("loading")).toBe(false);
    expect(shown("signup-row")).toBe(false);
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
    expect(document.title).toBe("Log in · Turjuman");
    expect(text("#username-label")).toBe("Username");
    expect(document.activeElement?.id).toBe("username");
    // A local install's admin resets a password on the server itself.
    const codes = [...$("#forgot").querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toEqual(["turjuman users passwd <name>", "make user-passwd USERNAME=<name>"]);
    expect(text("#forgot")).toContain("Forgot your password? Ask an admin.");
    // The wordmark goes to / (the local install's builder).
    expect($(".app-brand").getAttribute("href")).toBe("/");
  });

  it("logs in, says it is busy meanwhile, and goes to ?next=", async () => {
    const { nav } = await open("http://localhost:3000/login?next=%2Fapp%2Flook");
    const held = server.hold("POST /api/auth/login");
    await logIn("  imam ", "correct-horse");
    const submit = $<HTMLButtonElement>("#login-submit");
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe("Logging in…");
    expect(server.last("POST /api/auth/login")?.body).toEqual({
      username: "imam",
      password: "correct-horse",
    });
    expect(server.last("POST /api/auth/login")?.headers["content-type"]).toBe("application/json");
    held.release();
    await settle();
    expect(nav.assign).toHaveBeenCalledWith("/app/look");
    expect(server.requests()).not.toContain("GET /api/org");
  });

  it("never follows a ?next= to another site: the dashboard instead", async () => {
    const { nav } = await open("http://localhost:3000/login?next=%2F%2Fevil.example%2F");
    await logIn("imam", "correct-horse");
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  it("asks for both fields before sending anything", async () => {
    await open();
    await click("#login-submit");
    expect(text("#login-error-text")).toBe(en("login.missing"));
    expect(shown("login-error")).toBe(true);
    expect(document.activeElement?.id).toBe("username");
    type("#username", "imam");
    await click("#login-submit");
    expect(document.activeElement?.id).toBe("password");
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("says a password is wrong, selects it for another try, and then logs in", async () => {
    const { nav } = await open();
    await logIn("imam", "wrong");
    expect(text("#login-error-text")).toBe("Wrong username or password.");
    const submit = $<HTMLButtonElement>("#login-submit");
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Log in");
    expect(document.activeElement?.id).toBe("password");
    expect(nav.assign).not.toHaveBeenCalled();

    await logIn("imam", "correct-horse");
    expect(shown("login-error")).toBe(false);
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  it.each<[string, Reply, string]>([
    [
      "too many attempts, with the wait",
      { status: 429, body: { message: "Too many" }, headers: { "Retry-After": "300" } },
      "Too many attempts. Try again in 5 minutes.",
    ],
    [
      "too many attempts, within the minute",
      { status: 429, headers: { "Retry-After": "20" } },
      "Too many attempts. Try again in a minute.",
    ],
    ["too many attempts, no wait given", { status: 429 }, en("login.tooManyWait")],
    [
      "a disabled account",
      { status: 403, body: { ok: false, message: "This account is disabled" } },
      en("login.disabled"),
    ],
    [
      "a disabled mosque",
      {
        status: 403,
        body: { message: "This organisation is disabled; contact the server's operator" },
      },
      en("login.orgDisabled"),
    ],
    [
      "another refusal, in the server's words",
      { status: 403, body: { message: "Not from this network" } },
      "Not from this network",
    ],
    ["a refusal without words", { status: 403 }, en("err.403")],
    ["no connection", "network", en("err.network")],
    ["a server error", { status: 500, text: "<html>oops</html>" }, en("err.500")],
    ["an odd answer", { status: 418, body: { error: "  I'm a teapot " } }, "I'm a teapot"],
  ])("explains %s", async (_case, reply, want) => {
    await open();
    server.once("POST /api/auth/login", reply);
    await logIn("imam", "correct-horse");
    expect(text("#login-error-text")).toBe(want);
  });

  it("goes on after a log-in answered without the account", async () => {
    const { nav } = await open();
    server.once("POST /api/auth/login", { status: 200 });
    await logIn("imam", "correct-horse");
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  it("explains a navigation the browser refuses", async () => {
    const { nav } = await open();
    nav.assign.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    await logIn("imam", "correct-horse");
    expect(text("#login-error-text")).toBe(en("err.generic"));
  });

  it("goes straight on when the visitor is logged in already (the back button)", async () => {
    server.login(server.users[0] as never);
    const { nav } = await open("http://localhost:3000/login?next=%2Fapp%2Fnew");
    expect(server.requests()).toEqual(["GET /api/auth/state", "GET /api/auth/me"]);
    expect(nav.replace).toHaveBeenCalledWith("/app/new");
    expect(shown("login-form")).toBe(false);
  });

  it("shows the form when the server can't say who is logged in", async () => {
    server.login(server.users[0] as never);
    server.once("GET /api/auth/me", { status: 500 });
    const { nav } = await open();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(shown("login-form")).toBe(true);
  });

  it("shows the form with the reason when the server can't be asked", async () => {
    server.once("GET /api/auth/state", "network");
    await open();
    expect(shown("login-form")).toBe(true);
    expect(text("#login-error-text")).toBe(en("err.network"));
  });

  it("asks to log in when the server refuses the question", async () => {
    server.once("GET /api/auth/state", { status: 401 });
    await open();
    expect(text("#login-error-text")).toBe(en("login.again"));
  });

  it("shows and hides a password", async () => {
    await open();
    const toggle = $<HTMLButtonElement>('.pw-toggle[data-for="password"]');
    await click(toggle);
    expect($<HTMLInputElement>("#password").type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");
    await click(toggle);
    expect($<HTMLInputElement>("#password").type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
  });

  it("leaves a password toggle without its field alone", async () => {
    await open();
    const [first, second] = [...document.querySelectorAll<HTMLButtonElement>(".pw-toggle")];
    if (!first || !second) throw new Error("toggles missing");
    first.dataset.for = "loading"; // not an input
    delete second.dataset.for;
    await click(first);
    await click(second);
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("log-in page: the first admin of a local install", () => {
  it("asks for the admin account when there is none yet", async () => {
    await open();
    expect(shown("setup-form")).toBe(true);
    expect(shown("login-form")).toBe(false);
    expect(document.title).toBe("Create the admin account · Turjuman");
    expect(document.activeElement?.id).toBe("setup-name");
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("checks the username and both passwords first", async () => {
    await open();
    type("#setup-username", "a");
    await click("#setup-submit");
    expect(text("#setup-error-text")).toBe(en("setup.badUsername"));
    expect(document.activeElement?.id).toBe("setup-username");

    type("#setup-username", "imam.ali");
    type("#setup-password", "short");
    await click("#setup-submit");
    expect(text("#setup-error-text")).toBe(en("setup.shortPassword"));
    expect(document.activeElement?.id).toBe("setup-password");

    type("#setup-password", "a-long-password");
    type("#setup-password2", "another-password");
    await click("#setup-submit");
    expect(text("#setup-error-text")).toBe(en("setup.mismatch"));
    expect(document.activeElement?.id).toBe("setup-password2");
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("creates the admin with a name and goes to the dashboard", async () => {
    const { nav } = await open();
    type("#setup-name", "  Imam Ali ");
    type("#setup-username", "imam.ali");
    type("#setup-password", "a-long-password");
    type("#setup-password2", "a-long-password");
    const held = server.hold("POST /api/auth/setup");
    await click("#setup-submit");
    expect($<HTMLButtonElement>("#setup-submit").textContent).toBe("Creating…");
    held.release();
    await settle();
    expect(server.last("POST /api/auth/setup")?.body).toEqual({
      username: "imam.ali",
      password: "a-long-password",
      displayName: "Imam Ali",
    });
    expect(nav.assign).toHaveBeenCalledWith("/app");
    expect(server.users[0]?.role).toBe("admin");
  });

  it("sends no name when none is given", async () => {
    const { nav } = await open();
    server.once("POST /api/auth/setup", { status: 200, text: "" });
    type("#setup-username", "imam");
    type("#setup-password", "a-long-password");
    type("#setup-password2", "a-long-password");
    await click("#setup-submit");
    expect(server.last("POST /api/auth/setup")?.body).toEqual({
      username: "imam",
      password: "a-long-password",
    });
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  async function fillSetup(): Promise<void> {
    type("#setup-username", "imam");
    type("#setup-password", "a-long-password");
    type("#setup-password2", "a-long-password");
    await click("#setup-submit");
  }

  it("switches to log-in when someone else created the admin meanwhile", async () => {
    await open();
    server.addUser({ username: "first", role: "admin" });
    await fillSetup();
    expect(shown("login-form")).toBe(true);
    expect(shown("setup-form")).toBe(false);
    expect(text("#login-error-text")).toBe(en("setup.exists"));
    expect(document.title).toBe("Log in · Turjuman");
  });

  it("points to the server's own computer when set up from elsewhere", async () => {
    server.setupRemote = true;
    await open("http://192.168.1.20:8080/login");
    await fillSetup();
    expect(text("#setup-error-text")).toBe(
      en("setup.remote", { url: "http://127.0.0.1:8080/login" }),
    );
    expect($<HTMLButtonElement>("#setup-submit").disabled).toBe(false);
  });

  it("names the default port when the page came without one", async () => {
    server.setupRemote = true;
    await open("http://captions.local/login");
    await fillSetup();
    expect(text("#setup-error-text")).toBe(
      en("setup.remote", { url: "http://127.0.0.1:8765/login" }),
    );
  });

  it("shows the server's reason for other refusals", async () => {
    await open();
    server.once("POST /api/auth/setup", {
      status: 400,
      body: { message: "Password: too common" },
    });
    await fillSetup();
    expect(text("#setup-error-text")).toBe("Password: too common");
    server.once("POST /api/auth/setup", { status: 401 });
    await click("#setup-submit");
    expect(text("#setup-error-text")).toBe(en("setup.failed"));
  });
});

describe("log-in page: hosted", () => {
  beforeEach(() => {
    server.mode = "hosted";
    server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 0, estimateUsd: 0 } };
  });

  it("logs in by e-mail and links to sign-up while it is open", async () => {
    await open();
    expect(text("#username-label")).toBe("E-mail or username");
    expect(text("#forgot")).toBe(en("login.forgotHosted"));
    expect(shown("signup-row")).toBe(true);
    expect($(".app-brand").getAttribute("href")).toBe("/");
    await click("#login-submit");
    expect(text("#login-error-text")).toBe(en("login.missingHosted"));
    type("#username", "imam@example.org");
    type("#password", "nope");
    await click("#login-submit");
    expect(text("#login-error-text")).toBe(en("login.wrongHosted"));
  });

  it("has no sign-up link while sign-up is closed", async () => {
    server.signupOpen = false;
    await open();
    expect(shown("signup-row")).toBe(false);
  });

  it("sends an owner without a Soniox key to the keys first", async () => {
    server.addUser({ username: "owner", email: "imam@example.org", role: "owner", orgId: "o1" });
    const { nav } = await open();
    await logIn("imam@example.org", "correct-horse");
    expect(server.requests()).toContain("GET /api/org");
    expect(nav.assign).toHaveBeenCalledWith("/app/keys");
  });

  it("sends an owner with a key to the dashboard", async () => {
    server.addUser({ username: "owner", email: "imam@example.org", role: "owner", orgId: "o1" });
    server.soniox = { ...server.soniox, set: true, last4: "abcd", source: "stored" };
    const { nav } = await open();
    await logIn("imam@example.org", "correct-horse");
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  it("goes to the dashboard when the mosque can't be asked", async () => {
    server.addUser({ username: "owner", email: "imam@example.org", role: "owner", orgId: "o1" });
    const { nav } = await open();
    server.once("GET /api/org", { status: 500 });
    await logIn("imam@example.org", "correct-horse");
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  it("never sends a plain account to the keys (it can't add one)", async () => {
    server.addUser({ username: "helper", email: "helper@example.org", role: "user", orgId: "o1" });
    const { nav } = await open();
    await logIn("helper@example.org", "correct-horse");
    expect(server.requests()).not.toContain("GET /api/org");
    expect(nav.assign).toHaveBeenCalledWith("/app");
  });

  it("keeps an explicit ?next= over the keys", async () => {
    server.addUser({ username: "owner", email: "imam@example.org", role: "owner", orgId: "o1" });
    const { nav } = await open("http://localhost:3000/login?next=%2Fapp%2Flook%3Fx%3D1");
    await logIn("imam@example.org", "correct-horse");
    expect(nav.assign).toHaveBeenCalledWith("/app/look?x=1");
  });

  it("sends a logged-in owner without a key straight to the keys", async () => {
    server.login(
      server.addUser({ username: "owner", email: "imam@example.org", role: "owner", orgId: "o1" }),
    );
    const { nav } = await open();
    expect(nav.replace).toHaveBeenCalledWith("/app/keys");
  });

  it("never asks for the first admin (hosted mosques sign up)", async () => {
    server.once("GET /api/auth/state", {
      status: 200,
      body: { setupRequired: true, mode: "hosted", signup: true, loggedIn: false },
    });
    await open();
    expect(shown("login-form")).toBe(true);
    expect(shown("setup-form")).toBe(false);
  });

  it("links the wordmark to the website in the page's language", async () => {
    await open("http://localhost:3000/login", "nl");
    expect($(".app-brand").getAttribute("href")).toBe("/nl");
  });
});

describe("log-in page: languages", () => {
  beforeEach(() => {
    server.addUser({ username: "imam", role: "admin" });
  });

  it("speaks Dutch when the browser chose Dutch", async () => {
    await open("http://localhost:3000/login", "nl");
    expect(document.documentElement.lang).toBe("nl");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toBe(`${message("nl", "login.docTitle")} · Turjuman`);
    expect(text("#username-label")).toBe(message("nl", "login.username"));
    expect(text("#login-submit")).toBe(message("nl", "login.submit"));
    await logIn("imam", "wrong");
    expect(text("#login-error-text")).toBe(message("nl", "login.wrong"));
  });

  it("writes Arabic right to left with the Arabic name", async () => {
    await open("http://localhost:3000/login", "ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.title).toBe(`${message("ar", "login.docTitle")} · ترجمان`);
    expect(text("#forgot")).toContain("turjuman users passwd");
  });

  it("redraws the labels and the message on screen after a language switch", async () => {
    await open();
    await logIn("imam", "wrong");
    expect(text("#login-error-text")).toBe("Wrong username or password.");
    await click('.lang-btn[lang="ar"]');
    expect(document.documentElement.dir).toBe("rtl");
    expect(text("#login-error-text")).toBe(message("ar", "login.wrong"));
    expect(text("#login-submit")).toBe(message("ar", "login.submit"));
    expect(document.title).toBe(`${message("ar", "login.docTitle")} · ترجمان`);
    expect(text("#forgot")).toContain(message("ar", "login.nameArg"));
    expect(localStorage.getItem("tj-app-lang")).toBe("ar");
    await click('.lang-btn[lang="nl"]');
    expect(text("#login-error-text")).toBe(message("nl", "login.wrong"));
  });

  it("switches language while it is still loading", async () => {
    const held = server.hold("GET /api/auth/state");
    await open();
    expect(shown("loading")).toBe(true);
    await click('.lang-btn[lang="nl"]');
    expect(text("#loading")).toBe(message("nl", "common.loading"));
    held.release();
    await settle();
    expect(shown("login-form")).toBe(true);
    expect(text("#username-label")).toBe(message("nl", "login.username"));
  });

  it("redraws the set-up form's message too", async () => {
    server.users = [];
    await open();
    await click("#setup-submit");
    await click('.lang-btn[lang="nl"]');
    expect(text("#setup-error-text")).toBe(message("nl", "setup.badUsername"));
    expect(document.title).toBe(`${message("nl", "setup.docTitle")} · Turjuman`);
  });
});
