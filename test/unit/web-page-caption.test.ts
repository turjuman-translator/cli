// @vitest-environment happy-dom
// The caption page (/:from/:to and /feed/<guid> → ?screen=): it opens this machine's microphone,
// gates speech with the VAD, streams it over /ws/page and shows what comes back as caption blocks
// (default) or the live roll-up, with readable banners for every problem and a calm card for a
// switched-off or invalid screen. The microphone, Web Audio, the socket and fetch are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_FRAME_BYTES, type Status } from "../../src/shared/protocol.js";
import {
  block,
  FakeWebSocket,
  fakeFetch,
  jsonResponse,
  loadTemplate,
  segment,
  settle,
  setUrl,
  status,
  text,
  trackListeners,
} from "./helpers/web-shared-fakes.js";
import {
  FakeAudioContext,
  type FakeMediaDevices,
  FakeWorkletNode,
  installMedia,
  uninstallMedia,
  workletFrame,
} from "./helpers/web-shared-media.js";

const ORIGIN = "https://mosque.example.org";

const VAD = {
  thresholdDbfs: -45,
  minSpeechMs: 200,
  minSilenceMs: 400,
  hangoverMs: 800,
  prerollMs: 500,
};
const READY = {
  type: "ready",
  sessionId: "s1",
  resumed: false,
  vad: VAD,
  limits: { maxFrameBytes: 3200, maxRealtimeFactor: 2, dailyMinutesLeft: null },
};

let devices: FakeMediaDevices;
let fetched: string[];
let untrack: () => void;

beforeEach(() => {
  untrack = trackListeners(document, window);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 9, 13, 0, 0));
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  devices = installMedia();
  fetched = [];
  fakeFetch((url) => {
    fetched.push(url);
    if (url.startsWith("/api/presets")) return jsonResponse({ custom: [], default: null });
    if (url.startsWith("/api/sessions/")) return jsonResponse({ blocks: [], hasMore: false });
    return jsonResponse({}, 404);
  });
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  untrack();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  uninstallMedia();
  Reflect.deleteProperty(window, "obsstudio");
  Reflect.deleteProperty(window, "__captionStats");
  Reflect.deleteProperty(navigator, "wakeLock");
  Reflect.deleteProperty(document, "hidden");
});

/** Open the caption page at `path` + `query` and let it boot (theme, microphone). */
async function openPage(path = "/ar/nl", query = "", origin = ORIGIN): Promise<void> {
  setUrl(`${origin}${path}${query}`);
  loadTemplate("caption");
  vi.resetModules();
  await import("../../web/caption.js");
  await settle(60);
}

/** Open the page and complete the handshake: the page is listening. */
async function readyPage(path = "/ar/nl", query = ""): Promise<FakeWebSocket> {
  await openPage(path, query);
  const ws = FakeWebSocket.last();
  ws.accept();
  ws.receive(READY);
  return ws;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`${sel} not found`);
  return node;
};
const stateText = () => $("#st-state").textContent;
const dot = () => $("#st-dot").className;
const banners = () => [...document.querySelectorAll("#banners .banner")].map((b) => b.textContent);
const bannerOf = (kind: string) => document.querySelector(`#banners .banner.${kind}`);
const stats = (): CaptionPageStats => {
  const s = window.__captionStats;
  if (!s) throw new Error("no stats");
  return s;
};
const binaryFrames = (ws: FakeWebSocket) => ws.sent.filter((d) => d instanceof ArrayBuffer);
const speechMessages = (ws: FakeWebSocket) =>
  ws
    .json()
    .filter((m) => m.type === "speech")
    .map((m) => m.state);

/** `count` 100 ms microphone frames, loud (speech) or silent, one every 100 ms. */
function speak(count: number, loud: boolean): void {
  for (let i = 0; i < count; i++) {
    vi.advanceTimersByTime(100);
    FakeWorkletNode.last().post(
      workletFrame(loud ? 10_000 : 0, loud ? -10 : -100, loud ? -6 : -100),
    );
  }
}

/** Let a requestAnimationFrame render run (frames follow the fake clock's start, so ≤ 32 ms). */
async function frame(): Promise<void> {
  await settle();
  vi.advanceTimersByTime(40);
}

const blockTexts = () =>
  [...document.querySelectorAll("#captions article.blk .blk-body")].map((n) => n.textContent);

