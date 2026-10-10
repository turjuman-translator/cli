// Hosted mode, the way a mosque goes through it in a real Chrome against the built server: sign
// up, add the Soniox key, make a screen in the builder, show it on a TV (a second context with a
// fake microphone: captions replay a provider log), switch it from the dashboard and from a phone,
// show the prayer cards, clear, rename, restyle, renew and delete it, read its archive, manage
// accounts and the mosque's settings, change the password, log out and in, stay apart from another
// mosque (which deletes itself), and do it all again in Dutch and in Arabic. Then, on servers of
// their own: the log-in rate limit, the key check against a stand-in for Soniox, and a server
// whose sign-up is closed. Every page must end without console errors, page errors or CSP
// violations (a refused request the flow expects is named).
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventLabel, uiLabels } from "../../../web/shared/i18n.js";
import {
  type AppServer,
  api,
  appServer,
  Cleanup,
  captionStats,
  chrome,
  cookieHeader,
  cssVar,
  FAKE_KEY,
  FAKE_KEY_2,
  FIRST_CAPTION,
  hostedYaml,
  htmlLangDir,
  refused,
  say,
  sayN,
  tab,
  takeProblems,
  textOf,
  toasted,
  waitForStats,
  waitUntil,
} from "../helpers/app-tools.js";
import type { WatchedPage } from "../helpers/browser.js";
import { startFakeSoniox } from "../helpers/cli-tools.js";

/** The TV shows the caption language's own words (Dutch). */
const TV_LABELS = uiLabels("nl");

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

const OWNER = {
  org: "Masjid An-Noor",
  name: "Imam Yusuf",
  email: "yusuf@an-noor.example",
  password: "khutbah-friday-2026",
};
/** The owner's password after the change in the account menu. */
const NEW_PASSWORD = "khutbah-saturday-2026";
/** The second account of the mosque. */
const HELPER = { name: "Brother Bilal", email: "bilal@an-noor.example" };

let srv: AppServer;
let browser: Browser;
/** The owner's browser (one context for the whole story). */
let owner: WatchedPage;

beforeAll(async () => {
  srv = await appServer(cleanup, { yaml: hostedYaml });
  browser = await chrome(cleanup, srv.inst.dir);
  owner = await tab(browser, srv.url);
});

function en(key: Parameters<typeof say>[1], vars?: Parameters<typeof say>[2]): string {
  return say("en", key, vars);
}

/** The page has nothing in its console, no uncaught error and no CSP violation. */
function clean(w: WatchedPage): void {
  expect(takeProblems(w)).toEqual([]);
}

/** A screen as GET /api/screens shows it (the fields these tests read). */
interface ScreenRow {
  id: string;
  name: string;
  from: string;
  to: string;
  query: string;
  guid: string;
  enabled: boolean;
  url: string;
}

async function screensOf(w: WatchedPage): Promise<ScreenRow[]> {
  const r = await api(srv.url, "GET", "/api/screens", { cookie: await cookieHeader(w) });
  expect(r.status).toBe(200);
  return r.body as ScreenRow[];
}

/** The TV: a context of its own (no login) that shows the screen link. */
let tv: WatchedPage;
let screen: ScreenRow;
/** The TV's last caption session (ended when its screen was deleted). */
let sessionId = "";
/** Bilal's browser, and the password the owner gave him. */
let helper: WatchedPage;
let helperPassword = "";

/** The screen's card on a dashboard. */
function card(page: Page) {
  return page.locator(`article.screen-card[data-id="${screen.id}"]`);
}

/** An ended prayer card as the TV shows it: the Arabic name, the title and the time it began. */
function compactCard(type: "iqama" | "salah"): RegExp {
  const label = eventLabel(type, "nl");
  return new RegExp(`^${label.ar}${label.title} · \\d\\d:\\d\\d$`);
}

/** The prayer card on the TV, active or ended. */
function eventCard(page: Page, type: string, state: "is-active" | "is-ended") {
  return page.locator(`#captions .blk-event.${state}[data-event="${type}"]`);
}

/** Sign a mosque up through /signup in a page of its own; it lands on its keys. */
async function signUp(
  w: WatchedPage,
  who: { org: string; name: string; email: string; password: string },
  base = srv.url,
): Promise<void> {
  await w.page.goto(`${base}/signup`);
  await w.page.locator("#org-name").fill(who.org);
  await w.page.locator("#your-name").fill(who.name);
  await w.page.locator("#email").fill(who.email);
  await w.page.locator("#new-password").fill(who.password);
  await w.page.locator("#signup-submit").click();
  await w.page.waitForURL(`${base}/app/keys`);
}

/** The open sheet (a native <dialog>) of a page. */
function sheet(page: Page) {
  return page.locator("dialog.ui-sheet[open]");
}

