// @vitest-environment happy-dom
// What the audience reads around the captions, in the target language: the caption labels
// (web/shared/i18n.ts), the status corner (status-corner.ts) and the toolbar (toolbar.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { el } from "../../web/shared/dom.js";
import { clockTime, eventLabel, uiLabels } from "../../web/shared/i18n.js";
import { StatusCorner } from "../../web/shared/status-corner.js";
import { Toolbar, type ToolbarOptions } from "../../web/shared/toolbar.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("caption labels", () => {
  it("speaks the target language, by its base tag", () => {
    expect(uiLabels("nl").live).toBe("Live vertaling");
    expect(uiLabels("nl-BE").newItems).toBe("nieuw");
    expect(uiLabels("ar").ended).toBe("انتهت الجلسة");
    expect(uiLabels("ur").off).toBe("بند");
    expect(uiLabels("de").fullscreen).toBe("Vollbild");
    expect(uiLabels("fr").listening).toBe("Écoute…");
    expect(uiLabels("tr").archive).toBe("Oturum arşivi");
    expect(uiLabels("es").connecting).toBe("Conectando…");
    expect(uiLabels("id").quran).toBe("Al-Qur'an");
  });

  it("falls back to English for other languages", () => {
    expect(uiLabels("sw")).toEqual(uiLabels("en"));
    expect(uiLabels("").live).toBe("Live translation");
  });

  it("falls back to English for codes that are names of object properties", () => {
    // /ar/constructor once titled the page "undefined · ar → constructor".
    expect(uiLabels("constructor")).toEqual(uiLabels("en"));
    expect(uiLabels("__proto__").live).toBe("Live translation");
    expect(eventLabel("athan", "constructor")).toEqual(eventLabel("athan", "en"));
    expect(eventLabel("iqama", "__proto__").title).toBe("Iqama");
  });

  it("has every label in every language", () => {
    const keys = Object.keys(uiLabels("en")).sort();
    for (const l of ["nl", "de", "fr", "tr", "es", "id", "ar", "ur"]) {
      const labels = uiLabels(l);
      expect(Object.keys(labels).sort(), l).toEqual(keys);
      for (const v of Object.values(labels)) expect(v.trim(), l).not.toBe("");
    }
  });

  it("names prayer events in Arabic plus the target language, English otherwise", () => {
    expect(eventLabel("athan", "nl")).toEqual({
      ar: "الأذان",
      title: "Athan",
      subtitle: "Oproep tot het gebed",
    });
    expect(eventLabel("iqama", "tr-TR")).toEqual({
      ar: "الإقامة",
      title: "Kamet",
      subtitle: "Namaz başlıyor",
    });
    expect(eventLabel("salah", "de")).toEqual({ ar: "الصلاة", title: "Gebet", subtitle: "" });
    expect(eventLabel("athan", "fr").title).toBe("Adhan");
    expect(eventLabel("iqama", "ar")).toEqual({
      ar: "الإقامة",
      title: "Iqama",
      subtitle: "The prayer begins",
    });
    expect(eventLabel("salah", "xx").title).toBe("Prayer");
  });

  it("writes a clock time in the language's convention", () => {
    const at = new Date(2026, 9, 9, 13, 2).getTime();
    expect(clockTime(at, "nl")).toBe("13:02");
    expect(clockTime(at, "en-GB")).toBe("13:02");
  });

  it("falls back to HH:MM when the language tag is not a valid locale", () => {
    const at = new Date(2026, 9, 9, 7, 5).getTime();
    expect(clockTime(at, "!!")).toBe("07:05");
  });
});

