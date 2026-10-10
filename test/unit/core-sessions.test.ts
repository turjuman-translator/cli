import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passThroughFollower } from "../../src/compose/fast-blocks.js";
import type { Secrets } from "../../src/config.js";
import { type AudioInputSpec, SessionError } from "../../src/core/contracts.js";
import { FIRST_FRAME_TIMEOUT_MS, RESUME_FIRST_FRAME_TIMEOUT_MS } from "../../src/core/session.js";
import { SessionManager, type SessionManagerOptions } from "../../src/core/sessions.js";
import type { ServerMessage } from "../../src/shared/protocol.js";
import {
  type ControlledOptions,
  captureLog,
  controlledFactory,
  ERROR,
  KEYS,
  ManualInput,
  NO_KEYS,
  silentFrame,
  tempDirs,
  testConfig,
  toneFrame,
  WARN,
} from "./helpers/core-fakes.js";

const T0 = new Date(2026, 9, 9, 13, 0, 0).getTime();
const temp = tempDirs("core-sessions-");

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

const DEVICE = { audio: { input: { kind: "device", device: "Line In" } } };
const PAGE_REQ = {
  from: "ar",
  to: "nl",
  keyId: null,
  keyLabel: null,
  client: { obs: false, ua: "test" },
};

function manager(
  over: {
    config?: Record<string, unknown>;
    secrets?: Secrets;
    options?: Partial<SessionManagerOptions>;
    input?: (spec: AudioInputSpec) => ManualInput;
    providers?: ControlledOptions[];
  } = {},
) {
  const dataDir = temp.make();
  const loaded = testConfig(dataDir, over.config ?? {}, over.secrets ?? KEYS);
  const f = controlledFactory(...(over.providers ?? []));
  const cap = captureLog();
  const inputs: ManualInput[] = [];
  const m = new SessionManager({
    loaded,
    engineFactory: f.factory,
    audioInputFactory: (spec) => {
      const input = over.input?.(spec) ?? new ManualInput(spec);
      inputs.push(input);
      return input;
    },
    log: cap.log,
    version: "1.2.3",
    now: () => Date.now(),
    ...over.options,
  });
  return { m, f, cap, inputs, loaded, dataDir };
}

/** startLocal with the first frame delivered as soon as the input starts. */
async function startLocal(
  x: ReturnType<typeof manager>,
  req: Parameters<SessionManager["startLocal"]>[0] = { source: "device" },
) {
  const before = x.inputs.length;
  const result = x.m.startLocal(req);
  for (let i = 0; i < 10 && x.inputs.length === before; i++) await flush();
  x.inputs.at(-1)?.frame();
  await flush();
  return result;
}

