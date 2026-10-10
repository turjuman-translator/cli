import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineUnavailableError } from "../../src/core/contracts.js";
import { newSessionId, USAGE_REPORT_MS } from "../../src/core/session.js";
import { src, tempDirs, toneFrame, tr, WARN } from "./helpers/core-fakes.js";
import { makeSession, type SessionSetup } from "./helpers/core-session.js";

const T0 = new Date(2026, 9, 9, 13, 0, 0).getTime();
const temp = tempDirs("core-session-page-");

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const page = (s: SessionSetup = {}) => makeSession(temp.make(), s);

describe("newSessionId", () => {
  it("makes 8 base32 characters, different each time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{8}$/);
  });
});

describe("page session: start", () => {
  it("is live at once, without an engine, and describes itself", async () => {
    const p = page({ options: { id: "pagetest", orgId: "org-7" } });
    const { session } = p;
    expect(session.id).toBe("pagetest");
    expect(session.running).toBe(true);
    expect(session.stopped).toBe(false);
    expect(session.layout).toBe("rollup");
    expect(session.info()).toEqual({
      id: "pagetest",
      kind: "page",
      startedAt: T0,
      from: "ar",
      to: "nl",
      source: "page",
      inputKind: "page",
      keyLabel: "Main hall",
    });
    expect(session.status()).toEqual({
      state: "live",
      primary: "soniox",
      provider: "idle",
      audio: { state: "idle", rmsDbfs: null, lastFrameAgoMs: null, noSignal: false },
      latency: { p50Ms: null, p95Ms: null, n: 0 },
      tracks: [
        {
          track: "soniox",
          active: true,
          provider: "idle",
          latency: {
            source: { p50Ms: null, p95Ms: null, n: 0 },
            translation: { p50Ms: null, p95Ms: null, n: 0 },
          },
          vadLatency: null,
          costUsd: 0,
          segments: 0,
        },
      ],
      session: session.info(),
      layout: "rollup",
      page: { speaking: false, engineOpen: false, streamedMinutes: 0 },
    });
    expect(session.summary()).toEqual({
      id: "pagetest",
      kind: "page",
      from: "ar",
      to: "nl",
      engines: ["soniox"],
      startedAt: T0,
      durationMs: 0,
      streamedMinutes: 0,
      latency: { p50Ms: null, p95Ms: null, n: 0 },
      state: "live",
      keyLabel: "Main hall",
      layout: "rollup",
    });
    expect(p.f.providers).toHaveLength(0);
    // An idle page leaves no transcript folder.
    expect(p.dir()).toBeNull();
    await session.stop("test");
    expect(p.dir()).toBeNull();
  });

  it("opens the engine at the first speech and sends the recent pre-roll first", async () => {
    const p = page();
    const { session } = p;
    // 3 old frames, then 12 recent ones: only 10 are kept, and only those ≤ 1.5 s old are sent.
    for (let i = 0; i < 3; i++) {
      session.pushFrame(toneFrame());
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 12; i++) {
      session.pushFrame(toneFrame());
      vi.advanceTimersByTime(100);
    }
    expect(p.f.providers).toHaveLength(0);
    session.speech("start");
    expect(p.f.providers).toHaveLength(1);
    expect(p.f.providers[0]?.frames).toBe(10);
    session.pushFrame(toneFrame());
    expect(p.f.providers[0]?.frames).toBe(11);
    await flush();
    const st = session.status();
    expect(st.page).toMatchObject({ speaking: true, engineOpen: true });
    expect(st.provider).toBe("live");
    expect(st.audio.state).toBe("ok");
    expect(st.audio.lastFrameAgoMs).toBe(0);
    expect(st.audio.rmsDbfs).toBeGreaterThan(-20);
    // The first engine open creates the transcript folder with the buffered start marker.
    expect(p.markers().map((m) => m.type)).toEqual(["start", "engine-open"]);
    expect(p.markers()[0]).toMatchObject({
      kind: "page",
      from: "ar",
      to: "nl",
      layout: "rollup",
      engines: "soniox",
      keyLabel: "Main hall",
    });
    await session.stop("test");
  });

  it("drops pre-roll frames older than 1.5 s", async () => {
    const p = page();
    p.session.pushFrame(toneFrame());
    vi.advanceTimersByTime(1600);
    p.session.pushFrame(toneFrame());
    p.session.speech("start");
    expect(p.f.providers[0]?.frames).toBe(1);
    await p.session.stop("test");
  });

  it("uses the system clock unless given one", async () => {
    const p = page({ options: { now: undefined } });
    expect(p.session.startedAt).toBe(T0);
    vi.advanceTimersByTime(1500);
    expect(p.session.summary().durationMs).toBe(1500);
    await p.session.stop("test");
  });

  it("writes the organisation in the start marker", async () => {
    const p = page({ options: { orgId: "org-7" }, page: { keyLabel: null } });
    expect(p.session.info().keyLabel).toBeUndefined();
    expect(p.session.summary().keyLabel).toBeUndefined();
    p.session.speech("start");
    expect(p.markers()[0]).toMatchObject({ type: "start", orgId: "org-7" });
    expect(p.markers()[0]?.keyLabel).toBeUndefined();
    await p.session.stop("test");
  });

  it("passes the organisation's keys to every engine", async () => {
    let key = "first";
    const p = page({ options: { secrets: () => ({ sonioxApiKey: key }) } });
    p.session.speech("start");
    expect(p.f.requests[0]?.secrets).toEqual({ sonioxApiKey: "first" });
    p.session.speech("end");
    key = "second";
    await vi.advanceTimersByTimeAsync(30_000);
    p.session.speech("start");
    expect(p.f.requests[1]?.secrets).toEqual({ sonioxApiKey: "second" });
    await p.session.stop("test");
  });
});

