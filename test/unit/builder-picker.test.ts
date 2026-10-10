// @vitest-environment happy-dom
// The builder (web/picker.ts) on a local install: the six steps and the caption link they make,
// the remembered choices, the access key of a LAN browser, the look and placement steps, copying
// and opening the link, and the page in Dutch and Arabic. Screen mode and the microphone step
// have their own files.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $,
  all,
  type Browser,
  byId,
  change,
  closeBrowser,
  deferred,
  doc,
  type FakeMedia,
  FakeResizeObserver,
  fire,
  input,
  key,
  LANGS,
  languagesReply,
  type Reply,
  setDefaultSize,
  settle,
  win,
} from "./helpers/builder-dom.js";
import {
  boot,
  cell,
  checked,
  click,
  currentBrowser,
  disabled,
  hidden,
  LAN,
  link,
  linkSoFar,
  next,
  radio,
  step,
  text,
  value,
} from "./helpers/builder-picker.js";

interface HTMLLike {
  className: string;
  style: { getPropertyValue(name: string): string };
}

afterEach(() => closeBrowser());

describe("the caption link builder on a local install", () => {
  it("starts on the languages with Arabic → Dutch, the popular pairs and a plain link", async () => {
    const { b } = await boot();
    expect(step()).toBe("1");
    expect(text("server-status-text")).toBe("Ready");
    expect(byId("server-status").classList.contains("is-ok")).toBe(true);
    expect(value("from")).toBe("ar");
    expect(value("to")).toBe("nl");
    // Auto-detect first, then by name, each with its own name in front.
    const fromOptions = all("#from option").map((o) => o.textContent);
    expect(fromOptions[0]).toBe("Auto-detect (any language)");
    expect(fromOptions).toContain("العربية · Arabic");
    expect(fromOptions).toContain("English");
    expect(all("#to option").map((o) => o.getAttribute("value"))).not.toContain("auto");
    const chips = all("#pairs .pair-chip");
    expect(chips.map((c) => c.textContent)).toEqual([
      "Arabic → Dutch",
      "Arabic → English",
      "Arabic → Turkish",
      "Arabic → French",
    ]);
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(hidden("pairs-row")).toBe(false);
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    expect(hidden("key-row")).toBe(true);
    expect(hidden("back")).toBe(true);
    expect(disabled("next")).toBe(false);
    expect(hidden("jump-link")).toBe(true);
    expect(doc.title).toBe("Caption link · Turjuman");
    expect(text("b-title")).toBe("Caption link");
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    // A local install's footer has the server's own tools.
    expect(all("#app-foot a").map((a) => a.getAttribute("href"))).toEqual([
      "/control",
      "/overlay",
      "/health",
    ]);
    // Logged out: no question about the account (no 401 in the console).
    expect(b.api.sent("GET", "/api/auth/me")).toHaveLength(0);
    expect(b.api.sent("GET", "/api/languages")).toHaveLength(1);
    expect(b.api.sent("GET", "/api/presets")).toHaveLength(1);
  });

  it("shows the account of a logged-in browser, and nothing when that question fails", async () => {
    await boot({ loggedIn: true });
    const account = $(".acct-btn") as unknown as { hidden: boolean; textContent: string };
    expect(account.hidden).toBe(false);
    expect(account.textContent).toContain("Imam Yusuf");

    await boot({
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/auth/me", { status: 500 }),
    });
    expect(($(".acct-btn") as unknown as { hidden: boolean }).hidden).toBe(true);
    expect(step()).toBe("1");
  });

  it("walks the six steps and builds the caption link", async () => {
    const { b } = await boot();
    await next();
    expect(step()).toBe("2");
    expect(hidden("back")).toBe(false);
    radio("layout", "rollup");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?layout=rollup");
    await next();
    expect(step()).toBe("3");
    // Rolling looks first; the block looks are marked as such.
    const names = all("#gallery .theme-name").map((n) => n.textContent);
    expect(names.slice(0, 2)).toEqual(["Lower third", "Cinema"]);
    expect($("#gallery .theme-card:last-child").textContent).toContain("For blocks");
    expect($("#gallery .theme-card").textContent).not.toContain("For ");
    radio("preset", "cinema");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?preset=cinema");
    await next();
    expect(step()).toBe("4");
    input(byId("size"), "70");
    expect(text("size-value")).toBe("70 px");
    await next();
    expect(step()).toBe("5");
    change(byId("ch"), "left");
    change(byId("dsp"), "on");
    await next();
    expect(step()).toBe("6");
    expect(hidden("next")).toBe(true);
    expect(text("last-title")).toBe("Link");
    expect(text("last-step-label")).toBe("Link");
    const url = link();
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:8765/ar/nl");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      preset: "cinema",
      size: "70",
      ch: "left",
      dsp: "on",
    });
    // OBS: a rolling strip is 1920 × 400.
    expect(byId("obs-mount").textContent).toContain("400");
    click("open");
    expect(b.assign).toHaveBeenCalledWith("/ar/nl?preset=cinema&size=70&ch=left&dsp=on");
    // The look page starts from the same choices.
    const look = new URL(byId<{ href: string }>("customize").href);
    expect(look.pathname).toBe("/app/look");
    expect(Object.fromEntries(look.searchParams)).toEqual({
      from: "ar",
      to: "nl",
      preset: "cinema",
      size: "70",
    });
    expect(byId<{ href: string }>("customize-3").href).toBe(
      byId<{ href: string }>("customize").href,
    );
    // The choices are remembered for the next visit.
    expect(win.localStorage.getItem("captions.picker.preset")).toBe("cinema");
    expect(win.localStorage.getItem("captions.picker.ch")).toBe("left");
    expect(win.localStorage.getItem("captions.picker.dsp")).toBe("on");
    expect(win.localStorage.getItem("captions.picker.done")).toBe("1");
    expect(win.location.hash).toBe("#step=6");
  });

  it("comes back with the remembered setup and offers to jump to the link", async () => {
    await boot({
      storage: {
        "captions.picker.from": "en",
        "captions.picker.to": "tr",
        "captions.picker.layout": "rollup",
        "captions.picker.preset": "lower-third",
        "captions.picker.size": "500",
        "captions.picker.show": "source",
        "captions.picker.partial": "1",
        "captions.picker.quranArabic": "0",
        "captions.picker.pos": "top",
        "captions.picker.justify": "right",
        "captions.picker.width": "55",
        "captions.picker.height": " ",
        "captions.picker.lines": "3",
        "captions.picker.mic": "USB Mixer",
        "captions.picker.ch": "right",
        "captions.picker.dsp": "on",
        "captions.picker.advanced": "1",
        "captions.picker.done": "1",
      },
    });
    expect(hidden("jump-link")).toBe(false);
    expect(byId<{ open: boolean }>("more-audio").open).toBe(true);
    // The remembered microphone stays chosen although this browser can't name it yet.
    expect(value("mic")).toBe("USB Mixer");
    expect(all("#mic option").map((o) => o.getAttribute("value"))).toEqual(["", "USB Mixer"]);
    click("jump-link");
    expect(step()).toBe("6");
    expect(Object.fromEntries(link().searchParams)).toEqual({
      preset: "lower-third",
      size: "120",
      show: "source",
      pos: "top",
      lines: "3",
      width: "55",
      justify: "right",
      mic: "USB Mixer",
      ch: "right",
      dsp: "on",
      partial: "1",
    });
    // Rolling captions have no Quran switch, but the choice is kept for the blocks.
    expect(win.localStorage.getItem("captions.picker.quranArabic")).toBe("0");
  });

  it("ignores remembered values it can't use", async () => {
    await boot({
      storage: {
        "captions.picker.from": "ar",
        "captions.picker.to": "nl",
        "captions.picker.layout": "sideways",
        "captions.picker.size": "big",
        "captions.picker.show": "everything",
        "captions.picker.quranArabic": "maybe",
        "captions.picker.ch": "centre",
        "captions.picker.preset": "gone-look",
      },
    });
    expect(hidden("jump-link")).toBe(true);
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    expect(win.localStorage.getItem("captions.picker.preset")).toBeNull();
  });

  it("takes languages, a look and a layout from a link and cleans the address bar", async () => {
    await boot({
      url: "http://127.0.0.1:8765/?from=EN&to=AR&preset=Cinema&layout=blocks",
    });
    expect(win.location.search).toBe("");
    expect(win.location.pathname).toBe("/");
    expect(value("from")).toBe("en");
    expect(value("to")).toBe("ar");
    expect(hidden("error")).toBe(true);
    expect(linkSoFar()).toBe("127.0.0.1:8765/en/ar?preset=cinema&layout=blocks");
  });

  it("keeps the layout when the link names a look this page doesn't know yet", async () => {
    await boot({ url: "http://127.0.0.1:8765/?preset=hall" });
    // Not a look of this server: back to the server's default look and its layout.
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
  });

  it("shows the caption page's error and hides it once a language changes", async () => {
    await boot({
      url: "http://127.0.0.1:8765/?error=Microphone%20blocked",
      storage: { "captions.picker.from": "ar", "captions.picker.done": "1" },
    });
    expect(hidden("error")).toBe(false);
    expect(text("error-text")).toBe("Microphone blocked");
    // Not a calm start: no "Use last setup".
    expect(hidden("jump-link")).toBe(true);
    change(byId("from"), "en");
    expect(hidden("error")).toBe(true);
    expect(linkSoFar()).toBe("127.0.0.1:8765/en/nl");
  });

  it("swaps the languages, takes a popular pair, and won't swap what the lists can't", async () => {
    await boot({
      setup: (b) =>
        b.api.on("GET", "/api/languages", {
          body: {
            sources: [
              { code: "ar", en: "Arabic", native: "العربية" },
              { code: "en", en: "English", native: "English" },
              { code: "nl", en: "Dutch", native: "Nederlands" },
            ],
            targets: [
              { code: "en", en: "English", native: "English" },
              { code: "nl", en: "Dutch", native: "Nederlands" },
              { code: "fr", en: "French", native: "Français" },
            ],
            defaults: { from: "ar", to: "nl" },
          },
        }),
    });
    // Only the pairs both lists have.
    expect(all("#pairs .pair-chip").map((c) => c.textContent)).toEqual([
      "Arabic → Dutch",
      "Arabic → English",
      "Arabic → French",
    ]);
    click("swap");
    expect(byId("next-hint").textContent).toBe("These two languages can’t be swapped.");
    expect(value("from")).toBe("ar");
    (all("#pairs .pair-chip")[1] as unknown as { click(): void }).click();
    expect(value("to")).toBe("en");
    expect(all("#pairs .pair-chip")[1]?.getAttribute("aria-pressed")).toBe("true");
    // A click between the chips changes nothing.
    byId<{ click(): void }>("pairs").click();
    expect(value("to")).toBe("en");
    change(byId("from"), "nl");
    click("swap");
    expect(value("from")).toBe("en");
    expect(value("to")).toBe("nl");
    expect(linkSoFar()).toBe("127.0.0.1:8765/en/nl");
    change(byId("to"), "en");
    expect(byId("next-hint").textContent).toBe("Choose two different languages.");
    expect(disabled("next")).toBe(true);
    change(byId("from"), "auto");
    expect(disabled("swap")).toBe(true);
    expect(disabled("next")).toBe(false);
  });

  it("reads the language list carefully", async () => {
    await boot({
      setup: (b) =>
        b.api.on("GET", "/api/languages", {
          body: {
            sources: [
              "ar",
              null,
              { code: "auto", en: "Detect" },
              { code: "  " },
              { code: "ar", en: "Arabic", native: "العربية" },
              { code: "ar", en: "Arabic again" },
              { code: "qq", en: "  " },
              { code: "1x", en: "Odd code", native: "Odd" },
            ],
            targets: [{ code: "nl", en: "Dutch", native: "Nederlands" }, { code: "qq" }],
            defaultFrom: "qq",
            defaultTo: "nl",
          },
        }),
    });
    expect(all("#from option").map((o) => o.getAttribute("value"))).toEqual([
      "auto",
      "ar",
      "1x",
      "qq",
    ]);
    // The browser can't name these codes: the server's English name (or the code) stays.
    expect(all("#from option").map((o) => o.textContent)).toContain("Odd · Odd code");
    expect(value("from")).toBe("qq");
    expect(value("to")).toBe("nl");
  });
});

