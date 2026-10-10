import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedConfig } from "../../src/config.js";
import {
  type EngineRequest,
  EngineUnavailableError,
  SessionError,
} from "../../src/core/contracts.js";
import { parseGlossary } from "../../src/glossary.js";
import { parseLanguages } from "../../src/languages.js";
import type { ProviderEvent } from "../../src/stt/types.js";
import { KEYS, NO_KEYS, testConfig } from "./helpers/core-fakes.js";

// The real SonioxProvider opens a WebSocket on start(); these tests only check what it is built
// with, so it is replaced by a recorder of its options.
const built = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("../../src/stt/soniox.js", () => ({
  SonioxProvider: class {
    readonly capabilities = {
      nativeTranslation: true,
      timing: "provider",
      translationFinalAtEndpoint: true,
    };
    constructor(readonly options: unknown) {
      built.options.push(options);
    }
  },
}));

const { createEngineFactory } = await import("../../src/core/engines.js");
const { FakeProvider } = await import("../../src/stt/fake.js");

const FIXTURE = join(process.cwd(), "test", "fixtures", "soniox-tts-1.jsonl");

const languages = parseLanguages(`
languages:
  ar: { en: Arabic, native: العربية, soniox: ar }
  nl: { en: Dutch, native: Nederlands, soniox: nl }
  fil: { en: Filipino, native: Filipino, soniox: tl }
  xx: { en: Unmapped, native: Unmapped }
`);

const request = (over: Partial<EngineRequest> = {}): EngineRequest => ({
  track: "soniox",
  sessionId: "sess1",
  from: "ar",
  to: "nl",
  glossary: null,
  recordFile: null,
  ...over,
});

function factory(loaded: LoadedConfig, extra: Record<string, unknown> = {}) {
  return createEngineFactory({ loaded, log: pino({ level: "silent" }), languages, ...extra });
}

afterEach(() => {
  built.options.length = 0;
});

describe("createEngineFactory (Soniox)", () => {
  it("builds a Soniox provider from the config and the request", () => {
    const make = factory(testConfig("/data", { stt: { soniox: { region: "eu", model: "m1" } } }));
    const { provider } = make(request({ recordFile: "/data/p.jsonl" }));
    expect(provider.capabilities.nativeTranslation).toBe(true);
    expect(built.options).toHaveLength(1);
    expect(built.options[0]).toMatchObject({
      apiKey: KEYS.sonioxApiKey,
      region: "eu",
      model: "m1",
      from: "ar",
      targetLanguage: "nl",
      context: null,
      endpointDetection: true,
      maxEndpointDelayMs: null,
      endpointLatencyLevel: null,
      endpointSensitivity: null,
      pauseFinalizeMs: null,
      recordFile: "/data/p.jsonl",
      translationFinalAtEndpoint: true,
    });
  });

  it("gives fast blocks the measured endpoint defaults unless the config sets its own", () => {
    const make = factory(testConfig("/data"));
    make(request({ fastBlocks: true }));
    expect(built.options[0]).toMatchObject({
      maxEndpointDelayMs: 1200,
      endpointLatencyLevel: 1,
      endpointSensitivity: 0,
    });
    const tuned = factory(
      testConfig("/data", {
        stt: {
          soniox: {
            maxEndpointDelayMs: 900,
            endpointLatencyLevel: 2,
            endpointSensitivity: 0.5,
            pauseFinalizeMs: 700,
          },
        },
      }),
    );
    tuned(request({ fastBlocks: true }));
    expect(built.options[1]).toMatchObject({
      maxEndpointDelayMs: 900,
      endpointLatencyLevel: 2,
      endpointSensitivity: 0.5,
      pauseFinalizeMs: 700,
    });
  });

  it("maps language codes to Soniox codes and keeps 'auto' and unmapped codes", () => {
    const make = factory(testConfig("/data"));
    make(request({ from: "fil", to: "fil" }));
    make(request({ from: "auto", to: "xx" }));
    make(request({ from: "xx", to: "nl" }));
    expect(built.options[0]).toMatchObject({ from: "tl", targetLanguage: "tl" });
    expect(built.options[1]).toMatchObject({ from: "auto", targetLanguage: "xx" });
    expect(built.options[2]).toMatchObject({ from: "xx", targetLanguage: "nl" });
  });

  it("passes the glossary as Soniox context, and no context for an empty glossary", () => {
    const make = factory(testConfig("/data"));
    const { glossary } = parseGlossary(
      {
        context: "Vrijdagpreek",
        terms: ["التقوى"],
        translation_terms: [{ source: "الله", target: "Allah" }],
      },
      "ar-nl.yaml",
    );
    make(request({ glossary }));
    expect(built.options[0]).toMatchObject({
      context: {
        text: "Vrijdagpreek",
        terms: ["التقوى"],
        translation_terms: [{ source: "الله", target: "Allah" }],
      },
    });
    make(request({ glossary: parseGlossary({}, "empty.yaml").glossary }));
    expect(built.options[1]).toMatchObject({ context: null });
  });

  it("uses the organisation's key from the request over the server's", () => {
    const make = factory(testConfig("/data", {}, NO_KEYS));
    make(request({ secrets: { sonioxApiKey: "org-key" } }));
    expect(built.options[0]).toMatchObject({ apiKey: "org-key" });
  });

  it("refuses without a key, in the words of the mode", () => {
    const local = factory(testConfig("/data", {}, NO_KEYS));
    expect(() => local(request())).toThrow(new EngineUnavailableError("SONIOX_API_KEY is not set"));
    const hosted = factory(testConfig("/data", { mode: "hosted" }, KEYS));
    const err = (() => {
      try {
        hosted(request({ secrets: { sonioxApiKey: null } }));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).name).toBe("EngineUnavailableError");
    expect((err as Error).message).toBe(
      "This mosque has no Soniox key: add it in the app under Keys",
    );
    expect(built.options).toHaveLength(0);
  });
});

describe("createEngineFactory (fake provider)", () => {
  it("replays a provider.jsonl instead of calling Soniox, at the first audio by default", async () => {
    const make = factory(testConfig("/data", {}, NO_KEYS), { fakeProviderFile: FIXTURE });
    const { provider } = make(request());
    expect(provider).toBeInstanceOf(FakeProvider);
    expect(built.options).toHaveLength(0);
    // The recording asked Soniox for a translation, so the replay translates natively.
    expect(provider.capabilities).toEqual({
      nativeTranslation: true,
      timing: "provider",
      translationFinalAtEndpoint: false,
    });
    const events: ProviderEvent[] = [];
    await provider.start({ sessionId: "sess1", onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === "tokens")).toHaveLength(0);
    await provider.stop();
  });

  it("honours the replay speed and start options", async () => {
    const make = factory(testConfig("/data"), {
      fakeProviderFile: FIXTURE,
      fakeSpeed: Number.POSITIVE_INFINITY,
      fakeLoop: false,
      fakeStartOnFirstAudio: false,
    });
    const { provider } = make(request());
    const events: ProviderEvent[] = [];
    await provider.start({ sessionId: "sess1", onEvent: (e) => events.push(e) });
    // Infinite speed replays the whole recording inside start().
    expect(events.filter((e) => e.type === "tokens").length).toBeGreaterThan(5);
    expect(events.some((e) => e.type === "endpoint")).toBe(true);
    await provider.stop();
  });
});

describe("contract errors", () => {
  it("carry their name and, for sessions, the page error code", () => {
    const err = new SessionError("engine_unavailable", "the server is shutting down");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionError");
    expect(err.code).toBe("engine_unavailable");
    expect(err.message).toBe("the server is shutting down");
  });
});
