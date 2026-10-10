// Local (self-hosted) mode in a real Chrome against the built server: the first visit creates the
// first admin, the builder at / makes a caption link and a screen, the look editor saves a look
// that the caption page then shows, and the caption page captions the fake microphone (replayed
// provider log). Then the overlay and the control dock against a local session (`run --file`).
// Every page must end without console errors, page errors or CSP violations.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uiLabels } from "../../../web/shared/i18n.js";
import {
  type AppServer,
  api,
  appServer,
  Cleanup,
  chrome,
  cookieHeader,
  cssVar,
  exactly,
  FAKE_KEY,
  FIRST_CAPTION,
  localYaml,
  say,
  tab,
  takeProblems,
  textOf,
  toasted,
  waitForStats,
  waitUntil,
} from "../helpers/app-tools.js";
import type { WatchedPage } from "../helpers/browser.js";
import { writeWav } from "../helpers/instance.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

const ADMIN = { name: "Imam Khalid", username: "khalid", password: "local-admin-pw" };

let srv: AppServer;
let browser: Browser;
/** The admin's browser, logged in after the first visit. */
let admin: WatchedPage;

beforeAll(async () => {
  srv = await appServer(cleanup, { yaml: localYaml });
  browser = await chrome(cleanup, srv.inst.dir);
  admin = await tab(browser, srv.url);
});

function en(key: Parameters<typeof say>[1], vars?: Parameters<typeof say>[2]): string {
  return say("en", key, vars);
}

function clean(w: WatchedPage): void {
  expect(takeProblems(w)).toEqual([]);
}

