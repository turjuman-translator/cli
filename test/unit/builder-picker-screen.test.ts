// @vitest-environment happy-dom
// The builder in screen mode (/app/new, ?screen=new|<id>): the last step saves the setup as a
// screen (POST /api/screens) or saves an edited one (PATCH /api/screens/:id) and returns to the
// dashboard. It needs a login; an edited screen keeps its languages and its other link settings.
import { afterEach, describe, expect, it } from "vitest";
import {
  $,
  all,
  byId,
  closeBrowser,
  deferred,
  doc,
  input,
  key,
  languagesReply,
  type Reply,
  settle,
  win,
} from "./helpers/builder-dom.js";
import {
  boot,
  click,
  disabled,
  hidden,
  LAN,
  next,
  step,
  text,
  value,
} from "./helpers/builder-picker.js";

const NEW = "http://127.0.0.1:8765/app/new";

function screen(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    name: "Main hall",
    from: "ar",
    to: "en",
    query: "",
    guid: "g1",
    enabled: true,
    ownerControl: false,
    owner: null,
    createdAt: 1,
    updatedAt: 1,
    lastChange: null,
    url: "http://127.0.0.1:8765/feed/g1",
    localUrl: null,
    secureUrl: null,
    live: { pages: 0, sessions: 0, speaking: false, since: null, event: null },
    canControl: true,
    canEdit: true,
    ...over,
  };
}

afterEach(() => closeBrowser());

describe("a new screen", () => {
  it("sends a logged-out browser to the login page", async () => {
    const { b } = await boot({ url: NEW });
    // Back here (on its step) after logging in.
    expect(b.replace).toHaveBeenCalledWith("/login?next=%2Fapp%2Fnew%23step%3D1");
    expect(b.api.sent("GET", "/api/auth/me")).toHaveLength(0);
  });

  it("walks the steps and saves the screen, then goes back to the screens", async () => {
    const { b } = await boot({
      url: NEW,
      loggedIn: true,
      setup: (b) => b.api.on("POST", "/api/screens", { status: 201, body: screen({ id: "new1" }) }),
    });
    expect(text("b-title")).toBe("New screen");
    expect(doc.title).toBe("New screen · Turjuman");
    expect(hidden("screen-cancel")).toBe(false);
    expect(hidden("link-mode")).toBe(true);
    expect(hidden("save-mode")).toBe(false);
    expect(hidden("link-so-far")).toBe(true);
    expect(text("last-step-label")).toBe("Save");
    expect(text("last-title")).toBe("Save screen");
    expect(text("save-screen")).toBe("Save as screen");
    // The screen listens on the computer that shows it.
    expect(hidden("mic-tip")).toBe(true);
    expect(hidden("mic-where")).toBe(false);
    expect(text("mic-where")).toBe(
      "The screen listens through the microphone of the computer that shows it. A microphone chosen here by name must exist on that computer.",
    );
    expect(hidden("mic-phone")).toBe(true);
    // The app's header: Screens is where this belongs, with the account.
    expect($('a[data-nav="screens"]').getAttribute("aria-current")).toBe("page");
    expect($(".app-brand").getAttribute("href")).toBe("/app");
    expect(text("compact-label")).toBe("Languages");
    await next(5);
    expect(step()).toBe("6");
    expect(text("compact-label")).toBe("Save");
    expect(all(".stepper-btn")[5]?.getAttribute("aria-label")).toBe("Step 6: Save (current)");
    click("save-screen");
    expect(text("save-error")).toBe("Enter a name.");
    expect(doc.activeElement).toBe(byId("screen-name"));
    input(byId("screen-name"), "  Main hall  ");
    click("save-screen");
    expect(disabled("save-screen")).toBe(true);
    await settle();
    expect(b.api.sent("POST", "/api/screens").map((c) => c.body)).toEqual([
      { name: "Main hall", from: "ar", to: "nl", query: "" },
    ]);
    expect(b.assign).toHaveBeenCalledWith("/app?saved=new1");
    // A screen is the server's: this browser's own builder choices stay as they were.
    expect(win.localStorage.getItem("captions.picker.from")).toBeNull();
  });

  it("saves with Enter in the name field, and keeps the key out of the screen", async () => {
    const { b } = await boot({
      url: `${LAN}?screen=new`,
      loggedIn: true,
      storage: { "captions.picker.key": "s3cret", "captions.picker.mic": "USB Mixer" },
      setup: (b) => b.api.on("POST", "/api/screens", { status: 204 }),
    });
    // ?screen= stays in the address bar.
    expect(win.location.search).toBe("?screen=new");
    expect(hidden("key-row")).toBe(true);
    expect(disabled("next")).toBe(false);
    await next(5);
    input(byId("screen-name"), "Women's hall");
    key(byId("screen-name"), "a");
    expect(b.api.sent("POST", "/api/screens")).toHaveLength(0);
    const enter = key(byId("screen-name"), "Enter");
    expect(enter.defaultPrevented).toBe(true);
    // Enter saved; it did not also mean Next.
    expect(step()).toBe("6");
    await settle();
    expect(b.api.sent("POST", "/api/screens")[0]?.body).toEqual({
      name: "Women's hall",
      from: "ar",
      to: "nl",
      query: "mic=USB+Mixer",
    });
    // Saved without an answer to read: the dashboard without a highlight.
    expect(b.assign).toHaveBeenCalledWith("/app");
  });

  it("shows why saving failed and lets the user try again", async () => {
    let reply: Reply = {
      status: 400,
      body: { ok: false, message: "A screen with this name exists" },
    };
    const { b } = await boot({
      url: NEW,
      loggedIn: true,
      setup: (b) => b.api.on("POST", "/api/screens", () => reply),
    });
    await next(5);
    input(byId("screen-name"), "Main hall");
    click("save-screen");
    await settle();
    expect(text("save-error")).toBe("A screen with this name exists");
    expect(disabled("save-screen")).toBe(false);
    expect(b.assign).not.toHaveBeenCalled();
    reply = "network-error";
    click("save-screen");
    await settle();
    expect(text("save-error")).toBe("Can’t reach the server. Check the connection and try again.");
    // The server's words stay as they are; ours follow the language.
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("save-error")).toBe(
      "De server is niet bereikbaar. Controleer de verbinding en probeer het opnieuw.",
    );
    reply = { status: 401, body: { message: "Log in" } };
    click("save-screen");
    await settle();
    expect(b.assign).toHaveBeenCalledWith("/login?next=%2Fapp%2Fnew%23step%3D6");
  });

  it("sends a save without usable languages back to step 1", async () => {
    const { b } = await boot({
      url: `${NEW}#step=6`,
      loggedIn: true,
      storage: { "captions.picker.from": "ar", "captions.picker.to": "nl" },
      setup: (b) => b.api.on("GET", "/api/languages", { status: 500 }),
    });
    expect(step()).toBe("6");
    input(byId("screen-name"), "Main hall");
    click("save-screen");
    expect(step()).toBe("1");
    expect(b.api.sent("POST", "/api/screens")).toHaveLength(0);
  });

  it("can't start when the account can't be checked", async () => {
    const { b } = await boot({
      url: NEW,
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/auth/me", { status: 500 }),
    });
    expect(text("save-error")).toBe("The server had a problem. Try again in a moment.");
    expect(b.replace).not.toHaveBeenCalled();
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("save-error")).toBe("De server had een probleem. Probeer het zo opnieuw.");
  });

  it("warns on a phone that its microphones aren't the screen's", async () => {
    for (const handheld of ["touch", "ua", "ua-data"] as const) {
      await boot({ url: NEW, loggedIn: true, handheld });
      expect(hidden("mic-phone")).toBe(false);
      expect(text("mic-phone")).toContain(
        "This list shows the microphones of this phone or tablet",
      );
    }
    await boot({ url: LAN, handheld: "touch" });
    expect(hidden("mic-phone")).toBe(true);
  });

  it("has no server tools in the footer of a hosted mosque", async () => {
    await boot({ url: NEW, loggedIn: true, hosted: true });
    expect(all("#app-foot a")).toHaveLength(0);
    expect(byId("app-foot").textContent).toContain("Free and open source");
  });
});

