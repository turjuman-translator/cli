// VAD gate for the caption page: only speech (plus pre-roll and hangover) is streamed, because the
// engines bill per streamed second.
//   silent  → keep a pre-roll ring; on a VAD speech start send `start`, the ring frames from
//             (onset − prerollMs) on, then live frames;
//   speech  → send every frame; a VAD speech end arms the hangover;
//   hangover→ keep sending until (speech end + hangoverMs), then send `end` and go silent.
//             A speech restart within the hangover is continuous (no new `start`).
import type { VadParams } from "../../src/shared/protocol.js";
import { EnergyVad } from "../../src/shared/vad.js";

export const PAGE_SAMPLE_RATE = 16_000;

export interface GateSink {
  /** `atMs` = VAD onset for start, VAD speech end (not the hangover end) for end. */
  speech(state: "start" | "end", atMs: number): void;
  frame(samples: Int16Array): void;
}

type GateState = "silent" | "speech" | "hangover";

interface RingFrame {
  samples: Int16Array;
  startMs: number;
  endMs: number;
}

export class VadGate {
  private readonly vad: EnergyVad;
  private state: GateState = "silent";
  private ring: RingFrame[] = [];
  private readonly ringMs: number;
  private hangoverUntil = 0;
  private lastVadEnd = 0;

  constructor(
    readonly params: VadParams,
    private readonly sink: GateSink,
  ) {
    this.vad = new EnergyVad({
      thresholdDbfs: params.thresholdDbfs,
      minSpeechMs: params.minSpeechMs,
      minSilenceMs: params.minSilenceMs,
      sampleRate: PAGE_SAMPLE_RATE,
      windowMs: 20,
    });
    // The onset lies minSpeechMs before detection; keep enough to send prerollMs before it.
    this.ringMs = Math.max(0, params.prerollMs) + params.minSpeechMs + 200;
  }

  /** True while audio is being streamed (speech or hangover). */
  get sending(): boolean {
    return this.state !== "silent";
  }

  /** Feed one frame that starts at `startMs` (page clock). */
  push(samples: Int16Array, startMs: number): void {
    const endMs = startMs + (samples.length / PAGE_SAMPLE_RATE) * 1000;
    const events = this.vad.push(samples, startMs);

    if (this.state === "silent") {
      this.ring.push({ samples, startMs, endMs });
      while (this.ring.length > 1 && endMs - (this.ring[0]?.startMs ?? endMs) > this.ringMs) {
        this.ring.shift();
      }
      const start = events.find((e) => e.type === "speechStart");
      if (!start) return;
      this.state = "speech";
      this.sink.speech("start", start.atMs);
      const from = start.atMs - this.params.prerollMs;
      for (const f of this.ring) if (f.endMs > from) this.sink.frame(f.samples);
      this.ring = [];
      const end = events.find((e) => e.type === "speechEnd" && e.atMs >= start.atMs);
      if (end) this.armHangover(end.atMs);
      this.maybeEnd(endMs);
      return;
    }

    for (const e of events) {
      if (e.type === "speechStart") this.state = "speech";
      else this.armHangover(e.atMs);
    }
    if (this.state === "hangover" && startMs >= this.hangoverUntil) {
      // Beyond the hangover: this frame belongs to the next pre-roll.
      this.finish();
      this.ring.push({ samples, startMs, endMs });
      return;
    }
    this.sink.frame(samples);
    this.maybeEnd(endMs);
  }

  /** Stop streaming now (e.g. capture stopped); sends `end` when speech was open. */
  flush(): void {
    if (this.state !== "silent") this.finish();
    this.ring = [];
    this.vad.reset();
  }

  private armHangover(vadEndMs: number): void {
    this.state = "hangover";
    this.lastVadEnd = vadEndMs;
    this.hangoverUntil = vadEndMs + this.params.hangoverMs;
  }

  private maybeEnd(frameEndMs: number): void {
    if (this.state === "hangover" && frameEndMs >= this.hangoverUntil) this.finish();
  }

  private finish(): void {
    this.state = "silent";
    this.ring = [];
    this.sink.speech("end", this.lastVadEnd);
  }
}
