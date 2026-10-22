// Calm captions with the real fast blocks inside: the signal that a block is complete, no tail
// joins in calm mode (and the same ones as before in live mode), a sentence that never grows on
// screen, a recited ayah at once after the speech before it, and formula speech that is hidden
// before it ever showed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FastBlocks, type FastBlocksOptions } from "../../src/compose/fast-blocks.js";
import { Pacer } from "../../src/compose/pacer.js";
import type { FollowerVerse, PipelineOutput } from "../../src/compose/types.js";
import type { DetectorAction, DetectorSegment } from "../../src/events/types.js";
import type { Block } from "../../src/shared/protocol.js";
import {
  captureLog,
  LABELS,
  pipeline,
  scriptedDetector,
  scriptedFollower,
  seg,
  verse,
} from "./helpers/compose-fast-blocks.js";

const T0 = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** The pacer around fast blocks, as a calm session makes it. */
function calm(over: Partial<FastBlocksOptions> = {}) {
  const out: PipelineOutput[] = [];
  const persisted: Block[] = [];
  const log = captureLog();
  const pacer = new Pacer({
    sessionId: "s",
    now: () => Date.now(),
    log: log.logger,
    persist: (line) => persisted.push(JSON.parse(line) as Block),
    emit: (o) => out.push(o),
    inner: (hooks) =>
      new FastBlocks({
        sessionId: "s",
        targetLang: "nl",
        follower: scriptedFollower(),
        detector: null,
        labels: LABELS,
        now: () => Date.now(),
        log: log.logger,
        ...over,
        ...hooks,
      }),
  });
  return {
    pacer,
    out,
    persisted,
    adds: (): Block[] => out.flatMap((o) => (o.type === "block.add" ? [o.block] : [])),
    updates: (): Block[] => out.flatMap((o) => (o.type === "block.update" ? [o.block] : [])),
  };
}

const start = (
  event: "athan",
  discarded: DetectorSegment[],
  hideSince: number,
): DetectorAction => ({
  type: "event-start",
  event,
  discarded,
  hideFormulaBlocksSinceMs: hideSince,
});

describe("fast blocks tells when a block is complete", () => {
  it("once per block, with its final text, after its last update", () => {
    const closed: Array<{ block: Block; after: number }> = [];
    const p = pipeline({ closed: (block) => closed.push({ block, after: p.out.length }) });
    p.fb.update(seg("s:1", "الحمد لله رب العالمين", "Alle lof is voor Allah,"));
    expect(closed).toEqual([]);
    p.fb.update(
      seg("s:1", "الحمد لله رب العالمين", "Alle lof is voor Allah, de Heer der werelden.", {
        closed: true,
      }),
    );
    vi.advanceTimersByTime(12_000);
    expect(closed).toEqual([{ block: p.blocks()[0], after: p.out.length }]);
    expect(closed[0]?.block.text).toBe("Alle lof is voor Allah, de Heer der werelden.");
  });

  it("then never lets a short next sentence join it (live mode still does)", () => {
    const first = "Dat is een goede zin met genoeg woorden.";
    const sayAll = (p: ReturnType<typeof pipeline>): string[] => {
      p.fb.update(seg("s:1", "هذه جملة جيدة فيها كلمات كثيرة", first, { closed: true }));
      vi.advanceTimersByTime(2000);
      p.fb.update(seg("s:2", "نعم", " Ja.", { closed: true }));
      vi.advanceTimersByTime(2000);
      return p.shown();
    };
    expect(sayAll(pipeline({ closed: () => undefined }))).toEqual([first, "Ja."]);
    expect(sayAll(pipeline())).toEqual([`${first} Ja.`]);
  });
});