describe("loading the language list and the looks", () => {
  it("waits for the language list when reloaded on a later step", async () => {
    // Nothing remembered: step 1 can't be judged yet, so the page waits there…
    const slow = deferred();
    const { b } = await boot({
      url: "http://127.0.0.1:8765/#step=4",
      setup: (b) =>
        b.api.on("GET", "/api/languages", async () => {
          await slow.promise;
          return languagesReply();
        }),
    });
    expect(step()).toBe("1");
    expect(text("server-status-text")).toBe("Connecting…");
    expect(byId("next-hint").textContent).toBe("Loading languages…");
    expect(disabled("next")).toBe(true);
    expect(byId<{ disabled: boolean }>("from").disabled).toBe(true);
    // …and goes on to step 4 once the list is in.
    slow.resolve();
    await settle();
    expect(step()).toBe("4");
    expect(win.location.hash).toBe("#step=4");
    expect(b.api.sent("GET", "/api/languages")).toHaveLength(1);
  });

  it("opens a remembered setup on its step at once, and goes back when step 1 no longer holds", async () => {
    const slow = deferred();
    await boot({
      url: "http://127.0.0.1:8765/#step=3",
      storage: { "captions.picker.from": "nl", "captions.picker.to": "nl" },
      setup: (b) =>
        b.api.on("GET", "/api/languages", async () => {
          await slow.promise;
          return languagesReply();
        }),
    });
    expect(step()).toBe("3");
    slow.resolve();
    await settle();
    // Dutch → Dutch: back to the languages.
    expect(step()).toBe("1");
    expect(byId("next-hint").textContent).toBe("Choose two different languages.");
  });

  it("says why the language list didn't load, and loads it again on Retry", async () => {
    let reply: Reply = { status: 503 };
    await boot({ setup: (b) => b.api.on("GET", "/api/languages", () => reply) });
    expect(hidden("load-error")).toBe(false);
    expect(text("load-error-text")).toBe("Couldn’t load the language list (HTTP 503).");
    expect(text("server-status-text")).toBe("Server not reachable");
    expect(byId("server-status").classList.contains("is-error")).toBe(true);
    expect(byId("next-hint").textContent).toBe("The language list couldn’t be loaded.");
    expect(disabled("next")).toBe(true);

    reply = { body: { sources: LANGS, targets: [] } };
    click("retry");
    await settle();
    expect(text("load-error-text")).toBe("The server sent an unexpected language list.");

    reply = { raw: "null" };
    click("retry");
    await settle();
    expect(text("load-error-text")).toBe("The server sent an unexpected language list.");

    reply = { body: { sources: "ar", targets: LANGS } };
    click("retry");
    await settle();
    expect(text("load-error-text")).toBe("The server sent an unexpected language list.");

    reply = "network-error";
    click("retry");
    await settle();
    expect(text("load-error-text")).toBe("Couldn’t reach the server.");

    reply = languagesReply();
    click("retry");
    await settle();
    expect(hidden("load-error")).toBe(true);
    expect(text("server-status-text")).toBe("Ready");
    expect(disabled("next")).toBe(false);
  });

  it("lists the server's own looks and its default, and forgets a look that is gone", async () => {
    const own = {
      id: "hall",
      name: "Main hall",
      description: "",
      vars: { "--cap-text-color": "#ffcc00" },
      options: { layout: "rollup" },
    };
    await boot({
      storage: { "captions.picker.preset": "deleted-look" },
      setup: (b) =>
        b.api.on("GET", "/api/presets", {
          body: {
            builtin: [],
            custom: [own, { id: "mosque-dark", name: "Fake built-in", vars: {}, options: {} }, 7],
            default: "hall",
          },
        }),
    });
    expect(win.localStorage.getItem("captions.picker.preset")).toBeNull();
    // The server's default look decides the layout (rolling) and is chosen.
    await next(2);
    const cards = all("#gallery .theme-card");
    const hall = cards.find((c) => c.textContent?.includes("Main hall"));
    expect(hall?.textContent).toContain("Default");
    expect(hall?.textContent).toContain("Your look");
    expect(hall?.textContent).toContain("Your own look.");
    const chosen = hall?.querySelector("input") as unknown as HTMLInputElement | undefined;
    expect(chosen?.checked).toBe(true);
    expect(cards.filter((c) => c.textContent?.includes("Fake built-in"))).toHaveLength(0);
    // The default needs no preset= in the link.
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    // A block look keeps the rolling layout chosen so far.
    radio("preset", "mosque-dark");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?preset=mosque-dark&layout=rollup");
  });

  it("keeps the built-in looks when the server has no looks to give", async () => {
    for (const reply of [{ status: 404 }, { raw: "null" }, "network-error"] as Reply[]) {
      await boot({
        storage: { "captions.picker.preset": "glass" },
        setup: (b) => b.api.on("GET", "/api/presets", reply),
      });
      expect(all("#gallery .theme-card")).toHaveLength(10);
      expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?preset=glass");
    }
  });

  it("ignores a default the server can't name", async () => {
    await boot({
      setup: (b) =>
        b.api.on("GET", "/api/presets", { body: { custom: "none", default: "missing" } }),
    });
    await next(2);
    const first = all("#gallery .theme-card")[0];
    expect(first?.textContent).toContain("Mosque dark");
    expect(first?.textContent).toContain("Default");
  });
});

