// @vitest-environment happy-dom
// The dashboard's screens (web/admin.ts, /app): getting there, each screen's card with its live
// switch, status and prayer buttons, Clear, Copy link and Show on a screen, the ⋯ menu (rename,
// change look, new link, delete, the owner's switch), the 3-second refresh, the note after a
// screen was saved in the builder, the sections and the language switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenView } from "../../src/shared/protocol.js";
import { message } from "../../web/shared/app-i18n.js";
import { uiLabels } from "../../web/shared/i18n.js";
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
const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

let server: FakeServer;
let admin: FakeUser;
let hidden = false;

beforeEach(() => {
  fakeTimers();
  server = new FakeServer();
  admin = server.addUser({ username: "imam", displayName: "Imam Ali", role: "admin" });
  server.login(admin);
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(window, "isSecureContext");
});

function open(path = "/app", lang: "en" | "nl" | "ar" | null = null): Promise<Opened> {
  return openPage("admin", server, () => import("../../web/admin.js"), {
    url: `http://localhost:3000${path}`,
    lang,
  });
}

function card(name: string): HTMLElement {
  const found = $$(".screen-card").find((c) => text(".sc-name", c) === name);
  if (!found) throw new Error(`no card ${name}`);
  return found;
}

const names = (): string[] => $$(".screen-card").map((c) => text(".sc-name", c));
const shown = (sel: string, root: ParentNode = document): boolean => !$(sel, root).hidden;
const live = (over: Partial<ScreenView["live"]> = {}): ScreenView["live"] => ({
  pages: 0,
  sessions: 0,
  speaking: false,
  since: null,
  event: null,
  ...over,
});

/** The 3-second refresh, once. */
async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3000);
  await settle();
}

/** A menu action's button, by its label (a hint may follow it). */
function action(label: string): HTMLButtonElement {
  const b = $$<HTMLButtonElement>(".ui-sheet-action", sheet()).find(
    (x) => text(".ui-sheet-action-label", x) === label,
  );
  if (!b) throw new Error(`no action "${label}"`);
  return b;
}

async function menu(name: string, label: string): Promise<void> {
  await click($(".sc-more", card(name)));
  await click(action(label));
}

function clipboard(): ReturnType<typeof vi.fn> {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  return vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue() as never;
}

describe("dashboard: getting there", () => {
  it("sends a logged-out visitor to log in, back to the same section", async () => {
    server.session = null;
    const { nav } = await open("/app#accounts");
    expect(nav.replace).toHaveBeenCalledWith("/login?next=%2Fapp%23accounts");
    expect(server.requests()).toEqual(["GET /api/auth/state"]);
  });

  it("says when the account can't be loaded, and reloads a little later", async () => {
    server.once("GET /api/auth/me", { status: 502 });
    const { nav } = await open();
    expect(shown("#screens-loading")).toBe(false);
    expect(text("#screens-error-text")).toBe(en("dash.refreshFailed", { msg: en("err.500") }));
    expect(nav.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nav.reload).toHaveBeenCalledTimes(1);
  });

  it("shows the account and every section to an admin", async () => {
    await open();
    expect(document.title).toBe("Screens · Turjuman");
    expect(text(".acct-name")).toBe("Imam Ali");
    expect($('a[data-nav="screens"]').getAttribute("aria-current")).toBe("page");
    expect($('a[data-nav="accounts"]').hidden).toBe(false);
    expect($('a[data-nav="settings"]').hidden).toBe(false);
    expect($("#screens-title").getAttribute("tabindex")).toBe("-1");
    expect($$("#app-foot a").map((a) => a.getAttribute("href"))).toEqual([
      "/control",
      "/overlay",
      "/health",
    ]);
  });

  it("says there are no screens yet", async () => {
    await open();
    expect(shown("#screens-loading")).toBe(false);
    expect(shown("#screens-empty")).toBe(true);
    expect($$(".screen-card")).toHaveLength(0);
  });
});

