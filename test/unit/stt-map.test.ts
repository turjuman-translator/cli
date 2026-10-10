import { describe, expect, it } from "vitest";
import {
  EndpointDeduper,
  mapSonioxMessage,
  mapSonioxToken,
  sessionStartsWithReconnect,
  sonioxErrorEvent,
  sonioxReplayMapper,
} from "../../src/stt/soniox-map.js";
import { SonioxPauseDetector } from "../../src/stt/soniox-pause.js";
import { parseSonioxResponse, type SonioxResponse } from "../../src/stt/soniox-protocol.js";
import type { ProviderEvent, RecordingLine } from "../../src/stt/types.js";

type Meta = Extract<RecordingLine, { kind: "meta" }>;
type Entry = Exclude<RecordingLine, { kind: "meta" }>;

function frame(raw: unknown): SonioxResponse {
  const parsed = parseSonioxResponse(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.msg;
}

const tok = (text: string, is_final: boolean, extra: Record<string, unknown> = {}) => ({
  text,
  is_final,
  ...extra,
});

describe("mapSonioxToken", () => {
  it("maps spoken words to source tokens with language and session ms", () => {
    expect(
      mapSonioxToken({ text: " قال", language: "ar", start_ms: 120, end_ms: 380 }, "nl"),
    ).toEqual([{ text: " قال", kind: "source", lang: "ar", startMs: 120, endMs: 380 }]);
    expect(
      mapSonioxToken({ text: " قال", translation_status: "original", language: null }, "nl"),
    ).toEqual([{ text: " قال", kind: "source" }]);
  });

  it("maps translation tokens with their language when Soniox gives one", () => {
    expect(
      mapSonioxToken({ text: " zei", translation_status: "translation", language: "nl" }, "nl"),
    ).toEqual([{ text: " zei", kind: "translation", lang: "nl" }]);
  });

  it("mirrors untranslated words already in the target language into the translation", () => {
    expect(
      mapSonioxToken(
        { text: " Allah", translation_status: "none", language: "nl", start_ms: 0, end_ms: 50 },
        "nl",
      ),
    ).toEqual([
      { text: " Allah", kind: "source", lang: "nl", startMs: 0, endMs: 50 },
      { text: " Allah", kind: "translation", lang: "nl" },
    ]);
    // Not the target language, or no translation at all: only the spoken word.
    expect(
      mapSonioxToken({ text: " Allah", translation_status: "none", language: "en" }, "nl"),
    ).toHaveLength(1);
    expect(
      mapSonioxToken({ text: " Allah", translation_status: "none", language: "nl" }, null),
    ).toHaveLength(1);
  });
});

describe("mapSonioxMessage", () => {
  const opts = { targetLanguage: "nl", receivedAt: 5000 };

  it("splits a frame into runs at its endpoint markers", () => {
    const events = mapSonioxMessage(
      frame({
        tokens: [
          tok(" الحمد", true, { language: "ar" }),
          tok(" Lof", true, { translation_status: "translation" }),
          tok("<end>", true),
          tok(" لله", false, { language: "ar" }),
        ],
      }),
      opts,
    );
    expect(events).toEqual([
      {
        type: "tokens",
        final: [
          { text: " الحمد", kind: "source", lang: "ar" },
          { text: " Lof", kind: "translation" },
        ],
        nonFinal: [],
        receivedAt: 5000,
      },
      { type: "endpoint", receivedAt: 5000 },
      {
        type: "tokens",
        final: [],
        nonFinal: [{ text: " لله", kind: "source", lang: "ar" }],
        receivedAt: 5000,
      },
    ]);
  });

  it("ends with the marker when nothing follows it, and drops a non-final marker", () => {
    const events = mapSonioxMessage(
      frame({ tokens: [tok("<fin>", false), tok(" أكبر", true), tok("<fin>", true)] }),
      opts,
    );
    expect(events.map((e) => e.type)).toEqual(["tokens", "endpoint"]);
  });

  it("turns an empty frame into one empty tokens event (it clears the non-final words)", () => {
    expect(mapSonioxMessage(frame({ tokens: [] }), opts)).toEqual([
      { type: "tokens", final: [], nonFinal: [], receivedAt: 5000 },
    ]);
  });
});

describe("EndpointDeduper", () => {
  const tokens = (final: number): ProviderEvent => ({
    type: "tokens",
    final: Array.from({ length: final }, () => ({ text: " x", kind: "source" as const })),
    nonFinal: [],
    receivedAt: 0,
  });
  const endpoint: ProviderEvent = { type: "endpoint", receivedAt: 0 };

  it("drops the second marker of a finalize (<fin> and <end> for the same words)", () => {
    const d = new EndpointDeduper();
    expect(d.apply([endpoint]).map((e) => e.type)).toEqual([]);
    expect(d.apply([tokens(1), endpoint, tokens(0), endpoint]).map((e) => e.type)).toEqual([
      "tokens",
      "endpoint",
      "tokens",
    ]);
    const state: ProviderEvent = { type: "state", state: "live" };
    expect(d.apply([state, tokens(2)])).toHaveLength(2);
    d.reset();
    expect(d.apply([endpoint])).toEqual([]);
  });
});

describe("sessionStartsWithReconnect", () => {
  it("is true for every session after the first, or one that starts later in the audio", () => {
    expect(sessionStartsWithReconnect(0, 0)).toBe(false);
    expect(sessionStartsWithReconnect(0, 300)).toBe(true);
    expect(sessionStartsWithReconnect(2, 0)).toBe(true);
  });
});

describe("sonioxErrorEvent", () => {
  it("is a warning while the provider retries with less context", () => {
    expect(
      sonioxErrorEvent(
        { code: 400, type: "invalid_request", message: "context too long" },
        "retrying without translation_terms",
      ),
    ).toEqual({
      type: "error",
      fatal: false,
      message:
        "Soniox error 400 invalid_request: context too long (retrying without translation_terms)",
    });
  });

  it("is fatal for auth errors and not for server trouble", () => {
    expect(sonioxErrorEvent({ code: 401, type: null, message: null }, null).fatal).toBe(true);
    expect(sonioxErrorEvent({ code: 503, type: null, message: "busy" }, null)).toEqual({
      type: "error",
      fatal: false,
      message: "Soniox error 503: busy",
    });
  });
});

describe("sonioxReplayMapper", () => {
  const meta = (config: unknown): Meta => ({
    kind: "meta",
    provider: "soniox",
    version: 1,
    startedAt: 0,
    config,
  });
  const msg = (data: unknown, t = 0): Entry => ({ t, kind: "msg", session: 0, data });

  it("replays tokens with mirrored target-language words and deduplicated endpoints", () => {
    const m = sonioxReplayMapper(meta({ translation: { target_language: "nl" } }));
    expect(m.onLine({ t: 0, kind: "session", index: 0, audioOffsetMs: 0 })).toEqual([]);
    const first = m.onLine(
      msg({
        tokens: [
          tok(" Allah", true, { translation_status: "none", language: "nl" }),
          tok("<fin>", true),
        ],
      }),
    );
    expect(first.map((e) => e.type)).toEqual(["tokens", "endpoint"]);
    expect(first[0]?.type === "tokens" && first[0].final).toEqual([
      { text: " Allah", kind: "source", lang: "nl" },
      { text: " Allah", kind: "translation", lang: "nl" },
    ]);
    // Soniox's <end> for the same words: dropped.
    expect(m.onLine(msg({ tokens: [tok("<end>", true)] })).map((e) => e.type)).toEqual(["tokens"]);
  });

  it("turns later sessions into reconnects and ignores close, switch and invalid lines", () => {
    const m = sonioxReplayMapper(meta(undefined));
    expect(m.onLine({ t: 10, kind: "session", index: 1, audioOffsetMs: 4200, gapMs: 700 })).toEqual(
      [{ type: "reconnected", gapMs: 700, audioOffsetMs: 4200 }],
    );
    expect(m.onLine({ t: 20, kind: "session", index: 2, audioOffsetMs: 6000 })).toEqual([
      { type: "reconnected", gapMs: 0, audioOffsetMs: 6000 },
    ]);
    expect(m.onLine({ t: 30, kind: "close", session: 2, code: 1000, reason: "" })).toEqual([]);
    expect(m.onLine({ t: 40, kind: "switch", from: 0, to: 1 })).toEqual([]);
    expect(m.onLine(msg({ tokens: "garbage" }))).toEqual([]);
  });

  it("replays the context retries as warnings, then the error as fatal", () => {
    const m = sonioxReplayMapper(
      meta({ context: { terms: ["x"], translation_terms: [{ source: "a", target: "b" }] } }),
    );
    const reject = { error_code: 400, error_message: "bad context" };
    const events = [m.onLine(msg(reject)), m.onLine(msg(reject)), m.onLine(msg(reject))].flat();
    expect(events).toEqual([
      {
        type: "error",
        fatal: false,
        message: "Soniox error 400: bad context (retrying with less context)",
      },
      {
        type: "error",
        fatal: false,
        message: "Soniox error 400: bad context (retrying with less context)",
      },
      { type: "error", fatal: true, message: "Soniox error 400: bad context" },
    ]);
  });

  it("does not retry a 400 once the session has had tokens", () => {
    const m = sonioxReplayMapper(meta({ context: { terms: ["x"] } }));
    m.onLine({ t: 0, kind: "session", index: 0, audioOffsetMs: 0 });
    m.onLine(msg({ tokens: [tok(" قال", false)] }));
    expect(m.onLine(msg({ error_code: 400 }))).toEqual([
      { type: "error", fatal: true, message: "Soniox error 400" },
    ]);
    expect(m.onLine(msg({ error_code: 503 }))).toEqual([
      { type: "error", fatal: false, message: "Soniox error 503" },
    ]);
  });
});

describe("SonioxPauseDetector.reset", () => {
  it("forgets the word timing of the previous Soniox session", () => {
    const d = new SonioxPauseDetector(500);
    const word = { text: " الله", end_ms: 900, is_final: false, translation_status: "original" };
    expect(d.onResponse({ tokens: [word], totalAudioProcMs: 1500 })).toBe(true);
    // A new session restarts audio time: the same position is a new pause after reset.
    d.reset();
    expect(d.onResponse({ tokens: [], totalAudioProcMs: 1500 })).toBe(false);
    expect(d.onResponse({ tokens: [word], totalAudioProcMs: 1500 })).toBe(true);
    expect(d.onResponse({ tokens: [word], totalAudioProcMs: null })).toBe(false);
    expect(
      d.onResponse({ tokens: [{ text: " قال", is_final: false }], totalAudioProcMs: 3000 }),
    ).toBe(false);
  });
});
