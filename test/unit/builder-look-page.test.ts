// @vitest-environment happy-dom
// The look editor's page around the controls (web/customize.ts): the live preview and its tools,
// the links and copying them, hosted versus local, who is logged in, the full-window preview
// (?view=preview), and the page in Dutch and Arabic.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $,
  all,
  byId,
  change,
  closeBrowser,
  doc,
  FakeResizeObserver,
  input,
  setSize,
  settle,
  win,
} from "./helpers/builder-dom.js";
import {
  bootLook,
  card,
  control,
  customPreset,
  frame,
  part,
  themeQs,
  toastText,
} from "./helpers/builder-look.js";

const text = (id: string): string => (byId(id).textContent ?? "").trim();
const value = (id: string): string => byId<{ value: string }>(id).value;
const stage = (): HTMLElement => $("#stage-frame .pp-stage") as unknown as HTMLElement;

function aspect(label: string): void {
  const b = all("#aspect .seg-btn").find((x) => x.textContent === label);
  (b as unknown as { click(): void }).click();
  frame();
}

afterEach(() => closeBrowser());

describe("the live preview", () => {
  it("shows the look on a screen, a lower third or a phone, at a scale that fits", async () => {
    await bootLook();
    expect(stage().style.getPropertyValue("width")).toBe("1920px");
    expect(stage().style.getPropertyValue("height")).toBe("1080px");
    // A 320 × 180 box, 28 px of it padding: 152 / 1080 of the full size.
    expect(stage().style.getPropertyValue("transform")).toBe(`scale(${152 / 1080})`);
    expect(byId("stage-frame").style.getPropertyValue("width")).toBe("270px");
    expect(text("stage-caption")).toBe(
      "1920 × 1080: a TV, a projector or a full OBS picture · shown at 14 %1920 × 1080 · 14 %",
    );
    aspect("Lower third");
    expect(stage().style.getPropertyValue("height")).toBe("400px");
    expect($(".cz-cap-long").textContent).toBe("1920 × 400: a strip in OBS · shown at 15 %");
    aspect("Phone");
    expect(stage().style.getPropertyValue("width")).toBe("390px");
    expect($('#aspect .seg-btn[aria-pressed="true"]').textContent).toBe("Phone");
    expect(JSON.parse(win.localStorage.getItem("captions.customize.v1") ?? "{}").aspect).toBe(
      "phone",
    );
  });

  it("changes what is behind and the sample, shows the browser toolbar, and replays", async () => {
    await bootLook();
    expect($("#stage-frame .pp-backdrop").classList.contains("pp-bd-video")).toBe(true);
    change(byId("backdrop"), "checker");
    frame();
    expect($("#stage-frame .pp-backdrop").classList.contains("pp-bd-checker")).toBe(true);
    change(byId("sample"), "events");
    frame();
    expect(all("#stage-frame .pp-blk-event").length).toBeGreaterThan(0);
    expect(byId<{ href: string }>("open-preview").href).toBe(
      "http://127.0.0.1:8765/app/look?view=preview&backdrop=checker&sample=events&to=nl",
    );
    expect(doc.querySelector("#stage-frame .pp-tb")).toBeNull();
    change(byId("browser"), true);
    frame();
    expect($("#stage-frame .pp-tb").textContent).toContain("NL");
    // A colour change restyles the same stage; Replay builds it again with the newest block arriving.
    const before = stage();
    input(part(control("Panel", "Corner radius"), "input[type=range]"), "30");
    frame();
    expect(stage()).toBe(before);
    expect(stage().style.getPropertyValue("--cap-panel-radius")).toBe("30px");
    byId<{ click(): void }>("replay").click();
    expect(stage()).not.toBe(before);
    expect($("#stage-frame .pp-blk.is-new").classList.contains("pp-enter")).toBe(true);
  });

  it("fits the preview to its box and draws the thumbnails again for a new column width", async () => {
    await bootLook({ noFrame: true });
    // The box changed size before the first drawing: nothing to fit yet.
    FakeResizeObserver.resize(byId("stage-box"));
    frame();
    setSize(byId("stage-box"), 928, 568);
    FakeResizeObserver.resize(byId("stage-box"));
    expect(stage().style.getPropertyValue("transform")).toBe(`scale(${900 / 1920})`);
    expect(byId("stage-frame").style.getPropertyValue("height")).toBe("506px");
    const thumb = $("#gallery .pcard");
    setSize(byId("gallery"), 324);
    FakeResizeObserver.resize(byId("gallery"));
    expect($("#gallery .pcard")).toBe(thumb);
    setSize(byId("gallery"), 600);
    FakeResizeObserver.resize(byId("gallery"));
    expect($("#gallery .pcard")).not.toBe(thumb);
    expect(($("#gallery .pp-card") as unknown as HTMLElement).style.getPropertyValue("width")).toBe(
      "260px",
    );
  });

  it("fits the preview on a window resize where there is no ResizeObserver", async () => {
    await bootLook({ setup: () => vi.stubGlobal("ResizeObserver", undefined) });
    setSize(byId("stage-box"), 428, 268);
    win.dispatchEvent(new win.Event("resize"));
    expect(stage().style.getPropertyValue("transform")).toBe(`scale(${400 / 1920})`);
  });

  it("draws thumbnails at a sensible size before the column has one", async () => {
    await bootLook({ setup: () => setSize(byId("gallery"), 0) });
    expect(($("#gallery .pp-card") as unknown as HTMLElement).style.getPropertyValue("width")).toBe(
      "194px",
    );
  });
});