describe("dashboard: a screen's card", () => {
  it("shows each screen with its languages, switch, buttons and history", async () => {
    const helper = server.addUser({ username: "helper", displayName: "Yusuf", role: "user" });
    server.addScreen({ name: "Gallery", to: "en", owner: { id: helper.id, displayName: "Yusuf" } });
    const at = Date.now() - 60_000;
    server.addScreen({
      name: "Hall",
      enabled: true,
      owner: { id: admin.id, displayName: "Imam Ali" },
      lastChange: { action: "enabled", by: "Imam Ali", at },
      live: live({ pages: 2, sessions: 1 }),
    });
    await open();
    expect(names()).toEqual(["Hall", "Gallery"]);
    const hall = card("Hall");
    expect(text(".sc-langs", hall)).toBe("Arabic → Dutch");
    expect($<HTMLInputElement>(".big-switch", hall).checked).toBe(true);
    expect(text(".sc-state", hall)).toBe("On");
    expect(hall.classList.contains("is-on")).toBe(true);
    expect(text(".sc-status", hall)).toBe("2 connected · listening");
    expect(shown(".sc-lock", hall)).toBe(false);
    expect(text(".sc-show", hall)).toBe("Show on a screen");
    expect(text(".sc-copy", hall)).toBe("Copy link");
    expect(text(".sc-reset", hall)).toBe("Clear");
    expect($(".sc-reset", hall).title).toBe(en("sc.resetTitle"));
    expect($(".sc-more", hall).getAttribute("aria-label")).toBe("More actions");
    expect(text(".sc-owner", hall)).toBe("Your screen");
    expect(text(".sc-change", hall)).toBe(`Turned on by Imam Ali · ${clock(at)}`);
    expect(text(".sc-feed", hall)).toMatch(/^Link g\d+aaaaaa$/);
    expect($(".sc-feed", hall).title).toBe(en("sc.feedTitle"));
    expect($$(".sc-ev", hall).map((b) => b.textContent)).toEqual(["Athan", "Iqama", "Salah"]);
    expect($$<HTMLButtonElement>(".sc-ev", hall).every((b) => !b.disabled)).toBe(true);
    expect(shown(".sc-ev-stop", hall)).toBe(false);
    expect(shown(".sc-ev-hint", hall)).toBe(false);

    const gallery = card("Gallery");
    expect(text(".sc-langs", gallery)).toBe("Arabic → English");
    expect(text(".sc-state", gallery)).toBe("Off");
    expect(text(".sc-owner", gallery)).toBe("Owner: Yusuf");
    expect(text(".sc-change", gallery)).toBe("");
    expect(text(".sc-ev-hint", gallery)).toBe(en("ev.hintOff"));
    expect($$<HTMLButtonElement>(".sc-ev", gallery).every((b) => b.disabled)).toBe(true);
  });

  it.each<[string, boolean, Partial<ScreenView["live"]>, string, string]>([
    ["off", false, {}, "Off", "is-off"],
    ["off with a page waiting", false, { pages: 1 }, "Off · Connected, waiting", "is-off"],
    ["on without a page", true, {}, "Not connected", "is-idle"],
    ["listening", true, { pages: 1, sessions: 1 }, "Connected · listening", "is-listening"],
    [
      "speaking",
      true,
      { pages: 3, sessions: 1, speaking: true },
      "3 connected · speaking",
      "is-speaking",
    ],
    [
      "showing the Athan",
      true,
      { pages: 1, sessions: 1, event: "athan" },
      "Connected · Athan card on screen",
      "is-event",
    ],
    [
      "in Salah",
      true,
      { pages: 1, sessions: 1, event: "salah" },
      "Connected · Salah, captions paused",
      "is-event",
    ],
  ])("says how a screen is doing: %s", async (_case, enabled, l, want, cls) => {
    server.addScreen({ name: "Hall", enabled, live: live(l) });
    await open();
    expect(text(".sc-status", card("Hall"))).toBe(want);
    expect($(".sc-status", card("Hall")).className).toBe(`sc-status ${cls}`);
  });

  it("reads a screen without live state (an older server) as not connected", async () => {
    server.addScreen({ name: "Hall", enabled: true, live: undefined as never });
    server.addScreen({ name: "Gallery", live: undefined as never });
    await open();
    expect(text(".sc-status", card("Hall"))).toBe("Not connected");
    expect(text(".sc-ev-hint", card("Hall"))).toBe(en("ev.hintNotConnected"));
    expect(text(".sc-status", card("Gallery"))).toBe("Off");
  });

  it("works as a local install when the server's mode can't be asked", async () => {
    server.once("GET /api/auth/state", "network");
    server.addScreen({ name: "Hall" });
    await open();
    expect(server.requests().slice(0, 2)).toEqual(["GET /api/auth/state", "GET /api/auth/me"]);
    expect(names()).toEqual(["Hall"]);
    expect($$("#app-foot a")).toHaveLength(3);
  });

  it("brings back a screen that left the list while it was being switched", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    const held = server.hold("POST /api/screens/s2/enable");
    const toggle = $<HTMLInputElement>(".big-switch", card("Hall"));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    server.once("GET /api/screens", { status: 200, body: [] });
    await poll();
    expect(names()).toEqual([]);
    held.release();
    await settle();
    expect(names()).toEqual(["Hall"]);
    expect(text(".sc-state", card("Hall"))).toBe("On");
  });

  it("names a change it doesn't know as a change, and leaves out a missing link id", async () => {
    server.addScreen({
      name: "Hall",
      guid: "",
      lastChange: { action: "moved" as never, by: "cli", at: Date.now() },
    });
    await open();
    expect(text(".sc-change", card("Hall"))).toMatch(/^Changed by cli · /);
    expect(text(".sc-feed", card("Hall"))).toBe("");
  });

  it("locks a screen an account may not switch", async () => {
    const helper = server.login(server.addUser({ username: "helper", role: "user" }));
    server.addScreen({
      name: "Hall",
      owner: { id: helper.id, displayName: "" },
      canControl: false,
      canEdit: true,
    });
    await open();
    const hall = card("Hall");
    expect(hall.classList.contains("is-locked")).toBe(true);
    expect(text(".sc-lock", hall)).toBe("Locked · ask an admin");
    expect($<HTMLInputElement>(".big-switch", hall).disabled).toBe(true);
    expect($<HTMLButtonElement>(".sc-reset", hall).disabled).toBe(true);
    expect(shown(".sc-ev-hint", hall)).toBe(false);
    // A plain account sees no admin sections.
    expect($('a[data-nav="accounts"]').hidden).toBe(true);
  });

  it("switches a screen on at once, and off again", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    const toggle = $<HTMLInputElement>(".big-switch", card("Hall"));
    const held = server.hold("POST /api/screens/s2/enable");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    // Optimistic: on before the server answers.
    expect(text(".sc-state", card("Hall"))).toBe("On");
    expect(text(".sc-status", card("Hall"))).toBe("Not connected");
    held.release();
    await settle();
    expect(toastText()).toBe("Translation on · Hall");
    expect(server.screens[0]?.enabled).toBe(true);
    expect(text(".sc-change", card("Hall"))).toMatch(/^Turned on by Imam Ali · /);

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(server.last("POST /api/screens/s2/disable")).toBeTruthy();
    expect(toastText()).toBe("Translation off · Hall");
    expect(text(".sc-state", card("Hall"))).toBe("Off");
  });

  it("puts the switch back when the server says no", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    server.once("POST /api/screens/s2/enable", {
      status: 403,
      body: { message: "The admin has not allowed you to switch this screen" },
    });
    const toggle = $<HTMLInputElement>(".big-switch", card("Hall"));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(toggle.checked).toBe(false);
    expect(text(".sc-state", card("Hall"))).toBe("Off");
    expect(toastText()).toBe("The admin has not allowed you to switch this screen");
    expect($("#toast").classList.contains("is-error")).toBe(true);
  });

  it("goes to log in when the login expired", async () => {
    server.addScreen({ name: "Hall" });
    const { nav } = await open();
    server.once("POST /api/screens/s2/enable", { status: 401 });
    const toggle = $<HTMLInputElement>(".big-switch", card("Hall"));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp");
  });

  it("refreshes when the server answers a switch without the screen", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    server.once("POST /api/screens/s2/enable", { status: 200, body: { ok: true } });
    const before = server.requests().filter((r) => r === "GET /api/screens").length;
    const toggle = $<HTMLInputElement>(".big-switch", card("Hall"));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(server.requests().filter((r) => r === "GET /api/screens").length).toBe(before + 1);
  });

  it("clears a screen after asking", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    await click($(".sc-reset", card("Hall")));
    expect(text(".ui-sheet-title", sheet())).toBe(en("reset.title"));
    expect(text(".ui-sheet-text", sheet())).toBe(en("reset.msg", { name: "Hall" }));
    await click(buttonByText("Cancel", sheet()));
    expect(server.requests()).not.toContain("POST /api/screens/s2/reset");

    await click($(".sc-reset", card("Hall")));
    await click(buttonByText("Clear", sheet()));
    expect(server.requests()).toContain("POST /api/screens/s2/reset");
    expect(toastText()).toBe("Cleared");
  });

  it("explains a clear that fails, or goes to log in", async () => {
    server.addScreen({ name: "Hall" });
    const { nav } = await open();
    server.once("POST /api/screens/s2/reset", {
      status: 500,
      body: { message: "Internal server error" },
    });
    await click($(".sc-reset", card("Hall")));
    await click(buttonByText("Clear", sheet()));
    expect(toastText()).toBe(en("err.500"));
    server.once("POST /api/screens/s2/reset", { status: 401 });
    await click($(".sc-reset", card("Hall")));
    await click(buttonByText("Clear", sheet()));
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp");
  });
});

