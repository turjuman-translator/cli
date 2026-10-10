import { describe, expect, it } from "vitest";
import {
  EnergyVad,
  FLOOR_DBFS,
  frameLevel,
  pcmBytesToSamples,
  samplesLevel,
  type VadEvent,
} from "../../src/shared/vad.js";

const RATE = 16_000;

function tone(ms: number, amplitude: number, freq = 440): Int16Array {
  const n = (ms * RATE) / 1000;
  return Int16Array.from({ length: n }, (_, i) =>
    Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / RATE)),
  );
}

function silence(ms: number): Int16Array {
  return new Int16Array((ms * RATE) / 1000);
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Feed a signal to the VAD in 100 ms frames, like the audio pipeline does. */
function run(vad: EnergyVad, signal: Int16Array): VadEvent[] {
  const events: VadEvent[] = [];
  const frame = RATE / 10;
  for (let i = 0; i < signal.length; i += frame) {
    events.push(...vad.push(signal.subarray(i, i + frame), (i / RATE) * 1000));
  }
  return events;
}

describe("level math", () => {
  it("a full-scale square wave is 0 dBFS RMS and peak", () => {
    const square = Int16Array.from({ length: 1600 }, (_, i) => (i % 2 === 0 ? 32767 : -32768));
    const level = samplesLevel(square);
    expect(level.rmsDbfs).toBeCloseTo(0, 1);
    expect(level.peakDbfs).toBeCloseTo(0, 1);
  });

  it("a full-scale sine has RMS ≈ −3.01 dBFS", () => {
    expect(samplesLevel(tone(100, 1)).rmsDbfs).toBeCloseTo(-3.01, 1);
    expect(Math.abs(samplesLevel(tone(100, 1)).rmsDbfs + 3.01)).toBeLessThan(0.05);
  });

  it("digital silence clamps to the floor", () => {
    expect(samplesLevel(silence(100))).toEqual({ rmsDbfs: FLOOR_DBFS, peakDbfs: FLOOR_DBFS });
  });

  it("reads little-endian bytes and rejects odd lengths", () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]); // +16384, -16384
    expect(Array.from(pcmBytesToSamples(bytes))).toEqual([16384, -16384]);
    expect(frameLevel(bytes).peakDbfs).toBeCloseTo(-6.02, 1);
    expect(() => frameLevel(new Uint8Array(3))).toThrow(/odd/);
  });
});

describe("EnergyVad", () => {
  const cfg = { thresholdDbfs: -45, minSpeechMs: 200, minSilenceMs: 400 };
  const speech = (ms: number) => tone(ms, 0.1); // ≈ −23 dBFS

  it("detects speech start at the first voiced window", () => {
    const events = run(new EnergyVad(cfg), concat(silence(500), speech(600), silence(200)));
    expect(events).toEqual([{ type: "speechStart", atMs: 500 }]);
  });

  it("ignores a 150 ms blip (shorter than minSpeechMs)", () => {
    expect(run(new EnergyVad(cfg), concat(silence(300), speech(150), silence(900)))).toEqual([]);
  });

  it("does not end speech on a 300 ms gap (shorter than minSilenceMs)", () => {
    const events = run(new EnergyVad(cfg), concat(speech(500), silence(300), speech(500)));
    expect(events.map((e) => e.type)).toEqual(["speechStart"]);
  });

  it("ends speech at the start of the silence, within 20 ms", () => {
    const vad = new EnergyVad(cfg);
    const events = run(vad, concat(silence(200), speech(1000), silence(800)));
    const end = events.find((e) => e.type === "speechEnd");
    expect(end).toBeDefined();
    expect(Math.abs((end?.atMs ?? 0) - 1200)).toBeLessThanOrEqual(20);
    expect(vad.speaking).toBe(false);
  });

  it("treats a level just under the threshold as silence", () => {
    const quiet = tone(1000, 10 ** (-48 / 20) * Math.SQRT2); // RMS ≈ −48 dBFS
    expect(run(new EnergyVad(cfg), quiet)).toEqual([]);
  });
});
