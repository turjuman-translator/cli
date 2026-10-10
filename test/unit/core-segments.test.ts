import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameTimeline } from "../../src/audio/timeline.js";
import {
  NEXT_CLOSE_WINDOW_MS,
  SegmentStore,
  type SegmentStoreOptions,
} from "../../src/core/segments.js";
import type { Segment } from "../../src/shared/protocol.js";
import type { ProviderCapabilities, ProviderEvent, Token } from "../../src/stt/types.js";
import { src, tr } from "./helpers/core-fakes.js";

const T0 = 1_000_000;

const NATIVE: ProviderCapabilities = {
  nativeTranslation: true,
  timing: "provider",
  translationFinalAtEndpoint: false,
};

interface Harness {
  store: SegmentStore;
  upserts: Segment[];
  closed: Array<{ seg: Segment; engineId: string }>;
  done: Array<{ seg: Segment; engineId: string }>;
  late: Array<{ engineId: string; lang: string; text: string }>;
  engine(id: string, caps?: Partial<ProviderCapabilities>, timeline?: FrameTimeline): void;
  tokens(final: Token[], nonFinal?: Token[], engineId?: string): void;
  endpoint(engineId?: string): void;
  seg(seq: number): Segment | undefined;
}

function harness(
  opts: Partial<SegmentStoreOptions> = {},
  caps: Partial<ProviderCapabilities> = {},
): Harness {
  const upserts: Segment[] = [];
  const closed: Harness["closed"] = [];
  const done: Harness["done"] = [];
  const late: Harness["late"] = [];
  const store = new SegmentStore({
    sessionId: "s",
    track: "soniox",
    sourceLang: "ar",
    targetLangs: ["nl"],
    sessionStartWall: T0,
    now: () => Date.now(),
    onUpsert: (seg) => upserts.push(seg),
    onClosed: (seg, engineId) => closed.push({ seg, engineId }),
    onDone: (seg, engineId) => done.push({ seg, engineId }),
    onLateDrop: (info) => late.push(info),
    ...opts,
  });
  const h: Harness = {
    store,
    upserts,
    closed,
    done,
    late,
    engine(id, engineCaps = {}, timeline = new FrameTimeline({ originWallMs: T0 })) {
      store.beginEngine({
        engineId: id,
        capabilities: { ...NATIVE, ...caps, ...engineCaps },
        timeline,
      });
    },
    tokens(final, nonFinal = [], engineId) {
      const e: ProviderEvent = { type: "tokens", final, nonFinal, receivedAt: Date.now() };
      store.apply(e, engineId);
    },
    endpoint(engineId) {
      store.apply({ type: "endpoint", receivedAt: Date.now() }, engineId);
    },
    seg: (seq) => store.snapshot().find((s) => s.seq === seq),
  };
  h.engine("e1");
  return h;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SegmentStore: source text", () => {
  it("appends finals, shows non-finals after them and replaces the non-finals each event", () => {
    const h = harness();
    h.tokens([src("الحمد", 0, 400), src(" لله", 400, 800)], [src(" رب", 800, 1000)]);
    expect(h.seg(1)).toMatchObject({
      id: "s:soniox:1",
      sessionId: "s",
      track: "soniox",
      kind: "speech",
      closed: false,
      startMs: 0,
      endMs: 1000,
      source: { lang: "ar", text: "الحمد لله رب", finalLen: "الحمد لله".length, final: false },
      translations: { nl: { text: "", finalLen: 0, final: false } },
      timing: { source: "provider", firstTokenAt: T0 },
    });
    h.tokens([], [src(" ربّ", 800, 1000), src(" العالمين", 1000, 1400)]);
    expect(h.seg(1)?.source.text).toBe("الحمد لله ربّ العالمين");
    expect(h.seg(1)?.endMs).toBe(1400);
    // An event without source non-finals drops the shown ones.
    h.tokens([]);
    expect(h.seg(1)?.source.text).toBe("الحمد لله");
    expect(h.seg(1)?.endMs).toBe(800);
  });

  it("closes the open segment at an endpoint: final text only, times fixed", () => {
    const h = harness();
    h.tokens([src("الحمد", 0, 400)], [src(" لله", 400, 800)]);
    vi.advanceTimersByTime(250);
    h.endpoint();
    const seg = h.seg(1);
    expect(seg).toMatchObject({
      closed: true,
      startMs: 0,
      endMs: 400,
      source: { text: "الحمد", finalLen: 5, final: true },
      timing: { sourceFinalAt: T0 },
    });
    expect(h.closed.map((c) => [c.seg.seq, c.engineId])).toEqual([[1, "e1"]]);
    expect(h.store.closedCount).toBe(1);
    // An endpoint without an open segment changes nothing.
    h.endpoint();
    expect(h.closed).toHaveLength(1);
  });

  it("never starts a segment's text or translation with whitespace", () => {
    const h = harness();
    h.tokens([src(" بسم", 0, 300), tr(" In")], []);
    expect(h.seg(1)?.source.text).toBe("بسم");
    expect(h.seg(1)?.translations.nl?.text).toBe("In");
  });

  it("takes the language from non-finals until a final token fixes it", () => {
    const h = harness({ sourceLang: "auto" });
    h.tokens([], [src("hello", 0, 300, "en")]);
    expect(h.seg(1)?.source.lang).toBe("en");
    h.tokens([src("مرحبا", 0, 300, "ar")], [src(" there", 300, 600, "en")]);
    expect(h.seg(1)?.source.lang).toBe("ar");
    h.tokens([], [src(" again", 300, 600, "en")]);
    expect(h.seg(1)?.source.lang).toBe("ar");
  });

  it("keeps the session language for tokens without one, and null times without positions", () => {
    const h = harness();
    h.tokens([{ text: "بسم", kind: "source" }], [{ text: " الله", kind: "source" }]);
    expect(h.seg(1)).toMatchObject({ startMs: null, endMs: null, source: { lang: "ar" } });
  });

  it("starts the segment at the first final word's position", () => {
    const h = harness();
    h.tokens([], [src("بسم", 500, 800)]);
    expect(h.seg(1)?.startMs).toBe(500);
    h.tokens([src("بسم", 600, 800), src(" الله", 800, 1200)]);
    expect(h.seg(1)?.startMs).toBe(600);
    h.tokens([src(" الرحمن", 1200, 1600)]);
    expect(h.seg(1)?.startMs).toBe(600);
  });

  it("never lets a segment end before it starts", () => {
    const h = harness();
    h.tokens([src("بسم", 1000, 1200)], [src(" ؟", 500, 600)]);
    expect(h.seg(1)).toMatchObject({ startMs: 1000, endMs: 1000 });
  });

  it("maps positions through the engine's timeline into session time and fixes them at close", () => {
    const timeline = new FrameTimeline({ originWallMs: T0 });
    for (let i = 0; i < 20; i++) timeline.push(T0 + 5000 + (i + 1) * 100 + 40);
    const h = harness();
    h.engine("e2", {}, timeline);
    h.tokens([src("بسم", 0, 400)], [], "e2");
    // Captured 5,040 ms after the session start.
    expect(h.seg(1)).toMatchObject({ startMs: 5040, endMs: 5440 });
    h.endpoint("e2");
    // A frame that arrived with less delay moves the estimate, but not a closed segment.
    timeline.push(T0 + 5000 + 21 * 100);
    h.tokens([src("الله", 2100, 2200)], [], "e2");
    expect(h.seg(1)).toMatchObject({ startMs: 5040, endMs: 5440 });
    expect(h.seg(2)?.startMs).toBe(5000 + 2100);
  });

  it("times arrival-timed segments from token arrival (minus the start offset)", () => {
    const h = harness(
      { arrivalStartOffsetMs: 200 },
      { timing: "arrival", nativeTranslation: false },
    );
    vi.advanceTimersByTime(1000);
    h.tokens([], [src("بسم")]);
    expect(h.seg(1)).toMatchObject({
      startMs: 800,
      endMs: 1000,
      timing: { source: "arrival" },
    });
    vi.advanceTimersByTime(500);
    h.tokens([src("بسم")]);
    vi.advanceTimersByTime(500);
    h.tokens([], [src(" الله")]);
    expect(h.seg(1)).toMatchObject({ startMs: 800, endMs: 1500 });
  });

  it("uses a 300 ms arrival start offset by default", () => {
    const h = harness({}, { timing: "arrival", nativeTranslation: false });
    vi.advanceTimersByTime(1000);
    h.tokens([src("بسم")]);
    expect(h.seg(1)?.startMs).toBe(700);
  });
});