describe("dashboard: links and showing a screen", () => {
  it("copies the public link of a hosted screen", async () => {
    server.mode = "hosted";
    server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 0, estimateUsd: 0 } };
    admin.orgId = "o1";
    const s = server.addScreen({ name: "Hall", localUrl: null });
    const write = clipboard();
    await open();
    await click($(".sc-copy", card("Hall")));
    expect(write).toHaveBeenCalledWith(s.url);
    expect(toastText()).toBe("Link copied");
  });

  it("copies this computer's link on a local install", async () => {
    const s = server.addScreen({ name: "Hall" });
    const write = clipboard();
    await open();
    await click($(".sc-copy", card("Hall")));
    expect(write).toHaveBeenCalledWith(s.localUrl);
  });

  it("says when copying fails", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    await click($(".sc-copy", card("Hall")));
    expect(toastText()).toBe("Copy failed");
  });

  it("explains HTTPS instead of copying a link a TV couldn't use", async () => {
    server.addScreen({ name: "Hall", localUrl: null, secureUrl: null });
    await open();
    await click($(".sc-copy", card("Hall")));
    expect(text(".ui-sheet-title", sheet())).toBe("Show on a screen");
    expect(text(".sos-https-title", sheet())).toBe(en("sos.httpsTitle"));
  });

  it("shows the link and the OBS steps for a screen", async () => {
    server.mode = "hosted";
    server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 0, estimateUsd: 0 } };
    admin.orgId = "o1";
    const s = server.addScreen({ name: "Hall", localUrl: null });
    await open();
    await click($(".sc-show", card("Hall")));
    const sh = sheet();
    expect(sh.classList.contains("ui-sheet-wide")).toBe(true);
    expect(text(".sos-for-name", sh)).toBe("Hall");
    expect(text(".sos-for", sh)).toBe("HallArabic → Dutch");
    expect($<HTMLInputElement>(".sos-url", sh).value).toBe(s.url);
    expect(text(".obs-title", sh)).toBe("OBS Studio");
  });
});