describe("calm captions around fast blocks", () => {
  it("never show a sentence growing: it appears once, complete", () => {
    const c = calm();
    const ar = "إن الحمد لله نحمده ونستعينه ونستغفره ونعوذ بالله من شرور أنفسنا";
    c.pacer.update(seg("s:1", ar.split(" ").slice(0, 4).join(" "), "Alle lof is voor Allah,"));
    vi.advanceTimersByTime(400);
    c.pacer.update(
      seg("s:1", ar.split(" ").slice(0, 7).join(" "), "Alle lof is voor Allah, wij prijzen Hem"),
    );
    vi.advanceTimersByTime(400);
    expect(c.out).toEqual([]);
    c.pacer.update(
      seg("s:1", ar, "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.", {
        closed: true,
        startMs: 0,
        endMs: 3000,
      }),
    );
    vi.advanceTimersByTime(2000);
    expect(c.out).toEqual([
      {
        type: "block.add",
        block: {
          id: "s:b1",
          seq: 1,
          kind: "speech",
          text: "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.",
          ref: null,
          src: ar,
          lang: "nl",
          segmentIds: ["s:1"],
          createdAt: T0 + 2500,
          startMs: 0,
          endMs: 3000,
        },
      },
    ]);
    expect(c.persisted).toEqual(c.adds());
    c.pacer.close();
  });

  it("show a recited ayah at once, right after the speech said before it", () => {
    let reported: FollowerVerse | null = null;
    // Words 6.. of the stream are 3:102 (after "بسم الله" and a 4-word intro).
    const follower = scriptedFollower({
      push: (count, from) => {
        if (reported === null && count >= 11) {
          reported = verse({
            ref: "3:102",
            from: 6,
            to: count,
            approved: "O jullie die geloven, vreest Allah met ware vrees.",
            uthmani: "يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟",
          });
          return { verses: [reported] };
        }
        if (reported !== null && from >= 6) {
          return { verses: [{ ...reported, to: count, isNew: false }] };
        }
        return { decidedTo: Math.min(count, 6) };
      },
    });
    const c = calm({ follower });
    // An earlier step, so the speech waits for its gap.
    c.pacer.update(seg("s:0", "بسم الله", "In de naam van Allah.", { closed: true }));
    vi.advanceTimersByTime(2000);
    expect(c.adds()).toHaveLength(1);
    c.pacer.update(seg("s:1", "قال الله تعالى في", "Allah de Verhevene zei"));
    c.pacer.update(
      seg(
        "s:1",
        "قال الله تعالى في يا أيها الذين آمنوا اتقوا الله حق تقاته",
        "Allah de Verhevene zei: O jullie die geloven, vrees Allah zoals Hij gevreesd moet worden.",
        { closed: true },
      ),
    );
    expect(c.adds().map((b) => [b.kind, b.text, b.ref, b.createdAt - T0])).toEqual([
      ["speech", "In de naam van Allah.", null, 1500],
      ["speech", "Allah ﷾ zei", null, 2000],
      ["quran", "O jullie die geloven, vreest Allah met ware vrees.", "3:102", 2000],
    ]);
    c.pacer.close();
  });

  it("never show formula speech that the call's card hides", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) =>
      /حي على/.test(s.text) ? [start("athan", [s], T0)] : [{ type: "pass", segment: s }];
    const c = calm({ detector: d });
    c.pacer.update(
      seg("s:1", "وهذا كلام عادي جدا", "En dit is gewone spraak hier.", { closed: true }),
    );
    vi.advanceTimersByTime(2000);
    c.pacer.update(
      seg("s:2", "أشهد أن لا إله إلا الله", "Ik getuig dat er geen god is dan Allah.", {
        closed: true,
      }),
    );
    vi.advanceTimersByTime(2000);
    c.pacer.update(seg("s:3", "حي على الصلاة", "Kom naar het gebed", { closed: true }));
    vi.advanceTimersByTime(20_000);
    expect(c.adds().map((b) => [b.kind, b.text])).toEqual([
      ["speech", "En dit is gewone spraak hier."],
      ["event", ""],
    ]);
    expect(c.updates()).toEqual([]);
    expect(c.out.filter((o) => o.type === "mode")).toEqual([]);
    c.pacer.close();
  });
});