describe("SegmentStore: upserts", () => {
  it("sends a copy at once, then at most one per 100 ms with the latest state", () => {
    const h = harness();
    h.tokens([src("بسم", 0, 300)]);
    expect(h.upserts.map((s) => s.source.text)).toEqual(["بسم"]);
    h.tokens([src(" الله", 300, 600)]);
    h.tokens([src(" الرحمن", 600, 900)]);
    expect(h.upserts).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(h.upserts.map((s) => s.source.text)).toEqual(["بسم", "بسم الله الرحمن"]);
    // Copies: changing one does not change the store.
    const first = h.upserts[0];
    if (first !== undefined) first.source.text = "changed";
    expect(h.seg(1)?.source.text).toBe("بسم الله الرحمن");
  });

  it("flush() sends pending upserts now", () => {
    const h = harness();
    h.tokens([src("بسم", 0, 300)]);
    h.tokens([src(" الله", 300, 600)]);
    h.store.flush();
    expect(h.upserts.map((s) => s.source.text)).toEqual(["بسم", "بسم الله"]);
  });

  it("honours a custom upsert interval and works without callbacks", () => {
    const quiet = new SegmentStore({
      sessionId: "q",
      track: "soniox",
      sourceLang: "ar",
      targetLangs: [],
      sessionStartWall: T0,
    });
    quiet.beginEngine({
      engineId: "e",
      capabilities: NATIVE,
      timeline: new FrameTimeline({ originWallMs: T0 }),
    });
    quiet.apply({ type: "tokens", final: [src("بسم", 0, 300)], nonFinal: [], receivedAt: T0 });
    quiet.apply({ type: "endpoint", receivedAt: T0 });
    expect(quiet.snapshot()[0]?.translations).toEqual({});
    quiet.finalizeAll();

    const h = harness({ upsertIntervalMs: 1000 });
    h.tokens([src("بسم", 0, 300)]);
    h.tokens([src(" الله", 300, 600)]);
    vi.advanceTimersByTime(999);
    expect(h.upserts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.upserts).toHaveLength(2);
  });
});

