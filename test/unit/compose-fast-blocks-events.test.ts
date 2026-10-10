// FastBlocks and prayer events (detected or started by hand): formula speech
// waits for the detector, a confirmed call becomes a card, nothing is shown during the Salah.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectorAction, DetectorSegment } from "../../src/events/types.js";
import {
  LABELS,
  pipeline,
  type ScriptedDetector,
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

const start = (
  event: "athan" | "iqama" | "salah",
  discarded: DetectorSegment[],
  extra: { provisional?: boolean; hideSince?: number } = {},
): DetectorAction => ({
  type: "event-start",
  event,
  discarded,
  hideFormulaBlocksSinceMs: extra.hideSince ?? Number.POSITIVE_INFINITY,
  provisional: extra.provisional,
});

/** A detector for the Salah: override("salah") starts it, "none" ends it; it suppresses meanwhile. */
function salahDetector(): ScriptedDetector {
  const d = scriptedDetector();
  d.overrideFn = (event) => {
    if (event === "salah") {
      d.salah = true;
      d.mode = "salah";
      return [start("salah", []), { type: "mode", mode: "salah" }];
    }
    d.salah = false;
    d.mode = "speech";
    return [
      { type: "event-end", event: "salah" },
      { type: "mode", mode: "speech" },
    ];
  };
  d.onSegmentFn = (s) =>
    d.salah ? [{ type: "suppress", segment: s }] : [{ type: "pass", segment: s }];
  return d;
}

describe("FastBlocks: prayer calls", () => {
  it("holds formula speech and replaces a confirmed call by its card", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) => {
      if (/حي على/.test(s.text)) {
        d.mode = "athan";
        return [
          start("athan", [s], { provisional: true, hideSince: 0 }),
          { type: "mode", mode: "athan" },
        ];
      }
      if (/^الله أكبر/.test(s.text)) return [{ type: "hold", segment: s }];
      return [{ type: "pass", segment: s }];
    };
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste", { startMs: null, endMs: 2000 }));
    expect(p.blocks()).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(p.fb.listeningState()).toEqual({ active: true }); // a call may be starting
    p.fb.update(
      seg("s:1", "الله أكبر الله أكبر", "Allah is de grootste, Allah is de grootste", {
        closed: true,
        startMs: null,
        endMs: 3000,
      }),
    );
    p.fb.update(
      seg("s:2", "حي على الصلاة", "Kom naar het gebed", {
        closed: true,
        startMs: 5000,
        endMs: 7000,
      }),
    );
    const blocks = p.blocks();
    expect(blocks).toEqual([
      {
        id: "s:b1",
        seq: 1,
        kind: "event",
        text: "",
        ref: null,
        src: null,
        event: { type: "athan", active: true, startedAt: T0 + 250, label: LABELS.athan },
        lang: "nl",
        segmentIds: [],
        createdAt: T0 + 250,
        startMs: null,
        endMs: null,
      },
    ]);
    expect(p.fb.mode).toBe("athan");
    expect(p.out.filter((o) => o.type === "mode")).toEqual([{ type: "mode", mode: "athan" }]);
    expect(p.log.entries.find((e) => e.msg === "provisional prayer-call card")?.obj).toEqual({
      event: "athan",
    });
    // What the detector was told: the speech times and the silence before each segment.
    expect(d.segments.map((s) => [s.id, s.silenceBeforeMs, s.startMs, s.endMs])).toEqual([
      ["s:1", 1_000_000, undefined, 3000],
      ["s:2", 2000, 5000, 7000],
    ]);
    p.fb.update(
      seg("s:3", "أيها الناس", "O mensen.", { closed: true, startMs: null, endMs: null }),
    );
    expect(d.segments[2]).toEqual({
      id: "s:3",
      text: "أيها الناس",
      at: T0 + 250,
      silenceBeforeMs: 0,
    });
  });

  it("hides the formula blocks shown since the call began", () => {
    const d = scriptedDetector();
    const hideSince = T0 + 7000;
    d.onSegmentFn = (s) =>
      /حي على/.test(s.text) ? [start("athan", [s], { hideSince })] : [{ type: "pass", segment: s }];
    const formula = d.isFormulaOnly;
    d.isFormulaOnly = (text) => {
      if (text.includes("خطأ")) throw new Error("detector bug");
      return formula(text);
    };
    const p = pipeline({ detector: d });
    const say = (id: string, ar: string, nl: string) => {
      p.fb.update(seg(id, ar, nl, { closed: true }));
      vi.advanceTimersByTime(7000);
    };
    say("s:1", "أشهد أن محمدا رسول الله", "Ik getuig dat Mohammed de boodschapper is."); // before
    say("s:2", "وهذا كلام عادي", "En dit is gewone spraak hier.");
    say("s:3", "خطأ في الكلام", "Een fout in de woorden hier.");
    say("s:4", "أشهد أن لا إله إلا الله", "Ik getuig dat er geen god is dan Allah.");
    p.fb.update(seg("s:5", "حي على الصلاة", "Kom naar het gebed", { closed: true }));
    expect(p.shown()).toEqual([
      "Ik getuig dat Mohammed de boodschapper is.",
      "En dit is gewone spraak hier.",
      "Een fout in de woorden hier.",
    ]);
    const hidden = p.blocks().find((b) => b.hidden === true);
    expect(hidden?.text).toBe("Ik getuig dat er geen god is dan Allah.");
    expect(p.history(hidden?.id ?? "").at(-1)).toMatchObject({
      type: "block.update",
      block: { hidden: true },
    });
    // A tiny sentence after it does not join a hidden block.
    p.fb.overrideEvent("none");
    p.fb.update(seg("s:6", "نعم", "Ja.", { closed: true }));
    expect(p.shown().at(-1)).toBe("Ja.");
  });

  it("updates the card when an Athan turns out to be the Iqama, and retracts a false alarm", () => {
    const d = scriptedDetector();
    const held: DetectorSegment[] = [];
    d.onSegmentFn = (s) => {
      if (/حي على/.test(s.text)) return [start("athan", [], { provisional: true })];
      if (/قد قامت/.test(s.text)) return [{ type: "event-change", from: "athan", to: "iqama" }];
      if (/^الله أكبر/.test(s.text)) {
        held.push(s);
        return [{ type: "hold", segment: s }];
      }
      return [{ type: "event-retract", event: "iqama", released: held }];
    };
    const p = pipeline({ detector: d });
    // No card yet: a change or retract has nothing to act on.
    p.fb.update(seg("s:0", "قد قامت الصلاة", "", { closed: true, lang: null }));
    p.fb.update(seg("s:1", "حي على الصلاة", "", { closed: true, lang: null }));
    const card = p.blocks()[0];
    expect(card?.event?.type).toBe("athan");
    p.fb.update(seg("s:2", "قد قامت الصلاة", "", { closed: true, lang: null }));
    expect(p.blocks()[0]?.event).toMatchObject({
      type: "iqama",
      active: true,
      label: LABELS.iqama,
    });
    p.fb.update(seg("s:3", "الله أكبر الله أكبر", "Allah is de grootste.", { closed: true }));
    expect(p.shown()).toEqual([]);
    p.fb.update(seg("s:4", "بل هذا درس", "Nee, dit is een les.", { closed: true }));
    const after = p.blocks();
    expect(after[0]).toMatchObject({
      kind: "event",
      hidden: true,
      event: { type: "iqama", active: false, endedAt: T0 },
    });
    // The held phrase was released and is shown after all, before the next speech.
    expect(p.shown()).toEqual(["Allah is de grootste. Nee, dit is een les."]);
    // A second retract has no card left.
    const before = p.out.length;
    p.fb.update(seg("s:5", "شيء آخر", "", { closed: true, lang: null }));
    expect(p.out.length).toBe(before);
  });

  it("ends the card when the call is over, and ignores an end without a card", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) =>
      /حي على/.test(s.text) ? [start("athan", [s])] : [{ type: "pass", segment: s }];
    d.tickQueue = [
      [{ type: "event-end", event: "athan" }],
      [{ type: "event-end", event: "athan" }],
    ];
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "حي على الفلاح", "Kom naar het succes", { closed: true }));
    vi.advanceTimersByTime(1000);
    expect(p.blocks()[0]?.event).toEqual({
      type: "athan",
      active: false,
      startedAt: T0,
      endedAt: T0 + 250,
      label: LABELS.athan,
    });
    expect(p.history("s:b1").map((o) => o.type)).toEqual(["block.add", "block.update"]);
  });

  it("asks the detector every 500 ms, and releases what it held", () => {
    const d = scriptedDetector();
    d.mode = "held";
    d.onSegmentFn = (s) => [{ type: "hold", segment: s }];
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "من", "Van", { closed: true }));
    expect(p.blocks()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(d.ticks).toEqual([T0 + 250, T0 + 750]); // at most every 500 ms
    d.tickQueue.push([
      {
        type: "release",
        segments: [
          { id: "s:1", text: "من", at: T0, silenceBeforeMs: 0 },
          { id: "gone", text: "", at: T0, silenceBeforeMs: 0 },
        ],
      },
    ]);
    vi.advanceTimersByTime(500);
    expect(p.shown()).toEqual(["Van"]);
  });

  it("releases a held fragment as soon as clear speech follows it", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) =>
      s.text === "من" ? [{ type: "hold", segment: s }] : [{ type: "pass", segment: s }];
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "من", "Van", { closed: true }));
    p.fb.update(seg("s:2", "يعمل مثقال ذرة خيرا يره", " wie een greintje goed doet, zal het zien"));
    expect(p.shown()).toEqual(["Van wie een greintje goed doet, zal het zien"]);
  });

  it("keeps a held fragment while a call is under way", () => {
    for (const setup of ["card", "athan mode", "salah"] as const) {
      const d = scriptedDetector();
      d.onSegmentFn = (s) =>
        s.text === "من" ? [{ type: "hold", segment: s }] : [{ type: "pass", segment: s }];
      const p = pipeline({ detector: d });
      if (setup === "card") {
        d.overrideFn = () => [start("athan", [])];
        p.fb.overrideEvent("athan");
      }
      if (setup === "athan mode") d.mode = "athan";
      p.fb.update(seg("s:1", "من", "Van", { closed: true }));
      if (setup === "salah") d.salah = true;
      p.fb.update(seg("s:2", "يعمل مثقال ذرة خيرا يره", " wie een greintje goed doet"));
      expect(p.shown()).toEqual([]);
    }
  });

  it("drops a held phrase after 90 s so it never blocks the captions behind it", () => {
    const d = scriptedDetector();
    d.mode = "athan"; // no early release
    d.onSegmentFn = (s) =>
      s.text === "الله أكبر" ? [{ type: "hold", segment: s }] : [{ type: "pass", segment: s }];
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste", { closed: true }));
    p.fb.update(seg("s:2", "ثم قال", "Toen zei hij:", { closed: true }));
    vi.advanceTimersByTime(89_750);
    expect(p.blocks()).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(p.shown()).toEqual(["Toen zei hij:"]);
    expect(
      p.log.entries.find((e) => e.msg === "held speech dropped after the hold limit")?.obj,
    ).toEqual({
      segment: "s:1",
    });
  });

  it("never shows formula speech still held at the end of the session", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) => [{ type: "hold", segment: s }];
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste"));
    p.fb.update(seg("s:2", "الله أكبر", "Allah is de grootste", { closed: true }));
    void p.fb.drain(1000);
    vi.advanceTimersByTime(1000);
    expect(p.blocks()).toEqual([]);
  });

  it("survives a detector that fails on the operator's override", () => {
    const d = scriptedDetector();
    d.overrideFn = () => {
      throw new Error("override bug");
    };
    const p = pipeline({ detector: d });
    expect(() => p.fb.overrideEvent("salah")).not.toThrow();
    expect(p.blocks()).toEqual([]);
    expect(p.fb.mode).toBe("speech");
    expect(
      p.log.entries.find((e) => e.msg === "event detector override failed; ignored")?.obj,
    ).toMatchObject({ event: "salah" });
    // Captions go on.
    p.fb.update(seg("s:1", "قال", "Hij zei het.", { closed: true }));
    expect(p.shown()).toEqual(["Hij zei het."]);
  });

  it("shows a segment when the detector fails, and goes on when its tick fails", () => {
    const d = scriptedDetector();
    d.onSegmentFn = () => {
      throw new Error("detector bug");
    };
    d.tick = () => {
      throw new Error("tick bug");
    };
    d.isFormulaOnly = () => {
      throw new Error("formula bug");
    };
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste.", { closed: true }));
    vi.advanceTimersByTime(500);
    expect(p.shown()).toEqual(["Allah is de grootste."]);
    expect(p.log.messages("error")).toEqual([
      "event detector failed; segment shown",
      "event detector tick failed",
    ]);
  });

  it("passes a segment without Arabic at once", () => {
    const d = scriptedDetector();
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "", "", { closed: true, lang: null }));
    expect(d.segments).toEqual([]);
    p.fb.update(seg("s:2", "قال", "Hij zei het.", { closed: true }));
    expect(p.shown()).toEqual(["Hij zei het."]);
  });
});