describe("caption page: the address", () => {
  it.each([["/ar"], ["/ar/nl/extra"], ["/%E0%A4%A/nl"], ["/%20/nl"]])(
    "explains that %s is not a caption page and opens nothing",
    async (path) => {
      await openPage(path);
      expect(banners()).toEqual([
        "This isn't a caption page address (expected /<from>/<to>, e.g. /ar/nl). Choose languages",
      ]);
      expect($("#banners a").getAttribute("href")).toBe("/app/new");
      expect(devices.getUserMedia).not.toHaveBeenCalled();
      expect(FakeWebSocket.all).toHaveLength(0);
      expect(fetched).toEqual([]);
    },
  );

  it("names the page after the language pair, in the target language", async () => {
    await openPage("/ar/nl");
    expect(document.title).toBe("Live vertaling · ar → nl");
    expect($("#st-pair").textContent).toBe("ar → nl");
    expect(fetched[0]).toBe("/api/presets");
  });

  it("decodes the languages in the path", async () => {
    await openPage("/ar/%20en%20");
    expect($("#st-pair").textContent).toBe("ar → en");
    expect(document.title).toBe("Live translation · ar → en");
  });
});

describe("caption page: microphone, connection and speech", () => {
  it("asks for the microphone, then connects, then listens", async () => {
    devices.hold = true;
    await openPage();
    expect(stateText()).toBe("Requesting microphone…");
    expect(dot()).toBe("st-dot s-requesting-mic");
    expect(FakeWebSocket.all).toHaveLength(0);
    expect(stats().state).toBe("requesting-mic");

    devices.release();
    await settle(60);
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe("wss://mosque.example.org/ws/page");
    expect(stateText()).toBe("Connecting…");
    expect(dot()).toBe("st-dot s-connecting");
    expect($("#st-mic").textContent).toBe("Built-in Microphone");
    expect($("#st-mic").title).toBe("Built-in Microphone · 16000 Hz");

    ws.accept();
    const hello = ws.json()[0];
    expect(hello).toMatchObject({
      type: "hello",
      from: "ar",
      to: "nl",
      layout: "blocks",
      resume: null,
    });
    expect(hello).not.toHaveProperty("key");
    expect(hello).not.toHaveProperty("screen");
    ws.receive(READY);
    expect(stateText()).toBe("Listening");
    expect(dot()).toBe("st-dot s-listening");
    expect(stats()).toMatchObject({
      state: "listening",
      sessionId: "s1",
      layout: "blocks",
      mode: "speech",
      speaking: false,
      sampleRate: 16000,
      resampling: false,
      micLabel: "Built-in Microphone",
      screen: null,
    });
  });

  it("sends the access key in the hello", async () => {
    await openPage("/ar/nl", "?key=abc123");
    FakeWebSocket.last().accept();
    expect(FakeWebSocket.last().json()[0]?.key).toBe("abc123");
  });

  it("streams speech only: start, the pre-roll and live frames, then end after the hangover", async () => {
    const ws = await readyPage();
    speak(10, false);
    expect(binaryFrames(ws)).toHaveLength(0);
    speak(3, true);
    expect(speechMessages(ws)).toEqual(["start"]);
    expect(stateText()).toBe("Live");
    expect(dot()).toBe("st-dot s-live");
    expect(stats().speaking).toBe(true);
    const sent = binaryFrames(ws);
    expect(sent.length).toBeGreaterThanOrEqual(7);
    for (const f of sent) expect((f as ArrayBuffer).byteLength).toBe(PAGE_FRAME_BYTES);

    speak(15, false);
    expect(speechMessages(ws)).toEqual(["start", "end"]);
    expect(stateText()).toBe("Listening");
    expect(stats().speaking).toBe(false);
    // The stats follow on the next second's tick.
    vi.advanceTimersByTime(1000);
    expect(stats().framesSent).toBe(binaryFrames(ws).length);
  });

  it("measures the time from the speech end to the next caption block", async () => {
    const ws = await readyPage();
    speak(10, false);
    speak(5, true);
    speak(15, false);
    vi.advanceTimersByTime(700);
    ws.receive({ type: "block.add", block: block(1) });
    expect(stats().latencyBlocks.n).toBe(1);
    expect(stats().latency).toEqual(stats().latencyBlocks);
    expect(stats().latencyBlocks.p50Ms).toBeGreaterThan(1000);
    expect(stats().blocks).toBe(0);
    await frame();
    vi.advanceTimersByTime(1000);
    expect(stats().blocks).toBe(1);
    // Event cards and hidden blocks are not answers to speech.
    ws.receive({
      type: "block.add",
      block: block(2, {
        kind: "event",
        text: "",
        event: { type: "athan", active: true, startedAt: Date.now() },
      }),
    });
    ws.receive({ type: "block.add", block: block(3, { hidden: true }) });
    expect(stats().latencyBlocks.n).toBe(1);
  });

  it("re-anchors the frame clock after a gap in the microphone frames", async () => {
    const ws = await readyPage();
    speak(10, false);
    vi.advanceTimersByTime(5_000);
    speak(3, true);
    expect(speechMessages(ws)).toEqual(["start"]);
  });

  it("shows the microphone level, green while speaking", async () => {
    await readyPage();
    speak(1, false);
    expect($("#st-level").style.width).toBe("0%");
    expect($("#st-level").style.background).toContain("#4fa3ff");
    speak(3, true);
    expect($("#st-level").style.width).toBe("83%");
    expect($("#st-level").style.background).toContain("#3ddc84");
    expect($(".tb-level").style.width).toBe("83%");
  });

  it("says when the microphone runs resampled", async () => {
    FakeAudioContext.refuseOtherRate = true;
    await openPage();
    expect($("#st-mic").title).toBe("Built-in Microphone · 48000 Hz (resampled)");
  });

  it("resumes a suspended audio context on any key or pointer press", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    await openPage();
    await vi.advanceTimersByTimeAsync(1500);
    expect(bannerOf("info")?.textContent).toBe("Audio is paused by the browser.Start audio");
    expect(stateText()).toBe("Connecting…");
    FakeAudioContext.resumeWorks = true;
    document.dispatchEvent(new Event("keydown"));
    await settle();
    expect(banners()).toEqual([]);
    expect(FakeAudioContext.last().state).toBe("running");
    document.dispatchEvent(new Event("pointerdown"));
    await settle();
  });

  it("starts the audio from the banner's button", async () => {
    FakeAudioContext.startState = "suspended";
    FakeAudioContext.resumeWorks = false;
    await openPage();
    await vi.advanceTimersByTimeAsync(1500);
    FakeAudioContext.resumeWorks = true;
    $<HTMLButtonElement>("#banners button").click();
    await settle();
    expect(banners()).toEqual([]);
  });
});

