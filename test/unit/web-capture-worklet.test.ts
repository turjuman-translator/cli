// @vitest-environment happy-dom
// The caption page's AudioWorkletProcessor (web/capture-worklet.ts), run in a fake
// AudioWorkletGlobalScope: channel choice, clipping, 16 kHz resampling and the 100 ms frames it
// posts (1,600 Int16 samples, the buffer transferred, with RMS and peak in dBFS).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { samplesLevel } from "../../src/shared/vad.js";

interface PostedFrame {
  pcm: ArrayBuffer;
  rms: number;
  peak: number;
}

/** The fake scope's base class: a port whose posts the test reads. */
class FakeProcessorBase {
  readonly port = { postMessage: vi.fn<(msg: PostedFrame, transfer: Transferable[]) => void>() };
  constructor(readonly options?: AudioWorkletNodeOptions) {}
}

interface Processor extends FakeProcessorBase {
  process(inputs: Float32Array[][]): boolean;
}

type ProcessorClass = new (options: AudioWorkletNodeOptions) => Processor;

const registered: Array<[string, ProcessorClass]> = [];
let Capture: ProcessorClass;

beforeAll(async () => {
  vi.stubGlobal("sampleRate", 16_000);
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
  vi.stubGlobal("registerProcessor", (name: string, ctor: ProcessorClass) => {
    registered.push([name, ctor]);
  });
  vi.resetModules();
  await import("../../web/capture-worklet.js");
  const ctor = registered[0]?.[1];
  if (!ctor) throw new Error("the worklet registered no processor");
  Capture = ctor;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** A processor at `rate` (the AudioWorkletGlobalScope's sampleRate). */
function make(ch?: unknown, rate = 16_000): Processor {
  vi.stubGlobal("sampleRate", rate);
  const options: AudioWorkletNodeOptions =
    ch === undefined ? {} : { processorOptions: ch === null ? null : { ch } };
  return new Capture(options);
}

const block = (value: number, n = 128) => new Float32Array(n).fill(value);

/** Feed `blocks` render quanta of the given channels; returns the frames posted. */
function run(p: Processor, channels: Float32Array[], blocks: number): PostedFrame[] {
  for (let i = 0; i < blocks; i++) expect(p.process([channels])).toBe(true);
  return p.port.postMessage.mock.calls.map((c) => c[0]);
}

describe("capture worklet", () => {
  it("registers the capture processor", () => {
    expect(registered.map(([name]) => name)).toEqual(["capture-processor"]);
    expect(new Capture({})).toBeInstanceOf(FakeProcessorBase);
  });

  it("keeps running without an input", () => {
    const p = make();
    expect(p.process([])).toBe(true);
    expect(p.process([[]])).toBe(true);
    expect(p.port.postMessage).not.toHaveBeenCalled();
  });

  it("posts a 100 ms frame of 1,600 samples, transferring its buffer, with its level", () => {
    const p = make("mix");
    // 12 blocks of 128 = 1,536 samples: not a frame yet.
    expect(run(p, [block(0.5)], 12)).toEqual([]);
    const frames = run(p, [block(0.5)], 1);
    expect(frames).toHaveLength(1);
    const f = frames[0] as PostedFrame;
    expect(f.pcm.byteLength).toBe(3200);
    const samples = new Int16Array(f.pcm);
    expect(samples[0]).toBe(Math.round(0.5 * 32767));
    expect(samples[1599]).toBe(Math.round(0.5 * 32767));
    const level = samplesLevel(samples);
    expect(f.rms).toBe(level.rmsDbfs);
    expect(f.peak).toBe(level.peakDbfs);
    expect(p.port.postMessage.mock.calls[0]?.[1]).toEqual([f.pcm]);
    // The rest of that block (64 samples) starts the next frame: 64 + 12 × 128 = 1,600.
    expect(run(p, [block(0.5)], 11)).toHaveLength(1);
    expect(run(p, [block(0.5)], 1)).toHaveLength(2);
  });

  it("clips to full scale, using 32768 for negative and 32767 for positive values", () => {
    const p = make();
    const signal = new Float32Array(1600);
    signal.set([2, -2, 1, -1, 0.25, -0.25, Number.NaN]);
    p.process([[signal]]);
    const f = p.port.postMessage.mock.calls[0]?.[0] as PostedFrame;
    expect(Array.from(new Int16Array(f.pcm).slice(0, 7))).toEqual([
      32767,
      -32768,
      32767,
      -32768,
      Math.round(0.25 * 32767),
      Math.round(-0.25 * 32768),
      0,
    ]);
  });

  it("mixes all channels by default", () => {
    const p = make();
    const frames = run(p, [block(0.2, 400), block(0.6, 400)], 4);
    expect(new Int16Array(frames[0]?.pcm ?? new ArrayBuffer(0))[0]).toBe(Math.round(0.4 * 32767));
  });

  it("takes one channel with ch=left or ch=right", () => {
    const left = make("left");
    const right = make("right");
    const stereo = [block(0.2, 800), block(-0.6, 800)];
    const l = run(left, stereo, 2)[0] as PostedFrame;
    const r = run(right, stereo, 2)[0] as PostedFrame;
    expect(new Int16Array(l.pcm)[0]).toBe(Math.round(0.2 * 32767));
    expect(new Int16Array(r.pcm)[0]).toBe(Math.round(-0.6 * 32768));
  });

  it("uses the only channel there is, whatever ch says", () => {
    const right = make("right");
    const mono = [block(0.3, 1600)];
    expect(new Int16Array(run(right, mono, 1)[0]?.pcm ?? new ArrayBuffer(0))[0]).toBe(
      Math.round(0.3 * 32767),
    );
  });

  it("falls back to the first channel when the right one is missing from a sparse input", () => {
    const right = make("right");
    const sparse: Float32Array[] = [block(0.3, 1600)];
    sparse.length = 2;
    const f = run(right, sparse, 1)[0] as PostedFrame;
    expect(new Int16Array(f.pcm)[0]).toBe(Math.round(0.3 * 32767));
  });

  it("counts a missing channel as silence in the mix", () => {
    const p = make("mix");
    const sparse: Float32Array[] = [block(0.4, 1600)];
    sparse.length = 2;
    const f = run(p, sparse, 1)[0] as PostedFrame;
    expect(new Int16Array(f.pcm)[0]).toBe(Math.round(0.2 * 32767));
  });

  it("mixes when the channel option is missing or unknown", () => {
    for (const ch of [undefined, null, "both", 3]) {
      const p = make(ch);
      const f = run(p, [block(0.2, 800), block(0.6, 800)], 2)[0] as PostedFrame;
      expect(new Int16Array(f.pcm)[0], String(ch)).toBe(Math.round(0.4 * 32767));
    }
    const plain = make();
    expect(run(plain, [block(0.2, 1600), block(0.6, 1600)], 1)).toHaveLength(1);
  });

  it("resamples another context rate to 16 kHz (Firefox at 48 kHz)", () => {
    const p = make("mix", 48_000);
    // 48 kHz: 4,800 input samples make one 1,600-sample frame (after the filter's delay).
    const frames = run(p, [block(0.5, 480)], 12);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const samples = new Int16Array(frames[0]?.pcm ?? new ArrayBuffer(0));
    expect(samples).toHaveLength(1600);
    // A constant level passes the low-pass unchanged once the filter has filled.
    expect(samples[1599]).toBeCloseTo(Math.round(0.5 * 32767), -1);
    expect(run(p, [block(0.5, 480)], 30).length).toBeGreaterThan(frames.length + 2);
  });
});