describe("FastBlocks: the Salah", () => {
  it("shows nothing during the prayer, an ayah neither, and speech again after it", () => {
    const d = salahDetector();
    const follower = scriptedFollower({
      push: (count, from, text) =>
        text.includes("رب العالمين")
          ? {
              verses: [
                verse({
                  ref: "1:2",
                  from,
                  to: count,
                  approved: "Alle lof zij Allah, de Heer der Werelden.",
                }),
              ],
            }
          : {},
    });
    const p = pipeline({ detector: d, follower });
    p.fb.update(seg("s:1", "أيها الناس", "O mensen,")); // a sentence under way
    expect(p.shown()).toEqual(["O mensen,"]);
    p.fb.overrideEvent("salah");
    expect(p.fb.mode).toBe("salah");
    p.fb.update(seg("s:1", "أيها الناس اتقوا الله", "O mensen, vrees Allah.", { closed: true }));
    p.fb.update(seg("s:2", "الحمد لله رب العالمين", "Alle lof zij Allah, de Heer der werelden."));
    vi.advanceTimersByTime(1000);
    expect(p.shown()).toEqual(["O mensen,"]);
    p.fb.update(
      seg(
        "s:2",
        "الحمد لله رب العالمين الرحمن الرحيم",
        "Alle lof zij Allah, de Heer der werelden. De Erbarmer.",
        {
          closed: true,
        },
      ),
    );
    vi.advanceTimersByTime(1000);
    expect(
      p
        .blocks()
        .filter((b) => b.kind !== "event")
        .map((b) => b.text),
    ).toEqual(["O mensen,"]);
    expect(p.fb.listeningState()).toEqual({ active: false }); // no dots in the prayer
    p.fb.overrideEvent("none");
    expect(p.blocks().find((b) => b.kind === "event")?.event).toMatchObject({
      type: "salah",
      active: false,
    });
    p.fb.update(seg("s:3", "أيها الناس", "O mensen, luister goed.", { closed: true }));
    expect(p.shown()).toEqual(["O mensen,", "O mensen, luister goed."]);
    expect(p.out.filter((o) => o.type === "mode").map((o) => o.type === "mode" && o.mode)).toEqual([
      "salah",
      "speech",
    ]);
  });

  it("waits while a prayer is provisional, and shows the speech if it is withdrawn", () => {
    const d = scriptedDetector();
    d.overrideFn = () => [start("salah", [], { provisional: true })];
    const opened: DetectorSegment[] = [];
    d.onSegmentFn = (s) => {
      opened.push(s);
      return [{ type: "event-retract", event: "salah", released: opened }];
    };
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "بعد الإقامة نتكلم", "Na de iqama spreken we"));
    p.fb.overrideEvent("salah");
    p.fb.update(
      seg("s:1", "بعد الإقامة نتكلم عن الصبر", "Na de iqama spreken we over geduld.", {
        closed: true,
      }),
    );
    expect(p.shown()).toEqual(["Na de iqama spreken we", "over geduld."]);
    expect(p.blocks().find((b) => b.kind === "event")?.hidden).toBe(true);
  });

  it("holds open speech when the detector enters the Salah by itself", () => {
    const d = scriptedDetector();
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "الحمد", "Alle"));
    expect(p.shown()).toEqual(["Alle"]);
    d.salah = true; // the detector decided on its own; no action yet
    p.fb.update(seg("s:1", "الحمد لله رب العالمين", "Alle lof zij Allah, Heer der werelden"));
    vi.advanceTimersByTime(500);
    expect(p.shown()).toEqual(["Alle"]);
  });

  it("holds an ayah while the detector is in the Salah, and drops it with its segment", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) => [{ type: "suppress", segment: s }];
    const follower = scriptedFollower({
      push: (count) =>
        count >= 4
          ? { verses: [verse({ ref: "1:2", from: 0, to: count, approved: "Alle lof zij Allah." })] }
          : {},
    });
    const p = pipeline({ detector: d, follower });
    p.fb.update(seg("s:1", "الحمد", "Alle", { trFinal: 0 })); // under way before the prayer
    d.salah = true;
    // Recited words without a final translation yet: only the ayah could show.
    p.fb.update(seg("s:1", "الحمد لله رب العالمين", "Alle lof", { trFinal: 0 }));
    vi.advanceTimersByTime(500);
    expect(p.blocks()).toEqual([]);
    p.fb.update(seg("s:1", "الحمد لله رب العالمين", "Alle lof", { closed: true, trFinal: 0 }));
    d.salah = false;
    vi.advanceTimersByTime(500);
    expect(p.blocks()).toEqual([]);
  });

  it("keeps an ayah's block when the formula blocks are hidden", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) =>
      /حي على/.test(s.text)
        ? [start("athan", [s], { hideSince: 0 })]
        : [{ type: "pass", segment: s }];
    const follower = scriptedFollower({
      push: (count) =>
        count === 4
          ? { verses: [verse({ ref: "112:1", from: 0, to: 4, approved: "Zeg: Hij is Allah." })] }
          : {},
    });
    const p = pipeline({ detector: d, follower });
    p.fb.update(seg("s:1", "قل هو الله أحد", "Zeg: Hij is Allah, Eén.", { closed: true }));
    p.fb.update(seg("s:2", "حي على الصلاة", "Kom naar het gebed", { closed: true }));
    expect(p.shown()).toEqual(["Zeg: Hij is Allah."]);
  });

  it("closes the open block when the detector switches to the Salah mode", () => {
    const d = scriptedDetector();
    d.onSegmentFn = (s) => [{ type: "suppress", segment: s }];
    const p = pipeline({ detector: d });
    p.fb.update(seg("s:1", "قال", "Hij zei"));
    p.fb.update(seg("s:2", "ثم", "En dan"));
    d.tickQueue.push([{ type: "mode", mode: "salah" }]);
    d.mode = "salah";
    vi.advanceTimersByTime(500);
    expect(p.out.filter((o) => o.type === "mode")).toEqual([{ type: "mode", mode: "salah" }]);
    p.fb.update(seg("s:2", "ثم قرأ", "En dan las hij", { closed: true }));
    expect(p.shown()).toEqual(["Hij zei En dan"]);
  });

  it("does not show an ayah from a segment the detector suppressed", () => {
    const d = scriptedDetector();
    d.mode = "athan"; // no early release of the held intro
    d.onSegmentFn = (s) =>
      s.id === "s:1" ? [{ type: "hold", segment: s }] : [{ type: "suppress", segment: s }];
    const follower = scriptedFollower({
      push: (count) =>
        count === 6
          ? { verses: [verse({ ref: "112:1", from: 2, to: 6, approved: "Zeg: Hij is Allah." })] }
          : {},
    });
    const p = pipeline({ detector: d, follower });
    p.fb.update(seg("s:1", "ثم قال", "Toen zei hij:", { closed: true }));
    p.fb.update(seg("s:2", "قل هو الله أحد", "Zeg: Hij is Allah, Eén.", { closed: true }));
    // The ayah waits behind the held intro …
    expect(p.blocks()).toEqual([]);
    d.tickQueue.push([
      { type: "release", segments: [{ id: "s:1", text: "", at: 0, silenceBeforeMs: 0 }] },
    ]);
    vi.advanceTimersByTime(500);
    // … and its segment was suppressed: only the intro is shown.
    expect(p.shown()).toEqual(["Toen zei hij:"]);
  });
});