describe("dashboard: the ⋯ menu", () => {
  it("offers rename, look, new link and delete", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    await click($(".sc-more", card("Hall")));
    expect(text(".ui-sheet-title", sheet())).toBe("Hall");
    expect($$(".ui-sheet-action-label", sheet()).map((n) => n.textContent)).toEqual([
      "Rename",
      "Change look",
      "New link",
      "Delete screen",
    ]);
    expect(text(".ui-sheet-action-hint", sheet())).toBe(en("menu.newLinkHint"));
    // The screen's own owner (the admin) gets no switch for "the owner may".
    expect($$("#owner-control")).toHaveLength(0);
  });

  it("renames a screen, and sends nothing when the name stays", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    await menu("Hall", "Rename");
    const input = $<HTMLInputElement>("input", sheet());
    expect(input.value).toBe("Hall");
    await click(buttonByText("Save", sheet()));
    await menu("Hall", "Rename");
    await click(buttonByText("Cancel", sheet()));
    expect(server.requests()).not.toContain("PATCH /api/screens/s2");

    await menu("Hall", "Rename");
    type($<HTMLInputElement>("input", sheet()), "Main hall");
    await click(buttonByText("Save", sheet()));
    expect(server.last("PATCH /api/screens/s2")?.body).toEqual({ name: "Main hall" });
    expect(toastText()).toBe("Renamed");
    expect(names()).toEqual(["Main hall"]);
  });

  it("opens the builder at the look step", async () => {
    server.addScreen({ name: "Hall", id: "s/1" });
    const { nav } = await open();
    await menu("Hall", "Change look");
    expect(nav.assign).toHaveBeenCalledWith("/app/new?screen=s%2F1#step=3");
  });

  it("makes a new link after asking", async () => {
    const s = server.addScreen({ name: "Hall" });
    const old = s.guid;
    await open();
    await menu("Hall", "New link");
    expect(text(".ui-sheet-text", sheet())).toBe(en("regen.msg"));
    await click(buttonByText("Cancel", sheet()));
    expect(server.requests()).not.toContain("POST /api/screens/s2/regenerate");
    await menu("Hall", "New link");
    await click(buttonByText("New link", sheet()));
    expect(toastText()).toBe("New link ready");
    expect(text(".sc-feed", card("Hall"))).not.toContain(old.slice(0, 8));
  });

  it("deletes a screen after asking", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    await menu("Hall", "Delete screen");
    expect(text(".ui-sheet-title", sheet())).toBe("Delete “Hall”?");
    await click(buttonByText("Cancel", sheet()));
    expect(names()).toEqual(["Hall"]);
    await menu("Hall", "Delete screen");
    await click(buttonByText("Delete", sheet()));
    expect(server.requests()).toContain("DELETE /api/screens/s2");
    expect(names()).toEqual([]);
    expect(shown("#screens-empty")).toBe(true);
    expect(toastText()).toBe("Deleted");
  });

  it.each([
    ["Rename", "PATCH /api/screens/s2"],
    ["New link", "POST /api/screens/s2/regenerate"],
    ["Delete screen", "DELETE /api/screens/s2"],
  ])("explains a failed %s, or goes to log in", async (action, route) => {
    server.addScreen({ name: "Hall" });
    const { nav } = await open();
    const confirm = async (): Promise<void> => {
      if (action === "Rename") type($<HTMLInputElement>("input", sheet()), "Other");
      await click($("button.ui-btn-primary, button.ui-btn-danger", sheet()));
    };
    server.once(route, { status: 404, body: { message: "No such screen" } });
    await menu("Hall", action);
    await confirm();
    expect(toastText()).toBe("No such screen");
    expect(names()).toEqual(["Hall"]);
    server.once(route, { status: 401 });
    await menu("Hall", action);
    await confirm();
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp");
  });

  it("does nothing when the screen went away while its menu was open", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    for (const label of ["Rename", "New link", "Delete screen"]) {
      server.addScreen({ name: "Hall", id: "s2" });
      await poll();
      await click($(".sc-more", card("Hall")));
      server.screens = [];
      await poll();
      expect(names()).toEqual([]);
      await click(action(label));
      expect($$("dialog[open]")).toHaveLength(0);
    }
    expect(server.requests().filter((r) => !r.startsWith("GET"))).toEqual([]);
  });

  it("lets an admin allow the owner to switch the screen", async () => {
    const helper = server.addUser({ username: "helper", displayName: "Yusuf", role: "user" });
    server.addScreen({ name: "Hall", owner: { id: helper.id, displayName: "Yusuf" } });
    await open();
    await click($(".sc-more", card("Hall")));
    const sw = $<HTMLInputElement>("#owner-control", sheet());
    expect(sw.checked).toBe(false);
    expect(text(".sheet-toggle-title", sheet())).toBe(en("menu.ownerControl"));
    expect(text("#owner-control-desc", sheet())).toBe("Yusuf");
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await settle();
    expect(server.last("POST /api/screens/s3/owner-control")?.body).toEqual({ allowed: true });
    expect(toastText()).toBe("The owner may switch it");
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await settle();
    expect(toastText()).toBe("Only admins may switch it");

    server.once("POST /api/screens/s3/owner-control", { status: 500 });
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await settle();
    expect(sw.checked).toBe(false);
    expect(toastText()).toBe(en("err.500"));
  });

  it("goes to log in when the owner's switch finds the login expired", async () => {
    const helper = server.addUser({ username: "helper", displayName: "Yusuf", role: "user" });
    server.addScreen({
      name: "Hall",
      owner: { id: helper.id, displayName: "Yusuf" },
      canEdit: false,
    });
    const { nav } = await open();
    await click($(".sc-more", card("Hall")));
    // Only the switch: this admin may not edit the screen itself.
    expect($$(".ui-sheet-action", sheet())).toHaveLength(0);
    server.once("POST /api/screens/s3/owner-control", { status: 401 });
    const sw = $<HTMLInputElement>("#owner-control", sheet());
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await settle();
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp");
  });

  it("says there is nothing to change on a screen the account may only look at", async () => {
    const helper = server.login(server.addUser({ username: "helper", role: "user" }));
    server.addScreen({ name: "Hall", owner: { id: helper.id, displayName: "" }, canEdit: false });
    await open();
    await click($(".sc-more", card("Hall")));
    expect($$("dialog[open]")).toHaveLength(0);
    expect(toastText()).toBe(en("toast.nothing"));
  });
});