describe("page session: speech and silence", () => {
  it("finalizes at speech end and closes the engine after closeAfterSilenceSec", async () => {
    const usage: number[] = [];
    const p = page({
      config: { pages: { closeAfterSilenceSec: 2 } },
      page: { onUsage: (_engine, ms) => usage.push(ms) },
    });
    const { session } = p;
    session.speech("start");
    await flush();
    session.speech("end");
    session.speech("end");
    const provider = p.f.providers[0];
    expect(provider?.finalizeCalls).toBe(1);
    expect(session.status().page?.speaking).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(session.status().page?.engineOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider?.stopCalls).toEqual([undefined]);
    expect(session.status().page).toMatchObject({ engineOpen: false, streamedMinutes: 0.03 });
    expect(usage).toEqual([2000]);
    // The next speech opens a new engine.
    session.speech("start");
    expect(p.f.providers).toHaveLength(2);
    await session.stop("test");
  });

  it("keeps the engine when speech starts again before the silence closes it", async () => {
    const p = page({ config: { pages: { closeAfterSilenceSec: 2 } } });
    p.session.speech("start");
    p.session.speech("end");
    await vi.advanceTimersByTimeAsync(1500);
    p.session.speech("start");
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.session.status().page?.engineOpen).toBe(true);
    expect(p.f.providers).toHaveLength(1);
    await p.session.stop("test");
  });

  it("does not finalize at speech end when the config says so", async () => {
    const p = page({ config: { pages: { finalizeOnSpeechEnd: false } } });
    p.session.speech("start");
    p.session.speech("end");
    expect(p.f.providers[0]?.finalizeCalls).toBe(0);
    await p.session.stop("test");
  });

  it("shows audio as idle once frames stop for 2 s", async () => {
    const p = page();
    p.session.pushFrame(toneFrame());
    expect(p.session.status().audio.state).toBe("ok");
    vi.advanceTimersByTime(2000);
    expect(p.session.status().audio).toMatchObject({ state: "idle", lastFrameAgoMs: 2000 });
    // A frame of odd length still counts as a frame, without a level.
    p.session.pushFrame(new Uint8Array(3));
    expect(p.session.status().audio.lastFrameAgoMs).toBe(0);
    await p.session.stop("test");
  });

  it("reports engine-open time every 10 s while the engine is open", async () => {
    const usage: number[] = [];
    const p = page({ page: { onUsage: (_engine, ms) => usage.push(ms) } });
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_MS);
    // Nothing open, nothing to report.
    expect(usage).toEqual([]);
    p.session.speech("start");
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_MS);
    expect(usage).toEqual([10_000]);
    await vi.advanceTimersByTimeAsync(2500);
    await p.session.stop("test");
    expect(usage).toEqual([10_000, 2500]);
  });

  it("keeps going when the usage callback throws", async () => {
    const p = page({
      page: {
        onUsage: () => {
          throw new Error("db down");
        },
      },
    });
    p.session.speech("start");
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_MS);
    expect(p.cap.messages(WARN)).toContain("onUsage threw");
    await p.session.stop("test");
    expect(p.session.stopped).toBe(true);
  });

  it("sends a status every second while the engine is open", async () => {
    const p = page();
    await vi.advanceTimersByTimeAsync(3000);
    const idle = p.statuses().length;
    p.session.speech("start");
    await vi.advanceTimersByTimeAsync(3000);
    expect(p.statuses().length - idle).toBeGreaterThanOrEqual(3);
    await p.session.stop("test");
  });
});

