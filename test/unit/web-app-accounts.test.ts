// @vitest-environment happy-dom
// The dashboard's accounts and settings (web/admin.ts, /app#accounts and /app#settings): the list
// of accounts, adding one (username or e-mail), a new password shown once, disabling, roles and
// deleting; the server's "only screen links" setting; and a hosted mosque's name and deletion.
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
  sheet,
  text,
  toastText,
  type,
} from "./helpers/web-app-page.js";
import { FakeServer, type FakeUser } from "./helpers/web-app-server.js";

type Key = Parameters<typeof message>[1];
const en = (key: Key, vars?: Record<string, string | number>) => message("en", key, vars);

let server: FakeServer;
let admin: FakeUser;

beforeEach(() => {
  fakeTimers();
  server = new FakeServer();
  admin = server.addUser({ username: "imam", displayName: "Imam Ali", role: "admin" });
  server.login(admin);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "isSecureContext");
});

function open(hash = "#accounts", lang: "en" | "nl" | "ar" | null = null): Promise<Opened> {
  return openPage("admin", server, () => import("../../web/admin.js"), {
    url: `http://localhost:3000/app${hash}`,
    lang,
  });
}

function hosted(): void {
  server.mode = "hosted";
  server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 0, estimateUsd: 0 } };
  for (const u of server.users) u.orgId = "o1";
}

function userCard(name: string): HTMLElement {
  const found = $$(".user-card").find((c) => text(".uc-name", c) === name);
  if (!found) throw new Error(`no account ${name}`);
  return found;
}

const accountNames = (): string[] => $$(".user-card").map((c) => text(".uc-name", c));
const shown = (sel: string, root: ParentNode = document): boolean => !$(sel, root).hidden;

function action(label: string): HTMLButtonElement {
  const b = $$<HTMLButtonElement>(".ui-sheet-action", sheet()).find(
    (x) => text(".ui-sheet-action-label", x) === label,
  );
  if (!b) throw new Error(`no action "${label}"`);
  return b;
}

async function more(name: string, label: string): Promise<void> {
  await click($(".sc-more", userCard(name)));
  await click(action(label));
}

describe("accounts: the list", () => {
  it("shows every account with its role, login and facts, and actions for the others", async () => {
    const at = new Date("2026-10-02T09:30:00Z").getTime();
    server.addUser({
      username: "yusuf",
      displayName: "Yusuf",
      role: "admin",
      lastLoginAt: at,
      screens: 2,
    });
    server.addUser({ username: "omar", role: "user", disabled: true, screens: 1 });
    await open();
    expect(shown("#panel-accounts")).toBe(true);
    expect(document.title).toBe("Accounts · Turjuman");
    expect(accountNames()).toEqual(["Imam Ali", "Yusuf", "omar"]);

    const me = userCard("Imam Ali");
    expect(text(".uc-role", me)).toBe("Admin");
    expect(text(".uc-you", me)).toBe("You");
    expect(text(".uc-login", me)).toBe("@imam");
    expect(text(".uc-meta", me)).toBe("0 screens");
    expect($$("button", me)).toHaveLength(0);
    expect(text(".avatar", me)).toBe("I");

    const yusuf = userCard("Yusuf");
    const when = new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    expect(text(".uc-meta", yusuf)).toContain("2 screens");
    expect(text(".uc-meta", yusuf)).toContain(`Last login ${when}, `);
    expect($$("button", yusuf).map((b) => (b.textContent ?? "").trim())).toEqual([
      "Reset password",
      "Disable",
      "",
    ]);
    expect($(".sc-more", yusuf).getAttribute("aria-label")).toBe("More for @yusuf");

    const omar = userCard("omar");
    expect(omar.classList.contains("is-disabled")).toBe(true);
    expect(text(".uc-off", omar)).toBe("Disabled");
    expect(text(".uc-meta", omar)).toBe("1 screenNever logged in");
    expect(buttonByText("Enable", omar)).toBeTruthy();
  });

  it("leaves the owner alone: no actions on the person who signed up", async () => {
    hosted();
    server.addUser({
      username: "owner",
      displayName: "Owner",
      role: "owner",
      email: "o@example.org",
      orgId: "o1",
    });
    await open();
    const owner = userCard("Owner");
    expect(text(".uc-role", owner)).toBe("Owner");
    expect(text(".uc-login", owner)).toBe("o@example.org");
    expect($$("button", owner)).toHaveLength(0);
  });

  it("explains when the accounts can't be loaded, and reads an odd answer as none", async () => {
    server.once("GET /api/users", { status: 500, body: { message: "Internal server error" } });
    await open();
    expect(text("#users-error-text")).toBe(en("err.500"));
    expect(shown("#users-error")).toBe(true);
    server.once("GET /api/users", { status: 200, body: { users: [] } });
    window.dispatchEvent(new Event("hashchange"));
    await settle();
    expect(shown("#users-error")).toBe(false);
    expect(accountNames()).toEqual([]);
  });

  it("goes to log in when the login expired", async () => {
    server.once("GET /api/users", { status: 401 });
    const { nav } = await open();
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%23accounts");
    expect(shown("#users-error")).toBe(false);
  });
});