describe("SegmentStore: native translation", () => {
  it("shows final translation plus the non-final tail on the open segment", () => {
    const h = harness();
    h.tokens([src("الحمد", 0, 400), tr("Alle lof")], [src(" لله", 400, 800), tr(" is…")]);
    expect(h.seg(1)?.translations.nl).toEqual({
      text: "Alle lof is…",
      finalLen: "Alle lof".length,
      final: false,
    });
    // Translation tokens without a language go to the first target; others are ignored.
    h.tokens([{ text: " voor", kind: "translation" }, tr(" für", "de")], [tr(" nicht", "de")]);
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle lof voor");
  });

  it("finalizes at the endpoint when the engine says translations end there", () => {
    const h = harness({}, { translationFinalAtEndpoint: true });
    h.tokens([src("الحمد", 0, 400), tr("Alle lof")], [tr(" is")]);
    vi.advanceTimersByTime(50);
    h.endpoint();
    // Its non-final translation is still shown: not final yet.
    expect(h.seg(1)?.translations.nl?.final).toBe(false);
    expect(h.done).toHaveLength(0);
    vi.advanceTimersByTime(50);
    h.tokens([tr(" is voor Allah")]);
    expect(h.seg(1)?.translations.nl).toEqual({
      text: "Alle lof is voor Allah",
      finalLen: "Alle lof is voor Allah".length,
      final: true,
    });
    expect(h.done).toHaveLength(1);
    expect(h.done[0]?.seg.timing.translationFinalAt).toEqual({ nl: T0 + 100 });
    expect(h.done[0]?.seg.timing.sourceFinalAt).toBe(T0);
  });

  it("routes translations after the endpoint to the closed segment within the grace", () => {
    const h = harness({ translationGraceMs: 600 });
    h.tokens([src("الحمد", 0, 400), tr("Alle lof")]);
    h.endpoint();
    vi.advanceTimersByTime(100);
    h.tokens([tr(" is voor Allah")]);
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle lof is voor Allah");
    h.tokens([src("أيها", 1500, 1900)]);
    expect(h.seg(1)?.translations.nl?.final).toBe(false);
    // The grace ends at T0 + 600: a timer finalizes it as it stands.
    vi.advanceTimersByTime(500);
    expect(h.seg(1)?.translations.nl?.final).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.seg(1)?.translations.nl?.final).toBe(true);
    expect(h.seg(1)?.timing.translationFinalAt).toEqual({ nl: T0 + 100 });
    expect(h.done.map((d) => d.seg.seq)).toEqual([1]);
    h.tokens([tr("O moslims")]);
    expect(h.seg(2)?.translations.nl?.text).toBe("O moslims");
  });

  it("stops offering a closed segment 500 ms after the next one closes", () => {
    const h = harness({ translationGraceMs: 10_000 });
    h.tokens([src("الحمد", 0, 400)]);
    h.endpoint();
    h.tokens([src("أيها", 500, 900)]);
    h.endpoint();
    h.tokens([tr("Alle lof")]);
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle lof");
    vi.advanceTimersByTime(NEXT_CLOSE_WINDOW_MS + 1);
    expect(h.seg(1)?.translations.nl?.final).toBe(true);
    h.tokens([tr("O moslims")]);
    expect(h.seg(2)?.translations.nl?.text).toBe("O moslims");
    expect(h.seg(2)?.translations.nl?.final).toBe(false);
  });

  it("moves the non-final translation along to where the next tokens go", () => {
    const h = harness({ translationGraceMs: 600 });
    h.tokens([src("الحمد", 0, 400)], [tr("Alle")]);
    h.endpoint();
    h.tokens([src("أيها", 500, 900)], [tr("Alle lof")]);
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle lof");
    expect(h.seg(2)?.translations.nl?.text).toBe("");
    vi.advanceTimersByTime(601);
    // Seg 1 is no longer a candidate: the non-final text moves to the open segment.
    expect(h.seg(1)?.translations.nl).toMatchObject({ text: "", final: true });
    expect(h.seg(2)?.translations.nl?.text).toBe("Alle lof");
    h.tokens([], [tr("O")]);
    expect(h.seg(2)?.translations.nl?.text).toBe("O");
    h.tokens([]);
    expect(h.seg(2)?.translations.nl?.text).toBe("");
  });

  it("drops translation tokens that no segment can take", () => {
    const h = harness();
    h.tokens([tr("verloren")]);
    expect(h.late).toEqual([{ engineId: "e1", lang: "nl", text: "verloren" }]);
    expect(h.store.lateTranslationDropped).toBe(1);
    expect(h.store.snapshot()).toEqual([]);
  });

  it("puts mirrored tokens (speech already in the target language) on their own segment", () => {
    const h = harness({ translationGraceMs: 10_000 });
    h.tokens([src("الحمد", 0, 400)]);
    h.endpoint();
    h.tokens(
      [src("goedemorgen", 500, 900, "nl"), tr("goedemorgen"), tr("Alle lof")],
      [src(" allemaal", 900, 1200, "nl"), tr(" allemaal")],
    );
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle lof");
    expect(h.seg(2)).toMatchObject({
      source: { lang: "nl", text: "goedemorgen allemaal" },
      translations: { nl: { text: "goedemorgen allemaal", finalLen: "goedemorgen".length } },
    });
    // The mirrored non-final changes: the open segment is updated.
    h.tokens([], [src(" samen", 900, 1200, "nl"), tr(" samen")]);
    expect(h.seg(2)?.translations.nl?.text).toBe("goedemorgen samen");
    h.tokens([], [src(" samen", 900, 1200, "nl"), tr(" samen")]);
    expect(h.seg(2)?.translations.nl?.text).toBe("goedemorgen samen");
    h.endpoint();
    expect(h.seg(2)?.translations.nl?.text).toBe("goedemorgen");
  });

  it("finalizes an engine's pending translations at a reconnect", () => {
    const h = harness({ translationGraceMs: 10_000 });
    h.tokens([src("الحمد", 0, 400), tr("Alle")], [src(" لله", 400, 800)]);
    h.store.apply({ type: "reconnected", gapMs: 1000, audioOffsetMs: 4000 });
    expect(h.seg(1)).toMatchObject({
      closed: true,
      source: { text: "الحمد" },
      translations: { nl: { text: "Alle", final: true } },
    });
    h.tokens([src("بسم", 0, 300), tr("In")]);
    expect(h.seg(2)).toMatchObject({ startMs: 4000, translations: { nl: { text: "In" } } });
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle");
    // A reconnect with nothing open just starts a new provider session.
    h.endpoint();
    h.store.apply({ type: "reconnected", gapMs: 10, audioOffsetMs: 9000 });
    expect(h.seg(2)?.translations.nl?.final).toBe(true);
  });

  it("keeps a closed segment that has only translation text, and finishes empty ones at once", () => {
    const h = harness({ translationGraceMs: 600 });
    h.tokens([tr("Alleen")], [src("بسم", 0, 300)]);
    expect(h.late).toHaveLength(1);
    h.tokens([tr("vertaling")], [src("بسم", 0, 300)]);
    h.endpoint();
    expect(h.seg(1)).toMatchObject({
      source: { text: "" },
      translations: { nl: { text: "vertaling" } },
    });
    expect(h.store.closedCount).toBe(0);
    expect(h.done).toHaveLength(0);
    h.tokens([], [src("الله", 300, 600)]);
    h.endpoint();
    // Nothing at all: done at once and never shown.
    expect(h.done.map((d) => d.seg.seq)).toEqual([2]);
    expect(h.seg(2)).toBeUndefined();
    expect(h.done[0]?.seg.timing.translationFinalAt).toBeUndefined();
  });

  it("does not wait for translations from an engine without native translation", () => {
    const h = harness({}, { nativeTranslation: false });
    h.tokens([src("بسم", 0, 300), tr("In")], [tr(" de")]);
    h.endpoint();
    vi.advanceTimersByTime(60_000);
    expect(h.seg(1)?.translations.nl).toEqual({ text: "", finalLen: 0, final: false });
    expect(h.done).toHaveLength(0);
    h.store.finalizeAll();
    expect(h.done.map((d) => d.seg.translations.nl?.final)).toEqual([true]);
  });
});

