// @vitest-environment happy-dom
// The control dock (/control): starting and stopping the local session, the status it renders
// from /ws, the level meter, the page sessions list with its Stop and prayer-event buttons, and the
// toasts every action leaves. The server is a fake WebSocket and a fake fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Status, TrackStatus } from "../../src/shared/protocol.js";
import {
  FakeWebSocket,
  fakeFetch,
  jsonResponse,
  loadTemplate,
  settle,
  setUrl,
  status,
} from "./helpers/web-shared-fakes.js";

const ORIGIN = "http://127.0.0.1:8765";

interface Post {
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

let posts: Post[];
let sessionGets: Array<Record<string, string>>;
let sessionsReply: () => Response | Promise<Response>;
let postReply: (path: string) => Response | Promise<Response>;

function node<T extends Element>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} not found`);
  return found;
}

const id = <T extends HTMLElement>(name: string): T => node<T>(`#${name}`);
const button = (name: string): HTMLButtonElement => id<HTMLButtonElement>(name);
const toastText = (): string => id("toast").textContent ?? "";

/** Open /control with `query`; `prepare` runs on the template before the script starts. */
async function openDock(query = "", prepare?: () => void): Promise<FakeWebSocket> {
  setUrl(`${ORIGIN}/control${query}`);
  loadTemplate("control");
  prepare?.();
  vi.resetModules();
  await import("../../web/control.js");
  await settle(50);
  return FakeWebSocket.last();
}

/** A reply the test hands out later (to see the busy state in between). */
function deferred(): { promise: Promise<Response>; resolve(r: Response): void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sessionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "page-1",
    kind: "page",
    from: "ar",
    to: "nl",
    engines: ["soniox"],
    keyLabel: "Hall",
    startedAt: 0,
    durationMs: 65_000,
    streamedMinutes: 2.46,
    latency: { p50Ms: 900, p95Ms: 1400, n: 4 },
    state: "live",
    layout: "blocks",
    eventMode: "speech",
    ...over,
  };
}

function track(over: Partial<TrackStatus> = {}): TrackStatus {
  const none = { p50Ms: null, p95Ms: null, n: 0 };
  return {
    track: "soniox",
    active: true,
    provider: "live",
    latency: { source: none, translation: none },
    vadLatency: null,
    costUsd: 0.1234,
    segments: 5,
    ...over,
  };
}

