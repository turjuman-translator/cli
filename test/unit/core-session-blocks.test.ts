import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passThroughFollower } from "../../src/compose/fast-blocks.js";
import type {
  DetectorAction,
  DetectorSegment,
  EventDetectorApi,
  MarkerId,
} from "../../src/events/types.js";
import type { PrayerEvent, SessionMode } from "../../src/shared/protocol.js";
import { silentFrame, src, tempDirs, toneFrame, tr } from "./helpers/core-fakes.js";
import { makeSession, type SessionSetup } from "./helpers/core-session.js";

const T0 = new Date(2026, 9, 9, 13, 0, 0).getTime();
const temp = tempDirs("core-session-blocks-");

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

/** Passes every segment; an override starts or ends the card. */
class FakeDetector implements EventDetectorApi {
  mode: SessionMode = "speech";
  readonly salah = false;
  readonly seen: DetectorSegment[] = [];

  isFormulaOnly(): boolean {
    return false;
  }

  markers(): MarkerId[] {
    return [];
  }

  onSegment(seg: DetectorSegment): DetectorAction[] {
    this.seen.push(seg);
    return [{ type: "pass", segment: seg }];
  }

  tick(): DetectorAction[] {
    return [];
  }

  override(event: PrayerEvent | "none", now: number): DetectorAction[] {
    if (event === "none") {
      const previous = this.mode;
      this.mode = "speech";
      return previous === "athan" || previous === "iqama" || previous === "salah"
        ? [
            { type: "event-end", event: previous },
            { type: "mode", mode: "speech" },
          ]
        : [{ type: "mode", mode: "speech" }];
    }
    this.mode = event;
    return [
      { type: "event-start", event, discarded: [], hideFormulaBlocksSinceMs: now },
      { type: "mode", mode: event },
    ];
  }
}

function blocksSession(
  s: SessionSetup = {},
  detector: EventDetectorApi | null = new FakeDetector(),
) {
  return makeSession(temp.make(), {
    ...s,
    options: { layout: "blocks", blocks: { detector }, ...s.options },
  });
}

/** One sentence: Arabic words, their translation, then the endpoint. */
async function say(p: ReturnType<typeof blocksSession>, ar: string, nl: string): Promise<void> {
  const provider = p.f.providers.at(-1);
  provider?.tokens([src(ar, 0, 800), tr(nl)]);
  provider?.endpoint();
  await vi.advanceTimersByTimeAsync(2000);
}