describe("page session: engine problems", () => {
  it("shows a missing key and retries opening every 2 s while speaking", async () => {
    const p = page();
    p.f.failWith = new EngineUnavailableError("SONIOX_API_KEY is not set");
    p.session.speech("start");
    expect(p.session.status().error).toBe("SONIOX_API_KEY is not set");
    expect(p.session.status().tracks[0]?.lastError).toBe("SONIOX_API_KEY is not set");
    expect(p.cap.messages(WARN)).toContain("page engine failed to open");
    p.f.failWith = null;
    p.session.pushFrame(toneFrame());
    expect(p.f.providers).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    p.session.pushFrame(toneFrame());
    expect(p.f.providers).toHaveLength(1);
    await flush();
    // Live again: the connect error is cleared.
    expect(p.session.status().error).toBeUndefined();
    await p.session.stop("test");
  });

  it("has nothing to close after the silence when the engine already failed", async () => {
    const p = page({
      config: { pages: { closeAfterSilenceSec: 2 } },
      providers: [{ start: "manual" }],
    });
    p.session.speech("start");
    p.session.speech("end");
    p.f.providers[0]?.failStart("connect refused");
    await flush();
    expect(p.f.providers[0]?.stopCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.f.providers[0]?.stopCalls).toHaveLength(1);
    expect(p.session.status().page?.engineOpen).toBe(false);
    await p.session.stop("test");
  });

  it("does not reopen while silent", async () => {
    const p = page({ config: { pages: { closeAfterSilenceSec: 1 } } });
    p.session.speech("start");
    p.session.speech("end");
    await vi.advanceTimersByTimeAsync(1000);
    p.session.pushFrame(toneFrame());
    expect(p.f.providers).toHaveLength(1);
    await p.session.stop("test");
  });

  it("keeps the page on a failed connect and reconnects at the next speech frames", async () => {
    const p = page({ providers: [{ start: "manual" }, {}] });
    p.session.speech("start");
    p.f.providers[0]?.failStart("connect refused");
    await flush();
    expect(p.session.status()).toMatchObject({ state: "live", error: "connect refused" });
    vi.advanceTimersByTime(2000);
    p.session.pushFrame(toneFrame());
    expect(p.f.providers).toHaveLength(2);
    await flush();
    expect(p.session.status().error).toBeUndefined();
    await p.session.stop("test");
  });

  it("shows a fatal error and never opens another engine", async () => {
    const p = page();
    p.session.speech("start");
    await flush();
    p.f.providers[0]?.emit({ type: "error", fatal: true, message: "401 Unauthorized" });
    await flush();
    expect(p.session.status()).toMatchObject({ state: "error", error: "401 Unauthorized" });
    p.session.speech("end");
    p.session.speech("start");
    vi.advanceTimersByTime(5000);
    p.session.pushFrame(toneFrame());
    expect(p.f.providers).toHaveLength(1);
    await p.session.stop("test");
    expect(p.session.status().state).toBe("error");
  });

  it("reports the provider's reconnecting and error states", async () => {
    const p = page({ providers: [{ start: "manual" }] });
    p.session.speech("start");
    const provider = p.f.providers[0];
    if (provider === undefined) throw new Error("no provider");
    provider.state = "reconnecting";
    expect(p.session.status().state).toBe("reconnecting");
    provider.state = "error";
    expect(p.session.status().state).toBe("error");
    // A page keeps a non-fatal error while the engine is not live.
    p.f.providers[0]?.emit({ type: "error", fatal: false, message: "hiccup" });
    expect(p.session.status().tracks[0]?.lastError).toBe("hiccup");
    await p.session.stop("test");
  });
});