describe("hosted: a mosque signs up and adds its Soniox key", () => {
  it("signs up at /signup (checking the form first) and lands on the key onboarding", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/signup`);
    await page.getByRole("heading", { name: en("signup.title") }).waitFor();
    // The form says what is missing before anything is sent.
    await page.getByLabel(en("signup.org")).fill(OWNER.org);
    await page.getByLabel(en("signup.name")).fill(OWNER.name);
    await page.getByLabel(en("signup.email")).fill(OWNER.email);
    await page.getByLabel(en("signup.password"), { exact: true }).fill("too-short");
    await page.getByRole("button", { name: en("signup.submit") }).click();
    await textOf(page.locator("#signup-error-text"), en("signup.errPassword"));
    await page.getByLabel(en("signup.password"), { exact: true }).fill(OWNER.password);
    await page.getByRole("button", { name: en("signup.submit") }).click();

    await page.waitForURL(`${srv.url}/app/keys`);
    await page.getByRole("heading", { name: en("keys.sonioxTitle") }).waitFor();
    await textOf(page.locator("#keys-lead"), en("keys.leadNew"));
    // Onboarding: the numbered steps to get a key, and the field to paste it.
    expect(await page.locator(".kx-steps li").count()).toBe(4);
    await page.getByPlaceholder(en("keys.placeholder")).waitFor();
    await textOf(page.locator("#next-text"), en("keys.nextLater"));
    clean(owner);
  });

  it("adds the key (stored unchecked: Soniox can't be reached), replaces it, removes it and adds it again", async () => {
    const page = owner.page;
    const slot = page.locator("#kx-soniox");
    const status = slot.locator(".kf-state");

    await page.getByPlaceholder(en("keys.placeholder")).fill(FAKE_KEY);
    await slot.getByRole("button", { name: en("keys.save") }).click();
    await textOf(slot.locator(".kx-result"), en("keys.unreachable", { provider: "Soniox" }));
    await textOf(status, en("keys.storedUnchecked"));
    await textOf(slot.locator(".kf-mask"), `••••••••••••${FAKE_KEY.slice(-4)}`);
    await textOf(page.locator("#keys-lead"), en("keys.lead"));
    // With a key and no screen yet, the next step is the builder.
    await textOf(page.locator("#next-link"), en("keys.nextFirst"));
    expect(await page.locator("#next-link").getAttribute("href")).toBe("/app/new");

    await slot.getByRole("button", { name: en("keys.replace") }).click();
    await page.getByPlaceholder(en("keys.placeholder")).fill(FAKE_KEY_2);
    await slot.getByRole("button", { name: en("keys.save") }).click();
    await textOf(slot.locator(".kf-mask"), `••••••••••••${FAKE_KEY_2.slice(-4)}`);
    await textOf(status, en("keys.storedUnchecked"));

    await slot.getByRole("button", { name: en("keys.remove"), exact: true }).click();
    await textOf(slot.locator(".kx-confirm p"), en("keys.removeSoniox"));
    await slot.getByRole("button", { name: en("keys.removeYes") }).click();
    await toasted(page, en("keys.removed"));
    await page.getByPlaceholder(en("keys.placeholder")).waitFor();
    await textOf(page.locator("#keys-lead"), en("keys.leadNew"));

    await page.getByPlaceholder(en("keys.placeholder")).fill(FAKE_KEY);
    await slot.getByRole("button", { name: en("keys.save") }).click();
    await textOf(slot.locator(".kf-mask"), `••••••••••••${FAKE_KEY.slice(-4)}`);

    // The server says the same: set, last four characters, never checked; the key never comes back.
    const org = await api(srv.url, "GET", "/api/org", { cookie: await cookieHeader(owner) });
    expect(org.body).toMatchObject({
      name: OWNER.org,
      role: "owner",
      keys: { soniox: { set: true, last4: FAKE_KEY.slice(-4), validatedAt: null } },
    });
    expect(JSON.stringify(org.body)).not.toContain(FAKE_KEY);
    // Every check was refused by the jail before it left this computer: nothing reached Soniox.
    const attempts = srv.netAttempts();
    expect(attempts.length).toBe(3);
    for (const a of attempts) {
      expect(a).toMatchObject({ host: "api.soniox.com", port: 443, action: "blocked" });
    }
    clean(owner);
  });
});

describe("hosted: a screen from the builder to the TV", () => {
  it("makes a screen in the builder (ar → nl, a look, a placement) and sees it on the dashboard", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/app/new`);
    await textOf(page.locator("#b-title"), en("b.newScreen"));
    await textOf(page.locator("#server-status-text"), en("b.ready"));
    // 1 · Languages: the popular pair, Arabic spoken and Dutch captions.
    await page.locator(".pair-chip", { hasText: "Arabic → Dutch" }).click();
    expect(await page.locator("#from").inputValue()).toBe("ar");
    expect(await page.locator("#to").inputValue()).toBe("nl");
    await page.getByRole("button", { name: en("common.next") }).click();
    // 2 · Layout: blocks.
    await page.locator(".choice-card", { hasText: en("b.blocks") }).click();
    await page.getByRole("button", { name: en("common.next") }).click();
    // 3 · Look: Mosque light instead of the default dark one.
    await page.locator(".theme-card", { hasText: en("preset.mosque-light") }).click();
    expect(await page.locator('input[name="preset"][value="mosque-light"]').isChecked()).toBe(true);
    await page.getByRole("button", { name: en("common.next") }).click();
    // 4 · Adjust: the captions at the top of the screen.
    await page.getByRole("button", { name: `${en("plc.top")} · ${en("plc.center")}` }).click();
    expect(
      await page
        .getByRole("button", { name: `${en("plc.top")} · ${en("plc.center")}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page.getByRole("button", { name: en("common.next") }).click();
    // 5 · Microphone: the default one. 6 · Save.
    await page.getByRole("button", { name: en("common.next") }).click();
    await textOf(page.locator("#last-title"), en("b.saveScreen"));
    await page.getByRole("button", { name: en("b.saveAsScreen") }).click();
    await textOf(page.locator("#save-error"), en("b.enterName"));
    await page.getByLabel(en("b.screenName")).fill("Main hall TV");
    await page.getByRole("button", { name: en("b.saveAsScreen") }).click();

    await page.waitForURL(`${srv.url}/app`);
    const list = await screensOf(owner);
    expect(list).toHaveLength(1);
    screen = list[0] as ScreenRow;
    expect(screen).toMatchObject({ name: "Main hall TV", from: "ar", to: "nl", enabled: false });
    const query = new URLSearchParams(screen.query);
    expect(query.get("preset")).toBe("mosque-light");
    expect(query.get("pos")).toBe("top");
    expect(screen.url).toBe(`${srv.url}/feed/${screen.guid}`);

    // The dashboard: the card (off, nobody showing it yet) and "your screen is ready".
    await textOf(card(page).locator(".sc-name"), "Main hall TV");
    await textOf(card(page).locator(".sc-langs"), "Arabic → Dutch");
    await textOf(card(page).locator(".sc-status"), en("status.off"));
    expect(await card(page).locator("input.big-switch").isChecked()).toBe(false);
    await textOf(page.locator("#ready-title"), en("dash.readyTitle"));
    expect(await page.locator("#ready .sos-url").inputValue()).toBe(screen.url);
    await toasted(page, en("toast.saved", { name: "Main hall TV" }));
    clean(owner);
  });

  it("copies the screen link; the TV shows the off card, then captions once the screen is on", async () => {
    const page = owner.page;
    await card(page)
      .getByRole("button", { name: en("sc.copyLink") })
      .click();
    await toasted(page, en("toast.linkCopied"));
    const copied = String(await page.evaluate("navigator.clipboard.readText()"));
    expect(copied).toBe(screen.url);

    tv = await tab(browser, srv.url);
    await tv.page.goto(copied);
    // The feed link opens the caption page with the screen's languages and look.
    expect(new URL(tv.page.url()).pathname).toBe("/ar/nl");
    await waitForStats(tv.page, "the off state", (s) => s.screen?.state === "disabled");
    await textOf(tv.page.locator(".scr-wrap.is-off .scr-title"), TV_LABELS.screenOffTitle);
    await textOf(tv.page.locator(".scr-wrap.is-off .scr-name"), "Main hall TV");
    expect(await cssVar(tv.page, "--cap-text-color")).toBe("#2b2a28");
    // The dashboard sees the TV waiting; the prayer buttons wait for the screen to be on.
    await textOf(
      card(page).locator(".sc-status"),
      en("status.offWaiting", { where: sayN("en", "n.connected", 1) }),
    );
    await textOf(card(page).locator(".sc-ev-hint"), en("ev.hintOff"));
    expect(
      await card(page)
        .getByRole("button", { name: en("ev.athan") })
        .isDisabled(),
    ).toBe(true);

    await card(page).locator("input.big-switch").check();
    await toasted(page, en("toast.on", { name: "Main hall TV" }));
    const live = await waitForStats(tv.page, "caption blocks", (s) => s.blocks >= 1, 30_000);
    expect(live.screen?.state).toBe("enabled");
    await textOf(tv.page.locator("#captions .blk-text").first(), new RegExp(`^${FIRST_CAPTION}`));
    await textOf(
      card(page).locator(".sc-status"),
      new RegExp(`^${sayN("en", "n.connected", 1)} · (listening|speaking)$`),
    );
    clean(owner);
    clean(tv);
  });

  it("switches the screen off on the dashboard (the TV shows the off card) and on again", async () => {
    const page = owner.page;
    await card(page).locator("input.big-switch").uncheck();
    await toasted(page, en("toast.off", { name: "Main hall TV" }));
    await waitForStats(tv.page, "the off state", (s) => s.screen?.state === "disabled");
    await textOf(tv.page.locator(".scr-wrap.is-off .scr-title"), TV_LABELS.screenOffTitle);
    await waitUntil(
      "the captions to fade away",
      async () => (await tv.page.locator("#captions .blk-text").count()) === 0,
    );
    expect((await screensOf(owner))[0]?.enabled).toBe(false);

    await card(page).locator("input.big-switch").check();
    await toasted(page, en("toast.on", { name: "Main hall TV" }));
    await waitForStats(
      tv.page,
      "captions again",
      (s) => s.screen?.state === "enabled" && s.blocks >= 1,
      30_000,
    );
    expect(await tv.page.locator(".scr-wrap.is-shown").count()).toBe(0);
    clean(owner);
    clean(tv);
  });

  it("shows the Athan, Iqama and Salah cards on the TV from the dashboard, and ends them", async () => {
    const page = owner.page;
    const events = [
      ["athan", "ev.athan", "status.athan"],
      ["iqama", "ev.iqama", "status.iqama"],
      ["salah", "ev.salah", "status.salah"],
    ] as const;
    for (const [type, button, status] of events) {
      await card(page)
        .getByRole("button", { name: en(button), exact: true })
        .click();
      await toasted(page, en("toast.evShown", { event: en(button), name: "Main hall TV" }));
      // The TV says it in the caption language.
      await textOf(
        eventCard(tv.page, type, "is-active").locator(".ev-title"),
        eventLabel(type, "nl").title,
      );
      expect(
        await card(page)
          .getByRole("button", { name: en(button), exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await textOf(
        card(page).locator(".sc-status"),
        en(status, { where: sayN("en", "n.connected", 1) }),
      );
    }
    // One card at a time: the Athan card became the Iqama card, which ended when Salah began.
    expect(await tv.page.locator("#captions .blk-event.is-active").count()).toBe(1);
    await textOf(
      eventCard(tv.page, "iqama", "is-ended").locator(".ev-compact"),
      compactCard("iqama"),
    );
    await card(page)
      .getByRole("button", { name: en("ev.stop") })
      .click();
    await toasted(page, en("toast.evEnded", { name: "Main hall TV" }));
    await waitUntil(
      "no prayer card on the TV",
      async () => (await tv.page.locator("#captions .blk-event.is-active").count()) === 0,
    );
    await textOf(
      eventCard(tv.page, "salah", "is-ended").locator(".ev-compact"),
      compactCard("salah"),
    );
    await textOf(
      card(page).locator(".sc-status"),
      new RegExp(`^${sayN("en", "n.connected", 1)} · (listening|speaking)$`),
    );
    clean(owner);
    clean(tv);
  });

  it("from a phone: the owner logs in and switches the screen off and on, and the TV follows", async () => {
    const phone = await tab(browser, srv.url, { width: 390, height: 844, isMobile: true });
    const page = phone.page;
    await page.goto(`${srv.url}/login`);
    await page.locator("#username").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.locator("#login-submit").click();
    await page.waitForURL(`${srv.url}/app`);
    // A phone gets the navigation as a tab bar.
    expect(await page.evaluate("document.body.classList.contains('has-tabs')")).toBe(true);
    await card(page).locator("input.big-switch").uncheck();
    await toasted(page, en("toast.off", { name: "Main hall TV" }));
    await waitForStats(tv.page, "the off state", (s) => s.screen?.state === "disabled");
    await card(page).locator("input.big-switch").check();
    await toasted(page, en("toast.on", { name: "Main hall TV" }));
    await waitForStats(
      tv.page,
      "captions again",
      (s) => s.screen?.state === "enabled" && s.blocks >= 1,
      30_000,
    );
    clean(phone);
    clean(tv);
    await phone.context.close();
  });
});

describe("hosted: a look of the mosque's own", () => {
  it("the owner saves a look in the look editor; the mosque sees it, a visitor doesn't", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/app`);
    await page.locator('a[data-nav="look"]').click();
    await page.waitForURL(`${srv.url}/app/look`);
    await textOf(page.locator(".cz-title"), en("look.title"));
    // Hosted: no caption links or server default here; a look is chosen per screen.
    await textOf(page.locator("#use-lead"), en("lk.useHosted"));
    expect(await page.locator("#use-local").isHidden()).toBe(true);
    await page.locator("#gallery .pcard-main", { hasText: en("preset.high-contrast") }).click();
    await textOf(page.locator("#current-name"), en("preset.high-contrast"));
    const colour = page.getByLabel(en("lk.valueOf", { label: en("lk.textColour") }));
    await colour.fill("#ffcc00");
    await colour.press("Enter");
    await textOf(page.locator("#current-edited"), sayN("en", "n.changes", 1));
    await page.locator("#save").click();
    await textOf(page.locator("#save-text"), en("lk.saveTextHosted"));
    await page.locator("#save-name").fill("Noor look");
    await page.locator("#save-confirm").click();
    await toasted(page, en("lk.savedNamed", { name: "Noor look" }));
    await textOf(page.locator("#current-name"), "Noor look");

    const ids = (r: { body: unknown }) =>
      ((r.body as { custom: Array<{ id: string }> }).custom ?? []).map((p) => p.id);
    const cookie = await cookieHeader(owner);
    expect(ids(await api(srv.url, "GET", "/api/presets", { cookie }))).toEqual(["noor-look"]);
    expect(ids(await api(srv.url, "GET", "/api/presets"))).toEqual([]);
    // The mosque's screens (their pages carry ?screen=) get it as well.
    expect(ids(await api(srv.url, "GET", `/api/presets?screen=${screen.guid}`))).toEqual([
      "noor-look",
    ]);
    clean(owner);
  });
});

