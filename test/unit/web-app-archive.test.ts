// @vitest-environment happy-dom
// The archive page (web/archive.ts, /s/:sessionId): a finished session's blocks read back page by
// page, in the session's caption language, with the toolbar and the exports; and the access key,
// a missing session and a failed load.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Block } from "../../src/shared/protocol.js";
import {
  $,
  $$,
  cleanup,
  click,
  fakeTimers,
  type Opened,
  openPage,
  settle,
  text,
  type,
} from "./helpers/web-app-page.js";
import { FakeServer, type FakeSession } from "./helpers/web-app-server.js";

let server: FakeServer;

beforeEach(() => {
  fakeTimers();
  server = new FakeServer();
  try {
    localStorage.removeItem("captions.fontScale");
  } catch {
    // no storage
  }
});
afterEach(cleanup);

function block(seq: number, over: Partial<Block> = {}): Block {
  return {
    id: `sess-1:b${seq}`,
    seq,
    kind: "speech",
    text: `Line ${seq}`,
    ref: null,
    src: `مصدر ${seq}`,
    lang: "nl",
    segmentIds: [],
    createdAt: Date.UTC(2026, 9, 9, 11, 0, 0) + seq * 1000,
    ...over,
  };
}

function session(over: Partial<FakeSession> = {}): FakeSession {
  const s: FakeSession = {
    blocks: [block(1), block(2), block(3)],
    from: "ar",
    to: "nl",
    startedAt: Date.UTC(2026, 9, 9, 11, 0, 0),
    endedAt: Date.UTC(2026, 9, 9, 11, 40, 0),
    ...over,
  };
  server.sessions.set("sess-1", s);
  return s;
}

function open(path = "/s/sess-1"): Promise<Opened> {
  return openPage("archive", server, () => import("../../web/archive.js"), {
    url: `http://localhost:3000${path}`,
  });
}

const blockTexts = (): string[] =>
  $$(".blk-body", $("#captions")).map((n) => (n.textContent ?? "").trim());

