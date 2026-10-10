// EventDetector state machine: the transitions the replay
// fixtures (events-replay.test.ts) do not reach, each from a fresh detector.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventDetector, type EventsConfig, RETRACT_WINDOW_MS } from "../../src/events/detector.js";
import type { DetectorAction, DetectorSegment } from "../../src/events/types.js";

const CFG: EventsConfig = {
  enabled: true,
  silenceBeforeSec: 5,
  holdMaxSec: 75,
  endSilenceSec: 20,
  salahMode: true,
  salahMaxMin: 12,
};
const T = 1_000_000;

const TAKBIR = "الله أكبر الله أكبر";
const OPENING = "الله أكبر الله أكبر أشهد أن لا إله إلا الله";
const SPEECH = "أيها الناس اتقوا ربكم واعلموا أن الموت حق";

function seg(
  id: string,
  text: string,
  at: number,
  extra: Partial<DetectorSegment> = {},
): DetectorSegment {
  return { id, text, at, silenceBeforeMs: 0, ...extra };
}

/** Segment spoken over `ms` of session time (delivery rate). */
function timed(id: string, text: string, at: number, ms: number): DetectorSegment {
  return seg(id, text, at, { startMs: at - T, endMs: at - T + ms });
}

function describeAction(a: DetectorAction): string {
  switch (a.type) {
    case "pass":
    case "hold":
    case "suppress":
      return `${a.type} ${a.segment.id}`;
    case "release":
      return `release ${a.segments.map((s) => s.id).join(",")}`;
    case "event-start":
      return `start ${a.event}${a.provisional === true ? "?" : ""} ${a.discarded.map((s) => s.id).join(",")}`;
    case "event-change":
      return `change ${a.from}>${a.to}`;
    case "event-retract":
      return `retract ${a.event} ${a.released.map((s) => s.id).join(",")}`;
    case "event-end":
      return `end ${a.event}`;
    case "mode":
      return `mode ${a.mode}`;
  }
}

/** Compact, readable action log. */
function show(actions: readonly DetectorAction[]): string[] {
  return actions.map(describeAction);
}

function detector(cfg: Partial<EventsConfig> = {}): EventDetector {
  return new EventDetector({ ...CFG, ...cfg }, { now: () => T });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventDetector basics", () => {
  it("exposes the marker helpers", () => {
    const det = detector();
    expect(det.isFormulaOnly(TAKBIR)).toBe(true);
    expect(det.isFormulaOnly(SPEECH)).toBe(false);
    expect(det.markers(OPENING)).toEqual(["TAKBIR", "SHAHADA1"]);
    expect(det.mode).toBe("speech");
    expect(det.salah).toBe(false);
  });

  it("uses Date.now by default, and the clock for a segment without a finite time", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T);
    const det = new EventDetector(CFG);
    expect(show(det.onSegment(seg("a", TAKBIR, Number.NaN)))).toEqual(["mode held", "hold a"]);
    expect(now).toHaveBeenCalled();
    // The hold started at the clock's time: it ends holdMaxSec later.
    expect(det.tick(T + 74_999)).toEqual([]);
    expect(show(det.tick(T + 75_000))).toEqual(["release a", "mode speech"]);
  });

  it("passes everything through when events are disabled", () => {
    const det = detector({ enabled: false });
    expect(show(det.onSegment(seg("a", OPENING, T)))).toEqual(["pass a"]);
    expect(show(det.onSegment(seg("b", "قد قامت الصلاة قد قامت الصلاة", T + 1000)))).toEqual([
      "pass b",
    ]);
    expect(det.mode).toBe("speech");
  });
});