describe("SessionManager: page sessions", () => {
  it("creates as many page sessions as pages ask for and lists them", async () => {
    const x = manager();
    const pages = Array.from({ length: 12 }, (_, i) =>
      x.m.createPage({ ...PAGE_REQ, keyLabel: `page ${i}` }),
    );
    const [a, b] = pages;
    expect(new Set(pages.map((p) => p.id)).size).toBe(12);
    expect(x.m.get(a?.id ?? "")).toBe(a);
    expect(x.m.get("nope")).toBeUndefined();
    expect(x.m.list().map((s) => s.id)).toEqual(pages.map((p) => p.id));
    await a?.stop("done");
    expect(x.m.get(a?.id ?? "")).toBeUndefined();
    expect(x.m.list()).toHaveLength(11);
    expect(x.m.list()[0]?.id).toBe(b?.id);
    const c = x.m.createPage(PAGE_REQ);
    expect(x.m.list()).toHaveLength(12);
    await x.m.stopAll("test");
    expect(x.m.get(c.id)).toBeUndefined();
    expect(x.m.list()).toEqual([]);
  });

  it("reports a page's streamed time to its usage callback, on the system clock by default", async () => {
    const x = manager({ options: { now: undefined } });
    const usage: number[] = [];
    const s = x.m.createPage({ ...PAGE_REQ, onUsage: (_engine, ms) => usage.push(ms) });
    s.speech("start");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(usage).toEqual([10_000]);
    expect(x.m.health().uptimeMs).toBe(10_000);
    await x.m.stopAll("test");
  });

  it("knows each page session's organisation", async () => {
    const x = manager();
    const own = x.m.createPage({ ...PAGE_REQ, orgId: "masjid-1" });
    const local = x.m.createPage(PAGE_REQ);
    expect(x.m.orgOf(own.id)).toBe("masjid-1");
    expect(x.m.orgOf(local.id)).toBe("local");
    expect(x.m.orgOf("unknown")).toBeNull();
    await own.stop("done");
    expect(x.m.orgOf(own.id)).toBeNull();
    await x.m.stopAll("test");
  });

  it("uses each organisation's own keys", async () => {
    const asked: string[] = [];
    const x = manager({
      secrets: NO_KEYS,
      options: {
        keys: (orgId) => {
          asked.push(orgId);
          return { sonioxApiKey: orgId === "paid" ? "org-key" : null };
        },
      },
    });
    const s = x.m.createPage({ ...PAGE_REQ, orgId: "paid" });
    s.speech("start");
    expect(x.f.requests[0]?.secrets).toEqual({ sonioxApiKey: "org-key" });
    expect(() => x.m.createPage({ ...PAGE_REQ, orgId: "free" })).toThrow(
      new SessionError(
        "engine_unavailable",
        "No Soniox key yet: add it in the app under Keys (or with turjuman setup)",
      ),
    );
    expect(asked).toContain("free");
    await x.m.stopAll("test");
  });

  it("uses the server's keys by default and words a missing key for hosted mode", async () => {
    const x = manager({ secrets: NO_KEYS, config: { mode: "hosted", ...DEVICE } });
    expect(() => x.m.createPage(PAGE_REQ)).toThrow(
      new SessionError(
        "engine_unavailable",
        "This mosque has no Soniox key yet: add it in the app under Keys",
      ),
    );
    expect(await x.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "This mosque has no Soniox key yet: add it in the app under Keys",
    });
  });

  it("refuses new sessions while shutting down", async () => {
    const x = manager();
    await x.m.stopAll("shutdown");
    expect(() => x.m.createPage(PAGE_REQ)).toThrow(
      new SessionError("engine_unavailable", "the server is shutting down"),
    );
    expect(await x.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "the server is shutting down",
    });
  });
});

describe("SessionManager: layouts and block dependencies", () => {
  it("falls back to the rollup layout without block dependencies (logged once)", async () => {
    const x = manager();
    const a = x.m.createPage(PAGE_REQ);
    x.m.createPage(PAGE_REQ);
    expect(a.status().layout).toBe("rollup");
    expect(
      x.cap.messages(WARN).filter((m) => m === "layout blocks falls back to rollup"),
    ).toHaveLength(1);
    await x.m.stopAll("test");
  });

  it("gives a session the blocks layout with its own detector and follower", async () => {
    let detectors = 0;
    const followers: string[] = [];
    const x = manager({
      options: {
        blocks: {
          detectorFactory: () => {
            detectors++;
            return null;
          },
          followerFactory: (lang) => {
            followers.push(lang);
            return passThroughFollower();
          },
        },
      },
    });
    const a = x.m.createPage(PAGE_REQ);
    const b = x.m.createPage({ ...PAGE_REQ, to: "en" });
    const rollup = x.m.createPage({ ...PAGE_REQ, layout: "rollup" });
    expect([a.status().layout, b.status().layout, rollup.status().layout]).toEqual([
      "blocks",
      "blocks",
      "rollup",
    ]);
    expect(detectors).toBe(2);
    expect(followers).toEqual(["nl", "en"]);
    await x.m.stopAll("test");
  });

  it("disables events when the detector cannot be created", async () => {
    const x = manager({
      options: {
        blocks: {
          detectorFactory: () => {
            throw new Error("bad phrases file");
          },
        },
      },
    });
    const s = x.m.createPage(PAGE_REQ);
    expect(s.status().layout).toBe("blocks");
    expect(x.cap.messages(ERROR)).toContain("event detector could not be created; events disabled");
    await x.m.stopAll("test");
  });

  it("reports a local session that cannot be built", async () => {
    const x = manager({
      config: DEVICE,
      options: {
        blocks: {
          detectorFactory: () => null,
          followerFactory: () => {
            throw new Error("Quran index corrupt");
          },
        },
      },
    });
    expect(await x.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "Quran index corrupt",
    });
    expect(x.cap.messages(ERROR)).toContain("local session start failed");
    expect(x.m.local()).toBeNull();
    const notError = manager({
      config: DEVICE,
      options: {
        blocks: {
          detectorFactory: () => null,
          followerFactory: () => {
            throw "no data";
          },
        },
      },
    });
    expect(await notError.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "no data",
    });
  });
});

