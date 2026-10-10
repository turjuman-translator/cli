// @vitest-environment happy-dom
// The overlay (/overlay): captions of the local session for OBS, as caption blocks (default) or
// the live roll-up (?layout=rollup), its toolbar, the connection dot and the debug panel. The
// server is a fake WebSocket; /api/presets answers from a fake fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../src/shared/protocol.js";
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
} from "./helpers/web-shared-fakes.js";

const ORIGIN = "http://127.0.0.1:8765";

const SESSION: SessionInfo = {
  id: "s1",
  kind: "device",
  startedAt: 10_000,
  from: "ar",
  to: "nl",
  source: "device",
  inputKind: "device",
};

let presetUrls: string[];

function hello(langs = { source: "ar", targets: ["nl"] }): Record<string, unknown> {
  return {
    type: "hello",
    protocol: 1,
    serverTime: Date.now(),
    sessionId: "s1",
    langs,
    tracks: ["soniox"],
    primary: "soniox",
  };
}

function snapshot(
  segments: ReturnType<typeof segment>[] = [],
  session: SessionInfo | null = SESSION,
): Record<string, unknown> {
  return { type: "snapshot", track: "soniox", session, segments, status: status() };
}

async function openOverlay(query = ""): Promise<FakeWebSocket> {
  setUrl(`${ORIGIN}/overlay${query}`);
  loadTemplate("overlay");
  vi.resetModules();
  await import("../../web/overlay.js");
  await settle(50);
  return FakeWebSocket.last();
}

/** Let a requestAnimationFrame render run. */
async function frame(): Promise<void> {
  await settle();
  vi.advanceTimersByTime(20);
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

const articles = (): string[] =>
  Array.from(document.querySelectorAll("#captions article.blk .blk-body")).map(
    (n) => n.textContent ?? "",
  );

function toolbarButton(label: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>(".tb .tb-btn")).find(
    (x) => x.textContent === label || x.title === label,
  );
  if (!b) throw new Error(`no toolbar button ${label}`);
  return b;
}

