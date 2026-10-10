import { describe, expect, it } from "vitest";
import { EnergyVad, FLOOR_DBFS, samplesLevel } from "../../src/shared/vad.js";

function tone(ms: number, rate: number, amplitude = 0.1, freq = 440): Int16Array {
  const n = Math.round((ms * rate) / 1000);
  return Int16Array.from({ length: n }, (_, i) =>
    Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)),
  );
}

function silence(ms: number, rate: number): Int16Array {
  return new Int16Array(Math.round((ms * rate) / 1000));
}

const cfg = { thresholdDbfs: -45, minSpeechMs: 200, minSilenceMs: 400 };

describe("samplesLevel", () => {
  it("reports the floor for an empty frame", () => {
    expect(samplesLevel(new Int16Array(0))).toEqual({ rmsDbfs: FLOOR_DBFS, peakDbfs: FLOOR_DBFS });
  });
});

describe("EnergyVad.reset", () => {
  it("forgets a voiced run that had not yet reached minSpeechMs", () => {
    const withoutReset = new EnergyVad(cfg);
    expect(withoutReset.push(tone(100, 16_000), 0)).toEqual([]);
    expect(withoutReset.push(tone(100, 16_000), 100)).toEqual([{ type: "speechStart", atMs: 0 }]);

    const vad = new EnergyVad(cfg);
    expect(vad.push(tone(100, 16_000), 0)).toEqual([]);
    vad.reset();
    // The 100 ms before the reset no longer count: another 100 ms is not enough.
    expect(vad.push(tone(100, 16_000), 100)).toEqual([]);
    expect(vad.push(tone(100, 16_000), 200)).toEqual([{ type: "speechStart", atMs: 100 }]);
  });

  it("returns to silence, so the next speech starts again", () => {
    const vad = new EnergyVad(cfg);
    expect(vad.push(tone(300, 16_000), 0)).toEqual([{ type: "speechStart", atMs: 0 }]);
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
    // Silence right after a reset is not a speech end: nothing was speaking.
    expect(vad.push(silence(600, 16_000), 300)).toEqual([]);
    expect(vad.push(tone(300, 16_000), 900)).toEqual([{ type: "speechStart", atMs: 900 }]);
  });
});

describe("EnergyVad with its own sample rate and window", () => {
  it("places events on the window grid of the given rate", () => {
    const rate = 48_000;
    const signal = new Int16Array(rate);
    signal.set(silence(250, rate), 0);
    signal.set(tone(750, rate), Math.round(0.25 * rate));
    // 10 ms windows: speech starts exactly at 250 ms.
    const fine = new EnergyVad({ ...cfg, sampleRate: rate, windowMs: 10 });
    expect(fine.push(signal, 0)).toEqual([{ type: "speechStart", atMs: 250 }]);
    // With only the rate set, the default 20 ms window puts the start on the 20 ms grid.
    const coarse = new EnergyVad({ ...cfg, sampleRate: rate });
    expect(coarse.push(signal, 0)).toEqual([{ type: "speechStart", atMs: 240 }]);
  });
});
