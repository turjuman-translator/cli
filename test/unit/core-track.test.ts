import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineUnavailableError } from "../../src/core/contracts.js";
import {
  FAST_HARD_CLOSE_MS,
  STOP_HARD_CLOSE_MS,
  SWITCH_HARD_CLOSE_MS,
  Track,
  type TrackContext,
} from "../../src/core/track.js";
import { SessionTranscript } from "../../src/core/transcripts.js";
import type { Segment } from "../../src/shared/protocol.js";
import {
  type ControlledOptions,
  captureLog,
  controlledFactory,
  silentFrame,
  src,
  tempDirs,
  testConfig,
  toneFrame,
  tr,
  WARN,
} from "./helpers/core-fakes.js";

const T0 = 2_000_000;
const temp = tempDirs("core-track-");

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
});

interface Marker {
  type: string;
  data: Record<string, unknown>;
  line: string;
}

function setup(
  opts: {
    config?: Record<string, unknown>;
    providers?: ControlledOptions[];
    ctx?: Partial<TrackContext>;
  } = {},
) {
  const cap = captureLog();
  const f = controlledFactory(...(opts.providers ?? []));
  const markers: Marker[] = [];
  const segments: Segment[] = [];
  const failures: Array<{ message: string; fatal: boolean }> = [];
  let changes = 0;
  const track = new Track("soniox", {
    sessionId: "sess",
    from: "ar",
    to: "nl",
    sessionStartWall: T0,
    loaded: testConfig(temp.make(), opts.config ?? {}),
    engineFactory: f.factory,
    glossary: null,
    transcript: null,
    log: cap.log,
    now: () => Date.now(),
    hooks: {
      onSegment: (_t, seg) => segments.push(seg),
      onChange: () => {
        changes++;
      },
      onMarker: (type, data, line) => markers.push({ type, data, line }),
      onFailure: (_t, message, fatal) => failures.push({ message, fatal }),
    },
    ...opts.ctx,
  });
  return {
    track,
    f,
    cap,
    markers,
    segments,
    failures,
    changes: () => changes,
    types: () => markers.map((m) => m.type),
  };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("Track engines", () => {
  it("builds an engine for the track's request, marks it and goes live", async () => {
    const t = setup();
    expect(t.track.currentEngine).toBeNull();
    expect(t.track.engineOpen).toBe(false);
    expect(t.track.providerState()).toBe("idle");
    const inst = t.track.openEngine();
    expect(t.f.requests).toEqual([
      {
        track: "soniox",
        sessionId: "sess",
        from: "ar",
        to: "nl",
        glossary: null,
        recordFile: null,
        fastBlocks: false,
      },
    ]);
    expect(inst.id).toBe("soniox#1");
    expect(t.track.currentEngine).toBe(inst);
    expect(t.track.engineOpen).toBe(true);
    expect(t.markers[0]).toEqual({
      type: "engine-open",
      data: { track: "soniox", engine: "soniox#1" },
      line: "soniox: engine soniox#1 opened",
    });
    expect(inst.live).toBe(false);
    await flush();
    expect(inst.live).toBe(true);
    expect(t.track.providerState()).toBe("live");
    expect(await t.track.waitLive(inst, 1000)).toBe(true);
  });

  it("records provider messages in the transcript and reads the keys at every start", () => {
    const dir = temp.make();
    const transcript = new SessionTranscript({
      rootDir: dir,
      sessionId: "sess",
      startedAt: T0,
      from: "ar",
      to: "nl",
      srt: true,
      log: captureLog().log,
    });
    let key = "first";
    const t = setup({
      config: { transcripts: { recordProviderMessages: true } },
      ctx: {
        transcript: transcript.track("soniox"),
        fastBlocks: true,
        secrets: () => ({ sonioxApiKey: key }),
      },
    });
    t.track.openEngine();
    key = "replaced";
    t.track.openEngine();
    expect(t.f.requests.map((r) => [r.recordFile, r.secrets?.sonioxApiKey, r.fastBlocks])).toEqual([
      [join(transcript.track("soniox").dir, "provider.jsonl"), "first", true],
      [join(transcript.track("soniox").dir, "provider-2.jsonl"), "replaced", true],
    ]);
  });

  it("does not record provider messages without a transcript", () => {
    const t = setup({ config: { transcripts: { recordProviderMessages: true } } });
    t.track.openEngine();
    expect(t.f.requests[0]?.recordFile).toBeNull();
  });

  it("lets the factory's EngineUnavailableError through", () => {
    const t = setup();
    t.f.failWith = new EngineUnavailableError("SONIOX_API_KEY is not set");
    expect(() => t.track.openEngine()).toThrow("SONIOX_API_KEY is not set");
    expect(t.track.currentEngine).toBeNull();
  });

  it("switches engines: the new one gets the audio, the old one is stopped gracefully", async () => {
    const t = setup();
    const first = t.track.openEngine();
    await flush();
    const second = t.track.createEngine();
    expect(t.track.use(second)).toBe(first);
    expect(t.track.use(second)).toBeNull();
    await t.track.stopEngine(first, { fast: false });
    t.track.sendFrame(toneFrame(), Date.now());
    expect(t.f.providers.map((p) => p.frames)).toEqual([0, 1]);
    expect(t.f.providers[0]?.stopCalls).toEqual([undefined]);
    // openEngine() stops the engine it replaces by itself.
    t.track.openEngine();
    await flush();
    expect(t.f.providers[1]?.stopCalls).toEqual([undefined]);
    expect(second.closedAt).toBe(Date.now());
  });

  it("sends audio only to a running engine and survives a provider that throws", async () => {
    const t = setup({ providers: [{ sendAudioThrows: true }] });
    t.track.sendFrame(toneFrame(), Date.now());
    const inst = t.track.openEngine();
    t.track.sendFrame(toneFrame(), Date.now());
    t.track.sendFrame(toneFrame(), Date.now() + 100);
    expect(inst.framesSent).toBe(2);
    expect(inst.timeline.frames).toBe(2);
    expect(t.cap.messages(WARN)).toEqual(["sendAudio threw", "sendAudio threw"]);
    await t.track.closeCurrent({ fast: false });
    t.track.sendFrame(toneFrame(), Date.now());
    expect(inst.framesSent).toBe(2);
  });

  it("finalize() asks the current engine to close its utterance", async () => {
    const t = setup({ providers: [{ finalizeThrows: true }] });
    t.track.finalize();
    t.track.openEngine();
    t.track.finalize();
    expect(t.f.providers[0]?.finalizeCalls).toBe(1);
    expect(t.cap.messages(WARN)).toEqual(["finalize threw"]);
    await t.track.closeCurrent({ fast: true });
    t.track.finalize();
    expect(t.f.providers[0]?.finalizeCalls).toBe(1);
    await t.track.closeCurrent({ fast: true });
  });
});

describe("Track.waitLive", () => {
  it("resolves true once the engine connects", async () => {
    const t = setup({ providers: [{ start: "manual" }] });
    const inst = t.track.openEngine();
    const live = t.track.waitLive(inst, 5000);
    t.f.providers[0]?.connect();
    expect(await live).toBe(true);
    expect(inst.liveWaiters).toEqual([]);
  });

  it("resolves false on a timeout, a stop or a failed engine", async () => {
    const t = setup({ providers: [{ start: "manual" }] });
    const inst = t.track.openEngine();
    const timedOut = t.track.waitLive(inst, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await timedOut).toBe(false);
    const stopped = t.track.waitLive(inst, 60_000);
    const stopping = t.track.stopEngine(inst, { fast: true });
    expect(await stopped).toBe(false);
    await stopping;
    expect(await t.track.waitLive(inst, 1000)).toBe(false);
    // A failed engine answers at once too.
    const t2 = setup({ providers: [{ start: "manual" }] });
    const other = t2.track.openEngine();
    const waiting = t2.track.waitLive(other, 60_000);
    t2.f.providers[0]?.failStart("connect refused");
    expect(await waiting).toBe(false);
    expect(await t2.track.waitLive(other, 1000)).toBe(false);
  });

  it("an engine stopped before its connect finished never counts as live", async () => {
    const t = setup({ providers: [{ start: "manual" }] });
    const inst = t.track.openEngine();
    void t.track.stopEngine(inst, { fast: true });
    t.f.providers[0]?.connect();
    await flush();
    expect(inst.live).toBe(false);
  });
});

describe("Track provider events", () => {
  it("turns tokens and endpoints into segments", async () => {
    const t = setup();
    t.track.openEngine();
    const p = t.f.providers[0];
    p?.tokens([src("الحمد", 0, 400), tr("Alle lof")]);
    p?.endpoint();
    vi.advanceTimersByTime(100);
    expect(t.segments.at(-1)).toMatchObject({ source: { text: "الحمد" }, closed: true });
    expect(t.track.status(Date.now()).segments).toBe(1);
  });

  it("marks reconnects and state changes, and records errors", async () => {
    const t = setup();
    t.track.openEngine();
    await flush();
    const p = t.f.providers[0];
    p?.emit({ type: "reconnected", gapMs: 1200, audioOffsetMs: 3000 });
    p?.emit({ type: "state", state: "live" });
    p?.emit({ type: "state", state: "live", detail: "resumed" });
    p?.emit({ type: "state", state: "reconnecting" });
    p?.emit({ type: "error", fatal: false, message: "socket closed" });
    expect(t.markers.slice(1).map((m) => [m.type, m.data, m.line])).toEqual([
      [
        "reconnect",
        { track: "soniox", engine: "soniox#1", gapMs: 1200, audioOffsetMs: 3000 },
        "soniox: provider reconnected after a 1200 ms gap",
      ],
      [
        "provider-state",
        { track: "soniox", engine: "soniox#1", state: "live", detail: "resumed" },
        "soniox: provider live (resumed)",
      ],
      [
        "provider-state",
        { track: "soniox", engine: "soniox#1", state: "reconnecting", detail: null },
        "soniox: provider reconnecting",
      ],
      [
        "error",
        { track: "soniox", engine: "soniox#1", fatal: false, message: "socket closed" },
        "soniox: provider error: socket closed",
      ],
    ]);
    expect(t.track.lastError).toBe("socket closed");
    expect(t.track.status(Date.now()).lastError).toBe("socket closed");
    expect(t.failures).toEqual([]);
  });

  it("a fatal error stops the engine, blocks new ones and reports the failure", async () => {
    const t = setup();
    const inst = t.track.openEngine();
    await flush();
    t.f.providers[0]?.emit({ type: "error", fatal: true, message: "401 Unauthorized" });
    expect(t.markers.at(-1)?.line).toBe("soniox: provider error (fatal): 401 Unauthorized");
    expect(inst.failed).toBe(true);
    expect(t.track.fatal).toBe(true);
    expect(t.failures).toEqual([{ message: "401 Unauthorized", fatal: true }]);
    await flush();
    expect(t.f.providers[0]?.stopCalls).toEqual([{ fast: true }]);
    expect(t.track.providerState()).toBe("error");
    // A second fatal error of the same engine changes nothing.
    t.f.providers[0]?.emit({ type: "error", fatal: true, message: "again" });
    expect(t.failures).toHaveLength(1);
  });

  it("a failed connect is reported as fatal only when the provider gave up", async () => {
    const t = setup({ providers: [{ start: "manual" }] });
    const inst = t.track.openEngine();
    t.f.providers[0]?.failStart("connect refused");
    await flush();
    expect(t.failures).toEqual([{ message: "connect refused", fatal: false }]);
    expect(t.track.fatal).toBe(false);
    expect(t.track.lastError).toBe("connect refused");
    expect(inst.failed).toBe(true);
    expect(t.cap.messages(WARN)).toContain("provider start failed");
    t.track.openEngine();
    t.f.providers[1]?.failStart("invalid key", true);
    await flush();
    expect(t.failures.at(-1)).toEqual({ message: "invalid key", fatal: true });
    expect(t.track.fatal).toBe(true);
  });

  it("reports a connect that failed with something other than an Error", async () => {
    const t = setup({ providers: [{ start: "manual" }] });
    t.track.openEngine();
    t.f.providers[0]?.rejectStart("network unreachable");
    await flush();
    expect(t.failures).toEqual([{ message: "network unreachable", fatal: false }]);
  });

  it("treats a provider whose start throws like a failed connect", async () => {
    const t = setup({ providers: [{ start: "throw" }] });
    t.track.openEngine();
    await flush();
    expect(t.failures).toEqual([{ message: "start threw synchronously", fatal: false }]);
  });

  it("ignores a failed connect of an engine that is already stopping", async () => {
    const t = setup({ providers: [{ start: "manual" }] });
    const first = t.track.openEngine();
    void t.track.stopEngine(first, { fast: true });
    t.f.providers[0]?.failStart("late failure");
    await flush();
    expect(t.failures).toEqual([]);
    expect(t.track.lastError).toBeUndefined();
    expect(first.failed).toBe(false);
  });

  it("a fatal error of an engine that is not current does not stop the track", async () => {
    const t = setup();
    const first = t.track.openEngine();
    await flush();
    const second = t.track.createEngine();
    t.track.use(second);
    t.f.providers[0]?.emit({ type: "error", fatal: true, message: "old one died" });
    expect(first.failed).toBe(true);
    expect(t.track.fatal).toBe(false);
    expect(t.failures).toEqual([]);
  });
});

describe("Track stop", () => {
  it("stops an engine once: closes its segment, accrues cost and usage, marks it", async () => {
    const t = setup();
    const inst = t.track.openEngine();
    await flush();
    t.f.providers[0]?.tokens([src("بسم", 0, 300)]);
    t.track.sendFrame(toneFrame(), Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
    const a = t.track.stopEngine(inst, { fast: false });
    expect(t.track.stopEngine(inst, { fast: true })).toBe(a);
    await a;
    expect(t.f.providers[0]?.stopCalls).toEqual([undefined]);
    expect(t.segments.at(-1)).toMatchObject({ closed: true, source: { text: "بسم" } });
    expect(t.markers.at(-1)).toEqual({
      type: "engine-close",
      data: { track: "soniox", engine: "soniox#1", openMs: 60_000, framesSent: 1 },
      line: "soniox: engine soniox#1 closed after 60.0 s",
    });
    expect(t.track.engineOpenMs(Date.now() + 5000)).toBe(60_000);
    expect(t.track.takeUsageMs(Date.now())).toBe(60_000);
    expect(t.track.takeUsageMs(Date.now())).toBe(0);
    expect(t.track.costUsd(Date.now())).toBeCloseTo(0.18 / 60, 10);
    expect(t.track.costBreakdown(Date.now())).toBe("stream 1.00 min, $0.0030");
  });

  it("hard-closes a provider that does not stop in time", async () => {
    const t = setup({ providers: [{ stop: "manual" }] });
    const inst = t.track.openEngine();
    await flush();
    const stopping = t.track.stopEngine(inst, { fast: false });
    await vi.advanceTimersByTimeAsync(SWITCH_HARD_CLOSE_MS - 1);
    expect(inst.closedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(inst.closedAt).toBe(T0 + SWITCH_HARD_CLOSE_MS);
    expect(t.f.providers[0]?.stopCalls).toEqual([undefined, { fast: true }]);
    expect(t.cap.messages(WARN)).toContain("provider stop timed out; hard-closing");
  });

  it("ignores a hard close that fails too", async () => {
    const t = setup({ providers: [{ stop: "manual-then-reject" }] });
    const inst = t.track.openEngine();
    const stopping = t.track.stopEngine(inst, { fast: false });
    await vi.advanceTimersByTimeAsync(SWITCH_HARD_CLOSE_MS);
    await stopping;
    expect(t.f.providers[0]?.stopCalls).toEqual([undefined, { fast: true }]);
    expect(inst.closedAt).toBe(T0 + SWITCH_HARD_CLOSE_MS);
    expect(t.markers.at(-1)?.type).toBe("engine-close");
  });

  it("counts a closing engine's time exactly once in what its last segment's callbacks see", async () => {
    let seen: { openMs: number; usd: number } | null = null;
    const t = setup({
      ctx: {
        hooks: {
          onSegment: (_track, seg) => {
            if (seg.closed && seen === null) {
              seen = { openMs: t.track.engineOpenMs(Date.now()), usd: t.track.costUsd(Date.now()) };
            }
          },
          onChange: () => {},
          onMarker: () => {},
          onFailure: () => {},
        },
      },
    });
    const inst = t.track.openEngine();
    await flush();
    t.f.providers[0]?.tokens([src("بسم", 0, 300)]);
    await vi.advanceTimersByTimeAsync(60_000);
    await t.track.stopEngine(inst, { fast: true });
    expect(seen).toEqual({ openMs: 60_000, usd: t.track.costUsd(Date.now()) });
    expect(t.track.costUsd(Date.now())).toBeCloseTo(0.18 / 60, 10);
  });

  it("uses the fast hard-close time for fast stops and goes on when stop fails", async () => {
    const t = setup({ providers: [{ stop: "manual" }, { stop: "reject" }] });
    const slow = t.track.openEngine();
    const stopping = t.track.stopEngine(slow, { fast: true });
    await vi.advanceTimersByTimeAsync(FAST_HARD_CLOSE_MS);
    await stopping;
    expect(slow.closedAt).toBe(T0 + FAST_HARD_CLOSE_MS);
    const failing = t.track.openEngine();
    await t.track.stopEngine(failing, { fast: true });
    expect(failing.closedAt).toBe(Date.now());
    expect(t.cap.messages(WARN)).toContain("provider stop failed");
  });

  it("shutdown() stops every engine and deactivates the track", async () => {
    const t = setup({ providers: [{ stop: "manual" }] });
    t.track.active = true;
    t.track.openEngine();
    t.track.createEngine();
    const done = t.track.shutdown({ fast: false });
    expect(t.track.active).toBe(false);
    await vi.advanceTimersByTimeAsync(STOP_HARD_CLOSE_MS);
    await done;
    expect(t.f.providers.map((p) => p.stopCalls[0])).toEqual([undefined, undefined]);
    expect(t.types().filter((x) => x === "engine-close")).toHaveLength(2);
    const fast = setup({ providers: [{ stop: "manual" }] });
    fast.track.openEngine();
    const quick = fast.track.shutdown({ fast: true });
    await vi.advanceTimersByTimeAsync(FAST_HARD_CLOSE_MS);
    await quick;
    expect(fast.f.providers[0]?.stopCalls).toEqual([{ fast: true }, { fast: true }]);
  });

  it("closeCurrent() without an engine does nothing", async () => {
    const t = setup();
    await t.track.closeCurrent({ fast: false });
    expect(t.markers).toEqual([]);
  });
});

describe("Track accounting and status", () => {
  it("reports engine-open time once, for running and closed engines", async () => {
    const t = setup();
    const first = t.track.openEngine();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.track.takeUsageMs(Date.now())).toBe(10_000);
    await vi.advanceTimersByTimeAsync(5000);
    await t.track.stopEngine(first, { fast: true });
    t.track.openEngine();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.track.takeUsageMs(Date.now())).toBe(7000);
    expect(t.track.engineOpenMs(Date.now())).toBe(17_000);
    // A clock that went backwards never yields negative time.
    expect(t.track.takeUsageMs(Date.now() - 1000)).toBe(0);
  });

  it("reports status with latency, cost and closed segments", async () => {
    const t = setup();
    t.track.active = true;
    t.track.openEngine();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(t.track.status(Date.now())).toEqual({
      track: "soniox",
      active: true,
      provider: "live",
      latency: {
        source: { p50Ms: null, p95Ms: null, n: 0 },
        translation: { p50Ms: null, p95Ms: null, n: 0 },
      },
      vadLatency: null,
      costUsd: 0.09,
      segments: 0,
    });
  });

  it("feeds done segments to the latency metrics and the transcript", async () => {
    const dir = temp.make();
    const transcript = new SessionTranscript({
      rootDir: dir,
      sessionId: "sess",
      startedAt: T0,
      from: "ar",
      to: "nl",
      srt: true,
      log: captureLog().log,
    });
    transcript.materialize();
    const t = setup({ ctx: { transcript: transcript.track("soniox") } });
    t.track.openEngine();
    await flush();
    const before = t.changes();
    t.f.providers[0]?.tokens([src("الحمد", 0, 400), src(" لله", 400, 800), tr("Alle lof")]);
    vi.advanceTimersByTime(500);
    t.f.providers[0]?.endpoint();
    expect(t.changes()).toBeGreaterThan(before);
    expect(t.track.latency.source.stats().n).toBe(1);
    const saved = readFileSync(join(transcript.track("soniox").dir, "segments.jsonl"), "utf8");
    expect(saved).toContain("الحمد لله");
  });

  it("logs translations that arrived too late at debug level", () => {
    const t = setup();
    t.track.openEngine();
    t.f.providers[0]?.tokens([tr("te laat")]);
    expect(t.cap.messages(20)).toContain("late translation dropped");
  });
});

describe("Track long-utterance guard", () => {
  const words = (n: number) =>
    Array.from({ length: n }, (_, i) => src(i === 0 ? "كلمة" : " كلمة", i * 300, i * 300 + 300));

  it("is off unless a word or time limit is configured", () => {
    const t = setup();
    t.track.openEngine();
    t.f.providers[0]?.tokens(words(50));
    t.track.sendFrame(silentFrame(), Date.now());
    expect(t.f.providers[0]?.finalizeCalls).toBe(0);
  });

  it("finalizes a long segment at the next silence, once per segment", () => {
    const t = setup({ config: { stt: { soniox: { forceFinalizeAfterWords: 3 } } } });
    t.track.openEngine();
    const p = t.f.providers[0];
    t.track.sendFrame(silentFrame(), Date.now());
    p?.tokens(words(2));
    t.track.sendFrame(silentFrame(), Date.now());
    expect(p?.finalizeCalls).toBe(0);
    p?.tokens([src(" كلمة", 600, 900)]);
    vi.advanceTimersByTime(2400);
    t.track.sendFrame(silentFrame(), Date.now());
    t.track.sendFrame(silentFrame(), Date.now());
    expect(p?.finalizeCalls).toBe(1);
    expect(t.markers.at(-1)).toEqual({
      type: "guard",
      data: {
        track: "soniox",
        engine: "soniox#1",
        seq: 1,
        words: 3,
        ageMs: 2400,
        forced: false,
      },
      line: "soniox: long-utterance guard finalized segment 1 (3 words, 2 s)",
    });
  });

  it("waits while the imam speaks, unless the segment is half again over the limit", () => {
    const t = setup({ config: { stt: { soniox: { forceFinalizeAfterWords: 4 } } } });
    t.track.openEngine();
    const p = t.f.providers[0];
    for (let i = 0; i < 3; i++) t.track.sendFrame(toneFrame(), Date.now());
    p?.tokens(words(5));
    t.track.sendFrame(toneFrame(), Date.now());
    expect(p?.finalizeCalls).toBe(0);
    p?.tokens([src(" كلمة", 1500, 1800)]);
    t.track.sendFrame(toneFrame(), Date.now());
    expect(p?.finalizeCalls).toBe(1);
    expect(t.markers.at(-1)?.data).toMatchObject({ words: 6, forced: true });
    expect(t.markers.at(-1)?.line).toContain(", forced)");
  });

  it("also guards by segment age, and skips the level check for odd frames", () => {
    const t = setup({ config: { stt: { soniox: { forceFinalizeAfterMs: 10_000 } } } });
    t.track.openEngine();
    const p = t.f.providers[0];
    p?.tokens(words(1));
    vi.advanceTimersByTime(9_999);
    t.track.sendFrame(new Uint8Array(3), Date.now());
    expect(p?.finalizeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    t.track.sendFrame(new Uint8Array(3), Date.now());
    expect(p?.finalizeCalls).toBe(1);
    expect(t.markers.at(-1)?.data).toMatchObject({ ageMs: 10_000, forced: false });
    // Forced by age while speaking.
    p?.endpoint();
    p?.tokens(words(1));
    for (let i = 0; i < 3; i++) t.track.sendFrame(toneFrame(), Date.now());
    vi.advanceTimersByTime(15_000);
    t.track.sendFrame(toneFrame(), Date.now());
    expect(p?.finalizeCalls).toBe(2);
    expect(t.markers.at(-1)?.data).toMatchObject({ seq: 2, forced: true });
  });

  it("counts a segment of whitespace as zero words", () => {
    const t = setup({ config: { stt: { soniox: { forceFinalizeAfterMs: 1000 } } } });
    t.track.openEngine();
    t.f.providers[0]?.tokens([], [src(" ", 0, 100)]);
    vi.advanceTimersByTime(1000);
    t.track.sendFrame(silentFrame(), Date.now());
    expect(t.markers.at(-1)?.data).toMatchObject({ words: 0, ageMs: 1000 });
  });
});