describe("SegmentStore: several target languages", () => {
  it("finishes each language on its own and the segment once all are final", () => {
    const h = harness({ targetLangs: ["nl", "en"] }, { translationFinalAtEndpoint: true });
    h.tokens(
      [src("الحمد", 0, 400), tr("Alle lof", "nl"), tr("All praise", "en")],
      [tr(" is", "nl")],
    );
    h.endpoint();
    // English has nothing pending; Dutch still shows a non-final tail.
    expect(h.seg(1)?.translations).toEqual({
      nl: { text: "Alle lof is", finalLen: 8, final: false },
      en: { text: "All praise", finalLen: 10, final: true },
    });
    h.tokens([], [tr(" is", "nl")]);
    expect(h.done).toHaveLength(0);
    h.store.finalizeAll();
    expect(h.done).toHaveLength(1);
    expect(h.done[0]?.seg.translations).toEqual({
      nl: { text: "Alle lof", finalLen: 8, final: true },
      en: { text: "All praise", finalLen: 10, final: true },
    });
    expect(h.done[0]?.seg.timing.translationFinalAt).toEqual({ nl: T0, en: T0 });
  });

  it("sends a non-final translation without a language to the first target", () => {
    const h = harness({ targetLangs: ["nl", "en"] });
    h.tokens([src("الحمد", 0, 400)], [{ text: "Alle", kind: "translation" }]);
    expect(h.seg(1)?.translations.nl?.text).toBe("Alle");
    expect(h.seg(1)?.translations.en?.text).toBe("");
  });
});

