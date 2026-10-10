import { describe, expect, it } from "vitest";
import type { SonioxContext } from "../../src/glossary.js";
import {
  buildSonioxConfig,
  classifySonioxError,
  cleanSonioxContext,
  describeSonioxError,
  isSonioxControlToken,
  parseSonioxResponse,
  redactSonioxConfig,
  reduceSonioxContext,
  SONIOX_URLS,
  type SonioxConfigInput,
  sonioxContextReductionSteps,
  targetLanguageFromConfig,
} from "../../src/stt/soniox-protocol.js";

const FULL_CONTEXT: SonioxContext = {
  general: [{ key: "domain", value: "Friday khutbah" }],
  text: "A khutbah in Arabic.",
  terms: ["التقوى"],
  translation_terms: [{ source: "التقوى", target: "taqwa" }],
};

function input(over: Partial<SonioxConfigInput> = {}): SonioxConfigInput {
  return {
    apiKey: "test-key-0123456789",
    model: "stt-rt-v5",
    from: "ar",
    targetLanguage: "nl",
    context: null,
    endpointDetection: true,
    maxEndpointDelayMs: null,
    sessionId: "session-1",
    ...over,
  };
}

describe("Soniox control tokens", () => {
  it("knows the endpoint and finalize markers and nothing else", () => {
    expect(isSonioxControlToken("<end>")).toBe(true);
    expect(isSonioxControlToken("<fin>")).toBe(true);
    expect(isSonioxControlToken(" <end>")).toBe(false);
    expect(isSonioxControlToken("الله")).toBe(false);
  });

  it("dials the global and the EU endpoint per region", () => {
    expect(SONIOX_URLS.default).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(SONIOX_URLS.eu).toBe("wss://stt-rt.eu.soniox.com/transcribe-websocket");
  });
});

describe("cleanSonioxContext", () => {
  it("sends nothing without a context", () => {
    expect(cleanSonioxContext(null, true)).toBeNull();
  });

  it("keeps every filled part and copies it (the glossary is never changed)", () => {
    const out = cleanSonioxContext(FULL_CONTEXT, true);
    expect(out).toEqual(FULL_CONTEXT);
    expect(out?.general).not.toBe(FULL_CONTEXT.general);
    expect(out?.terms).not.toBe(FULL_CONTEXT.terms);
    expect(out?.translation_terms).not.toBe(FULL_CONTEXT.translation_terms);
  });

  it("drops translation terms when Soniox does not translate", () => {
    expect(cleanSonioxContext(FULL_CONTEXT, false)).toEqual({
      general: FULL_CONTEXT.general,
      text: FULL_CONTEXT.text,
      terms: FULL_CONTEXT.terms,
    });
  });

  it("removes empty parts and returns null when nothing is left", () => {
    const empty: SonioxContext = { general: [], text: "   ", terms: [], translation_terms: [] };
    expect(cleanSonioxContext(empty, true)).toBeNull();
    expect(cleanSonioxContext({}, true)).toBeNull();
    expect(cleanSonioxContext({ text: "", terms: ["x"] }, true)).toEqual({ terms: ["x"] });
  });
});