describe("a browser on another computer", () => {
  it("waits on step 1 for the key when reloaded on a later step", async () => {
    const slow =
      (gate: Promise<void>) =>
      (b: Browser): void => {
        b.api.on("GET", "/api/languages", async () => {
          await gate;
          return languagesReply();
        });
      };
    const remembered = { "captions.picker.from": "ar", "captions.picker.to": "nl" };
    // Without a key the page can't go further than step 1 (the list never arrives here).
    await boot({ url: `${LAN}#step=3`, storage: remembered, setup: slow(new Promise(() => {})) });
    expect(step()).toBe("1");
    const list = deferred();
    await boot({
      url: `${LAN}#step=3`,
      storage: { ...remembered, "captions.picker.key": "k" },
      setup: slow(list.promise),
    });
    expect(step()).toBe("3");
    list.resolve();
    await settle();
    expect(step()).toBe("3");
  });

  it("needs the access key, keeps it in this browser and hides it on screen", async () => {
    const { b } = await boot({ url: LAN });
    expect(hidden("key-row")).toBe(false);
    expect(disabled("next")).toBe(true);
    expect(byId("next-hint").textContent).toBe("Enter the access key.");
    input(byId("key"), "  s3cret ");
    expect(win.localStorage.getItem("captions.picker.key")).toBe("s3cret");
    expect(disabled("next")).toBe(false);
    expect(linkSoFar()).toBe("192.168.1.20:8765/ar/nl?key=••••");
    expect(new URL(byId<{ href: string }>("customize").href).searchParams.get("key")).toBe(
      "s3cret",
    );
    await next(5);
    expect(link().searchParams.get("key")).toBe("s3cret");
    click("open");
    expect(b.assign).toHaveBeenCalledWith("/ar/nl?key=s3cret");
    input(byId("key"), "");
    expect(win.localStorage.getItem("captions.picker.key")).toBeNull();

    // The next visit fills it in again.
    await boot({ url: LAN, storage: { "captions.picker.key": "again" } });
    expect(value("key")).toBe("again");
    expect(disabled("next")).toBe(false);
  });

  it("explains that a microphone needs HTTPS and links to the server's own address", async () => {
    await boot({ url: "http://192.168.1.20/", secure: false, media: null });
    expect(hidden("insecure")).toBe(false);
    const a = $("#insecure-text a") as unknown as { href: string; textContent: string };
    expect(a.href).toBe("http://127.0.0.1:8765/");
    expect(byId("insecure-text").textContent).toBe(
      "No microphone over plain HTTP. Use https:// or http://127.0.0.1:8765/ on the server.",
    );
    expect(disabled("list-mics")).toBe(true);
    expect(disabled("test-mic")).toBe(true);
    expect(text("mic-note")).toBe(
      "Choosing or testing a microphone needs HTTPS (or this computer’s own address).",
    );
  });
});

