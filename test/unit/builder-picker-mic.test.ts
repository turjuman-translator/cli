// @vitest-environment happy-dom
// The builder's microphone helpers (web/picker-mic.ts): which devices have a name, the words for
// a refused microphone, and the "Test" level meter that listens only while asked and always lets
// the device go again. Run against a fake getUserMedia / enumerateDevices / AudioContext.
import { afterEach, describe, expect, it } from "vitest";
import {
  $,
  all,
  type Browser,
  byId,
  change,
  closeBrowser,
  doc,
  FakeAudioContext,
  FakeMedia,
  fire,
  importWeb,
  openBrowser,
  settle,
  sound,
  win,
} from "./helpers/builder-dom.js";
import {
  boot,
  click,
  disabled,
  hidden,
  linkSoFar,
  next,
  text,
  value,
} from "./helpers/builder-picker.js";

type State =
  | { kind: "starting" | "listening" | "heard" | "quiet" }
  | { kind: "error"; message: string };

interface Tester {
  readonly active: boolean;
  start(o: { mic: string; dsp: boolean; ch: "mix" | "left" | "right" }): Promise<void>;
  stop(): void;
}

interface Callbacks {
  onLevel(level: number): void;
  onState(state: State): void;
  onLabels(labels: string[]): void;
}

interface MicModule {
  micCapable(): boolean;
  micErrorText(err: unknown): string;
  knownMicLabels(): Promise<string[]>;
  requestMicLabels(): Promise<string[]>;
  MicTester: new (cb: Callbacks) => Tester;
}

interface Run {
  b: Browser;
  media: FakeMedia;
  mic: MicModule;
}

async function load(opts: { secure?: boolean; media?: FakeMedia | null } = {}): Promise<Run> {
  const b = openBrowser("picker", { url: "http://127.0.0.1:8765/", ...opts });
  const mic = await importWeb<MicModule>("web/picker-mic.ts");
  return { b, media: b.media ?? new FakeMedia(), mic };
}

/** A tester whose reports are kept in order. */
function recorder(mic: MicModule): {
  tester: Tester;
  states: string[];
  levels: number[];
  labels: string[][];
  cb: Callbacks;
} {
  const states: string[] = [];
  const levels: number[] = [];
  const labels: string[][] = [];
  const cb: Callbacks = {
    onLevel: (l) => levels.push(l),
    onState: (s) => states.push(s.kind === "error" ? `error:${s.message}` : s.kind),
    onLabels: (l) => labels.push(l),
  };
  return { tester: new mic.MicTester(cb), states, levels, labels, cb };
}

const MIX = { mic: "", dsp: false, ch: "mix" as const };

afterEach(() => closeBrowser());

describe("which browsers can use a microphone", () => {
  it("needs a secure page with getUserMedia", async () => {
    const { mic } = await load();
    expect(mic.micCapable()).toBe(true);
    await load({ secure: false });
    expect(mic.micCapable()).toBe(false);
    const none = await load({ media: null });
    expect(none.mic.micCapable()).toBe(false);
    const old = await load();
    (old.media as unknown as { getUserMedia: unknown }).getUserMedia = undefined;
    expect(old.mic.micCapable()).toBe(false);
  });

  it("names each kind of refusal", async () => {
    const { mic } = await load();
    const dom = (name: string): DOMException => new win.DOMException("x", name) as never;
    expect(mic.micErrorText(dom("NotAllowedError"))).toBe("mic.blocked");
    expect(mic.micErrorText(dom("SecurityError"))).toBe("mic.blocked");
    expect(mic.micErrorText(dom("NotFoundError"))).toBe("mic.notFound");
    expect(mic.micErrorText(dom("OverconstrainedError"))).toBe("mic.notFound");
    expect(mic.micErrorText(dom("NotReadableError"))).toBe("mic.busy");
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(mic.micErrorText(aborted)).toBe("mic.busy");
    expect(mic.micErrorText(new TypeError("x"))).toBe("mic.unavailable");
    expect(mic.micErrorText("NotAllowedError")).toBe("mic.unavailable");
  });
});