describe("page session: detach and attach", () => {
  it("survives a page reload within the grace period", async () => {
    const p = page({ config: { pages: { resumeGraceSec: 5 } } });
    p.session.speech("start");
    p.session.detach();
    // Detaching while speaking ends the speech.
    expect(p.f.providers[0]?.finalizeCalls).toBe(1);
    p.session.detach();
    await vi.advanceTimersByTimeAsync(4000);
    p.session.attach();
    p.session.attach();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.session.running).toBe(true);
    expect(p.markers().map((m) => m.type)).toEqual(expect.arrayContaining(["detach", "resume"]));
    expect(p.markers().find((m) => m.type === "detach")).toMatchObject({ graceMs: 5000 });
    await p.session.stop("test");
  });

  it("stops when the page does not come back", async () => {
    const p = page({ config: { pages: { resumeGraceSec: 5 } } });
    p.session.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.session.stopped).toBe(true);
    expect(p.stopped).toEqual([p.session]);
    expect(p.cap.lines.find((l) => l.msg === "session stopped")?.reason).toBe("page gone");
    p.session.detach();
    p.session.attach();
  });
});

describe("page session: captions", () => {
  it("sends segments to subscribers and includes them in the snapshot", async () => {
    const p = page();
    p.session.speech("start");
    await flush();
    p.f.providers[0]?.tokens([src("الحمد", 0, 400), tr("Alle lof")]);
    expect(p.of("segment").at(-1)?.segment.source.text).toBe("الحمد");
    const snaps = p.session.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      type: "snapshot",
      track: "soniox",
      session: p.session.info(),
      segments: [{ source: { text: "الحمد" }, translations: { nl: { text: "Alle lof" } } }],
    });
    expect(p.session.blocks()).toEqual({ blocks: [], hasMore: false });
    await p.session.stop("test");
  });

  it("clear() hides the captions, tells subscribers and marks it", async () => {
    const p = page();
    p.session.speech("start");
    p.f.providers[0]?.tokens([src("الحمد", 0, 400)]);
    p.session.clear();
    p.session.clear("soniox");
    expect(p.of("clear").map((m) => m.track)).toEqual(["all", "soniox"]);
    expect(p.of("blocks.snapshot")).toEqual([]);
    expect(p.session.snapshots()[0]).toMatchObject({ segments: [] });
    expect(
      p
        .markers()
        .filter((m) => m.type === "clear")
        .map((m) => m.track),
    ).toEqual(["all", "soniox"]);
    await p.session.stop("test");
  });

  it("ignores an event override without a block pipeline", async () => {
    const p = page();
    p.session.overrideEvent("athan");
    expect(p.cap.messages()).toContain("event override ignored (no block pipeline)");
    expect(p.markers()).toEqual([]);
    await p.session.stop("test");
  });

  it("a throwing listener does not stop the others", async () => {
    const p = page();
    p.session.subscribe(() => {
      throw new Error("socket gone");
    });
    const later: string[] = [];
    const off = p.session.subscribe((m) => later.push(m.type));
    p.session.clear();
    expect(later).toContain("clear");
    expect(p.cap.messages(WARN)).toContain("session listener threw");
    off();
    p.session.clear();
    expect(later.filter((t) => t === "clear")).toHaveLength(1);
    await p.session.stop("test");
  });
});