describe("hosted: two mosques on one server", () => {
  it("keeps a second mosque apart: it sees no screens or accounts of the first and can't touch them", async () => {
    const other = await tab(browser, srv.url);
    await signUp(other, {
      org: "Masjid Al-Huda",
      name: "Sister Maryam",
      email: "maryam@al-huda.example",
      password: "another-long-password",
    });
    await other.page.goto(`${srv.url}/app`);
    await textOf(other.page.locator("#screens-empty .empty-title"), en("dash.emptyTitle"));
    await textOf(other.page.locator("#key-missing .adm-key-text"), en("dash.keyMissing"));
    expect(await other.page.locator("article.screen-card").count()).toBe(0);
    await textOf(other.page.locator("#org-line"), "Masjid Al-Huda");

    const cookie = await cookieHeader(other);
    expect((await api(srv.url, "GET", "/api/screens", { cookie })).body).toEqual([]);
    const users = (await api(srv.url, "GET", "/api/users", { cookie })).body as Array<{
      email: string;
    }>;
    expect(users.map((u) => u.email)).toEqual(["maryam@al-huda.example"]);
    const presets = (await api(srv.url, "GET", "/api/presets", { cookie })).body as {
      custom: unknown[];
    };
    expect(presets.custom).toEqual([]);
    // The first mosque's screen is not there for the second: every action says it doesn't exist.
    const attempts: Array<[string, string, unknown]> = [
      ["PATCH", `/api/screens/${screen.id}`, { name: "Taken" }],
      ["POST", `/api/screens/${screen.id}/disable`, {}],
      ["POST", `/api/screens/${screen.id}/event`, { event: "athan" }],
      ["POST", `/api/screens/${screen.id}/regenerate`, {}],
      ["DELETE", `/api/screens/${screen.id}`, {}],
    ];
    for (const [method, path, body] of attempts) {
      expect(await api(srv.url, method, path, { cookie, body }), `${method} ${path}`).toEqual({
        status: 404,
        body: { ok: false, message: "No such screen" },
      });
    }
    // The first mosque's live captions are its own as well.
    const stats = await captionStats(tv.page);
    const blocks = `/api/sessions/${stats?.sessionId ?? ""}/blocks`;
    expect((await api(srv.url, "GET", blocks, { cookie })).status).toBe(401);
    expect((await api(srv.url, "GET", blocks, { cookie: await cookieHeader(owner) })).status).toBe(
      200,
    );
    // Nothing changed for the first mosque: its screen is on and its TV shows captions.
    expect((await screensOf(owner))[0]).toMatchObject({ name: "Main hall TV", enabled: true });
    expect((await captionStats(tv.page))?.screen?.state).toBe("enabled");

    // The second mosque leaves: its owner deletes it in Settings, with the password.
    await other.page.locator('a[data-nav="settings"]').click();
    await textOf(other.page.locator("#settings-title"), en("set.title"));
    await other.page.getByRole("button", { name: en("org.deleteButton") }).click();
    await sheet(other.page).getByLabel(en("org.deletePassword")).fill("not-the-password");
    await sheet(other.page)
      .getByRole("button", { name: en("org.deleteConfirm") })
      .click();
    await textOf(sheet(other.page).locator(".ui-field-error"), en("org.wrongPassword"));
    expect(takeProblems(other)).toEqual([expect.stringMatching(refused(403))]);
    await sheet(other.page).getByLabel(en("org.deletePassword")).fill("another-long-password");
    await sheet(other.page)
      .getByRole("button", { name: en("org.deleteConfirm") })
      .click();
    await other.page.waitForURL(`${srv.url}/`);
    expect(
      (
        await api(srv.url, "POST", "/api/auth/login", {
          body: { email: "maryam@al-huda.example", password: "another-long-password" },
        })
      ).status,
    ).toBe(401);
    expect((await screensOf(owner))[0]).toMatchObject({ name: "Main hall TV", enabled: true });
    clean(other);
    await other.context.close();
  });

  it("the owner renames the mosque in Settings; the name heads its screens", async () => {
    const page = owner.page;
    await page.locator('a[data-nav="settings"]').click();
    await textOf(page.locator("#settings-title"), en("set.title"));
    // A hosted mosque has no server-wide settings: those are the operator's.
    expect(await page.locator("#require-row").isHidden()).toBe(true);
    expect(await page.locator("#org-name").inputValue()).toBe(OWNER.org);
    await page.locator("#org-name").fill("Masjid An-Noor Amsterdam");
    await page.locator("#org-save").click();
    await textOf(page.locator("#org-status"), en("common.saved"));
    await page.locator('a[data-nav="screens"]').click();
    await textOf(page.locator("#org-line"), "Masjid An-Noor Amsterdam");
    expect(
      (await api(srv.url, "GET", "/api/org", { cookie: await cookieHeader(owner) })).body,
    ).toMatchObject({ name: "Masjid An-Noor Amsterdam" });
    clean(owner);
  });
});

