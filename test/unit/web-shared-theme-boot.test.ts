// @vitest-environment happy-dom
// Theme bootstrap of the caption views (web/shared/theme-boot.ts): custom presets and the
// server's default from /api/presets, the URL on top, the page colour around the panel in a
// browser, the reader's A−/A+ font scale, and the toolbar's visibility.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fontSizeVar } from "../../src/shared/theme.js";
import type { ThemePreset } from "../../src/shared/theme-vars.js";
import {
  applyFontScale,
  bootTheme,
  fetchPresets,
  fontScale,
  stepFontScale,
  themeNumber,
  toolbarVisible,
} from "../../web/shared/theme-boot.js";
import { fakeFetch, jsonResponse } from "./helpers/web-shared-fakes.js";

const q = (s: string) => new URLSearchParams(s);
const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

function preset(id: string, over: Partial<ThemePreset> = {}): ThemePreset {
  return {
    id,
    name: id,
    description: "",
    vars: {},
    options: { layout: "blocks", bg: "panel" },
    ...over,
  };
}

const HALL = preset("hall", { vars: { "--cap-panel-bg": "#123456" } });
const GLASS = preset("clear-panel", { vars: { "--cap-panel-bg": "rgba(0, 0, 0, 0)" } });
const STRIP = preset("strip", { options: { layout: "rollup", bg: "band" } });

