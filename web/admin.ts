// The dashboard (GET /app and /admin): screens with a live on/off switch, the prayer buttons
// (Athan / Iqama / Salah / Stop), clear, copy and open, and a menu for rename, change look, new
// link and delete; accounts and settings for owners and admins. Phone-first. Polls GET /api/screens
// every 3 s while the page is visible; the switch is optimistic and rolls back when the server
// says no. Sections follow the URL hash (#accounts, #settings), so the header's navigation can
// link to them from any app page.
import "./admin.css";
import type { PrayerEvent, ScreenAction } from "../src/shared/protocol.js";
import {
  ApiError,
  type AppMode,
  apiJson,
  apiVoid,
  authStateOnce,
  errText,
  fetchMe,
  fetchOrg,
  LangNames,
  loginUrl,
  type Me,
  maybeLoggedIn,
  type OrgView,
  type PortalSettings,
  type ScreenView,
  type UserView,
} from "./admin-api.js";
import {
  actionSheet,
  button,
  confirmSheet,
  copyText,
  generatePassword,
  type IconName,
  icon,
  openSheet,
  promptSheet,
  type Sheet,
  type SheetAction,
  toast,
} from "./admin-ui.js";
import { fmtWhen, type MsgKey, t, tn } from "./shared/app-i18n.js";
import {
  type AppHeader,
  initial,
  initPage,
  isAdminRole,
  mountFooter,
  mountHeader,
  type NavId,
  roleLabel,
  setTitle,
} from "./shared/app-shell.js";
import { byId, el } from "./shared/dom.js";
import { uiLabels } from "./shared/i18n.js";
import { chosenLink, showOnScreen } from "./shared/obs-steps.js";

const POLL_MS = 3000;

const screensBox = byId("screens", HTMLDivElement);
const screensLoading = byId("screens-loading", HTMLParagraphElement);
const screensEmpty = byId("screens-empty", HTMLDivElement);
const screensError = byId("screens-error", HTMLDivElement);
const screensErrorText = byId("screens-error-text", HTMLSpanElement);
const usersBox = byId("users", HTMLDivElement);
const usersError = byId("users-error", HTMLDivElement);
const usersErrorText = byId("users-error-text", HTMLSpanElement);
const addUserBtn = byId("add-user", HTMLButtonElement);
const requireScreen = byId("require-screen", HTMLInputElement);
const requireRow = byId("require-row", HTMLDivElement);
const orgDelete = byId("org-delete", HTMLDivElement);
const orgDeleteBtn = byId("org-delete-btn", HTMLButtonElement);
const settingsStatus = byId("settings-status", HTMLParagraphElement);
const keyMissing = byId("key-missing", HTMLDivElement);
const orgForm = byId("org-form", HTMLFormElement);
const orgName = byId("org-name", HTMLInputElement);
const orgSave = byId("org-save", HTMLButtonElement);
const orgStatus = byId("org-status", HTMLParagraphElement);
const ready = byId("ready", HTMLElement);
const readyDone = byId("ready-done", HTMLButtonElement);
const readyOff = byId("ready-off", HTMLParagraphElement);
const readyBody = byId("ready-body", HTMLDivElement);
const orgLine = byId("org-line", HTMLParagraphElement);

type Section = "screens" | "accounts" | "settings";

const PANELS: Readonly<Record<Section, HTMLElement>> = {
  screens: byId("panel-screens", HTMLElement),
  accounts: byId("panel-accounts", HTMLElement),
  settings: byId("panel-settings", HTMLElement),
};

let header: AppHeader | null = null;
let me: Me | null = null;
let org: OrgView | null = null;
/** Hosted mode: accounts log in by e-mail, passwords need 10 characters, no server settings. */
let mode: AppMode = "local";
let section: Section = "screens";
const names = new LangNames();
let screens: ScreenView[] = [];
let users: UserView[] = [];
/** Optimistic switch states while a request is on its way. */
const pending = new Map<string, boolean>();
let pollTimer = 0;
let polling = false;
/** The refresh problem on screen (re-rendered on a language switch). */
let screensProblem: string | null = null;
/** The screen just saved in the builder (?saved=<id>): its link and the OBS steps. */
let readyId: string | null = null;

function isAdmin(): boolean {
  return isAdminRole(me);
}

function minPassword(): number {
  return mode === "hosted" ? 10 : 8;
}

/** A 401 means the login expired: go to /login and come back here afterwards. */
function handleAuth(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 401) {
    window.location.assign(loginUrl("/app"));
    return true;
  }
  return false;
}

function showAlert(box: HTMLDivElement, text: HTMLSpanElement, message: string | null): void {
  text.textContent = message ?? "";
  box.hidden = message === null;
}

