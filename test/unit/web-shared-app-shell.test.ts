// @vitest-environment happy-dom
// The app's shared chrome (web/shared/app-shell.ts): static page text in the chosen language, the
// language switch, the header with its navigation and account menu, changing the password, logging
// out and the footer. Each test loads fresh modules: the language and the server's mode are
// module state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../../src/shared/protocol.js";
import { fakeFetch, jsonResponse, settle } from "./helpers/web-shared-fakes.js";

type Shell = typeof import("../../web/shared/app-shell.js");
type I18n = typeof import("../../web/shared/app-i18n.js");

async function fresh(): Promise<{ shell: Shell; i18n: I18n }> {
  vi.resetModules();
  const shell = await import("../../web/shared/app-shell.js");
  const i18n = await import("../../web/shared/app-i18n.js");
  return { shell, i18n };
}

function me(over: Partial<Me> = {}): Me {
  return {
    id: "u1",
    username: "aisha",
    displayName: "Aisha",
    role: "user",
    orgId: "local",
    email: null,
    ...over,
  };
}

function q<T extends Element>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`${sel} not found`);
  return node;
}

function sheet(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog.ui-sheet");
}

/** The mode the server reports on GET /api/auth/state, and the answer to the other calls. */
function server(
  mode: "hosted" | "local" | null,
  other: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () =>
    new Response(null, { status: 204 }),
) {
  return fakeFetch((url, init) => {
    if (url === "/api/auth/state") {
      return mode === null ? jsonResponse({}, 500) : jsonResponse({ mode, loggedIn: true });
    }
    return other(url, init);
  });
}

// Links in these tests must never navigate the test window.
const noNavigation = (ev: Event): void => ev.preventDefault();

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.className = "";
  document.title = "";
  document.addEventListener("click", noNavigation, true);
});

