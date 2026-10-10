// AudioWorkletProcessor for the caption page: picks a channel (left/right/mix), resamples to 16 kHz
// when the context runs at another rate (Firefox), and posts 100 ms frames (1,600 Int16 samples =
// 3,200 bytes, ArrayBuffer transferred) with their RMS/peak dBFS.
// Built as its own bundle; the page loads it with audioWorklet.addModule(__WORKLET_URL__).
import { Resampler } from "../src/shared/resample.js";
import { samplesLevel } from "../src/shared/vad.js";

// AudioWorkletGlobalScope (not part of TypeScript's DOM lib).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(
  name: string,
  ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

const OUT_RATE = 16_000;
const FRAME_SAMPLES = 1600;

type Channel = "mix" | "left" | "right";

function channelOption(options: AudioWorkletNodeOptions | undefined): Channel {
  const po: unknown = options?.processorOptions;
  if (typeof po === "object" && po !== null) {
    const ch = (po as { ch?: unknown }).ch;
    if (ch === "left" || ch === "right") return ch;
  }
  return "mix";
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly ch: Channel;
  private readonly resampler: Resampler | null;
  private mono = new Float32Array(128);
  private frame = new Int16Array(FRAME_SAMPLES);
  private fill = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    this.ch = channelOption(options);
    this.resampler = sampleRate === OUT_RATE ? null : new Resampler(sampleRate, OUT_RATE);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const first = input?.[0];
    if (!input || !first) return true; // no input connected yet
    const n = first.length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const mono = this.mono;
    if (this.ch === "left" || input.length === 1) {
      mono.set(first);
    } else if (this.ch === "right") {
      mono.set(input[1] ?? first);
    } else {
      const count = input.length;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < count; c++) sum += input[c]?.[i] ?? 0;
        mono[i] = sum / count;
      }
    }
    this.push(this.resampler ? this.resampler.process(mono) : mono);
    return true;
  }

  private push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] ?? 0;
      const clipped = v > 1 ? 1 : v < -1 ? -1 : v;
      this.frame[this.fill++] =
        clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
      if (this.fill === FRAME_SAMPLES) {
        const level = samplesLevel(this.frame);
        const pcm = this.frame.buffer;
        this.port.postMessage({ pcm, rms: level.rmsDbfs, peak: level.peakDbfs }, [pcm]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.fill = 0;
      }
    }
  }
}

registerProcessor("capture-processor", CaptureProcessor);