describe("buildSonioxConfig", () => {
  it("writes the session config Soniox expects first, with the key and the reference id", () => {
    expect(buildSonioxConfig(input({ context: FULL_CONTEXT }))).toEqual({
      api_key: "test-key-0123456789",
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true,
      client_reference_id: "session-1",
      language_hints: ["ar"],
      translation: { type: "one_way", target_language: "nl" },
      context: FULL_CONTEXT,
    });
  });

  it("puts the source language first in the hints, without repeats or auto", () => {
    const config = buildSonioxConfig(input({ languageHints: ["en", "ar", "auto", "en"] }));
    expect(config.language_hints).toEqual(["ar", "en"]);
  });

  it("sends no hints at all for auto detection", () => {
    const config = buildSonioxConfig(input({ from: "auto", languageHints: ["ar"] }));
    expect(config).not.toHaveProperty("language_hints");
  });

  it("sends the endpoint tuning only with endpoint detection on", () => {
    const tuned = { maxEndpointDelayMs: 1200, endpointLatencyLevel: 1, endpointSensitivity: 0 };
    const on = buildSonioxConfig(input(tuned));
    expect(on.max_endpoint_delay_ms).toBe(1200);
    expect(on.endpoint_latency_adjustment_level).toBe(1);
    expect(on.endpoint_sensitivity).toBe(0);
    const off = buildSonioxConfig(input({ ...tuned, endpointDetection: false }));
    expect(off.enable_endpoint_detection).toBe(false);
    expect(off).not.toHaveProperty("max_endpoint_delay_ms");
    expect(off).not.toHaveProperty("endpoint_latency_adjustment_level");
    expect(off).not.toHaveProperty("endpoint_sensitivity");
    const defaults = buildSonioxConfig(
      input({ endpointLatencyLevel: null, endpointSensitivity: undefined }),
    );
    expect(defaults).not.toHaveProperty("max_endpoint_delay_ms");
    expect(defaults).not.toHaveProperty("endpoint_latency_adjustment_level");
    expect(defaults).not.toHaveProperty("endpoint_sensitivity");
  });

  it("asks for no translation (and no translation terms) without a target language", () => {
    const config = buildSonioxConfig(input({ targetLanguage: null, context: FULL_CONTEXT }));
    expect(config).not.toHaveProperty("translation");
    expect(config.context).not.toHaveProperty("translation_terms");
    expect(config.context?.terms).toEqual(["التقوى"]);
  });

  it("omits an empty context and cuts the reference id at 256 characters", () => {
    const config = buildSonioxConfig(input({ context: { terms: [] }, sessionId: "s".repeat(300) }));
    expect(config).not.toHaveProperty("context");
    expect(config.client_reference_id).toHaveLength(256);
  });
});

describe("redactSonioxConfig", () => {
  it("replaces only the key", () => {
    const config = buildSonioxConfig(input());
    const redacted = redactSonioxConfig(config);
    expect(redacted.api_key).toBe("[redacted]");
    expect(config.api_key).toBe("test-key-0123456789");
    expect({ ...redacted, api_key: config.api_key }).toEqual(config);
  });
});

describe("reduceSonioxContext (a 400 at session start)", () => {
  it("drops the translation terms first, then the whole context, then gives up", () => {
    const config = buildSonioxConfig(input({ context: FULL_CONTEXT }));
    const first = reduceSonioxContext(config);
    expect(first?.dropped).toBe("translation_terms");
    expect(first?.config.context).toEqual({
      general: FULL_CONTEXT.general,
      text: FULL_CONTEXT.text,
      terms: FULL_CONTEXT.terms,
    });
    const second = first === null ? null : reduceSonioxContext(first.config);
    expect(second?.dropped).toBe("context");
    expect(second?.config).not.toHaveProperty("context");
    expect(second?.config.translation).toEqual({ type: "one_way", target_language: "nl" });
    expect(second === null ? "none" : reduceSonioxContext(second.config)).toBeNull();
  });

  it("drops the context at once when translation terms are all it has", () => {
    const config = buildSonioxConfig(
      input({ context: { translation_terms: FULL_CONTEXT.translation_terms } }),
    );
    const reduced = reduceSonioxContext(config);
    expect(reduced?.dropped).toBe("context");
    expect(reduced?.config).not.toHaveProperty("context");
  });

  it("drops a context without translation terms in one step", () => {
    const config = buildSonioxConfig(input({ context: { text: "khutbah" } }));
    expect(reduceSonioxContext(config)?.dropped).toBe("context");
  });

  it("counts the same steps from a recorded config", () => {
    expect(sonioxContextReductionSteps(buildSonioxConfig(input({ context: FULL_CONTEXT })))).toBe(
      2,
    );
    expect(sonioxContextReductionSteps({ context: { translation_terms: [] } })).toBe(1);
    expect(sonioxContextReductionSteps({ context: { terms: ["x"] } })).toBe(1);
    expect(sonioxContextReductionSteps({ context: ["x"] })).toBe(0);
    expect(sonioxContextReductionSteps({ model: "stt-rt-v5" })).toBe(0);
    expect(sonioxContextReductionSteps(null)).toBe(0);
    expect(sonioxContextReductionSteps([{ context: { terms: [] } }])).toBe(0);
  });
});

describe("targetLanguageFromConfig", () => {
  it("reads the translation target of a recorded config, or null", () => {
    expect(targetLanguageFromConfig(buildSonioxConfig(input()))).toBe("nl");
    expect(targetLanguageFromConfig(buildSonioxConfig(input({ targetLanguage: null })))).toBe(null);
    expect(targetLanguageFromConfig({ translation: null })).toBeNull();
    expect(targetLanguageFromConfig({ translation: { target_language: "" } })).toBeNull();
    expect(targetLanguageFromConfig("not a config")).toBeNull();
    expect(targetLanguageFromConfig(undefined)).toBeNull();
  });
});