describe("SegmentStore: callbacks that re-enter the store", () => {
  function reentrant(onDoneHook: (store: SegmentStore) => void, maxSegments = 50) {
    const done: Segment[] = [];
    const late: string[] = [];
    let onClosedHook: ((store: SegmentStore) => void) | null = null;
    const store: SegmentStore = new SegmentStore({
      sessionId: "s",
      track: "soniox",
      sourceLang: "ar",
      targetLangs: ["nl"],
      sessionStartWall: T0,
      maxSegments,
      now: () => Date.now(),
      onClosed: () => onClosedHook?.(store),
      onDone: (seg) => {
        done.push(seg);
        onDoneHook(store);
      },
      onLateDrop: (info) => late.push(info.text),
    });
    store.beginEngine({
      engineId: "e1",
      capabilities: NATIVE,
      timeline: new FrameTimeline({ originWallMs: T0 }),
    });
    const tokens = (final: Token[], nonFinal: Token[] = []): void =>
      store.apply({ type: "tokens", final, nonFinal, receivedAt: Date.now() });
    return {
      store,
      done,
      late,
      tokens,
      setOnClosed: (hook: (s: SegmentStore) => void) => {
        onClosedHook = hook;
      },
    };
  }

  it("finishes a segment once when a close callback stops the store", () => {
    const r = reentrant(() => {});
    r.setOnClosed((store) => store.finalizeAll());
    r.tokens([], [src("بسم", 0, 300)]);
    r.store.apply({ type: "endpoint", receivedAt: Date.now() });
    expect(r.done.map((s) => s.seq)).toEqual([1]);
  });

  it("finishes a segment that a close callback opened while the store was stopping", () => {
    const r = reentrant(() => {});
    r.tokens([src("بسم", 0, 300)]);
    let once = true;
    r.setOnClosed(() => {
      if (!once) return;
      once = false;
      r.tokens([src("الله", 300, 600)]);
    });
    r.store.finalizeAll();
    expect(r.done.map((s) => [s.seq, s.source.text])).toEqual([
      [1, "بسم"],
      [2, "الله"],
    ]);
  });

  it("drops a translation for a segment a callback already finished", () => {
    let stopNext = false;
    const r = reentrant((store) => {
      if (stopNext) {
        stopNext = false;
        store.finalizeAll();
      }
    }, 1);
    r.tokens([src("الحمد", 0, 400)]);
    r.store.apply({ type: "endpoint", receivedAt: Date.now() });
    // The next segment evicts the first one; its done callback stops the store mid-event.
    stopNext = true;
    r.tokens([src("goedemorgen", 500, 900, "nl"), tr("goedemorgen")]);
    expect(r.done.map((s) => s.seq)).toEqual([1, 2]);
    expect(r.done[1]?.translations.nl?.text).toBe("");
    expect(r.late).toEqual(["goedemorgen"]);
  });
});