describe("local: the first visit and the builder", () => {
  it("the first visit to the app creates the first admin on the log-in page (set-up mode)", async () => {
    const page = admin.page;
    expect((await api(srv.url, "GET", "/api/auth/state")).body).toMatchObject({
      setupRequired: true,
      mode: "local",
      signup: false,
      loggedIn: false,
    });
    await page.goto(`${srv.url}/app`);
    await page.waitForURL(`${srv.url}/login?next=%2Fapp`);
    await textOf(page.locator("#setup-form .auth-title"), en("setup.title"));
    expect(await page.locator("#login-form").isHidden()).toBe(true);
    await page.locator("#setup-name").fill(ADMIN.name);
    await page.locator("#setup-username").fill(ADMIN.username);
    await page.locator("#setup-password").fill(ADMIN.password);
    await page.locator("#setup-password2").fill("something-else");
    await page.locator("#setup-submit").click();
    await textOf(page.locator("#setup-error-text"), en("setup.mismatch"));
    await page.locator("#setup-password2").fill(ADMIN.password);
    await page.locator("#setup-submit").click();

    await page.waitForURL(`${srv.url}/app`);
    await textOf(page.locator(".acct-name"), ADMIN.name);
    await textOf(page.locator("#screens-empty .empty-title"), en("dash.emptyTitle"));
    // A local install's footer links its own tools.
    await textOf(page.locator('#app-foot a[href="/control"]'), en("foot.control"));
    // Set up once: the log-in page now goes straight on, and a second set-up is refused.
    await page.goto(`${srv.url}/login`);
    await page.waitForURL(`${srv.url}/app`);
    expect(
      await api(srv.url, "POST", "/api/auth/setup", {
        body: { username: "intruder", password: "another-password" },
      }),
    ).toMatchObject({ status: 409 });
    clean(admin);
  });

  it("the builder at / makes a caption link (rolling captions, a look, a text size) that captions the microphone", async () => {
    const page = admin.page;
    await page.goto(`${srv.url}/`);
    await textOf(page.locator("#b-title"), en("b.docTitleLink"));
    await textOf(page.locator("#server-status-text"), en("b.ready"));
    await page.locator(".pair-chip", { hasText: "Arabic → Dutch" }).click();
    await page.getByRole("button", { name: en("common.next") }).click();
    await page.locator(".choice-card", { hasText: en("b.rolling") }).click();
    await page.getByRole("button", { name: en("common.next") }).click();
    await page.locator(".theme-card", { hasText: en("preset.cinema") }).click();
    await page.getByRole("button", { name: en("common.next") }).click();
    await page.getByLabel(en("b.textSize")).fill("64");
    await textOf(page.locator("#size-value"), "64 px");
    await page.getByRole("button", { name: en("common.next") }).click();
    // 5 · Microphone: the test hears the (fake) microphone, then stops.
    await page.getByRole("button", { name: en("b.test") }).click();
    await textOf(page.locator("#meter-status"), en("mic.heard"));
    await page.getByRole("button", { name: en("b.stop") }).click();
    expect(await page.locator("#meter").isHidden()).toBe(true);
    await page.getByRole("button", { name: en("common.next") }).click();
    await textOf(page.locator("#last-title"), en("step.link"));

    const link = await page.locator("#url").inputValue();
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe(`${srv.url}/ar/nl`);
    expect(url.searchParams.get("preset")).toBe("cinema");
    expect(url.searchParams.get("size")).toBe("64");
    await page.getByRole("button", { name: en("common.copy"), exact: true }).click();
    await toasted(page, en("common.copied"));
    expect(String(await page.evaluate("navigator.clipboard.readText()"))).toBe(link);

    // Open: the caption page itself, listening to the fake microphone.
    await page.getByRole("button", { name: en("common.open"), exact: true }).click();
    await page.waitForURL(link);
    await waitForStats(page, "rolling captions", (s) => s.finals >= 1, 30_000);
    await waitUntil("the Dutch captions on the page", async () =>
      ((await page.locator("#captions .cap-translation .cap-text").textContent()) ?? "").includes(
        FIRST_CAPTION,
      ),
    );
    expect(await cssVar(page, "--cap-font-size")).toBe("min(64px, 5vw)");
    clean(admin);
  });

  it("the builder at /?screen=new makes a screen; its link for this computer opens the off card", async () => {
    const page = admin.page;
    await page.goto(`${srv.url}/?screen=new`);
    await textOf(page.locator("#b-title"), en("b.newScreen"));
    await textOf(page.locator("#server-status-text"), en("b.ready"));
    for (let i = 0; i < 5; i++) await page.getByRole("button", { name: en("common.next") }).click();
    await page.getByLabel(en("b.screenName")).fill("Lobby");
    await page.getByRole("button", { name: en("b.saveAsScreen") }).click();
    await page.waitForURL(`${srv.url}/app`);

    const list = (await api(srv.url, "GET", "/api/screens", { cookie: await cookieHeader(admin) }))
      .body as Array<{ id: string; guid: string; name: string; localUrl: string | null }>;
    expect(list).toHaveLength(1);
    const lobby = list[0] as { id: string; guid: string; name: string; localUrl: string | null };
    expect(lobby.localUrl).toBe(`http://127.0.0.1:${srv.port}/feed/${lobby.guid}`);
    const card = page.locator(`article.screen-card[data-id="${lobby.id}"]`);
    await textOf(card.locator(".sc-name"), "Lobby");
    // "Show on a screen": this computer's link (the one that runs Turjuman).
    await card.getByRole("button", { name: en("sos.button") }).click();
    const sheet = page.locator("dialog.ui-sheet[open]");
    expect(await sheet.getByLabel(en("sos.here")).isChecked()).toBe(true);
    expect(await sheet.locator(".sos-url").inputValue()).toBe(lobby.localUrl);
    await sheet.getByRole("button", { name: en("common.close") }).click();
    await card.getByRole("button", { name: en("sc.copyLink") }).click();
    await toasted(page, en("toast.linkCopied"));
    expect(String(await page.evaluate("navigator.clipboard.readText()"))).toBe(lobby.localUrl);

    const tv = await tab(browser, srv.url);
    await tv.page.goto(lobby.localUrl ?? "");
    await waitForStats(tv.page, "the off state", (s) => s.screen?.state === "disabled");
    await textOf(tv.page.locator(".scr-wrap.is-off .scr-title"), uiLabels("nl").screenOffTitle);
    await card.locator("input.big-switch").check();
    await toasted(page, en("toast.on", { name: "Lobby" }));
    await waitForStats(tv.page, "the screen on", (s) => s.screen?.state === "enabled");
    clean(admin);
    clean(tv);
    await tv.context.close();
  });
});