describe("dashboard: prayer cards", () => {
  beforeEach(() => {
    server.addScreen({ name: "Hall", enabled: true, live: live({ pages: 1, sessions: 1 }) });
  });

  it("shows the Athan on the screen and ends it again", async () => {
    await open();
    const held = server.hold("POST /api/screens/s2/event");
    await click(buttonByText("Athan", card("Hall")));
    expect($$<HTMLButtonElement>(".sc-ev", card("Hall")).every((b) => b.disabled)).toBe(true);
    held.release();
    await settle();
    expect(server.last("POST /api/screens/s2/event")?.body).toEqual({ event: "athan" });
    expect(toastText()).toBe("Athan on screen · Hall");
    const athan = buttonByText("Athan", card("Hall"));
    expect(athan.getAttribute("aria-pressed")).toBe("true");
    expect(athan.classList.contains("is-active")).toBe(true);
    expect(athan.disabled).toBe(false);
    const stop = $<HTMLButtonElement>(".sc-ev-stop", card("Hall"));
    expect(stop.hidden).toBe(false);
    expect(stop.title).toBe(en("ev.stopTitle"));
    await click(stop);
    expect(server.last("POST /api/screens/s2/event")?.body).toEqual({ event: "none" });
    expect(toastText()).toBe("Card ended · Hall");
    expect($(".sc-ev-stop", card("Hall")).hidden).toBe(true);
  });

  it("says the screen isn't shown anywhere any more, and refreshes", async () => {
    await open();
    server.screens[0] = { ...(server.screens[0] as ScreenView), live: live({ pages: 0 }) };
    const before = server.requests().filter((r) => r === "GET /api/screens").length;
    await click(buttonByText("Iqama", card("Hall")));
    expect(toastText()).toBe(en("ev.hintNotConnected"));
    expect(server.requests().filter((r) => r === "GET /api/screens").length).toBe(before + 1);
    expect(text(".sc-ev-hint", card("Hall"))).toBe(en("ev.hintNotConnected"));
  });

  it("says to switch the screen on when it went off meanwhile", async () => {
    server.screens[0] = { ...(server.screens[0] as ScreenView), enabled: false };
    await open();
    // Switched on here; the Athan is pressed before the server has answered.
    const held = server.hold("POST /api/screens/s2/enable");
    const toggle = $<HTMLInputElement>(".big-switch", card("Hall"));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    server.once("POST /api/screens/s2/event", { status: 409, body: { message: "off" } });
    await click(buttonByText("Athan", card("Hall")));
    expect(toastText()).toBe(en("ev.hintOff"));
    held.release();
    await settle();
  });

  it("explains other failures, or goes to log in", async () => {
    const { nav } = await open();
    server.once("POST /api/screens/s2/event", "network");
    await click(buttonByText("Salah", card("Hall")));
    expect(toastText()).toBe(en("err.network"));
    server.once("POST /api/screens/s2/event", { status: 401 });
    await click(buttonByText("Salah", card("Hall")));
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp");
  });

  it("lets go of a screen that was deleted while its card was being shown", async () => {
    await open();
    const held = server.hold("POST /api/screens/s2/event");
    await click(buttonByText("Athan", card("Hall")));
    server.screens = [];
    await poll();
    expect(names()).toEqual([]);
    held.release({ status: 404, body: { message: "No such screen" } });
    await settle();
    expect(toastText()).toBe("No such screen");
  });
});

