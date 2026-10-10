// @vitest-environment happy-dom
// The keys page (web/keys.ts, /app/keys): onboarding while the Soniox key is missing, adding a
// key (checked, unchecked or rejected), replacing and removing it, the server's own .env key,
// read-only accounts, this month's usage and where to go next, in English, Dutch and Arabic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "../../web/shared/app-i18n.js";
import {
  $,
  $$,
  buttonByText,
  cleanup,
  click,
  fakeTimers,
  type Opened,
  openPage,
  settle,
  text,
  toastText,
  type,
} from "./helpers/web-app-page.js";
import { FakeServer, type FakeUser, type Reply } from "./helpers/web-app-server.js";

type Key = Parameters<typeof message>[1];
const en = (key: Key, vars?: Record<string, string | number>) => message("en", key, vars);

const KEY = "sk_live_0123456789abcdef";
const CHECKED_AT = "2026-10-09T10:00:00.000Z";
const checkedTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

let server: FakeServer;
let owner: FakeUser;

beforeEach(() => {
  fakeTimers();
  server = new FakeServer();
  server.mode = "hosted";
  server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 12.4, estimateUsd: 0.37 } };
  owner = server.addUser({
    username: "owner",
    displayName: "Imam Ali",
    email: "imam@example.org",
    role: "owner",
    orgId: "o1",
  });
  server.login(owner);
});
afterEach(cleanup);

function open(lang: "en" | "nl" | "ar" | null = null): Promise<Opened> {
  return openPage("keys", server, () => import("../../web/keys.js"), {
    url: "http://localhost:3000/app/keys",
    lang,
  });
}

const shown = (sel: string): boolean => !$(sel).hidden;
const slot = (): HTMLElement => $("#kx-soniox");
const input = (): HTMLInputElement => $<HTMLInputElement>("#key-soniox");

async function save(key: string): Promise<void> {
  type(input(), key);
  await click(buttonByText(en("keys.save"), slot()));
}

function stored(over: Partial<FakeServer["soniox"]> = {}): void {
  server.soniox = {
    provider: "soniox",
    set: true,
    last4: "cdef",
    validatedAt: CHECKED_AT,
    source: "stored",
    ...over,
  };
}