describe("SegmentStore: engines", () => {
  it("routes events by engine id; without one they go to the latest engine", () => {
    const h = harness();
    h.tokens([src("قديم", 0, 300)]);
    h.engine("e2");
    h.tokens([src("جديد", 0, 300)]);
    h.tokens([src(" أيضا", 300, 600)], [], "e1");
    expect(h.store.snapshot().map((s) => s.source.text)).toEqual(["قديم أيضا", "جديد"]);
    expect(h.store.openSegment("e1")?.text).toBe("قديم أيضا");
    expect(h.store.openSegment("e2")?.seq).toBe(2);
  });

  it("refuses to register an engine id twice", () => {
    const h = harness();
    expect(() => h.engine("e1")).toThrow("engine e1 already registered");
  });

  it("ignores events before any engine, for unknown engines and of other kinds", () => {
    const empty = new SegmentStore({
      sessionId: "s",
      track: "soniox",
      sourceLang: "ar",
      targetLangs: ["nl"],
      sessionStartWall: T0,
    });
    empty.apply({ type: "endpoint", receivedAt: T0 });
    expect(empty.snapshot()).toEqual([]);
    const h = harness();
    h.tokens([src("بسم", 0, 300)], [], "nope");
    h.store.apply({ type: "state", state: "live" });
    h.store.apply({ type: "error", fatal: false, message: "x" });
    expect(h.store.snapshot()).toEqual([]);
  });

  it("endEngine() closes its open segment, drops non-finals and ignores its later events", () => {
    const h = harness({ translationGraceMs: 10_000 });
    h.tokens([src("بسم", 0, 300), tr("In")], [src(" الله", 300, 600), tr(" de naam")]);
    h.store.endEngine("e1");
    expect(h.seg(1)).toMatchObject({
      closed: true,
      source: { text: "بسم" },
      translations: { nl: { text: "In", final: true } },
    });
    h.tokens([src("بعد", 600, 900)], [], "e1");
    expect(h.store.snapshot()).toHaveLength(1);
    h.store.endEngine("e1");
    h.store.endEngine("unknown");
    expect(h.done).toHaveLength(1);
  });

  it("endEngine() of an engine with nothing open only stops it", () => {
    const h = harness();
    h.store.endEngine("e1");
    h.tokens([src("بسم", 0, 300)], [], "e1");
    expect(h.store.snapshot()).toEqual([]);
  });

  it("forgets ended engines once no kept segment refers to them", () => {
    const h = harness({ maxSegments: 1 });
    h.tokens([src("بسم", 0, 300)]);
    h.store.endEngine("e1");
    h.engine("e2");
    // e1 still has a kept segment: its id is taken.
    expect(() => h.engine("e1")).toThrow();
    h.tokens([src("الله", 0, 300)], [], "e2");
    h.engine("e3");
    // e1's segment was evicted: the id is free again.
    expect(() => h.engine("e1")).not.toThrow();
  });

  it("openSegment() is null for an unknown engine or an engine with nothing open", () => {
    const h = harness();
    expect(h.store.openSegment("e1")).toBeNull();
    expect(h.store.openSegment("nope")).toBeNull();
    vi.advanceTimersByTime(42);
    h.tokens([src("بسم", 0, 300)], [src(" الله", 300, 600)]);
    expect(h.store.openSegment("e1")).toEqual({
      seq: 1,
      text: "بسم الله",
      firstTokenAt: T0 + 42,
    });
  });
});