describe("dashboard: the refresh", () => {
  it("picks up changes every three seconds", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    server.screens[0] = {
      ...(server.screens[0] as ScreenView),
      enabled: true,
      live: live({ pages: 1, sessions: 1, speaking: true }),
    };
    server.addScreen({ name: "Gallery" });
    await poll();
    expect(names()).toEqual(["Gallery", "Hall"]);
    expect(text(".sc-status", card("Hall"))).toBe("Connected · speaking");
    // Reordered and one gone.
    server.screens = [server.screens[1] as ScreenView, ...server.screens.slice(0, 1)];
    await poll();
    expect(names()).toEqual(["Hall", "Gallery"]);
    server.screens = server.screens.slice(1);
    await poll();
    expect(names()).toEqual(["Gallery"]);
  });

  it("reads an older server's answer and leaves out what isn't a screen", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    server.once("GET /api/screens", {
      status: 200,
      body: { screens: [server.screens[0], { id: "x" }, null, "screen"] },
    });
    await poll();
    expect(names()).toEqual(["Hall"]);
    server.once("GET /api/screens", { status: 200, body: { list: [] } });
    await poll();
    expect(names()).toEqual([]);
    expect(shown("#screens-empty")).toBe(true);
  });

  it("says a refresh failed, and clears it when the next one works", async () => {
    server.addScreen({ name: "Hall" });
    await open();
    server.once("GET /api/screens", "network");
    await poll();
    expect(text("#screens-error-text")).toBe(en("dash.refreshFailed", { msg: en("err.network") }));
    expect(names()).toEqual(["Hall"]);
    await poll();
    expect(shown("#screens-error")).toBe(false);
  });

  it("shows the failure in place of the loading line on the first load", async () => {
    server.once("GET /api/screens", { status: 500 });
    await open();
    expect(shown("#screens-loading")).toBe(false);
    expect(shown("#screens-error")).toBe(true);
  });

  it("goes to log in when a refresh finds the login expired", async () => {
    const { nav } = await open();
    server.once("GET /api/screens", { status: 401 });
    await poll();
    expect(nav.assign).toHaveBeenCalledWith("/login?next=%2Fapp");
  });

  it("stops while the page is hidden and refreshes as soon as it is back", async () => {
    await open();
    const count = (): number => server.requests().filter((r) => r === "GET /api/screens").length;
    const first = count();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await poll();
    await poll();
    expect(count()).toBe(first);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(count()).toBe(first + 1);
    await poll();
    expect(count()).toBe(first + 2);
  });

  it("never schedules the refresh while hidden", async () => {
    hidden = true;
    await open();
    const first = server.requests().filter((r) => r === "GET /api/screens").length;
    await poll();
    expect(server.requests().filter((r) => r === "GET /api/screens").length).toBe(first);
  });

  it("asks once at a time", async () => {
    await open();
    const held = server.hold("GET /api/screens");
    await poll();
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    held.release();
    await settle();
    // The timer's refresh was on its way: the one for the page coming back was skipped.
    expect(server.requests().filter((r) => r === "GET /api/screens")).toHaveLength(2);
  });
});