describe("the look and the fine-tuning", () => {
  it("adds only what differs from the look to the link", async () => {
    await boot();
    await next(3);
    expect(step()).toBe("4");
    expect(hidden("row-quran")).toBe(false);
    expect(hidden("row-lines")).toBe(true);
    expect(hidden("row-height")).toBe(false);
    expect(disabled("tune-reset")).toBe(true);
    expect(text("show-src-title")).toBe("Arabic text");
    expect(checked("show-src")).toBe(false);
    expect(checked("quran-ar")).toBe(true);
    expect(checked("partial")).toBe(false);
    expect(text("size-value")).toBe("52 px");
    expect(text("width-value")).toBe("100 %");
    expect(text("height-value")).toBe("100 %");
    expect(text("opacity-value")).toBe("92 %");

    change(byId("show-src"), true);
    change(byId("quran-ar"), false);
    change(byId("partial"), true);
    input(byId("width"), "70");
    input(byId("height"), "60");
    input(byId("opacity"), "60");
    expect(text("width-value")).toBe("70 %");
    expect(text("opacity-value")).toBe("60 %");
    expect(disabled("tune-reset")).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(linkSoFar().split("?")[1]))).toEqual({
      show: "both",
      quranArabic: "0",
      partial: "1",
      width: "70",
      height: "60",
      panelOpacity: "60",
      blockOpacity: "60",
    });
    // Back at the look's own opacity: nothing to add.
    input(byId("opacity"), "92");
    expect(linkSoFar()).not.toContain("Opacity");
    // A slider being dragged keeps the value under the finger.
    for (const id of ["size", "width", "height", "opacity"]) {
      byId<{ focus(): void }>(id).focus();
      input(byId(id), "77");
      expect(value(id)).toBe("77");
    }
    expect(text("size-value")).toBe("77 px");
    click("tune-reset");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    expect(disabled("tune-reset")).toBe(true);
    expect(text("width-value")).toBe("100 %");
  });

  it("places the panel on a 3×3 grid and makes room for a camera picture", async () => {
    await boot();
    await next(3);
    const note = (): string => $("#place-mount .plc-note").textContent ?? "";
    cell("Top · Left").click();
    expect(note()).toBe(
      "Width set to 65 % so a camera picture fits on the right. Height set to 50 % so the panel can sit at the top.",
    );
    expect(Object.fromEntries(new URLSearchParams(linkSoFar().split("?")[1]))).toEqual({
      pos: "top",
      width: "65",
      height: "50",
      justify: "left",
    });
    expect(text("width-value")).toBe("65 %");
    expect(
      ($('#place-mount .plc-cell[aria-label="Top · Left"]') as unknown as Element).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    // The opposite pick gives the look its own sizes back.
    cell("Bottom · Center").click();
    expect(note()).toBe("Width back to the look’s own size. Height back to the look’s own size.");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    // A width set by hand stays.
    cell("Middle · Right").click();
    input(byId("width"), "75");
    expect($("#place-mount .plc-note").hidden).toBe(true);
    cell("Bottom · Center").click();
    expect(note()).toBe("Height back to the look’s own size.");
    expect(linkSoFar()).toContain("width=75");
    input(byId("height"), "80");
    cell("Top · Center").click();
    expect(linkSoFar()).toContain("height=80");
  });

  it("moves through the grid with the arrow keys", async () => {
    await boot();
    await next(3);
    const pressed = (): string | null =>
      $("#place-mount .plc-cell[aria-pressed=true]").getAttribute("aria-label");
    const bottomCenter = cell("Bottom · Center");
    bottomCenter.focus();
    key(bottomCenter, "ArrowUp");
    expect(pressed()).toBe("Middle · Center");
    key(doc.activeElement, "ArrowLeft");
    expect(pressed()).toBe("Middle · Left");
    key(doc.activeElement, "ArrowLeft");
    expect(pressed()).toBe("Middle · Left");
    key(doc.activeElement, "ArrowDown");
    expect(pressed()).toBe("Bottom · Left");
    key(doc.activeElement, "ArrowDown");
    key(doc.activeElement, "ArrowRight");
    key(doc.activeElement, "ArrowRight");
    key(doc.activeElement, "ArrowRight");
    expect(pressed()).toBe("Bottom · Right");
    const other = key(doc.activeElement, "Home");
    expect(other.defaultPrevented).toBe(false);
    // Only a focused cell moves.
    byId<{ focus(): void }>("size").focus();
    key($("#place-mount .plc"), "ArrowUp");
    expect(pressed()).toBe("Bottom · Right");
  });

  it("offers lines for rolling captions instead of a height and the Quran switch", async () => {
    await boot();
    await next();
    radio("layout", "rollup");
    await next(2);
    expect(hidden("row-lines")).toBe(false);
    expect(hidden("row-quran")).toBe(true);
    expect(hidden("row-height")).toBe(true);
    expect(checked("show-src")).toBe(true);
    radio("lines", "3");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?layout=rollup&lines=3");
    expect(win.localStorage.getItem("captions.picker.lines")).toBe("3");
    change(byId("show-src"), false);
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?layout=rollup&show=target&lines=3");
  });

  it("can't change the background of a look without one", async () => {
    await boot({ storage: { "captions.picker.preset": "minimal-transparent" } });
    await next(3);
    expect(disabled("opacity")).toBe(true);
    expect(text("opacity-value")).toBe("–");
    expect(byId("opacity").getAttribute("title")).toBe("This look has no background");
  });

  it("shows a faint look's own opacity under the slider's lowest value", async () => {
    await boot({ storage: { "captions.picker.preset": "glass" } });
    await next(3);
    expect(text("opacity-value")).toBe("7 %");
    expect(value("opacity")).toBe("40");
  });

  it("calls the source line 'Original text' when the language is detected", async () => {
    await boot();
    change(byId("from"), "auto");
    await next(3);
    expect(text("show-src-title")).toBe("Original text");
  });
});

