// The app's own words (web/shared/app-i18n.ts): the language choice, plurals, and that every
// message exists in English, Dutch and Arabic with the same placeholders.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOX_SHADOWS, BUILTIN_PRESETS, TEXT_SHADOWS } from "../../src/shared/theme.js";
import {
  APP_LANGS,
  chooseLang,
  dirOf,
  fill,
  isMsgKey,
  localeOf,
  message,
  missingKeys,
  msgKeys,
  normalizeLang,
  plural,
  pluralForms,
  pluralKeys,
} from "../../web/shared/app-i18n.js";

const WEB = join(import.meta.dirname, "..", "..", "web");

/** "{name}" placeholders of a text, sorted. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
}

describe("app i18n: choosing the language", () => {
  it("normalises tags and refuses other languages", () => {
    expect(normalizeLang("nl-BE")).toBe("nl");
    expect(normalizeLang(" AR ")).toBe("ar");
    expect(normalizeLang("en_GB")).toBe("en");
    expect(normalizeLang("fr")).toBeNull();
    expect(normalizeLang("")).toBeNull();
    expect(normalizeLang(null)).toBeNull();
  });

  it("takes the app's choice, then the website's, then the browser's, then English", () => {
    expect(chooseLang({ app: "ar", site: "nl", browser: ["en-US"] })).toBe("ar");
    expect(chooseLang({ app: null, site: "nl", browser: ["ar"] })).toBe("nl");
    expect(chooseLang({ app: "xx", site: "de", browser: ["fr-FR", "nl-NL", "ar"] })).toBe("nl");
    expect(chooseLang({ browser: ["de-DE", "fr"] })).toBe("en");
    expect(chooseLang({})).toBe("en");
  });

  it("writes Arabic right to left with Latin digits", () => {
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
    expect(dirOf("nl")).toBe("ltr");
    expect(localeOf("ar")).toBe("ar-u-nu-latn");
  });
});

describe("app i18n: the dictionaries", () => {
  it("has every key filled in all three languages", () => {
    expect(missingKeys()).toEqual([]);
    expect(msgKeys().length).toBeGreaterThan(400);
  });

  it("keeps the same placeholders in every language", () => {
    const wrong: string[] = [];
    for (const key of msgKeys()) {
      const want = placeholders(message("en", key));
      for (const l of APP_LANGS) {
        if (JSON.stringify(placeholders(message(l, key))) !== JSON.stringify(want)) {
          wrong.push(`${l}:${key}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("fills placeholders and leaves unknown ones as they are", () => {
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    expect(message("en", "toast.saved", { name: "Hall" })).toBe("Saved · Hall");
    expect(message("ar", "toast.saved", { name: "القاعة" })).toContain("القاعة");
  });

  it("knows every data-i18n key used in the app's page templates", () => {
    const unknown: string[] = [];
    for (const file of readdirSync(WEB).filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(join(WEB, file), "utf8");
      for (const m of html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) {
        const key = m[1] ?? "";
        if (!isMsgKey(key)) unknown.push(`${file}: ${key}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("names and describes every built-in look, and every shadow choice", () => {
    for (const p of BUILTIN_PRESETS) {
      expect(isMsgKey(`preset.${p.id}`), p.id).toBe(true);
      expect(isMsgKey(`presetDesc.${p.id}`), p.id).toBe(true);
    }
    for (const k of [...Object.keys(BOX_SHADOWS), ...Object.keys(TEXT_SHADOWS)]) {
      expect(isMsgKey(`lk.sh.${k}`), k).toBe(true);
    }
  });
});

describe("app i18n: one word per thing (the glossary)", () => {
  /** Words the app never shows, per language (preset ids and {placeholders} are left out). */
  const NEVER: Readonly<Record<(typeof APP_LANGS)[number], RegExp>> = {
    en: /\b(themes?|presets?|feeds?|sign(ed)?[ -]in)\b/i,
    nl: /\b(thema'?s?|presets?|feeds?)\b|(^|[^r])weergave/i,
    ar: /السمة|سمات|سمتك|المعرّف/,
  };

  it("says look, screen link and log in, never theme, preset, feed or sign in", () => {
    const wrong: string[] = [];
    for (const l of APP_LANGS) {
      for (const key of msgKeys()) {
        if (key.startsWith("preset.") || key.startsWith("presetDesc.")) continue;
        const text = message(l, key)
          .replace(/\{\w+\}/g, "")
          .replace(/\/feed\/…/g, "");
        if (NEVER[l].test(text)) wrong.push(`${l}:${key}: ${text}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names the builder step and the menu item after the look", () => {
    expect(message("en", "step.theme")).toBe("Look");
    expect(message("nl", "step.theme")).toBe("Stijl");
    expect(message("ar", "step.theme")).toBe("النمط");
    expect(message("nl", "menu.changeLook")).toBe("Stijl wijzigen");
    expect(message("en", "account.signedInAs", { who: "a", role: "b" })).toBe("Logged in as a · b");
  });
});

describe("app i18n: counted messages", () => {
  it("has an 'other' form and the same placeholders in every language", () => {
    for (const key of pluralKeys()) {
      const want = placeholders(pluralForms("en", key).other);
      for (const l of APP_LANGS) {
        const forms = pluralForms(l, key);
        expect(forms.other, `${l}:${key}`).toBeTruthy();
        for (const text of Object.values(forms)) {
          // A form may leave the number out ("one screen"), never add another placeholder.
          for (const p of placeholders(text ?? "")) expect(want, `${l}:${key}`).toContain(p);
        }
      }
    }
  });

  it("picks English and Dutch singular and plural", () => {
    expect(plural("en", "n.screens", 1)).toBe("1 screen");
    expect(plural("en", "n.screens", 3)).toBe("3 screens");
    expect(plural("en", "n.screens", 0)).toBe("0 screens");
    expect(plural("nl", "n.minutes", 1)).toBe("1 minuut");
    expect(plural("nl", "n.minutes", 12)).toBe("12 minuten");
    expect(plural("en", "n.changes", 2)).toBe("2 changes");
  });

  it("picks the six Arabic forms", () => {
    expect(plural("ar", "n.screens", 0)).toBe("لا شاشات");
    expect(plural("ar", "n.screens", 1)).toBe("شاشة واحدة");
    expect(plural("ar", "n.screens", 2)).toBe("شاشتان");
    expect(plural("ar", "n.screens", 3)).toBe("3 شاشات");
    expect(plural("ar", "n.screens", 11)).toBe("11 شاشة");
    expect(plural("ar", "n.screens", 100)).toBe("100 شاشة");
    expect(plural("ar", "n.changes", 2)).toBe("تغييران");
  });
});