describe("dashboard: back from the builder", () => {
  it("shows the saved screen with its link, says it starts off, and highlights it", async () => {
    const s = server.addScreen({ name: "Hall", to: "nl" });
    await open(`/app?saved=${s.id}`);
    expect(window.location.search).toBe("");
    expect(shown("#ready")).toBe(true);
    expect(text("#ready-off")).toBe(en("dash.readyOff", { off: uiLabels("nl").screenOffTitle }));
    expect($<HTMLInputElement>("#ready-body .sos-url").value).toBe(s.localUrl);
    // The note has the link only; the OBS steps are one tap further.
    expect($$("#ready-body .obs-guide")).toHaveLength(0);
    expect(toastText()).toBe("Saved · Hall");
    expect(card("Hall").classList.contains("is-highlight")).toBe(true);
    await vi.advanceTimersByTimeAsync(2400);
    expect(card("Hall").classList.contains("is-highlight")).toBe(false);

    await click(buttonByText("Steps for OBS", $("#ready")));
    expect(text(".sos-for-name", sheet())).toBe("Hall");
    expect($$(".obs-guide", sheet())).toHaveLength(1);
    await click($(".ui-sheet-close", sheet()));

    await click("#ready-done");
    expect(shown("#ready")).toBe(false);
  });

  it("keeps the note as it is while nothing about the link changes", async () => {
    const s = server.addScreen({ name: "Hall", enabled: true });
    await open(`/app?saved=${s.id}#accounts`);
    expect(window.location.hash).toBe("#accounts");
    // Opened on the accounts section: the note waits on the screens panel.
    expect(shown("#panel-screens")).toBe(false);
    expect(shown("#ready-off")).toBe(false);
    const note = $("#ready-body").firstElementChild;
    server.screens[0] = { ...(server.screens[0] as ScreenView), name: "Main hall" };
    await poll();
    expect($("#ready-body").firstElementChild).toBe(note);
    // The steps show the latest name.
    await click(buttonByText("Steps for OBS", $("#ready")));
    expect(text(".sos-for-name", sheet())).toBe("Main hall");
    await click($(".ui-sheet-close", sheet()));
    // A new link redraws it.
    server.screens[0] = {
      ...(server.screens[0] as ScreenView),
      localUrl: "http://127.0.0.1:8765/feed/new",
    };
    await poll();
    expect($("#ready-body").firstElementChild).not.toBe(note);
    expect($<HTMLInputElement>("#ready-body .sos-url").value).toBe(
      "http://127.0.0.1:8765/feed/new",
    );
  });

  it("says the screen was saved even when it isn't in the list", async () => {
    await open("/app?saved=elsewhere");
    expect(toastText()).toBe("Screen saved");
    expect(shown("#ready")).toBe(false);
  });

  it("drops the note when its screen is deleted", async () => {
    const s = server.addScreen({ name: "Hall" });
    await open(`/app?saved=${s.id}`);
    await menu("Hall", "Delete screen");
    await click(buttonByText("Delete", sheet()));
    expect(shown("#ready")).toBe(false);
    server.addScreen({ name: "Hall", id: s.id });
    await poll();
    expect(shown("#ready")).toBe(false);
  });

  it("keeps the note of another screen when one is deleted", async () => {
    const hall = server.addScreen({ name: "Hall" });
    server.addScreen({ name: "Gallery" });
    await open(`/app?saved=${hall.id}`);
    await menu("Gallery", "Delete screen");
    await click(buttonByText("Delete", sheet()));
    expect(shown("#ready")).toBe(true);
  });
});

