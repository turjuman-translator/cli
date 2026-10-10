// @vitest-environment happy-dom
// applyTheme / clearTheme on a real element: the theme reaches the page only through the CSSOM.
import type { Document } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  clearTheme,
  DEFAULT_VARS,
  resolveTheme,
  type ThemeVars,
} from "../../src/shared/theme.js";
import { THEME_VARS } from "../../src/shared/theme-vars.js";

// The environment's page, typed by happy-dom itself (the root tsconfig has no DOM lib).
declare const document: Document;

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("applyTheme", () => {
  it("sets every variable of a resolved theme on the element", () => {
    const root = document.documentElement;
    const t = resolveTheme(new URLSearchParams("preset=glass&fg=ffcc00&size=60"));
    applyTheme(root, t.vars);
    for (const name of THEME_VARS)
      expect(root.style.getPropertyValue(name), name).toBe(t.vars[name]);
    expect(root.style.getPropertyValue("--cap-text-color")).toBe("#ffcc00");
    expect(root.style.getPropertyValue("--cap-font-size")).toBe("min(60px, 5vw)");
  });

  it("re-validates the values: canonical forms are set, invalid ones skipped", () => {
    const el = document.createElement("div");
    el.style.setProperty("--cap-block-bg", "#123456");
    applyTheme(el, {
      "--cap-text-color": "FFF",
      "--cap-block-radius": "16",
      "--cap-block-bg": "red; background-image: url(https://evil.example/x.png)",
      "--cap-panel-bg": undefined,
    });
    expect(el.style.getPropertyValue("--cap-text-color")).toBe("#ffffff");
    expect(el.style.getPropertyValue("--cap-block-radius")).toBe("16px");
    // The invalid value leaves what was there before.
    expect(el.style.getPropertyValue("--cap-block-bg")).toBe("#123456");
    expect(el.style.getPropertyValue("--cap-panel-bg")).toBe("");
  });

  it("ignores names that are not theme variables", () => {
    const el = document.createElement("div");
    const extra: Record<string, string> = { color: "red", "--cap-hadith-accent": "#4a90d9" };
    const vars: ThemeVars = extra;
    applyTheme(el, vars);
    expect(el.style.getPropertyValue("color")).toBe("");
    expect(el.style.getPropertyValue("--cap-hadith-accent")).toBe("");
  });
});

describe("clearTheme", () => {
  it("removes every theme variable and nothing else", () => {
    const el = document.createElement("div");
    el.style.setProperty("color", "red");
    el.style.setProperty("--other", "1");
    applyTheme(el, DEFAULT_VARS);
    expect(el.style.getPropertyValue("--cap-panel-bg")).toBe(DEFAULT_VARS["--cap-panel-bg"]);
    clearTheme(el);
    for (const name of THEME_VARS) expect(el.style.getPropertyValue(name), name).toBe("");
    expect(el.style.getPropertyValue("color")).toBe("red");
    expect(el.style.getPropertyValue("--other")).toBe("1");
  });
});