const rows = (): HTMLLIElement[] => Array.from(document.querySelectorAll("#sessions > li"));

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  document.body.className = "";
  posts = [];
  sessionGets = [];
  sessionsReply = () => jsonResponse([]);
  postReply = () => jsonResponse({ ok: true });
  fakeFetch((url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (init?.method === "POST") {
      posts.push({ path: url, body: JSON.parse(String(init.body)), headers });
      return postReply(url);
    }
    if (url === "/api/sessions") {
      sessionGets.push(headers);
      return sessionsReply();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("control dock: the session controls", () => {
  it("starts on the live input with the file row hidden", async () => {
    await openDock();
    expect(id<HTMLSelectElement>("source").value).toBe("device");
    expect(id<HTMLInputElement>("file").value).toBe("");
    expect(id("file-row").hidden).toBe(true);
    expect(id("state").textContent).toBe("unknown");
    expect(id("timer").textContent).toBe("–");
    expect(id("all-row").hidden).toBe(true);
  });

  it("restores the saved source and file path, and remembers every change", async () => {
    localStorage.setItem("captions.control.source", "file");
    localStorage.setItem("captions.control.file", "recordings/jumuah.wav");
    await openDock();
    const source = id<HTMLSelectElement>("source");
    const file = id<HTMLInputElement>("file");
    expect(source.value).toBe("file");
    expect(file.value).toBe("recordings/jumuah.wav");
    expect(id("file-row").hidden).toBe(false);

    source.value = "device";
    source.dispatchEvent(new Event("change"));
    expect(id("file-row").hidden).toBe(true);
    expect(localStorage.getItem("captions.control.source")).toBe("device");

    file.value = "  other.wav  ";
    file.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("captions.control.file")).toBe("other.wav");
    file.value = "   ";
    file.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("captions.control.file")).toBeNull();
  });

  it("ignores a saved source it doesn't know", async () => {
    localStorage.setItem("captions.control.source", "satellite");
    await openDock();
    expect(id<HTMLSelectElement>("source").value).toBe("device");
  });

  it("starts the device session and keeps Start disabled while the request runs", async () => {
    await openDock();
    const reply = deferred();
    postReply = () => reply.promise;
    button("start").click();
    await settle();
    expect(posts).toEqual([
      {
        path: "/api/session/start",
        body: { source: "device" },
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      },
    ]);
    expect(button("start").disabled).toBe(true);
    reply.resolve(jsonResponse({ ok: true }));
    await settle(50);
    expect(button("start").disabled).toBe(false);
    expect(toastText()).toBe("Done.");
    expect(id("toast").classList.contains("toast-error")).toBe(false);
    expect(localStorage.getItem("captions.control.source")).toBe("device");
    expect(localStorage.getItem("captions.control.file")).toBeNull();
  });

  it("replays a file with its path, and asks for a path first when there is none", async () => {
    await openDock();
    const source = id<HTMLSelectElement>("source");
    const file = id<HTMLInputElement>("file");
    source.value = "file";
    source.dispatchEvent(new Event("change"));

    button("start").click();
    await settle();
    expect(posts).toEqual([]);
    expect(toastText()).toBe("Enter the path of the file to replay.");
    expect(id("toast").classList.contains("toast-error")).toBe(true);
    expect(document.activeElement).toBe(file);

    file.value = " recordings/khutbah.wav ";
    button("start").click();
    await settle(50);
    expect(posts.map((p) => p.body)).toEqual([{ source: "file", file: "recordings/khutbah.wav" }]);
    expect(localStorage.getItem("captions.control.file")).toBe("recordings/khutbah.wav");
  });

  it("stops only on a second click within four seconds", async () => {
    await openDock();
    const stop = button("stop");
    stop.click();
    expect(stop.textContent).toBe("Confirm stop");
    expect(stop.classList.contains("armed")).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(stop.textContent).toBe("Stop");
    expect(stop.classList.contains("armed")).toBe(false);
    await settle();
    expect(posts).toEqual([]);

    stop.click();
    vi.advanceTimersByTime(3000);
    stop.click();
    expect(stop.textContent).toBe("Stop");
    expect(stop.classList.contains("armed")).toBe(false);
    await settle(50);
    expect(posts.map((p) => [p.path, p.body])).toEqual([["/api/session/stop", {}]]);
    // The disarm timer of the first arming was cleared: the label stays.
    vi.advanceTimersByTime(4000);
    expect(stop.textContent).toBe("Stop");
  });

  it("clears the captions and shows the server's own message for six seconds", async () => {
    await openDock();
    postReply = () => jsonResponse({ ok: true, message: "Captions cleared." });
    button("clear").click();
    expect(button("clear").disabled).toBe(true);
    await settle(50);
    expect(posts.map((p) => p.path)).toEqual(["/api/captions/clear"]);
    expect(button("clear").disabled).toBe(false);
    expect(toastText()).toBe("Captions cleared.");
    vi.advanceTimersByTime(5999);
    expect(toastText()).toBe("Captions cleared.");
    vi.advanceTimersByTime(1);
    expect(toastText()).toBe("");
  });

  it("says what went wrong in the toast", async () => {
    await openDock();
    const clear = button("clear");
    const say = async (reply: () => Response | Promise<Response>): Promise<[string, boolean]> => {
      postReply = reply;
      clear.click();
      await settle(50);
      return [toastText(), id("toast").classList.contains("toast-error")];
    };
    expect(await say(() => jsonResponse({ error: "No session" }, 409))).toEqual([
      "No session",
      true,
    ]);
    expect(await say(() => jsonResponse({ ok: false, message: "Already idle" }))).toEqual([
      "Already idle",
      true,
    ]);
    // ok: false without a message is never "Done.".
    expect(await say(() => jsonResponse({ ok: false }))).toEqual(["That didn't work.", true]);
    expect(await say(() => new Response(null, { status: 204 }))).toEqual(["Done.", false]);
    expect(await say(() => jsonResponse("fine"))).toEqual(["Done.", false]);
    expect(await say(() => new Response("nope", { status: 401 }))).toEqual([
      "HTTP 401: open this page with ?token=<admin token>",
      true,
    ]);
    expect(await say(() => new Response("nope", { status: 403 }))).toEqual([
      "HTTP 403: open this page with ?token=<admin token>",
      true,
    ]);
    expect(await say(() => new Response("oops", { status: 500 }))).toEqual(["HTTP 500", true]);
    expect(
      await say(() => {
        throw new TypeError("Failed to fetch");
      }),
    ).toEqual(["Server unreachable.", true]);
    // A newer toast restarts the six seconds.
    vi.advanceTimersByTime(4000);
    await say(() => jsonResponse({ message: "Again" }));
    vi.advanceTimersByTime(4000);
    expect(toastText()).toBe("Again");
    vi.advanceTimersByTime(2000);
    expect(toastText()).toBe("");
  });
});

describe("control dock: the admin token", () => {
  it("goes into the preview links, the socket URL and every request", async () => {
    sessionsReply = () => jsonResponse([]);
    const ws = await openDock("?token=a b&x=1", () => {
      // A link without data-href and without a query string gets "?token=".
      const plain = document.createElement("a");
      plain.className = "preview";
      plain.setAttribute("href", "/overlay");
      const bare = document.createElement("a");
      bare.className = "preview";
      document.querySelector(".links")?.append(plain, bare);
    });
    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.preview")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/overlay?lang=ar&token=a%20b",
      "/overlay?lang=nl&token=a%20b",
      "/overlay?lang=ar,nl&debug=1&token=a%20b",
      "/overlay?token=a%20b",
      "?token=a%20b",
    ]);
    expect(ws.url).toBe("ws://127.0.0.1:8765/ws?token=a%20b");
    expect(sessionGets[0]).toEqual({ Accept: "application/json", Authorization: "Bearer a b" });
    button("clear").click();
    await settle(50);
    expect(posts[0]?.headers.Authorization).toBe("Bearer a b");
  });

  it("is left out without ?token=", async () => {
    const ws = await openDock();
    expect(ws.url).toBe("ws://127.0.0.1:8765/ws");
    expect(node<HTMLAnchorElement>("a.preview").getAttribute("href")).toBe("/overlay?lang=ar");
    expect(sessionGets[0]).toEqual({ Accept: "application/json" });
  });
});