describe("status corner", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = el("div");
    document.body.append(host);
  });

  const dot = () => host.querySelector<HTMLElement>(".sdot");
  const bar = () => host.querySelector<HTMLElement>(".sbar");

  it("is one dot and a hidden sound bar, in the target language", () => {
    const c = new StatusCorner(host, "ar");
    expect(c.state).toBeNull();
    expect(host.querySelectorAll(".scorner > *")).toHaveLength(2);
    expect(dot()?.getAttribute("role")).toBe("status");
    expect(dot()?.lang).toBe("ar");
    expect(bar()?.hidden).toBe(true);
    expect(bar()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows its state as a colour and its meaning as text", () => {
    const c = new StatusCorner(host, "nl");
    c.set("off", "Live vertaling staat uit · Grote zaal");
    expect(c.state).toBe("off");
    expect(dot()?.className).toBe("sdot is-off");
    expect(dot()?.title).toBe("Live vertaling staat uit · Grote zaal");
    expect(dot()?.querySelector(".sdot-text")?.textContent).toBe(
      "Live vertaling staat uit · Grote zaal",
    );
    c.set("on", "Live vertaling");
    expect(dot()?.className).toBe("sdot is-on");
    c.set("wait", "Verbinden…");
    expect(dot()?.className).toBe("sdot is-wait");
    expect(dot()?.title).toBe("Verbinden…");
    c.set("lost", "Can't reach the caption server");
    expect(dot()?.className).toBe("sdot is-lost");
  });

  it("does not rewrite the same state", () => {
    const c = new StatusCorner(host, "en");
    c.set("on", "Live translation");
    const node = dot()?.querySelector(".sdot-text")?.firstChild;
    c.set("on", "Live translation");
    expect(dot()?.querySelector(".sdot-text")?.firstChild).toBe(node);
  });

  it("fills the sound bar in its colour, within 0 to 100 %, and hides it without a microphone", () => {
    const c = new StatusCorner(host, "en");
    const fill = () => host.querySelector<HTMLElement>(".sbar-fill")?.style.width;
    c.sound(72.4, "good");
    expect(bar()?.hidden).toBe(false);
    expect(bar()?.className).toBe("sbar is-good");
    expect(fill()).toBe("72%");
    c.sound(30, "soft");
    expect(bar()?.className).toBe("sbar is-soft");
    c.sound(-20, "low");
    expect(bar()?.className).toBe("sbar is-low");
    expect(fill()).toBe("0%");
    c.sound(140, "good");
    expect(fill()).toBe("100%");
    c.sound(null, "low");
    expect(bar()?.hidden).toBe(true);
    expect(bar()?.className).toBe("sbar is-good");
  });
});
describe("toolbar", () => {
  function options(over: Partial<ToolbarOptions> = {}): ToolbarOptions {
    return {
      targetLang: "nl",
      showSource: false,
      quranArabic: true,
      onFontStep: vi.fn(),
      onShowSource: vi.fn(),
      onQuranArabic: vi.fn(),
      ...over,
    };
  }

  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".tb-btn")];
  const byText = (t: string) => buttons().find((b) => b.textContent === t);

  function setFullscreen(enabled: boolean, element: Element | null): void {
    Object.defineProperty(document, "fullscreenEnabled", { value: enabled, configurable: true });
    Object.defineProperty(document, "fullscreenElement", { value: element, configurable: true });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "fullscreenEnabled");
    Reflect.deleteProperty(document, "fullscreenElement");
    Reflect.deleteProperty(document, "exitFullscreen");
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
  });

  it("shows the live label, the language chip and labelled buttons in the target language", () => {
    const tb = new Toolbar(document.body, options({ targetLang: "nl-be-extra" }));
    expect(tb.root.getAttribute("role")).toBe("toolbar");
    expect(tb.root.querySelector(".tb-label")?.textContent).toBe("Live vertaling");
    expect(tb.root.querySelector(".tb-chip")?.textContent).toBe("NL-BE");
    expect(byText("A−")?.title).toBe("Kleinere tekst");
    expect(byText("A+")?.getAttribute("aria-label")).toBe("Grotere tekst");
    expect(byText("Bron")?.getAttribute("aria-pressed")).toBe("false");
    expect(byText("Koran")?.getAttribute("aria-pressed")).toBe("true");
    expect(tb.root.querySelector(".tb-meter")).toBeNull();
  });

  it("takes another label (the archive)", () => {
    const tb = new Toolbar(document.body, options({ targetLang: "en", label: "Session archive" }));
    expect(tb.root.querySelector(".tb-label")?.textContent).toBe("Session archive");
  });

  it("steps the font size", () => {
    const o = options();
    new Toolbar(document.body, o);
    byText("A−")?.click();
    byText("A+")?.click();
    expect(o.onFontStep).toHaveBeenNthCalledWith(1, -1);
    expect(o.onFontStep).toHaveBeenNthCalledWith(2, 1);
  });

  it("toggles the source text and the Quran Arabic", () => {
    const o = options({ showSource: true, quranArabic: false });
    new Toolbar(document.body, o);
    const source = byText("Bron");
    const quran = byText("Koran");
    source?.click();
    expect(source?.getAttribute("aria-pressed")).toBe("false");
    expect(o.onShowSource).toHaveBeenLastCalledWith(false);
    source?.click();
    expect(source?.getAttribute("aria-pressed")).toBe("true");
    expect(o.onShowSource).toHaveBeenLastCalledWith(true);
    quran?.click();
    expect(quran?.getAttribute("aria-pressed")).toBe("true");
    expect(o.onQuranArabic).toHaveBeenLastCalledWith(true);
  });

  it("hides the source toggle when asked (show=source pages)", () => {
    new Toolbar(document.body, options({ sourceToggle: false }));
    expect(byText("Bron")?.hidden).toBe(true);
    document.body.replaceChildren();
    new Toolbar(document.body, options({ sourceToggle: true }));
    expect(byText("Bron")?.hidden).toBe(false);
  });

  it("hides fullscreen where the browser has none", () => {
    setFullscreen(false, null);
    new Toolbar(document.body, options());
    expect(byText("⛶")?.hidden).toBe(true);
  });

  it("enters fullscreen, and leaves it when already there", async () => {
    setFullscreen(true, null);
    const request = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: request,
      configurable: true,
    });
    const exit = vi.fn(() => Promise.reject(new Error("not allowed")));
    Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
    new Toolbar(document.body, options());
    const full = byText("⛶");
    expect(full?.hidden).toBe(false);
    expect(full?.title).toBe("Volledig scherm");
    full?.click();
    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    setFullscreen(true, document.body);
    full?.click();
    expect(exit).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("does nothing on a browser without requestFullscreen", () => {
    setFullscreen(true, null);
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: undefined,
      configurable: true,
    });
    new Toolbar(document.body, options());
    expect(() => byText("⛶")?.click()).not.toThrow();
  });

  it("shows the connection state with a title", () => {
    const tb = new Toolbar(document.body, options());
    const dot = tb.root.querySelector<HTMLElement>(".tb-dot");
    expect(dot?.className).toBe("tb-dot s-connecting");
    tb.setState("error", "Server problem", "Can't reach the caption server");
    expect(dot?.className).toBe("tb-dot s-error");
    expect(dot?.title).toBe("Can't reach the caption server");
    expect(tb.root.querySelector(".tb-state")?.textContent).toBe("Server problem");
    tb.setState("live", "");
    expect(dot?.className).toBe("tb-dot s-live");
    expect(dot?.title).toBe("");
    expect(tb.root.querySelector(".tb-state")?.textContent).toBe("");
    tb.setState("live", "");
    expect(dot?.className).toBe("tb-dot s-live");
  });

  it("shows the microphone level from −60 to 0 dBFS, green while speaking", () => {
    const tb = new Toolbar(document.body, options({ meter: true }));
    const level = tb.root.querySelector<HTMLElement>(".tb-level");
    expect(tb.root.querySelector(".tb-meter")?.getAttribute("title")).toBe("Microphone");
    tb.setLevel(-30, true);
    expect(level?.style.width).toBe("50%");
    expect(level?.style.background).toContain("#34d17a");
    tb.setLevel(-100, false);
    expect(level?.style.width).toBe("0%");
    expect(level?.style.background).toContain("#4fa3ff");
    tb.setLevel(6, false);
    expect(level?.style.width).toBe("100%");
  });

  it("ignores levels without a meter", () => {
    const tb = new Toolbar(document.body, options());
    expect(() => tb.setLevel(-10, true)).not.toThrow();
    expect(tb.root.querySelector(".tb-level")).toBeNull();
  });
});