describe("the links", () => {
  it("follow the languages and the layout", async () => {
    await bootLook();
    input(byId("from"), " en ");
    frame();
    expect(value("url-caption")).toBe("http://127.0.0.1:8765/en/nl");
    const thumb = $("#gallery .pcard");
    input(byId("to"), "ar");
    frame();
    expect(value("url-caption")).toBe("http://127.0.0.1:8765/en/ar");
    expect(byId<{ href: string }>("open-caption").href).toBe("http://127.0.0.1:8765/en/ar");
    // The samples speak the caption language: the thumbnails are drawn again.
    expect($("#gallery .pcard")).not.toBe(thumb);
    expect($("#gallery .pp-blk").getAttribute("lang")).toBe("ar");
    expect($("#stage-frame .pp-blk").getAttribute("lang")).toBe("ar");
    input(byId("to"), "not a code");
    frame();
    expect(value("url-caption")).toBe("http://127.0.0.1:8765/en/nl");
    const thumb2 = $("#gallery .pcard");
    input(byId("from"), "fr");
    frame();
    expect($("#gallery .pcard")).toBe(thumb2);

    const layout = control("Layout and placement", "Layout");
    const roll = [...layout.querySelectorAll(".seg-btn")].find((b) => b.textContent === "Rolling");
    (roll as unknown as { click(): void }).click();
    frame();
    expect(value("url-overlay")).toBe("http://127.0.0.1:8765/overlay?layout=rollup&lang=fr%2Cnl");
    expect(byId<{ href: string }>("open-overlay").href).toBe(value("url-overlay"));
    const show = control("Layout and placement", "Show");
    for (const [label, langs] of [
      ["Translation", "nl"],
      ["Original", "fr"],
    ]) {
      const b = [...show.querySelectorAll(".seg-btn")].find((x) => x.textContent === label);
      (b as unknown as { click(): void }).click();
      frame();
      expect(new URL(value("url-overlay")).searchParams.get("lang")).toBe(langs);
    }
  });

  it("copies the caption link, the overlay link and the look", async () => {
    const { b } = await bootLook();
    byId<{ click(): void }>("copy-caption").click();
    await settle(1);
    expect(b.clipboard.writeText).toHaveBeenLastCalledWith("http://127.0.0.1:8765/ar/nl");
    expect(toastText()).toBe("Copied");
    byId<{ click(): void }>("copy-overlay").click();
    await settle(1);
    expect(b.clipboard.writeText).toHaveBeenLastCalledWith("http://127.0.0.1:8765/overlay");
    // "Look only" copies the parameters, not the explanation shown when there are none.
    byId<{ click(): void }>("copy-theme").click();
    await settle(1);
    expect(b.clipboard.writeText).toHaveBeenLastCalledWith("");
    input(part(control("Panel", "Corner radius"), "input[type=range]"), "30");
    frame();
    byId<{ click(): void }>("copy-theme").click();
    await settle(1);
    expect(b.clipboard.writeText).toHaveBeenLastCalledWith("panelRadius=30");
  });

  it("selects the text when it can't copy", async () => {
    const { b } = await bootLook();
    b.clipboard.writeText.mockRejectedValue(new Error("denied"));
    b.execCommand.mockReturnValue(false);
    byId<{ click(): void }>("copy-caption").click();
    await settle(1);
    expect(toastText()).toBe("Couldn’t copy. Select the text and copy it.");
    expect($("#toast").classList.contains("is-error")).toBe(true);
    expect(doc.activeElement).toBe(byId("url-caption"));
  });
});