describe("Athan detection", () => {
  it("takbir + shahada not spoken at speech pace is a provisional Athan", () => {
    const det = detector();
    // Untimed (no startMs/endMs and no previous segment): no delivery rate, so not speech pace.
    expect(show(det.onSegment(seg("a", "الله أكبر أشهد أن لا إله إلا الله", T)))).toEqual([
      "start athan? a",
      "mode athan",
    ]);
    expect(det.mode).toBe("athan");
  });

  it("estimates the delivery rate from the time between segments (sung takbir)", () => {
    const det = detector();
    expect(show(det.onSegment(seg("a", TAKBIR, T)))).toEqual(["mode held", "hold a"]);
    // 5 s later, no silence: 2 words over 5 s = 0.4 w/s, sung, so the Athan.
    expect(show(det.onSegment(seg("b", "الله أكبر", T + 5000)))).toEqual([
      "start athan? a,b",
      "mode athan",
    ]);
  });

  it("does not trust an estimate that is too short or too long", () => {
    // 100 ms after the previous segment: no estimate, so no rate, so no Athan yet.
    const quick = detector();
    quick.onSegment(seg("a", TAKBIR, T));
    expect(show(quick.onSegment(seg("b", "الله أكبر", T + 100)))).toEqual(["hold b"]);
    // 40 s after it (more than 30 s of speech): no estimate either.
    const slow = detector();
    slow.onSegment(seg("a", TAKBIR, T));
    expect(show(slow.onSegment(seg("b", "الله أكبر", T + 40_000)))).toEqual(["hold b"]);
    // The silence before a segment is not speech: 5 s later after 4.9 s of silence = 100 ms.
    const paused = detector();
    paused.onSegment(seg("a", TAKBIR, T));
    expect(
      show(paused.onSegment(seg("b", "الله أكبر", T + 5000, { silenceBeforeMs: 4900 }))),
    ).toEqual(["hold b"]);
  });

  it("a provisional Athan becomes the Iqama on قد قامت الصلاة (same card, now definitive)", () => {
    const det = detector();
    det.onSegment(seg("a", "الله أكبر أشهد أن لا إله إلا الله", T));
    expect(show(det.onSegment(seg("b", "قد قامت الصلاة قد قامت الصلاة", T + 3000)))).toEqual([
      "change athan>iqama",
      "mode iqama",
      "suppress b",
    ]);
    // Definitive: clear speech within the retract window ends it instead of retracting it, and
    // the Salah follows (provisional until Al-Fatiha: the speech is held, never shown).
    expect(show(det.onSegment(seg("c", SPEECH, T + 5000)))).toEqual([
      "end iqama",
      "start salah? ",
      "mode salah",
      "hold c",
    ]);
  });

  it("a provisional Athan becomes a provisional Iqama on a fast HAYYA, which speech retracts", () => {
    const det = detector();
    det.onSegment(seg("a", "الله أكبر أشهد أن لا إله إلا الله", T));
    // 6 words in 1.5 s = 4 w/s: the Iqama's pace.
    expect(show(det.onSegment(timed("b", "حي على الصلاة حي على الفلاح", T + 3000, 1500)))).toEqual([
      "change athan>iqama",
      "mode iqama",
      "suppress b",
    ]);
    expect(show(det.onSegment(seg("c", SPEECH, T + 6000)))).toEqual([
      "retract iqama a,b",
      "mode speech",
      "pass c",
    ]);
  });

  it("a definitive Athan does not turn into the Iqama by pace", () => {
    const det = detector();
    det.override("athan", T);
    expect(show(det.onSegment(timed("b", OPENING, T + 3000, 1500)))).toEqual(["suppress b"]);
    expect(det.mode).toBe("athan");
  });
});