describe("caption page: microphone problems", () => {
  it.each([
    [
      "NotAllowedError",
      "Microphone access was denied. Allow the microphone for this site. Retrying every 15 s.",
    ],
    ["NotFoundError", "Microphone not found. Retrying every 5 s."],
    ["NotReadableError", "The microphone can't be opened (in use?). Retrying every 5 s."],
    ["EncodingError", "Microphone error: EncodingError: broken. Retrying every 5 s."],
  ])("%s → a readable banner", async (name, message) => {
    devices.failures.push(new DOMException("broken", name));
    await openPage();
    expect(banners()).toEqual([message]);
    expect(bannerOf("error")).not.toBeNull();
    expect(stateText()).toBe("Microphone problem");
    expect(dot()).toBe("st-dot s-error");
    expect(FakeWebSocket.all).toHaveLength(0);
  });

  it("tells OBS users how to allow the microphone", async () => {
    Object.defineProperty(window, "obsstudio", {
      value: { pluginVersion: "2" },
      configurable: true,
    });
    devices.failures.push(new DOMException("no", "NotAllowedError"));
    await openPage();
    expect(banners()).toEqual([
      "Microphone access was denied. Allow the microphone for this site (OBS: start OBS with --enable-media-stream). Retrying every 15 s.",
    ]);
  });

  it("clears the banner when the microphone comes back", async () => {
    devices.failures.push(new DOMException("none", "NotFoundError"));
    await openPage();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(banners()).toEqual([]);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("explains that the microphone needs HTTPS, with this machine's address", async () => {
    installMedia({ secure: false });
    await openPage("/ar/nl", "", "http://192.168.1.5:9000");
    expect(stateText()).toBe("Needs HTTPS");
    expect(dot()).toBe("st-dot s-error");
    expect(banners()).toEqual([
      "Microphone needs HTTPS (or localhost). Open this page via https:// or on this machine at http://127.0.0.1:9000/ar/nl",
    ]);
    expect(FakeWebSocket.all).toHaveLength(0);
  });

  it("uses port 8765 in the hint when the page has none", async () => {
    installMedia({ secure: false });
    await openPage("/ar/nl", "", "http://mosque.local");
    expect(banners()[0]).toContain("http://127.0.0.1:8765/ar/nl");
  });

  it("never prints a screen's link on the HTTPS hint", async () => {
    installMedia({ secure: false });
    await openPage("/ar/nl", "?screen=6f1c-guid");
    FakeWebSocket.last().accept();
    FakeWebSocket.last().receive(READY);
    const text = banners()[0] ?? "";
    expect(text).toContain("Microphone needs HTTPS. On the computer that runs Turjuman");
    expect(text).not.toContain("6f1c");
  });

  it("names this computer's microphones only with ?debug=1", async () => {
    await openPage("/ar/nl", "?mic=Shure");
    expect(banners()).toEqual([]);
    await openPage("/ar/nl", "?mic=Shure&debug=1");
    expect(bannerOf("warn")?.textContent).toBe(
      'No microphone matches "Shure"; using the default. Available: Built-in Microphone.',
    );
    vi.advanceTimersByTime(60_000);
    expect(bannerOf("warn")).toBeNull();
  });
});

describe("caption page: server problems", () => {
  it.each([
    ["unauthorized", "An access key is needed.", "An access key is needed. Retrying every 5 min."],
    // the server's words end as a sentence before "Retrying …"
    [
      "unauthorized",
      "Invalid or expired access key",
      "Invalid or expired access key. Retrying every 5 min.",
    ],
    ["quota_exceeded", "", "Daily limit reached for this access key. Retrying every 5 min."],
    [
      "engine_unavailable",
      "No Soniox key.",
      "The speech engine is unavailable on the server. No Soniox key. Retrying in 30 s.",
    ],
    ["teapot", "I'm a teapot", "Server error: I'm a teapot. Retrying in 10 s."],
  ])("%s → a banner that says when it retries", async (code, message, shown) => {
    await openPage();
    const ws = FakeWebSocket.last();
    ws.accept();
    ws.receive({ type: "error", code, message });
    expect(banners()).toEqual([shown]);
    expect(stateText()).toBe("Server problem");
    expect(stats().state).toBe("error");
  });

  it("gives up on an unsupported language pair, with a way to choose others", async () => {
    await openPage("/ar/xx");
    const ws = FakeWebSocket.last();
    ws.accept();
    ws.receive({ type: "error", code: "bad_language", message: "xx is not a language." });
    expect(banners()).toEqual([
      "Unsupported language pair ar → xx. xx is not a language. Choose languages",
    ]);
    expect($("#banners a").getAttribute("href")).toBe(
      `/app/new?error=${encodeURIComponent("Unsupported language pair ar → xx")}`,
    );
    expect(stateText()).toBe("Server problem");
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    // A fatal error is not "unreachable".
    expect(banners()).toHaveLength(1);
  });

  it("clears the error banner when the server is ready again", async () => {
    await openPage();
    const ws = FakeWebSocket.last();
    ws.accept();
    ws.receive({ type: "error", code: "engine_unavailable", message: "No Soniox key." });
    vi.advanceTimersByTime(30_000);
    const again = FakeWebSocket.last();
    expect(again).not.toBe(ws);
    again.accept();
    expect(again.json()[0]?.resume).toBeNull();
    again.receive(READY);
    expect(banners()).toEqual([]);
    expect(stateText()).toBe("Listening");
  });

  it("says it can't reach the server after 2.5 s down, and reconnects with the session", async () => {
    const ws = await readyPage();
    ws.drop();
    expect(stateText()).toBe("Reconnecting…");
    expect($(".tb-state").textContent).toBe("Verbinden…");
    expect($(".tb-dot").title).toBe("Reconnecting…");
    FakeWebSocket.failNext = 10;
    vi.advanceTimersByTime(2_000);
    expect(banners()).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(banners()).toEqual(["Can't reach the caption server. Reconnecting…"]);
    expect(stateText()).toBe("Reconnecting…");
    FakeWebSocket.failNext = 0;
    vi.advanceTimersByTime(2_000);
    const again = FakeWebSocket.last();
    again.accept();
    expect(again.json()[0]?.resume).toBe("s1");
    again.receive(READY);
    vi.advanceTimersByTime(1_000);
    expect(banners()).toEqual([]);
    expect(stateText()).toBe("Listening");
  });

  it("says Connecting… (not Reconnecting…) on the first connection", async () => {
    await openPage();
    expect(stateText()).toBe("Connecting…");
    expect($(".tb-dot").title).toBe("Connecting…");
  });

  it("waits for a slow first connection before it calls the server unreachable", async () => {
    await openPage();
    vi.advanceTimersByTime(2_000);
    expect(banners()).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(banners()).toEqual(["Can't reach the caption server. Reconnecting…"]);
  });
});

describe("caption page: signed screens", () => {
  const GUID = "8d1c0c55-2f6e-4f53-9a4f-0d6ad1a0c001";

  async function screenPage(): Promise<FakeWebSocket> {
    await openPage("/ar/nl", `?screen=${GUID}`);
    const ws = FakeWebSocket.last();
    ws.accept();
    return ws;
  }

  it("connects first and opens the microphone only when the server is ready", async () => {
    const ws = await screenPage();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(ws.json()[0]?.screen).toEqual({ guid: GUID });
    expect(stats().screen).toEqual({ guid: GUID, state: "pending" });
    ws.receive(READY);
    await settle(60);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(stateText()).toBe("Listening");
    expect(stats().screen).toEqual({ guid: GUID, state: "enabled" });
  });

  it("shows a calm card and releases the microphone while the screen is off", async () => {
    const ws = await screenPage();
    ws.receive(READY);
    await settle(60);
    const track = devices.lastTrack();
    ws.receive({ type: "block.add", block: block(1) });
    await frame();
    expect(blockTexts()).toEqual(["Block 1."]);

    ws.receive({ type: "screen", state: "disabled", name: "Grote zaal" });
    expect(track.stopped).toBe(true);
    expect(document.body.classList.contains("is-screen-off")).toBe(true);
    expect($(".scr-title").textContent).toBe("Live vertaling staat uit");
    expect($(".scr-name").textContent).toBe("Grote zaal");
    expect(stateText()).toBe("Uit");
    expect(dot()).toBe("st-dot s-off");
    expect($(".tb-dot").className).toBe("tb-dot s-idle");
    expect(stats().screen).toEqual({ guid: GUID, state: "disabled" });
    expect($("#st-level").style.width).toBe("0%");
    // The captions fade away and the next session starts clean.
    vi.advanceTimersByTime(500);
    expect(blockTexts()).toEqual([]);
    // Never a red banner on a switched-off screen, however long it stays off.
    vi.advanceTimersByTime(60_000);
    expect(banners()).toEqual([]);

    ws.receive({ type: "screen", state: "enabled", name: "Grote zaal" });
    expect(document.body.classList.contains("is-screen-off")).toBe(false);
    const hellos = ws.json().filter((m) => m.type === "hello");
    expect(hellos).toHaveLength(2);
    expect(hellos[1]?.resume).toBeNull();
    ws.receive({ ...READY, sessionId: "s2" });
    await settle(60);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(stateText()).toBe("Listening");
  });

  it("keeps the card without a name when the screen has none", async () => {
    const ws = await screenPage();
    ws.receive({ type: "screen", state: "disabled", name: "" });
    expect($(".scr-name").textContent).toBe("");
    expect(stats().screen?.state).toBe("disabled");
  });

  it("reloads its feed link when the screen's look changes", async () => {
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
    const ws = await screenPage();
    ws.receive({ type: "screen", state: "reload", name: "" });
    expect(replace).toHaveBeenCalledWith(`/feed/${GUID}`);
  });

  it("ignores a reload request without a screen link", async () => {
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
    const ws = await readyPage();
    ws.receive({ type: "screen", state: "reload", name: "" });
    expect(replace).not.toHaveBeenCalled();
    expect(stateText()).toBe("Listening");
  });

  it.each([
    ["screen_invalid", "Deze link is niet meer geldig", "invalid"],
    ["screen_required", "Deze pagina heeft een beveiligde schermlink nodig", "required"],
  ])("%s shows a calm card instead of a banner", async (code, title, state) => {
    const ws = await screenPage();
    ws.receive(READY);
    await settle(60);
    ws.receive({ type: "error", code, message: "nope" });
    expect($(".scr-title").textContent).toBe(title);
    expect(stateText()).toBe(title);
    expect(document.body.classList.contains("is-screen-off")).toBe(true);
    expect(devices.lastTrack().stopped).toBe(true);
    expect(stats().screen?.state).toBe(state);
    vi.advanceTimersByTime(30_000);
    expect(banners()).toEqual([]);
  });

  it("shows the screen in the debug panel", async () => {
    await openPage("/ar/nl", `?screen=${GUID}&debug=1`);
    const ws = FakeWebSocket.last();
    ws.accept();
    ws.receive({ type: "screen", state: "disabled", name: "Hall" });
    expect($("#debug").textContent).toContain(
      `screen    ${GUID.slice(0, 8)}… disabled (Hall)  mic released`,
    );
    ws.receive({ type: "screen", state: "enabled", name: "" });
    ws.receive(READY);
    await settle(60);
    expect($("#debug").textContent).toContain(`screen    ${GUID.slice(0, 8)}… enabled  mic open`);
    ws.receive({ type: "error", code: "screen_invalid", message: "" });
    expect($("#debug").textContent).toContain(
      `screen    ${GUID.slice(0, 8)}… invalid  mic released`,
    );
  });
});

describe("caption page: caption blocks", () => {
  it("shows the blocks with history, the listening dots and the session end", async () => {
    const ws = await readyPage();
    ws.receive({ type: "blocks.snapshot", blocks: [block(2), block(1)], hasMore: false });
    expect(blockTexts()).toEqual(["Block 1.", "Block 2."]);
    expect(stats().blocks).toBe(2);
    expect($(".blk-root").classList.contains("is-history")).toBe(true);
    ws.receive({ type: "block.update", block: block(2, { text: "Block 2. And more." }) });
    await frame();
    expect(blockTexts()).toEqual(["Block 1.", "Block 2. And more."]);
    ws.receive({ type: "listening", active: true, partial: "بسم" });
    expect($(".blk-listen").classList.contains("is-on")).toBe(true);
    ws.receive({ type: "mode", mode: "athan" });
    expect(stats().mode).toBe("athan");
    ws.receive({ type: "session.ended", endedAt: Date.now() });
    await frame();
    expect($(".blk-end .blk-marker").textContent).toBe("Sessie beëindigd · 13:00");
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".blk-export a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual([
      "/api/sessions/s1/export.txt",
      "/api/sessions/s1/export.md",
      "/api/sessions/s1/export.srt",
    ]);
  });

  it("passes the access key on to the export links", async () => {
    const ws = await readyPage("/ar/nl", "?key=k9");
    ws.receive({ type: "blocks.snapshot", blocks: [block(1)], hasMore: false });
    ws.receive({ type: "session.ended", endedAt: Date.now() });
    await frame();
    expect($(".blk-export a").getAttribute("href")).toBe("/api/sessions/s1/export.txt?key=k9");
  });

  it("empties the blocks on a clear of all tracks or the shown one", async () => {
    const ws = await readyPage();
    ws.receive({ type: "blocks.snapshot", blocks: [block(1)], hasMore: false });
    ws.receive({ type: "clear", track: "all" });
    expect(blockTexts()).toEqual([]);
    ws.receive({ type: "blocks.snapshot", blocks: [block(2)], hasMore: false });
    ws.receive({ type: "clear", track: "soniox" });
    expect(blockTexts()).toEqual([]);
  });

  it("follows in OBS: no history, no toolbar", async () => {
    Object.defineProperty(window, "obsstudio", { value: {}, configurable: true });
    const ws = await readyPage();
    ws.receive({ type: "blocks.snapshot", blocks: [block(1)], hasMore: false });
    expect($(".blk-root").classList.contains("is-history")).toBe(false);
    expect(document.querySelector(".tb")).toBeNull();
    expect(document.body.classList.contains("has-statusbar")).toBe(false);
    expect(ws.json()[0]?.client).toEqual({ obs: true, ua: navigator.userAgent });
  });

  it("has a toolbar in a browser: font size, source text and Quran Arabic", async () => {
    await readyPage("/ar/nl", "?show=target");
    expect(document.body.classList.contains("has-statusbar")).toBe(true);
    expect(document.body.classList.contains("layout-blocks")).toBe(true);
    expect($("#statusbar").classList.contains("is-hidden")).toBe(true);
    const button = (label: string) => {
      const b = [...document.querySelectorAll<HTMLButtonElement>(".tb-btn")].find(
        (x) => x.textContent === label,
      );
      if (!b) throw new Error(label);
      return b;
    };
    button("A+").click();
    expect(localStorage.getItem("captions.fontScale")).toBe("1.1");
    expect(document.documentElement.style.getPropertyValue("--cap-font-size")).toContain("* 1.1");
    button("A−").click();
    expect(localStorage.getItem("captions.fontScale")).toBe("1");
    const root = $(".blk-root");
    expect(root.classList.contains("show-target")).toBe(true);
    button("Bron").click();
    expect(root.classList.contains("show-both")).toBe(true);
    button("Bron").click();
    expect(root.classList.contains("show-target")).toBe(true);
    const quranOn = root.classList.contains("quran-ar");
    button("Koran").click();
    expect(root.classList.contains("quran-ar")).toBe(!quranOn);
  });

  it("hides the source toggle on a source-only page", async () => {
    await readyPage("/ar/nl", "?show=source");
    const source = [...document.querySelectorAll<HTMLButtonElement>(".tb-btn")].find(
      (b) => b.textContent === "Bron",
    );
    expect(source?.hidden).toBe(true);
  });

  it("hides the toolbar with ?ui=0", async () => {
    await readyPage("/ar/nl", "?ui=0");
    expect(document.querySelector(".tb")).toBeNull();
  });

  it("loads older blocks with the access key", async () => {
    const ws = await readyPage("/ar/nl", "?key=k9");
    ws.receive({ type: "blocks.snapshot", blocks: [block(5)], hasMore: true });
    const scroller = $(".blk-scroll");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 10;
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    expect(
      fetched.some(
        (u) =>
          u.startsWith("/api/sessions/s1/blocks?") &&
          u.includes("before=5") &&
          u.includes("key=k9"),
      ),
    ).toBe(true);
  });

  it("does not count the same final twice and forgets old ones", async () => {
    const ws = await readyPage();
    for (let i = 1; i <= 505; i++) {
      ws.receive({
        type: "segment",
        track: "soniox",
        segment: segment(i, text("نص"), { nl: text("tekst") }),
      });
    }
    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(505, text("نص"), { nl: text("tekst") }),
    });
    expect(stats().finals).toBe(505);
  });
});