describe("hosted: the screen's menu", () => {
  it("clears the captions, renames the screen, changes its look (the TV follows) and makes a new link", async () => {
    const page = owner.page;
    await textOf(tv.page.locator("#captions .blk-text").first(), new RegExp(`^${FIRST_CAPTION}`));
    await card(page)
      .getByRole("button", { name: en("sc.reset") })
      .click();
    await textOf(sheet(page).locator(".ui-sheet-title"), en("reset.title"));
    await sheet(page)
      .getByRole("button", { name: en("reset.confirm") })
      .click();
    await toasted(page, en("toast.cleared"));
    await waitUntil(
      "the first caption to be cleared from the TV",
      async () =>
        (await tv.page.locator("#captions .blk-text", { hasText: FIRST_CAPTION }).count()) === 0,
    );

    await card(page)
      .getByRole("button", { name: en("sc.more") })
      .click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("menu.rename") })
      .click();
    await sheet(page).getByLabel(en("rename.label")).fill("Prayer hall TV");
    await sheet(page)
      .getByRole("button", { name: en("common.save") })
      .click();
    await toasted(page, en("toast.renamed"));
    await textOf(card(page).locator(".sc-name"), "Prayer hall TV");

    // Change look: the builder opens at its Look step with the screen's languages locked.
    await card(page)
      .getByRole("button", { name: en("sc.more") })
      .click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("menu.changeLook") })
      .click();
    await page.waitForURL(`${srv.url}/app/new?screen=${screen.id}#step=3`);
    await textOf(page.locator("#b-title"), en("b.editNamed", { name: "Prayer hall TV" }));
    // The mosque's own look is in the gallery, marked as such.
    const noor = page.locator(".theme-card", { hasText: "Noor look" });
    await textOf(noor.locator(".ui-badge-neutral"), en("b.yourTheme"));
    await noor.click();
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: en("common.next") }).click();
    await textOf(page.locator("#last-title"), en("b.saveChanges"));
    expect(await page.getByLabel(en("b.screenName")).inputValue()).toBe("Prayer hall TV");
    await page.locator("#save-screen").click();
    await page.waitForURL(`${srv.url}/app`);
    const changed = (await screensOf(owner))[0] as ScreenRow;
    expect(new URLSearchParams(changed.query).get("preset")).toBe("noor-look");
    expect(new URLSearchParams(changed.query).get("pos")).toBe("top");
    // The TV loads its link again and shows the new look.
    await tv.page.waitForURL((url) => url.searchParams.get("preset") === "noor-look");
    await waitUntil("the new look on the TV", async () => {
      const color = await cssVar(tv.page, "--cap-text-color").catch(() => "");
      return color === "#ffcc00";
    });
    expect(await cssVar(tv.page, "--cap-panel-bg")).toBe("#000000");
    await waitForStats(tv.page, "captions in the new look", (s) => s.screen?.state === "enabled");

    // New link: the old one stops working on the TV.
    await card(page)
      .getByRole("button", { name: en("sc.more") })
      .click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("menu.newLink") })
      .click();
    await textOf(sheet(page).locator(".ui-sheet-title"), en("regen.title"));
    await sheet(page)
      .getByRole("button", { name: en("regen.confirm") })
      .click();
    await toasted(page, en("toast.newLink"));
    await waitForStats(tv.page, "the old link refused", (s) => s.screen?.state === "invalid");
    await textOf(tv.page.locator(".scr-wrap.is-problem .scr-title"), TV_LABELS.linkInvalidTitle);
    const renewed = (await screensOf(owner))[0] as ScreenRow;
    expect(renewed.guid).not.toBe(screen.guid);
    screen = renewed;
    await tv.page.goto(screen.url);
    await waitForStats(tv.page, "captions on the new link", (s) => s.blocks >= 1, 30_000);
    clean(owner);
    clean(tv);
  });

  it("deletes the screen: the dashboard is empty and the TV says the link is no longer valid", async () => {
    const page = owner.page;
    await card(page)
      .getByRole("button", { name: en("sc.more") })
      .click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("menu.deleteScreen") })
      .click();
    await textOf(
      sheet(page).locator(".ui-sheet-title"),
      en("del.title", { name: "Prayer hall TV" }),
    );
    await sheet(page)
      .getByRole("button", { name: en("common.delete") })
      .click();
    await toasted(page, en("toast.deleted"));
    await textOf(page.locator("#screens-empty .empty-title"), en("dash.emptyTitle"));
    expect(await screensOf(owner)).toEqual([]);
    const ended = (await captionStats(tv.page))?.sessionId ?? null;
    await waitForStats(tv.page, "the deleted link refused", (s) => s.screen?.state === "invalid");
    await textOf(tv.page.locator(".scr-wrap.is-problem .scr-title"), TV_LABELS.linkInvalidTitle);
    clean(owner);
    clean(tv);
    await tv.context.close();

    // The session's captions stay with the mosque: its archive page and the exports.
    expect(ended).not.toBeNull();
    sessionId = ended ?? "";
    await page.goto(`${srv.url}/s/${sessionId}`);
    await textOf(page.locator("#captions .blk-text").first(), new RegExp(`^${FIRST_CAPTION}`));
    await textOf(
      page.locator("#captions .blk-end .blk-marker"),
      new RegExp(`^${TV_LABELS.ended} · `),
    );
    expect(await page.locator(".arc-exports a").allTextContents()).toEqual(["TXT", "MD", "SRT"]);
    const txt = await api(srv.url, "GET", `/api/sessions/${sessionId}/export.txt`, {
      cookie: await cookieHeader(owner),
    });
    expect(txt.status).toBe(200);
    expect(String(txt.body)).toContain(FIRST_CAPTION);
    clean(owner);
  });

  // Was a bug: on a hosted server, where there are no access keys, the archive page asked a
  // visitor who isn't logged in for an "Access key".
  it("the archive page tells a visitor to log in, not for an access key", async () => {
    const visitor = await tab(browser, srv.url);
    await visitor.page.goto(`${srv.url}/s/${sessionId}`);
    await waitUntil(
      "the archive's answer",
      async () =>
        (await visitor.page.locator("#arc-key").isVisible()) ||
        (await visitor.page.locator("#arc-msg").isVisible()),
    );
    expect(await visitor.page.locator("#arc-key").isVisible()).toBe(false);
    expect(await visitor.page.locator("#arc-msg").textContent()).toMatch(/log in/i);
    await visitor.context.close();
  });
});

