import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localTimestamp,
  regenerateMissingSrts,
  SessionTranscript,
  SRT_EVERY,
  sessionFolderName,
  srtNames,
} from "../../src/core/transcripts.js";
import type { Segment } from "../../src/shared/protocol.js";
import { captureLog, ERROR, tempDirs, WARN } from "./helpers/core-fakes.js";

const temp = tempDirs("core-transcripts-");
afterEach(() => temp.cleanup());

const START = new Date(2026, 9, 9, 13, 5, 7, 42).getTime();

function seg(seq: number, text: string, nl = "", lang = "ar"): Segment {
  return {
    id: `abc:soniox:${seq}`,
    sessionId: "abc",
    track: "soniox",
    seq,
    kind: "speech",
    startMs: seq * 1000,
    endMs: seq * 1000 + 500,
    source: { lang, text, finalLen: text.length, final: true },
    translations: { nl: { text: nl, finalLen: nl.length, final: true } },
    closed: true,
    timing: { source: "provider", firstTokenAt: 0 },
  };
}

function transcript(rootDir: string, over: Partial<{ from: string; srt: boolean }> = {}) {
  const cap = captureLog();
  let now = START;
  const t = new SessionTranscript({
    rootDir,
    sessionId: "abc",
    startedAt: START,
    from: over.from ?? "ar",
    to: "nl",
    srt: over.srt ?? true,
    log: cap.log,
    now: () => now++,
  });
  return { t, cap };
}

const read = (file: string): string => readFileSync(file, "utf8");

describe("transcript names", () => {
  it("names the folder <YYYY-MM-DD_HHmm>_<id> and log lines with local time", () => {
    expect(sessionFolderName(START, "abc")).toBe("2026-10-09_1305_abc");
    expect(localTimestamp(START)).toBe("2026-10-09 13:05:07.042");
  });

  it("names SRTs after the pair, the detected language for auto, and avoids a clash", () => {
    expect(srtNames("ar", "nl", [])).toEqual({ source: "ar.srt", target: "nl.srt" });
    expect(srtNames("nl", "nl", [])).toEqual({ source: "nl.source.srt", target: "nl.srt" });
    expect(srtNames("auto", "nl", [])).toEqual({ source: "source.srt", target: "nl.srt" });
    const detected = [
      seg(1, "hello", "", "en"),
      seg(2, "مرحبا", "", "ar"),
      seg(3, "again", "", "en"),
      seg(4, "  ", "", "tr"),
      seg(5, "x", "", "auto"),
    ];
    expect(srtNames("auto", "nl", detected).source).toBe("en.srt");
  });
});