function path(id: string, action = ""): string {
  return `/api/screens/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

function isScreenView(v: unknown): v is ScreenView {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string" && typeof r.enabled === "boolean";
}

// --- screens -------------------------------------------------------------------------------------

interface ScreenCard {
  view: ScreenView;
  root: HTMLElement;
  name: HTMLHeadingElement;
  langs: HTMLSpanElement;
  status: HTMLParagraphElement;
  statusText: HTMLSpanElement;
  toggle: HTMLInputElement;
  toggleState: HTMLSpanElement;
  lock: HTMLParagraphElement;
  lockText: HTMLSpanElement;
  reset: HTMLButtonElement;
  resetLabel: HTMLSpanElement;
  copyLabel: HTMLSpanElement;
  showLabel: HTMLSpanElement;
  more: HTMLButtonElement;
  owner: HTMLSpanElement;
  change: HTMLSpanElement;
  feed: HTMLSpanElement;
  /** Athan / Iqama / Salah by hand, and Stop. */
  evGroup: HTMLDivElement;
  evButtons: Map<PrayerEvent, HTMLButtonElement>;
  evStop: HTMLButtonElement;
  evHint: HTMLParagraphElement;
}

const cards = new Map<string, ScreenCard>();

const EVENTS: readonly PrayerEvent[] = ["athan", "iqama", "salah"];
const EVENT_KEY: Readonly<Record<PrayerEvent, MsgKey>> = {
  athan: "ev.athan",
  iqama: "ev.iqama",
  salah: "ev.salah",
};
const EVENT_STATUS: Readonly<Record<PrayerEvent, MsgKey>> = {
  athan: "status.athan",
  iqama: "status.iqama",
  salah: "status.salah",
};

const VERB: Readonly<Record<ScreenAction, MsgKey>> = {
  created: "verb.created",
  enabled: "verb.enabled",
  disabled: "verb.disabled",
  reset: "verb.reset",
  regenerated: "verb.regenerated",
  edited: "verb.edited",
};

function domId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function statusOf(v: ScreenView, enabled: boolean): { text: string; cls: string } {
  const pages = v.live?.pages ?? 0;
  const where = tn("n.connected", pages);
  if (!enabled) {
    return pages > 0
      ? { text: t("status.offWaiting", { where }), cls: "is-off" }
      : { text: t("status.off"), cls: "is-off" };
  }
  if (pages === 0) return { text: t("status.notConnected"), cls: "is-idle" };
  const event = v.live?.event ?? null;
  if (event !== null) return { text: t(EVENT_STATUS[event], { where }), cls: "is-event" };
  return v.live?.speaking
    ? { text: t("status.speaking", { where }), cls: "is-speaking" }
    : { text: t("status.listening", { where }), cls: "is-listening" };
}

/** A small button of a card: its icon and the label fillCard writes. */
function cardButton(name: IconName, cls: string): [HTMLButtonElement, HTMLSpanElement] {
  const label = el("span");
  const b = el(
    "button",
    { class: `ui-btn ui-btn-secondary ui-btn-sm ${cls}`, attrs: { type: "button" } },
    [icon(name), label],
  );
  return [b, label];
}

function createCard(view: ScreenView): ScreenCard {
  const id = view.id;
  const sid = domId(id);
  const name = el("h2", { class: "sc-name plain", attrs: { id: `sc-name-${sid}` } });
  const langs = el("span", { class: "sc-langs" });
  const more = el("button", {
    class: "sc-more",
    attrs: { type: "button", "aria-haspopup": "dialog" },
  });
  more.append(icon("more", 22));
  const statusText = el("span");
  const status = el("p", { class: "sc-status", attrs: { id: `sc-status-${sid}` } }, [
    el("span", { class: "sc-dot", attrs: { "aria-hidden": "true" } }),
    statusText,
  ]);
  const toggle = el("input", {
    class: "big-switch",
    attrs: {
      type: "checkbox",
      "aria-labelledby": `sc-name-${sid} sc-state-${sid}`,
      "aria-describedby": `sc-status-${sid}`,
    },
  });
  const toggleState = el("span", { class: "sc-state", attrs: { id: `sc-state-${sid}` } });
  const switchRow = el("label", { class: "sc-switch" }, [toggleState, toggle]);
  const lockText = el("span");
  const lock = el("p", { class: "sc-lock" }, [icon("lock", 16), lockText]);
  const [show, showLabel] = cardButton("screen", "sc-show");
  show.setAttribute("aria-haspopup", "dialog");
  const [copy, copyLabel] = cardButton("copy", "sc-copy");
  const [reset, resetLabel] = cardButton("reset", "sc-reset");
  const owner = el("span", { class: "sc-owner" });
  const change = el("span", { class: "sc-change" });
  const feed = el("span", { class: "sc-feed" });
  // Prayer events by hand: the card on every OBS page of this screen.
  const evButtons = new Map<PrayerEvent, HTMLButtonElement>();
  const evGroup = el("div", { class: "sc-events", attrs: { role: "group" } });
  for (const ev of EVENTS) {
    const b = el("button", {
      class: "sc-ev",
      attrs: { type: "button", "aria-pressed": "false" },
    });
    evButtons.set(ev, b);
    evGroup.append(b);
  }
  const evStop = el("button", {
    class: "ui-btn ui-btn-ghost ui-btn-sm sc-ev-stop",
    attrs: { type: "button" },
  });
  const evHint = el("p", { class: "sc-ev-hint" });
  const root = el("article", { class: "screen-card", attrs: { "data-id": id } }, [
    el("div", { class: "sc-head" }, [
      el("div", { class: "sc-title" }, [name, el("p", { class: "sc-sub" }, [langs])]),
      switchRow,
      more,
    ]),
    status,
    lock,
    el("div", { class: "sc-controls" }, [
      el("div", { class: "sc-evrow" }, [evGroup, evStop]),
      evHint,
      el("div", { class: "sc-actions" }, [show, copy, reset]),
    ]),
    el("p", { class: "sc-meta" }, [owner, change, feed]),
  ]);
  const card: ScreenCard = {
    view,
    root,
    name,
    langs,
    status,
    statusText,
    toggle,
    toggleState,
    lock,
    lockText,
    reset,
    resetLabel,
    copyLabel,
    showLabel,
    more,
    owner,
    change,
    feed,
    evGroup,
    evButtons,
    evStop,
    evHint,
  };
  toggle.addEventListener("change", () => void setEnabled(card, toggle.checked));
  reset.addEventListener("click", () => void resetScreen(card));
  copy.addEventListener("click", () => void copyLink(card));
  show.addEventListener("click", () => openShowSheet(card.view));
  more.addEventListener("click", () => openScreenMenu(card));
  for (const [ev, b] of evButtons) b.addEventListener("click", () => void setEvent(card, ev));
  evStop.addEventListener("click", () => void setEvent(card, "none"));
  return card;
}

function fillCard(card: ScreenCard, view: ScreenView): void {
  card.view = view;
  const enabled = pending.get(view.id) ?? view.enabled;
  card.root.classList.toggle("is-on", enabled);
  card.root.classList.toggle("is-locked", !view.canControl);
  card.name.textContent = view.name;
  card.langs.textContent = names.pair(view.from, view.to);
  const st = statusOf(view, enabled);
  card.status.className = `sc-status ${st.cls}`;
  card.statusText.textContent = st.text;
  card.toggle.checked = enabled;
  card.toggle.disabled = !view.canControl;
  card.toggleState.textContent = t(enabled ? "sc.on" : "sc.off");
  card.lock.hidden = view.canControl;
  card.lockText.textContent = t("sc.locked");
  card.more.setAttribute("aria-label", t("sc.more"));
  card.more.title = t("sc.more");
  card.resetLabel.textContent = t("sc.reset");
  card.reset.title = t("sc.resetTitle");
  card.reset.disabled = !view.canControl;
  card.copyLabel.textContent = t("sc.copyLink");
  card.showLabel.textContent = t("sos.button");
  card.owner.textContent = view.owner
    ? view.owner.id === me?.id
      ? t("sc.yours")
      : t("sc.owner", { name: view.owner.displayName })
    : "";
  card.change.textContent = view.lastChange
    ? t("sc.change", {
        verb: t(VERB[view.lastChange.action] ?? "verb.changed"),
        who: view.lastChange.by,
        when: fmtWhen(view.lastChange.at),
      })
    : "";
  card.feed.replaceChildren(
    ...(view.guid
      ? [`${t("sc.feed")} `, el("span", { class: "sc-feed-id ltr", text: view.guid.slice(0, 8) })]
      : []),
  );
  card.feed.title = t("sc.feedTitle");
  // Prayer events: the screen must be on and shown somewhere (a running session).
  const event = view.live?.event ?? null;
  const connected = (view.live?.sessions ?? 0) > 0;
  const usable = view.canControl && enabled && connected;
  card.evGroup.setAttribute("aria-label", t("sc.prayer"));
  for (const [ev, b] of card.evButtons) {
    b.textContent = t(EVENT_KEY[ev]);
    b.disabled = !usable || pendingEvent.has(view.id);
    b.setAttribute("aria-pressed", String(ev === event));
    b.classList.toggle("is-active", ev === event);
  }
  card.evStop.textContent = t("ev.stop");
  card.evStop.title = t("ev.stopTitle");
  card.evStop.hidden = event === null;
  card.evStop.disabled = !usable || pendingEvent.has(view.id);
  card.evHint.textContent = !view.canControl
    ? ""
    : !enabled
      ? t("ev.hintOff")
      : !connected
        ? t("ev.hintNotConnected")
        : "";
  card.evHint.hidden = card.evHint.textContent === "";
}

/** Screens with an Athan / Iqama / Salah request in flight (their buttons wait, disabled). */
const pendingEvent = new Set<string>();

async function setEvent(card: ScreenCard, ev: PrayerEvent | "none"): Promise<void> {
  const id = card.view.id;
  pendingEvent.add(id);
  fillCard(card, card.view);
  try {
    applyView(await apiJson<unknown>("POST", path(id, "event"), { event: ev }));
    toast(
      ev === "none"
        ? t("toast.evEnded", { name: card.view.name })
        : t("toast.evShown", { event: t(EVENT_KEY[ev]), name: card.view.name }),
    );
  } catch (err) {
    if (handleAuth(err)) return;
    // 409: the screen went off, or no page shows it any more (since the last refresh).
    const text =
      err instanceof ApiError && err.status === 409
        ? t(card.view.enabled ? "ev.hintNotConnected" : "ev.hintOff")
        : errText(err);
    toast(text, "error");
    void refreshScreens();
  } finally {
    pendingEvent.delete(id);
    const fresh = cards.get(id);
    if (fresh) fillCard(fresh, fresh.view);
  }
}

function renderScreens(list: ScreenView[]): void {
  screensLoading.hidden = true;
  const ids = new Set(list.map((s) => s.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  let prev: Element | null = null;
  for (const view of list) {
    let card = cards.get(view.id);
    if (!card) {
      card = createCard(view);
      cards.set(view.id, card);
    }
    fillCard(card, view);
    const expected: Element | null = prev ? prev.nextElementSibling : screensBox.firstElementChild;
    if (expected !== card.root) {
      if (prev) prev.after(card.root);
      else screensBox.prepend(card.root);
    }
    prev = card.root;
  }
  screensEmpty.hidden = list.length > 0;
  renderReady();
}

function applyView(v: unknown): void {
  if (!isScreenView(v)) {
    void refreshScreens();
    return;
  }
  const i = screens.findIndex((s) => s.id === v.id);
  if (i >= 0) screens[i] = v;
  else screens.unshift(v);
  renderScreens(screens);
}

function showScreensProblem(message: string | null): void {
  screensProblem = message;
  showAlert(
    screensError,
    screensErrorText,
    message === null ? null : t("dash.refreshFailed", { msg: message }),
  );
}

async function refreshScreens(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const r = await apiJson<unknown>("GET", "/api/screens");
    const list = Array.isArray(r)
      ? r
      : typeof r === "object" && r !== null && Array.isArray((r as { screens?: unknown }).screens)
        ? ((r as { screens: unknown[] }).screens as unknown[])
        : [];
    screens = list.filter(isScreenView);
    showScreensProblem(null);
    renderScreens(screens);
  } catch (err) {
    if (!handleAuth(err)) {
      screensLoading.hidden = true;
      showScreensProblem(errText(err));
    }
  } finally {
    polling = false;
  }
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = window.setTimeout(() => {
    void refreshScreens().then(schedulePoll);
  }, POLL_MS);
}

async function setEnabled(card: ScreenCard, want: boolean): Promise<void> {
  const id = card.view.id;
  pending.set(id, want);
  fillCard(card, card.view);
  try {
    const v = await apiJson<unknown>("POST", path(id, want ? "enable" : "disable"));
    pending.delete(id);
    applyView(v);
    toast(t(want ? "toast.on" : "toast.off", { name: card.view.name }));
  } catch (err) {
    pending.delete(id);
    if (handleAuth(err)) return;
    fillCard(card, card.view);
    toast(errText(err), "error");
  }
}

async function resetScreen(card: ScreenCard): Promise<void> {
  const view = card.view;
  const ok = await confirmSheet({
    title: t("reset.title"),
    message: t("reset.msg", { name: view.name }),
    confirm: t("reset.confirm"),
    danger: true,
  });
  if (!ok) return;
  try {
    applyView(await apiJson<unknown>("POST", path(view.id, "reset")));
    toast(t("toast.cleared"));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

async function copyLink(card: ScreenCard): Promise<void> {
  const view = card.view;
  // Never a plain-http network link (no microphone there): no usable link yet → the panel.
  const link = chosenLink(view, mode);
  if (link === null) {
    openShowSheet(view);
    return;
  }
  const ok = await copyText(link);
  toast(ok ? t("toast.linkCopied") : t("toast.copyFailed"), ok ? "ok" : "error");
}

function openScreenMenu(card: ScreenCard): void {
  const view = card.view;
  const id = view.id;
  const actions: SheetAction[] = [];
  if (view.canEdit) {
    actions.push(
      {
        label: t("menu.rename"),
        icon: "edit",
        run: () => void renameScreen(id),
      },
      {
        label: t("menu.changeLook"),
        icon: "palette",
        // Straight to the Look step: a saved screen keeps its languages (step 1 is locked).
        run: () => window.location.assign(`/app/new?screen=${encodeURIComponent(id)}#step=3`),
      },
      {
        label: t("menu.newLink"),
        icon: "refresh",
        hint: t("menu.newLinkHint"),
        run: () => void regenerate(id),
      },
      {
        label: t("menu.deleteScreen"),
        icon: "trash",
        danger: true,
        run: () => void deleteScreen(id),
      },
    );
  }
  const extra: Node[] = [];
  if (isAdmin() && view.owner && view.owner.id !== me?.id) {
    const sw = el("input", {
      class: "ui-switch",
      attrs: { type: "checkbox", id: "owner-control", "aria-describedby": "owner-control-desc" },
    });
    sw.checked = view.ownerControl;
    sw.addEventListener("change", async () => {
      const allowed = sw.checked;
      try {
        applyView(await apiJson<unknown>("POST", path(id, "owner-control"), { allowed }));
        toast(t(allowed ? "toast.ownerMay" : "toast.adminsOnly"));
      } catch (err) {
        sw.checked = !allowed;
        if (!handleAuth(err)) toast(errText(err), "error");
      }
    });
    extra.push(
      el("div", { class: "sheet-toggle" }, [
        el("div", { class: "sheet-toggle-text" }, [
          el("label", {
            class: "sheet-toggle-title",
            text: t("menu.ownerControl"),
            attrs: { for: "owner-control" },
          }),
          el("p", {
            class: "sheet-toggle-desc",
            text: view.owner.displayName,
            attrs: { id: "owner-control-desc" },
          }),
        ]),
        sw,
      ]),
    );
  }
  if (actions.length === 0 && extra.length === 0) {
    toast(t("toast.nothing"), "error");
    return;
  }
  actionSheet(view.name, actions, extra);
}