describe("the microphone names", () => {
  it("lists named inputs once, without the default and communications aliases", async () => {
    const { mic, media } = await load();
    // Before permission the browser hides the names.
    expect(await mic.knownMicLabels()).toEqual([]);
    expect(await mic.requestMicLabels()).toEqual(["Built-in Microphone", "USB Mixer"]);
    // The device asked for the names is let go at once.
    expect(media.streams[0]?.tracks.every((t) => t.stopped)).toBe(true);
    expect(await mic.knownMicLabels()).toEqual(["Built-in Microphone", "USB Mixer"]);
  });

  it("knows no names where it can't ask", async () => {
    const insecure = await load({ secure: false });
    expect(await insecure.mic.knownMicLabels()).toEqual([]);
    const noList = await load();
    (noList.media as unknown as { enumerateDevices: unknown }).enumerateDevices = undefined;
    expect(await noList.mic.knownMicLabels()).toEqual([]);
    const failing = await load();
    failing.media.enumerateError = new Error("gone");
    expect(await failing.mic.knownMicLabels()).toEqual([]);
  });

  it("lets the device go even when listing fails", async () => {
    const { mic, media } = await load();
    media.enumerateError = new Error("gone");
    await expect(mic.requestMicLabels()).rejects.toThrow("gone");
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
  });
});

