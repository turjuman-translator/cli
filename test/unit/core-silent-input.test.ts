import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SilentAudioInput } from "../../src/core/silent-input.js";
import type { AudioState } from "../../src/shared/protocol.js";
import type { Level } from "../../src/shared/vad.js";

describe("SilentAudioInput", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 50_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a frame of digital silence every 100 ms in real time until stopped", async () => {
    const input = new SilentAudioInput();
    expect(input.state).toBe("idle");
    expect(input.lastStderr).toBeNull();
    const frames: Array<{ frame: Uint8Array; at: number }> = [];
    const levels: Level[] = [];
    const states: AudioState[] = [];
    input.start({
      onFrame: (frame, at) => frames.push({ frame, at }),
      onLevel: (level) => levels.push(level),
      onState: (state, detail) => {
        states.push(state);
        expect(detail.lastStderr).toBeNull();
      },
    });
    expect(input.state).toBe("ok");
    expect(states).toEqual(["ok"]);
    vi.advanceTimersByTime(350);
    expect(frames.map((f) => f.at)).toEqual([50_100, 50_200, 50_300]);
    expect(frames.every((f) => f.frame.byteLength === 3200 && f.frame.every((b) => b === 0))).toBe(
      true,
    );
    // Each frame is its own copy: a consumer may keep or change it.
    expect(frames[0]?.frame).not.toBe(frames[1]?.frame);
    expect(levels).toEqual([
      { rmsDbfs: -100, peakDbfs: -100 },
      { rmsDbfs: -100, peakDbfs: -100 },
      { rmsDbfs: -100, peakDbfs: -100 },
    ]);
    await input.stop();
    expect(input.state).toBe("idle");
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(3);
  });

  it("ignores a second start, works without the optional handlers and can stop twice", async () => {
    const input = new SilentAudioInput();
    const first: number[] = [];
    const second: number[] = [];
    input.start({ onFrame: (_f, at) => first.push(at) });
    input.start({ onFrame: (_f, at) => second.push(at) });
    vi.advanceTimersByTime(200);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
    await input.stop();
    await input.stop();
    expect(input.state).toBe("idle");
  });
});
