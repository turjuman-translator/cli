// Browser globals provided by OBS Browser Sources (absent in normal browsers), build-time
// constants injected by scripts/build-web.ts, and test hooks exposed by the caption page.

interface CaptionPageStats {
  state: string;
  sessionId: string | null;
  layout: "blocks" | "rollup";
  /** Prayer-event mode from the server's `mode` messages. */
  mode: string;
  /** Blocks currently rendered (layout=blocks). */
  blocks: number;
  /** VAD speech end → block arrival. */
  latencyBlocks: import("../src/shared/protocol.js").LatencyStats;
  /** Segments currently held for the session's track. */
  segments: number;
  /** Final arrivals seen live (source finals). */
  finals: number;
  /** Page-side latency: blocks layout → latencyBlocks; rollup → translation (or source) finals. */
  latency: import("../src/shared/protocol.js").LatencyStats;
  latencySource: import("../src/shared/protocol.js").LatencyStats;
  latencyTranslation: import("../src/shared/protocol.js").LatencyStats;
  framesSent: number;
  speaking: boolean;
  sampleRate: number | null;
  resampling: boolean;
  micLabel: string | null;
  /** Signed screen link: enabled | disabled | invalid | required | pending. */
  screen: { guid: string; state: string } | null;
}

interface Window {
  obsstudio?: { pluginVersion?: string };
  __captionStats?: CaptionPageStats;
}

/** Hashed URL of the capture worklet bundle (esbuild `define`, see scripts/build-web.ts). */
declare const __WORKLET_URL__: string;