describe("fast Iqama (speech pace)", () => {
  /** One fast segment (≈ 5 w/s): what does it start? */
  function fast(text: string): string[] {
    return show(detector().onSegment(timed("q", text, T, 2000)));
  }

  it("takbir + shahada + HAYYA under way (a trailing حي / حي على …)", () => {
    for (const tail of ["حي", "حي على", "حي علا", "حي عل"]) {
      expect(fast(`${OPENING} ${tail}`), tail).toEqual(["start iqama? q", "mode iqama"]);
    }
  });

  it("not when the words after حي are no HAYYA (held instead)", () => {
    expect(fast(`${OPENING} حي الفلا`)).toEqual(["mode held", "hold q"]);
    expect(fast(OPENING)).toEqual(["mode held", "hold q"]);
  });

  it("the whole opening: takbir ×2 and both shahadas (TAHLIL for the first)", () => {
    expect(fast("الله أكبر الله أكبر لا إله إلا الله أشهد أن محمدا رسول الله")).toEqual([
      "start iqama? q",
      "mode iqama",
    ]);
    expect(fast("الله أكبر لا إله إلا الله أشهد أن محمدا رسول الله")).toEqual([
      "mode held",
      "hold q",
    ]);
  });

  it("قد قامت الصلاة in speech right after a held call is the Iqama", () => {
    const det = detector();
    expect(show(det.onSegment(timed("a", OPENING, T, 2000)))).toEqual(["mode held", "hold a"]);
    expect(
      show(det.onSegment(seg("b", "قد قامت الصلاة فاستووا واعتدلوا وتراصوا", T + 3000))),
    ).toEqual(["start iqama a,b", "mode iqama"]);
  });

  it("a stray fragment stays held with the call; clear speech releases both", () => {
    const det = detector();
    det.onSegment(timed("a", OPENING, T, 2000));
    expect(show(det.onSegment(seg("b", "استووا", T + 3000)))).toEqual(["hold b"]);
    expect(show(det.onSegment(seg("c", SPEECH, T + 6000)))).toEqual([
      "release a,b",
      "mode speech",
      "pass c",
    ]);
  });
});

describe("operator overrides", () => {
  it("none in plain speech still reports mode speech", () => {
    const det = detector();
    expect(show(det.override("none", T))).toEqual(["mode speech"]);
  });

  it("switching from a call to Salah ends the call", () => {
    const det = detector();
    det.onSegment(seg("a", "الله أكبر أشهد أن لا إله إلا الله", T));
    expect(show(det.override("salah", T + 1000))).toEqual([
      "end athan",
      "start salah ",
      "mode salah",
    ]);
    expect(det.salah).toBe(true);
  });

  it("switching from a provisional Salah to the Athan never shows what the Salah held", () => {
    const det = detector({ salahMode: true });
    det.override("iqama", T);
    // The Iqama ends after endSilenceSec: a provisional Salah follows and holds speech.
    expect(show(det.tick(T + 20_000))).toEqual(["end iqama", "start salah? ", "mode salah"]);
    expect(show(det.onSegment(seg("s", SPEECH, T + 21_000)))).toEqual(["hold s"]);
    expect(show(det.override("athan", T + 22_000))).toEqual([
      "suppress s",
      "end salah",
      "start athan ",
      "mode athan",
    ]);
  });
});

describe("Salah", () => {
  it("forgets a tasleem more than 30 formula fragments back", () => {
    const det = detector();
    det.override("salah", T);
    let t = T;
    const say = (id: string, text: string): string[] => {
      t += 1000;
      return show(det.onSegment(seg(id, text, t)));
    };
    expect(say("t1", "السلام عليكم ورحمة الله")).toEqual(["suppress t1"]);
    for (let i = 0; i < 30; i++) expect(say(`k${i}`, "الله أكبر")).toEqual([`suppress k${i}`]);
    // The first tasleem left the 30-fragment run: this one is the first again.
    expect(say("t2", "السلام عليكم ورحمة الله")).toEqual(["suppress t2"]);
    expect(det.mode).toBe("salah");
    expect(say("t3", "السلام عليكم ورحمة الله")).toEqual([
      "end salah",
      "mode speech",
      "suppress t3",
    ]);
  });

  it("ends after salahMaxMin at the latest", () => {
    const det = detector({ salahMaxMin: 12 });
    det.override("salah", T);
    expect(det.tick(T + 12 * 60_000 - 1)).toEqual([]);
    expect(show(det.tick(T + 12 * 60_000))).toEqual(["end salah", "mode speech"]);
  });
});

describe("timing constants", () => {
  it("a provisional card is retractable for RETRACT_WINDOW_MS", () => {
    const det = detector();
    det.onSegment(seg("a", "الله أكبر أشهد أن لا إله إلا الله", T));
    // Past the window the card is definitive: speech ends the Athan instead of retracting it.
    expect(show(det.onSegment(seg("b", SPEECH, T + RETRACT_WINDOW_MS)))).toEqual([
      "end athan",
      "mode speech",
      "pass b",
    ]);
  });
});