describe("archive page", () => {
  it.each([
    ["no session id", "/s"],
    ["a longer path", "/s/a/b"],
    ["another page", "/x/sess-1"],
    ["a broken escape", "/s/%E0%A4%A"],
  ])("says when the address isn't an archive: %s", async (_case, path) => {
    await open(path);
    expect(text("#arc-msg")).toBe(
      "This isn't an archive address (expected /s/<session id>). Start page",
    );
    expect($("#arc-msg a").getAttribute("href")).toBe("/");
    expect(server.requests()).toEqual(["GET /api/presets"]);
  });

  it("shows the whole session in its caption language, with the toolbar and exports", async () => {
    session();
    await open();
    expect($("#arc-msg").hidden).toBe(true);
    expect(blockTexts()).toEqual(["Line 1", "Line 2", "Line 3"]);
    expect(document.title).toBe("Sessie-archief · sess-1");
    expect(document.documentElement.lang).toBe("nl");
    // The end of the session closes the list.
    expect(text(".blk-end .blk-marker")).toMatch(/^Sessie beëindigd · \d\d:\d\d$/);
    expect(text(".tb-label")).toBe("Sessie-archief");
    expect(text(".tb-chip")).toBe("NL");
    expect($(".tb-dot").className).toBe("tb-dot s-idle");
    expect(text(".tb-state")).toBe(
      new Date(Date.UTC(2026, 9, 9, 11, 0, 0)).toLocaleString("nl", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
    expect($(".tb-dot").title).toBe("sess-1");
    const links = $$<HTMLAnchorElement>(".arc-exports a");
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.title])).toEqual([
      ["TXT", "/api/sessions/sess-1/export.txt", "Exporteren TXT"],
      ["MD", "/api/sessions/sess-1/export.md", "Exporteren MD"],
      ["SRT", "/api/sessions/sess-1/export.srt", "Exporteren SRT"],
    ]);
    expect(links.every((a) => a.hasAttribute("download"))).toBe(true);
    const asked = server.sent.filter((r) => r.path.endsWith("/blocks"));
    expect(asked.map((r) => r.query.toString())).toEqual(["limit=200"]);
  });

  it("reads a long session page by page, oldest first, without repeating a block", async () => {
    const blocks = Array.from({ length: 250 }, (_, i) => block(i + 1));
    session({ blocks, live: true, endedAt: null });
    // The older page overlaps the newer one by a block (a block saved between the two reads).
    server.once("GET /api/sessions/sess-1/blocks", () => ({
      status: 200,
      body: {
        live: true,
        to: "nl",
        blocks: blocks.slice(150, 250).reverse(),
        hasMore: true,
      },
    }));
    server.once("GET /api/sessions/sess-1/blocks", (req) => ({
      status: 200,
      body: { blocks: blocks.slice(0, 151), hasMore: req.query.get("before") !== "151" },
    }));
    await open();
    const asked = server.sent.filter((r) => r.path.endsWith("/blocks"));
    expect(asked.map((r) => r.query.toString())).toEqual(["limit=200", "limit=200&before=151"]);
    const shown = blockTexts();
    expect(shown).toHaveLength(250);
    expect(shown[0]).toBe("Line 1");
    expect(shown[249]).toBe("Line 250");
    expect($(".tb-dot").className).toBe("tb-dot s-live");
    expect($$(".blk-end")).toHaveLength(0);
  });

  it("says so when a session has no caption blocks", async () => {
    session({ blocks: [], startedAt: null, endedAt: null, to: "" });
    // A page that claims more but brings nothing ends the reading.
    server.once("GET /api/sessions/sess-1/blocks", {
      status: 200,
      body: { blocks: [], hasMore: true },
    });
    await open();
    expect(text("#arc-msg")).toBe("This session has no caption blocks.");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Session archive · sess-1");
    expect(text(".tb-state")).toBe("");
    expect(server.sent.filter((r) => r.path.endsWith("/blocks"))).toHaveLength(1);
  });

  it("takes the caption language from the blocks, then from the address", async () => {
    session({ to: "", blocks: [block(1, { lang: "en" })] });
    await open();
    expect(document.documentElement.lang).toBe("en");

    cleanup();
    fakeTimers();
    session({ to: "", blocks: [block(1, { lang: "" })] });
    await open("/s/sess-1?lang=ar&from=ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.title).toMatch(/· sess-1$/);
  });

  it("writes the date plainly when the caption language has no usable locale", async () => {
    session({ to: "", blocks: [block(1, { lang: "not a tag!" })], endedAt: null });
    await open();
    expect(text(".tb-state")).toBe("2026-10-09 11:00");
  });

  it("asks for the access key, and opens the session with it", async () => {
    session({ key: "s3cret" });
    const { nav } = await open("/s/sess-1?preset=classic");
    expect($("#arc-msg").hidden).toBe(true);
    expect($("#arc-key").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("arc-key-input");
    await click("#arc-key button");
    expect(nav.href).not.toHaveBeenCalled();
    type("#arc-key-input", "  s3cret ");
    await click("#arc-key button");
    expect(nav.href).toHaveBeenCalledWith(
      "http://localhost:3000/s/sess-1?preset=classic&key=s3cret",
    );
  });

  it("passes the access key on to the blocks and the exports", async () => {
    session({ key: "s3cret" });
    await open("/s/sess-1?key=s3cret");
    expect(blockTexts()).toEqual(["Line 1", "Line 2", "Line 3"]);
    expect($(".arc-exports a").getAttribute("href")).toBe(
      "/api/sessions/sess-1/export.txt?key=s3cret",
    );
    expect(server.last("GET /api/presets")?.query.get("key")).toBe("s3cret");
  });

  it("asks for the key when the server refuses the reader", async () => {
    session();
    server.once("GET /api/sessions/sess-1/blocks", { status: 403 });
    await open();
    expect($("#arc-key").hidden).toBe(false);
  });

  it("asks a reader of a hosted server to log in (it has no access keys)", async () => {
    session({ key: "s3cret" });
    server.mode = "hosted";
    await open("/s/sess-1?preset=classic");
    expect($("#arc-key").hidden).toBe(true);
    expect(text("#arc-msg")).toBe("Log in to open this session. Log in");
    expect($("#arc-msg a").getAttribute("href")).toBe(
      "/login?next=%2Fs%2Fsess-1%3Fpreset%3Dclassic",
    );
  });

  it("asks for the key when it cannot tell what server this is", async () => {
    session({ key: "s3cret" });
    server.once("GET /api/auth/state", { status: 502 });
    await open();
    expect($("#arc-key").hidden).toBe(false);
  });

  it("says a session doesn't exist", async () => {
    await open("/s/gone%20one");
    expect(text("#arc-msg")).toBe("Session gone one was not found. Start page");
    expect(server.last("GET /api/sessions/gone%20one/blocks")).toBeTruthy();
  });

  it("offers to try again when the session can't be loaded", async () => {
    session();
    server.once("GET /api/sessions/sess-1/blocks", { status: 500 });
    await open("/s/sess-1?size=40");
    expect(text("#arc-msg")).toBe("Couldn't load this session. Try again");
    expect($("#arc-msg a").getAttribute("href")).toBe("http://localhost:3000/s/sess-1?size=40");
  });

  it("makes the text larger and smaller, and toggles the source and the Quran's Arabic", async () => {
    session({ blocks: [block(1), block(2, { kind: "quran", ref: "2:255", quranText: "ٱللَّهُ" })] });
    await open("/s/sess-1?show=both");
    const root = $(".blk-root");
    expect(root.classList.contains("show-both")).toBe(true);
    const [smaller, larger, source, quran] = $$<HTMLButtonElement>(".tb-btn");
    if (!smaller || !larger || !source || !quran) throw new Error("toolbar buttons missing");
    expect(source.hidden).toBe(false);

    await click(larger);
    expect(localStorage.getItem("captions.fontScale")).toBe("1.1");
    expect(document.documentElement.style.getPropertyValue("--cap-font-size")).toMatch(
      /^calc\(.+ \* 1\.1\)$/,
    );
    await click(smaller);
    expect(localStorage.getItem("captions.fontScale")).toBe("1");

    await click(source);
    expect(source.getAttribute("aria-pressed")).toBe("false");
    expect(root.classList.contains("show-target")).toBe(true);
    await click(source);
    expect(root.classList.contains("show-both")).toBe(true);

    const arabicOn = root.classList.contains("quran-ar");
    await click(quran);
    expect(root.classList.contains("quran-ar")).toBe(!arabicOn);
  });

  it("hides the source switch on a source-only page and drops the panel for bg=none", async () => {
    session();
    await open("/s/sess-1?show=source&bg=none");
    const [, , source] = $$<HTMLButtonElement>(".tb-btn");
    expect(source?.hidden).toBe(true);
    expect($(".blk-root").classList.contains("bg-none")).toBe(true);
  });

  it("keeps the panel for the other backgrounds", async () => {
    session();
    await open("/s/sess-1?bg=band");
    expect($(".blk-root").classList.contains("bg-panel")).toBe(true);
    await settle();
  });
});