afterEach(() => {
  document.removeEventListener("click", noNavigation, true);
  for (const d of document.querySelectorAll("dialog")) d.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("app shell: static text", () => {
  it("fills data-i18n text and the aria, title, placeholder and tip attributes", async () => {
    const { shell } = await fresh();
    document.body.innerHTML = `
      <p id="a" data-i18n="nav.screens">x</p>
      <p id="b" data-i18n="no.such.key">keep</p>
      <button id="c" data-i18n-aria="nav.main" data-i18n-title="nav.look"></button>
      <input id="d" data-i18n-placeholder="cp.current">
      <span id="e" data-i18n-tip="sos.private"></span>
      <span id="f" data-i18n-tip="not.a.key" data-tip="old"></span>
      <span id="g" data-i18n-aria="not.a.key"></span>`;
    shell.applyI18n();
    expect(q("#a").textContent).toBe("Screens");
    expect(q("#b").textContent).toBe("keep");
    expect(q("#c").getAttribute("aria-label")).toBe("Main");
    expect(q("#c").getAttribute("title")).toBe("Look");
    expect(q("#d").getAttribute("placeholder")).toBe("Current password");
    const tip = q<HTMLElement>("#e");
    expect(tip.dataset.tip).toBe("Keep it private: anyone with this link can show this screen.");
    expect(tip.getAttribute("aria-label")).toBe(tip.dataset.tip);
    expect(q<HTMLElement>("#f").dataset.tip).toBe("old");
    expect(q("#f").hasAttribute("aria-label")).toBe(false);
    expect(q("#g").hasAttribute("aria-label")).toBe(false);
  });

  it("touches only the given subtree", async () => {
    const { shell } = await fresh();
    document.body.innerHTML = `<p id="out" data-i18n="nav.keys">x</p>
      <section id="in"><p id="inner" data-i18n="nav.keys">x</p></section>`;
    shell.applyI18n(q("#in"));
    expect(q("#inner").textContent).toBe("Keys");
    expect(q("#out").textContent).toBe("x");
  });

  it("puts DOM nodes in place of placeholders and leaves unknown ones as text", async () => {
    const { shell } = await fresh();
    const code = document.createElement("code");
    code.textContent = "--flag";
    const nodes = shell.fillNodes("add {flag} to {target} now", { flag: code });
    const p = document.createElement("p");
    p.append(...nodes);
    expect(p.textContent).toBe("add --flag to {target} now");
    expect(p.querySelector("code")).toBe(code);
    expect(nodes[1]).toBe(code);
    expect(shell.fillNodes("plain", {}).map((n) => n.textContent)).toEqual(["plain"]);
  });

  it("titles the page in the app's language with the brand name", async () => {
    const { shell, i18n } = await fresh();
    shell.setTitle("cp.title");
    expect(document.title).toBe("Change password · Turjuman");
    i18n.setLang("ar");
    shell.setTitle("cp.title");
    expect(document.title).toBe("تغيير كلمة المرور · ترجمان");
  });

  it("starts a page in its language and re-renders it on every switch", async () => {
    localStorage.setItem("tj-app-lang", "ar");
    const { shell, i18n } = await fresh();
    document.body.innerHTML = `<h1 id="h" data-i18n="nav.settings">x</h1>`;
    const onChange = vi.fn();
    shell.initPage(onChange);
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(q("#h").textContent).toBe("الإعدادات");
    i18n.setLang("nl");
    expect(q("#h").textContent).toBe("Instellingen");
    expect(document.documentElement.dir).toBe("ltr");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-renders without a callback too", async () => {
    const { shell, i18n } = await fresh();
    document.body.innerHTML = `<h1 id="h" data-i18n="nav.settings">x</h1>`;
    shell.initPage();
    i18n.setLang("nl");
    expect(q("#h").textContent).toBe("Instellingen");
  });
});

describe("app shell: the language switch", () => {
  it("offers each language in its own words and marks the current one", async () => {
    const { shell } = await fresh();
    const group = shell.langSwitch();
    document.body.append(group);
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button.lang-btn")];
    expect(buttons.map((b) => b.lang)).toEqual(["en", "nl", "ar"]);
    expect(buttons.map((b) => q(".lang-long", b).textContent)).toEqual([
      "English",
      "Nederlands",
      "العربية",
    ]);
    expect(buttons.map((b) => q(".lang-short", b).textContent)).toEqual(["EN", "NL", "عربي"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(group.getAttribute("aria-label")).toBe("Language");
  });

  it("switches on a click and ignores a click on the current language", async () => {
    const { shell, i18n } = await fresh();
    const group = shell.langSwitch();
    document.body.append(group);
    const heard = vi.fn();
    i18n.onLangChange(heard);
    const [en, nl] = group.querySelectorAll<HTMLButtonElement>("button");
    en?.click();
    expect(heard).not.toHaveBeenCalled();
    nl?.click();
    expect(heard).toHaveBeenCalledWith("nl");
    expect(i18n.lang()).toBe("nl");
    expect(localStorage.getItem("tj-app-lang")).toBe("nl");
    expect(nl?.getAttribute("aria-pressed")).toBe("true");
    expect(en?.getAttribute("aria-pressed")).toBe("false");
    expect(group.getAttribute("aria-label")).toBe("Taal");
  });
});

describe("app shell: roles, names and the website's home", () => {
  it("knows who may administer", async () => {
    const { shell } = await fresh();
    expect(shell.isAdminRole(null)).toBe(false);
    expect(shell.isAdminRole(undefined)).toBe(false);
    expect(shell.isAdminRole({ role: "user" })).toBe(false);
    expect(shell.isAdminRole({ role: "admin" })).toBe(true);
    expect(shell.isAdminRole({ role: "owner" })).toBe(true);
    expect(["owner", "admin", "user"].map((r) => shell.roleLabel(r as Me["role"]))).toEqual([
      "Owner",
      "Admin",
      "User",
    ]);
  });

  it("takes the first letter of a name for the avatar", async () => {
    const { shell } = await fresh();
    expect(shell.initial("  aisha ")).toBe("A");
    expect(shell.initial("عائشة")).toBe("ع");
    expect(shell.initial("   ")).toBe("?");
  });

  it("links the website's home in the app's language (hosted) or / (local)", async () => {
    const { shell, i18n } = await fresh();
    expect(shell.siteHome(null)).toBe("/");
    expect(shell.siteHome("local")).toBe("/");
    expect(shell.siteHome("hosted")).toBe("/");
    i18n.setLang("nl");
    expect(shell.siteHome("hosted")).toBe("/nl");
    expect(shell.siteHome("local")).toBe("/");
    i18n.setLang("ar");
    expect(shell.siteHome("hosted")).toBe("/ar");
  });
});

describe("app shell: the header", () => {
  it("makes its own header without a placeholder, without navigation", async () => {
    const { shell } = await fresh();
    document.body.innerHTML = `<main id="m"></main>`;
    const header = shell.mountHeader({ home: "/", nav: false });
    expect(header.root.id).toBe("app-head");
    expect(document.body.firstElementChild).toBe(header.root);
    expect(header.root.classList.contains("app-head")).toBe(true);
    const brand = q<HTMLAnchorElement>("a.app-brand", header.root);
    expect(brand.getAttribute("href")).toBe("/");
    expect(brand.getAttribute("aria-label")).toBe("Turjuman");
    expect(q(".tj-wm-lat", brand).textContent).toBe("Turjuman");
    expect(header.root.querySelector("nav.app-nav")).toBeNull();
    expect(header.root.querySelector(".lang-switch")).not.toBeNull();
    expect(document.body.classList.contains("has-tabs")).toBe(false);
  });

  it("fills the template's placeholder with the navigation and marks the page", async () => {
    const { shell } = await fresh();
    document.body.innerHTML = `<header id="app-head"></header>`;
    const header = shell.mountHeader({ home: "/app", nav: true, active: "look" });
    expect(header.root).toBe(q("#app-head"));
    expect(document.body.classList.contains("has-tabs")).toBe(true);
    const nav = q("nav.app-nav", header.root);
    expect(nav.getAttribute("aria-label")).toBe("Main");
    const links = [...nav.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => [a.dataset.nav, a.getAttribute("href"), a.textContent])).toEqual([
      ["screens", "/app", "Screens"],
      ["accounts", "/app#accounts", "Accounts"],
      ["settings", "/app#settings", "Settings"],
      ["look", "/app/look", "Look"],
      ["keys", "/app/keys", "Keys"],
    ]);
    // No login yet: the admin-only items stay hidden.
    expect(links.filter((a) => a.hidden).map((a) => a.dataset.nav)).toEqual([
      "accounts",
      "settings",
    ]);
    expect(links.filter((a) => a.hasAttribute("aria-current")).map((a) => a.dataset.nav)).toEqual([
      "look",
    ]);
    header.setActive("keys");
    expect(q('[data-nav="keys"]').getAttribute("aria-current")).toBe("page");
    expect(q('[data-nav="look"]').hasAttribute("aria-current")).toBe(false);
    header.setActive(null);
    expect(nav.querySelector("[aria-current]")).toBeNull();
  });

  it("keeps the phone tab bar off when asked", async () => {
    const { shell } = await fresh();
    document.body.classList.add("has-tabs");
    shell.mountHeader({ home: "/app", nav: true, tabs: false });
    expect(document.body.classList.contains("has-tabs")).toBe(false);
  });

  it("tells the page which nav item was clicked", async () => {
    const { shell } = await fresh();
    const onNav = vi.fn();
    const header = shell.mountHeader({ home: "/app", nav: true, onNav });
    q<HTMLAnchorElement>('[data-nav="settings"]', header.root).click();
    expect(onNav).toHaveBeenCalledTimes(1);
    expect(onNav.mock.calls[0]?.[0]).toBe("settings");
    expect(onNav.mock.calls[0]?.[1]).toBeInstanceOf(MouseEvent);
  });

  it("follows a nav link quietly without a handler", async () => {
    const { shell } = await fresh();
    const header = shell.mountHeader({ home: "/app", nav: true });
    expect(() => q<HTMLAnchorElement>('[data-nav="look"]', header.root).click()).not.toThrow();
  });

  it("shows the account and the admin items for an admin", async () => {
    const { shell } = await fresh();
    const header = shell.mountHeader({ home: "/app", nav: true });
    const account = q<HTMLButtonElement>("button.acct-btn", header.root);
    expect(account.hidden).toBe(true);

    header.setAccount(me({ role: "admin", displayName: "aisha k" }));
    expect(account.hidden).toBe(false);
    expect(q(".acct-avatar", account).textContent).toBe("A");
    expect(q(".acct-name", account).textContent).toBe("aisha k");
    expect(account.getAttribute("aria-label")).toBe("aisha k, account menu");
    expect(q<HTMLAnchorElement>('[data-nav="accounts"]').hidden).toBe(false);

    header.setAccount(me({ role: "user", displayName: "" }));
    expect(q(".acct-name", account).textContent).toBe("aisha");
    expect(q<HTMLAnchorElement>('[data-nav="accounts"]').hidden).toBe(true);

    header.setAccount(null);
    expect(account.hidden).toBe(true);
  });

  it("opens the account menu for the logged-in account only", async () => {
    const { shell } = await fresh();
    const header = shell.mountHeader({ home: "/app", nav: true });
    const account = q<HTMLButtonElement>("button.acct-btn", header.root);
    account.click();
    expect(sheet()).toBeNull();
    header.setAccount(me({ email: "aisha@example.org", role: "owner" }));
    account.click();
    const dialog = sheet();
    expect(dialog?.open).toBe(true);
    expect(q(".ui-sheet-title", dialog ?? document).textContent).toBe("Aisha");
    expect(q(".sheet-note", dialog ?? document).textContent).toBe(
      "Logged in as aisha@example.org · Owner",
    );
  });

  it("relabels everything on a language switch, the home link included", async () => {
    const { shell, i18n } = await fresh();
    const header = shell.mountHeader({
      home: () => shell.siteHome("hosted"),
      nav: true,
      active: "screens",
    });
    header.setAccount(me());
    i18n.setLang("ar");
    const brand = q<HTMLAnchorElement>("a.app-brand", header.root);
    expect(brand.getAttribute("aria-label")).toBe("ترجمان");
    expect(brand.getAttribute("href")).toBe("/ar");
    expect(q("nav.app-nav").getAttribute("aria-label")).toBe("القائمة الرئيسية");
    expect(q('[data-nav="screens"]').textContent).toBe("الشاشات");
    expect(q('[data-nav="screens"]').getAttribute("aria-current")).toBe("page");
    expect(q("button.acct-btn").getAttribute("aria-label")).toBe("Aisha، قائمة الحساب");
    i18n.setLang("en");
    header.relabel();
    expect(brand.getAttribute("href")).toBe("/");
  });
});

describe("app shell: the password and logging out", () => {
  it("asks 10 characters on a hosted server and 8 on a local install", async () => {
    server("hosted");
    expect(await (await fresh()).shell.minPasswordLength()).toBe(10);
    server("local");
    expect(await (await fresh()).shell.minPasswordLength()).toBe(8);
    // No answer from the server: the local rule.
    server(null);
    expect(await (await fresh()).shell.minPasswordLength()).toBe(8);
  });

  /** Open the sheet and return its parts. */
  async function openPasswordSheet(shell: Shell) {
    await shell.changePasswordSheet();
    const dialog = sheet();
    if (!dialog) throw new Error("no sheet");
    const form = q<HTMLFormElement>("form", dialog);
    const field = (id: string) => q<HTMLInputElement>(`#${id}`, dialog);
    const error = q<HTMLParagraphElement>(".ui-field-error", dialog);
    const submitBtn = q<HTMLButtonElement>('button[type="submit"]', dialog);
    const fill = (cur: string, next: string, again: string): void => {
      field("cp-current").value = cur;
      field("cp-next").value = next;
      field("cp-again").value = again;
    };
    const submit = async (): Promise<void> => {
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await settle();
    };
    return { dialog, form, field, error, submitBtn, fill, submit };
  }

  it("opens a sheet with three password fields and the server's length rule", async () => {
    server("hosted");
    const { shell } = await fresh();
    const s = await openPasswordSheet(shell);
    expect(q(".ui-sheet-title", s.dialog).textContent).toBe("Change password");
    for (const id of ["cp-current", "cp-next", "cp-again"]) {
      expect(s.field(id).type).toBe("password");
    }
    expect(s.field("cp-current").getAttribute("autocomplete")).toBe("current-password");
    expect(q(".ui-hint", s.dialog).textContent).toBe(
      "10 characters or more. Other devices are logged out.",
    );
    expect(document.activeElement).toBe(s.field("cp-current"));
    expect(s.error.hidden).toBe(true);
  });

  it("says what is wrong before sending anything", async () => {
    const calls = server("local");
    const { shell } = await fresh();
    const s = await openPasswordSheet(shell);
    await s.submit();
    expect(s.error.hidden).toBe(false);
    expect(s.error.textContent).toBe("Enter your current password.");
    s.fill("old-password", "short", "short");
    await s.submit();
    expect(s.error.textContent).toBe("New password: 8 characters or more.");
    s.fill("old-password", "a-new-password", "another-password");
    await s.submit();
    expect(s.error.textContent).toBe("The new passwords don’t match.");
    expect(calls.mock.calls.map((c) => c[0])).toEqual(["/api/auth/state"]);
  });

  it("changes the password, closes the sheet and says so", async () => {
    const calls = server("local");
    const { shell } = await fresh();
    const s = await openPasswordSheet(shell);
    s.fill("old-password", "a-new-password", "a-new-password");
    await s.submit();
    const post = calls.mock.calls.find((c) => c[0] === "/api/auth/password");
    expect(post?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      current: "old-password",
      next: "a-new-password",
    });
    expect(s.dialog.open).toBe(false);
    expect(sheet()).toBeNull();
    expect(q("#toast").textContent).toBe("Password changed");
  });

  it("calls a 401 or 403 a wrong current password, and lets the user try again", async () => {
    for (const code of [401, 403]) {
      server("local", () => jsonResponse({ message: "nope" }, code));
      const { shell } = await fresh();
      const s = await openPasswordSheet(shell);
      s.fill("old-password", "a-new-password", "a-new-password");
      s.field("cp-again").focus();
      await s.submit();
      expect(s.error.textContent).toBe("The current password is wrong.");
      expect(s.error.hidden).toBe(false);
      expect(s.submitBtn.disabled).toBe(false);
      expect(document.activeElement).toBe(s.field("cp-current"));
      expect(s.dialog.open).toBe(true);
      s.dialog.close();
    }
  });

  it("shows the server's own message for other failures", async () => {
    server("local", () => jsonResponse({ message: "Password storage is read-only" }, 500));
    const { shell } = await fresh();
    const s = await openPasswordSheet(shell);
    s.fill("old-password", "a-new-password", "a-new-password");
    await s.submit();
    expect(s.error.textContent).toBe("Password storage is read-only");
  });

  it("shows a generic message when the answer can't even be read", async () => {
    // A reply without headers: the client fails with a TypeError, not an API error.
    server(
      "local",
      () => ({ ok: false, status: 502, text: async () => "" }) as unknown as Response,
    );
    const { shell } = await fresh();
    const s = await openPasswordSheet(shell);
    s.fill("old-password", "a-new-password", "a-new-password");
    await s.submit();
    expect(s.error.textContent).toBe("Something went wrong. Try again.");
  });

  it("closes the sheet on Cancel", async () => {
    server("local");
    const { shell } = await fresh();
    const s = await openPasswordSheet(shell);
    const cancel = [...s.dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Cancel",
    );
    cancel?.click();
    expect(s.dialog.open).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("logs out and goes to the login page, even when the server can't be reached", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const calls = server("local");
    await (await fresh()).shell.logout();
    expect(calls.mock.calls.at(-1)?.[0]).toBe("/api/auth/logout");
    expect(calls.mock.calls.at(-1)?.[1]?.method).toBe("POST");
    expect(assign).toHaveBeenLastCalledWith("/login");

    fakeFetch(() => Promise.reject(new TypeError("offline")));
    await (await fresh()).shell.logout();
    expect(assign).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenLastCalledWith("/login");
  });

  it("offers changing the password and logging out in the account menu", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    server("local");
    const { shell } = await fresh();
    shell.accountMenu(me({ role: "admin" }));
    let dialog = sheet();
    expect(q(".ui-sheet-title", dialog ?? document).textContent).toBe("Aisha");
    expect(q(".sheet-note", dialog ?? document).textContent).toBe("Logged in as @aisha · Admin");
    const labels = () =>
      [...document.querySelectorAll(".ui-sheet-action-label")].map((n) => n.textContent);
    expect(labels()).toEqual(["Change password", "Log out"]);

    q<HTMLButtonElement>(".ui-sheet-action").click();
    await settle();
    dialog = sheet();
    expect(q(".ui-sheet-title", dialog ?? document).textContent).toBe("Change password");
    dialog?.close();

    shell.accountMenu(me({ displayName: "" }));
    expect(q(".ui-sheet-title").textContent).toBe("aisha");
    document.querySelectorAll<HTMLButtonElement>(".ui-sheet-action")[1]?.click();
    await settle();
    expect(assign).toHaveBeenCalledWith("/login");
  });
});

describe("app shell: the footer", () => {
  it("does nothing on a page without a footer placeholder", async () => {
    const { shell } = await fresh();
    document.body.innerHTML = "<main></main>";
    shell.mountFooter({ local: true });
    expect(document.body.innerHTML).toBe("<main></main>");
  });

  it("links the server's own tools on a local install", async () => {
    const { shell, i18n } = await fresh();
    document.body.innerHTML = `<footer id="app-foot"></footer>`;
    shell.mountFooter({ local: true });
    const foot = q("#app-foot");
    expect(foot.classList.contains("app-foot")).toBe(true);
    const links = [...foot.querySelectorAll("a")].map((a) => [
      a.getAttribute("href"),
      a.textContent,
    ]);
    expect(links).toEqual([
      ["/control", "Control"],
      ["/overlay", "Overlay"],
      ["/health", "Health"],
    ]);
    expect(q("nav", foot).getAttribute("aria-label")).toBe("Tools");
    expect(foot.textContent).toContain("Free and open source");
    i18n.setLang("nl");
    expect(foot.textContent).toContain("Gratis en open source");
    expect(q('a[href="/control"]', foot).textContent).toBe("Bediening");
  });

  it("shows only the licence line on a hosted server", async () => {
    const { shell } = await fresh();
    document.body.innerHTML = `<footer id="app-foot"></footer>`;
    shell.mountFooter({ local: false });
    const foot = q("#app-foot");
    expect(foot.querySelectorAll("a")).toHaveLength(0);
    expect(foot.textContent).toBe("Free and open source");
  });
});
