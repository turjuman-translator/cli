// The real EngineFactory: builds the Soniox provider (speech recognition + its own translation)
// for a session.
import type { Logger } from "pino";
import type { LoadedConfig, Secrets } from "../config.js";
import { buildSonioxContext } from "../glossary.js";
import type { Languages } from "../languages.js";
import { FakeProvider } from "../stt/fake.js";
import { SonioxProvider } from "../stt/soniox.js";
import { sonioxReplayMapper } from "../stt/soniox-map.js";
import {
  type Engine,
  type EngineFactory,
  type EngineRequest,
  EngineUnavailableError,
} from "./contracts.js";

export interface EngineFactoryOptions {
  loaded: LoadedConfig;
  log: Logger;
  languages: Languages;
  /** Replay this provider.jsonl instead of calling a real engine (`run --fake-provider`, `replay`). */
  fakeProviderFile?: string | null;
  fakeSpeed?: number;
  fakeLoop?: boolean;
  /** Fake providers start replaying at the first audio frame (page sessions) or at start(). */
  fakeStartOnFirstAudio?: boolean;
}

/** Measured on recorded Soniox sessions: translation never follows <end> (0/15), never non-final. Re-verify on a real khutbah. */
/** Soniox endpointing for fast blocks (docs: 500–3000 ms, level 0–3, −1…1). */
// Measured on a deliberate khatib (pauses of 0.4–1.2 s inside sentences): 600/3/0.3
// gave 54 % sentence scraps of ≤ 3 words; 1200/1/0 gives whole sentences (0 %), shown ≈1.6 s
// (p50) after the sentence ends (a comparable live captioning service: ≈2.5 s).
const FAST_ENDPOINT_MS = 1200;
const FAST_ENDPOINT_LEVEL = 1;
const FAST_ENDPOINT_SENSITIVITY = 0;
const SONIOX_TRANSLATION_FINAL_AT_ENDPOINT = true;

export function createEngineFactory(opts: EngineFactoryOptions): EngineFactory {
  const { config } = opts.loaded;
  const { languages, log } = opts;
  /** The request's organisation keys, else the server's .env keys. */
  const secretsOf = (req: EngineRequest): Secrets => req.secrets ?? opts.loaded.secrets;

  const fake = (req: EngineRequest, file: string): Engine => {
    const provider = new FakeProvider({
      file,
      track: req.track,
      speed: opts.fakeSpeed ?? 1,
      loop: opts.fakeLoop ?? false,
      startOnFirstAudio: opts.fakeStartOnFirstAudio ?? true,
      mappers: { soniox: sonioxReplayMapper },
    });
    return { provider };
  };

  const soniox = (req: EngineRequest): Engine => {
    const apiKey = secretsOf(req).sonioxApiKey;
    if (apiKey === null) {
      // A missing key, in the words of the mode: hosted mosques add keys in the app.
      throw new EngineUnavailableError(
        config.mode === "hosted"
          ? "This mosque has no Soniox key: add it in the app under Keys"
          : "SONIOX_API_KEY is not set",
      );
    }
    const s = config.stt.soniox;
    const from = req.from === "auto" ? "auto" : (languages.providerCode(req.from) ?? req.from);
    const context =
      req.glossary === null
        ? null
        : buildSonioxContext(req.glossary, { nativeTranslation: true }).context;
    const provider = new SonioxProvider({
      apiKey,
      region: s.region,
      model: s.model,
      from,
      targetLanguage: languages.providerCode(req.to) ?? req.to,
      context: context !== null && Object.keys(context).length > 0 ? context : null,
      endpointDetection: s.endpointDetection,
      // Fast blocks want an endpoint soon after the imam pauses.
      maxEndpointDelayMs:
        s.maxEndpointDelayMs ?? (req.fastBlocks === true ? FAST_ENDPOINT_MS : null),
      endpointLatencyLevel:
        s.endpointLatencyLevel ?? (req.fastBlocks === true ? FAST_ENDPOINT_LEVEL : null),
      endpointSensitivity:
        s.endpointSensitivity ?? (req.fastBlocks === true ? FAST_ENDPOINT_SENSITIVITY : null),
      pauseFinalizeMs: s.pauseFinalizeMs ?? null,
      recordFile: req.recordFile,
      log: log.child({ engine: "soniox", session: req.sessionId }),
      translationFinalAtEndpoint: SONIOX_TRANSLATION_FINAL_AT_ENDPOINT,
    });
    return { provider };
  };

  return (req) => (opts.fakeProviderFile ? fake(req, opts.fakeProviderFile) : soniox(req));
}
