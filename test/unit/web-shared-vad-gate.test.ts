// @vitest-environment happy-dom
// The caption page's VAD gate (web/shared/vad-gate.ts): only speech, with its pre-roll and
// hangover, is streamed (the engine bills per streamed second).
import { describe, expect, it } from "vitest";
import type { VadParams } from "../../src/shared/protocol.js";
import { PAGE_SAMPLE_RATE, VadGate } from "../../web/shared/vad-gate.js";

const PARAMS: VadParams = {
  thresholdDbfs: -45,
  minSpeechMs: 200,
  minSilenceMs: 400,
  hangoverMs: 800,
  prerollMs: 500,
};

/** `ms` of samples: a loud tone, or digital silence. */
function sound(ms: number, loud: boolean): Int16Array {
  const n = (ms * PAGE_SAMPLE_RATE) / 1000;
  return Int16Array.from({ length: n }, (_, i) =>
    loud ? Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / PAGE_SAMPLE_RATE)) : 0,
  );
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

type Event = { speech: "start" | "end"; at: number } | { frame: number };

/** A gate whose sink records speech events and the start time of each frame it sends. */
function gate(params: VadParams = PARAMS) {
  const events: Event[] = [];
  const starts = new Map<Int16Array, number>();
  const g = new VadGate(params, {
    speech: (state, atMs) => events.push({ speech: state, at: atMs }),
    frame: (samples) => events.push({ frame: starts.get(samples) ?? -1 }),
  });
  /** Push 100 ms frames, loud or silent, from `fromMs` on; returns the next start time. */
  const feed = (fromMs: number, count: number, loud: boolean): number => {
    let t = fromMs;
    for (let i = 0; i < count; i++) {
      const f = sound(100, loud);
      starts.set(f, t);
      g.push(f, t);
      t += 100;
    }
    return t;
  };
  const push = (samples: Int16Array, at: number): void => {
    starts.set(samples, at);
    g.push(samples, at);
  };
  return { g, events, feed, push };
}

const frames = (events: Event[]) => events.flatMap((e) => ("frame" in e ? [e.frame] : []));
const speech = (events: Event[]) =>
  events.flatMap((e) => ("speech" in e ? [`${e.speech}@${e.at}`] : []));