describe("hosted: accounts", () => {
  it("adds a user who sees only his own screen, locked until an admin lets him switch it", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/app`);
    await page.locator('a[data-nav="accounts"]').click();
    await textOf(page.locator("#accounts-title"), en("acc.title"));
    expect(page.url()).toBe(`${srv.url}/app#accounts`);
    const self = page.locator(".user-card", { hasText: OWNER.email });
    await textOf(self.locator(".uc-role"), en("role.owner"));
    await textOf(self.locator(".uc-you"), en("acc.you"));

    await page.getByRole("button", { name: en("acc.add") }).click();
    await sheet(page).getByLabel(en("acc.name")).fill(HELPER.name);
    await sheet(page).getByLabel(en("acc.email")).fill(HELPER.email);
    helperPassword = await sheet(page).getByLabel(en("acc.password")).inputValue();
    expect(helperPassword).toMatch(/^[\w-]{14,}$/);
    await sheet(page)
      .getByRole("button", { name: en("acc.create") })
      .click();
    await textOf(sheet(page).locator(".once-title"), en("acc.created"));
    await textOf(sheet(page).locator(".once-pw"), helperPassword);
    await sheet(page)
      .getByRole("button", { name: en("common.done") })
      .click();
    const bilal = page.locator(".user-card", { hasText: HELPER.email });
    await textOf(bilal.locator(".uc-name"), HELPER.name);
    await textOf(bilal.locator(".uc-role"), en("role.user"));
    await textOf(bilal.locator(".uc-meta"), new RegExp(en("acc.never")));

    // Bilal logs in and makes a screen of his own: he sees only that one, and can't switch it.
    helper = await tab(browser, srv.url);
    await helper.page.goto(`${srv.url}/login`);
    await textOf(helper.page.locator("#username-label"), en("login.emailOrUsername"));
    await helper.page.locator("#username").fill(HELPER.email);
    await helper.page.locator("#password").fill(helperPassword);
    await helper.page.locator("#login-submit").click();
    await helper.page.waitForURL(`${srv.url}/app`);
    await textOf(helper.page.locator("#screens-empty .empty-title"), en("dash.emptyTitle"));
    // A user has no accounts or settings to manage.
    expect(await helper.page.locator('a[data-nav="accounts"]').isHidden()).toBe(true);
    await helper.page.locator("#new-screen").click();
    await textOf(helper.page.locator("#server-status-text"), en("b.ready"));
    for (let i = 0; i < 5; i++) {
      await helper.page.getByRole("button", { name: en("common.next") }).click();
    }
    await helper.page.getByLabel(en("b.screenName")).fill("Bilal's screen");
    await helper.page.getByRole("button", { name: en("b.saveAsScreen") }).click();
    await helper.page.waitForURL(`${srv.url}/app`);
    const his = helper.page.locator("article.screen-card", { hasText: "Bilal's screen" });
    await textOf(his.locator(".sc-owner"), en("sc.yours"));
    await textOf(his.locator(".sc-lock"), en("sc.locked"));
    expect(await his.locator("input.big-switch").isDisabled()).toBe(true);

    // The owner sees it as Bilal's, and lets him switch it.
    await page.locator('a[data-nav="screens"]').click();
    const theirs = page.locator("article.screen-card", { hasText: "Bilal's screen" });
    await textOf(theirs.locator(".sc-owner"), en("sc.owner", { name: HELPER.name }));
    await theirs.getByRole("button", { name: en("sc.more") }).click();
    await sheet(page).getByLabel(en("menu.ownerControl")).check();
    await toasted(page, en("toast.ownerMay"));
    await sheet(page)
      .getByRole("button", { name: en("common.close") })
      .click();
    // Bilal's dashboard follows within its next refresh.
    await waitUntil("Bilal's switch to unlock", () => his.locator("input.big-switch").isEnabled());
    await his.locator("input.big-switch").check();
    await toasted(helper.page, en("toast.on", { name: "Bilal's screen" }));
    await textOf(theirs.locator(".sc-state"), en("sc.on"));
    clean(owner);
    clean(helper);
  });

  it("makes him an admin, disables, enables, resets his password and deletes him (his screen moves to the owner)", async () => {
    const page = owner.page;
    await page.locator('a[data-nav="accounts"]').click();
    const bilal = page.locator(".user-card", { hasText: HELPER.email });
    await textOf(bilal.locator(".uc-meta"), new RegExp(`^${sayN("en", "n.screens", 1)}`));
    await bilal.getByRole("button", { name: en("acc.moreFor", { name: HELPER.email }) }).click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("acc.makeAdmin") })
      .click();
    await toasted(page, en("acc.nowAdmin", { name: HELPER.email }));
    await textOf(bilal.locator(".uc-role"), en("role.admin"));

    await bilal.getByRole("button", { name: en("acc.disable") }).click();
    await textOf(
      sheet(page).locator(".ui-sheet-title"),
      en("acc.disableTitle", { name: HELPER.email }),
    );
    await sheet(page)
      .getByRole("button", { name: en("acc.disable") })
      .click();
    await toasted(page, en("acc.disabledToast"));
    await textOf(bilal.locator(".uc-off"), en("acc.disabled"));

    // Disabled: Bilal is logged out and can't log in …
    await helper.page.reload();
    await helper.page.waitForURL(`${srv.url}/login?next=%2Fapp`);
    await helper.page.locator("#username").fill(HELPER.email);
    await helper.page.locator("#password").fill(helperPassword);
    await helper.page.locator("#login-submit").click();
    await textOf(helper.page.locator("#login-error-text"), en("login.disabled"));
    expect(takeProblems(helper)).toEqual([expect.stringMatching(refused(403))]);

    // … until he is enabled again: an admin with the mosque's key goes to the dashboard.
    await bilal.getByRole("button", { name: en("acc.enable") }).click();
    await toasted(page, en("acc.enabledToast"));
    expect(await bilal.locator(".uc-off").count()).toBe(0);
    await helper.page.locator("#login-submit").click();
    await helper.page.waitForURL(`${srv.url}/app`);
    await textOf(helper.page.locator(".acct-name"), HELPER.name);

    // A new password for Bilal: shown once, and every login of his ends.
    await bilal.getByRole("button", { name: en("acc.resetPassword") }).click();
    await textOf(sheet(page).locator(".ui-sheet-title"), en("acc.resetTitle"));
    const fresh = await sheet(page).getByLabel(en("acc.newPassword")).inputValue();
    await sheet(page)
      .getByRole("button", { name: en("acc.setPassword") })
      .click();
    await textOf(sheet(page).locator(".once-title"), en("acc.passwordSet"));
    await textOf(sheet(page).locator(".once-pw"), fresh);
    await sheet(page)
      .getByRole("button", { name: en("common.done") })
      .click();
    await helper.page.reload();
    await helper.page.waitForURL(`${srv.url}/login?next=%2Fapp`);
    await helper.page.locator("#username").fill(HELPER.email);
    await helper.page.locator("#password").fill(fresh);
    await helper.page.locator("#login-submit").click();
    await helper.page.waitForURL(`${srv.url}/app`);

    await bilal.getByRole("button", { name: en("acc.moreFor", { name: HELPER.email }) }).click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("acc.delete") })
      .click();
    await textOf(
      sheet(page).locator(".ui-sheet-title"),
      en("acc.deleteTitle", { name: HELPER.email }),
    );
    await textOf(
      sheet(page).locator(".ui-sheet-text"),
      `${sayN("en", "n.screensMove", 1)} ${en("acc.undo")}`,
    );
    await sheet(page)
      .getByRole("button", { name: en("common.delete") })
      .click();
    await toasted(page, en("acc.deletedToast"));
    expect(await page.locator(".user-card", { hasText: HELPER.email }).count()).toBe(0);
    // A deleted account is logged out everywhere; its screen is the owner's now.
    await helper.page.reload();
    await helper.page.waitForURL(`${srv.url}/login?next=%2Fapp`);
    await page.locator('a[data-nav="screens"]').click();
    const moved = page.locator("article.screen-card", { hasText: "Bilal's screen" });
    await textOf(moved.locator(".sc-owner"), en("sc.yours"));
    const id = await moved.getAttribute("data-id");
    expect(
      (await api(srv.url, "DELETE", `/api/screens/${id}`, { cookie: await cookieHeader(owner) }))
        .status,
    ).toBe(204);
    clean(owner);
    clean(helper);
    await helper.context.close();
  });

  it("changes the password, logs out from the account menu, refuses the old password and logs in again", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/app`);
    await page.getByRole("button", { name: en("account.menu", { name: OWNER.name }) }).click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("account.changePassword") })
      .click();
    await sheet(page).getByLabel(en("cp.current")).fill(OWNER.password);
    await sheet(page).getByLabel(en("cp.new"), { exact: true }).fill(NEW_PASSWORD);
    await sheet(page).getByLabel(en("cp.repeat")).fill(`${NEW_PASSWORD}!`);
    await sheet(page)
      .getByRole("button", { name: en("cp.title") })
      .click();
    await textOf(sheet(page).locator(".ui-field-error"), en("cp.mismatch"));
    await sheet(page).getByLabel(en("cp.repeat")).fill(NEW_PASSWORD);
    await sheet(page)
      .getByRole("button", { name: en("cp.title") })
      .click();
    await toasted(page, en("cp.done"));

    await page.getByRole("button", { name: en("account.menu", { name: OWNER.name }) }).click();
    await textOf(
      sheet(page).locator(".sheet-note"),
      en("account.signedInAs", { who: OWNER.email, role: en("role.owner") }),
    );
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: en("account.logout") })
      .click();
    await page.waitForURL(`${srv.url}/login`);
    expect(
      (await api(srv.url, "GET", "/api/auth/me", { cookie: await cookieHeader(owner) })).status,
    ).toBe(401);

    await page.locator("#username").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.locator("#login-submit").click();
    await textOf(page.locator("#login-error-text"), en("login.wrongHosted"));
    expect(takeProblems(owner)).toEqual([expect.stringMatching(refused(401))]);

    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#login-submit").click();
    await page.waitForURL(`${srv.url}/app`);
    await textOf(page.locator(".acct-name"), OWNER.name);
    clean(owner);
  });
});

describe("hosted: the app in Dutch and in Arabic (the language switch)", () => {
  const nl = (key: Parameters<typeof say>[1], vars?: Parameters<typeof say>[2]) =>
    say("nl", key, vars);
  const ar = (key: Parameters<typeof say>[1], vars?: Parameters<typeof say>[2]) =>
    say("ar", key, vars);

  it("in Dutch: the dashboard, a screen from the builder, its switch, the keys, the look and the accounts", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/app`);
    await textOf(page.locator("#screens-title"), en("dash.title"));
    await page.locator('.lang-btn[lang="nl"]').click();
    expect(await htmlLangDir(page)).toEqual({ lang: "nl", dir: "ltr" });
    expect(await page.locator('.lang-btn[lang="nl"]').getAttribute("aria-pressed")).toBe("true");
    await textOf(page.locator("#screens-title"), nl("dash.title"));
    await textOf(page.locator("#screens-empty .empty-title"), nl("dash.emptyTitle"));
    await textOf(page.locator('a[data-nav="keys"] .app-nav-label'), nl("nav.keys"));

    // The next page speaks Dutch too: the choice is remembered.
    await page.locator("#new-screen").click();
    await page.waitForURL((url) => url.pathname === "/app/new");
    expect(await htmlLangDir(page)).toEqual({ lang: "nl", dir: "ltr" });
    await textOf(page.locator("#b-title"), nl("b.newScreen"));
    await textOf(page.locator('.stepper-btn[data-goto="1"] .stepper-label'), nl("step.languages"));
    await textOf(page.locator("#server-status-text"), nl("b.ready"));
    for (let i = 0; i < 5; i++) await page.getByRole("button", { name: nl("common.next") }).click();
    await page.getByLabel(nl("b.screenName")).fill("Zaal-tv");
    await page.getByRole("button", { name: nl("b.saveAsScreen") }).click();
    await page.waitForURL(`${srv.url}/app`);
    await toasted(page, nl("toast.saved", { name: "Zaal-tv" }));
    await textOf(page.locator("#ready-title"), nl("dash.readyTitle"));
    const zaal = page.locator("article.screen-card", { hasText: "Zaal-tv" });
    await textOf(zaal.locator(".sc-langs"), "Arabisch → Nederlands");
    await textOf(zaal.locator(".sc-status"), nl("status.off"));
    await zaal.locator("input.big-switch").check();
    await toasted(page, nl("toast.on", { name: "Zaal-tv" }));
    await textOf(zaal.locator(".sc-state"), nl("sc.on"));

    await page.locator('a[data-nav="keys"]').click();
    await page.waitForURL(`${srv.url}/app/keys`);
    await textOf(page.locator(".page-title"), nl("keys.title"));
    await textOf(page.locator("#kx-soniox .kf-state"), nl("keys.storedUnchecked"));
    await page.locator('a[data-nav="look"]').click();
    await page.waitForURL(`${srv.url}/app/look`);
    await textOf(page.locator(".cz-title"), nl("look.title"));
    await page.locator('a[data-nav="accounts"]').click();
    await page.waitForURL(`${srv.url}/app#accounts`);
    await textOf(page.locator("#accounts-title"), nl("acc.title"));
    await textOf(page.locator("#add-user span"), nl("acc.add"));
    clean(owner);
  });

  it("in Arabic, right to left: the dashboard, switching and deleting the screen, the keys, the builder, the look and the accounts", async () => {
    const page = owner.page;
    await page.goto(`${srv.url}/app`);
    expect(await htmlLangDir(page)).toEqual({ lang: "nl", dir: "ltr" });
    await page.locator('.lang-btn[lang="ar"]').click();
    expect(await htmlLangDir(page)).toEqual({ lang: "ar", dir: "rtl" });
    await textOf(page.locator("#screens-title"), ar("dash.title"));
    const zaal = page.locator("article.screen-card", { hasText: "Zaal-tv" });
    await textOf(zaal.locator(".sc-state"), ar("sc.on"));
    await zaal.locator("input.big-switch").uncheck();
    await toasted(page, ar("toast.off", { name: "Zaal-tv" }));
    await textOf(zaal.locator(".sc-status"), ar("status.off"));
    await zaal.getByRole("button", { name: ar("sc.more") }).click();
    await sheet(page)
      .locator(".ui-sheet-action", { hasText: ar("menu.deleteScreen") })
      .click();
    await textOf(sheet(page).locator(".ui-sheet-title"), ar("del.title", { name: "Zaal-tv" }));
    await sheet(page)
      .getByRole("button", { name: ar("common.delete"), exact: true })
      .click();
    await toasted(page, ar("toast.deleted"));
    await textOf(page.locator("#screens-empty .empty-title"), ar("dash.emptyTitle"));

    const pages: Array<[string, string, Parameters<typeof say>[1]]> = [
      ["/app/keys", ".page-title", "keys.title"],
      ["/app/new", "#b-title", "b.newScreen"],
      ["/app/look", ".cz-title", "look.title"],
      ["/app#accounts", "#accounts-title", "acc.title"],
    ];
    for (const [path, title, key] of pages) {
      await page.goto(`${srv.url}${path}`);
      await textOf(page.locator(title), ar(key));
      expect(await htmlLangDir(page), path).toEqual({ lang: "ar", dir: "rtl" });
      if (path === "/app/keys") {
        await textOf(page.locator("#kx-soniox .kf-state"), ar("keys.storedUnchecked"));
      }
    }
    clean(owner);
  });

  it("the log-in and sign-up pages switch to Dutch and to Arabic for a visitor", async () => {
    const visitor = await tab(browser, srv.url);
    const page = visitor.page;
    await page.goto(`${srv.url}/login`);
    await textOf(page.locator("#login-form .auth-title"), en("login.title"));
    await page.locator('.lang-btn[lang="nl"]').click();
    expect(await htmlLangDir(page)).toEqual({ lang: "nl", dir: "ltr" });
    await textOf(page.locator("#login-form .auth-title"), nl("login.title"));
    await textOf(page.locator("#username-label"), nl("login.emailOrUsername"));
    await page.locator("#username").fill(OWNER.email);
    await page.locator("#password").fill("not-the-password");
    await page.locator("#login-submit").click();
    await textOf(page.locator("#login-error-text"), nl("login.wrongHosted"));
    expect(takeProblems(visitor)).toEqual([expect.stringMatching(refused(401))]);

    await page.locator("#signup-row a").click();
    await page.waitForURL(`${srv.url}/signup`);
    await textOf(page.locator("#signup-form .auth-title"), nl("signup.title"));
    await page.locator('.lang-btn[lang="ar"]').click();
    expect(await htmlLangDir(page)).toEqual({ lang: "ar", dir: "rtl" });
    await textOf(page.locator("#signup-form .auth-title"), ar("signup.title"));
    await page.locator("#signup-submit").click();
    await textOf(page.locator("#signup-error-text"), ar("signup.errOrg"));
    await page.locator("#signup-form .auth-alt a").click();
    await page.waitForURL(`${srv.url}/login`);
    await textOf(page.locator("#login-form .auth-title"), ar("login.title"));
    expect(await htmlLangDir(page)).toEqual({ lang: "ar", dir: "rtl" });
    clean(visitor);
    await visitor.context.close();
  });
});

