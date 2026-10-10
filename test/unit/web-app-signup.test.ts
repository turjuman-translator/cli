// @vitest-environment happy-dom
// The sign-up page (web/signup.ts, hosted mode): a new mosque with its owner, the checks before
// sending, open and closed sign-up, and the server's refusals in the person's own language.
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
  server.mode = "hosted";
  server.org = null;
});
afterEach(cleanup);

function open(lang: "en" | "nl" | "ar" | null = null): Promise<Opened> {
  return openPage("signup", server, () => import("../../web/signup.js"), {
    url: "http://localhost:3000/signup",
    lang,
  });
}

function fill(over: Partial<Record<"org" | "name" | "email" | "password", string>> = {}): void {
  type("#org-name", over.org ?? "  Masjid Al-Noor ");
  type("#your-name", over.name ?? " Imam Ali ");
  type("#email", over.email ?? " imam@example.org ");
  type("#new-password", over.password ?? "a-long-password");
}

const shown = (id: string): boolean => !$(`#${id}`).hidden;

describe("sign-up page", () => {
  it("opens on the form for a logged-out visitor, without asking who is logged in", async () => {
    await open();
    expect(shown("signup-form")).toBe(true);
    expect(shown("signup-closed")).toBe(false);
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
    expect(document.title).toBe("Create an account · Turjuman");
    expect(document.activeElement?.id).toBe("org-name");
    expect($(".app-brand").getAttribute("href")).toBe("/");
  });

  it("ticks the password rule once it has ten characters", async () => {
    await open();
    const rule = $("#password-rule");
    expect(rule.classList.contains("is-met")).toBe(false);
    type("#new-password", "123456789");
    expect(rule.classList.contains("is-met")).toBe(false);
    type("#new-password", "1234567890");
    expect(rule.classList.contains("is-met")).toBe(true);
  });

  it("checks every field in turn before sending", async () => {
    await open();
    const steps: Array<[Parameters<typeof fill>[0], string, string]> = [
      [{ org: "  " }, "signup.errOrg", "org-name"],
      [{ name: "" }, "signup.errName", "your-name"],
      [{ email: "imam@example" }, "signup.errEmail", "email"],
      [{ password: "short pw" }, "signup.errPassword", "new-password"],
    ];
    for (const [over, key, field] of steps) {
      fill(over);
      await click("#signup-submit");
      expect(text("#signup-error-text")).toBe(en(key as Parameters<typeof message>[1]));
      expect(shown("signup-error")).toBe(true);
      expect(document.activeElement?.id).toBe(field);
    }
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("creates the mosque and its owner, then goes to the keys", async () => {
    const { nav } = await open();
    fill();
    const held = server.hold("POST /api/auth/signup");
    await click("#signup-submit");
    const submit = $<HTMLButtonElement>("#signup-submit");
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe(en("signup.busy"));
    held.release();
    await settle();
    expect(server.last("POST /api/auth/signup")?.body).toEqual({
      orgName: "Masjid Al-Noor",
      name: "Imam Ali",
      email: "imam@example.org",
      password: "a-long-password",
      website: "",
    });
    expect(nav.assign).toHaveBeenCalledWith("/app/keys");
    expect(server.me()?.role).toBe("owner");
    expect(shown("signup-error")).toBe(false);
  });

  it("sends the hidden honeypot field as it is (a bot fills it in)", async () => {
    await open();
    fill();
    $<HTMLInputElement>("#website").value = "http://spam.example";
    await click("#signup-submit");
    expect(server.last("POST /api/auth/signup")?.body).toMatchObject({
      website: "http://spam.example",
    });
    expect(text("#signup-error-text")).toBe("Sign-up failed");
  });

  it("says an e-mail address has an account already and puts the cursor there", async () => {
    server.addUser({ username: "x", email: "imam@example.org", role: "owner" });
    await open();
    fill();
    await click("#signup-submit");
    expect(text("#signup-error-text")).toBe(en("signup.errExists"));
    expect(document.activeElement?.id).toBe("email");
    const submit = $<HTMLButtonElement>("#signup-submit");
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe(en("signup.submit"));
  });

  it.each<[string, Reply, string]>([
    [
      "too many sign-ups, with the wait",
      { status: 429, headers: { "Retry-After": "3600" } },
      en("signup.errTooManyIn", { time: "60 minutes" }),
    ],
    ["too many sign-ups", { status: 429 }, en("signup.errTooMany")],
    ["sign-up missing on this server", { status: 404 }, en("signup.unavailable")],
    ["sign-up closed meanwhile", { status: 403, body: { message: "closed" } }, en("signup.closed")],
    ["no connection", "network", en("err.network")],
    [
      "the server's own reason",
      { status: 400, body: { message: "Enter a valid e-mail address" } },
      "Enter a valid e-mail address",
    ],
  ])("explains %s", async (_case, reply, want) => {
    await open();
    fill();
    server.once("POST /api/auth/signup", reply);
    await click("#signup-submit");
    expect(text("#signup-error-text")).toBe(want);
    expect(document.activeElement?.id).not.toBe("email");
  });

  it("explains a navigation the browser refuses", async () => {
    const { nav } = await open();
    nav.assign.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    fill();
    await click("#signup-submit");
    expect(text("#signup-error-text")).toBe(en("err.generic"));
  });

  it("says so when sign-up is closed, without asking who is logged in", async () => {
    server.signupOpen = false;
    await open();
    expect(shown("signup-form")).toBe(false);
    expect(shown("signup-closed")).toBe(true);
    expect(shown("closed-hint")).toBe(true);
    expect(text("#closed-hint")).toBe(en("signup.closedHint"));
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("goes to the dashboard when the visitor is logged in already", async () => {
    server.login(server.addUser({ username: "owner", email: "o@example.org", role: "owner" }));
    const { nav } = await open();
    expect(server.requests()).toEqual(["GET /api/auth/state", "GET /api/auth/me"]);
    expect(nav.replace).toHaveBeenCalledWith("/app");
  });

  it("asks who is logged in when the server's state is unknown, and stays on the form", async () => {
    server.once("GET /api/auth/state", "network");
    const { nav } = await open();
    expect(server.requests()).toEqual(["GET /api/auth/state", "GET /api/auth/me"]);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(shown("signup-form")).toBe(true);
    expect($(".app-brand").getAttribute("href")).toBe("/");
  });

  it("stays on the form when the login check fails", async () => {
    server.login(server.addUser({ username: "owner", email: "o@example.org", role: "owner" }));
    server.once("GET /api/auth/me", { status: 500 });
    const { nav } = await open();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe("org-name");
  });

  it("on a local install the form stays, and the server says there is no sign-up", async () => {
    server.mode = "local";
    server.addUser({ username: "imam", role: "admin" });
    await open();
    expect(shown("signup-form")).toBe(true);
    fill();
    await click("#signup-submit");
    expect(text("#signup-error-text")).toBe(en("signup.unavailable"));
  });

  it("shows and hides the password", async () => {
    await open();
    const toggle = $<HTMLButtonElement>(".pw-toggle");
    await click(toggle);
    expect($<HTMLInputElement>("#new-password").type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");
    await click(toggle);
    expect($<HTMLInputElement>("#new-password").type).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
  });

  it("speaks Arabic right to left and links the wordmark to the Arabic website", async () => {
    await open("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.title).toBe(`${message("ar", "signup.docTitle")} · ترجمان`);
    expect($(".app-brand").getAttribute("href")).toBe("/ar");
    expect(text("#signup-submit")).toBe(message("ar", "signup.submit"));
  });

  it("redraws the message on screen after a language switch", async () => {
    await open();
    fill({ email: "nope" });
    await click("#signup-submit");
    expect(text("#signup-error-text")).toBe(en("signup.errEmail"));
    await click('.lang-btn[lang="nl"]');
    expect(text("#signup-error-text")).toBe(message("nl", "signup.errEmail"));
    expect(document.title).toBe(`${message("nl", "signup.docTitle")} · Turjuman`);
    expect($(".app-brand").getAttribute("href")).toBe("/nl");
  });

  it("redraws the title only when no message is on screen", async () => {
    await open();
    await click('.lang-btn[lang="nl"]');
    expect(document.title).toBe(`${message("nl", "signup.docTitle")} · Turjuman`);
    expect(shown("signup-error")).toBe(false);
  });
});
