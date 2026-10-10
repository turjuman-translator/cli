import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider, type FakeProviderOptions, replayCapabilities } from "../../src/stt/fake.js";
import type { RecordingEntry, RecordingMeta } from "../../src/stt/recording.js";
import { sonioxReplayMapper } from "../../src/stt/soniox-map.js";
import type { ProviderCapabilities, ProviderEvent, Token } from "../../src/stt/types.js";

const FIXTURE = join(process.cwd(), "test", "fixtures", "soniox-tts-1.jsonl");

const META: RecordingMeta = {
  kind: "meta",
  provider: "soniox",
  version: 1,
  startedAt: 0,
  config: { translation: { type: "one_way", target_language: "nl" } },
};

/** A Soniox frame with final Arabic words and their Dutch translation, then an endpoint. */
const said = (t: number, ar: string, nl: string, session = 0): RecordingEntry => ({
  t,
  kind: "msg",
  session,
  data: {
    tokens: [
      { text: ar, is_final: true, language: "ar", start_ms: t - 300, end_ms: t - 100 },
      { text: nl, is_final: true, language: "nl", translation_status: "translation" },
      { text: "<end>", is_final: true },
    ],
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stt-fake-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function recording(lines: RecordingEntry[], meta: RecordingMeta = META): string {
  const file = join(dir, `provider-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, `${[meta, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

function fake(file: string, over: Partial<FakeProviderOptions> = {}) {
  const events: ProviderEvent[] = [];
  const provider = new FakeProvider({
    file,
    track: "soniox",
    mappers: { soniox: sonioxReplayMapper },
    ...over,
  });
  const start = () => provider.start({ sessionId: "s1", onEvent: (e) => events.push(e) });
  return { provider, events, start };
}

const text = (events: ProviderEvent[], kind: Token["kind"]): string =>
  events
    .flatMap((e) => (e.type === "tokens" ? e.final : []))
    .filter((t) => t.kind === kind)
    .map((t) => t.text)
    .join("");

const kinds = (events: ProviderEvent[]): string[] =>
  events.map((e) => (e.type === "state" ? `state:${e.state}` : e.type));

describe("FakeProvider: options", () => {
  it("refuses a speed that is not positive, and looping at infinite speed", () => {
    const file = recording([]);
    for (const speed of [0, -1, Number.NaN]) {
      expect(() => fake(file, { speed })).toThrow(`speed must be > 0 (got ${speed})`);
    }
    expect(() => fake(file, { speed: Number.POSITIVE_INFINITY, loop: true })).toThrow(
      "loop needs a finite speed",
    );
  });

  it("takes its capabilities from the recording, unless given", () => {
    expect(fake(FIXTURE).provider.capabilities).toEqual({
      nativeTranslation: true,
      timing: "provider",
      translationFinalAtEndpoint: false,
    });
    const asr = recording([], { ...META, config: { model: "stt-rt-v5" } });
    expect(fake(asr).provider.capabilities.nativeTranslation).toBe(false);
    const caps: ProviderCapabilities = {
      nativeTranslation: false,
      timing: "arrival",
      translationFinalAtEndpoint: true,
    };
    expect(fake(FIXTURE, { capabilities: caps }).provider.capabilities).toBe(caps);
    expect(fake(FIXTURE).provider.track).toBe("soniox");
  });

  it("gives other providers' recordings arrival timing", () => {
    expect(replayCapabilities({ ...META, provider: "other" })).toEqual({
      nativeTranslation: false,
      timing: "arrival",
      translationFinalAtEndpoint: false,
    });
  });
});

describe("FakeProvider: replay", () => {
  it("replays a real Soniox recording at once with infinite speed", async () => {
    let clock = 7000;
    const f = fake(FIXTURE, { speed: Number.POSITIVE_INFINITY, now: () => clock++ });
    await f.start();
    expect(f.provider.state).toBe("live");
    expect(kinds(f.events).slice(0, 3)).toEqual(["state:connecting", "state:live", "tokens"]);
    // Soniox's <end>, then the <fin> of the stop: it closes no new words, so it is dropped.
    expect(f.events.filter((e) => e.type === "endpoint")).toHaveLength(1);
    expect(text(f.events, "source")).toContain("بسم الله الرحمن الرحيم.");
    expect(text(f.events, "translation")).toContain("In de naam van Allah");
    // receivedAt is the replay clock, not the recorded time.
    const times = f.events.flatMap((e) => (e.type === "tokens" ? [e.receivedAt] : []));
    expect(times[0]).toBeGreaterThanOrEqual(7000);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    await expect(f.provider.whenDone()).resolves.toBeUndefined();
  });

  it("keeps the recorded timing, divided by the speed", async () => {
    vi.useFakeTimers({ now: 0 });
    const f = fake(recording([said(1000, " قال", " zei"), said(3000, " الله", " Allah")]), {
      speed: 2,
    });
    let done = false;
    void f.provider.whenDone().then(() => {
      done = true;
    });
    await f.start();
    expect(kinds(f.events)).toEqual(["state:connecting", "state:live"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(text(f.events, "source")).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(text(f.events, "source")).toBe(" قال");
    expect(f.events.at(-2)).toMatchObject({ type: "tokens", receivedAt: 500 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(text(f.events, "source")).toBe(" قال الله");
    expect(text(f.events, "translation")).toBe(" zei Allah");
    expect(done).toBe(true);
  });

  it("starts the clock at the first audio frame when asked to", async () => {
    vi.useFakeTimers({ now: 0 });
    const f = fake(recording([said(200, " قال", " zei")]), { startOnFirstAudio: true });
    f.provider.sendAudio(new Uint8Array(3200)); // before start(): counted only
    expect(f.provider.framesReceived).toBe(1);
    await f.start();
    // Audio already arrived: the replay runs from start().
    await vi.advanceTimersByTimeAsync(200);
    expect(text(f.events, "source")).toBe(" قال");
    await f.provider.stop();

    const g = fake(recording([said(200, " قال", " zei")]), { startOnFirstAudio: true });
    await g.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(text(g.events, "source")).toBe("");
    g.provider.sendAudio(new Uint8Array(3200));
    await vi.advanceTimersByTimeAsync(100);
    g.provider.sendAudio(new Uint8Array(3200)); // the replay is already running
    await vi.advanceTimersByTimeAsync(100);
    expect(text(g.events, "source")).toBe(" قال");
    expect(g.provider.framesReceived).toBe(2);
  });

  it("counts finalize calls and frames without using them", async () => {
    const f = fake(recording([]), { speed: Number.POSITIVE_INFINITY });
    await f.start();
    f.provider.finalize();
    f.provider.finalize();
    f.provider.sendAudio(new Uint8Array(3200));
    expect(f.provider.finalizeCalls).toBe(2);
    expect(f.provider.framesReceived).toBe(1);
  });

  it("refuses a second start and a recording without a replay mapper", async () => {
    const f = fake(FIXTURE, { speed: Number.POSITIVE_INFINITY });
    await f.start();
    await expect(f.start()).rejects.toThrow("FakeProvider: already started");
    const other = recording([], { ...META, provider: "other" });
    await expect(fake(other).start()).rejects.toThrow(
      'FakeProvider: no replay mapper for provider "other"',
    );
  });

  it("stops mid-replay: no later events, idle, and done", async () => {
    vi.useFakeTimers({ now: 0 });
    const f = fake(recording([said(100, " قال", " zei"), said(5000, " الله", " Allah")]));
    await f.start();
    await vi.advanceTimersByTimeAsync(100);
    await f.provider.stop();
    expect(f.provider.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(text(f.events, "source")).toBe(" قال");
    expect(f.events.at(-1)).toEqual({ type: "state", state: "idle" });
    await expect(f.provider.whenDone()).resolves.toBeUndefined();
    // stop() again (no timer left) and a fresh start replay from the beginning.
    await f.provider.stop();
    await f.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(text(f.events, "source")).toBe(" قال قال");
  });

  it("lets the consumer stop the replay from inside its event handler", async () => {
    const f = fake(recording([said(0, " قال", " zei"), said(10, " الله", " Allah")]), {
      speed: Number.POSITIVE_INFINITY,
    });
    const seen: string[] = [];
    await f.provider.start({
      sessionId: "s1",
      onEvent: (e) => {
        if (e.type !== "tokens") return;
        seen.push(e.final.map((t) => t.text).join(""));
        void f.provider.stop();
      },
    });
    expect(seen).toEqual([" قال zei"]);
    expect(f.provider.state).toBe("idle");
  });

  it("survives a consumer that throws", async () => {
    const f = fake(recording([said(0, " قال", " zei"), said(10, " الله", " Allah")]), {
      speed: Number.POSITIVE_INFINITY,
    });
    const seen: string[] = [];
    await f.provider.start({
      sessionId: "s1",
      onEvent: (e) => {
        seen.push(e.type);
        throw new Error("consumer bug");
      },
    });
    expect(seen.filter((t) => t === "endpoint")).toHaveLength(2);
  });
});

describe("FakeProvider: loop", () => {
  it("starts over as a new provider session placed after the recorded audio", async () => {
    vi.useFakeTimers({ now: 0 });
    // Session 1 starts at t=1000 with 4 s of audio before it: the loop covers
    // max(1450, 4000 + 450) ms → 4500 ms of input audio (whole frames, rounded up).
    const lines: RecordingEntry[] = [
      { t: 0, kind: "session", index: 0, audioOffsetMs: 0 },
      said(400, " قال", " zei"),
      { t: 1000, kind: "session", index: 1, audioOffsetMs: 4000, gapMs: 600 },
      said(1450, " الله", " Allah", 1),
    ];
    const f = fake(recording(lines), { loop: true });
    await f.start();
    await vi.advanceTimersByTimeAsync(1450);
    expect(f.events.filter((e) => e.type === "reconnected")).toEqual([
      { type: "reconnected", gapMs: 600, audioOffsetMs: 4000 },
    ]);
    let done = false;
    void f.provider.whenDone().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(100 + 1450);
    expect(f.events.filter((e) => e.type === "reconnected")).toEqual([
      { type: "reconnected", gapMs: 600, audioOffsetMs: 4000 },
      { type: "reconnected", gapMs: 0, audioOffsetMs: 4500 },
      { type: "reconnected", gapMs: 600, audioOffsetMs: 8500 },
    ]);
    expect(text(f.events, "source")).toBe(" قال الله قال الله");
    expect(done).toBe(false);
    await f.provider.stop();
    expect(done).toBe(true);
  });

  it("ends an empty recording even when looping", async () => {
    const f = fake(recording([]), { loop: true });
    await f.start();
    await expect(f.provider.whenDone()).resolves.toBeUndefined();
    expect(kinds(f.events)).toEqual(["state:connecting", "state:live"]);
  });
});