describe("FastBlocks: a card started by hand, without a detector", () => {
  it("makes the operator's card the mode; a manual Salah is silent", () => {
    const p = pipeline();
    p.fb.overrideEvent("athan");
    expect(p.fb.mode).toBe("athan");
    p.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste.", { closed: true }));
    p.fb.overrideEvent("iqama"); // the Athan card ends, the Iqama card starts
    const cards = p.blocks().filter((b) => b.kind === "event");
    expect(cards.map((b) => [b.event?.type, b.event?.active])).toEqual([
      ["athan", false],
      ["iqama", true],
    ]);
    p.fb.overrideEvent("none");
    p.fb.overrideEvent("none"); // nothing left to end
    p.fb.update(seg("s:2", "أيها الناس", "O mensen, luister.", { closed: true }));
    expect(p.shown()).toEqual(["O mensen, luister."]);
    // A manual Salah: what was being said is cut off, and stays off after the prayer.
    vi.advanceTimersByTime(7000);
    p.fb.update(seg("s:3", "ثم قال", "Toen zei hij"));
    p.fb.overrideEvent("salah");
    p.fb.update(seg("s:4", "الله أكبر", "Allah is de grootste.", { closed: true }));
    p.fb.overrideEvent("none");
    p.fb.update(seg("s:3", "ثم قال كلاما", "Toen zei hij iets", { closed: true }));
    expect(p.shown()).toEqual(["O mensen, luister.", "Toen zei hij"]);
    expect(p.out.filter((o) => o.type === "mode").map((o) => o.type === "mode" && o.mode)).toEqual([
      "athan",
      "iqama",
      "speech",
      "salah",
      "speech",
    ]);
  });
});