describe("parseSonioxResponse", () => {
  it("reads tokens, audio progress and the finished flag", () => {
    const parsed = parseSonioxResponse({
      tokens: [
        { text: " الله", start_ms: 100, end_ms: 400, is_final: true, language: "ar" },
        { text: " Allah", is_final: false, translation_status: "translation", speaker: 1 },
      ],
      final_audio_proc_ms: 400,
      total_audio_proc_ms: 900,
      finished: true,
    });
    expect(parsed).toEqual({
      ok: true,
      droppedTokens: 0,
      msg: {
        tokens: [
          { text: " الله", start_ms: 100, end_ms: 400, is_final: true, language: "ar" },
          { text: " Allah", is_final: false, translation_status: "translation", speaker: 1 },
        ],
        finalAudioProcMs: 400,
        totalAudioProcMs: 900,
        finished: true,
        error: null,
      },
    });
  });

  it("keeps a frame with malformed tokens and counts what it dropped", () => {
    const parsed = parseSonioxResponse({
      tokens: [{ text: " قال", is_final: true }, { text: 5 }, "junk", null],
    });
    expect(parsed.ok && parsed.droppedTokens).toBe(3);
    expect(parsed.ok && parsed.msg.tokens).toEqual([{ text: " قال", is_final: true }]);
  });

  it("reads an empty frame (no tokens, no progress)", () => {
    expect(parseSonioxResponse({ tokens: null })).toEqual({
      ok: true,
      droppedTokens: 0,
      msg: {
        tokens: [],
        finalAudioProcMs: null,
        totalAudioProcMs: null,
        finished: false,
        error: null,
      },
    });
  });

  it("rejects a frame that is not a Soniox response", () => {
    const bad = parseSonioxResponse({ tokens: "nope", finished: "yes" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toMatch(/expected/i);
    expect(parseSonioxResponse("text").ok).toBe(false);
  });

  it("reads error frames, with numeric or textual codes", () => {
    const numeric = parseSonioxResponse({
      error_code: 401,
      error_type: "unauthenticated",
      error_message: "Invalid API key",
    });
    expect(numeric.ok && numeric.msg.error).toEqual({
      code: 401,
      type: "unauthenticated",
      message: "Invalid API key",
    });
    const textual = parseSonioxResponse({ error_code: "503", error_message: "busy" });
    expect(textual.ok && textual.msg.error).toEqual({ code: 503, type: null, message: "busy" });
    const garbled = parseSonioxResponse({ error_code: "E_BAD" });
    expect(garbled.ok && garbled.msg.error).toEqual({ code: null, type: null, message: null });
    const typeOnly = parseSonioxResponse({ error_type: "internal_error" });
    expect(typeOnly.ok && typeOnly.msg.error).toEqual({
      code: null,
      type: "internal_error",
      message: null,
    });
  });
});

describe("Soniox errors", () => {
  it("never retries auth, config or quota errors and retries everything else", () => {
    for (const code of [400, 401, 402, 403]) expect(classifySonioxError(code, null)).toBe("fatal");
    expect(classifySonioxError(null, "organization_balance_exhausted")).toBe("fatal");
    expect(classifySonioxError(500, "temp_api_key_session_expired")).toBe("fatal");
    for (const code of [408, 413, 429, 500, 503])
      expect(classifySonioxError(code, null)).toBe("retry");
    expect(classifySonioxError(null, "internal_error")).toBe("retry");
    expect(classifySonioxError(null, null)).toBe("retry");
  });

  it("describes an error with what Soniox told", () => {
    expect(describeSonioxError({ code: 401, type: "unauthenticated", message: "Bad key" })).toBe(
      "Soniox error 401 unauthenticated: Bad key",
    );
    expect(describeSonioxError({ code: 503, type: null, message: null })).toBe("Soniox error 503");
    expect(describeSonioxError({ code: null, type: "", message: "" })).toBe("Soniox error ?");
    expect(describeSonioxError({ code: null, type: "internal_error", message: "x" })).toBe(
      "Soniox error ? internal_error: x",
    );
  });
});