describe("caption page: rolling captions", () => {
  it("shows the source and the translation as they grow", async () => {
    const ws = await readyPage("/ar/nl", "?layout=rollup&partial=1");
    expect(document.body.classList.contains("layout-rollup")).toBe(true);
    expect($("#statusbar").classList.contains("is-hidden")).toBe(false);
    expect($("#statusbar").classList.contains("at-top")).toBe(true);
    expect(FakeWebSocket.last().json()[0]?.layout).toBe("rollup");
    const blocks = [...document.querySelectorAll<HTMLElement>(".cap-block")];
    expect(blocks.map((b) => [b.lang, b.dir])).toEqual([
      ["ar", "rtl"],
      ["nl", "ltr"],
    ]);

    ws.receive({
      type: "snapshot",
      track: "soniox",
      session: null,
      segments: [segment(1, text("بسم الله"), { nl: text("In de naam van Allah") })],
      status: status(),
    });
    await frame();
    expect(blocks[0]?.textContent?.trim()).toBe("بسم الله");
    expect(blocks[1]?.textContent?.trim()).toBe("In de naam van Allah");

    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(2, text("الرحمن الرحيم", 7, false), {
        nl: text("de Barmhartige", 3, false),
      }),
    });
    await frame();
    expect(blocks[1]?.querySelector(".cap-partial")?.textContent).toBe("Barmhartige");
    expect(blocks[0]?.querySelector(".cap-partial")?.textContent).toBe("الرحيم");
    expect(stats().segments).toBe(2);
    expect(stats().finals).toBe(0);

    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(2, text("الرحمن الرحيم"), { nl: text("de Barmhartige") }),
    });
    await frame();
    expect(blocks[1]?.textContent).toContain("de Barmhartige");
    expect(stats().finals).toBe(1);
    expect(stats().latencyTranslation.n).toBe(0);

    ws.receive({ type: "status", status: status() });
    ws.receive({ type: "clear", track: "soniox" });
    await frame();
    expect(blocks[1]?.textContent?.trim()).toBe("");
  });

  it("measures caption latency from the speech end to the finals", async () => {
    const ws = await readyPage("/ar/nl", "?layout=rollup&show=source");
    speak(10, false);
    speak(5, true);
    speak(15, false);
    ws.receive({ type: "segment", track: "soniox", segment: segment(1, text("بسم الله")) });
    expect(stats().latencySource.n).toBe(1);
    expect(stats().latency).toEqual(stats().latencySource);
    expect(document.querySelectorAll(".cap-block")).toHaveLength(1);
  });

  it("reports translation latency when the page shows the translation", async () => {
    const ws = await readyPage("/ar/nl", "?layout=rollup&show=target");
    speak(10, false);
    speak(5, true);
    speak(15, false);
    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(1, text("بسم"), { nl: text("In") }),
    });
    expect(stats().latencyTranslation.n).toBe(1);
    expect(stats().latency).toEqual(stats().latencyTranslation);
    expect([...document.querySelectorAll<HTMLElement>(".cap-block")].map((b) => b.lang)).toEqual([
      "nl",
    ]);
  });

  it("puts the status bar at the bottom when the captions are at the top", async () => {
    await readyPage("/ar/nl", "?layout=rollup&pos=top");
    expect($("#statusbar").classList.contains("at-bottom")).toBe(true);
    expect($("#banners").classList.contains("at-bottom")).toBe(true);
  });

  it("keeps the caption background choices of a roll-up", async () => {
    await readyPage("/ar/nl", "?layout=rollup&bg=shadow");
    expect($(".cap-root").classList.contains("bg-shadow")).toBe(true);
    await readyPage("/ar/nl", "?layout=rollup&bg=none");
    expect($(".cap-root").classList.contains("bg-none")).toBe(true);
  });

  it("wipes the roll-up on a clear of all tracks", async () => {
    const ws = await readyPage("/ar/nl", "?layout=rollup");
    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(1, text("بسم"), { nl: text("In") }),
    });
    await frame();
    ws.receive({ type: "clear", track: "all" });
    await frame();
    expect($(".cap-root").textContent?.trim()).toBe("");
  });

  it("fades the roll-up away when the screen is switched off", async () => {
    await openPage("/ar/nl", "?layout=rollup&screen=g-1");
    const ws = FakeWebSocket.last();
    ws.accept();
    ws.receive(READY);
    await settle(60);
    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(1, text("بسم"), { nl: text("In") }),
    });
    await frame();
    ws.receive({ type: "screen", state: "disabled", name: "" });
    expect($(".cap-root").classList.contains("is-fading")).toBe(true);
  });
});