describe("local: the server's settings", () => {
  it("only screen links start captions when the admin says so: a plain caption page then says why", async () => {
    const page = admin.page;
    await page.goto(`${srv.url}/app#settings`);
    await textOf(page.locator("#settings-title"), en("set.title"));
    const only = page.getByLabel(en("set.requireScreen"));
    await waitUntil("the setting to load", () => only.isEnabled());
    expect(await only.isChecked()).toBe(false);
    await only.check();
    await textOf(page.locator("#settings-status"), en("common.saved"));
    expect(readFileSync(join(srv.inst.dir, "config.yaml"), "utf8")).toMatch(
      /pages:\n {2}requireScreen: true/,
    );

    const plain = await tab(browser, srv.url);
    await plain.page.goto(`${srv.url}/ar/nl`);
    await waitForStats(plain.page, "the refusal", (s) => s.state === "error");
    await textOf(
      plain.page.locator(".scr-wrap.is-problem .scr-title"),
      uiLabels("nl").screenRequiredTitle,
    );
    expect(takeProblems(plain)).toEqual([]);
    await plain.context.close();

    await only.uncheck();
    await textOf(page.locator("#settings-status"), en("common.saved"));
    expect(
      (await api(srv.url, "GET", "/api/settings", { cookie: await cookieHeader(admin) })).body,
    ).toEqual({ requireScreen: false });
    clean(admin);
  });
});

describe("local: the look editor", () => {
  it("changes a colour and the font size, saves the look as the default, and the caption page shows it", async () => {
    const page = admin.page;
    await page.goto(`${srv.url}/app/look`);
    await textOf(page.locator(".cz-title"), en("look.title"));
    await textOf(page.locator("#current-name"), en("preset.mosque-dark"));
    const colour = page.getByLabel(en("lk.valueOf", { label: en("lk.textColour") }));
    await colour.fill("#ffcc00");
    await colour.press("Enter");
    // The text size (the honorifics have a size of their own).
    const text = page.locator("details.grp", {
      has: page.locator(".grp-title", { hasText: exactly(en("lk.g.text")) }),
    });
    await text.getByLabel(en("lk.size"), { exact: true }).fill("60");
    await waitUntil("the two changes in the editor", async () =>
      ((await page.locator("#current-edited").textContent()) ?? "").includes("2"),
    );
    // The editor's own caption link carries both changes.
    const link = new URL(await page.locator("#url-caption").inputValue());
    expect(link.searchParams.get("fg")).toBe("ffcc00");
    expect(link.searchParams.get("size")).toBe("60");

    await page.locator("#save").click();
    const dialog = page.locator("#save-dialog");
    await dialog.getByLabel(en("lk.name")).fill("Hall look");
    await dialog.locator("#save-confirm").click();
    await toasted(page, en("lk.savedNamed", { name: "Hall look" }));
    await textOf(page.locator("#current-name"), "Hall look");
    await textOf(page.locator("#make-default"), en("lk.makeDefault", { name: "Hall look" }));
    await page.locator("#make-default").click();
    await toasted(page, en("lk.nowDefault", { name: "Hall look" }));
    await textOf(page.locator("#make-default"), en("lk.isDefault"));
    expect(readFileSync(join(srv.inst.dir, "config.yaml"), "utf8")).toMatch(
      /display:\n {2}preset: hall-look/,
    );
    clean(admin);

    // The plain caption page now has this look, and captions the microphone in it.
    const viewer = await tab(browser, srv.url);
    await viewer.page.goto(`${srv.url}/ar/nl`);
    await waitForStats(viewer.page, "caption blocks", (s) => s.blocks >= 1, 30_000);
    expect(await cssVar(viewer.page, "--cap-text-color")).toBe("#ffcc00");
    expect(await cssVar(viewer.page, "--cap-font-size")).toBe("min(60px, 5vw)");
    const style = (await viewer.page.evaluate(
      "(() => { const s = getComputedStyle(document.querySelector('#captions .blk-panel')); return { color: s.color, size: s.fontSize }; })()",
    )) as { color: string; size: string };
    expect(style).toEqual({ color: "rgb(255, 204, 0)", size: "60px" });
    await textOf(
      viewer.page.locator("#captions .blk-text").first(),
      new RegExp(`^${FIRST_CAPTION}`),
    );
    clean(viewer);
    await viewer.context.close();
  });
});