function servePresets(custom: unknown[] = [HALL, GLASS, STRIP], def: unknown = null) {
  return fakeFetch(() => jsonResponse({ custom, default: def }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.doUnmock("../../src/shared/theme.js");
  Reflect.deleteProperty(window, "obsstudio");
});

describe("custom presets from the server", () => {
  it("asks /api/presets with the access key, admin token and screen only", async () => {
    const fetch = servePresets();
    const got = await fetchPresets(q("key=k1&token=t1&screen=g1&lang=nl&key2=x"));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/presets?key=k1&token=t1&screen=g1");
    expect(init?.headers).toEqual({ Accept: "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(got.custom.map((p) => p.id)).toEqual(["hall", "clear-panel", "strip"]);
    expect(got.defaultId).toBeNull();
  });

  it("asks without a query string when there is nothing to pass", async () => {
    const fetch = servePresets([], "hall");
    const got = await fetchPresets(q("key=&lang=nl"));
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/presets");
    expect(got).toEqual({ custom: [], defaultId: "hall" });
  });

  it("keeps only well-formed presets and a non-empty default", async () => {
    servePresets(
      [
        HALL,
        null,
        "x",
        { id: 1, name: "n", vars: {}, options: {} },
        { id: "a", name: 2, vars: {}, options: {} },
        { id: "a", name: "A", vars: null, options: {} },
        { id: "a", name: "A", vars: "x", options: {} },
        { id: "a", name: "A", vars: {}, options: null },
        { id: "a", name: "A", vars: {}, options: 1 },
      ],
      "",
    );
    const got = await fetchPresets(q(""));
    expect(got.custom.map((p) => p.id)).toEqual(["hall"]);
    expect(got.defaultId).toBeNull();
  });

  it("treats odd answers as no presets", async () => {
    fakeFetch(() => jsonResponse({ custom: "nope", default: 7 }));
    expect(await fetchPresets(q(""))).toEqual({ custom: [], defaultId: null });
    fakeFetch(() => jsonResponse(null));
    expect(await fetchPresets(q(""))).toEqual({ custom: [], defaultId: null });
    fakeFetch(() => jsonResponse("text"));
    expect(await fetchPresets(q(""))).toEqual({ custom: [], defaultId: null });
  });

  it("gives up on an HTTP error or a network failure", async () => {
    fakeFetch(() => jsonResponse({ error: "no" }, 500));
    expect(await fetchPresets(q(""))).toEqual({ custom: [], defaultId: null });
    fakeFetch(() => {
      throw new TypeError("offline");
    });
    expect(await fetchPresets(q(""))).toEqual({ custom: [], defaultId: null });
  });

  it("gives up after 1.5 s without an answer", async () => {
    vi.useFakeTimers();
    fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    let done = false;
    const pending = fetchPresets(q("")).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ custom: [], defaultId: null });
  });
});

describe("booting the theme", () => {
  it("applies the URL's preset and sets the page to the panel colour in a browser", async () => {
    servePresets();
    const t = await bootTheme(q("preset=hall"));
    expect(t.presetId).toBe("hall");
    expect(t.options.layout).toBe("blocks");
    expect(t.vars["--cap-page-bg"]).toBe("#123456");
    expect(rootVar("--cap-panel-bg")).toBe("#123456");
    expect(rootVar("--cap-page-bg")).toBe("#123456");
    expect(rootVar("--cap-font-size")).toBe(t.vars["--cap-font-size"]);
    expect(t.vars["--cap-font-size"]).toBe(fontSizeVar(t.options.size));
  });

  it("uses a dark page when the panel itself is clear", async () => {
    servePresets();
    const t = await bootTheme(q("preset=clear-panel"));
    expect(t.vars["--cap-page-bg"]).toBe("#0b0b0d");
    expect(rootVar("--cap-page-bg")).toBe("#0b0b0d");
  });

  it("keeps a page colour given in the URL", async () => {
    servePresets();
    const t = await bootTheme(q("preset=hall&PageBg=%23ff0000"));
    expect(t.vars["--cap-page-bg"]).toBe("#ff0000");
  });

  it("keeps the page transparent in OBS, without a panel, or when asked", async () => {
    servePresets();
    expect((await bootTheme(q("preset=hall"), { opaque: false })).vars["--cap-page-bg"]).toBe(
      "transparent",
    );
    Object.defineProperty(window, "obsstudio", { value: {}, configurable: true });
    expect((await bootTheme(q("preset=hall"))).vars["--cap-page-bg"]).toBe("transparent");
    Reflect.deleteProperty(window, "obsstudio");
    expect((await bootTheme(q("preset=hall&bg=none"))).vars["--cap-page-bg"]).toBe("transparent");
    // Forced opaque (e.g. a page that knows better) even in OBS.
    Object.defineProperty(window, "obsstudio", { value: {}, configurable: true });
    expect((await bootTheme(q("preset=hall"), { opaque: true })).vars["--cap-page-bg"]).toBe(
      "#123456",
    );
  });

  it("keeps a preset's own page colour", async () => {
    servePresets([preset("night", { vars: { "--cap-page-bg": "#060a17" } })]);
    const t = await bootTheme(q("preset=night"));
    expect(t.vars["--cap-page-bg"]).toBe("#060a17");
  });

  it("starts from the server's default preset when the URL names none", async () => {
    servePresets([HALL], "hall");
    expect((await bootTheme(q(""))).presetId).toBe("hall");
    servePresets([HALL], null);
    expect((await bootTheme(q(""))).presetId).toBe("mosque-dark");
  });

  it("starts a roll-up from the lower-third look, not from a blocks preset", async () => {
    servePresets([HALL], "hall");
    const t = await bootTheme(q("layout=rollup&size=40"));
    expect(t.presetId).toBe("lower-third");
    expect(t.options.layout).toBe("rollup");
    expect(t.options.size).toBe(40);
  });

  it("keeps the named preset under ?layout=rollup, and a roll-up preset as it is", async () => {
    servePresets();
    expect((await bootTheme(q("Preset=hall&layout=rollup"))).presetId).toBe("hall");
    servePresets([STRIP], "strip");
    const strip = await bootTheme(q("layout=rollup"));
    expect(strip.presetId).toBe("strip");
    expect(strip.options.layout).toBe("rollup");
  });

  it("applies the reader's font scale", async () => {
    servePresets();
    localStorage.setItem("captions.fontScale", "1.35");
    const t = await bootTheme(q("preset=hall&size=50"));
    expect(t.vars["--cap-font-size"]).toBe("min(50px, 5vw)");
    expect(rootVar("--cap-font-size")).toBe("calc(min(50px, 5vw) * 1.35)");
  });
});

describe("when the theme module fails", () => {
  async function brokenBoot() {
    vi.resetModules();
    vi.doMock("../../src/shared/theme.js", async (importOriginal) => {
      const real = await importOriginal<typeof import("../../src/shared/theme.js")>();
      return {
        ...real,
        resolveTheme: () => {
          throw new Error("broken presets");
        },
        applyTheme: () => {
          throw new Error("broken vars");
        },
      };
    });
    return import("../../web/shared/theme-boot.js");
  }

  it("still renders blocks with the fallback look and the URL's size", async () => {
    servePresets();
    const { bootTheme: boot } = await brokenBoot();
    const t = await boot(q("size=60"));
    expect(t.presetId).toBe("fallback");
    expect(t.options).toMatchObject({ layout: "blocks", bg: "panel", partial: false, size: 60 });
    expect(t.vars["--cap-font-size"]).toBe("60px");
    expect(t.vars["--cap-page-bg"]).toBe("#0b0b0d");
    expect(rootVar("--cap-font-size")).toBe("60px");
  });

  it("still renders a roll-up, and ignores a size out of range", async () => {
    servePresets();
    const { bootTheme: boot } = await brokenBoot();
    const t = await boot(q("layout=rollup&size=5"));
    expect(t.options).toMatchObject({ layout: "rollup", bg: "band", partial: true, size: 46 });
    expect(t.vars["--cap-page-bg"]).toBeUndefined();
    const big = await boot(q("size=301"));
    expect(big.options.size).toBe(46);
    const odd = await boot(q("size=abc"));
    expect(odd.options.size).toBe(46);
  });
});

describe("the reader's font scale", () => {
  it("reads a remembered scale between 0.5 and 2.5, else 1", () => {
    expect(fontScale()).toBe(1);
    localStorage.setItem("captions.fontScale", "1.2");
    expect(fontScale()).toBe(1.2);
    for (const bad of ["0.4", "2.6", "abc"]) {
      localStorage.setItem("captions.fontScale", bad);
      expect(fontScale(), bad).toBe(1);
    }
  });

  it("sets the base size at scale 1, else a calc() of it", () => {
    applyFontScale("46px", 1);
    expect(rootVar("--cap-font-size")).toBe("46px");
    applyFontScale("46px", 0.8);
    expect(rootVar("--cap-font-size")).toBe("calc(46px * 0.8)");
  });

  it("steps through the scale and remembers it", () => {
    expect(stepFontScale("46px", 1)).toBe(1.1);
    expect(localStorage.getItem("captions.fontScale")).toBe("1.1");
    expect(rootVar("--cap-font-size")).toBe("calc(46px * 1.1)");
    expect(stepFontScale("46px", -1)).toBe(1);
    expect(rootVar("--cap-font-size")).toBe("46px");
    expect(stepFontScale("46px", -1)).toBe(0.9);
  });

  it("stops at both ends", () => {
    localStorage.setItem("captions.fontScale", "2");
    expect(stepFontScale("46px", 1)).toBe(2);
    localStorage.setItem("captions.fontScale", "0.6");
    expect(stepFontScale("46px", -1)).toBe(0.6);
  });

  it("steps from a remembered value between two steps", () => {
    localStorage.setItem("captions.fontScale", "1.05");
    expect(stepFontScale("46px", 1)).toBe(1.2);
    localStorage.setItem("captions.fontScale", "1.05");
    expect(stepFontScale("46px", -1)).toBe(1);
    // Above the largest step (2.4 is allowed): down from the top.
    localStorage.setItem("captions.fontScale", "2.4");
    expect(stepFontScale("46px", -1)).toBe(1.7);
    localStorage.setItem("captions.fontScale", "2.4");
    expect(stepFontScale("46px", 1)).toBe(2);
  });
});

describe("theme numbers and the toolbar", () => {
  it("reads numeric theme variables", () => {
    expect(themeNumber({ "--cap-src-scale": "1.1" }, "--cap-src-scale")).toBe(1.1);
    expect(themeNumber({ "--cap-line-height": "1.3" }, "--cap-line-height")).toBe(1.3);
    expect(themeNumber({ "--cap-src-scale": "big" }, "--cap-src-scale")).toBeNull();
    expect(themeNumber({}, "--cap-src-scale")).toBeNull();
  });

  it("shows the toolbar: ?ui= first, then the theme, then not in OBS", () => {
    expect(toolbarVisible(q("ui=1"), "off", true)).toBe(true);
    expect(toolbarVisible(q("ui=%20TRUE"), "off", true)).toBe(true);
    expect(toolbarVisible(q("ui=0"), "on", false)).toBe(false);
    expect(toolbarVisible(q("ui=false"), "on", false)).toBe(false);
    expect(toolbarVisible(q("ui=maybe"), "on", true)).toBe(true);
    expect(toolbarVisible(q(""), "off", false)).toBe(false);
    expect(toolbarVisible(q(""), "auto", false)).toBe(true);
    expect(toolbarVisible(q(""), "auto", true)).toBe(false);
  });
});
