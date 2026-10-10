// The app's shared chrome: the header with the wordmark top-left, the main navigation, the language
// switch (English · Nederlands · العربية) and the account menu, the quiet footer, and the data-i18n
// plumbing for static page text.
// Static text in the HTML templates carries data-i18n="key" (textContent) or
// data-i18n-aria / data-i18n-title / data-i18n-placeholder / data-i18n-tip (attributes).
import { ApiError, type AppMode, apiVoid, authStateOnce, type Me } from "../admin-api.js";
import { actionSheet, button, type IconName, icon, openSheet, toast } from "../admin-ui.js";
import {
  APP_LANGS,
  type AppLang,
  applyDocumentLang,
  isMsgKey,
  LANG_LABELS,
  lang,
  type MsgKey,
  onLangChange,
  setLang,
  t,
} from "./app-i18n.js";
import { wordmarkHtml } from "./brand.js";
import { el } from "./dom.js";

// --- static text -----------------------------------------------------------------------------------

const ATTRS: ReadonlyArray<readonly [string, string]> = [
  ["i18nAria", "aria-label"],
  ["i18nTitle", "title"],
  ["i18nPlaceholder", "placeholder"],
];

/** Fill every data-i18n* element below `root` in the current language. */
export function applyI18n(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n ?? "";
    if (isMsgKey(key)) node.textContent = t(key);
  }
  for (const [data, attr] of ATTRS) {
    const sel = `[data-${data.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    for (const node of root.querySelectorAll<HTMLElement>(sel)) {
      const key = node.dataset[data] ?? "";
      if (isMsgKey(key)) node.setAttribute(attr, t(key));
    }
  }
  // The ⓘ tips show their text from data-tip and read it out from aria-label.
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-tip]")) {
    const key = node.dataset.i18nTip ?? "";
    if (!isMsgKey(key)) continue;
    node.dataset.tip = t(key);
    node.setAttribute("aria-label", t(key));
  }
}

/** A translated text with "{name}" placeholders replaced by DOM nodes (links, code). */
export function fillNodes(text: string, nodes: Readonly<Record<string, Node>>): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const node = m[1] === undefined ? undefined : nodes[m[1]];
    if (node === undefined) continue;
    out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(node);
    last = m.index + m[0].length;
  }
  out.push(document.createTextNode(text.slice(last)));
  return out;
}

function brandName(): string {
  return lang() === "ar" ? "ترجمان" : "Turjuman";
}

/** "Log in · Turjuman" (or the Arabic name on an Arabic page). */
export function setTitle(key: MsgKey): void {
  document.title = `${t(key)} · ${brandName()}`;
}

/** Language on <html>, static text, and a re-render callback for each later switch. */
export function initPage(onChange?: () => void): void {
  applyDocumentLang();
  applyI18n(document);
  onLangChange(() => {
    applyI18n(document);
    onChange?.();
  });
}

// --- language switch -------------------------------------------------------------------------------

export function langSwitch(): HTMLElement {
  const group = el("div", { class: "lang-switch", attrs: { role: "group" } });
  const buttons = new Map<AppLang, HTMLButtonElement>();
  const sync = (): void => {
    group.setAttribute("aria-label", t("lang.label"));
    for (const [l, b] of buttons) b.setAttribute("aria-pressed", String(l === lang()));
  };
  for (const l of APP_LANGS) {
    const b = el(
      "button",
      { class: "lang-btn", attrs: { type: "button", lang: l, "aria-pressed": "false" } },
      [
        el("span", { class: "lang-long", text: LANG_LABELS[l].long }),
        el("span", {
          class: "lang-short",
          text: LANG_LABELS[l].short,
          attrs: { "aria-hidden": "true" },
        }),
      ],
    );
    b.addEventListener("click", () => {
      if (l !== lang()) setLang(l);
    });
    buttons.set(l, b);
    group.append(b);
  }
  sync();
  onLangChange(sync);
  return group;
}

// --- header ----------------------------------------------------------------------------------------

export type NavId = "screens" | "accounts" | "settings" | "look" | "keys";

interface NavItem {
  id: NavId;
  href: string;
  key: MsgKey;
  icon: IconName;
  admin?: boolean;
}

const NAV: readonly NavItem[] = [
  { id: "screens", href: "/app", key: "nav.screens", icon: "screen" },
  { id: "accounts", href: "/app#accounts", key: "nav.accounts", icon: "users", admin: true },
  { id: "settings", href: "/app#settings", key: "nav.settings", icon: "sliders", admin: true },
  { id: "look", href: "/app/look", key: "nav.look", icon: "palette" },
  { id: "keys", href: "/app/keys", key: "nav.keys", icon: "key" },
];

export function isAdminRole(me: Pick<Me, "role"> | null | undefined): boolean {
  return me?.role === "admin" || me?.role === "owner";
}

export function roleLabel(role: Me["role"]): string {
  return t(role === "owner" ? "role.owner" : role === "admin" ? "role.admin" : "role.user");
}

export interface AppHeader {
  root: HTMLElement;
  setActive(id: NavId | null): void;
  /** Show the account menu (and the admin-only nav items) for this login. */
  setAccount(me: Me | null): void;
  /** Re-label after a language switch (done automatically). */
  relabel(): void;
}

/** The website's home in the app's language (hosted: /, /nl, /ar); a local install's / is the
 *  app (its builder), whatever the language. */
export function siteHome(mode: AppMode | null): string {
  if (mode !== "hosted") return "/";
  const l = lang();
  return l === "en" ? "/" : `/${l}`;
}

export interface HeaderOptions {
  /** Where the wordmark goes: /app inside the app; on login and sign-up the website's home in
   *  the page's language (a function: read again on a language switch and on relabel()). */
  home: string | (() => string);
  /** Show the app navigation (not on login / sign-up). */
  nav: boolean;
  /** On phones the navigation is a tab bar at the bottom of the screen; false hides it there
   *  (the builder has its own step bar at the bottom). Default true. */
  tabs?: boolean;
  active?: NavId | null;
  /** Called when a nav item of this page is clicked (the dashboard switches panels in place). */
  onNav?: (id: NavId, ev: MouseEvent) => void;
}

/** Mount the header into #app-head (the template's placeholder). */
export function mountHeader(opts: HeaderOptions): AppHeader {
  let root = document.getElementById("app-head");
  if (!root) {
    root = el("header", { attrs: { id: "app-head" } });
    document.body.prepend(root);
  }
  root.classList.add("app-head");
  const homeHref = (): string => (typeof opts.home === "function" ? opts.home() : opts.home);
  const brand = el("a", { class: "app-brand", attrs: { href: homeHref() } });
  brand.innerHTML = wordmarkHtml();
  const nav = el("nav", { class: "app-nav" });
  const navLinks: Array<{ item: NavItem; a: HTMLAnchorElement; label: HTMLSpanElement }> = [];
  let me: Me | null = null;
  let active: NavId | null = opts.active ?? null;
  for (const item of NAV) {
    const label = el("span", { class: "app-nav-label" });
    const a = el("a", { attrs: { href: item.href, "data-nav": item.id } }, [
      icon(item.icon, 22),
      label,
    ]);
    a.addEventListener("click", (ev) => opts.onNav?.(item.id, ev));
    navLinks.push({ item, a, label });
    nav.append(a);
  }
  if (opts.nav) document.body.classList.toggle("has-tabs", opts.tabs !== false);
  const account = el("button", {
    class: "acct-btn",
    attrs: { type: "button", "aria-haspopup": "dialog" },
  });
  account.hidden = true;
  account.addEventListener("click", () => {
    if (me) accountMenu(me);
  });
  const tools = el("div", { class: "app-tools" }, [langSwitch(), account]);
  const inner = el("div", { class: "app-head-in" }, [brand]);
  if (opts.nav) inner.append(nav);
  inner.append(tools);
  root.replaceChildren(inner);
  const header = root;

  const relabel = (): void => {
    brand.setAttribute("aria-label", brandName());
    brand.setAttribute("href", homeHref());
    nav.setAttribute("aria-label", t("nav.main"));
    for (const { item, a, label } of navLinks) {
      label.textContent = t(item.key);
      a.hidden = item.admin === true && !isAdminRole(me);
      if (item.id === active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (me) {
      const shown = me.displayName || me.username;
      account.replaceChildren(
        el("span", {
          class: "acct-avatar",
          text: initial(shown),
          attrs: { "aria-hidden": "true" },
        }),
        el("span", { class: "acct-name", text: shown }),
      );
      account.setAttribute("aria-label", t("account.menu", { name: shown }));
    }
  };
  relabel();
  onLangChange(relabel);
  return {
    root: header,
    setActive(id) {
      active = id;
      relabel();
    },
    setAccount(next) {
      me = next;
      account.hidden = next === null;
      relabel();
    },
    relabel,
  };
}

export function initial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

// --- account menu ----------------------------------------------------------------------------------

function fieldError(): HTMLParagraphElement {
  const p = el("p", { class: "ui-field-error", attrs: { role: "alert" } });
  p.hidden = true;
  return p;
}

/** Hosted mode asks 10 characters, a local install 8 (the server's own rule). */
export async function minPasswordLength(): Promise<number> {
  return (await authStateOnce())?.mode === "hosted" ? 10 : 8;
}

export async function changePasswordSheet(): Promise<void> {
  const min = await minPasswordLength();
  const mk = (id: string, label: string, auto: string): [HTMLElement, HTMLInputElement] => {
    const input = el("input", {
      class: "ui-input",
      attrs: { id, type: "password", autocomplete: auto, dir: "ltr" },
    });
    return [
      el("div", {}, [el("label", { class: "ui-label", text: label, attrs: { for: id } }), input]),
      input,
    ];
  };
  const [curRow, cur] = mk("cp-current", t("cp.current"), "current-password");
  const [nextRow, nextIn] = mk("cp-next", t("cp.new"), "new-password");
  const [againRow, again] = mk("cp-again", t("cp.repeat"), "new-password");
  const error = fieldError();
  const submit = button(t("cp.title"), { kind: "primary", type: "submit" });
  const cancel = button(t("common.cancel"));
  const form = el("form", { class: "ui-sheet-form", attrs: { novalidate: "" } }, [
    curRow,
    nextRow,
    againRow,
    el("p", { class: "ui-hint", text: t("cp.hint", { n: min }) }),
    error,
    el("div", { class: "ui-sheet-actions-row" }, [cancel, submit]),
  ]);
  const sheet = openSheet(t("cp.title"), [form]);
  cancel.addEventListener("click", () => sheet.close());
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    let problem: string | null = null;
    if (cur.value === "") problem = t("cp.enterCurrent");
    else if (nextIn.value.length < min) problem = t("cp.short", { n: min });
    else if (nextIn.value !== again.value) problem = t("cp.mismatch");
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await apiVoid("POST", "/api/auth/password", { current: cur.value, next: nextIn.value });
      sheet.close();
      toast(t("cp.done"));
    } catch (err) {
      submit.disabled = false;
      // Here a 401/403 means "wrong current password", not an expired login.
      error.textContent =
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? t("cp.wrong")
          : err instanceof ApiError
            ? err.message
            : t("err.generic");
      error.hidden = false;
      cur.focus();
    }
  });
  cur.focus();
}

export async function logout(): Promise<void> {
  try {
    await apiVoid("POST", "/api/auth/logout");
  } catch {
    // logged out anyway as far as this page is concerned
  }
  window.location.assign("/login");
}

export function accountMenu(me: Me): void {
  const who = me.email ?? `@${me.username}`;
  actionSheet(
    me.displayName || me.username,
    [
      { label: t("account.changePassword"), icon: "key", run: () => void changePasswordSheet() },
      { label: t("account.logout"), icon: "logout", run: () => void logout() },
    ],
    [
      el("p", {
        class: "sheet-note",
        text: t("account.signedInAs", { who, role: roleLabel(me.role) }),
      }),
    ],
  );
}

// --- footer ----------------------------------------------------------------------------------------

/** The quiet footer: the server's own tools in local mode, and the licence line. */
export function mountFooter(opts: { local: boolean }): void {
  const host = document.getElementById("app-foot");
  if (!host) return;
  host.classList.add("app-foot");
  const render = (): void => {
    const links = el("nav", { class: "app-foot-links", attrs: { "aria-label": "Tools" } });
    if (opts.local) {
      for (const [href, key] of [
        ["/control", "foot.control"],
        ["/overlay", "foot.overlay"],
        ["/health", "foot.health"],
      ] as const) {
        links.append(el("a", { text: t(key), attrs: { href } }));
      }
    }
    host.replaceChildren(
      el("div", { class: "app-foot-in" }, [links, el("span", { text: t("foot.free") })]),
    );
  };
  render();
  onLangChange(render);
}