describe("keys page: getting there", () => {
  it("sends a logged-out visitor to log in, without asking who is logged in", async () => {
    server.session = null;
    const { nav } = await open();
    expect(nav.replace).toHaveBeenCalledWith("/login?next=%2Fapp%2Fkeys");
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("explains when the account can't be loaded", async () => {
    server.once("GET /api/auth/me", { status: 500, body: { message: "Internal server error" } });
    await open();
    expect(shown("#keys-loading")).toBe(false);
    expect(shown("#keys-error")).toBe(true);
    expect(text("#keys-error-text")).toBe(en("keys.loadFailed", { msg: en("err.500") }));
    expect($$("#providers > *")).toHaveLength(0);
  });

  it("sends the visitor to log in when the login expired meanwhile", async () => {
    server.once("GET /api/org", { status: 401 });
    const { nav } = await open();
    expect(nav.replace).toHaveBeenCalledWith("/login?next=%2Fapp%2Fkeys");
  });

  it("explains when the keys can't be loaded", async () => {
    server.once("GET /api/org", "network");
    await open();
    expect(text("#keys-error-text")).toBe(en("keys.loadFailed", { msg: en("err.network") }));
    expect(shown("#keys-loading")).toBe(false);
    expect(shown("#next")).toBe(false);
  });

  it("says so on a server without keys in the app", async () => {
    server.org = null;
    await open();
    expect(text("#keys-error-text")).toBe(en("keys.unavailable"));
    expect(shown("#keys-lead")).toBe(false);
    expect(shown("#usage")).toBe(false);
  });

  it("marks Keys in the header and shows the account", async () => {
    await open();
    expect(document.title).toBe("Keys · Turjuman");
    expect($('a[data-nav="keys"]').getAttribute("aria-current")).toBe("page");
    expect(text(".acct-name")).toBe("Imam Ali");
    // Hosted: the footer has no links to the server's own tools.
    expect($$("#app-foot a")).toHaveLength(0);
    expect(text("#app-foot")).toBe(en("foot.free"));
  });
});

describe("keys page: adding the Soniox key", () => {
  it("shows the steps to get a key and puts the cursor in the field", async () => {
    await open();
    expect(text("#keys-lead")).toBe(en("keys.leadNew"));
    expect(text(".kx-title", slot())).toBe("Soniox key");
    expect(text(".kx-need", slot())).toBe("Required");
    const steps = $$("ol.kx-steps li", slot()).map((li) => (li.textContent ?? "").trim());
    expect(steps).toEqual([
      "Create an account at console.soniox.com.",
      en("keys.sonioxStep2"),
      en("keys.sonioxStep3"),
      en("keys.stepPaste"),
    ]);
    const link = $<HTMLAnchorElement>("ol.kx-steps a", slot());
    expect(link.href).toBe("https://console.soniox.com/");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(document.activeElement).toBe(input());
    expect(input().type).toBe("password");
    expect(input().placeholder).toBe("Paste your key");
    expect(text("label.ui-sr-only", slot())).toBe("Soniox key");
    expect(text(".kx-enc", slot())).toBe(en("keys.encrypted"));
    expect(shown("#usage")).toBe(false);
    expect(text("#next-text")).toBe(en("keys.nextLater"));
    const next = $<HTMLAnchorElement>("#next-link");
    expect(next.textContent).toBe("Go to your screens");
    expect(next.getAttribute("href")).toBe("/app");
    expect(next.className).toBe("ui-btn ui-btn-secondary");
  });

  it.each<[string, string, Key]>([
    ["nothing pasted", "   ", "keys.pasteFirst"],
    ["a key cut short", "sk_live_012", "keys.tooShort"],
    ["far too much text", "k".repeat(513), "keys.tooLong"],
    ["spaces in it", "sk live 0123456789 abcdef", "keys.badChars"],
  ])("checks the key's shape before sending: %s", async (_case, key, want) => {
    await open();
    await save(key);
    expect(text(".kx-result.is-error", slot())).toBe(en(want));
    expect(document.activeElement).toBe(input());
    expect(server.requests()).not.toContain("PUT /api/org/keys/soniox");
  });

  it("checks the key with Soniox, says so meanwhile, and shows it working", async () => {
    await open();
    type(input(), `  ${KEY} `);
    const held = server.hold("PUT /api/org/keys/soniox");
    await click(buttonByText("Save", slot()));
    const busy = buttonByText("Checking…", slot());
    expect(busy.disabled).toBe(true);
    held.release();
    await settle();
    const put = server.last("PUT /api/org/keys/soniox");
    expect(put?.body).toEqual({ key: KEY });
    expect(put?.headers["content-type"]).toBe("application/json");
    expect(toastText()).toBe("Key saved");
    expect(text(".kf-mask", slot())).toBe("••••••••••••cdef");
    expect(text(".kf-state.is-ok", slot())).toBe(
      en("keys.works", { when: checkedTime(CHECKED_AT) }),
    );
    expect($$(".kx-result", slot())).toHaveLength(0);
    expect($$("ol.kx-steps", slot())).toHaveLength(0);
    expect(buttonByText("Replace", slot())).toBeTruthy();
    expect(buttonByText("Remove", slot())).toBeTruthy();
    // Usage and the next step follow the key.
    expect(text("#keys-lead")).toBe(en("keys.lead"));
    expect(shown("#usage")).toBe(true);
    expect(text("#usage-minutes")).toBe("12 minutes");
    expect(text("#usage-cost")).toBe("About $0.37 at Soniox list prices");
    const next = $<HTMLAnchorElement>("#next-link");
    expect(next.textContent).toBe("Create your first screen");
    expect(next.getAttribute("href")).toBe("/app/new");
    expect(next.className).toBe("ui-btn ui-btn-primary");
    expect(text("#next-text")).toBe(en("keys.nextFirstHint"));
    // The toast goes away by itself.
    await vi.advanceTimersByTimeAsync(2600);
    expect(toastText()).toBe("");
  });

  it("sends to the dashboard once screens exist", async () => {
    server.addScreen({ name: "Hall", owner: { id: owner.id, displayName: "Imam Ali" } });
    await open();
    await save(KEY);
    expect(text("#next-link")).toBe("Go to your screens");
    expect($("#next-link").getAttribute("href")).toBe("/app");
    expect(shown("#next-text")).toBe(false);
  });

  it("sends a key once, however often the form is sent while it is checked", async () => {
    await open();
    type(input(), KEY);
    const held = server.hold("PUT /api/org/keys/soniox");
    await click(buttonByText("Save", slot()));
    $<HTMLFormElement>("form.kx-form", slot()).requestSubmit();
    await settle();
    held.release();
    await settle();
    expect(server.requests().filter((r) => r === "PUT /api/org/keys/soniox")).toHaveLength(1);
  });

  it.each<[string, string, string]>([
    [
      "Soniox couldn't be reached",
      "Soniox could not be reached; the key was not checked.",
      en("keys.unreachable", { provider: "Soniox" }),
    ],
    [
      "Soniox answered with an error",
      "Soniox answered HTTP 503; the key was not checked.",
      en("keys.uncheckedHttp", { provider: "Soniox", status: "503" }),
    ],
    [
      "something else",
      "the check timed out",
      en("keys.notChecked", { warning: "the check timed out" }),
    ],
  ])("stores a key it couldn't check and says why: %s", async (_case, warning, want) => {
    server.keyCheck = () => ({ result: "unchecked", message: warning });
    await open();
    await save(KEY);
    expect(text(".kx-result.is-warn", slot())).toBe(want);
    expect(text(".kf-state.is-warn", slot())).toBe(en("keys.storedUnchecked"));
    expect(toastText()).toBe("");
  });

  it("says a stored key is not checked when the server gave no reason", async () => {
    await open();
    server.once("PUT /api/org/keys/soniox", {
      status: 200,
      body: {
        status: {
          provider: "soniox",
          set: true,
          last4: "cdef",
          validatedAt: null,
          source: "stored",
        },
        checked: false,
      },
    });
    await save(KEY);
    expect(text(".kx-result.is-warn", slot())).toBe(en("keys.storedUnchecked"));
  });

  it("says the server's .env key wins while it is set", async () => {
    server.envKey = true;
    await open();
    await save(KEY);
    expect(text(".kx-result.is-warn", slot())).toBe(en("keys.envWins", { name: "SONIOX_API_KEY" }));
    expect(text(".kf-env", slot())).toBe("Set on the server");
    expect(text(".kf-mask", slot())).toBe("••••cdef");
    expect(text(".kx-muted", slot())).toBe(en("keys.envHint"));
  });

  it("says Soniox refused the key, keeps what was typed, and takes the corrected key", async () => {
    server.keyCheck = (key) =>
      key === KEY
        ? { result: "rejected", message: "Soniox did not accept this key (HTTP 401)." }
        : { result: "ok" };
    await open();
    await save(KEY);
    expect(text(".kx-result.is-error", slot())).toBe(
      `${en("keys.rejected", { provider: "Soniox" })} (HTTP 401)`,
    );
    expect(input().value).toBe(KEY);
    expect(buttonByText("Save", slot()).disabled).toBe(false);
    expect(server.soniox.set).toBe(false);

    await save(`${KEY}9`);
    expect(toastText()).toBe("Key saved");
    expect(text(".kf-mask", slot())).toBe("••••••••••••def9");
    expect(server.requests().filter((r) => r === "PUT /api/org/keys/soniox")).toHaveLength(2);
  });

  it.each<[string, Reply, string]>([
    ["a refusal without a reason", { status: 400 }, en("keys.rejected", { provider: "Soniox" })],
    [
      "the server's own rule",
      { status: 400, body: { message: "Key: 16–512 printable characters." } },
      "Key: 16–512 printable characters.",
    ],
    [
      "too many checks",
      { status: 429, headers: { "Retry-After": "3600" } },
      message("en", "login.tooMany", { time: "60 minutes" }),
    ],
    [
      "a broken master key",
      {
        status: 500,
        body: { message: "This server cannot store keys: its master key is not valid" },
      },
      "This server cannot store keys: its master key is not valid",
    ],
    [
      "an internal error",
      { status: 500, body: { message: "Internal server error" } },
      en("err.500"),
    ],
    ["no connection", "network", en("err.network")],
  ])("explains %s", async (_case, reply, want) => {
    await open();
    server.once("PUT /api/org/keys/soniox", reply);
    await save(KEY);
    expect(text(".kx-result.is-error", slot())).toBe(want);
  });

  it("sends the visitor to log in when the login expired while saving", async () => {
    const { nav } = await open();
    server.once("PUT /api/org/keys/soniox", { status: 401 });
    await save(KEY);
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%2Fkeys");
  });

  it("onboards with the key status missing from an older server's answer", async () => {
    server.once("GET /api/org", {
      status: 200,
      body: {
        id: "o1",
        name: "Al-Noor",
        mode: "hosted",
        role: "owner",
        keys: {},
        usage: { monthMinutes: 0, estimateUsd: null },
      },
    });
    await open();
    expect($$("ol.kx-steps li", slot())).toHaveLength(4);
    expect(document.activeElement).toBe(input());
  });
});

describe("keys page: a stored key", () => {
  beforeEach(() => stored());

  it("shows the key masked with when it last worked, and this month's usage", async () => {
    await open();
    expect(text(".kf-mask", slot())).toBe("••••••••••••cdef");
    expect(text(".kf-state", slot())).toBe(en("keys.works", { when: checkedTime(CHECKED_AT) }));
    expect(text("#keys-lead")).toBe(en("keys.lead"));
    expect(text("#usage-minutes")).toBe("12 minutes");
    expect(document.activeElement).not.toBe($$("input", slot())[0] ?? null);
    expect($$("input", slot())).toHaveLength(0);
  });

  it("shows a check time it can't read as the server wrote it", async () => {
    stored({ validatedAt: "yesterday" });
    await open();
    expect(text(".kf-state", slot())).toBe(en("keys.works", { when: "yesterday" }));
  });

  it("leaves the cost out when there is no estimate", async () => {
    server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 1, estimateUsd: null } };
    await open();
    expect(text("#usage-minutes")).toBe("1 minute");
    expect(shown("#usage-cost")).toBe(false);
  });

  it("replaces the key, or cancels and forgets what was typed", async () => {
    await open();
    await click(buttonByText("Replace", slot()));
    expect(document.activeElement).toBe(input());
    type(input(), "half-typed");
    await click(buttonByText("Cancel", slot()));
    expect($$("input", slot())).toHaveLength(0);
    await click(buttonByText("Replace", slot()));
    expect(input().value).toBe("");

    await save("sk_live_9999999999999999wxyz");
    expect(text(".kf-mask", slot())).toBe("••••••••••••wxyz");
    expect(toastText()).toBe("Key saved");
  });

  it("asks before removing, and cancelling goes back to the Remove button", async () => {
    await open();
    await click(buttonByText("Remove", slot()));
    const confirm = $(".kx-confirm", slot());
    expect(confirm.getAttribute("role")).toBe("alert");
    expect(text("p", confirm)).toBe(en("keys.removeSoniox"));
    expect(document.activeElement).toBe(buttonByText("Cancel", slot()));
    await click(buttonByText("Cancel", slot()));
    expect($$(".kx-confirm", slot())).toHaveLength(0);
    expect(document.activeElement).toBe($(".kx-remove", slot()));
    expect(server.requests()).not.toContain("DELETE /api/org/keys/soniox");
  });

  it("removes the key and starts the onboarding again", async () => {
    await open();
    await click(buttonByText("Remove", slot()));
    const held = server.hold("DELETE /api/org/keys/soniox");
    const yes = buttonByText("Yes, remove", slot());
    await click(yes);
    expect(buttonByText("Yes, remove", slot()).disabled).toBe(true);
    await click(yes); // a second tap while it runs does nothing
    held.release();
    await settle();
    expect(server.requests().filter((r) => r === "DELETE /api/org/keys/soniox")).toHaveLength(1);
    expect(toastText()).toBe("Key removed");
    expect($$("ol.kx-steps li", slot())).toHaveLength(4);
    expect(text("#keys-lead")).toBe(en("keys.leadNew"));
    expect(shown("#usage")).toBe(false);
    expect(text("#next-text")).toBe(en("keys.nextLater"));
  });

  it("treats an empty answer to a removal as no key", async () => {
    await open();
    server.once("DELETE /api/org/keys/soniox", { status: 204 });
    await click(buttonByText("Remove", slot()));
    await click(buttonByText("Yes, remove", slot()));
    expect($$("ol.kx-steps li", slot())).toHaveLength(4);
  });

  it("keeps the key and explains when removing fails", async () => {
    await open();
    server.once("DELETE /api/org/keys/soniox", { status: 503 });
    await click(buttonByText("Remove", slot()));
    await click(buttonByText("Yes, remove", slot()));
    expect(text(".kx-result.is-error", slot())).toBe(en("err.500"));
    expect(text(".kf-mask", slot())).toBe("••••••••••••cdef");
    expect($$(".kx-confirm", slot())).toHaveLength(0);
    // Replace clears the message.
    await click(buttonByText("Replace", slot()));
    expect($$(".kx-result", slot())).toHaveLength(0);
  });

  it("sends the visitor to log in when the login expired while removing", async () => {
    const { nav } = await open();
    server.once("DELETE /api/org/keys/soniox", { status: 401 });
    await click(buttonByText("Remove", slot()));
    await click(buttonByText("Yes, remove", slot()));
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%2Fkeys");
  });

  it("shows only dots for a key whose last characters the server didn't send", async () => {
    stored({ last4: null });
    await open();
    expect(text(".kf-mask", slot())).toBe("••••••••••••");
  });

  it("says the .env key wins even when the server didn't name it", async () => {
    await open();
    server.once("PUT /api/org/keys/soniox", {
      status: 200,
      body: {
        status: { provider: "soniox", set: true, last4: "wxyz", validatedAt: null, source: "env" },
        checked: true,
        warning: "A key in the server's .env is used",
      },
    });
    await click(buttonByText("Replace", slot()));
    await save(KEY);
    expect(text(".kx-result.is-warn", slot())).toBe(en("keys.envWins", { name: "SONIOX_API_KEY" }));
  });

  it("says a key stored without a check is not checked yet", async () => {
    stored({ validatedAt: null });
    await open();
    expect(text(".kf-state.is-warn", slot())).toBe(en("keys.storedUnchecked"));
  });
});