describe("SegmentStore: clear, eviction, stop", () => {
  it("clear() cuts the open segment and hides everything; the speech goes on in a new one", () => {
    const h = harness({ translationGraceMs: 10_000 });
    h.tokens([src("الحمد", 0, 400)]);
    h.endpoint();
    h.tokens([src("أيها", 500, 900)], [src(" المسلمون", 900, 1300)]);
    h.store.flush();
    const before = h.upserts.length;
    h.store.clear();
    expect(h.store.snapshot()).toEqual([]);
    expect(h.closed.at(-1)?.seg.meta).toEqual({ cut: true });
    vi.advanceTimersByTime(1000);
    expect(h.upserts.length).toBe(before);
    h.tokens([], [src(" المسلمون", 900, 1300)]);
    expect(h.store.snapshot().map((s) => [s.seq, s.source.text])).toEqual([[3, "المسلمون"]]);
    h.tokens([src(" المسلمون", 900, 1300)]);
    // Transcripts still get the hidden segments.
    h.store.finalizeAll();
    expect(h.done.map((d) => d.seg.seq)).toEqual([1, 2, 3]);
  });

  it("clear() leaves ended engines alone", () => {
    const h = harness();
    h.tokens([src("بسم", 0, 300)]);
    h.store.endEngine("e1");
    h.store.clear();
    expect(h.closed.map((c) => c.seg.meta)).toEqual([undefined]);
  });

  it("keeps the last maxSegments, finalizing each evicted one first", () => {
    const h = harness({ maxSegments: 2, translationGraceMs: 10_000 });
    for (const [i, word] of ["واحد", "اثنان", "ثلاثة"].entries()) {
      h.tokens([src(word, i * 1000, i * 1000 + 500)]);
      h.endpoint();
    }
    expect(h.store.snapshot().map((s) => s.seq)).toEqual([2, 3]);
    expect(h.done.map((d) => d.seg.seq)).toEqual([1]);
    expect(h.done[0]?.seg.translations.nl?.final).toBe(true);
  });

  it("evicts another engine's open segment by closing it first", () => {
    const h = harness({ maxSegments: 1 });
    h.tokens([src("قديم", 0, 300)]);
    h.engine("e2");
    h.tokens([src("جديد", 0, 300)], [], "e2");
    expect(h.closed.map((c) => [c.seg.seq, c.engineId])).toEqual([[1, "e1"]]);
    expect(h.done.map((d) => d.seg.seq)).toEqual([1]);
    expect(h.store.openSegment("e1")).toBeNull();
    // A done segment is evicted without being finished twice.
    h.endpoint("e2");
    h.store.finalizeAll();
    h.store.endEngine("e2");
    expect(h.done.map((d) => d.seg.seq)).toEqual([1, 2]);
  });

  it("does not finish a done segment again when it is evicted", () => {
    const h = harness({ maxSegments: 1 }, { translationFinalAtEndpoint: true });
    h.tokens([src("واحد", 0, 300), tr("een")]);
    h.endpoint();
    expect(h.done.map((d) => d.seg.seq)).toEqual([1]);
    h.tokens([src("اثنان", 400, 700)]);
    expect(h.done.map((d) => d.seg.seq)).toEqual([1]);
    expect(h.store.snapshot().map((s) => s.seq)).toEqual([2]);
  });

  it("finalizeAll() closes and finishes everything and sends the last upserts", () => {
    const h = harness({ translationGraceMs: 10_000 });
    h.tokens([src("الحمد", 0, 400), tr("Alle lof")]);
    h.endpoint();
    h.tokens([src("أيها", 500, 900)], [src(" المسلمون", 900, 1300), tr(" O")]);
    h.store.finalizeAll();
    expect(h.done.map((d) => [d.seg.seq, d.seg.source.text, d.seg.translations.nl?.text])).toEqual([
      [1, "الحمد", "Alle lof"],
      [2, "أيها", ""],
    ]);
    const last = h.upserts.at(-1);
    expect(last).toMatchObject({ seq: 2, closed: true, translations: { nl: { final: true } } });
    // Done segments do not change any more; the engines are ended.
    h.tokens([src("بعد", 0, 300), tr("na")]);
    h.store.finalizeAll();
    expect(h.done).toHaveLength(2);
  });

  it("dispose() stops timers and ignores later events", () => {
    const h = harness({ translationGraceMs: 600 });
    h.tokens([src("الحمد", 0, 400)]);
    h.endpoint();
    h.store.dispose();
    vi.advanceTimersByTime(10_000);
    expect(h.done).toHaveLength(0);
    h.tokens([src("بعد", 0, 300)]);
    h.store.endEngine("e1");
    expect(h.store.snapshot()).toHaveLength(1);
    h.store.dispose();
  });
});
