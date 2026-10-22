// @vitest-environment happy-dom
// The builder's pace choice for caption blocks (web/picker.ts, the layout step): Calm (the
// default) or Live. Only blocks have it; the link carries pace=live only when it differs from the
// look, a screen keeps it in its query, and the words come in English, Dutch and Arabic.
import { afterEach, describe, expect, it } from "vitest";
import { $, all, closeBrowser, settle, win } from "./helpers/builder-dom.js";
import { boot, click, hidden, linkSoFar, next, radio } from "./helpers/builder-picker.js";

afterEach(() => closeBrowser());

/** The pace radio that is checked ("calm" / "live"), or null. */
function picked(): string | null {
  const on = all("input[name=pace]").find((r) => (r as unknown as HTMLInputElement).checked);
  return on === undefined ? null : ((on as unknown as HTMLInputElement).value ?? null);
}

const words = (): string[] =>
  all("#row-pace .sos-where-text").map((n) => n.textContent?.trim() ?? "");

describe("the pace of caption blocks", () => {
  it("is offered with blocks, calm by default, and only a live choice goes into the link", async () => {
    await boot();
    await next();
    expect(hidden("row-pace")).toBe(false);
    expect(($("#row-pace legend").textContent ?? "").trim()).toBe("Pace");
    expect(words()).toEqual([
      "CalmNew text every 6 to 20 seconds",
      "LiveText appears as it is said",
    ]);
    expect(picked()).toBe("calm");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    radio("pace", "live");
    expect(picked()).toBe("live");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?pace=live");
    expect(win.localStorage.getItem("captions.picker.pace")).toBe("live");
    radio("pace", "calm");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    expect(win.localStorage.getItem("captions.picker.pace")).toBe("calm");
  });

  it("is not there for rolling captions, and comes back with the choice made", async () => {
    await boot();
    await next();
    radio("pace", "live");
    radio("layout", "rollup");
    expect(hidden("row-pace")).toBe(true);
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?layout=rollup");
    radio("layout", "blocks");
    expect(hidden("row-pace")).toBe(false);
    expect(picked()).toBe("live");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?pace=live");
  });

  it("is remembered for the next visit, and forgotten on Start over", async () => {
    await boot({ storage: { "captions.picker.pace": "live", "captions.picker.from": "ar" } });
    await next();
    expect(picked()).toBe("live");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?pace=live");
    await next(4);
    click("start-over");
    await settle();
    await next();
    expect(picked()).toBe("calm");
    expect(win.localStorage.getItem("captions.picker.pace")).toBeNull();
  });

  it("follows a look that is live, and then says calm in the link", async () => {
    await boot({
      setup: (b) =>
        b.api.on("GET", "/api/presets", {
          body: {
            builtin: [],
            custom: [{ id: "hall", name: "Hall", vars: {}, options: { pace: "live" } }],
            default: "hall",
          },
        }),
    });
    await next();
    expect(picked()).toBe("live");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl");
    radio("pace", "calm");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?pace=calm");
  });

  it("speaks Dutch and Arabic", async () => {
    await boot({ storage: { "tj-app-lang": "nl" } });
    await next();
    expect(($("#row-pace legend").textContent ?? "").trim()).toBe("Tempo");
    expect(words()).toEqual([
      "RustigElke 6 tot 20 seconden nieuwe tekst",
      "LiveDe tekst verschijnt terwijl er gesproken wordt",
    ]);
    ($('.lang-btn[lang="ar"]') as unknown as { click(): void }).click();
    expect(($("#row-pace legend").textContent ?? "").trim()).toBe("الإيقاع");
    expect(words()).toEqual(["هادئنص جديد كل 6 إلى 20 ثانية", "مباشريظهر النص أثناء الكلام"]);
  });
});