describe("accounts: adding one", () => {
  async function openAdd(): Promise<HTMLDialogElement> {
    await click("#add-user");
    return sheet();
  }

  it("creates an account with a generated password and shows it once", async () => {
    await open();
    const s = await openAdd();
    expect(text(".ui-sheet-title", s)).toBe("Add account");
    expect(document.activeElement?.id).toBe("nu-name");
    expect($<HTMLInputElement>("#nu-username", s).type).toBe("text");
    const pw = $<HTMLInputElement>("#nu-password", s);
    expect(pw.value).toMatch(/^\w{5}-\w{5}-\w{4}$/);
    const first = pw.value;
    await click(buttonByText("Generate", s));
    expect(pw.value).not.toBe(first);
    expect(document.activeElement).toBe(pw);

    type("#nu-name", " Yusuf ");
    type("#nu-username", " yusuf ");
    $<HTMLInputElement>('input[name="nu-role"][value="admin"]', s).checked = true;
    const password = pw.value;
    await click(buttonByText("Create account", s));
    expect(server.last("POST /api/users")?.body).toEqual({
      username: "yusuf",
      password,
      role: "admin",
      displayName: "Yusuf",
    });
    expect(text(".once-title", s)).toBe("Account created");
    expect($$(".once-creds dt", s).map((d) => d.textContent)).toEqual(["Username", "Password"]);
    expect(text(".once-pw", s)).toBe(password);
    expect(accountNames()).toEqual(["Imam Ali", "Yusuf"]);

    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await click(buttonByText("Copy", s));
    expect(write).toHaveBeenCalledWith(
      `Username: yusuf\nPassword: ${password}\nLog in: http://localhost:3000/login`,
    );
    expect(toastText()).toBe("Copied");
    write.mockRejectedValueOnce(new Error("denied"));
    await click(buttonByText("Copy", s));
    expect(toastText()).toBe(en("acc.onceCopyFailed"));
    await click(buttonByText("Done", s));
    expect(s.isConnected).toBe(false);
  });

  it("checks the username and the password length first", async () => {
    await open();
    const s = await openAdd();
    type("#nu-username", "y");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.badUsername"));
    type("#nu-username", "yusuf");
    type("#nu-password", "1234567");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.shortPassword", { n: 8 }));
    expect(server.requests()).not.toContain("POST /api/users");
    // An account as a plain user, without a name.
    type("#nu-password", "12345678");
    await click(buttonByText("Create account", s));
    expect(server.last("POST /api/users")?.body).toEqual({
      username: "yusuf",
      password: "12345678",
      role: "user",
    });
  });

  it("says a username is taken, and explains other failures", async () => {
    server.addUser({ username: "yusuf" });
    await open();
    const s = await openAdd();
    type("#nu-username", "yusuf");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.usernameTaken"));
    expect(document.activeElement?.id).toBe("nu-username");
    expect($<HTMLButtonElement>('button[type="submit"]', s).disabled).toBe(false);
    server.once("POST /api/users", { status: 429, headers: { "Retry-After": "60" } });
    type("#nu-username", "omar");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe("Too many attempts. Try again in a minute.");
  });

  it("goes to log in when the login expired", async () => {
    const { nav } = await open();
    const s = await openAdd();
    server.once("POST /api/users", { status: 401 });
    type("#nu-username", "omar");
    await click(buttonByText("Create account", s));
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%23accounts");
    expect($(".ui-field-error", s).hidden).toBe(true);
  });

  it("cancels without sending anything", async () => {
    await open();
    const s = await openAdd();
    await click(buttonByText("Cancel", s));
    expect(s.isConnected).toBe(false);
    expect(server.requests()).not.toContain("POST /api/users");
  });

  it("adds a hosted account by e-mail with ten characters at least", async () => {
    hosted();
    await open();
    const s = await openAdd();
    expect($<HTMLInputElement>("#nu-username", s).type).toBe("email");
    expect(text('label[for="nu-username"]', s)).toBe("E-mail");
    type("#nu-username", "yusuf@example");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.badEmail"));
    type("#nu-username", "yusuf@example.org");
    type("#nu-password", "123456789");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.shortPassword", { n: 10 }));
    type("#nu-password", "1234567890");
    await click(buttonByText("Create account", s));
    expect(server.last("POST /api/users")?.body).toEqual({
      email: "yusuf@example.org",
      password: "1234567890",
      role: "user",
    });
    expect($$(".once-creds dt", s).map((d) => d.textContent)).toEqual(["E-mail", "Password"]);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await click(buttonByText("Copy", s));
    expect(write.mock.calls[0]?.[0]).toMatch(/^E-mail: yusuf@example\.org\n/);
  });

  it("says an e-mail address can't be used", async () => {
    hosted();
    server.addUser({ username: "x", email: "yusuf@example.org", orgId: "elsewhere" });
    await open();
    const s = await openAdd();
    type("#nu-username", "yusuf@example.org");
    type("#nu-password", "1234567890");
    await click(buttonByText("Create account", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.emailTaken"));
  });

  it("reloads the list when the server answers without the account", async () => {
    await open();
    const s = await openAdd();
    server.once("POST /api/users", { status: 201 });
    type("#nu-username", "omar");
    await click(buttonByText("Create account", s));
    expect(server.requests().filter((r) => r === "GET /api/users")).toHaveLength(2);
  });
});

describe("accounts: changing one", () => {
  let yusuf: FakeUser;
  beforeEach(() => {
    yusuf = server.addUser({ username: "yusuf", displayName: "Yusuf", role: "user", screens: 2 });
  });

  it("sets a new password and shows it once", async () => {
    await open();
    await click(buttonByText("Reset password", userCard("Yusuf")));
    const s = sheet();
    expect(text(".ui-sheet-text", s)).toBe(en("acc.resetText", { name: "@yusuf" }));
    const pw = $<HTMLInputElement>("#rp-password", s);
    // The generated password is selected, to type over or to copy.
    expect([pw.selectionStart, pw.selectionEnd]).toEqual([0, pw.value.length]);
    type(pw, "short");
    await click(buttonByText("Set password", s));
    expect(text(".ui-field-error", s)).toBe(en("acc.shortPassword", { n: 8 }));
    type(pw, "a-new-password");
    await click(buttonByText("Set password", s));
    expect(server.last(`PATCH /api/users/${yusuf.id}`)?.body).toEqual({
      password: "a-new-password",
    });
    expect(yusuf.password).toBe("a-new-password");
    expect(text(".once-title", s)).toBe("New password set");
    expect($$(".once-creds dd", s).map((d) => d.textContent)).toEqual(["yusuf", "a-new-password"]);
  });

  it("explains a failed password change, or goes to log in", async () => {
    const { nav } = await open();
    await click(buttonByText("Reset password", userCard("Yusuf")));
    const s = sheet();
    server.once(`PATCH /api/users/${yusuf.id}`, {
      status: 400,
      body: { message: "Password: too common" },
    });
    await click(buttonByText("Set password", s));
    expect(text(".ui-field-error", s)).toBe("Password: too common");
    expect($<HTMLButtonElement>('button[type="submit"]', s).disabled).toBe(false);
    server.once(`PATCH /api/users/${yusuf.id}`, { status: 401 });
    await click(buttonByText("Set password", s));
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%23accounts");
    await click(buttonByText("Cancel", s));
    expect(s.isConnected).toBe(false);
  });

  it("disables an account after asking, and enables it without asking", async () => {
    await open();
    await click(buttonByText("Disable", userCard("Yusuf")));
    expect(text(".ui-sheet-title", sheet())).toBe("Disable @yusuf?");
    await click(buttonByText("Cancel", sheet()));
    expect(yusuf.disabled).toBe(false);
    await click(buttonByText("Disable", userCard("Yusuf")));
    await click(buttonByText("Disable", sheet()));
    expect(server.last(`PATCH /api/users/${yusuf.id}`)?.body).toEqual({ disabled: true });
    expect(toastText()).toBe("Account disabled");
    expect(userCard("Yusuf").classList.contains("is-disabled")).toBe(true);
    await click(buttonByText("Enable", userCard("Yusuf")));
    expect(server.last(`PATCH /api/users/${yusuf.id}`)?.body).toEqual({ disabled: false });
    expect(toastText()).toBe("Account enabled");
    expect($$("dialog[open]")).toHaveLength(0);
  });

  it("makes an account an admin and a user again", async () => {
    await open();
    await more("Yusuf", "Make admin");
    expect(server.last(`PATCH /api/users/${yusuf.id}`)?.body).toEqual({ role: "admin" });
    expect(toastText()).toBe("@yusuf is now an admin");
    expect(text(".uc-role", userCard("Yusuf"))).toBe("Admin");
    await more("Yusuf", "Make user");
    expect(toastText()).toBe("@yusuf is now a user");
  });

  it("deletes an account after asking; its screens move to the admin", async () => {
    await open();
    await more("Yusuf", "Delete");
    expect(text(".ui-sheet-text", sheet())).toBe(`Their 2 screens move to you. ${en("acc.undo")}`);
    await click(buttonByText("Cancel", sheet()));
    expect(accountNames()).toContain("Yusuf");
    await more("Yusuf", "Delete");
    const screensBefore = server.requests().filter((r) => r === "GET /api/screens").length;
    await click(buttonByText("Delete", sheet()));
    expect(server.requests()).toContain(`DELETE /api/users/${yusuf.id}`);
    expect(accountNames()).toEqual(["Imam Ali"]);
    expect(toastText()).toBe("Account deleted");
    expect(server.requests().filter((r) => r === "GET /api/screens").length).toBe(
      screensBefore + 1,
    );
  });

  it("names an account without a name by its username", async () => {
    server.addUser({ username: "omar" });
    await open();
    await click($(".sc-more", userCard("omar")));
    expect(text(".ui-sheet-title", sheet())).toBe("omar");
    expect(text(".avatar", userCard("omar"))).toBe("O");
  });

  it("asks only 'can't be undone' for an account without screens", async () => {
    yusuf.screens = 0;
    await open();
    await more("Yusuf", "Delete");
    expect(text(".ui-sheet-text", sheet())).toBe(en("acc.undo"));
  });

  it.each([
    ["Disable", (name: string) => click(buttonByText("Disable", userCard(name))), "Disable"],
    ["Make admin", (name: string) => more(name, "Make admin"), null],
    ["Delete", (name: string) => more(name, "Delete"), "Delete"],
  ] as const)("explains a failed %s, or goes to log in", async (_label, start, confirm) => {
    const { nav } = await open();
    const route = `${_label === "Delete" ? "DELETE" : "PATCH"} /api/users/${yusuf.id}`;
    server.once(route, {
      status: 403,
      body: { message: "Only the owner can change the owner's account" },
    });
    await start("Yusuf");
    if (confirm) await click(buttonByText(confirm, sheet()));
    expect(toastText()).toBe("Only the owner can change the owner's account");
    expect(accountNames()).toContain("Yusuf");
    server.once(route, { status: 401 });
    await start("Yusuf");
    if (confirm) await click(buttonByText(confirm, sheet()));
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%23accounts");
  });
});

describe("settings: a local install", () => {
  it("shows and changes 'only screen links start captions'", async () => {
    server.requireScreen = true;
    await open("#settings");
    const box = $<HTMLInputElement>("#require-screen");
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(shown("#require-row")).toBe(true);
    expect(shown("#org-form")).toBe(false);
    expect(shown("#org-delete")).toBe(false);
    const held = server.hold("PATCH /api/settings");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(box.disabled).toBe(true);
    expect(text("#settings-status")).toBe("Saving…");
    held.release();
    await settle();
    expect(server.last("PATCH /api/settings")?.body).toEqual({ requireScreen: false });
    expect(server.requireScreen).toBe(false);
    expect(text("#settings-status")).toBe("Saved");
    expect($("#settings-status").className).toBe("setting-status is-ok");
    expect(box.disabled).toBe(false);
  });

  it("keeps what was sent when the server answers without the setting", async () => {
    await open("#settings");
    server.once("PATCH /api/settings", { status: 200 });
    const box = $<HTMLInputElement>("#require-screen");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(box.checked).toBe(true);
  });

  it("puts the switch back and explains a failed save", async () => {
    await open("#settings");
    server.once("PATCH /api/settings", {
      status: 400,
      body: { message: "config.yaml is read-only" },
    });
    const box = $<HTMLInputElement>("#require-screen");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(box.checked).toBe(false);
    expect(text("#settings-status")).toBe("config.yaml is read-only");
    expect($("#settings-status").className).toBe("setting-status is-error");
    // The message follows a language switch as the server wrote it.
    await click('.lang-btn[lang="nl"]');
    expect(text("#settings-status")).toBe("config.yaml is read-only");
  });

  it("explains when the setting can't be loaded", async () => {
    server.once("GET /api/settings", "network");
    await open("#settings");
    expect(text("#settings-status")).toBe(en("err.network"));
    expect($<HTMLInputElement>("#require-screen").disabled).toBe(true);
  });

  it("goes to log in when the login expired", async () => {
    server.once("GET /api/settings", { status: 401 });
    const { nav } = await open("#settings");
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%23settings");
    server.once("PATCH /api/settings", { status: 401 });
    const box = $<HTMLInputElement>("#require-screen");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(nav.assign).toHaveBeenCalledTimes(2);
    expect(box.checked).toBe(false);
  });

  it("redraws the saved note in the new language", async () => {
    await open("#settings");
    const box = $<HTMLInputElement>("#require-screen");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    await click('.lang-btn[lang="ar"]');
    expect(text("#settings-status")).toBe(message("ar", "common.saved"));
    expect(document.title).toBe(`${message("ar", "set.title")} · ترجمان`);
  });
});

describe("settings: a hosted mosque", () => {
  beforeEach(hosted);

  it("shows the mosque's name to change, and no server settings", async () => {
    await open("#settings");
    expect(shown("#require-row")).toBe(false);
    expect(server.requests()).not.toContain("GET /api/settings");
    expect(shown("#org-form")).toBe(true);
    expect($<HTMLInputElement>("#org-name").value).toBe("Al-Noor");
    // An admin isn't the owner: no deleting the mosque.
    expect(shown("#org-delete")).toBe(false);
  });

  it("renames the mosque and the screens' heading follows", async () => {
    await open("#settings");
    type("#org-name", "  ");
    await click("#org-save");
    expect(text("#org-status")).toBe(en("common.empty"));
    expect($("#org-status").className).toBe("setting-status is-error");
    expect(document.activeElement?.id).toBe("org-name");

    type("#org-name", " Masjid Al-Noor ");
    const held = server.hold("PATCH /api/org");
    await click("#org-save");
    expect(text("#org-status")).toBe("Saving…");
    expect($<HTMLButtonElement>("#org-save").disabled).toBe(true);
    held.release();
    await settle();
    expect(server.last("PATCH /api/org")?.body).toEqual({ name: "Masjid Al-Noor" });
    expect(text("#org-status")).toBe("Saved");
    expect(text("#org-line")).toBe("Masjid Al-Noor");
    expect($<HTMLButtonElement>("#org-save").disabled).toBe(false);
  });

  it("keeps the typed name when the server answers without one", async () => {
    await open("#settings");
    server.once("PATCH /api/org", { status: 200 });
    type("#org-name", "Masjid");
    await click("#org-save");
    expect(text("#org-line")).toBe("Masjid");
  });

  it("explains a failed rename, or goes to log in", async () => {
    const { nav } = await open("#settings");
    server.once("PATCH /api/org", { status: 400, body: { message: "Name: too long" } });
    await click("#org-save");
    expect(text("#org-status")).toBe("Name: too long");
    server.once("PATCH /api/org", { status: 401 });
    await click("#org-save");
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp%23settings");
  });

  it("hides the name from a plain account", async () => {
    server.login(server.addUser({ username: "helper", role: "user", orgId: "o1" }));
    await open("");
    expect(shown("#org-form")).toBe(false);
    expect(text("#org-line")).toBe("Al-Noor");
  });

  it("lets the owner delete the mosque with the password", async () => {
    const owner = server.login(
      server.addUser({
        username: "owner",
        email: "o@example.org",
        role: "owner",
        orgId: "o1",
        password: "owner-password",
      }),
    );
    const { nav } = await open("#settings");
    expect(shown("#org-delete")).toBe(true);
    await click("#org-delete-btn");
    const s = sheet();
    expect(text(".ui-sheet-title", s)).toBe(en("org.deleteTitle"));
    expect(document.activeElement?.id).toBe("del-org-password");
    await click(buttonByText(en("org.deleteConfirm"), s));
    expect(text(".ui-field-error", s)).toBe(en("common.empty"));
    type("#del-org-password", "wrong");
    await click(buttonByText(en("org.deleteConfirm"), s));
    expect(text(".ui-field-error", s)).toBe(en("org.wrongPassword"));
    server.once("DELETE /api/org", { status: 429 });
    await click(buttonByText(en("org.deleteConfirm"), s));
    expect(text(".ui-field-error", s)).toBe(en("login.tooManyWait"));
    expect(nav.assign).not.toHaveBeenCalled();
    type("#del-org-password", owner.password);
    await click(buttonByText(en("org.deleteConfirm"), s));
    expect(server.last("DELETE /api/org")?.body).toEqual({ password: "owner-password" });
    expect(nav.assign).toHaveBeenCalledWith("/");
    expect(server.org).toBeNull();
  });

  it("cancels deleting the mosque", async () => {
    server.login(server.addUser({ username: "owner", role: "owner", orgId: "o1" }));
    await open("#settings");
    await click("#org-delete-btn");
    await click(buttonByText("Cancel", sheet()));
    expect($$("dialog")).toHaveLength(0);
    expect(server.requests()).not.toContain("DELETE /api/org");
  });

  it("keeps a name being typed when the mosque loads", async () => {
    let release = (): void => {};
    server.once("GET /api/org", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        status: 200,
        body: {
          id: "o1",
          name: "Al-Noor",
          mode: "hosted",
          role: "admin",
          keys: { soniox: server.soniox },
          usage: { monthMinutes: 0, estimateUsd: 0 },
        },
      };
    });
    await open("#settings");
    $<HTMLInputElement>("#org-name").focus();
    type("#org-name", "New name");
    release();
    await settle();
    expect($<HTMLInputElement>("#org-name").value).toBe("New name");
  });
});

describe("accounts: languages", () => {
  it("draws the accounts again after a language switch", async () => {
    server.addUser({ username: "yusuf", displayName: "Yusuf", role: "admin" });
    await open();
    await click('.lang-btn[lang="nl"]');
    expect(text(".uc-role", userCard("Yusuf"))).toBe(message("nl", "role.admin"));
    expect(text(".uc-you", userCard("Imam Ali"))).toBe(message("nl", "acc.you"));
    expect(document.title).toBe(`${message("nl", "acc.title")} · Turjuman`);
  });
});