describe("SessionManager: glossaries", () => {
  function withGlossary(x: ReturnType<typeof manager>, name: string, text: string): void {
    mkdirSync(x.loaded.paths.glossariesDir, { recursive: true });
    writeFileSync(join(x.loaded.paths.glossariesDir, name), text);
  }

  it("gives the engine the pair's glossary, and none for auto or a missing one", async () => {
    const x = manager();
    withGlossary(x, "ar-nl.yaml", "context: Vrijdagpreek\nterms: [التقوى]\n");
    x.m.createPage(PAGE_REQ).speech("start");
    x.m.createPage({ ...PAGE_REQ, from: "auto" }).speech("start");
    x.m.createPage({ ...PAGE_REQ, to: "en" }).speech("start");
    expect(x.f.requests.map((r) => r.glossary?.terms ?? null)).toEqual([["التقوى"], null, null]);
    await x.m.stopAll("test");
  });

  it("logs a glossary's warnings and goes on without a broken one", async () => {
    const x = manager();
    const many = Array.from({ length: 41 }, (_, i) => `  - { source: "w${i}", target: "t${i}" }`);
    withGlossary(x, "ar-nl.yaml", `translation_terms:\n${many.join("\n")}\n`);
    withGlossary(x, "ar-en.yaml", "terms: 5\n");
    x.m.createPage(PAGE_REQ).speech("start");
    x.m.createPage({ ...PAGE_REQ, to: "en" }).speech("start");
    expect(x.f.requests[0]?.glossary?.translation_terms).toHaveLength(41);
    expect(x.f.requests[1]?.glossary).toBeNull();
    expect(x.cap.messages(WARN).some((m) => m.includes("41 translation_terms"))).toBe(true);
    expect(x.cap.messages(WARN)).toContain("glossary could not be loaded; continuing without it");
    await x.m.stopAll("test");
  });
});

