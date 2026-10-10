// A self-hosted server on the network (exposure lan, an admin token; plain http is fine on
// 127.0.0.1): caption pages need an access key (`turjuman keys add`), a missing or wrong key shows
// a readable banner, the right one captions the fake microphone, and the control dock needs the
// admin token. Every page must end without console errors, page errors or CSP violations.
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uiLabels } from "../../../web/shared/i18n.js";
import {
  type AppServer,
  api,
  appServer,
  Cleanup,
  chrome,
  FIRST_CAPTION,
  lanYaml,
  refused,
  tab,
  takeProblems,
  textOf,
  waitForStats,
} from "../helpers/app-tools.js";
import type { WatchedPage } from "../helpers/browser.js";
import { turjuman } from "../helpers/cli.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

let srv: AppServer;
let browser: Browser;
/** The access key `turjuman keys add` printed (once). */
let key: string;
/** The caption page opened with that key (kept open for the control dock). */
let keyed: WatchedPage;

beforeAll(async () => {
  srv = await appServer(cleanup, { yaml: lanYaml });
  browser = await chrome(cleanup, srv.inst.dir);
  const added = await turjuman(srv.inst, ["keys", "add", "--label", "Main hall"]);
  expect(added.code).toBe(0);
  key = /^ {2}(\S{16,})$/m.exec(added.stdout)?.[1] ?? "";
  expect(key).not.toBe("");
});

/** The caption page /ar/nl<query> in a context of its own, listening to the fake microphone. */
async function captionPage(query: string): Promise<WatchedPage> {
  const w = await tab(browser, srv.url);
  await w.page.goto(`${srv.url}/ar/nl${query}`);
  return w;
}

describe("lan: caption pages need an access key", () => {
  it("the server tells pages that a key is needed", async () => {
    expect((await api(srv.url, "GET", "/api/languages")).body).toMatchObject({ keyRequired: true });
  });

  it("without a key, the caption page says how to add one", async () => {
    const w = await captionPage("");
    await textOf(
      w.page.locator("#banners .banner.error"),
      // No full stop yet between the server's sentence and the page's "Retrying …".
      /^This server needs an access key: add \?key=… to the page URL\.? Retrying every 5 min\.$/,
    );
    await waitForStats(w.page, "the error state", (s) => s.state === "error");
    expect(takeProblems(w)).toEqual([]);
    await w.context.close();
  });

  it("with a wrong key, the caption page shows the banner and no captions", async () => {
    const w = await captionPage("?key=not-the-right-key-0000");
    await textOf(
      w.page.locator("#banners .banner.error"),
      /^Invalid or expired access key\.? Retrying every 5 min\.$/,
    );
    const stats = await waitForStats(w.page, "the error state", (s) => s.state === "error");
    expect(stats.sessionId).toBeNull();
    expect(takeProblems(w)).toEqual([]);
    await w.context.close();
  });

  it("with the key, the caption page captions the microphone", async () => {
    keyed = await captionPage(`?key=${encodeURIComponent(key)}`);
    await waitForStats(keyed.page, "caption blocks", (s) => s.blocks >= 1, 30_000);
    await textOf(
      keyed.page.locator("#captions .blk-text").first(),
      new RegExp(`^${FIRST_CAPTION}`),
    );
    expect(await keyed.page.locator("#banners .banner").count()).toBe(0);
    expect(takeProblems(keyed)).toEqual([]);
  });
});

describe("lan: the control dock is the operator's", () => {
  it("refuses the dock without the admin token and opens it with ?token=", async () => {
    const w = await tab(browser, srv.url);
    const res = await w.page.goto(`${srv.url}/control`);
    expect(res?.status()).toBe(401);
    expect(await w.page.locator("body").textContent()).toContain(
      "Admin login required: log in at /login as an admin, or use the admin token",
    );
    expect(takeProblems(w)).toEqual([expect.stringMatching(refused(401))]);

    // The dock's confirm steps last 4 s: the test holds the page's clock while it confirms.
    await w.context.clock.install();
    await w.page.goto(`${srv.url}/control?token=${encodeURIComponent(srv.token)}`);
    await textOf(w.page.locator("#conn"), "connected");
    expect(await w.page.locator("#start").isEnabled()).toBe(true);
    // The keyed caption page is one of its sessions, with the key's label.
    const row = w.page.locator("#sessions li.session");
    await textOf(row.locator(".row-title"), "ar → nl · soniox");
    await textOf(row.locator(".kind"), "page");
    await textOf(row.locator(".small.muted"), /^Main hall · .* · live$/);
    await textOf(w.page.locator("#sessions-count"), "(1)");

    // A prayer card on that page from the dock, then Stop (with its confirm step) ends it.
    await row.getByRole("button", { name: "Athan" }).click();
    await textOf(
      keyed.page.locator('#captions .blk-event.is-active[data-event="athan"] .ev-title'),
      "Athan",
    );
    await w.page.clock.pauseAt(Date.now() + 1000);
    await row.getByRole("button", { name: "Stop" }).click();
    await row.getByRole("button", { name: "Confirm" }).click();
    await w.page.clock.resume();
    await textOf(
      keyed.page.locator("#captions .blk-end .blk-marker"),
      new RegExp(`^${uiLabels("nl").ended} · \\d\\d:\\d\\d$`),
    );
    await textOf(w.page.locator("#sessions-note"), "No active sessions.");
    expect(takeProblems(w)).toEqual([]);
    expect(takeProblems(keyed)).toEqual([]);
    await w.context.close();
    await keyed.context.close();
  });

  // Was a bug: without an audio input (the default) the dock got no status until a local session
  // started, so its badge said "unknown".
  it("a server without a local session shows the dock idle", async () => {
    const w = await tab(browser, srv.url);
    await w.page.goto(`${srv.url}/control?token=${encodeURIComponent(srv.token)}`);
    await textOf(w.page.locator("#conn"), "connected");
    await textOf(w.page.locator("#state"), "idle", 3000);
    await w.context.close();
  });
});