describe("caption page: debug panel and page lifecycle", () => {
  it("shows the debug panel with the session, link, level, engine and latency", async () => {
    const ws = await readyPage("/ar/nl", "?debug=1");
    expect($("#debug").classList.contains("is-hidden")).toBe(false);
    const st: Status = status({
      tracks: [
        {
          track: "soniox",
          active: true,
          provider: "live",
          latency: {
            source: { p50Ms: 800, p95Ms: 1200, n: 3 },
            translation: { p50Ms: 1500, p95Ms: 2500, n: 3 },
          },
          vadLatency: null,
          costUsd: 0.01,
          segments: 3,
          lastError: "rate limited",
        },
      ],
      page: { speaking: true, engineOpen: true, streamedMinutes: 1.5 },
    });
    ws.receive({ type: "status", status: st });
    expect($("#debug").textContent).toContain("state     listening\n");
    speak(3, true);
    const text = $("#debug").textContent ?? "";
    expect(text).toContain("state     live (sending speech)");
    expect(text).toContain("level     -10.0 dBFS  peak -6.0");
    expect(text).toContain("session   s1  link ready");
    expect(text).toContain("layout    blocks  preset mosque-dark  mode speech");
    expect(text).toContain("screen    –  mic open");
    expect(text).toContain("mic       Built-in Microphone @ 16000 Hz");
    expect(text).toContain("engine    soniox  provider live  session live");
    expect(text).toContain("page      speaking true  engineOpen true  min 1.50");
    expect(text).toContain("server    p50 1.50 s p95 2.50 s  err rate limited");
    expect(text).toMatch(/frames {4}sent \d+ {2}dropped 0/);
    expect(text).toContain("segments  0  finals 0  blocks 0");
  });

  it("shows dashes in the debug panel before any status", async () => {
    FakeAudioContext.refuseOtherRate = true;
    await openPage("/ar/nl", "?debug=1");
    const text = $("#debug").textContent ?? "";
    expect(text).toContain("session   –  link connecting");
    expect(text).toContain("engine    soniox  provider –  session –");
    expect(text).toContain("page      speaking –  engineOpen –  min –");
    expect(text).toContain("server    p50 – p95 –");
    expect(text).toContain("(resampled)");
    expect(text).toContain("latency   blocks p50 – p95 – (n=0)");
  });

  it("shows dashes for an unknown microphone in the debug panel", async () => {
    devices.hold = true;
    await openPage("/ar/nl", "?debug=1");
    expect($("#debug").textContent).toContain("mic       – @ ? Hz");
  });

  it("warns when the page goes to the background, and keeps the screen awake", async () => {
    const release = { released: false };
    const request = vi.fn(async () => release);
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    await readyPage();
    expect(request).toHaveBeenCalledWith("screen");
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(banners()).toEqual([
      "This page is in the background. Some browsers stop the microphone; keep it visible.",
    ]);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(banners()).toEqual([]);
    await settle();
    // Still held: no second request.
    expect(request).toHaveBeenCalledTimes(1);
    release.released = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("works on without a wake lock (refused, hidden page or OBS)", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("battery", "NotAllowedError");
    });
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    await readyPage();
    expect(request).toHaveBeenCalledTimes(1);
    expect(stateText()).toBe("Listening");

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await readyPage();
    expect(request).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(document, "hidden");

    Object.defineProperty(window, "obsstudio", { value: {}, configurable: true });
    await readyPage();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