describe("control dock: the live socket", () => {
  it("shows the connection state and subscribes to levels once open", async () => {
    const ws = await openDock();
    const conn = id("conn");
    expect(conn.textContent).toBe("connecting…");
    expect(conn.dataset.conn).toBe("connecting");
    expect(conn.hidden).toBe(false);

    ws.accept();
    expect(ws.json()).toEqual([{ type: "subscribe", topics: ["level"] }]);
    expect(conn.textContent).toBe("connected");
    expect(conn.hidden).toBe(true);

    ws.drop();
    expect(conn.textContent).toBe("disconnected");
    expect(conn.hidden).toBe(false);
    expect(document.body.classList.contains("offline")).toBe(true);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(conn.textContent).toBe("connecting…");
    expect(document.body.classList.contains("offline")).toBe(false);
  });

  it("ignores binary frames, junk and messages it doesn't use", async () => {
    const ws = await openDock();
    ws.accept();
    ws.receive(new ArrayBuffer(4));
    ws.receive("not json");
    ws.receive({ type: "segment", track: "soniox" });
    ws.receive({ type: "snapshot", status: null });
    ws.receive({ type: "status", status: "live" });
    ws.receive({ type: "hello", serverTime: "soon" });
    ws.receive({ type: "level", rmsDbfs: "loud", peakDbfs: -3 });
    vi.advanceTimersByTime(20);
    expect(id("state").textContent).toBe("unknown");
    expect(id("level-text").textContent).toBe("no level data");
  });

  it("renders a live file session from the snapshot", async () => {
    const ws = await openDock();
    ws.accept();
    ws.receive({
      type: "snapshot",
      track: "soniox",
      session: null,
      segments: [],
      status: status({
        eventMode: "athan",
        layout: "blocks",
        audio: { state: "ok", rmsDbfs: -30, lastFrameAgoMs: 2500, noSignal: true },
        session: {
          id: "local-1",
          kind: "file",
          startedAt: Date.now() - 1000,
          from: "ar",
          to: "nl",
          source: "file",
          inputKind: "file",
          file: "C:\\recordings\\khutbah.wav",
        },
      }),
    });
    expect(id("state").textContent).toBe("live");
    expect(id("state").dataset.state).toBe("live");
    const mode = id("mode");
    expect(mode.hidden).toBe(false);
    expect(mode.textContent).toBe("athan");
    expect(mode.dataset.mode).toBe("athan");
    expect(mode.title).toBe("Caption mode: athan · layout: blocks");
    expect(id("file-banner").hidden).toBe(false);
    expect(id("file-name").textContent).toBe("khutbah.wav");
    expect(id("file-name").title).toBe("C:\\recordings\\khutbah.wav");
    expect(id("audio-state").textContent).toBe("input: ok · last frame 2.50 s ago");
    expect(id("no-signal").hidden).toBe(false);
    expect(id("waiting-bridge").hidden).toBe(true);
    expect(id("error-line").hidden).toBe(true);
    expect(button("start").disabled).toBe(true);
    expect(button("stop").disabled).toBe(false);
  });

  it("renders an idle status: no mode, no file banner, Stop disabled", async () => {
    const ws = await openDock();
    ws.accept();
    ws.receive({
      type: "status",
      status: status({
        state: "idle",
        audio: { state: "waiting-for-bridge", rmsDbfs: null, lastFrameAgoMs: 100, noSignal: false },
        session: {
          id: "local-1",
          kind: "device",
          startedAt: 0,
          from: "ar",
          to: "nl",
          source: "file",
          inputKind: "file",
        },
      }),
    });
    expect(id("state").textContent).toBe("idle");
    expect(id("mode").hidden).toBe(true);
    expect(id("file-banner").hidden).toBe(true);
    expect(id("audio-state").textContent).toBe("input: waiting-for-bridge");
    expect(id("waiting-bridge").hidden).toBe(false);
    expect(id("no-signal").hidden).toBe(true);
    expect(button("start").disabled).toBe(false);
    expect(button("stop").disabled).toBe(true);
    expect(id("timer").textContent).toBe("–");
  });

  it("names a file session without a path, and a device session without a banner", async () => {
    const ws = await openDock();
    ws.accept();
    const session = {
      id: "local-1",
      startedAt: 0,
      from: "ar",
      to: "nl",
      inputKind: "file" as const,
    };
    ws.receive({
      type: "status",
      status: status({ session: { ...session, kind: "file", source: "device" } }),
    });
    expect(id("file-banner").hidden).toBe(false);
    expect(id("file-name").textContent).toBe("");
    ws.receive({
      type: "status",
      status: status({ session: { ...session, kind: "device", source: "device" } }),
    });
    expect(id("file-banner").hidden).toBe(true);
  });

  it("reads the prayer-event mode from any of its field names", async () => {
    const ws = await openDock();
    ws.accept();
    const show = (extra: Record<string, unknown>): [boolean, string | null, string] => {
      ws.receive({ type: "status", status: { ...status(), ...extra } });
      const mode = id("mode");
      return [mode.hidden, mode.textContent, mode.title];
    };
    expect(show({ sessionMode: "held" })).toEqual([false, "held", "Caption mode: held"]);
    expect(show({ prayerMode: "iqama", layout: "rollup" })).toEqual([
      false,
      "iqama",
      "Caption mode: iqama · layout: rollup",
    ]);
    expect(show({ mode: "speech", layout: "grid" })).toEqual([
      false,
      "normal",
      "Caption mode: normal",
    ]);
    expect(show({ eventMode: "party" })[0]).toBe(true);
  });

  it("shows the session error, else the last ffmpeg line of a failing input", async () => {
    const ws = await openDock();
    ws.accept();
    const errorLine = id("error-line");
    ws.receive({ type: "status", status: status({ error: "Soniox rejected the key" }) });
    expect(errorLine.hidden).toBe(false);
    expect(errorLine.textContent).toBe("Soniox rejected the key");

    const long = `  ${"x".repeat(200)}  `;
    const audio = { rmsDbfs: null, lastFrameAgoMs: null, noSignal: false, lastStderr: long };
    ws.receive({ type: "status", status: status({ audio: { ...audio, state: "error" } }) });
    expect(errorLine.textContent).toBe(`ffmpeg: ${"x".repeat(180)}…`);
    expect(id("audio-state").textContent).toBe("input: error");

    const short = { ...audio, lastStderr: "Device busy" };
    ws.receive({ type: "status", status: status({ audio: { ...short, state: "stalled" } }) });
    expect(errorLine.textContent).toBe("ffmpeg: Device busy");
    ws.receive({ type: "status", status: status({ audio: { ...short, state: "ok" } }) });
    expect(errorLine.hidden).toBe(true);
    expect(errorLine.textContent).toBe("");
  });

  it("copes with a status without audio or tracks", async () => {
    const ws = await openDock();
    ws.accept();
    const { audio: _audio, tracks: _tracks, ...rest } = status();
    ws.receive({ type: "status", status: { ...rest, tracks: "none" } });
    expect(id("audio-state").textContent).toBe("input: –");
    expect(id("no-signal").hidden).toBe(true);
    expect(id("waiting-bridge").hidden).toBe(true);
    expect(id("tracks").children).toHaveLength(0);
  });

  it("lists the engine tracks with their best latency figure, cost and errors", async () => {
    const ws = await openDock();
    ws.accept();
    const stats = (p50: number, p95: number, n: number) => ({ p50Ms: p50, p95Ms: p95, n });
    const none = stats(0, 0, 0);
    const tracks: unknown[] = [
      track({
        vadLatency: { final: none, translation: stats(1200, 2000, 3) },
        lastError: "socket closed",
      }),
      track({
        active: false,
        provider: "reconnecting",
        vadLatency: { final: none, translation: none },
        latency: { source: none, translation: stats(800, 900, 2) },
      }),
      track({ latency: { source: stats(500, 600, 1), translation: none } }),
      { ...track(), latency: undefined, costUsd: "free", segments: undefined },
    ];
    ws.receive({ type: "status", status: { ...status(), tracks } });
    const items = Array.from(id("tracks").children);
    expect(items.map((li) => li.querySelector(".track-head")?.textContent)).toEqual([
      "soniox active · live",
      "soniox standby · reconnecting",
      "soniox active · live",
      "soniox active · live",
    ]);
    expect(items[1]?.querySelector(".dot")?.getAttribute("data-state")).toBe("reconnecting");
    expect(items.map((li) => li.querySelector(".small.muted")?.textContent)).toEqual([
      "VAD→tr p50 1.20 s · p95 2.00 s (n=3) · $0.123 · 5 seg",
      "tr p50 0.80 s · p95 0.90 s (n=2) · $0.123 · 5 seg",
      "src p50 0.50 s · p95 0.60 s (n=1) · $0.123 · 5 seg",
      "latency –",
    ]);
    expect(items[0]?.querySelector(".error-text")?.textContent).toBe("socket closed");
    expect(items[1]?.querySelector(".error-text")).toBeNull();
  });

  it("times the session on the server's clock", async () => {
    const ws = await openDock();
    ws.accept();
    ws.receive({ type: "hello", serverTime: Date.now() + 5000 });
    const session = {
      id: "local-1",
      kind: "device" as const,
      startedAt: Date.now() - 65_000,
      from: "ar",
      to: "nl",
      source: "device" as const,
      inputKind: "device" as const,
    };
    ws.receive({ type: "status", status: status({ session }) });
    expect(id("timer").textContent).toBe("1:10");
    vi.advanceTimersByTime(1000);
    expect(id("timer").textContent).toBe("1:11");
    const notStarted = { ...session, startedAt: "soon" } as unknown as Status["session"];
    ws.receive({ type: "status", status: status({ session: notStarted }) });
    expect(id("timer").textContent).toBe("–");
  });
});