describe("VAD gate", () => {
  it("sends nothing while it is silent", () => {
    const { g, events, feed } = gate();
    feed(0, 30, false);
    expect(events).toEqual([]);
    expect(g.sending).toBe(false);
  });

  it("on speech, sends start at the onset, then the pre-roll from 500 ms before it, then live frames", () => {
    const { g, events, feed } = gate();
    let t = feed(0, 10, false);
    t = feed(t, 2, true);
    expect(g.sending).toBe(true);
    expect(speech(events)).toEqual(["start@1000"]);
    // The onset frame (1000) was detected in the next one (1100); the pre-roll starts at 500.
    expect(frames(events)).toEqual([500, 600, 700, 800, 900, 1000, 1100]);
    expect(events[0]).toEqual({ speech: "start", at: 1000 });
    feed(t, 2, true);
    expect(frames(events).slice(-2)).toEqual([1200, 1300]);
  });

  it("keeps sending through the hangover, then sends end at the VAD speech end", () => {
    const { g, events, feed } = gate();
    let t = feed(0, 10, false);
    t = feed(t, 10, true); // speech 1000–2000
    t = feed(t, 4, false); // silence from 2000: the VAD ends speech after 400 ms (in frame 2300)
    expect(g.sending).toBe(true);
    expect(speech(events)).toEqual(["start@1000"]);
    // Hangover until 2000 + 800 = 2800: frames up to the one ending at 2800 are still sent.
    t = feed(t, 4, false);
    expect(speech(events)).toEqual(["start@1000", "end@2000"]);
    expect(frames(events).at(-1)).toBe(2700);
    expect(g.sending).toBe(false);
    const sent = events.length;
    feed(t, 5, false);
    expect(events).toHaveLength(sent);
  });

  it("treats speech that resumes within the hangover as one stretch", () => {
    const { events, feed } = gate();
    let t = feed(0, 10, false);
    t = feed(t, 10, true);
    t = feed(t, 5, false); // speech end at 2000, hangover until 2800
    t = feed(t, 5, true); // resumes at 2500
    t = feed(t, 15, false);
    expect(speech(events)).toEqual(["start@1000", "end@3000"]);
    const sent = frames(events);
    // Contiguous from the pre-roll to the end of the hangover, nothing twice.
    expect(sent[0]).toBe(500);
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.at(-1)).toBe(3700);
    expect(t).toBe(4500);
  });

  it("ends the stretch when the next frame starts after the hangover (a gap in the clock)", () => {
    const { g, events, feed } = gate();
    let t = feed(0, 10, false);
    t = feed(t, 10, true);
    feed(t, 5, false); // speech end at 2000, hangover until 2800, last frame 2400–2500
    expect(g.sending).toBe(true);
    // The page clock jumped (a capture gap): this frame belongs to the next pre-roll.
    feed(5000, 1, false);
    expect(speech(events)).toEqual(["start@1000", "end@2000"]);
    expect(frames(events)).not.toContain(5000);
    expect(g.sending).toBe(false);
    // …and it is part of that pre-roll when speech starts right after it.
    feed(5100, 3, true);
    expect(speech(events).at(-1)).toBe("start@5100");
    expect(frames(events).slice(-4)).toEqual([5000, 5100, 5200, 5300]);
  });

  it("handles a start and an end inside the first frame", () => {
    const { g, events, push } = gate({
      thresholdDbfs: -45,
      minSpeechMs: 20,
      minSilenceMs: 40,
      hangoverMs: 0,
      prerollMs: 0,
    });
    push(concat(sound(40, true), sound(60, false)), 0);
    expect(speech(events)).toEqual(["start@0", "end@40"]);
    expect(frames(events)).toEqual([0]);
    expect(g.sending).toBe(false);
  });

  it("keeps the hangover open when the end inside the first frame is far from the frame end", () => {
    const { g, events, push } = gate({
      thresholdDbfs: -45,
      minSpeechMs: 20,
      minSilenceMs: 40,
      hangoverMs: 500,
      prerollMs: 0,
    });
    push(concat(sound(40, true), sound(60, false)), 0);
    expect(speech(events)).toEqual(["start@0"]);
    expect(g.sending).toBe(true);
  });

  it("starts after the onset with a negative pre-roll", () => {
    const { events, feed } = gate({ ...PARAMS, prerollMs: -100 });
    let t = feed(0, 10, false);
    t = feed(t, 2, true);
    // Sending starts 100 ms after the onset (1000): the onset frame 1000–1100 is left out.
    expect(speech(events)).toEqual(["start@1000"]);
    expect(frames(events)).toEqual([1100]);
    expect(t).toBe(1200);
  });

  it("flushes an open stretch with end, and forgets the pre-roll and the VAD state", () => {
    const { g, events, feed } = gate();
    let t = feed(0, 10, false);
    t = feed(t, 3, true);
    g.flush();
    expect(speech(events)).toEqual(["start@1000", "end@0"]);
    expect(g.sending).toBe(false);
    // Silent flush: nothing to say.
    g.flush();
    expect(speech(events)).toHaveLength(2);
    // The VAD starts from silence again: the next onset needs a full 200 ms of speech.
    const before = events.length;
    t = feed(t, 1, true);
    expect(events).toHaveLength(before);
    feed(t, 1, true);
    expect(speech(events).at(-1)).toBe(`start@${t - 100}`);
    // No frames from before the flush in the new pre-roll.
    expect(frames(events.slice(before))).toEqual([t - 100, t]);
  });

  it("exposes its parameters", () => {
    expect(gate().g.params).toEqual(PARAMS);
  });
});