const debugLines = (): string[] => (q("#debug")?.textContent ?? "").split("\n");

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  presetUrls = [];
  fakeFetch((url) => {
    if (url.startsWith("/api/presets")) {
      presetUrls.push(url);
      return jsonResponse({ custom: [], default: null });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.obsstudio;
});

describe("overlay: caption blocks", () => {
  it("waits for the session's languages, then shows and updates the blocks", async () => {
    const ws = await openOverlay();
    ws.accept();
    ws.receive({ type: "blocks.snapshot", blocks: [block(1)], hasMore: false });
    expect(q("#captions .blk-root")).toBeNull();

    ws.receive(hello());
    const root = q("#captions .blk-root");
    expect(root?.classList.contains("is-history")).toBe(true);
    expect(q(".tb .tb-chip")?.textContent).toBe("NL");
    expect(q(".tb .tb-label")?.textContent).toBe("Live vertaling");

    ws.receive({ type: "blocks.snapshot", blocks: [block(2), block(1)], hasMore: false });
    expect(articles()).toEqual(["Block 1.", "Block 2."]);

    ws.receive({ type: "block.add", block: block(3, { text: "Broeders en zusters," }) });
    await frame();
    expect(articles()).toEqual(["Block 1.", "Block 2.", "Broeders en zusters,"]);

    ws.receive({
      type: "block.update",
      block: block(3, { text: "Broeders en zusters, vandaag" }),
    });
    await frame();
    expect(articles()[2]).toBe("Broeders en zusters, vandaag");

    ws.receive({ type: "listening", active: true });
    expect(q(".blk-listen")?.classList.contains("is-on")).toBe(true);

    ws.receive({ type: "session.ended", endedAt: Date.now() });
    await frame();
    expect(q(".blk-end .blk-marker")?.textContent).toMatch(/^Sessie beëindigd · \d\d:\d\d$/);
    expect(q(".blk-listen")?.classList.contains("is-on")).toBe(false);
    expect(q(".blk-root")).toBe(root);
  });

  it("takes the languages from the snapshot's session and rebuilds for a new target", async () => {
    const ws = await openOverlay();
    ws.accept();
    ws.receive({ type: "status", status: status() });
    expect(q("#captions .blk-root")).toBeNull();

    ws.receive(snapshot([], { ...SESSION, to: "en" }));
    expect(q(".tb .tb-label")?.textContent).toBe("Live translation");
    const first = q("#captions .blk-root");

    ws.receive(hello());
    expect(document.querySelectorAll("#captions .blk-root")).toHaveLength(1);
    expect(document.querySelectorAll(".tb")).toHaveLength(1);
    expect(q(".tb .tb-chip")?.textContent).toBe("NL");
    const second = q("#captions .blk-root");
    expect(second).not.toBe(first);

    ws.receive(hello());
    expect(q("#captions .blk-root")).toBe(second);
  });

  it("clears the blocks for every track or the shown one only", async () => {
    const ws = await openOverlay();
    ws.accept();
    ws.receive({ type: "clear", track: "all" });
    ws.receive(hello());
    const fill = (): void =>
      ws.receive({ type: "blocks.snapshot", blocks: [block(1), block(2)], hasMore: false });
    fill();
    ws.receive({ type: "clear", track: "other" });
    expect(articles()).toHaveLength(2);
    ws.receive({ type: "clear", track: "soniox" });
    expect(articles()).toHaveLength(0);
    fill();
    ws.receive({ type: "clear", track: "all" });
    expect(articles()).toHaveLength(0);
  });

  it("ignores binary frames and text that isn't a message", async () => {
    const ws = await openOverlay("?debug=1");
    ws.accept();
    const before = q("#debug")?.textContent;
    ws.receive(new ArrayBuffer(8));
    ws.receive("{oops");
    ws.receive({ kind: "hello" });
    expect(q("#debug")?.textContent).toBe(before);
    expect(q("#captions")?.children).toHaveLength(0);
  });
});

describe("overlay: the toolbar", () => {
  it("shows the connection state and steps the font size", async () => {
    const ws = await openOverlay();
    ws.receive(hello());
    expect(q(".tb .tb-dot")?.className).toBe("tb-dot s-connecting");
    ws.accept();
    expect(q(".tb .tb-dot")?.className).toBe("tb-dot s-live");

    toolbarButton("A+").click();
    expect(localStorage.getItem("captions.fontScale")).toBe("1.1");
    expect(document.documentElement.style.getPropertyValue("--cap-font-size")).toBe(
      "calc(min(52px, 5vw) * 1.1)",
    );
    toolbarButton("A−").click();
    expect(localStorage.getItem("captions.fontScale")).toBe("1");
    expect(document.documentElement.style.getPropertyValue("--cap-font-size")).toBe(
      "min(52px, 5vw)",
    );

    ws.drop();
    expect(q(".tb .tb-dot")?.className).toBe("tb-dot s-connecting");
  });

  it("toggles the source text and the Quran Arabic", async () => {
    const ws = await openOverlay();
    ws.accept();
    ws.receive(hello());
    const root = q("#captions .blk-root");
    expect(root?.classList.contains("show-target")).toBe(true);
    toolbarButton("Bron").click();
    expect(root?.classList.contains("show-both")).toBe(true);
    toolbarButton("Bron").click();
    expect(root?.classList.contains("show-target")).toBe(true);

    expect(root?.classList.contains("quran-ar")).toBe(true);
    toolbarButton("Koran").click();
    expect(root?.classList.contains("quran-ar")).toBe(false);
    toolbarButton("Koran").click();
    expect(root?.classList.contains("quran-ar")).toBe(true);
  });

  it("is hidden by ?ui=0, by toolbar=off and inside OBS, and forced by ?ui=1", async () => {
    const shown = async (query: string, obs = false): Promise<boolean> => {
      if (obs) window.obsstudio = { pluginVersion: "30.0" };
      else delete window.obsstudio;
      const ws = await openOverlay(query);
      ws.accept();
      ws.receive(hello());
      return q(".tb") !== null;
    };
    expect(await shown("?ui=0")).toBe(false);
    expect(await shown("?toolbar=off")).toBe(false);
    expect(await shown("", true)).toBe(false);
    // OBS follows the newest block: no history scrolling there.
    expect(q("#captions .blk-root")?.classList.contains("is-history")).toBe(false);
    expect(await shown("?ui=1", true)).toBe(true);
    expect(await shown("?toolbar=on", true)).toBe(true);
  });
});

describe("overlay: the socket, the dot and the debug panel", () => {
  it("connects to /ws, with the session and token of the link", async () => {
    let ws = await openOverlay();
    expect(ws.url).toBe("ws://127.0.0.1:8765/ws");
    expect(presetUrls).toEqual(["/api/presets"]);
    ws = await openOverlay("?session=abc&token=t%20k");
    expect(ws.url).toBe("ws://127.0.0.1:8765/ws?session=abc&token=t+k");
    expect(presetUrls[1]).toBe("/api/presets?token=t+k");
  });

  it("shows the amber dot only after three seconds without a connection", async () => {
    const ws = await openOverlay();
    const dot = q("#conn");
    expect(dot?.classList.contains("is-hidden")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(dot?.classList.contains("is-hidden")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(dot?.classList.contains("is-hidden")).toBe(false);
    expect(dot?.classList.contains("is-ok")).toBe(false);

    ws.accept();
    expect(dot?.classList.contains("is-hidden")).toBe(true);
    expect(dot?.classList.contains("is-ok")).toBe(true);
    ws.drop();
    expect(dot?.classList.contains("is-hidden")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(dot?.classList.contains("is-hidden")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(dot?.classList.contains("is-hidden")).toBe(false);
  });

  it("shows the dot and the debug panel all the time with ?debug=1", async () => {
    const ws = await openOverlay("?debug=1&session=abc");
    expect(q("#debug")?.classList.contains("is-hidden")).toBe(false);
    expect(q("#conn")?.classList.contains("is-hidden")).toBe(false);
    expect(debugLines()).toEqual([
      "link     down 0 s",
      "layout   blocks  preset mosque-dark  mode speech",
      "track    soniox  session abc",
      "status   –  provider –  audio –",
      "latency  p50 – p95 – (n=0)",
      "blocks   0 rendered",
    ]);
    vi.advanceTimersByTime(5000);
    expect(debugLines()[0]).toBe("link     down 5 s");

    ws.accept();
    expect(q("#conn")?.classList.contains("is-hidden")).toBe(false);
    ws.receive(hello());
    ws.receive(snapshot());
    ws.receive({ type: "mode", mode: "athan" });
    ws.receive({ type: "blocks.snapshot", blocks: [block(1), block(2)], hasMore: false });
    expect(debugLines()).toEqual([
      "link     connected",
      "layout   blocks  preset mosque-dark  mode athan",
      "track    soniox  session s1",
      "status   live  provider live  audio ok",
      "latency  p50 0.90 s p95 1.40 s (n=12)",
      "blocks   2 rendered",
    ]);
  });
});

describe("overlay: the roll-up", () => {
  const blockSpecs = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>("#captions .cap-block")).map(
      (b) => `${b.classList.contains("cap-source") ? "source" : "translation"}:${b.lang || b.dir}`,
    );
  const lineText = (role: "source" | "translation"): string =>
    (q(`.cap-${role} .cap-text`)?.textContent ?? "").trim();

  it("rolls the source and translation of the session's segments", async () => {
    const ws = await openOverlay("?layout=rollup");
    ws.accept();
    ws.receive(hello());
    await frame();
    expect(blockSpecs()).toEqual(["source:ar", "translation:nl"]);
    expect(q(".tb")).toBeNull();

    ws.receive(snapshot([segment(1, text("بسم الله"), { nl: text("In de naam van Allah") })]));
    await frame();
    expect(lineText("source")).toBe("بسم الله");
    expect(lineText("translation")).toBe("In de naam van Allah");

    ws.receive({
      type: "segment",
      track: "soniox",
      segment: segment(2, text("الحمد لله"), { nl: text("Alle lof is voor Allah") }),
    });
    await frame();
    expect(lineText("translation")).toBe("In de naam van Allah Alle lof is voor Allah");

    ws.receive({ type: "status", status: status() });
    ws.receive({ type: "clear", track: "other" });
    await frame();
    expect(lineText("translation")).toBe("In de naam van Allah Alle lof is voor Allah");
    ws.receive({ type: "clear", track: "all" });
    await frame();
    expect(lineText("source")).toBe("");
    expect(lineText("translation")).toBe("");
  });

  it("builds the blocks from ?lang=: targets, the source, and an auto-detected source", async () => {
    let ws = await openOverlay("?layout=rollup&lang=nl,en,ar");
    ws.receive(hello());
    await frame();
    expect(blockSpecs()).toEqual(["translation:nl", "translation:en", "source:ar"]);

    ws = await openOverlay("?layout=rollup&lang=nl,en");
    ws.receive(hello({ source: "auto", targets: ["nl"] }));
    await frame();
    expect(blockSpecs()).toEqual(["translation:nl", "source:auto"]);
  });

  it("takes the source language from the snapshot's session, and waits without one", async () => {
    let ws = await openOverlay("?layout=rollup");
    ws.receive(snapshot([], null));
    await frame();
    expect(blockSpecs()).toEqual([]);
    ws = await openOverlay("?layout=rollup&lang=ar");
    ws.receive(snapshot([], { ...SESSION, from: "ur" }));
    await frame();
    expect(blockSpecs()).toEqual(["translation:ar"]);
  });

  it("passes the background choice to the renderer", async () => {
    const rootClass = async (query: string, selector: string): Promise<string> => {
      const ws = await openOverlay(query);
      ws.receive(hello());
      await frame();
      return q(selector)?.className ?? "";
    };
    expect(await rootClass("?layout=rollup", ".cap-root")).toContain("bg-band");
    expect(await rootClass("?layout=rollup&bg=none", ".cap-root")).toContain("bg-none");
    expect(await rootClass("?layout=rollup&bg=shadow", ".cap-root")).toContain("bg-shadow");
    expect(await rootClass("", ".blk-root")).toContain("bg-panel");
    expect(await rootClass("?bg=none", ".blk-root")).toContain("bg-none");
  });

  it("lists the roll-up blocks and the latest segment latencies in the debug panel", async () => {
    const ws = await openOverlay("?layout=rollup&debug=1");
    expect(debugLines()[1]).toBe("layout   rollup  preset lower-third  mode speech");
    expect(debugLines()[5]).toBe("blocks   –");

    ws.receive(hello({ source: "ar", targets: ["en"] }));
    const s1 = segment(1, text("واحد"), { en: text("One") });
    const end1 = SESSION.startedAt + (s1.endMs ?? 0);
    s1.timing = {
      source: "arrival",
      firstTokenAt: 0,
      sourceFinalAt: end1 + 500,
      translationFinalAt: { en: end1 + 700 },
    };
    const s2 = segment(2, text("اثنان", 2, false), {}, { closed: false });
    const s3 = { ...segment(3, text("ثلاثة")), endMs: null };
    ws.receive({ type: "segment", track: "soniox", segment: s1 });
    expect(debugLines().slice(5)).toEqual(["blocks   source:ar, translation:nl", "  #1 closed –"]);

    ws.receive(snapshot([s1, s2, s3]));
    expect(debugLines().slice(5)).toEqual([
      "blocks   source:ar, translation:nl",
      "  #1 closed src 0.50 s en 0.70 s",
      "  #2 open   src – en –",
      "  #3 closed –",
    ]);
  });
});
