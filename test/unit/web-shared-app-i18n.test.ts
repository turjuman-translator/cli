// @vitest-environment happy-dom
// The app's words in the browser (web/shared/app-i18n.ts): which language a page starts in, the
// language switch (remembered, applied to <html>, announced), and dates and amounts in it. The
// dictionaries themselves are checked in app-i18n.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type I18n = typeof import("../../web/shared/app-i18n.js");

/** A fresh module: the current language is detected again on first use. */
async function fresh(): Promise<I18n> {
  vi.resetModules();
  return import("../../web/shared/app-i18n.js");
}

function browserLanguages(languages: readonly string[], language = languages[0] ?? ""): void {
  Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
  Object.defineProperty(navigator, "language", { value: language, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
  document.documentElement.dir = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "languages");
  Reflect.deleteProperty(navigator, "language");
});

describe("app i18n in the browser: the starting language", () => {
  it("takes the app's own remembered choice first", async () => {
    localStorage.setItem("tj-app-lang", "ar");
    localStorage.setItem("tj-lang", "nl");
    browserLanguages(["en-US"]);
    const i18n = await fresh();
    expect(i18n.lang()).toBe("ar");
    expect(i18n.t("nav.screens")).toBe("الشاشات");
  });

  it("then the website's choice, then the browser's languages", async () => {
    localStorage.setItem("tj-lang", "nl-BE");
    expect((await fresh()).lang()).toBe("nl");

    localStorage.clear();
    browserLanguages(["fr-FR", "nl-NL"]);
    expect((await fresh()).lang()).toBe("nl");
  });

  it("uses navigator.language when the browser lists no languages", async () => {
    browserLanguages([], "ar-EG");
    expect((await fresh()).lang()).toBe("ar");
  });

  it("falls back to English without any usable answer", async () => {
    browserLanguages([], "");
    expect((await fresh()).lang()).toBe("en");

    vi.stubGlobal("navigator", undefined);
    expect((await fresh()).lang()).toBe("en");
  });

  it("still starts when the storage throws (private mode, file://)", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    browserLanguages(["nl"]);
    const i18n = await fresh();
    expect(i18n.lang()).toBe("nl");
    // The switch works for this page even though it can't be remembered.
    i18n.setLang("ar");
    expect(i18n.lang()).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("keeps the language once detected", async () => {
    browserLanguages(["nl"]);
    const i18n = await fresh();
    expect(i18n.lang()).toBe("nl");
    localStorage.setItem("tj-app-lang", "ar");
    expect(i18n.lang()).toBe("nl");
  });
});

describe("app i18n in the browser: switching", () => {
  it("writes lang and dir on <html>", async () => {
    browserLanguages(["ar"]);
    const i18n = await fresh();
    i18n.applyDocumentLang();
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("does nothing on <html> where there is no document", async () => {
    const i18n = await fresh();
    vi.stubGlobal("document", undefined);
    expect(() => i18n.applyDocumentLang()).not.toThrow();
    vi.unstubAllGlobals();
    expect(document.documentElement.lang).toBe("");
  });

  it("remembers the choice, applies it and tells every listener", async () => {
    browserLanguages(["en"]);
    const i18n = await fresh();
    const heard: string[] = [];
    i18n.onLangChange((l) => heard.push(`a:${l}`));
    i18n.onLangChange((l) => heard.push(`b:${l}`));
    i18n.setLang("nl");
    expect(localStorage.getItem("tj-app-lang")).toBe("nl");
    expect(document.documentElement.lang).toBe("nl");
    expect(document.documentElement.dir).toBe("ltr");
    expect(heard).toEqual(["a:nl", "b:nl"]);
    expect(i18n.t("nav.screens")).toBe("Schermen");
    expect(i18n.t("account.menu", { name: "Aisha" })).toBe("Aisha, accountmenu");
    expect(i18n.tn("n.screens", 2)).toBe("2 schermen");
  });
});

describe("app i18n in the browser: dates and amounts", () => {
  const at = new Date(2026, 9, 9, 18, 42).getTime();
  const earlier = new Date(2026, 9, 2, 18, 42).getTime();

  it("shows only the time today, else the day too", async () => {
    browserLanguages(["en"]);
    const i18n = await fresh();
    expect(i18n.fmtWhen(at, at + 60_000)).toBe("18:42");
    expect(i18n.fmtWhen(earlier, at)).toBe("2 Oct, 18:42");
    i18n.setLang("nl");
    expect(i18n.fmtWhen(earlier, at)).toBe("2 okt, 18:42");
    i18n.setLang("ar");
    // Arabic month names with Latin digits.
    const ar = i18n.fmtWhen(earlier, at);
    expect(ar).toContain("2 أكتوبر");
    expect(ar).toContain("06:42");
  });

  it("compares with now when no reference time is given", async () => {
    browserLanguages(["en"]);
    const i18n = await fresh();
    expect(i18n.fmtWhen(Date.now())).toMatch(/^\d\d:\d\d$/);
  });

  it("writes dollars with cents below $10 and whole dollars above", async () => {
    browserLanguages(["en"]);
    const i18n = await fresh();
    expect(i18n.fmtUsd(1.25)).toBe("$1.25");
    expect(i18n.fmtUsd(12.4)).toBe("$12");
    expect(i18n.fmtUsd(1.25, "nl")).toBe("$\u00a01,25");
  });

  it("isolates the amount left to right on an Arabic page", async () => {
    browserLanguages(["ar"]);
    const i18n = await fresh();
    expect(i18n.fmtUsd(1.25)).toBe("\u2066$1.25\u2069");
  });

  it("falls back to a plain $ amount when Intl can't format", async () => {
    const i18n = await fresh();
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new RangeError("no currency data");
    });
    expect(i18n.fmtUsd(3.5, "en")).toBe("$3.50");
    expect(i18n.fmtUsd(3.5, "ar")).toBe("\u2066$3.50\u2069");
  });

  it("uses the 'other' form for a category a language leaves out", async () => {
    const i18n = await fresh();
    // Arabic "connected" has no zero form.
    expect(i18n.pluralForms("ar", "n.connected").zero).toBeUndefined();
    expect(i18n.plural("ar", "n.connected", 0)).toBe("متصلة بـ 0 شاشة");
  });

  it("names a message key that a language lacks", async () => {
    const i18n = await fresh();
    const keys = Object.keys;
    // The English key list gains a key no dictionary has (only for the first language checked).
    vi.spyOn(Object, "keys").mockImplementationOnce((o: object) => [...keys(o), "only.here"]);
    expect(i18n.missingKeys()).toEqual(["en:only.here"]);
  });

  it("counts one and other when Intl has no plural rules", async () => {
    const i18n = await fresh();
    vi.spyOn(Intl, "PluralRules").mockImplementation(() => {
      throw new RangeError("no plural data");
    });
    expect(i18n.plural("en", "n.screens", 1)).toBe("1 screen");
    expect(i18n.plural("en", "n.screens", 4)).toBe("4 screens");
    expect(i18n.plural("ar", "n.screens", 1)).toBe("شاشة واحدة");
    expect(i18n.plural("ar", "n.screens", 2)).toBe("2 شاشة");
  });
});