describe("SessionTranscript", () => {
  it("keeps lines in memory until materialized, then writes them in order", () => {
    const root = temp.make();
    const { t } = transcript(root);
    expect(t.dir).toBe(join(root, "2026-10-09_1305_abc"));
    t.logLine("start");
    t.marker("start", { from: "ar" });
    t.marker("plain");
    t.appendBlock('{"id":"b1"}');
    expect(t.materialized).toBe(false);
    expect(existsSync(t.dir)).toBe(false);
    expect(t.materialize()).toBe(true);
    expect(t.materialize()).toBe(true);
    t.logLine("later");
    t.appendBlock('{"id":"b2"}');
    expect(read(join(t.dir, "session.log"))).toBe(
      "2026-10-09 13:05:07.042 start\n2026-10-09 13:05:07.045 later\n",
    );
    const markers = read(join(t.dir, "session.jsonl"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as unknown);
    expect(markers).toEqual([
      { t: START + 1, type: "start", from: "ar" },
      { t: START + 2, type: "plain" },
    ]);
    expect(read(join(t.dir, "blocks.jsonl"))).toBe('{"id":"b1"}\n{"id":"b2"}\n');
  });

  it("creates only the files that have lines", () => {
    const { t } = transcript(temp.make());
    t.materialize();
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it("writes done segments and the SRTs of a track, every ten segments and at finish", () => {
    const { t } = transcript(temp.make());
    const track = t.track("soniox");
    expect(t.track("soniox")).toBe(track);
    track.addDone(seg(2, "الحمد لله", "Alle lof"));
    // Empty segments are not kept.
    track.addDone(seg(3, "  ", " "));
    track.addDone(seg(1, "بسم الله", ""));
    expect(track.segments).toBe(2);
    t.materialize();
    const lines = read(join(track.dir, "segments.jsonl")).trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as Segment).seq)).toEqual([2, 1]);
    expect(existsSync(join(track.dir, "ar.srt"))).toBe(false);
    t.finish();
    // Sorted by start time; the translation reuses the source timing.
    expect(read(join(track.dir, "ar.srt"))).toBe(
      "1\n00:00:01,000 --> 00:00:01,500\nبسم الله\n\n2\n00:00:02,000 --> 00:00:02,500\nالحمد لله\n",
    );
    expect(read(join(track.dir, "nl.srt"))).toBe("1\n00:00:02,000 --> 00:00:02,500\nAlle lof\n");
    // A translation alone counts as text.
    track.addDone(seg(4, "", "Alleen vertaling"));
    for (let i = 5; i < 5 + SRT_EVERY - 2; i++) track.addDone(seg(i, `كلمة ${i}`, `woord ${i}`));
    expect(read(join(track.dir, "nl.srt"))).not.toContain("woord");
    track.addDone(seg(20, "آخر", "laatste"));
    expect(read(join(track.dir, "nl.srt"))).toContain("laatste");
    expect(read(join(track.dir, "segments.jsonl")).trim().split("\n")).toHaveLength(SRT_EVERY + 2);
  });

  it("creates a track folder at once when the session folder already exists", () => {
    const { t } = transcript(temp.make());
    t.materialize();
    const track = t.track("soniox");
    expect(existsSync(track.dir)).toBe(true);
    track.addDone(seg(1, "بسم الله", "In de naam"));
    expect(read(join(track.dir, "segments.jsonl"))).toContain('"seq":1');
  });

  it("sorts segments without a start time first and leaves them out of the SRTs", () => {
    const { t } = transcript(temp.make());
    t.materialize();
    const track = t.track("soniox");
    track.addDone(seg(2, "الحمد لله", "Alle lof"));
    track.addDone({ ...seg(1, "بلا وقت", "zonder tijd"), startMs: null });
    track.addDone({ ...seg(3, "أيضا", "ook"), startMs: null });
    t.finish();
    expect(read(join(track.dir, "nl.srt"))).toBe("1\n00:00:02,000 --> 00:00:02,500\nAlle lof\n");
    const root = temp.make();
    const dir = join(root, "x_s", "soniox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "segments.jsonl"), read(join(track.dir, "segments.jsonl")));
    regenerateMissingSrts(root, captureLog().log);
    expect(read(join(dir, "nl.srt"))).toBe(read(join(track.dir, "nl.srt")));
  });

  it("does not write SRTs when transcripts.srt is off", () => {
    const { t } = transcript(temp.make(), { srt: false });
    t.materialize();
    const track = t.track("soniox");
    track.addDone(seg(1, "بسم الله", "In de naam"));
    t.finish();
    expect(readdirSync(track.dir)).toEqual(["segments.jsonl"]);
  });

  it("names the provider recordings of successive engines", () => {
    const { t } = transcript(temp.make());
    const track = t.track("soniox");
    expect(track.nextRecordFile()).toBe(join(track.dir, "provider.jsonl"));
    expect(track.nextRecordFile()).toBe(join(track.dir, "provider-2.jsonl"));
    expect(track.nextRecordFile()).toBe(join(track.dir, "provider-3.jsonl"));
  });

  it("logs one error when the folder cannot be created, then drops further lines", () => {
    const root = temp.make();
    writeFileSync(join(root, "blocker"), "");
    const { t, cap } = transcript(join(root, "blocker"));
    t.logLine("before");
    expect(t.materialize()).toBe(false);
    expect(t.materialize()).toBe(false);
    t.logLine("after");
    t.marker("after");
    t.appendBlock("{}");
    t.track("soniox").addDone(seg(1, "بسم الله"));
    t.finish();
    expect(t.materialized).toBe(false);
    const errors = cap.lines.filter((l) => l.level === ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe("transcript write failed; transcripts may be incomplete");
    expect(errors[0]?.dir).toBe(t.dir);
  });

  it("logs one error when an append fails and keeps captioning", () => {
    const { t, cap } = transcript(temp.make());
    t.materialize();
    mkdirSync(join(t.dir, "session.log"));
    t.logLine("goes nowhere");
    t.logLine("also nowhere");
    t.marker("still fine?");
    expect(cap.messages(ERROR)).toEqual(["transcript write failed; transcripts may be incomplete"]);
  });

  it("logs an error when an SRT cannot be written", () => {
    const { t, cap } = transcript(temp.make());
    t.materialize();
    const track = t.track("soniox");
    track.addDone(seg(1, "بسم الله", "In de naam"));
    rmSync(track.dir, { recursive: true });
    t.finish();
    expect(cap.messages(ERROR)).toHaveLength(1);
  });

  it("reports a track folder that cannot be created", () => {
    const { t, cap } = transcript(temp.make());
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(join(t.dir, "soniox"), "a file where the folder should be");
    const track = t.track("soniox");
    track.addDone(seg(1, "بسم الله"));
    expect(t.materialize()).toBe(true);
    expect(cap.messages(ERROR)).toHaveLength(1);
  });
});

describe("regenerateMissingSrts", () => {
  function sessionWithSegments(root: string, name: string, segments: Segment[]): string {
    const dir = join(root, name, "soniox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "segments.jsonl"),
      `${segments.map((s) => JSON.stringify(s)).join("\n")}\n\n`,
    );
    return dir;
  }

  it("does nothing when the transcripts folder is missing", () => {
    const { log } = captureLog();
    expect(regenerateMissingSrts(join(temp.make(), "missing"), log)).toEqual([]);
  });

  it("rebuilds missing SRTs next to segments.jsonl and keeps existing ones", () => {
    const root = temp.make();
    const { log } = captureLog();
    const a = sessionWithSegments(root, "2026-10-09_1305_aaa", [
      seg(2, "الحمد لله", "Alle lof"),
      seg(1, "بسم الله", "In de naam"),
    ]);
    const b = sessionWithSegments(root, "2026-10-09_1400_bbb", [seg(1, "بسم الله", "In de naam")]);
    writeFileSync(join(b, "ar.srt"), "kept");
    mkdirSync(join(root, "2026-10-09_1500_ccc"));
    writeFileSync(join(root, "stray.txt"), "");
    const written = regenerateMissingSrts(root, log);
    expect(written.sort()).toEqual([join(a, "ar.srt"), join(a, "nl.srt"), join(b, "nl.srt")]);
    expect(read(join(a, "ar.srt"))).toBe(
      "1\n00:00:01,000 --> 00:00:01,500\nبسم الله\n\n2\n00:00:02,000 --> 00:00:02,500\nالحمد لله\n",
    );
    expect(read(join(b, "ar.srt"))).toBe("kept");
    expect(regenerateMissingSrts(root, log)).toEqual([]);
  });

  it("names the source SRT after the first known language (auto when none)", () => {
    const root = temp.make();
    const { log } = captureLog();
    const dir = sessionWithSegments(root, "s_auto", [seg(1, "hello there", "hallo", "auto")]);
    expect(regenerateMissingSrts(root, log).sort()).toEqual([
      join(dir, "nl.srt"),
      join(dir, "source.srt"),
    ]);
  });

  it("warns and goes on when a segments.jsonl cannot be parsed", () => {
    const root = temp.make();
    const cap = captureLog();
    const dir = join(root, "s_bad", "soniox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "segments.jsonl"), "{ torn\n");
    const good = sessionWithSegments(root, "s_good", [seg(1, "بسم الله", "In de naam")]);
    expect(regenerateMissingSrts(root, cap.log)).toHaveLength(2);
    expect(existsSync(join(good, "nl.srt"))).toBe(true);
    expect(cap.messages(WARN)).toEqual(["could not regenerate SRTs from segments.jsonl"]);
  });
});