describe("local: the overlay and the control dock of a local session", () => {
  let session: AppServer;
  let dock: WatchedPage;
  let overlay: WatchedPage;

  beforeAll(async () => {
    const recordings = (dir: string) => join(dir, "data", "recordings");
    session = await appServer(cleanup, {
      yaml: localYaml,
      // A rehearsal: the recording plays in a loop, the provider log gives the captions.
      args: ["--file", "data/recordings/khutbah.wav", "--loop"],
      env: { SONIOX_API_KEY: FAKE_KEY },
      prepare: (dir) => {
        mkdirSync(recordings(dir), { recursive: true });
        writeWav(join(recordings(dir), "khutbah.wav"), { seconds: 8, tone: true });
      },
    });
  });

  it("the dock shows the live file session, and the overlay its captions", async () => {
    dock = await tab(browser, session.url);
    // The dock's confirm steps last 4 s: the test holds the page's clock while it confirms.
    await dock.context.clock.install();
    await dock.page.goto(`${session.url}/control`);
    await textOf(dock.page.locator("#state"), "live");
    await textOf(dock.page.locator("#file-banner strong"), "FILE SESSION ACTIVE");
    await textOf(dock.page.locator("#file-name"), "khutbah.wav");
    expect(await dock.page.locator("#conn").isHidden()).toBe(true);

    overlay = await tab(browser, session.url);
    await overlay.page.goto(`${session.url}/overlay`);
    await waitUntil(
      "the first caption on the overlay",
      async () =>
        (await overlay.page.locator("#captions .blk-text", { hasText: FIRST_CAPTION }).count()) ===
        1,
      30_000,
    );
    clean(dock);
    clean(overlay);
  });

  // Was a bug: the hub followed the clear with snapshots taken before the session forgot its
  // blocks, so the overlay got every caption back.
  it("Clear in the dock empties the overlay", async () => {
    const first = overlay.page.locator("#captions .blk-text", { hasText: FIRST_CAPTION });
    expect(await first.count()).toBe(1);
    await dock.page.locator("#clear").click();
    await toasted(dock.page, "Cleared");
    await waitUntil(
      "the overlay's first caption to be cleared",
      async () => (await first.count()) === 0,
      5000,
    );
  });

  it("Stop (with its confirm step) ends the session and Start replays a recording again", async () => {
    const first = overlay.page.locator("#captions .blk-text", { hasText: FIRST_CAPTION });
    const before = await first.count();
    await dock.page.clock.pauseAt(Date.now() + 1000);
    await dock.page.locator("#stop").click();
    await textOf(dock.page.locator("#stop"), "Confirm stop");
    await dock.page.locator("#stop").click();
    await dock.page.clock.resume();
    await textOf(dock.page.locator("#state"), "idle");
    expect(await dock.page.locator("#file-banner").isHidden()).toBe(true);
    // The overlay marks the end of the session.
    await textOf(
      overlay.page.locator("#captions .blk-end .blk-marker").last(),
      new RegExp(`^${uiLabels("nl").ended} · \\d\\d:\\d\\d$`),
    );

    await dock.page.locator("#source").selectOption("file");
    await dock.page.locator("#file").fill("khutbah.wav");
    await dock.page.locator("#start").click();
    await textOf(dock.page.locator("#state"), "live");
    await textOf(dock.page.locator("#file-name"), "khutbah.wav");
    await waitUntil(
      "the new session's first caption on the overlay",
      async () => (await first.count()) === before + 1,
      30_000,
    );
    clean(dock);
    clean(overlay);
  });
});