describe("keys page: the server's own key and other accounts", () => {
  it("shows a key from the server's .env as set there, without changes", async () => {
    stored({ source: "env", last4: null, validatedAt: null });
    server.mode = "local";
    await open();
    expect(text(".kf-env", slot())).toBe("Set on the server");
    expect($$(".kf-mask", slot())).toHaveLength(0);
    expect(text(".kx-muted", slot())).toBe(en("keys.envHint"));
    expect($$("button", slot())).toHaveLength(0);
    expect($$(".kx-enc", slot())).toHaveLength(0);
  });

  it("tells a local install where its keys live, and links the server's tools", async () => {
    server.mode = "local";
    await open();
    expect(text(".kx-enc", slot())).toBe(en("keys.encryptedLocal"));
    expect($$("#app-foot a").map((a) => a.getAttribute("href"))).toEqual([
      "/control",
      "/overlay",
      "/health",
    ]);
  });

  it("shows a plain account the key without changing it", async () => {
    stored();
    server.login(server.addUser({ username: "helper", role: "user", orgId: "o1" }));
    await open();
    expect(text(".kf-mask", slot())).toBe("••••••••••••cdef");
    expect(text(".kx-muted", slot())).toBe(en("keys.readOnly"));
    expect($$("button", slot())).toHaveLength(0);
  });

  it("tells a plain account the key is missing and who can add it", async () => {
    server.login(server.addUser({ username: "helper", role: "user", orgId: "o1" }));
    await open();
    expect($$(".kx-muted", slot()).map((p) => p.textContent)).toEqual([
      en("keys.notSet"),
      en("keys.readOnly"),
    ]);
    expect($$("input", slot())).toHaveLength(0);
    expect(document.activeElement?.id).not.toBe("key-soniox");
  });

  it("counts no screens when the screens can't be listed", async () => {
    stored();
    server.addScreen({ name: "Hall" });
    server.once("GET /api/screens", { status: 500 });
    await open();
    expect($("#next-link").getAttribute("href")).toBe("/app/new");
  });

  it("counts no screens from an answer that isn't a list", async () => {
    stored();
    server.once("GET /api/screens", { status: 200, body: { screens: [] } });
    await open();
    expect($("#next-link").getAttribute("href")).toBe("/app/new");
  });
});