describe("control dock: the level meter", () => {
  const cover = (): string => id("meter-cover").style.getPropertyValue("width");
  const peak = (): string => id("meter-peak").style.getPropertyValue("left");
  const peakClass = (cls: string): boolean => id("meter-peak").classList.contains(cls);
  const levelText = (): string => id("level-text").textContent ?? "";

  it("says there is no level data until the first level arrives", async () => {
    const ws = await openDock();
    ws.accept();
    vi.advanceTimersByTime(20);
    expect(levelText()).toBe("no level data");
    expect(cover()).toBe("100.0%");
    expect(peakClass("hidden-peak")).toBe(true);
  });

  it("draws the RMS bar, the held peak and the numbers of each level message", async () => {
    const ws = await openDock();
    ws.accept();
    ws.receive({ type: "level", rmsDbfs: -30, peakDbfs: -6 });
    vi.advanceTimersByTime(20);
    expect(cover()).toBe("50.0%");
    expect(peak()).toBe("90.0%");
    expect(peakClass("hidden-peak")).toBe(false);
    expect(peakClass("clip")).toBe(false);
    expect(levelText()).toBe("RMS -30 dB · peak -6 dB");

    ws.receive({ type: "level", rmsDbfs: -12, peakDbfs: -0.4 });
    vi.advanceTimersByTime(20);
    expect(peakClass("clip")).toBe(true);
    expect(peak()).toBe("99.3%");

    // A lower peak doesn't move the held one during the hold time…
    ws.receive({ type: "level", rmsDbfs: -40, peakDbfs: -20 });
    vi.advanceTimersByTime(1000);
    expect(peak()).toBe("99.3%");
    // …then it falls 24 dB per second, never below the current peak.
    ws.receive({ type: "level", rmsDbfs: -40, peakDbfs: -20 });
    vi.advanceTimersByTime(1000);
    const left = Number.parseFloat(peak());
    expect(left).toBeLessThan(99.3);
    expect(left).toBeGreaterThan(66.7);
    ws.receive({ type: "level", rmsDbfs: -40, peakDbfs: -20 });
    vi.advanceTimersByTime(1000);
    expect(peak()).toBe("66.7%");
  });

  it("falls back to the status level when the messages stop, and hides the peak", async () => {
    const ws = await openDock();
    ws.accept();
    ws.receive({ type: "status", status: status({ audio: { ...status().audio, rmsDbfs: -45 } }) });
    ws.receive({ type: "level", rmsDbfs: -30, peakDbfs: -6 });
    vi.advanceTimersByTime(20);
    expect(levelText()).toBe("RMS -30 dB · peak -6 dB");
    vi.advanceTimersByTime(1500);
    expect(levelText()).toBe("no level data");
    expect(cover()).toBe("75.0%");
    vi.advanceTimersByTime(5000);
    expect(peakClass("hidden-peak")).toBe(true);

    ws.receive({
      type: "status",
      status: status({ audio: { ...status().audio, rmsDbfs: null } }),
    });
    vi.advanceTimersByTime(20);
    expect(cover()).toBe("100.0%");
    ws.drop();
    vi.advanceTimersByTime(20);
    expect(levelText()).toBe("");
  });
});