describe("page session: stop", () => {
  it("stops once: engines, transcript summary, final status, onStopped", async () => {
    const p = page();
    const { session } = p;
    session.speech("start");
    await flush();
    p.f.providers[0]?.tokens([src("الحمد", 0, 400), src(" لله", 400, 800), tr("Alle lof")]);
    p.f.providers[0]?.endpoint();
    await vi.advanceTimersByTimeAsync(60_000);
    const a = session.stop("operator");
    expect(session.stop("again")).toBe(a);
    expect(session.status().state).toBe("stopping");
    expect(session.running).toBe(false);
    await a;
    expect(session.stopped).toBe(true);
    expect(session.status().state).toBe("idle");
    expect(session.status().audio.state).toBe("idle");
    expect(p.statuses().at(-1)?.state).toBe("idle");
    expect(p.stopped).toEqual([session]);
    expect(session.summary()).toMatchObject({ engines: [], durationMs: 60_000, state: "idle" });
    vi.advanceTimersByTime(60_000);
    expect(session.summary().durationMs).toBe(60_000);
    const dir = p.dir();
    if (dir === null) throw new Error("no transcript folder");
    const log = readFileSync(join(dir, "session.log"), "utf8");
    expect(log).toContain("summary soniox: source");
    expect(log).toContain("stream 1.00 min");
    expect(log).toContain("stop: operator");
    expect(p.markers().at(-1)).toMatchObject({
      type: "stop",
      reason: "operator",
      durationMs: 60_000,
    });
    expect(readFileSync(join(dir, "soniox", "nl.srt"), "utf8")).toContain("Alle lof");
    // A stopped page ignores audio and speech.
    session.pushFrame(toneFrame());
    session.speech("start");
    expect(p.f.providers).toHaveLength(1);
  });

  it("logs an onStopped that throws", async () => {
    const p = page({
      options: {
        onStopped: () => {
          throw new Error("registry broken");
        },
      },
    });
    await p.session.stop("test");
    expect(p.cap.messages(WARN)).toContain("onStopped threw");
  });

  it("writes nothing when page transcripts are off", async () => {
    const p = page({ options: { saveTranscripts: false } });
    p.session.speech("start");
    await p.session.stop("test");
    expect(existsSync(p.loaded.paths.transcriptsDir)).toBe(false);
  });

  it("stops fast at shutdown", async () => {
    const p = page({ providers: [{ stop: "manual" }] });
    p.session.speech("start");
    const stopping = p.session.stop("shutdown", { fast: true });
    await vi.advanceTimersByTimeAsync(1500);
    await stopping;
    expect(p.f.providers[0]?.stopCalls).toEqual([{ fast: true }, { fast: true }]);
  });

  it("still ends when stopping throws, and logs it", async () => {
    const p = page();
    p.session.speech("start");
    const provider = p.f.providers[0];
    if (provider === undefined) throw new Error("no provider");
    provider.stop = () => {
      throw new Error("stop exploded");
    };
    await p.session.stop("test");
    expect(p.session.stopped).toBe(true);
    expect(p.cap.messages(50)).toContain("error while stopping session");
  });
});