describe("dashboard: sections", () => {
  it("switches sections from the header without leaving the page", async () => {
    const { nav } = await open();
    const accounts = $<HTMLAnchorElement>('a[data-nav="accounts"]');
    accounts.click();
    await settle();
    expect(nav.open).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#accounts");
    expect(shown("#panel-accounts")).toBe(true);
    expect(shown("#panel-screens")).toBe(false);
    expect(document.title).toBe("Accounts · Turjuman");
    expect(document.activeElement?.id).toBe("accounts-title");
    expect(accounts.getAttribute("aria-current")).toBe("page");
    expect(server.requests()).toContain("GET /api/users");

    $<HTMLAnchorElement>('a[data-nav="settings"]').click();
    await settle();
    expect(document.title).toBe("Settings · Turjuman");
    expect(server.requests()).toContain("GET /api/settings");

    $<HTMLAnchorElement>('a[data-nav="screens"]').click();
    await settle();
    expect(window.location.hash).toBe("");
    expect(shown("#panel-screens")).toBe(true);
    expect(document.title).toBe("Screens · Turjuman");
  });

  it("leaves a click with a modifier key, and the other pages' links, to the browser", async () => {
    const { nav } = await open();
    $('a[data-nav="accounts"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    $('a[data-nav="settings"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }),
    );
    $<HTMLAnchorElement>('a[data-nav="keys"]').click();
    await settle();
    expect(nav.open).toHaveBeenCalledTimes(3);
    expect(shown("#panel-screens")).toBe(true);
  });

  it("follows the address when it changes (back and forward)", async () => {
    await open();
    window.history.pushState(null, "", "/app#settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect(shown("#panel-settings")).toBe(true);
    window.history.pushState(null, "", "/app#accounts");
    window.dispatchEvent(new Event("hashchange"));
    await settle();
    expect(shown("#panel-accounts")).toBe(true);
    window.history.pushState(null, "", "/app#nothing");
    window.dispatchEvent(new Event("hashchange"));
    await settle();
    expect(shown("#panel-screens")).toBe(true);
  });

  it("keeps a plain account on the screens", async () => {
    server.login(server.addUser({ username: "helper", role: "user" }));
    await open("/app#settings");
    expect(shown("#panel-screens")).toBe(true);
    expect(shown("#panel-settings")).toBe(false);
    expect(window.location.hash).toBe("");
    expect(server.requests()).not.toContain("GET /api/settings");
  });
});

describe("dashboard: the mosque and its key", () => {
  beforeEach(() => {
    server.mode = "hosted";
    server.org = { id: "o1", name: "Al-Noor", usage: { monthMinutes: 0, estimateUsd: 0 } };
    admin.orgId = "o1";
  });

  it("asks a hosted admin for the Soniox key and heads the screens with the mosque", async () => {
    await open();
    expect(shown("#key-missing")).toBe(true);
    expect(text("#org-line")).toBe("Al-Noor");
    expect(shown("#org-line")).toBe(true);
    expect($$("#app-foot a")).toHaveLength(0);
  });

  it("doesn't ask once the key is there, nor a plain account", async () => {
    server.soniox = {
      provider: "soniox",
      set: true,
      last4: "abcd",
      validatedAt: null,
      source: "stored",
    };
    await open();
    expect(shown("#key-missing")).toBe(false);
    cleanup();
    fakeTimers();
    server.soniox = { ...server.soniox, set: false };
    server.login(server.addUser({ username: "helper", role: "user", orgId: "o1" }));
    await open();
    expect(shown("#key-missing")).toBe(false);
  });

  it("does without the mosque when it can't be loaded", async () => {
    server.once("GET /api/org", { status: 500 });
    await open();
    expect(shown("#key-missing")).toBe(false);
    expect(shown("#org-line")).toBe(false);
  });

  it("has no mosque line for a mosque without a name", async () => {
    if (server.org) server.org.name = "  ";
    await open();
    expect(shown("#org-line")).toBe(false);
  });
});

describe("dashboard: languages", () => {
  it("draws every card again after a language switch", async () => {
    server.addScreen({ name: "Hall", enabled: true, live: live({ pages: 2, sessions: 1 }) });
    await open();
    server.once("GET /api/screens", "network");
    await poll();
    await click('.lang-btn[lang="nl"]');
    const hall = card("Hall");
    expect(text(".sc-state", hall)).toBe(message("nl", "sc.on"));
    expect(text(".sc-langs", hall)).toBe("Arabisch → Nederlands");
    expect(text(".sc-copy", hall)).toBe(message("nl", "sc.copyLink"));
    expect(text("#screens-error-text")).toBe(
      message("nl", "dash.refreshFailed", { msg: en("err.network") }),
    );
    expect(document.title).toBe(`${message("nl", "dash.docTitle")} · Turjuman`);
  });

  it("writes Arabic right to left", async () => {
    const s = server.addScreen({ name: "القاعة" });
    await open(`/app?saved=${s.id}`, "ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(text(".sc-langs", card("القاعة"))).toBe(
      `العربية ${message("ar", "common.arrow")} الهولندية`,
    );
    expect(text("#ready-off")).toBe(
      message("ar", "dash.readyOff", { off: uiLabels("nl").screenOffTitle }),
    );
  });
});
