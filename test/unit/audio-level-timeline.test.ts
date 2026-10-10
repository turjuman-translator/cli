import { describe, expect, it } from "vitest";
import { FLOOR_DBFS, frameLevel, LevelMeter, samplesLevel } from "../../src/audio/level.js";
import { EPOCH_GAP_MS, FRAME_MS, FrameTimeline } from "../../src/audio/timeline.js";

const lvl = (rmsDbfs: number, peakDbfs = rmsDbfs) => ({ rmsDbfs, peakDbfs });

describe("LevelMeter", () => {
  it("re-exports the browser-safe level math", () => {
    expect(FLOOR_DBFS).toBe(-100);
    expect(frameLevel(new Uint8Array(3200))).toEqual(lvl(FLOOR_DBFS));
    expect(samplesLevel(Int16Array.of(-32768)).peakDbfs).toBe(0);
  });

  it("publishes at once, then at most every 200 ms with the max peak and energy-averaged RMS", () => {
    const meter = new LevelMeter({ silenceWarnDbfs: -50 });
    expect(meter.last).toBeNull();
    expect(meter.push(lvl(-20, -10), 0)).toEqual(lvl(-20, -10));
    expect(meter.last).toEqual(lvl(-20, -10));
    expect(meter.push(lvl(-20, -30), 100)).toBeNull();
    expect(meter.push(lvl(-40, -5), 150)).toBeNull();
    const out = meter.push(lvl(-30, -12), 200);
    // Powers 1e-2, 1e-4, 1e-3 → mean 0.0037 → 10·log10 = -24.32 dBFS.
    expect(out?.rmsDbfs).toBeCloseTo(10 * Math.log10((1e-2 + 1e-4 + 1e-3) / 3), 6);
    expect(out?.peakDbfs).toBe(-5);
    expect(meter.last).toBe(out);
  });

  it("floors the RMS of digital silence (zero power) at FLOOR_DBFS", () => {
    const meter = new LevelMeter({ silenceWarnDbfs: -50 });
    expect(meter.push(lvl(Number.NEGATIVE_INFINITY, FLOOR_DBFS), 0)).toEqual(lvl(FLOOR_DBFS));
    expect(meter.push(lvl(-200, FLOOR_DBFS), 1000)).toEqual(lvl(FLOOR_DBFS));
  });

  it("flags noSignal after 10 s of audio below the threshold; a loud frame resets it", () => {
    const meter = new LevelMeter({ silenceWarnDbfs: -50 });
    for (let i = 0; i < 99; i++) meter.push(lvl(-70), i * 100);
    expect(meter.noSignal).toBe(false);
    meter.push(lvl(-70), 9900);
    expect(meter.noSignal).toBe(true);
    meter.push(lvl(-10), 10_000);
    expect(meter.noSignal).toBe(false);
  });

  it("honours custom intervals and frame durations, and reset() forgets everything", () => {
    const meter = new LevelMeter({
      silenceWarnDbfs: -50,
      publishIntervalMs: 1000,
      noSignalAfterMs: 500,
    });
    expect(meter.push(lvl(-60), 0, 250)).not.toBeNull();
    expect(meter.push(lvl(-60), 900, 250)).toBeNull();
    expect(meter.noSignal).toBe(true);
    expect(meter.push(lvl(-60), 1000, 250)).not.toBeNull();
    meter.reset();
    expect(meter.noSignal).toBe(false);
    expect(meter.last).toBeNull();
    expect(meter.push(lvl(-60), 1001)).toEqual(lvl(-60));
  });
});

describe("FrameTimeline", () => {
  it("uses the origin before any frame was pushed", () => {
    expect(new FrameTimeline().wallAt(500)).toBe(500);
    const t = new FrameTimeline({ originWallMs: 10_000 });
    expect(t.wallAt(250)).toBe(10_250);
    expect(t.frames).toBe(0);
    expect(t.inputMs).toBe(0);
    expect(t.epochCount).toBe(0);
  });

  it("keeps the minimum arrival offset of an epoch (late delivery is jitter)", () => {
    expect(FRAME_MS).toBe(100);
    const t = new FrameTimeline();
    t.push(5100); // frame [0,100) arrives at 5100: offset 5000
    t.push(5300); // [100,200) late: candidate 5100, ignored
    t.push(5300); // [200,300): candidate 5000, not lower
    t.push(5390); // [300,400): candidate 4990, the new minimum
    expect(t.epochCount).toBe(1);
    expect(t.frames).toBe(4);
    expect(t.inputMs).toBe(400);
    expect(t.wallAt(0)).toBe(4990);
    expect(t.wallAt(450)).toBe(5440); // extrapolates past the last frame
  });

  it("starts a new epoch after an arrival gap, and maps each input position to its epoch", () => {
    expect(EPOCH_GAP_MS).toBe(500);
    const t = new FrameTimeline();
    t.push(1100);
    t.push(1200);
    t.push(9300); // gap 8100 ms: an ffmpeg restart; frame [200,300) captured at 9200
    t.push(9400);
    t.push(20_500); // third epoch, [400,500)
    expect(t.epochCount).toBe(3);
    expect(t.wallAt(150)).toBe(1150);
    expect(t.wallAt(250)).toBe(9250);
    expect(t.wallAt(399)).toBe(9399);
    expect(t.wallAt(450)).toBe(20_450);
    expect(t.wallAt(-50)).toBe(950); // before the first frame: the first epoch
  });

  it("honours custom frame durations and epoch gaps", () => {
    const t = new FrameTimeline({ frameMs: 20, epochGapMs: 50 });
    t.push(1020);
    t.push(1060, 40); // explicit duration: [20,60), gap 40 ≤ 50
    t.push(1200); // gap 140 > 50: new epoch at input 60
    expect(t.inputMs).toBe(80);
    expect(t.epochCount).toBe(2);
    expect(t.wallAt(70)).toBe(1190);
  });
});