async function renameScreen(id: string): Promise<void> {
  const view = cards.get(id)?.view;
  if (!view) return;
  const name = await promptSheet({
    title: t("rename.title"),
    label: t("rename.label"),
    value: view.name,
    confirm: t("common.save"),
  });
  if (name === null || name === view.name) return;
  try {
    applyView(await apiJson<unknown>("PATCH", path(id), { name }));
    toast(t("toast.renamed"));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

async function regenerate(id: string): Promise<void> {
  const view = cards.get(id)?.view;
  if (!view) return;
  const ok = await confirmSheet({
    title: t("regen.title"),
    message: t("regen.msg"),
    confirm: t("regen.confirm"),
    danger: true,
  });
  if (!ok) return;
  try {
    applyView(await apiJson<unknown>("POST", path(id, "regenerate")));
    toast(t("toast.newLink"));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

async function deleteScreen(id: string): Promise<void> {
  const view = cards.get(id)?.view;
  if (!view) return;
  const ok = await confirmSheet({
    title: t("del.title", { name: view.name }),
    message: t("del.msg"),
    confirm: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await apiVoid("DELETE", path(id));
    screens = screens.filter((s) => s.id !== id);
    if (readyId === id) readyId = null;
    renderScreens(screens);
    toast(t("toast.deleted"));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

// --- "show on a screen": the link and the OBS steps, for every screen at any time ----------------

function openShowSheet(view: ScreenView): void {
  const sheet = openSheet(t("sos.title"), [
    el("p", { class: "sos-for" }, [
      el("span", { class: "sos-for-name", text: view.name, attrs: { dir: "auto" } }),
      el("span", { text: names.pair(view.from, view.to) }),
    ]),
    showOnScreen(view, mode),
  ]);
  sheet.dialog.classList.add("ui-sheet-wide");
}

// --- "your screen is ready" (back from the builder) -------------------------------------------------

/** The url and look the ready note was drawn for (redrawn only when they change). */
let readyDrawn = "";

function renderReady(force = false): void {
  const view = readyId === null ? undefined : screens.find((s) => s.id === readyId);
  ready.hidden = view === undefined;
  if (!view) {
    readyDrawn = "";
    return;
  }
  // A new screen starts off: say when to switch it on, and what the TV shows until then (the
  // caption page's own words, in the screen's caption language).
  readyOff.hidden = view.enabled;
  readyOff.textContent = t("dash.readyOff", { off: uiLabels(view.to).screenOffTitle });
  const key = `${view.url} ${view.localUrl} ${view.secureUrl} ${view.query}`;
  if (!force && key === readyDrawn) return;
  readyDrawn = key;
  // The link right away; the OBS steps one tap further (the same sheet as on the card).
  const steps = button(t("sos.stepsButton"), { kind: "secondary", icon: "screen" });
  steps.setAttribute("aria-haspopup", "dialog");
  // The card's view is the latest (a rename doesn't redraw the note).
  steps.addEventListener("click", () => openShowSheet(cards.get(view.id)?.view ?? view));
  readyBody.replaceChildren(
    showOnScreen(view, mode, { guide: false }),
    el("div", { class: "ready-more" }, [steps]),
  );
}

// --- accounts ------------------------------------------------------------------------------------

function accountName(u: UserView): string {
  return u.email ?? `@${u.username}`;
}

function userCard(u: UserView): HTMLElement {
  const self = u.id === me?.id;
  const title = el("div", { class: "uc-title" }, [
    el("span", { class: "uc-name", text: u.displayName || u.username, attrs: { dir: "auto" } }),
  ]);
  title.append(el("span", { class: "uc-role", text: roleLabel(u.role) }));
  if (self) title.append(el("span", { class: "uc-you", text: t("acc.you") }));
  if (u.disabled) title.append(el("span", { class: "uc-off", text: t("acc.disabled") }));
  // The login on its own line; then the facts (a logged-in person's own "last login" is moot).
  const facts = [el("span", { text: tn("n.screens", u.screens) })];
  if (!self) {
    facts.push(
      el("span", {
        text: u.lastLoginAt ? t("acc.lastLogin", { when: fmtWhen(u.lastLoginAt) }) : t("acc.never"),
      }),
    );
  }
  const body = el("div", { class: "uc-body" }, [
    title,
    el("p", { class: "uc-login" }, [el("span", { class: "ltr", text: accountName(u) })]),
    el("p", { class: "uc-meta" }, facts),
  ]);
  const actions = el("div", { class: "uc-actions" });
  // The owner stays: an admin can't demote, disable or delete the person who signed up.
  if (!self && u.role !== "owner") {
    const reset = button(t("acc.resetPassword"), { kind: "secondary" });
    reset.classList.add("ui-btn-sm");
    reset.addEventListener("click", () => resetPasswordSheet(u));
    const toggle = button(t(u.disabled ? "acc.enable" : "acc.disable"), { kind: "secondary" });
    toggle.classList.add("ui-btn-sm");
    toggle.addEventListener("click", () => void setDisabled(u, !u.disabled));
    const more = el("button", {
      class: "sc-more",
      attrs: {
        type: "button",
        "aria-label": t("acc.moreFor", { name: accountName(u) }),
        "aria-haspopup": "dialog",
      },
    });
    more.append(icon("more", 22));
    more.addEventListener("click", () => userMenu(u));
    actions.append(reset, toggle, more);
  }
  return el("article", { class: `user-card${u.disabled ? " is-disabled" : ""}` }, [
    el("span", {
      class: "avatar",
      text: initial(u.displayName || u.username),
      attrs: { "aria-hidden": "true" },
    }),
    body,
    actions,
  ]);
}

function renderUsers(): void {
  usersBox.replaceChildren(...users.map(userCard));
}

async function loadUsers(): Promise<void> {
  try {
    const r = await apiJson<unknown>("GET", "/api/users");
    users = Array.isArray(r) ? (r as UserView[]) : [];
    showAlert(usersError, usersErrorText, null);
    renderUsers();
  } catch (err) {
    if (!handleAuth(err)) showAlert(usersError, usersErrorText, errText(err));
  }
}

function replaceUser(u: unknown): void {
  if (typeof u === "object" && u !== null && typeof (u as UserView).id === "string") {
    const v = u as UserView;
    const i = users.findIndex((x) => x.id === v.id);
    if (i >= 0) users[i] = v;
    else users.push(v);
    renderUsers();
  } else {
    void loadUsers();
  }
}

async function setDisabled(u: UserView, disabled: boolean): Promise<void> {
  if (disabled) {
    const ok = await confirmSheet({
      title: t("acc.disableTitle", { name: accountName(u) }),
      message: t("acc.disableMsg"),
      confirm: t("acc.disable"),
      danger: true,
    });
    if (!ok) return;
  }
  try {
    replaceUser(
      await apiJson<unknown>("PATCH", `/api/users/${encodeURIComponent(u.id)}`, { disabled }),
    );
    toast(t(disabled ? "acc.disabledToast" : "acc.enabledToast"));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

function userMenu(u: UserView): void {
  actionSheet(u.displayName || u.username, [
    u.role === "admin"
      ? {
          label: t("acc.makeUser"),
          icon: "user",
          run: () => void setRole(u, "user"),
        }
      : {
          label: t("acc.makeAdmin"),
          icon: "shield",
          run: () => void setRole(u, "admin"),
        },
    {
      label: t("acc.delete"),
      icon: "trash",
      danger: true,
      hint: t("acc.deleteHint"),
      run: () => void deleteUser(u),
    },
  ]);
}

async function setRole(u: UserView, role: "admin" | "user"): Promise<void> {
  try {
    replaceUser(
      await apiJson<unknown>("PATCH", `/api/users/${encodeURIComponent(u.id)}`, { role }),
    );
    toast(t(role === "admin" ? "acc.nowAdmin" : "acc.nowUser", { name: accountName(u) }));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

async function deleteUser(u: UserView): Promise<void> {
  const ok = await confirmSheet({
    title: t("acc.deleteTitle", { name: accountName(u) }),
    message: `${u.screens > 0 ? `${tn("n.screensMove", u.screens)} ` : ""}${t("acc.undo")}`,
    confirm: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await apiVoid("DELETE", `/api/users/${encodeURIComponent(u.id)}`);
    users = users.filter((x) => x.id !== u.id);
    renderUsers();
    void refreshScreens();
    toast(t("acc.deletedToast"));
  } catch (err) {
    if (!handleAuth(err)) toast(errText(err), "error");
  }
}

/** Password input + Generate, prefilled with a generated password. */
function passwordField(id: string, label: string): { root: HTMLElement; input: HTMLInputElement } {
  const input = el("input", {
    class: "ui-input pw-input",
    attrs: {
      id,
      type: "text",
      autocomplete: "new-password",
      spellcheck: "false",
      minlength: "8",
      dir: "ltr",
    },
  });
  input.value = generatePassword();
  const gen = button(t("acc.generate"), { icon: "dice" });
  gen.addEventListener("click", () => {
    input.value = generatePassword();
    input.focus();
  });
  return {
    input,
    root: el("div", {}, [
      el("label", { class: "ui-label", text: label, attrs: { for: id } }),
      el("div", { class: "pw-row" }, [input, gen]),
      el("p", { class: "ui-hint", text: t("acc.shownOnce") }),
    ]),
  };
}

function fieldError(): HTMLParagraphElement {
  const p = el("p", { class: "ui-field-error", attrs: { role: "alert" } });
  p.hidden = true;
  return p;
}

/** The new password, once, to pass on; `login` is the e-mail (hosted) or the username. */
function showOnce(sheet: Sheet, title: string, login: string, password: string): void {
  const byEmail = login.includes("@");
  const copy = button(t("common.copy"), { kind: "primary", icon: "copy" });
  const done = button(t("common.done"));
  copy.addEventListener("click", async () => {
    const ok = await copyText(
      t(byEmail ? "acc.onceCopyEmail" : "acc.onceCopy", {
        u: login,
        p: password,
        url: `${window.location.origin}/login`,
      }),
    );
    toast(ok ? t("common.copied") : t("acc.onceCopyFailed"), ok ? "ok" : "error");
  });
  done.addEventListener("click", () => sheet.close());
  sheet.body.replaceChildren(
    el("div", { class: "once" }, [
      el("span", { class: "once-check" }, [icon("check", 24)]),
      el("p", { class: "once-title", text: title }),
      el("p", { class: "once-text", text: t("acc.onceText") }),
      el("dl", { class: "once-creds" }, [
        el("dt", { text: t(byEmail ? "acc.email" : "acc.username") }),
        el("dd", { class: "ltr", text: login }),
        el("dt", { text: t("acc.password") }),
        el("dd", { class: "once-pw ltr", text: password }),
      ]),
      el("div", { class: "ui-sheet-actions-row" }, [done, copy]),
    ]),
  );
  copy.focus();
}

function addUserSheet(): void {
  const byEmail = mode === "hosted";
  const nameIn = el("input", {
    class: "ui-input",
    attrs: { id: "nu-name", autocomplete: "off", dir: "auto" },
  });
  const userIn = el("input", {
    class: "ui-input",
    attrs: {
      id: "nu-username",
      type: byEmail ? "email" : "text",
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      dir: "ltr",
    },
  });
  const pw = passwordField("nu-password", t("acc.password"));
  const roleUser = el("input", { attrs: { type: "radio", name: "nu-role", value: "user" } });
  roleUser.checked = true;
  const roleAdmin = el("input", { attrs: { type: "radio", name: "nu-role", value: "admin" } });
  const role = el("fieldset", { class: "ui-segmented nu-role" }, [
    el("legend", { class: "ui-sr-only", text: t("acc.role") }),
    el("label", {}, [roleUser, el("span", { text: t("role.user") })]),
    el("label", {}, [roleAdmin, el("span", { text: t("role.admin") })]),
  ]);
  const roleHint = el("p", { class: "ui-hint", text: t("acc.roleHint") });
  const error = fieldError();
  const submit = button(t("acc.create"), { kind: "primary", type: "submit" });
  const cancel = button(t("common.cancel"));
  const form = el("form", { class: "ui-sheet-form", attrs: { novalidate: "" } }, [
    el("div", {}, [
      el("label", { class: "ui-label", text: t("acc.name"), attrs: { for: "nu-name" } }),
      nameIn,
    ]),
    el("div", {}, [
      el("label", {
        class: "ui-label",
        text: t(byEmail ? "acc.email" : "acc.username"),
        attrs: { for: "nu-username" },
      }),
      userIn,
    ]),
    el("div", {}, [el("p", { class: "ui-label", text: t("acc.role") }), role, roleHint]),
    pw.root,
    error,
    el("div", { class: "ui-sheet-actions-row" }, [cancel, submit]),
  ]);
  const sheet = openSheet(t("acc.add"), [form]);
  cancel.addEventListener("click", () => sheet.close());
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const login = userIn.value.trim();
    const password = pw.input.value;
    let problem: string | null = null;
    if (
      byEmail ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) : !/^[a-zA-Z0-9._-]{2,40}$/.test(login)
    ) {
      problem = t(byEmail ? "acc.badEmail" : "acc.badUsername");
    } else if (password.length < minPassword()) {
      problem = t("acc.shortPassword", { n: minPassword() });
    }
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    submit.disabled = true;
    try {
      const displayName = nameIn.value.trim();
      const u = await apiJson<unknown>("POST", "/api/users", {
        ...(byEmail ? { email: login } : { username: login }),
        password,
        role: roleAdmin.checked ? "admin" : "user",
        ...(displayName ? { displayName } : {}),
      });
      replaceUser(u);
      showOnce(sheet, t("acc.created"), login, password);
    } catch (err) {
      submit.disabled = false;
      if (handleAuth(err)) return;
      // 409: that e-mail address or username has an account already.
      error.textContent =
        err instanceof ApiError && err.status === 409
          ? t(/e-?mail/i.test(err.message) ? "acc.emailTaken" : "acc.usernameTaken")
          : errText(err);
      error.hidden = false;
      userIn.focus();
    }
  });
  nameIn.focus();
}

function resetPasswordSheet(u: UserView): void {
  const pw = passwordField("rp-password", t("acc.newPassword"));
  const error = fieldError();
  const submit = button(t("acc.setPassword"), { kind: "primary", type: "submit" });
  const cancel = button(t("common.cancel"));
  const form = el("form", { class: "ui-sheet-form", attrs: { novalidate: "" } }, [
    el("p", { class: "ui-sheet-text", text: t("acc.resetText", { name: accountName(u) }) }),
    pw.root,
    error,
    el("div", { class: "ui-sheet-actions-row" }, [cancel, submit]),
  ]);
  const sheet = openSheet(t("acc.resetTitle"), [form]);
  cancel.addEventListener("click", () => sheet.close());
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const password = pw.input.value;
    if (password.length < minPassword()) {
      error.textContent = t("acc.shortPassword", { n: minPassword() });
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      replaceUser(
        await apiJson<unknown>("PATCH", `/api/users/${encodeURIComponent(u.id)}`, { password }),
      );
      showOnce(sheet, t("acc.passwordSet"), u.email ?? u.username, password);
    } catch (err) {
      submit.disabled = false;
      if (handleAuth(err)) return;
      error.textContent = errText(err);
      error.hidden = false;
    }
  });
  pw.input.select();
}

// --- settings ------------------------------------------------------------------------------------

/** The settings status line: a key (re-rendered on a switch) or the server's text. */
let settingsNote: { cls: string; text: () => string } | null = null;

function showSettingsNote(note: typeof settingsNote): void {
  settingsNote = note;
  settingsStatus.className = `setting-status${note?.cls ? ` ${note.cls}` : ""}`;
  settingsStatus.textContent = note?.text() ?? "";
}

async function loadSettings(): Promise<void> {
  try {
    const s = await apiJson<PortalSettings>("GET", "/api/settings");
    requireScreen.checked = s.requireScreen === true;
    requireScreen.disabled = false;
    showSettingsNote(null);
  } catch (err) {
    if (handleAuth(err)) return;
    const message = errText(err);
    showSettingsNote({ cls: "is-error", text: () => message });
  }
}

async function saveRequireScreen(): Promise<void> {
  const want = requireScreen.checked;
  requireScreen.disabled = true;
  showSettingsNote({ cls: "", text: () => t("common.saving") });
  try {
    const s = await apiJson<PortalSettings>("PATCH", "/api/settings", { requireScreen: want });
    requireScreen.checked = s?.requireScreen ?? want;
    showSettingsNote({ cls: "is-ok", text: () => t("common.saved") });
  } catch (err) {
    requireScreen.checked = !want;
    if (handleAuth(err)) return;
    const message = errText(err);
    showSettingsNote({ cls: "is-error", text: () => message });
  } finally {
    requireScreen.disabled = false;
  }
}

/** The mosque's name (PATCH /api/org): owners and admins, once the server has organisations.
 *  Deleting it (DELETE /api/org) is for the owner of a hosted mosque only. The server-wide
 *  "only screen links" setting belongs to a local install. */
function renderOrg(): void {
  requireRow.hidden = mode === "hosted";
  // Hosted: the mosque's name heads its screens (one login is one mosque). A local install is one
  // mosque without a name anywhere: no field that changes nothing.
  const name = mode === "hosted" ? (org?.name.trim() ?? null) : null;
  orgForm.hidden = name === null || !isAdmin();
  orgLine.hidden = name === null || name === "";
  orgLine.textContent = name ?? "";
  orgDelete.hidden = !(org !== null && mode === "hosted" && me?.role === "owner");
  if (org && document.activeElement !== orgName && orgName.value === "") orgName.value = org.name;
}

function deleteOrgSheet(): void {
  const input = el("input", {
    class: "ui-input",
    attrs: {
      id: "del-org-password",
      type: "password",
      autocomplete: "current-password",
      dir: "ltr",
    },
  });
  const error = fieldError();
  const submit = button(t("org.deleteConfirm"), { kind: "danger", type: "submit" });
  const cancel = button(t("common.cancel"));
  const form = el("form", { class: "ui-sheet-form", attrs: { novalidate: "" } }, [
    el("p", { class: "ui-sheet-text", text: t("org.deleteText") }),
    el("div", {}, [
      el("label", {
        class: "ui-label",
        text: t("org.deletePassword"),
        attrs: { for: "del-org-password" },
      }),
      input,
    ]),
    error,
    el("div", { class: "ui-sheet-actions-row" }, [cancel, submit]),
  ]);
  const sheet = openSheet(t("org.deleteTitle"), [form]);
  cancel.addEventListener("click", () => sheet.close());
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (input.value === "") {
      error.textContent = t("common.empty");
      error.hidden = false;
      input.focus();
      return;
    }
    submit.disabled = true;
    try {
      await apiVoid("DELETE", "/api/org", { password: input.value });
      window.location.assign("/");
    } catch (err) {
      submit.disabled = false;
      error.textContent =
        err instanceof ApiError && err.status === 403 ? t("org.wrongPassword") : errText(err);
      error.hidden = false;
      input.select();
    }
  });
  input.focus();
}

async function saveOrgName(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const name = orgName.value.trim();
  if (name === "") {
    orgStatus.className = "setting-status is-error";
    orgStatus.textContent = t("common.empty");
    orgName.focus();
    return;
  }
  orgSave.disabled = true;
  orgStatus.className = "setting-status";
  orgStatus.textContent = t("common.saving");
  try {
    const r = await apiJson<Partial<OrgView> | null>("PATCH", "/api/org", { name });
    if (org) org.name = typeof r?.name === "string" ? r.name : name;
    renderOrg();
    orgStatus.className = "setting-status is-ok";
    orgStatus.textContent = t("common.saved");
  } catch (err) {
    if (handleAuth(err)) return;
    orgStatus.className = "setting-status is-error";
    orgStatus.textContent = errText(err);
  } finally {
    orgSave.disabled = false;
  }
}

// --- sections (the header's navigation) ------------------------------------------------------------

function sectionFromHash(): Section {
  const h = window.location.hash.replace("#", "");
  return h === "accounts" || h === "settings" ? h : "screens";
}

const TITLES: Readonly<Record<Section, MsgKey>> = {
  screens: "dash.docTitle",
  accounts: "acc.title",
  settings: "set.title",
};

function selectSection(want: Section, history: "replace" | "push" | "none" = "replace"): void {
  const s: Section = isAdmin() ? want : "screens";
  section = s;
  for (const [k, panel] of Object.entries(PANELS) as Array<[Section, HTMLElement]>) {
    panel.hidden = k !== s;
  }
  header?.setActive(s);
  setTitle(TITLES[s]);
  const hash = s === "screens" ? "" : `#${s}`;
  if (history !== "none" && window.location.hash !== hash) {
    const url = `${window.location.pathname}${hash}`;
    if (history === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }
  if (s === "accounts") void loadUsers();
  if (s === "settings" && mode !== "hosted") void loadSettings();
}

function onNav(id: NavId, ev: MouseEvent): void {
  if (id !== "screens" && id !== "accounts" && id !== "settings") return;
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
  ev.preventDefault();
  selectSection(id, "push");
  PANELS[id].querySelector<HTMLElement>(".page-title")?.focus({ preventScroll: true });
}

// --- language switch: everything drawn by script is drawn again ---------------------------------

function rerender(): void {
  for (const card of cards.values()) fillCard(card, card.view);
  renderReady(true);
  if (screensProblem !== null) showScreensProblem(screensProblem);
  if (section === "accounts") renderUsers();
  if (settingsNote) showSettingsNote(settingsNote);
  // Drawn again, not loaded again: a reload would wipe the settings note just redrawn.
  setTitle(TITLES[section]);
}

// --- init --------------------------------------------------------------------------------------------

async function init(): Promise<void> {
  initPage(rerender);
  setTitle("dash.docTitle");
  header = mountHeader({ home: "/app", nav: true, active: "screens", onNav });
  void authStateOnce().then((s) => mountFooter({ local: s?.mode !== "hosted" }));
  try {
    // Logged out: straight to the log-in page, without a 401 from /api/auth/me in the console.
    me = (await maybeLoggedIn()) ? await fetchMe() : null;
  } catch (err) {
    screensLoading.hidden = true;
    showScreensProblem(errText(err));
    window.setTimeout(() => window.location.reload(), 10_000);
    return;
  }
  if (!me) {
    window.location.replace(loginUrl("/app"));
    return;
  }
  header.setAccount(me);
  mode = (await authStateOnce())?.mode ?? "local";
  renderOrg();
  addUserBtn.addEventListener("click", addUserSheet);
  requireScreen.addEventListener("change", () => void saveRequireScreen());
  orgForm.addEventListener("submit", (ev) => void saveOrgName(ev));
  orgDeleteBtn.addEventListener("click", deleteOrgSheet);
  readyDone.addEventListener("click", () => {
    readyId = null;
    renderReady();
  });
  for (const p of Object.values(PANELS)) {
    p.querySelector<HTMLElement>(".page-title")?.setAttribute("tabindex", "-1");
  }
  window.addEventListener("popstate", () => selectSection(sectionFromHash(), "none"));
  window.addEventListener("hashchange", () => selectSection(sectionFromHash(), "none"));

  // Back from the builder: say so and show the saved screen with its link.
  const params = new URLSearchParams(window.location.search);
  const saved = params.get("saved");
  if (saved) {
    readyId = saved;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }

  await names.load();
  await refreshScreens();
  schedulePoll();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.clearTimeout(pollTimer);
    else void refreshScreens().then(schedulePoll);
  });
  selectSection(sectionFromHash());

  if (saved) {
    const card = cards.get(saved);
    toast(card ? t("toast.saved", { name: card.view.name }) : t("toast.screenSaved"));
    if (card) {
      card.root.classList.add("is-highlight");
      window.setTimeout(() => card.root.classList.remove("is-highlight"), 2400);
    }
  }

  // The organisation: the missing Soniox key and the mosque's name.
  try {
    org = await fetchOrg();
  } catch {
    org = null;
  }
  keyMissing.hidden = !(org && isAdmin() && !org.keys.soniox.set);
  renderOrg();
}

void init();