describe("the link: open, copy, start over", () => {
  it("copies the link and says so for a moment", async () => {
    const { b } = await boot();
    await next(5);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    click("copy");
    await settle(1);
    expect(b.clipboard.writeText).toHaveBeenCalledWith("http://127.0.0.1:8765/ar/nl");
    expect(hidden("toast")).toBe(false);
    expect(text("toast-text")).toBe("Copied");
    vi.advanceTimersByTime(2000);
    click("copy");
    await settle(1);
    vi.advanceTimersByTime(2000);
    expect(hidden("toast")).toBe(false);
    vi.advanceTimersByTime(700);
    expect(hidden("toast")).toBe(true);
  });

  it("falls back to selecting the link, and says when copying failed", async () => {
    const { b } = await boot();
    await next(5);
    b.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    click("copy");
    await settle(1);
    expect(b.execCommand).toHaveBeenCalledWith("copy");
    expect(text("toast-text")).toBe("Copied");
    b.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    b.execCommand.mockReturnValueOnce(false);
    click("copy");
    await settle(1);
    expect(text("toast-text")).toBe("Copy failed. Select the link and copy it.");
    b.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    b.execCommand.mockImplementationOnce(() => {
      throw new Error("no execCommand");
    });
    click("copy");
    await settle(1);
    expect(text("toast-text")).toBe("Copy failed. Select the link and copy it.");
  });

  it("selects the link for copying where the clipboard needs HTTPS", async () => {
    const { b } = await boot({ url: LAN, secure: false, storage: { "captions.picker.key": "k" } });
    await next(5);
    click("copy");
    await settle(1);
    expect(b.clipboard.writeText).not.toHaveBeenCalled();
    expect(b.execCommand).toHaveBeenCalledWith("copy");
    expect(text("toast-text")).toBe("Copied");
  });

  it("sends a link opened too early back to the languages", async () => {
    const slow = deferred();
    const { b } = await boot({
      url: "http://127.0.0.1:8765/#step=6",
      storage: { "captions.picker.from": "ar", "captions.picker.to": "nl" },
      setup: (b) =>
        b.api.on("GET", "/api/languages", async () => {
          await slow.promise;
          return languagesReply();
        }),
    });
    expect(step()).toBe("6");
    click("open");
    expect(step()).toBe("1");
    expect(b.assign).not.toHaveBeenCalled();
    slow.resolve();
    await settle();
  });

  it("starts over with the defaults", async () => {
    await boot({ setup: (b) => ((b.media as FakeMedia).granted = true) });
    change(byId("to"), "en");
    await next();
    radio("layout", "rollup");
    await next(2);
    input(byId("size"), "80");
    await next();
    change(byId("mic"), "USB Mixer");
    await next();
    expect(step()).toBe("6");
    expect(link().searchParams.get("mic")).toBe("USB Mixer");
    click("start-over");
    expect(step()).toBe("1");
    expect(value("to")).toBe("nl");
    expect(value("mic")).toBe("");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    expect(win.localStorage.getItem("captions.picker.done")).toBeNull();
    expect(win.localStorage.getItem("captions.picker.size")).toBeNull();
    const steppers = all(".stepper-btn") as unknown as Array<{ disabled: boolean }>;
    expect(steppers.map((s) => s.disabled)).toEqual([false, true, true, true, true, true]);
  });

  it("starts over with a caption language the server offers", async () => {
    await boot({
      setup: (b) =>
        b.api.on("GET", "/api/languages", {
          body: {
            sources: [{ code: "ar", en: "Arabic", native: "العربية" }],
            targets: [
              { code: "tr", en: "Turkish", native: "Türkçe" },
              { code: "fr", en: "French", native: "Français" },
            ],
          },
        }),
    });
    // Neither Dutch nor English here, and no server default: the first of the list.
    expect(value("to")).toBe("fr");
    change(byId("to"), "tr");
    click("start-over");
    expect(value("to")).toBe("fr");
    expect(disabled("next")).toBe(false);
  });

  it("starts over without a language list too", async () => {
    await boot({
      storage: { "captions.picker.from": "en", "captions.picker.to": "tr" },
      setup: (b) => b.api.on("GET", "/api/languages", { status: 500 }),
    });
    expect(step()).toBe("1");
    click("start-over");
    expect(step()).toBe("1");
    expect(win.localStorage.getItem("captions.picker.from")).toBe("ar");
    expect(win.localStorage.getItem("captions.picker.to")).toBe("nl");
  });
});