describe("session in the blocks layout", () => {
  it("turns segments with Soniox's translation into caption blocks", async () => {
    const detector = new FakeDetector();
    const p = blocksSession({}, detector);
    const { session } = p;
    expect(session.layout).toBe("blocks");
    expect(session.status()).toMatchObject({ layout: "blocks", eventMode: "speech" });
    expect(session.summary()).toMatchObject({ layout: "blocks", eventMode: "speech" });
    session.speech("start");
    expect(p.f.requests[0]?.fastBlocks).toBe(true);
    await flush();
    await say(p, "الحمد لله رب العالمين", "Alle lof is voor Allah, de Heer der werelden.");
    const added = p.of("block.add").map((m) => m.block);
    expect(added.map((b) => [b.kind, b.text])).toEqual([
      ["speech", "Alle lof is voor Allah, de Heer der werelden."],
    ]);
    expect(detector.seen.map((s) => s.text)).toEqual(["الحمد لله رب العالمين"]);
    expect(session.blocks().blocks.map((b) => b.text)).toEqual([
      "Alle lof is voor Allah, de Heer der werelden.",
    ]);
    expect(session.blocks({ limit: 1, before: 1 })).toEqual({ blocks: [], hasMore: false });
    const snaps = session.snapshots();
    expect(snaps.map((m) => m.type)).toEqual(["snapshot", "blocks.snapshot", "mode", "listening"]);
    expect(snaps[1]).toMatchObject({ type: "blocks.snapshot", hasMore: false });
    expect(snaps[2]).toEqual({ type: "mode", mode: "speech" });
    await session.stop("test");
  });

  it("falls back to the rollup layout without the block dependencies", async () => {
    const p = makeSession(temp.make(), { options: { layout: "blocks", blocks: null } });
    expect(p.session.layout).toBe("rollup");
    expect(p.session.status().eventMode).toBeUndefined();
    await p.session.stop("test");
  });

  it("shows an operator's event override as a card in the target language", async () => {
    const p = blocksSession();
    p.session.speech("start");
    p.session.overrideEvent("athan");
    const card = p.of("block.add").at(-1)?.block;
    expect(card).toMatchObject({
      kind: "event",
      event: {
        type: "athan",
        active: true,
        label: { ar: "الأذان", title: "Athan", subtitle: "Oproep tot het gebed" },
      },
    });
    expect(p.of("mode").at(-1)).toEqual({ type: "mode", mode: "athan" });
    expect(p.session.status().eventMode).toBe("athan");
    p.session.overrideEvent("none");
    expect(p.of("block.update").at(-1)?.block.event?.active).toBe(false);
    expect(
      p
        .markers()
        .filter((m) => m.type === "event-override")
        .map((m) => m.event),
    ).toEqual(["athan", "none"]);
    await p.session.stop("test");
    p.session.overrideEvent("iqama");
    expect(p.cap.messages()).toContain("event override ignored (no block pipeline)");
  });

  it("labels cards in English when the target language has no labels", async () => {
    const custom = blocksSession({
      options: { to: "fr" },
      config: {
        events: {
          labels: {
            en: {
              athan: { ar: "الأذان", title: "Athan (en)", subtitle: "Call" },
              iqama: { ar: "الإقامة", title: "Iqama", subtitle: "" },
              salah: { ar: "الصلاة", title: "Prayer", subtitle: "" },
            },
          },
        },
      },
    });
    custom.session.overrideEvent("athan");
    expect(custom.of("block.add").at(-1)?.block.event?.label?.title).toBe("Athan (en)");
    await custom.session.stop("test");
    const builtIn = blocksSession({
      options: { to: "fr" },
      config: {
        events: {
          labels: {
            nl: {
              athan: { ar: "الأذان", title: "Athan", subtitle: "Oproep" },
              iqama: { ar: "الإقامة", title: "Iqama", subtitle: "" },
              salah: { ar: "الصلاة", title: "Gebed", subtitle: "" },
            },
          },
        },
      },
    });
    builtIn.session.overrideEvent("iqama");
    expect(builtIn.of("block.add").at(-1)?.block.event?.label).toEqual({
      ar: "الإقامة",
      title: "Iqama",
      subtitle: "The prayer begins",
    });
    await builtIn.session.stop("test");
  });

  it("leaves the detector out when events are disabled", async () => {
    const detector = new FakeDetector();
    const p = blocksSession({ config: { events: { enabled: false } } }, detector);
    p.session.speech("start");
    await flush();
    await say(p, "الحمد لله", "Alle lof.");
    expect(detector.seen).toEqual([]);
    expect(p.of("block.add")).toHaveLength(1);
    await p.session.stop("test");
  });

  it("builds the Quran follower for the target language", async () => {
    const langs: string[] = [];
    const p = blocksSession({
      options: {
        layout: "blocks",
        blocks: {
          detector: null,
          followerFactory: (lang) => {
            langs.push(lang);
            return passThroughFollower();
          },
        },
      },
    });
    expect(langs).toEqual(["nl"]);
    await p.session.stop("test");
  });

  it("clear('all') forgets the block history; clearing the track keeps it", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    await say(p, "الحمد لله", "Alle lof.");
    p.session.clear("soniox");
    expect(p.of("blocks.snapshot")).toEqual([]);
    expect(p.session.blocks().blocks).toHaveLength(1);
    p.session.clear();
    expect(p.of("blocks.snapshot")).toEqual([
      { type: "blocks.snapshot", blocks: [], hasMore: false },
    ]);
    expect(p.session.blocks().blocks).toEqual([]);
    const lines = readFileSync(join(p.dir() ?? "", "blocks.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toEqual({ type: "clear", at: Date.now() });
    await p.session.stop("test");
  });

  it("has forgotten the blocks when {clear} goes out (the hub answers it with snapshots)", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    await say(p, "الحمد لله", "Alle lof.");
    const seen: number[] = [];
    p.session.subscribe((m) => {
      if (m.type === "clear") seen.push(p.session.blocks().blocks.length);
    });
    p.session.clear();
    expect(seen).toEqual([0]);
    await p.session.stop("test");
  });

  it("drains, announces the end and archives it when stopping", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    p.f.providers[0]?.tokens([src("الحمد لله", 0, 800), tr("Alle lof")]);
    await vi.advanceTimersByTimeAsync(500);
    await p.session.stop("test", { fast: true });
    const ended = p.of("session.ended");
    expect(ended).toEqual([{ type: "session.ended", endedAt: Date.now() }]);
    expect(p.session.blocks().blocks.map((b) => b.text)).toEqual(["Alle lof"]);
    const lines = readFileSync(join(p.dir() ?? "", "blocks.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toEqual(ended[0]);
    expect(p.session.snapshots().at(-1)).toEqual(ended[0]);
  });

  it("drains without a transcript too", async () => {
    const p = blocksSession({ options: { saveTranscripts: false } });
    await p.session.stop("test");
    expect(p.of("session.ended")).toHaveLength(1);
  });

  it("feeds a local session's speech starts and ends to the blocks (listening dots)", async () => {
    const p = blocksSession({ kind: "device" });
    const started = p.session.startLocal();
    const input = p.inputs[0];
    if (input === undefined) throw new Error("no input");
    input.frame(silentFrame());
    await flush();
    expect((await started).ok).toBe(true);
    // The server-side VAD hears speech start: the dots light up until text or quiet.
    for (let i = 0; i < 5; i++) {
      input.frame(toneFrame());
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(p.of("listening").map((m) => m.active)).toEqual([true]);
    input.frame(new Uint8Array(3));
    for (let i = 0; i < 10; i++) {
      input.frame(silentFrame());
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.of("listening").map((m) => m.active)).toEqual([true, false]);
    await p.session.stop("test");
  });

  it("passes page speech events to the blocks", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 10; i++) {
      p.session.speech("start");
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(p.of("listening").map((m) => m.active)).toEqual([true]);
    await p.session.stop("test");
  });
});