describe("hosted: the log-in rate limit", () => {
  it("after ten wrong passwords from one address, even the right one waits, and the page says how long", async () => {
    const limited = await appServer(cleanup, { yaml: hostedYaml });
    const who = { orgName: "Masjid Al-Falah", name: "Ahmad", email: "ahmad@al-falah.example" };
    const password = "the-right-password";
    expect(
      (await api(limited.url, "POST", "/api/auth/signup", { body: { ...who, password } })).status,
    ).toBe(201);
    let wrong = 0;
    for (;;) {
      const r = await api(limited.url, "POST", "/api/auth/login", {
        body: { email: who.email, password: `wrong-${wrong}` },
      });
      if (r.status === 429) break;
      expect(r.status).toBe(401);
      wrong++;
      expect(wrong).toBeLessThanOrEqual(10);
    }
    expect(wrong).toBe(10);

    const visitor = await tab(browser, limited.url);
    await visitor.page.goto(`${limited.url}/login`);
    await visitor.page.locator("#username").fill(who.email);
    await visitor.page.locator("#password").fill(password);
    await visitor.page.locator("#login-submit").click();
    await textOf(
      visitor.page.locator("#login-error-text"),
      en("login.tooMany", { time: sayN("en", "n.minutes", 10) }),
    );
    expect(takeProblems(visitor)).toEqual([expect.stringMatching(refused(429))]);
    await visitor.context.close();
  });
});