describe("moving between the steps", () => {
  it("goes back and forth with the step bar, Back, the browser's history and Enter", async () => {
    const { b } = await boot();
    await next(3);
    expect(step()).toBe("4");
    const steppers = all(".stepper-btn");
    expect(steppers.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Step 1: Languages (done)",
      "Step 2: Layout (done)",
      "Step 3: Look (done)",
      "Step 4: Adjust (current)",
      "Step 5: Microphone",
      "Step 6: Link",
    ]);
    expect(steppers[3]?.getAttribute("aria-current")).toBe("step");
    expect((steppers[4] as unknown as { disabled: boolean }).disabled).toBe(true);
    expect(text("compact-count")).toBe("4/6");
    expect(text("compact-label")).toBe("Adjust");
    (steppers[1] as unknown as { click(): void }).click();
    expect(step()).toBe("2");
    expect(doc.activeElement?.textContent).toBe("Layout");
    // Steps already seen stay reachable.
    expect((steppers[3] as unknown as { disabled: boolean }).disabled).toBe(false);
    click("back");
    expect(step()).toBe("1");
    win.history.replaceState(null, "", "#step=3");
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    expect(step()).toBe("3");
    win.history.replaceState(null, "", "#step=2");
    win.dispatchEvent(new win.HashChangeEvent("hashchange"));
    expect(step()).toBe("2");
    win.dispatchEvent(new win.HashChangeEvent("hashchange"));
    expect(step()).toBe("2");
    // Enter in a field means Next; in a button it keeps its own meaning.
    click("back");
    key(byId("from"), "Enter");
    expect(step()).toBe("2");
    key($("input[name=layout]"), "Enter", { isComposing: true });
    key($("input[name=layout]"), "a");
    key(byId("back"), "Enter");
    expect(step()).toBe("2");
    key($("input[name=layout]"), "Enter");
    expect(step()).toBe("3");
    // A submit on the last step goes nowhere.
    await next(3);
    expect(step()).toBe("6");
    fire(byId("wizard"), "submit");
    key(byId("screen-name"), "Enter");
    expect(step()).toBe("6");
    expect(b.scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls the step bar back into view", async () => {
    const { b } = await boot();
    const stepper = $(".stepper");
    vi.spyOn(stepper, "getBoundingClientRect").mockReturnValue({
      top: -40,
    } as unknown as ReturnType<typeof stepper.getBoundingClientRect>);
    await next();
    expect(b.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("grows the link box with the link when the window resizes", async () => {
    await boot();
    await next(5);
    vi.spyOn(byId("url"), "scrollHeight", "get").mockReturnValue(96);
    win.dispatchEvent(new win.Event("resize"));
    expect(byId("url").style.getPropertyValue("height")).toBe("100px");
  });
});

describe("the previews", () => {
  it("draws the previews once they have room, and again when they change size", async () => {
    await boot({ setup: () => setDefaultSize(0) });
    expect(byId("preview-box").children).toHaveLength(0);
    expect($(".theme-thumb").children).toHaveLength(0);
    setDefaultSize(480);
    FakeResizeObserver.resize();
    const card = byId("preview-box").firstElementChild as unknown as HTMLLike;
    expect(card.className).toBe("pp-card");
    expect(card.style.getPropertyValue("width")).toBe("480px");
    expect(card.style.getPropertyValue("height")).toBe("270px");
    expect($(".theme-thumb .pp-card")).toBeTruthy();
    expect($("#thumb-rollup .pp-stage").classList.contains("layout-rollup")).toBe(true);
    // The same size again draws nothing new.
    FakeResizeObserver.resize(byId("preview-box"));
    expect(byId("preview-box").firstElementChild).toBe(card);
    // A change repaints the big preview in the next frame.
    const { frames } = currentBrowser();
    change(byId("to"), "en");
    frames.flush();
    expect(byId("preview-box").firstElementChild).not.toBe(card);
  });
});

describe("in Dutch and Arabic", () => {
  it("switches the whole builder to Dutch, the language names too", async () => {
    await boot();
    await next(5);
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(doc.documentElement.getAttribute("lang")).toBe("nl");
    expect(doc.title).toBe("Ondertitellink · Turjuman");
    expect(text("b-title")).toBe("Ondertitellink");
    expect(text("server-status-text")).toBe("Klaar");
    expect(text("compact-label")).toBe("Link");
    expect(all(".stepper-btn")[0]?.getAttribute("aria-label")).toBe("Stap 1: Talen (klaar)");
    expect(all("#from option").map((o) => o.textContent)).toContain("العربية · Arabisch");
    expect(all("#pairs .pair-chip")[0]?.textContent).toBe("Arabisch → Nederlands");
    expect(byId("obs-mount").textContent).toContain("1080");
    expect(text("copy")).toBe("Kopiëren");
    click("back");
    expect(text("next-label")).toBe("Volgende");
  });

  it("is right to left in Arabic", async () => {
    await boot({ storage: { "tj-app-lang": "ar" } });
    expect(doc.documentElement.getAttribute("dir")).toBe("rtl");
    expect(doc.title).toBe("رابط الترجمة · ترجمان");
    expect(text("server-status-text")).toBe("جاهز");
    // The arrow points the reading way.
    expect(all("#pairs .pair-chip")[0]?.textContent).toBe("العربية ← الهولندية");
    ($('.lang-btn[lang="en"]') as unknown as { click(): void }).click();
    expect(doc.documentElement.getAttribute("dir")).toBe("ltr");
    expect(text("server-status-text")).toBe("Ready");
  });

  it("translates the messages already on screen", async () => {
    await boot({
      url: "http://192.168.1.20:8765/",
      secure: false,
      setup: (b) => b.api.on("GET", "/api/languages", { status: 502 }),
    });
    expect(text("load-error-text")).toBe("Couldn’t load the language list (HTTP 502).");
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("load-error-text")).toBe("De talenlijst kon niet worden geladen (HTTP 502).");
    expect(text("server-status-text")).toBe("Server niet bereikbaar");
    expect(text("mic-note")).toBe(
      "Een microfoon kiezen of testen kan alleen via HTTPS (of het eigen adres van deze computer).",
    );
    expect(byId("insecure-text").textContent).toBe(
      "Geen microfoon via gewone HTTP. Gebruik https:// of http://127.0.0.1:8765/ op de server.",
    );
  });

  it("falls back to the server's English names where the browser has none", async () => {
    await boot({
      storage: { "tj-app-lang": "nl" },
      setup: () =>
        vi.spyOn(Intl, "DisplayNames").mockImplementation(() => {
          throw new RangeError("no language names");
        }),
    });
    // A Dutch page, but no Dutch language names to be had.
    expect(text("server-status-text")).toBe("Klaar");
    expect(all("#to option").map((o) => o.textContent)).toContain("Nederlands · Dutch");
    expect(all("#pairs .pair-chip")[0]?.textContent).toBe("Arabic → Dutch");
  });
});