describe("hosted and local", () => {
  it("is the mosque's own on a hosted server: no links, no server default", async () => {
    const { b } = await bootLook({
      mode: "hosted",
      url: "http://127.0.0.1:8765/app/look?to=ar",
    });
    expect(byId<{ hidden: boolean }>("use-local").hidden).toBe(true);
    expect(text("use-lead")).toBe(
      "Save it as a look, then choose it for a screen: Screens → ⋯ → Change look.",
    );
    expect(all("#app-foot a")).toHaveLength(0);
    // The sample text speaks the caption language the builder sent along.
    expect($("#stage-frame .pp-blk").getAttribute("lang")).toBe("ar");
    expect(b.api.sent("GET", "/api/auth/me")).toHaveLength(1);
    await bootLook({ mode: "hosted", url: "http://127.0.0.1:8765/app/look?to=x!" });
    expect($("#stage-frame .pp-blk").getAttribute("lang")).toBe("en");
  });

  it("sends a logged-out visitor of a hosted server to the login page", async () => {
    const { b } = await bootLook({
      mode: "hosted",
      loggedIn: false,
      setup: (b) => b.api.on("GET", "/api/auth/me", { status: 401 }),
    });
    expect(b.replace).toHaveBeenCalledWith("/login?next=%2Fapp%2Flook");
    expect(b.api.sent("GET", "/api/presets")).toHaveLength(0);
  });

  it("works without a login on a local install", async () => {
    const { b } = await bootLook({ loggedIn: false });
    expect(b.api.sent("GET", "/api/auth/me")).toHaveLength(0);
    expect(byId<{ hidden: boolean }>("save").hidden).toBe(false);
    expect(($(".acct-btn") as unknown as { hidden: boolean }).hidden).toBe(true);
    // The login can't be checked: the page works as without one.
    const failing = await bootLook({
      setup: (b) => b.api.on("GET", "/api/auth/me", { status: 500 }),
    });
    expect(failing.b.api.sent("GET", "/api/auth/me")).toHaveLength(1);
    expect(byId<{ hidden: boolean }>("save").hidden).toBe(false);
    // A server that doesn't say its mode is treated as a local one.
    await bootLook({ setup: (b) => b.api.on("GET", "/api/auth/state", { status: 500 }) });
    expect(byId<{ hidden: boolean }>("use-local").hidden).toBe(false);
  });
});

describe("the full-window preview", () => {
  it("shows only the stage, at the window's size, and follows a resize", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    win.happyDOM.setViewport({ width: 1280, height: 720 });
    const { b } = await bootLook({
      url: "http://127.0.0.1:8765/app/look?view=preview&preset=glass&size=70&backdrop=dark&sample=events&to=ar",
    });
    expect(doc.body.classList.contains("is-preview-only")).toBe(true);
    expect(byId<{ hidden: boolean }>("preview-only").hidden).toBe(false);
    expect(doc.title).toBe("Preview · Glass");
    const shown = (): HTMLElement => $("#preview-only .pp-stage") as unknown as HTMLElement;
    expect(shown().style.getPropertyValue("width")).toBe("1280px");
    // 5vw of a 1280 px window.
    expect(shown().style.getPropertyValue("--cap-font-size")).toBe("min(70px, 64px)");
    expect($("#preview-only .pp-backdrop").classList.contains("pp-bd-dark")).toBe(true);
    expect(all("#preview-only .pp-blk-event").length).toBeGreaterThan(0);
    expect($("#preview-only .pp-blk").getAttribute("lang")).toBe("ar");
    // No editor around it, and no login question.
    expect($("#app-head").children).toHaveLength(0);
    expect(b.api.sent("GET", "/api/auth/state")).toHaveLength(0);
    win.happyDOM.setViewport({ width: 800, height: 450 });
    win.dispatchEvent(new win.Event("resize"));
    win.dispatchEvent(new win.Event("resize"));
    expect(shown().style.getPropertyValue("width")).toBe("1280px");
    vi.advanceTimersByTime(80);
    expect(shown().style.getPropertyValue("width")).toBe("800px");
  });

  it("names your own look, and samples in English without a caption language", async () => {
    await bootLook({
      url: "http://127.0.0.1:8765/app/look?view=preview&preset=hall",
      custom: [customPreset("hall", "Main hall")],
    });
    expect(doc.title).toBe("Preview · Main hall");
    expect($("#preview-only .pp-blk").getAttribute("lang")).toBe("en");
    await bootLook({ url: "http://127.0.0.1:8765/app/look?view=preview&preset=nope" });
    expect(doc.title).toBe("Preview · Mosque dark");
  });
});

describe("in Dutch and Arabic", () => {
  it("draws every control, look and caption again in Dutch", async () => {
    await bootLook({ custom: [customPreset("hall", "Main hall")] });
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    frame();
    expect(doc.title).toBe("Stijl · Turjuman");
    expect(all("#groups .grp-title")[0]?.textContent).toBe("Indeling en plaats");
    expect(all("#aspect .seg-btn").map((b) => b.textContent)).toEqual([
      "Scherm",
      "Onderste derde",
      "Telefoon",
    ]);
    expect(text("current-name")).toBe("Moskee donker");
    expect(card("Main hall").querySelector(".pcard-badge")?.textContent).toBe("Eigen");
    expect(text("use-lead")).toContain("Sla hem op als stijl");
    expect($(".cz-cap-long").textContent).toContain("getoond op");
    expect(themeQs()).toBe("");
  });

  it("is right to left in Arabic", async () => {
    await bootLook({ storage: { "tj-app-lang": "ar" } });
    expect(doc.documentElement.getAttribute("dir")).toBe("rtl");
    expect(doc.title).toBe("النمط · ترجمان");
  });
});