describe("Test my microphone", () => {
  it("listens, shows the level and reports sound", async () => {
    const { b, mic, media } = await load();
    const r = recorder(mic);
    await r.tester.start({ mic: "", dsp: true, ch: "left" });
    expect(r.states).toEqual(["starting", "listening"]);
    expect(r.labels).toEqual([["Built-in Microphone", "USB Mixer"]]);
    expect(r.tester.active).toBe(true);
    expect(media.asked[0]).toEqual({
      audio: {
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // The context was suspended (no user gesture yet): resumed.
    expect(FakeAudioContext.made[0]?.state).toBe("running");
    sound.amplitude = 0.1; // -20 dBFS: speech
    for (let i = 0; i < 20; i++) b.frames.flush(16);
    expect(r.states).toEqual(["starting", "listening", "heard"]);
    // -20 dBFS is (−20 + 60) / 48 of the bar.
    expect(r.levels.at(-1)).toBeCloseTo(40 / 48, 5);
    // Quieter: the bar falls slowly.
    sound.amplitude = 0.001;
    b.frames.flush(16);
    expect(r.levels.at(-1)).toBeCloseTo((40 / 48) * 0.9, 5);
    r.tester.stop();
    expect(r.tester.active).toBe(false);
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(FakeAudioContext.made[0]?.closed).toBe(true);
    expect(b.frames.pending).toBe(0);
  });

  it("says when it hears nothing for seven seconds, and still reports a later sound", async () => {
    const { b, mic } = await load();
    const r = recorder(mic);
    FakeAudioContext.startState = "running";
    await r.tester.start(MIX);
    sound.amplitude = 0;
    for (let i = 0; i < 80; i++) b.frames.flush(100);
    expect(r.states).toEqual(["starting", "listening", "quiet"]);
    expect(r.levels.every((l) => l === 0)).toBe(true);
    sound.amplitude = 0.5;
    for (let i = 0; i < 4; i++) b.frames.flush(100);
    expect(r.states).toEqual(["starting", "listening", "quiet", "heard"]);
    r.tester.stop();
  });

  it("switches to the named microphone", async () => {
    const { mic, media } = await load();
    const r = recorder(mic);
    await r.tester.start({ mic: "Built-In", dsp: false, ch: "mix" });
    expect(media.asked).toHaveLength(2);
    expect(media.asked[1]).toMatchObject({
      audio: { deviceId: { exact: "builtin" }, channelCount: 1 },
    });
    // The first device (the default) was let go.
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(media.streams[1]?.tracks[0]?.stopped).toBe(false);
    expect(r.states).toEqual(["starting", "listening"]);
    r.tester.stop();
    expect(media.streams[1]?.tracks[0]?.stopped).toBe(true);
  });

  it("keeps the device it got when that is the named one or no device matches", async () => {
    const { mic, media } = await load();
    media.devices = [{ kind: "audioinput", label: "Only Mic", deviceId: "default" }];
    const r = recorder(mic);
    await r.tester.start({ mic: "only", dsp: false, ch: "mix" });
    await r.tester.start({ mic: "nothing like it", dsp: false, ch: "right" });
    expect(media.asked).toHaveLength(2);
    expect(r.states).toEqual(["starting", "listening", "starting", "listening"]);
    // A new start lets the earlier device go.
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
    r.tester.stop();
  });

  it("reports a refused or missing microphone", async () => {
    const { mic, media } = await load();
    media.error = new win.DOMException("denied", "NotAllowedError");
    const r = recorder(mic);
    await r.tester.start(MIX);
    expect(r.states).toEqual(["starting", "error:mic.blocked"]);
    expect(r.tester.active).toBe(false);
  });

  it("reports a browser that can't analyse the sound, and lets the device go", async () => {
    const { mic, media } = await load();
    FakeAudioContext.failNext = new win.DOMException("no audio", "NotSupportedError");
    const r = recorder(mic);
    await r.tester.start(MIX);
    expect(r.states).toEqual(["starting", "error:mic.unavailable"]);
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
  });

  it("keeps going when the context won't resume or close", async () => {
    const { mic } = await load();
    FakeAudioContext.resumeFails = true;
    FakeAudioContext.closeFails = true;
    const r = recorder(mic);
    await r.tester.start(MIX);
    expect(r.states).toEqual(["starting", "listening"]);
    r.tester.stop();
    await settle(1);
    expect(FakeAudioContext.made[0]?.closed).toBe(true);
  });

  it("drops a start that was stopped while the browser asked", async () => {
    const { mic, media } = await load();
    media.holdCalls.add(0);
    const r = recorder(mic);
    const started = r.tester.start(MIX);
    r.tester.stop();
    media.release();
    await started;
    expect(r.states).toEqual(["starting"]);
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(FakeAudioContext.made).toHaveLength(0);
  });

  it("drops a start that was stopped while it switched microphones", async () => {
    const { mic, media } = await load();
    media.holdCalls.add(1);
    const r = recorder(mic);
    const started = r.tester.start({ mic: "built-in", dsp: false, ch: "mix" });
    await settle(1);
    expect(media.asked).toHaveLength(2);
    r.tester.stop();
    media.release();
    await started;
    expect(r.states).toEqual(["starting"]);
    expect(media.streams.every((s) => s.tracks[0]?.stopped)).toBe(true);
    expect(FakeAudioContext.made).toHaveLength(0);
  });

  it("keeps quiet about a failure of a start that was stopped", async () => {
    const { mic, media } = await load();
    media.holdCalls.add(0);
    media.error = new win.DOMException("busy", "NotReadableError");
    const r = recorder(mic);
    const started = r.tester.start(MIX);
    r.tester.stop();
    media.release();
    await started;
    expect(r.states).toEqual(["starting"]);
  });

  it("ends the meter when a report stops the test", async () => {
    const { b, mic } = await load();
    const states: string[] = [];
    let levels = 0;
    const tester = new mic.MicTester({
      onLevel: () => {
        levels++;
      },
      onState: (s) => {
        states.push(s.kind);
        if (s.kind === "heard") tester.stop();
      },
      onLabels: () => undefined,
    });
    await tester.start(MIX);
    sound.amplitude = 0.2;
    for (let i = 0; i < 5; i++) b.frames.flush(100);
    expect(states).toEqual(["starting", "listening", "heard"]);
    const seen = levels;
    for (let i = 0; i < 3; i++) b.frames.flush(100);
    expect(levels).toBe(seen);
    expect(b.frames.pending).toBe(0);
  });
});

describe("the microphone step of the builder", () => {
  const options = (): Array<string | null> =>
    all("#mic option").map((o) => o.getAttribute("value"));

  it("names the microphones this browser already allowed", async () => {
    await boot({ setup: (b) => ((b.media as FakeMedia).granted = true) });
    expect(options()).toEqual(["", "Built-in Microphone", "USB Mixer"]);
    expect(hidden("mic-tip")).toBe(false);
    expect(hidden("mic-where")).toBe(true);
    expect(hidden("mic-note")).toBe(true);
  });

  it("asks for permission to list the microphones, and uses the one picked", async () => {
    const { b } = await boot();
    const media = b.media as FakeMedia;
    await next(4);
    expect(options()).toEqual([""]);
    media.holdCalls.add(0);
    click("list-mics");
    expect(disabled("list-mics")).toBe(true);
    expect(text("mic-note")).toBe("Asking for permission…");
    media.release();
    await settle();
    expect(disabled("list-mics")).toBe(false);
    expect(text("mic-note")).toBe("2 found");
    expect(options()).toEqual(["", "Built-in Microphone", "USB Mixer"]);
    change(byId("mic"), "USB Mixer");
    expect(linkSoFar()).toBe("127.0.0.1:8765/ar/nl?mic=USB+Mixer");
    expect(win.localStorage.getItem("captions.picker.mic")).toBe("USB Mixer");
    // The device asked for the list is let go.
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
  });

  it("says when no microphone has a name, or the browser refused", async () => {
    const { b } = await boot();
    const media = b.media as FakeMedia;
    await next(4);
    media.devices = [{ kind: "audioinput", label: "", deviceId: "x" }];
    click("list-mics");
    await settle();
    expect(text("mic-note")).toBe("No named microphones. The default is used.");
    media.error = new win.DOMException("denied", "NotAllowedError");
    click("list-mics");
    await settle();
    expect(text("mic-note")).toBe("Blocked. Allow the microphone in the site settings.");
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("mic-note")).toBe("Geblokkeerd. Sta de microfoon toe in de site-instellingen.");
  });

  it("tests the microphone: the level, what it heard, and Stop", async () => {
    const { b } = await boot();
    await next(4);
    expect(hidden("meter")).toBe(true);
    click("test-mic");
    expect(hidden("meter")).toBe(false);
    expect(text("meter-status")).toBe("Starting…");
    expect(text("test-mic")).toBe("Stop");
    await settle();
    expect(text("meter-status")).toBe("Listening…");
    // The test found the names: the list fills.
    expect(options()).toEqual(["", "Built-in Microphone", "USB Mixer"]);
    sound.amplitude = 0.1;
    for (let i = 0; i < 20; i++) b.frames.flush(16);
    expect(text("meter-status")).toBe("Sound detected");
    expect(byId("meter").classList.contains("is-good")).toBe(true);
    expect(byId("meter-fill").style.getPropertyValue("transform")).toBe("scaleX(0.833)");
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("meter-status")).toBe("Geluid gehoord");
    ($('.lang-btn[lang="en"]') as unknown as { click(): void }).click();
    click("test-mic");
    expect(hidden("meter")).toBe(true);
    expect(text("test-mic")).toBe("Test");
    expect(byId("meter-fill").style.getPropertyValue("transform")).toBe("scaleX(0)");
    expect((b.media as FakeMedia).streams.every((s) => s.tracks[0]?.stopped)).toBe(true);
  });

  it("says when it hears nothing", async () => {
    const { b } = await boot();
    await next(4);
    click("test-mic");
    await settle();
    for (let i = 0; i < 80; i++) b.frames.flush(100);
    expect(text("meter-status")).toBe("No sound yet");
    expect(byId("meter").classList.contains("is-warn")).toBe(true);
  });

  it("reports a blocked microphone, and Retry tries again", async () => {
    const { b } = await boot();
    const media = b.media as FakeMedia;
    await next(4);
    media.error = new win.DOMException("denied", "NotAllowedError");
    click("test-mic");
    await settle();
    expect(text("meter-status")).toBe("Blocked. Allow the microphone in the site settings.");
    expect(byId("meter").classList.contains("is-error")).toBe(true);
    expect(text("test-mic")).toBe("Retry");
    media.error = null;
    click("test-mic");
    await settle();
    expect(text("meter-status")).toBe("Listening…");
    expect(byId("meter").classList.contains("is-error")).toBe(false);
  });

  it("starts the test again when the microphone, channel or processing changes", async () => {
    const { b } = await boot({ setup: (b) => ((b.media as FakeMedia).granted = true) });
    const media = b.media as FakeMedia;
    await next(4);
    // Not testing: a change just changes the link.
    change(byId("ch"), "right");
    expect(media.asked).toHaveLength(0);
    click("test-mic");
    await settle();
    expect(media.asked).toHaveLength(1);
    change(byId("mic"), "Built-in Microphone");
    await settle();
    expect(media.asked.at(-1)).toMatchObject({ audio: { deviceId: { exact: "builtin" } } });
    const asked = media.asked.length;
    change(byId("ch"), "mix");
    await settle();
    change(byId("dsp"), "on");
    await settle();
    expect(media.asked.length).toBe(asked + 4);
    expect(media.asked.at(-1)).toMatchObject({
      audio: { channelCount: 1, echoCancellation: true },
    });
    expect(value("dsp")).toBe("on");
  });

  it("stops the test when the step is left or the page is hidden", async () => {
    const { b } = await boot();
    const media = b.media as FakeMedia;
    await next(4);
    click("test-mic");
    await settle();
    await next();
    expect(step6()).toBe(true);
    expect(media.streams[0]?.tracks[0]?.stopped).toBe(true);
    click("back");
    click("test-mic");
    await settle();
    fire(doc, "visibilitychange");
    expect(hidden("meter")).toBe(false);
    Object.defineProperty(doc, "hidden", { configurable: true, get: () => true });
    try {
      fire(doc, "visibilitychange");
    } finally {
      delete (doc as unknown as Record<string, unknown>).hidden;
    }
    expect(hidden("meter")).toBe(true);
    expect(media.streams[1]?.tracks[0]?.stopped).toBe(true);
  });

  it("remembers whether the advanced audio settings were open", async () => {
    await boot();
    const more = byId<{ open: boolean }>("more-audio");
    more.open = true;
    fire(more, "toggle");
    expect(win.localStorage.getItem("captions.picker.advanced")).toBe("1");
    more.open = false;
    fire(more, "toggle");
    expect(win.localStorage.getItem("captions.picker.advanced")).toBeNull();
  });
});

function step6(): boolean {
  return doc.body.dataset.step === "6";
}