describe("SessionManager: the local session", () => {
  it("starts on the configured device, refuses a second start and stops", async () => {
    const x = manager({
      config: { ...DEVICE, audio: { ...DEVICE.audio, monitorWhenIdle: false } },
    });
    expect(x.m.local()).toBeNull();
    expect(await startLocal(x)).toEqual({ ok: true, message: "live" });
    const local = x.m.local();
    expect(local?.status().state).toBe("live");
    expect(x.inputs.map((i) => i.spec)).toEqual([{ kind: "device", device: "Line In" }]);
    expect(x.m.get(local?.id ?? "")).toBe(local);
    expect(x.m.orgOf(local?.id ?? "")).toBe("local");
    expect(x.m.list().map((s) => s.kind)).toEqual(["device"]);
    expect(await x.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: `already live (session ${local?.id})`,
    });
    expect(await x.m.stopLocal("operator")).toEqual({ ok: true, message: "stopped (operator)" });
    expect(await x.m.stopLocal("again")).toEqual({
      ok: false,
      message: "no local session is running",
    });
    expect(x.m.list()).toEqual([]);
    expect(x.m.local()).toBe(local);
  });

  it("uses the first language hint as the source and the target language", async () => {
    const x = manager({
      config: {
        ...DEVICE,
        stt: { soniox: { languageHints: [] } },
        translation: { targetLanguage: "en" },
      },
    });
    await startLocal(x);
    expect(x.m.local()?.info()).toMatchObject({ from: "auto", to: "en" });
    await x.m.stopAll("test");
  });

  it("gives the local session the configured layout", async () => {
    const blocks = { detectorFactory: () => null };
    const rollup = manager({
      config: { ...DEVICE, display: { layout: "rollup" } },
      options: { blocks },
    });
    await startLocal(rollup);
    expect(rollup.m.local()?.status().layout).toBe("rollup");
    await rollup.m.stopAll("test");
    const fast = manager({ config: DEVICE, options: { blocks } });
    await startLocal(fast);
    expect(fast.m.local()?.status().layout).toBe("blocks");
    await fast.m.stopAll("test");
  });

  it("refuses a start while another one is in progress", async () => {
    const x = manager({ config: DEVICE });
    const first = x.m.startLocal({ source: "device" });
    expect(await x.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "a local session is starting or stopping",
    });
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    expect((await first).ok).toBe(false);
  });

  it("waits longer for the first frame when resuming after a restart", async () => {
    const x = manager({ config: DEVICE });
    const resumed = x.m.startLocal({ source: "device", resume: true });
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    x.inputs.at(-1)?.frame();
    expect(await resumed).toEqual({ ok: true, message: "live" });
    await x.m.stopAll("test");
    const plain = manager({ config: DEVICE });
    const started = plain.m.startLocal({ source: "device" });
    await vi.advanceTimersByTimeAsync(RESUME_FIRST_FRAME_TIMEOUT_MS);
    expect((await started).message).toContain("within 5 s");
  });

  it("replaces a stopped local session with a new one", async () => {
    const x = manager({ config: DEVICE });
    await startLocal(x);
    const first = x.m.local();
    await x.m.stopLocal("operator");
    await startLocal(x);
    expect(x.m.local()).not.toBe(first);
    expect(x.m.local()?.status().state).toBe("live");
    await x.m.stopAll("test");
  });

  it("waits for a previous local session that is still stopping", async () => {
    const x = manager({
      config: { ...DEVICE, audio: { ...DEVICE.audio, monitorWhenIdle: false } },
      providers: [{ stop: "manual" }, {}],
    });
    await startLocal(x);
    const previous = x.m.local();
    const stopping = x.m.stopLocal("operator");
    await flush();
    expect(previous?.status().state).toBe("stopping");
    const next = x.m.startLocal({ source: "device" });
    await flush();
    // The new input opens only once the old session has let go of its own.
    expect(x.inputs).toHaveLength(1);
    x.f.providers[0]?.finishStop();
    await stopping;
    await flush();
    expect(x.inputs).toHaveLength(2);
    x.inputs[1]?.frame();
    expect(await next).toEqual({ ok: true, message: "live" });
    expect(x.m.local()).not.toBe(previous);
    expect(previous?.status().state).toBe("idle");
    await x.m.stopAll("test");
  });

  it("builds file inputs from the request or the config", async () => {
    const x = manager({ config: { audio: { monitorWhenIdle: false } } });
    expect(await startLocal(x, { source: "file", file: "/media/a.wav" })).toMatchObject({
      ok: true,
    });
    await x.m.stopLocal("next");
    expect(await startLocal(x, { source: "file", file: "/media/b.wav", loop: true })).toMatchObject(
      {
        ok: true,
      },
    );
    await x.m.stopLocal("next");
    expect(x.inputs.map((i) => i.spec)).toEqual([
      { kind: "file", path: "/media/a.wav", loop: false, startAtSec: 0 },
      { kind: "file", path: "/media/b.wav", loop: true, startAtSec: 0 },
    ]);
    expect(x.m.local()?.info().kind).toBe("file");
    expect(await x.m.startLocal({ source: "file" })).toEqual({
      ok: false,
      message: "no file given (and audio.input.path is not set)",
    });

    const configured = manager({
      config: {
        audio: { input: { kind: "file", path: "media/k.wav", loop: true, startAtSec: 12 } },
      },
    });
    await startLocal(configured, { source: "file" });
    await configured.m.stopLocal("next");
    await startLocal(configured, { source: "file", loop: false });
    await configured.m.stopLocal("next");
    await startLocal(configured, { source: "device" });
    await configured.m.stopAll("test");
    const path = join(configured.dataDir, "media", "k.wav");
    expect(configured.inputs.map((i) => i.spec)).toEqual([
      { kind: "file", path, loop: true, startAtSec: 12 },
      { kind: "file", path, loop: false, startAtSec: 12 },
      { kind: "file", path, loop: true, startAtSec: 12 },
    ]);
  });

  it("builds network inputs and refuses a device start without a usable input", async () => {
    const net = manager({
      config: {
        audio: {
          monitorWhenIdle: false,
          input: { kind: "network", network: { port: 7100, sampleRate: 44_100, channels: 1 } },
        },
      },
    });
    await startLocal(net);
    expect(net.inputs[0]?.spec).toEqual({
      kind: "network",
      port: 7100,
      sampleRate: 44_100,
      channels: 1,
    });
    expect(net.m.local()?.info()).toMatchObject({ kind: "device", inputKind: "network" });
    await net.m.stopAll("test");

    const none = manager();
    expect(await none.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "device capture is disabled (audio.input.kind: none)",
    });
    const noPath = manager({ config: { audio: { input: { kind: "file" } } } });
    expect(await noPath.m.startLocal({ source: "device" })).toEqual({
      ok: false,
      message: "audio.input.path is not set",
    });
  });

  it("includes the local session in /health", async () => {
    const x = manager({ config: { ...DEVICE, server: { exposure: "local" } } });
    const page = x.m.createPage(PAGE_REQ);
    vi.advanceTimersByTime(5000);
    expect(x.m.health()).toEqual({
      ok: true,
      version: "1.2.3",
      uptimeMs: 5000,
      exposure: "local",
      local: null,
      sessions: [page.summary()],
    });
    await startLocal(x);
    const health = x.m.health();
    expect(health.local?.state).toBe("live");
    expect(health.sessions.map((s) => s.kind)).toEqual(["device", "page"]);
    await x.m.stopAll("test");
  });

  it("stopAll() stops every session fast and logs failures", async () => {
    const x = manager({ config: DEVICE });
    const page = x.m.createPage(PAGE_REQ);
    page.speech("start");
    await startLocal(x);
    const local = x.m.local();
    // A session whose stop fails must not keep the others from stopping.
    const failing = x.m.createPage(PAGE_REQ);
    failing.stop = () => Promise.reject(new Error("stuck"));
    await x.m.stopAll("shutdown");
    expect(page.status().state).toBe("idle");
    expect(local?.status().state).toBe("idle");
    expect(x.f.providers.every((p) => p.stopCalls[0]?.fast === true)).toBe(true);
    expect(x.cap.messages(WARN)).toContain("stop during shutdown failed");
  });
});

