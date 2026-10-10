import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlocksArchive,
  blocksToMarkdown,
  blocksToSrt,
  blocksToTxt,
  EXPORT_TYPES,
  eventLine,
  exportFileName,
  MAX_PAGE,
  pageBlocks,
  renderExport,
  replayBlocks,
} from "../../src/core/blocks-archive.js";
import type { Block } from "../../src/shared/protocol.js";
import { tempDirs } from "./helpers/core-fakes.js";

const temp = tempDirs("core-archive-");
afterEach(() => temp.cleanup());

/** Local-time instant, so clock strings do not depend on the time zone. */
const T = (h: number, m: number): number => new Date(2026, 9, 9, h, m).getTime();

function block(seq: number, over: Partial<Block> = {}): Block {
  return {
    id: `s:b${seq}`,
    seq,
    kind: "speech",
    text: `blok ${seq}`,
    ref: null,
    src: null,
    lang: "nl",
    segmentIds: [],
    createdAt: 0,
    ...over,
  };
}

const lines = (...items: unknown[]): string =>
  items.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("\n");

describe("pageBlocks", () => {
  const all = [1, 2, 3, 4, 5].map((n) => block(n));

  it("returns the newest blocks up to the limit, with hasMore for older ones", () => {
    expect(pageBlocks(all).blocks.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(pageBlocks(all)).toMatchObject({ hasMore: false });
    const page = pageBlocks(all, { limit: 2 });
    expect(page.blocks.map((b) => b.seq)).toEqual([4, 5]);
    expect(page.hasMore).toBe(true);
  });

  it("pages backwards with `before` and clamps the limit to 1..MAX_PAGE", () => {
    expect(pageBlocks(all, { before: 4, limit: 2 }).blocks.map((b) => b.seq)).toEqual([2, 3]);
    expect(pageBlocks(all, { before: 3, limit: 2 }).hasMore).toBe(false);
    expect(pageBlocks(all, { limit: 0 }).blocks.map((b) => b.seq)).toEqual([5]);
    const many = Array.from({ length: MAX_PAGE + 10 }, (_, i) => block(i));
    expect(pageBlocks(many, { limit: 10_000 }).blocks).toHaveLength(MAX_PAGE);
  });
});

describe("replayBlocks", () => {
  it("replays every wrapper as an upsert by id, ordered by seq", () => {
    const text = lines(
      { type: "block.add", block: block(2) },
      { op: "add", block: block(1) },
      block(3),
      { type: "blocks.snapshot", blocks: [block(4), block(5)] },
      { type: "block.update", block: block(2, { text: "bijgewerkt", hidden: true }) },
      "",
      "   ",
    );
    const out = replayBlocks(text);
    expect(out.blocks.map((b) => [b.seq, b.text])).toEqual([
      [1, "blok 1"],
      [2, "bijgewerkt"],
      [3, "blok 3"],
      [4, "blok 4"],
      [5, "blok 5"],
    ]);
    expect(out.blocks[1]?.hidden).toBe(true);
    expect(out.skipped).toBe(0);
    expect(out.endedAt).toBeNull();
  });

  it("reads the end time and skips torn, foreign and invalid lines", () => {
    const text = lines(
      block(1),
      "{ torn",
      "[1,2]",
      "42",
      { type: "clear", at: 5 },
      { type: "session.ended", endedAt: 1234 },
      { type: "session.ended", endedAt: "late" },
      { block: { id: "", seq: 1 } },
      { blocks: [block(2), { id: "x", seq: 1.5, kind: "speech" }] },
      { block: { id: "y", seq: 3, kind: "poem" } },
    );
    const out = replayBlocks(text);
    expect(out.blocks.map((b) => b.seq)).toEqual([1, 2]);
    expect(out.endedAt).toBe(1234);
    // torn, [1,2], 42, clear, session.ended without a number, and three invalid blocks.
    expect(out.skipped).toBe(8);
  });

  it("fills defaults and reads old 'hadith' blocks as speech", () => {
    const out = replayBlocks(JSON.stringify({ id: "old", seq: 7, kind: "hadith" }));
    expect(out.blocks).toEqual([
      {
        id: "old",
        seq: 7,
        kind: "speech",
        text: "",
        ref: null,
        src: null,
        lang: "",
        segmentIds: [],
        createdAt: 0,
      },
    ]);
  });
});

describe("BlocksArchive", () => {
  function sessionDir(root: string, name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  }

  it("reads an ended session's blocks and its start/stop markers", () => {
    const root = temp.make();
    const dir = sessionDir(root, "2026-10-09_1305_abc12345", {
      "blocks.jsonl": lines(block(1), block(2), "{ torn"),
      "session.jsonl": lines(
        "",
        "{ torn",
        "[]",
        { t: 1000, type: "start", from: "ar", to: "nl", kind: "page", orgId: "org-1" },
        { t: 1500, type: "engine-open" },
        { t: 9000, type: "stop" },
      ),
    });
    const archive = new BlocksArchive(root);
    expect(archive.transcriptsDir).toBe(root);
    const s = archive.get("abc12345");
    expect(s).toEqual({
      sessionId: "abc12345",
      dir,
      blocks: [block(1), block(2)],
      startedAt: 1000,
      endedAt: 9000,
      from: "ar",
      to: "nl",
      kind: "page",
      orgId: "org-1",
      skippedLines: 1,
    });
  });

  it("prefers the end time from blocks.jsonl and leaves unknown fields null", () => {
    const root = temp.make();
    sessionDir(root, "2026-10-09_1305_s1", {
      "blocks.jsonl": lines(block(1), { type: "session.ended", endedAt: 7777 }),
      "session.jsonl": lines(
        { type: "start", t: "not a number", from: 3 },
        { t: 9000, type: "stop" },
      ),
    });
    const s = new BlocksArchive(root).get("s1");
    expect(s).toMatchObject({
      startedAt: null,
      endedAt: 7777,
      from: null,
      to: null,
      kind: null,
      orgId: null,
    });
  });

  it("works without session.jsonl and with session.jsonl that cannot be read", () => {
    const root = temp.make();
    sessionDir(root, "a_s1", { "blocks.jsonl": lines(block(1)) });
    const dir = sessionDir(root, "a_s2", { "blocks.jsonl": lines(block(1)) });
    mkdirSync(join(dir, "session.jsonl"));
    const archive = new BlocksArchive(root);
    expect(archive.get("s1")).toMatchObject({ startedAt: null, endedAt: null, from: null });
    expect(archive.get("s2")).toMatchObject({ startedAt: null, endedAt: null, from: null });
  });

  it("finds blocks.jsonl in a track subfolder (older layout)", () => {
    const root = temp.make();
    sessionDir(root, "x_s1", {
      "notes.txt": "",
      "empty/readme": "",
      "soniox/blocks.jsonl": lines(block(3)),
    });
    expect(new BlocksArchive(root).get("s1")?.blocks.map((b) => b.seq)).toEqual([3]);
  });

  it("returns null for unknown sessions, unsafe ids, folders without blocks and missing roots", () => {
    const root = temp.make();
    sessionDir(root, "x_noblocks", { "session.jsonl": "" });
    writeFileSync(join(root, "x_afile"), "not a folder");
    const archive = new BlocksArchive(root);
    expect(archive.get("unknown")).toBeNull();
    expect(archive.get("../etc")).toBeNull();
    expect(archive.get("")).toBeNull();
    expect(archive.get("noblocks")).toBeNull();
    expect(archive.get("afile")).toBeNull();
    expect(new BlocksArchive(join(root, "missing")).get("abc")).toBeNull();
    const fileRoot = join(root, "x_afile");
    expect(new BlocksArchive(fileRoot).findDir("abc")).toBeNull();
  });

  it("returns null when blocks.jsonl is not a readable file", () => {
    const root = temp.make();
    const dir = sessionDir(root, "x_s1", {});
    mkdirSync(join(dir, "blocks.jsonl"));
    expect(new BlocksArchive(root).get("s1")).toBeNull();
  });

  it("takes the newest folder when a session id appears twice", () => {
    const root = temp.make();
    sessionDir(root, "2026-10-08_0900_dup", { "blocks.jsonl": lines(block(1)) });
    const newer = sessionDir(root, "2026-10-09_0900_dup", { "blocks.jsonl": lines(block(2)) });
    expect(new BlocksArchive(root).findDir("dup")).toBe(newer);
  });

  it("caches by file stamp and re-reads a changed file", () => {
    const root = temp.make();
    const dir = sessionDir(root, "x_s1", { "blocks.jsonl": lines(block(1)) });
    const archive = new BlocksArchive(root);
    const first = archive.get("s1");
    expect(archive.get("s1")).toBe(first);
    writeFileSync(join(dir, "blocks.jsonl"), lines(block(1), block(2)));
    utimesSync(join(dir, "blocks.jsonl"), new Date(), new Date(Date.now() + 5000));
    const second = archive.get("s1");
    expect(second).not.toBe(first);
    expect(second?.blocks).toHaveLength(2);
  });

  it("keeps at most eight sessions in its cache", () => {
    const root = temp.make();
    for (let i = 0; i < 10; i++) sessionDir(root, `x_s${i}`, { "blocks.jsonl": lines(block(i)) });
    const archive = new BlocksArchive(root);
    const first = archive.get("s0");
    for (let i = 1; i < 10; i++) archive.get(`s${i}`);
    const cache = Reflect.get(archive, "cache") as Map<string, unknown>;
    expect(cache.size).toBe(8);
    expect(cache.has("s0")).toBe(false);
    // Evicted: read again from disk (an equal but new object).
    const again = archive.get("s0");
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });
});

describe("exports", () => {
  const athan = block(3, {
    kind: "event",
    text: "",
    event: { type: "athan", active: false, startedAt: T(13, 2), endedAt: T(13, 6) },
  });
  const blocks: Block[] = [
    block(1, { text: "  Alle lof is voor Allah  " }),
    block(2, { kind: "quran", text: "Zeg: Hij is Allah", ref: "112:1-2" }),
    athan,
    block(4, { kind: "quran", text: "“Al gequote”", ref: null }),
    block(5, { text: "verborgen", hidden: true }),
    block(6, { kind: "dua", text: "regel een\n\nregel twee" }),
    block(7, { text: "   " }),
  ];

  it("labels event cards with their title and local start time", () => {
    expect(eventLine(athan)).toBe("Athan · 13:02");
    expect(
      eventLine(
        block(1, {
          kind: "event",
          event: {
            type: "iqama",
            active: true,
            startedAt: T(9, 5),
            label: { ar: "الإقامة", title: "Iqama (NL)", subtitle: "" },
          },
        }),
      ),
    ).toBe("Iqama (NL) · 09:05");
    expect(
      eventLine(
        block(1, {
          kind: "event",
          event: {
            type: "salah",
            active: true,
            startedAt: T(9, 5),
            label: { ar: "", title: "", subtitle: "" },
          },
        }),
      ),
    ).toBe("Salah · 09:05");
    expect(eventLine(block(1, { kind: "event" }))).toBe("Event");
  });

  it("exports plain text: visible blocks, quoted Quran with its reference, events in brackets", () => {
    const paragraphs = [
      "Alle lof is voor Allah",
      '"Zeg: Hij is Allah" (112:1–2)',
      "[Athan · 13:02]",
      "“Al gequote”",
      "regel een\n\nregel twee",
    ];
    expect(blocksToTxt(blocks)).toBe(`${paragraphs.join("\n\n")}\n`);
    expect(blocksToTxt([])).toBe("");
    expect(blocksToTxt([block(1, { text: "" })])).toBe("");
  });

  it("exports Markdown with a heading for the pair and the start", () => {
    const md = blocksToMarkdown(blocks, {
      sessionId: "abc",
      from: "ar",
      to: "nl",
      startedAt: T(13, 0),
    });
    expect(md).toBe(
      [
        "# Captions · ar → nl · 2026-10-09 13:00",
        "",
        "Session `abc`",
        "",
        "- **speech**: Alle lof is voor Allah",
        '- **quran**: "Zeg: Hij is Allah" (112:1–2)',
        "- **event**: Athan · 13:02–13:06",
        "- **quran**: “Al gequote”",
        "- **dua**: regel een regel twee",
        "",
      ].join("\n"),
    );
    const running = block(8, {
      kind: "event",
      text: "",
      event: { type: "athan", active: true, startedAt: T(13, 2) },
    });
    const bare = blocksToMarkdown([running], {
      sessionId: "abc",
      from: null,
      to: "nl",
      startedAt: null,
    });
    expect(bare).toBe("# Captions\n\nSession `abc`\n\n- **event**: Athan · 13:02\n");
  });

  it("exports SRT with the blocks' speech times, without events", () => {
    const timed = [
      block(1, { startMs: 0, endMs: 1500 }),
      athan,
      block(2, { kind: "quran", text: "Zeg", ref: "112:1", startMs: 2000, endMs: 3000 }),
      block(3, { startMs: null, endMs: 4000 }),
      block(4),
    ];
    expect(blocksToSrt(timed)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nblok 1\n\n2\n00:00:02,000 --> 00:00:03,000\n"Zeg" (112:1)\n',
    );
  });

  it("renders each format and names the download", () => {
    const meta = { sessionId: "ab/c..12", from: "ar", to: "nl", startedAt: T(13, 0) };
    expect(renderExport("txt", blocks, meta)).toBe(blocksToTxt(blocks));
    expect(renderExport("md", blocks, meta)).toBe(blocksToMarkdown(blocks, meta));
    expect(renderExport("srt", blocks, meta)).toBe(blocksToSrt(blocks));
    expect(exportFileName(meta, "md")).toBe("captions_2026-10-09_abc12.md");
    expect(exportFileName({ ...meta, startedAt: null }, "srt")).toBe("captions_abc12.srt");
    expect(EXPORT_TYPES).toEqual({
      txt: "text/plain; charset=utf-8",
      md: "text/markdown; charset=utf-8",
      srt: "application/x-subrip; charset=utf-8",
    });
  });
});