describe("control dock: page sessions", () => {
  it("lists the sessions with their details and mode, every two seconds", async () => {
    sessionsReply = () =>
      jsonResponse([
        sessionRow(),
        sessionRow({
          id: "page-2",
          from: "ar",
          to: "en",
          engines: [],
          keyLabel: null,
          durationMs: null,
          streamedMinutes: null,
          latency: { p50Ms: null, p95Ms: null, n: 0 },
          layout: "tiles",
          eventMode: "iqama",
          state: "starting",
        }),
      ]);
    await openDock();
    expect(sessionGets).toHaveLength(1);
    const [first, second] = rows();
    expect(node(".kind", first).textContent).toBe("page");
    expect(node<HTMLElement>(".kind", first).dataset.kind).toBe("page");
    expect(node(".row-title", first).textContent).toBe("ar → nl · soniox");
    expect(node<HTMLElement>(".row-title", first).title).toBe("page-1");
    expect(node(".small.muted", first).textContent).toBe(
      "Hall · 1:05 · 2.5 min · p50 0.90 s · p95 1.40 s · blocks · live",
    );
    expect(node<HTMLElement>(".mode-badge", first).textContent).toBe("normal");
    expect(node(".row-title", second).textContent).toBe("ar → en");
    expect(node(".small.muted", second).textContent).toBe("starting");
    expect(node<HTMLElement>(".mode-badge", second).textContent).toBe("iqama");
    expect(id("sessions-count").textContent).toBe("(2)");
    expect(id("all-row").hidden).toBe(false);
    expect(id("sessions-note").hidden).toBe(true);

    const pressed = (li: Element | undefined): string[] =>
      Array.from(li?.querySelectorAll<HTMLButtonElement>(".btn-ev.active") ?? []).map(
        (b) => `${b.dataset.event}:${b.getAttribute("aria-pressed")}`,
      );
    expect(pressed(first)).toEqual(["none:true"]);
    expect(pressed(second)).toEqual(["iqama:true"]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sessionGets).toHaveLength(2);
  });

  it("keeps the rows (and their buttons) when the list changes order, and drops ended ones", async () => {
    sessionsReply = () =>
      jsonResponse([sessionRow({ id: "a" }), sessionRow({ id: "b" }), sessionRow({ id: "c" })]);
    await openDock();
    const [a, b] = rows();
    const stopB = node<HTMLButtonElement>(".btn-stop", b);
    stopB.click();
    expect(stopB.textContent).toBe("Confirm");

    sessionsReply = () =>
      jsonResponse({
        sessions: [sessionRow({ id: "b", eventMode: "held" }), sessionRow({ id: "a" })],
      });
    await vi.advanceTimersByTimeAsync(2000);
    await settle(50);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(b);
    expect(rows()[1]).toBe(a);
    expect(node<HTMLElement>(".row-title", b).title).toBe("b");
    // Still armed: the row was reused, not re-created.
    expect(stopB.textContent).toBe("Confirm");
    expect(b?.querySelectorAll(".btn-ev.active")).toHaveLength(0);
    expect(node<HTMLElement>(".mode-badge", b).textContent).toBe("held");
    expect(id("sessions-count").textContent).toBe("(2)");
  });

  it("reads the sessions defensively", async () => {
    sessionsReply = () =>
      jsonResponse([
        null,
        "page-x",
        { kind: "page" },
        { id: 7 },
        { id: "bare", engines: ["soniox", 3], latency: "fast", streamedMinutes: Number.NaN },
        { id: "half", latency: { p50Ms: 100 } },
      ]);
    await openDock();
    expect(rows().map((li) => node<HTMLElement>(".row-title", li).title)).toEqual(["bare", "half"]);
    const [bare, half] = rows();
    expect(node(".kind", bare).textContent).toBe("?");
    expect(node(".row-title", bare).textContent).toBe("? → ? · soniox");
    expect(node(".small.muted", bare).textContent).toBe("?");
    expect(node<HTMLElement>(".mode-badge", bare).hidden).toBe(true);
    expect(bare?.querySelectorAll(".btn-ev.active")).toHaveLength(0);
    expect(node(".small.muted", half).textContent).toBe("?");
  });

  it("says when there are no sessions or when they can't be loaded", async () => {
    sessionsReply = () => jsonResponse([sessionRow()]);
    await openDock();
    const note = id("sessions-note");
    const next = async (reply: () => Response | Promise<Response>): Promise<string | null> => {
      sessionsReply = reply;
      await vi.advanceTimersByTimeAsync(2000);
      await settle(50);
      return note.hidden ? null : note.textContent;
    };
    expect(await next(() => jsonResponse([]))).toBe("No active sessions.");
    expect(rows()).toHaveLength(0);
    expect(id("sessions-count").textContent).toBe("");
    expect(id("all-row").hidden).toBe(true);
    expect(await next(() => new Response("", { status: 401 }))).toBe(
      "Couldn't load sessions (HTTP 401: open this page with ?token=<admin token>).",
    );
    expect(await next(() => new Response("", { status: 502 }))).toBe(
      "Couldn't load sessions (HTTP 502).",
    );
    expect(await next(() => jsonResponse({ list: [] }))).toBe("Unexpected sessions response.");
    expect(
      await next(() => {
        throw new TypeError("Failed to fetch");
      }),
    ).toBe("Server unreachable.");
    expect(await next(() => jsonResponse([sessionRow()]))).toBeNull();
  });

  it("stops one session after a confirming second click, then reloads the list", async () => {
    sessionsReply = () => jsonResponse([sessionRow({ id: "page 1/x" })]);
    await openDock();
    const stop = node<HTMLButtonElement>(".btn-stop", rows()[0]);
    stop.click();
    expect(stop.textContent).toBe("Confirm");
    await settle();
    expect(posts).toEqual([]);
    vi.advanceTimersByTime(4000);
    expect(stop.textContent).toBe("Stop");

    await settle(50);
    const reply = deferred();
    postReply = () => reply.promise;
    stop.click();
    stop.click();
    await settle();
    expect(posts.map((p) => [p.path, p.body])).toEqual([["/api/sessions/page%201%2Fx/stop", {}]]);
    const polls = sessionGets.length;
    reply.resolve(jsonResponse({ message: "Stopped." }));
    await settle(50);
    expect(toastText()).toBe("Stopped.");
    expect(sessionGets).toHaveLength(polls + 1);
  });

  it("forces a prayer event on one session, the buttons disabled meanwhile", async () => {
    sessionsReply = () => jsonResponse([sessionRow()]);
    await openDock();
    const row = rows()[0];
    const athan = node<HTMLButtonElement>('button[data-event="athan"]', row);
    expect(athan.title).toBe("Show the Athan card (this session)");
    expect(node<HTMLButtonElement>('button[data-event="none"]', row).title).toBe(
      "Back to normal captions (this session)",
    );
    const reply = deferred();
    postReply = () => reply.promise;
    athan.click();
    await settle();
    expect(posts.map((p) => [p.path, p.body])).toEqual([
      ["/api/sessions/page-1/event", { event: "athan" }],
    ]);
    const buttons = Array.from(row?.querySelectorAll<HTMLButtonElement>(".btn-ev") ?? []);
    expect(buttons.map((b) => b.disabled)).toEqual([true, true, true, true]);
    // Busy: a second press goes nowhere.
    athan.dispatchEvent(new MouseEvent("click"));
    await settle();
    expect(posts).toHaveLength(1);

    sessionsReply = () => jsonResponse([sessionRow({ eventMode: "athan" })]);
    reply.resolve(jsonResponse({ ok: true }));
    await settle(50);
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, false, false]);
    expect(sessionGets).toHaveLength(2);
    expect(athan.classList.contains("active")).toBe(true);
    expect(athan.getAttribute("aria-pressed")).toBe("true");
  });

  it("forces an event on every session at once, also when the request fails", async () => {
    sessionsReply = () => jsonResponse([sessionRow()]);
    await openDock();
    const all = id("all-events");
    const normal = node<HTMLButtonElement>('button[data-event="none"]', all);
    expect(normal.title).toBe("Back to normal captions (all sessions)");
    expect(node<HTMLButtonElement>('button[data-event="salah"]', all).title).toBe(
      "Show the Salah card (all sessions)",
    );
    postReply = () => {
      throw new TypeError("Failed to fetch");
    };
    normal.click();
    await settle(50);
    expect(posts.map((p) => [p.path, p.body])).toEqual([
      ["/api/sessions/all/event", { event: "none" }],
    ]);
    expect(toastText()).toBe("Server unreachable.");
    expect(normal.disabled).toBe(false);
    expect(sessionGets).toHaveLength(2);
  });
});