describe("SessionManager: idle monitor", () => {
  it("shows the input's level and status before Start", async () => {
    const x = manager({ config: DEVICE });
    const seen: ServerMessage[] = [];
    const off = x.m.subscribeMonitor((msg) => seen.push(msg));
    expect(x.inputs).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: "status",
      status: {
        state: "idle",
        primary: "soniox",
        provider: "idle",
        audio: { state: "idle", rmsDbfs: null, lastFrameAgoMs: null, noSignal: false },
        latency: { p50Ms: null, p95Ms: null, n: 0 },
        tracks: [],
      },
    });
    const input = x.inputs[0];
    if (input === undefined) throw new Error("no monitor input");
    input.setState("ok", "ffmpeg started");
    input.setState("ok", null);
    for (let i = 0; i < 10; i++) {
      input.frame(i === 5 ? toneFrame(0.9) : toneFrame(0.1));
      vi.advanceTimersByTime(100);
    }
    const levels = seen.filter((m) => m.type === "level");
    expect(levels.length).toBeGreaterThanOrEqual(4);
    expect(levels.length).toBeLessThanOrEqual(6);
    const status = seen.filter((m) => m.type === "status").at(-1);
    expect(status).toMatchObject({
      status: { audio: { state: "ok", lastFrameAgoMs: 100, lastStderr: "ffmpeg started" } },
    });
    // Odd frames have no level; quiet audio turns into "no signal" after 10 s.
    input.frame(new Uint8Array(3));
    for (let i = 0; i < 101; i++) {
      input.frame(silentFrame());
      vi.advanceTimersByTime(100);
    }
    expect(seen.filter((m) => m.type === "status").at(-1)).toMatchObject({
      status: { audio: { noSignal: true } },
    });
    off();
    const count = seen.length;
    vi.advanceTimersByTime(2000);
    expect(seen.length).toBe(count);
    await x.m.stopAll("test");
    expect(input.stopped).toBe(true);
  });

  it("hands the input to the local session and takes it back after Stop", async () => {
    const x = manager({ config: DEVICE });
    x.m.startMonitor();
    x.m.startMonitor();
    expect(x.inputs).toHaveLength(1);
    expect(await startLocal(x)).toMatchObject({ ok: true });
    expect(x.inputs[0]?.stopped).toBe(true);
    expect(x.inputs).toHaveLength(2);
    // No monitor while the local session runs.
    x.m.subscribeMonitor(() => {});
    expect(x.inputs).toHaveLength(2);
    await x.m.stopLocal("operator");
    expect(x.inputs).toHaveLength(3);
    expect(x.inputs[2]?.started).toBe(true);
    await x.m.stopAll("test");
  });

  it("takes the input back when the local session stops by itself or fails to start", async () => {
    const x = manager({
      config: { audio: { input: { kind: "network" } }, session: { maxDurationMin: 1 } },
    });
    x.m.startMonitor();
    await startLocal(x);
    expect(x.inputs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(x.m.local()?.status().state).toBe("idle");
    expect(x.inputs).toHaveLength(3);
    expect(x.inputs[2]?.spec).toEqual({
      kind: "network",
      port: 7000,
      sampleRate: 48_000,
      channels: 2,
    });
    const failed = x.m.startLocal({ source: "device" });
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    expect((await failed).ok).toBe(false);
    expect(x.inputs).toHaveLength(5);
    expect(x.inputs[4]?.started).toBe(true);
    await x.m.stopAll("test");
  });

  it("has no monitor when it is off or the input is a file or none, and still says idle", async () => {
    const off = manager({ config: { audio: { ...DEVICE.audio, monitorWhenIdle: false } } });
    const file = manager({ config: { audio: { input: { kind: "file", path: "k.wav" } } } });
    const none = manager();
    for (const x of [off, file, none]) {
      const seen: ServerMessage[] = [];
      x.m.subscribeMonitor((msg) => seen.push(msg));
      expect(x.inputs).toHaveLength(0);
      // The control dock shows "idle" (it showed "unknown" without any status).
      expect(seen).toEqual([
        {
          type: "status",
          status: expect.objectContaining({
            state: "idle",
            audio: { state: "none", rmsDbfs: null, lastFrameAgoMs: null, noSignal: false },
            tracks: [],
          }),
        },
      ]);
    }
  });

  it("keeps working when a monitor listener throws", async () => {
    const x = manager({ config: DEVICE });
    x.m.subscribeMonitor(() => {
      throw new Error("socket closed");
    });
    const seen: ServerMessage[] = [];
    x.m.subscribeMonitor((msg) => seen.push(msg));
    x.inputs[0]?.frame();
    expect(seen.some((m) => m.type === "level")).toBe(true);
    expect(x.cap.messages(WARN).filter((m) => m === "monitor listener threw").length).toBe(2);
    await x.m.stopAll("test");
  });

  it("logs a monitor that cannot start or stop", async () => {
    const broken = manager({
      config: DEVICE,
      input: () => {
        throw new Error("device busy");
      },
    });
    broken.m.startMonitor();
    expect(broken.cap.messages(WARN)).toContain("idle audio monitor failed to start");
    const sticky = manager({ config: DEVICE });
    sticky.m.startMonitor();
    const input = sticky.inputs[0];
    if (input === undefined) throw new Error("no monitor input");
    input.stopBehaviour = "reject";
    await sticky.m.stopAll("test");
    expect(sticky.cap.messages(WARN)).toContain("idle audio monitor stop failed");
  });

  it("lets shutdown wait for a monitor that a Start is still releasing, and drops that Start", async () => {
    const x = manager({ config: DEVICE });
    x.m.startMonitor();
    const input = x.inputs[0];
    if (input === undefined) throw new Error("no monitor input");
    let release: () => void = () => {};
    input.stop = () => {
      input.stopped = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const starting = x.m.startLocal({ source: "device" });
    await flush();
    let shutDown = false;
    const shutdown = x.m.stopAll("test").then(() => {
      shutDown = true;
    });
    await flush();
    expect(shutDown).toBe(false);
    release();
    await shutdown;
    await flush();
    // No session (no audio input, no Soniox engine) may start after the shutdown.
    expect(x.inputs).toHaveLength(1);
    expect(x.m.local()).toBeNull();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    expect(await starting).toEqual({ ok: false, message: "the server is shutting down" });
  });
});