describe("hosted: the key check with a stand-in for Soniox", () => {
  it("a key Soniox refuses is not stored; one it accepts works, checked", async () => {
    const soniox = await startFakeSoniox(srv.inst.dir);
    cleanup.add(() => soniox.close());
    soniox.answer = (key) =>
      key === FAKE_KEY ? { status: 200, body: { models: [{ id: "stt-rt-v5" }] } } : { status: 401 };
    const checked = await appServer(cleanup, {
      yaml: hostedYaml,
      env: { E2E_NET_REDIRECT: soniox.redirects, NODE_EXTRA_CA_CERTS: soniox.ca },
    });
    const w = await tab(browser, checked.url);
    await signUp(
      w,
      {
        org: "Masjid At-Taqwa",
        name: "Umar",
        email: "umar@at-taqwa.example",
        password: "a-long-password",
      },
      checked.url,
    );
    const page = w.page;
    const slot = page.locator("#kx-soniox");
    await page.getByPlaceholder(en("keys.placeholder")).fill(FAKE_KEY_2);
    await slot.getByRole("button", { name: en("keys.save") }).click();
    await textOf(
      slot.locator(".kx-result.is-error"),
      `${en("keys.rejected", { provider: "Soniox" })} (HTTP 401)`,
    );
    expect(takeProblems(w)).toEqual([expect.stringMatching(refused(400))]);

    await page.getByPlaceholder(en("keys.placeholder")).fill(FAKE_KEY);
    await slot.getByRole("button", { name: en("keys.save") }).click();
    await toasted(page, en("keys.saved"));
    await textOf(
      slot.locator(".kf-state.is-ok"),
      new RegExp(`^${en("keys.works", { when: "\\d\\d:\\d\\d" })}$`),
    );
    // Both checks went to the stand-in (the list of models), each with its own key.
    expect(soniox.requests.map((r) => [r.host, r.path, r.authorization])).toEqual([
      ["api.soniox.com", "/v1/models", `Bearer ${FAKE_KEY_2}`],
      ["api.soniox.com", "/v1/models", `Bearer ${FAKE_KEY}`],
    ]);
    expect(checked.netAttempts().every((a) => a.action === "redirected")).toBe(true);
    clean(w);
    await w.context.close();
  });
});

describe("hosted: sign-up closed", () => {
  it("the sign-up page says sign-up is closed, and the log-in page offers none", async () => {
    const closed = await appServer(cleanup, {
      yaml: (port, token) => hostedYaml(port, token).replace("signup: open", "signup: closed"),
    });
    const w = await tab(browser, closed.url);
    await w.page.goto(`${closed.url}/signup`);
    await textOf(w.page.locator("#signup-closed .auth-title"), en("signup.closed"));
    await textOf(w.page.locator("#closed-hint"), en("signup.closedHint"));
    expect(await w.page.locator("#signup-form").isHidden()).toBe(true);
    await w.page.goto(`${closed.url}/login`);
    await textOf(w.page.locator("#login-form .auth-title"), en("login.title"));
    expect(await w.page.locator("#signup-row").isHidden()).toBe(true);
    expect(
      await api(closed.url, "POST", "/api/auth/signup", {
        body: { orgName: "X", name: "Y", email: "y@x.example", password: "a-long-password" },
      }),
    ).toEqual({ status: 403, body: { ok: false, message: "Sign-up is closed on this server" } });
    clean(w);
    await w.context.close();
  });
});