describe("keys page: languages", () => {
  it("speaks Dutch", async () => {
    await open("nl");
    expect(document.title).toBe(`${message("nl", "keys.docTitle")} · Turjuman`);
    expect(text("#keys-lead")).toBe(message("nl", "keys.leadNew"));
    expect(text(".kx-title", slot())).toBe(message("nl", "keys.sonioxTitle"));
  });

  it("writes Arabic right to left, with the amount kept left to right", async () => {
    stored();
    await open("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(text("#usage-cost")).toBe(message("ar", "keys.usageCost", { usd: "⁦$0.37⁩" }));
  });

  it("keeps a half-typed key and the message on screen through a language switch", async () => {
    await open();
    await save("too-short");
    type(input(), "sk_live_half");
    await click('.lang-btn[lang="nl"]');
    expect(input().value).toBe("sk_live_half");
    expect(text(".kx-result", slot())).toBe(message("nl", "keys.tooShort"));
    expect(buttonByText(message("nl", "keys.save"), slot())).toBeTruthy();
    expect(document.title).toBe(`${message("nl", "keys.docTitle")} · Turjuman`);
  });

  it("redraws a load failure in the new language", async () => {
    server.org = null;
    await open();
    await click('.lang-btn[lang="ar"]');
    expect(text("#keys-error-text")).toBe(message("ar", "keys.unavailable"));
  });
});