describe("editing a screen", () => {
  // Lower third: a rolling look whose blocks have a background (the opacity applies to them).
  const QUERY =
    "preset=Lower-Third&size=60.4&fg=ffcc00&fg=000000&mic=USB+Mixer&ch=left&dsp=1&panelOpacity=70" +
    "&lines=3&quranArabic=no&partial=on&pos=top&justify=right&width=80&height=abc&show=target" +
    "&key=old&screen=s1&engine=soniox&translation=native";

  it("loads the screen, keeps its languages and the settings the builder doesn't show", async () => {
    const { b } = await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) =>
        b.api
          .on("GET", "/api/screens", { body: [screen({ id: "other" }), screen({ query: QUERY })] })
          .on("PATCH", "/api/screens/s1", { body: screen() }),
    });
    expect(text("b-title")).toBe("Edit · Main hall");
    expect(doc.title).toBe("Edit · Main hall · Turjuman");
    expect(value("screen-name")).toBe("Main hall");
    expect(text("save-screen")).toBe("Save changes");
    expect(text("last-title")).toBe("Save changes");
    expect(value("from")).toBe("ar");
    expect(value("to")).toBe("en");
    expect(disabled("from")).toBe(true);
    expect(disabled("to")).toBe(true);
    expect(disabled("swap")).toBe(true);
    expect(hidden("pairs-row")).toBe(true);
    expect(hidden("lang-lock")).toBe(false);
    expect(value("mic")).toBe("USB Mixer");
    expect(value("ch")).toBe("left");
    expect(value("dsp")).toBe("on");
    // In Dutch the languages stay locked.
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("b-title")).toBe("Bewerken · Main hall");
    expect(disabled("from")).toBe(true);
    expect(hidden("pairs-row")).toBe(true);
    ($('.lang-btn[lang="en"]') as unknown as { click(): void }).click();
    await next(5);
    click("save-screen");
    await settle();
    const sent = b.api.sent("PATCH", "/api/screens/s1");
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as { name: string; query: string };
    expect(body.name).toBe("Main hall");
    // Never the key, the screen or an engine; the Quran switch means nothing when rolling; a
    // setting given twice keeps its first value (as a caption page reads it).
    expect(Object.fromEntries(new URLSearchParams(body.query))).toEqual({
      preset: "lower-third",
      show: "target",
      partial: "1",
      pos: "top",
      lines: "3",
      size: "60",
      width: "80",
      justify: "right",
      blockOpacity: "70",
      mic: "USB Mixer",
      ch: "left",
      dsp: "on",
      fg: "ffcc00",
    });
    expect(b.assign).toHaveBeenCalledWith("/app?saved=s1");
  });

  it("returns to the screen it edited when the server sends no body", async () => {
    const { b } = await boot({
      url: "http://127.0.0.1:8765/?screen=s1",
      loggedIn: true,
      setup: (b) =>
        b.api
          .on("GET", "/api/screens", { body: [screen({ query: "layout=rollup&lines=x" })] })
          .on("PATCH", "/api/screens/s1", { status: 204 }),
    });
    expect(text("b-title")).toBe("Edit · Main hall");
    await next(5);
    input(byId("screen-name"), "Renamed");
    click("save-screen");
    await settle();
    expect(b.api.sent("PATCH", "/api/screens/s1")[0]?.body).toEqual({
      name: "Renamed",
      query: "layout=rollup",
    });
    expect(b.assign).toHaveBeenCalledWith("/app?saved=s1");
  });

  it("says 'Edit screen' until the screen is loaded, and fills it in once the languages arrive", async () => {
    const screens = deferred();
    const langs = deferred();
    await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) =>
        b.api
          .on("GET", "/api/screens", async () => {
            await screens.promise;
            return { body: [screen({ from: "en", to: "tr" })] };
          })
          .on("GET", "/api/languages", async () => {
            await langs.promise;
            return languagesReply();
          }),
    });
    expect(text("b-title")).toBe("Edit screen");
    screens.resolve();
    await settle();
    expect(text("b-title")).toBe("Edit · Main hall");
    langs.resolve();
    await settle();
    expect(value("from")).toBe("en");
    expect(value("to")).toBe("tr");
    expect(disabled("from")).toBe(true);
  });

  it("explains a screen whose languages are no longer offered", async () => {
    await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/screens", { body: [screen({ from: "ur" })] }),
    });
    expect(byId("next-hint").textContent).toBe("Choose the spoken language.");
    expect(disabled("next")).toBe(true);
    await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/screens", { body: [screen({ to: "xx" })] }),
    });
    expect(byId("next-hint").textContent).toBe("Choose the caption language.");
  });

  it("says when the screen is gone", async () => {
    for (const body of [[screen({ id: "other" })], { screens: [] }]) {
      await boot({
        url: `${NEW}?screen=s1`,
        loggedIn: true,
        setup: (b) => b.api.on("GET", "/api/screens", { body }),
      });
      expect(text("b-title")).toBe("This screen no longer exists");
      expect(disabled("save-screen")).toBe(true);
    }
  });

  it("goes to the login page when the login expired", async () => {
    const { b } = await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/screens", { status: 401 }),
    });
    expect(b.replace).toHaveBeenCalledWith("/login?next=%2Fapp%2Fnew%3Fscreen%3Ds1%23step%3D1");
  });

  it("says when the screen couldn't be loaded", async () => {
    await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/screens", { status: 500 }),
    });
    expect(text("save-error")).toBe("The server had a problem. Try again in a moment.");
    // A reply the page can't read.
    await boot({
      url: `${NEW}?screen=s1`,
      loggedIn: true,
      setup: (b) => b.api.on("GET", "/api/screens", { body: [null] }),
    });
    expect(text("save-error")).toBe("Couldn’t load the screen.");
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("save-error")).toBe("Het scherm kon niet worden geladen.");
  });
});

describe("the address", () => {
  it("is a plain link builder on / with an empty ?screen=", async () => {
    await boot({ url: "http://127.0.0.1:8765/?screen=%20" });
    expect(text("b-title")).toBe("Caption link");
    expect(hidden("link-mode")).toBe(false);
  });

  it("is the screen builder anywhere under /app", async () => {
    const { b } = await boot({ url: "http://127.0.0.1:8765/app" });
    expect(text("b-title")).toBe("New screen");
    expect(b.replace).toHaveBeenCalledWith("/login?next=%2Fapp%23step%3D1");
  });
});
