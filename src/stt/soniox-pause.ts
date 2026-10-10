// Finalize at the khatib's pauses, detected from Soniox's own word timing.
//
// The page VAD sends speech:end → finalize only when the room goes quiet; with ambience or a PA
// hum it never does, and Soniox's endpointing does not end an utterance at a short pause inside a
// sentence: the words before the pause then wait for the next endpoint (≈ 1.5–3.5 s). Soniox
// reports how much audio it has processed: unfinalized words and ≥ pauseMs of audio after the
// newest word = the khatib paused → finalize, so their translation arrives at once. One finalize
// per pause; a new word re-arms it.
import type { SonioxToken } from "./soniox-protocol.js";

export class SonioxPauseDetector {
  private readonly pauseMs: number;
  private lastWordEnd = -1;
  private firedFor = -1;

  constructor(pauseMs: number) {
    this.pauseMs = pauseMs;
  }

  /** One Soniox response; true when a finalize should be sent now. */
  onResponse(msg: {
    tokens: readonly Pick<SonioxToken, "text" | "end_ms" | "is_final" | "translation_status">[];
    totalAudioProcMs: number | null;
  }): boolean {
    let pending = false;
    for (const t of msg.tokens) {
      if (t.translation_status === "translation") continue;
      if (t.text.startsWith("<") || t.text.trim() === "") continue;
      if (typeof t.end_ms === "number") this.lastWordEnd = Math.max(this.lastWordEnd, t.end_ms);
      if (t.is_final !== true) pending = true;
    }
    const proc = msg.totalAudioProcMs;
    if (!pending || proc === null || this.lastWordEnd < 0) return false;
    if (this.firedFor === this.lastWordEnd || proc - this.lastWordEnd < this.pauseMs) return false;
    this.firedFor = this.lastWordEnd;
    return true;
  }

  reset(): void {
    this.lastWordEnd = -1;
    this.firedFor = -1;
  }
}
