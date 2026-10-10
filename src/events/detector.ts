// Rule-based Athan / Iqama / Salah detection, early provisional cards, silent Salah, operator
// override.
//
// Every final segment goes through onSegment() before it is shown; the returned actions say what to
// do with it. Within one call the order is: state transitions (release / event-start /
// event-change / event-retract / event-end), then a `mode` action when the mode changed, then the
// segment's own disposition (pass / hold / suppress). A segment consumed by an event is listed in
// `event-start.discarded` (or suppressed while the event runs).
//
// Soniox cuts the sung call mid-phrase ("الله." | "أكبر، الله." | "أكبر."), so formula-only is
// judged per segment with the call's vocabulary (markers.ts), phrase markers are found in the joined
// text of the current formula run (consecutive formula-only segments), and the delivery rate (words
// per second of speech, from startMs/endMs) tells the sung Athan (≤ 1.6 w/s) from the Iqama
// (> 2.2 w/s) and from the khatib.
//
//   speech → held    Every formula-only segment is held until the detector decides; a non-formula
//                    segment releases the held ones in order (then passes); so does holdMaxSec
//                    without a new held segment.
//   → iqama          QAD_QAMAT in the run (said twice, after silence, or after ≥ 2 other phrases):
//                    definitive. Provisional: a fast delivery of takbir + shahada + HAYYA (or a
//                    trailing "حي"), or of the whole opening (takbir ×2, both shahadas).
//   → athan          Provisional, as soon as the run has ≥ 2 formula-only segments with takbir and
//                    a slow sung delivery (≤ 1.6 w/s over ≥ 4 s), or takbir + shahada (any order
//                    across fragments) not spoken fast; or HAYYA with the opening / ≥ 4 phrases /
//                    ≥ 2 phrases after silence.
//   provisional      A provisional Athan becomes the Iqama on QAD_QAMAT or a fast HAYYA
//                    (event-change, same card). Clear speech within RETRACT_WINDOW_MS of the card
//                    retracts it (event-retract with everything it consumed, in order); after that
//                    it is definitive silently.
//   athan / iqama    Formula segments are suppressed. endSilenceSec without one, or clear speech,
//                    ends the call; a stray fragment (≤ 2 words) is suppressed without ending it.
//   iqama → salah    (salahMode) Silence: EVERY segment is suppressed, recitation included, until
//                    the tasleem is said twice (fragments joined), the operator's "none", or
//                    salahMaxMin. After an Iqama the Salah card is provisional until Al-Fatiha is
//                    heard (≥ 2 of its verses): until then segments are held (never shown), then
//                    suppressed; 3 clear non-Fatiha sentences first mean no prayer started (e.g. a
//                    false Iqama, or a talk after it): the card is retracted and they are shown.
// The khutbah's own takbir and shahada never trigger: mixed with content they are not
// formula-only, a lone formula line is only held until the next sentence, and takbir + shahada
// spoken at speech pace (> 1.6 w/s) is no Athan. The operator always wins (override()).
import type { Config } from "../config.js";
import type { PrayerEvent, SessionMode } from "../shared/protocol.js";
import {
  analyzeFormulas,
  countTasleem,
  type FormulaAnalysis,
  fatihaVerses,
  formulaWords,
  isFormulaOnly,
  markerSequence,
  markers,
} from "./markers.js";
import type { DetectorAction, DetectorSegment, EventDetectorApi, MarkerId } from "./types.js";

export type EventsConfig = Pick<
  Config["events"],
  "enabled" | "silenceBeforeSec" | "holdMaxSec" | "endSilenceSec" | "salahMode" | "salahMaxMin"
>;

export interface EventDetectorOptions {
  /** Clock for a segment without a finite `at` (defaults to Date.now). */
  now?: () => number;
}

/** On confirmation, formula-only blocks emitted in the last 60 s are hidden. */
export const HIDE_FORMULA_WINDOW_MS = 60_000;
/** Clear speech this soon after a provisional card retracts it. */
export const RETRACT_WINDOW_MS = 10_000;
/** After a retract, the weak Athan rules (takbir alone / takbir + shahada) rest this long. */
export const RETRACT_COOLDOWN_MS = 60_000;
/** Sung delivery: at most this many words per second of speech, over at least SLOW_MIN_SPEECH_MS. */
export const SLOW_MAX_WPS = 1.6;
const SLOW_MIN_SPEECH_MS = 4_000;
/** Iqama delivery: more than this many words per second (over at least FAST_MIN_SPEECH_MS). */
export const FAST_MIN_WPS = 2.2;
const FAST_MIN_SPEECH_MS = 1_500;
/** Speech duration estimated from `at` deltas (no startMs/endMs) is trusted within these bounds. */
const MIN_ESTIMATED_MS = 200;
const MAX_ESTIMATED_MS = 30_000;
/** During a call, a non-formula segment this short is a stray fragment, not the khatib. */
const STRAY_FRAGMENT_WORDS = 2;
/** During a call, a segment at least this formula-heavy still belongs to it. */
const CALL_FORMULA_SHARE = 0.5;
/** Segments of a formula run analyzed together (phrases cut across segments). */
const RUN_MAX_SEGMENTS = 40;
/** Salah formula segments analyzed together for the tasleem ("السلام عليكم" | "ورحمة الله"). */
const RECENT_MAX_SEGMENTS = 30;
/** After the final tasleem, Salah formula fragments are still suppressed ("…" | "ورحمة الله"). */
const SALAH_TAIL_MS = 8_000;
/** Distinct Al-Fatiha verses (2–7) that confirm the prayer has started. */
const FATIHA_CONFIRM_VERSES = 2;
/** Clear non-Fatiha sentences before any Fatiha that withdraw a provisional Salah. */
const SALAH_RETRACT_SENTENCES = 3;

interface FormulaRun {
  /** Texts of the run's formula-only segments (last RUN_MAX_SEGMENTS). */
  texts: string[];
  segs: number;
  firstAt: number;
  lastAt: number;
  startedAfterSilence: boolean;
  /** Marker phrases of the joined run text, in spoken order. */
  seq: MarkerId[];
  /** Speech time and words of the segments with a known duration (delivery rate). */
  speechMs: number;
  timedWords: number;
  /** Formula words of the latest segment (a trailing "حي" = HAYYA under way). */
  tail: string[];
}

interface ActiveEvent {
  type: PrayerEvent;
  startedAt: number;
  /** Last formula segment of an Athan / Iqama (it ends endSilenceSec later). */
  lastFormulaAt: number;
  manual: boolean;
  /** Athan / Iqama: retractable until startedAt + RETRACT_WINDOW_MS. Salah: until Al-Fatiha. */
  provisional: boolean;
  /**
   * While provisional, in order: an Athan / Iqama's discarded or suppressed segments; a Salah's
   * held segments.
   */
  consumed: DetectorSegment[];
  /** Athan / Iqama: the formula run, continued (QAD_QAMAT or a fast HAYYA turns Athan → Iqama). */
  run: FormulaRun | null;
  /** Salah: the current run of formula-only segments (tasleems cut across segments). */
  recent: string[];
  /** Salah: tasleems in earlier formula runs. */
  tasleemsBefore: number;
  /** Provisional Salah: Al-Fatiha verses heard, clear non-Fatiha sentences heard. */
  fatiha: Set<string>;
  nonFatiha: number;
}

interface Decision {
  event: PrayerEvent;
  provisional: boolean;
}

function count(seq: readonly MarkerId[], id: MarkerId): number {
  let n = 0;
  for (const m of seq) if (m === id) n++;
  return n;
}

function hasHayya(seq: readonly MarkerId[]): boolean {
  return seq.includes("HAYYA_SALAH") || seq.includes("HAYYA_FALAH");
}

function hasShahada(seq: readonly MarkerId[]): boolean {
  return seq.includes("SHAHADA1") || seq.includes("SHAHADA2");
}

/** The Athan / Iqama opening: takbir first, then both shahadas. */
function athanOpening(seq: readonly MarkerId[]): boolean {
  return (
    seq[0] === "TAKBIR" &&
    seq.includes("SHAHADA2") &&
    (seq.includes("SHAHADA1") || seq.includes("TAHLIL"))
  );
}

/** Words per second of speech, or null when too little was timed. */
function rate(run: FormulaRun, minSpeechMs: number): number | null {
  return run.speechMs >= minSpeechMs ? run.timedWords / (run.speechMs / 1000) : null;
}

function isSlow(run: FormulaRun): boolean {
  const r = rate(run, SLOW_MIN_SPEECH_MS);
  return r !== null && r <= SLOW_MAX_WPS;
}

function isFast(run: FormulaRun): boolean {
  const r = rate(run, FAST_MIN_SPEECH_MS);
  return r !== null && r > FAST_MIN_WPS;
}

/** Not spoken at speech pace: sung (≤ SLOW_MAX_WPS), or not timed at all. */
function notSpokenPace(run: FormulaRun): boolean {
  const r = rate(run, FAST_MIN_SPEECH_MS);
  return r === null || r <= SLOW_MAX_WPS;
}

/** HAYYA, or its first words at the end of the run ("… حي." | "على الصلاة"). */
function hayyaUnderWay(run: FormulaRun): boolean {
  if (hasHayya(run.seq)) return true;
  const n = run.tail.length;
  const last = run.tail[n - 1];
  const prev = run.tail[n - 2];
  return last === "حي" || (prev === "حي" && (last === "علي" || last === "علا" || last === "عل"));
}

function qualifiesAsAthan(run: FormulaRun): boolean {
  const seq = run.seq;
  return (
    hasHayya(seq) &&
    (athanOpening(seq) || seq.length >= 4 || (run.startedAfterSilence && seq.length >= 2))
  );
}

function confirmsIqama(run: FormulaRun): boolean {
  const qad = count(run.seq, "QAD_QAMAT");
  return qad > 0 && (qad >= 2 || run.startedAfterSilence || run.seq.length - qad >= 2);
}

/** Iqama at speech pace: takbir + shahada + HAYYA, or the whole opening (takbir ×2, both shahadas). */
function isFastIqama(run: FormulaRun): boolean {
  const seq = run.seq;
  if (!isFast(run) || !seq.includes("TAKBIR") || !hasShahada(seq)) return false;
  return hayyaUnderWay(run) || (athanOpening(seq) && count(seq, "TAKBIR") >= 2);
}

function isCall(event: PrayerEvent): boolean {
  return event === "athan" || event === "iqama";
}

function pushCapped(list: string[], text: string, max: number): void {
  list.push(text);
  if (list.length > max) list.shift();
}

export class EventDetector implements EventDetectorApi {
  private readonly cfg: EventsConfig;
  private readonly clock: () => number;
  private run: FormulaRun | null = null;
  private held: DetectorSegment[] = [];
  private lastHeldAt = 0;
  private active: ActiveEvent | null = null;
  /** After an operator "none": formula segments pass untouched until speech resumes. */
  private vetoed = false;
  private lastSegmentAt: number | null = null;
  /** Until then, Salah formula fragments are suppressed (the tail of the final tasleem). */
  private salahTailUntil = Number.NEGATIVE_INFINITY;
  /** Until then, the weak Athan rules are off (a provisional card was just retracted). */
  private cooldownUntil = Number.NEGATIVE_INFINITY;

  constructor(cfg: EventsConfig, opts: EventDetectorOptions = {}) {
    this.cfg = cfg;
    this.clock = opts.now ?? Date.now;
  }

  get mode(): SessionMode {
    if (this.active !== null) return this.active.type;
    return this.held.length > 0 ? "held" : "speech";
  }

  get salah(): boolean {
    return this.active?.type === "salah";
  }

  isFormulaOnly(text: string): boolean {
    return isFormulaOnly(text);
  }

  markers(text: string): MarkerId[] {
    return markers(text);
  }

  onSegment(seg: DetectorSegment): DetectorAction[] {
    const t = Number.isFinite(seg.at) ? seg.at : this.clock();
    const before = this.mode;
    const out = this.expire(t);
    const disposition = this.route(seg, t, out);
    this.lastSegmentAt = t;
    return this.finish(before, out, disposition);
  }

  tick(now: number): DetectorAction[] {
    const before = this.mode;
    return this.finish(before, this.expire(now), null);
  }

  override(event: PrayerEvent | "none", now: number): DetectorAction[] {
    const before = this.mode;
    const out = this.expire(now);
    const active = this.active;
    if (event === "none") {
      if (active !== null) {
        // A provisional Athan / Iqama is withdrawn with what it consumed; a definitive one just
        // ends; a Salah ends and what it held is never shown (prayer content never leaks).
        if (active.provisional && active.type !== "salah") {
          out.push({ type: "event-retract", event: active.type, released: active.consumed });
        } else {
          if (active.type === "salah") this.confirmSalah(active, out);
          out.push({ type: "event-end", event: active.type });
        }
      }
      this.active = null;
      if (this.held.length > 0) out.push({ type: "release", segments: this.held });
      this.held = [];
      this.run = null;
      this.vetoed = true;
      const actions = this.finish(before, out, null);
      if (!actions.some((a) => a.type === "mode")) actions.push({ type: "mode", mode: "speech" });
      return actions;
    }
    this.vetoed = false;
    if (active !== null && (active.type === event || (isCall(active.type) && isCall(event)))) {
      // Already showing (or Athan ↔ Iqama): the operator makes it definitive; same card.
      if (active.type !== event) {
        out.push({ type: "event-change", from: active.type, to: event });
        active.type = event;
      }
      if (active.type === "salah") this.confirmSalah(active, out);
      active.manual = true;
      active.provisional = false;
      active.consumed = [];
      active.lastFormulaAt = now;
      if (event === "salah") {
        active.startedAt = now;
        active.recent = [];
        active.tasleemsBefore = 0;
      }
      return this.finish(before, out, null);
    }
    if (active !== null) {
      if (active.type === "salah") this.confirmSalah(active, out);
      out.push({ type: "event-end", event: active.type });
    }
    this.active = null;
    this.startEvent(event, now, this.held, out, {
      manual: true,
      run: this.run,
      lastFormulaAt: now,
    });
    return this.finish(before, out, null);
  }

  // --- segment routing ---------------------------------------------------------------------------

  private route(seg: DetectorSegment, t: number, out: DetectorAction[]): DetectorAction | null {
    const call = this.active;
    if (call !== null && call.type !== "salah") {
      const r = this.duringCall(call, seg, t, out);
      if (r !== "ended") return r;
      // The call ended (or was retracted) on this segment: it continues in the new mode.
    }
    const now = this.active;
    if (now !== null && now.type === "salah") return this.duringSalah(now, seg, t, out);
    if (t <= this.salahTailUntil && analyzeFormulas(seg.text, "salah").formulaOnly) {
      return { type: "suppress", segment: seg };
    }
    if (!this.cfg.enabled) return { type: "pass", segment: seg };
    return this.duringSpeech(seg, t, out);
  }

  /** Mode speech / held. */
  private duringSpeech(
    seg: DetectorSegment,
    t: number,
    out: DetectorAction[],
  ): DetectorAction | null {
    const a = analyzeFormulas(seg.text, "athan");
    const holdMaxMs = this.cfg.holdMaxSec * 1000;
    if (this.lastSegmentAt !== null && t - this.lastSegmentAt > holdMaxMs) this.vetoed = false;
    // A formula run never outlives its held segments (expire(), speechSegment() and startEvent()
    // drop both together), so a stale run cannot reach this point.
    if (!a.formulaOnly) return this.speechSegment(seg, a, t, out);
    if (this.vetoed) return { type: "pass", segment: seg };

    const run: FormulaRun = this.run ?? {
      texts: [],
      segs: 0,
      firstAt: t,
      lastAt: t,
      startedAfterSilence: seg.silenceBeforeMs >= this.cfg.silenceBeforeSec * 1000,
      seq: [],
      speechMs: 0,
      timedWords: 0,
      tail: [],
    };
    this.run = run;
    this.addToRun(run, seg, a, t);
    const decision = this.decide(run, t);
    if (decision !== null) {
      this.startEvent(decision.event, t, [...this.held, seg], out, {
        run,
        provisional: decision.provisional,
      });
      return null;
    }
    this.held.push(seg);
    this.lastHeldAt = t;
    return { type: "hold", segment: seg };
  }

  private decide(run: FormulaRun, t: number): Decision | null {
    if (confirmsIqama(run)) return { event: "iqama", provisional: false };
    if (isFastIqama(run)) return { event: "iqama", provisional: true };
    const seq = run.seq;
    const takbir = seq.includes("TAKBIR");
    if (t >= this.cooldownUntil && takbir) {
      if (run.segs >= 2 && isSlow(run)) return { event: "athan", provisional: true };
      if (hasShahada(seq) && notSpokenPace(run)) return { event: "athan", provisional: true };
    }
    if (qualifiesAsAthan(run)) return { event: "athan", provisional: true };
    return null;
  }

  /** A non-formula segment in mode speech / held: it ends the formula run and any hold. */
  private speechSegment(
    seg: DetectorSegment,
    a: FormulaAnalysis,
    t: number,
    out: DetectorAction[],
  ): DetectorAction | null {
    const run = this.run;
    const wasVetoed = this.vetoed;
    this.vetoed = false;
    if (this.held.length > 0 && run !== null && !wasVetoed) {
      const callLike = (run.seq.includes("TAKBIR") && hasShahada(run.seq)) || hasHayya(run.seq);
      if (callLike) {
        // The Iqama with speech mixed in or cut across segments ("قد قامت" | "الصلاة، استووا").
        const joined = markerSequence(analyzeFormulas([...run.texts, seg.text].join(" "), "athan"));
        if (count(joined, "QAD_QAMAT") > count(run.seq, "QAD_QAMAT")) {
          this.startEvent("iqama", t, [...this.held, seg], out, { run });
          return null;
        }
        if (a.words.length <= STRAY_FRAGMENT_WORDS) {
          // A call under way (not yet confirmed): a stray fragment stays held with it.
          this.held.push(seg);
          this.lastHeldAt = t;
          return { type: "hold", segment: seg };
        }
      }
    }
    this.run = null;
    if (this.held.length > 0) out.push({ type: "release", segments: this.held });
    this.held = [];
    return { type: "pass", segment: seg };
  }

  /** Mode athan / iqama. Returns "ended" when the segment ended or retracted the call. */
  private duringCall(
    call: ActiveEvent,
    seg: DetectorSegment,
    t: number,
    out: DetectorAction[],
  ): DetectorAction | null | "ended" {
    const a = analyzeFormulas(seg.text, "athan");
    const formulaLike = a.formulaOnly || a.share >= CALL_FORMULA_SHARE;
    if (formulaLike) {
      call.lastFormulaAt = t;
      const run = call.run;
      if (run !== null) this.addToRun(run, seg, a, t);
      if (!call.manual && run !== null) {
        if (run.seq.includes("QAD_QAMAT")) {
          // The Iqama (it repeats the Athan's opening): same card, now definitive.
          if (call.type === "athan") out.push({ type: "event-change", from: "athan", to: "iqama" });
          call.type = "iqama";
          call.provisional = false;
          call.consumed = [];
        } else if (call.type === "athan" && isFastIqama(run)) {
          out.push({ type: "event-change", from: "athan", to: "iqama" });
          call.type = "iqama";
        }
      }
    } else if (a.words.length > STRAY_FRAGMENT_WORDS) {
      // Clear speech: a provisional card was a false alarm; a definitive call is over.
      if (call.provisional) {
        out.push({ type: "event-retract", event: call.type, released: call.consumed });
        this.active = null;
        this.run = null;
        this.cooldownUntil = t + RETRACT_COOLDOWN_MS;
      } else {
        this.endEvent(call, t, out);
      }
      return "ended";
    }
    if (call.provisional) call.consumed.push(seg);
    return { type: "suppress", segment: seg };
  }

  /** Mode salah: silence. Every segment is suppressed; the tasleem said twice ends it. */
  private duringSalah(
    call: ActiveEvent,
    seg: DetectorSegment,
    t: number,
    out: DetectorAction[],
  ): DetectorAction | null {
    const a = analyzeFormulas(seg.text, "salah");
    if (a.formulaOnly) {
      pushCapped(call.recent, seg.text, RECENT_MAX_SEGMENTS);
      const inRun = countTasleem(analyzeFormulas(call.recent.join(" "), "salah"));
      if (call.tasleemsBefore + inRun >= 2) {
        this.endEvent(call, t, out);
        this.salahTailUntil = t + SALAH_TAIL_MS;
        return { type: "suppress", segment: seg };
      }
    } else if (call.recent.length > 0) {
      call.tasleemsBefore += countTasleem(analyzeFormulas(call.recent.join(" "), "salah"));
      call.recent = [];
    }
    if (!call.provisional) return { type: "suppress", segment: seg };
    // Not confirmed yet: a prayer's first recitation is Al-Fatiha.
    if (!a.formulaOnly) {
      const verses = fatihaVerses(seg.text);
      for (const v of verses) call.fatiha.add(v);
      if (call.fatiha.size >= FATIHA_CONFIRM_VERSES) {
        this.confirmSalah(call, out);
        return { type: "suppress", segment: seg };
      }
      if (verses.length === 0 && a.words.length > STRAY_FRAGMENT_WORDS) call.nonFatiha += 1;
      if (call.nonFatiha >= SALAH_RETRACT_SENTENCES) {
        // Speech, not a prayer: withdraw the card and show what it held (this segment last).
        out.push({ type: "event-retract", event: "salah", released: [...call.consumed, seg] });
        this.active = null;
        return null;
      }
    }
    call.consumed.push(seg);
    return { type: "hold", segment: seg };
  }

  /** A provisional Salah is a prayer after all: its held segments are never shown. */
  private confirmSalah(call: ActiveEvent, out: DetectorAction[]): void {
    for (const held of call.consumed) out.push({ type: "suppress", segment: held });
    call.consumed = [];
    call.provisional = false;
  }

  private addToRun(run: FormulaRun, seg: DetectorSegment, a: FormulaAnalysis, t: number): void {
    pushCapped(run.texts, seg.text, RUN_MAX_SEGMENTS);
    run.segs += 1;
    run.lastAt = t;
    run.seq = markerSequence(analyzeFormulas(run.texts.join(" "), "athan"));
    const ms = this.speechMsOf(seg, t);
    if (ms !== null) {
      run.speechMs += ms;
      run.timedWords += a.words.length;
    }
    run.tail = formulaWords(seg.text);
  }

  /** Speech duration of a segment: endMs − startMs, else estimated from the time since the last one. */
  private speechMsOf(seg: DetectorSegment, t: number): number | null {
    const { startMs, endMs } = seg;
    if (typeof startMs === "number" && typeof endMs === "number" && endMs > startMs) {
      return endMs - startMs;
    }
    if (this.lastSegmentAt === null) return null;
    const ms = t - this.lastSegmentAt - Math.max(0, seg.silenceBeforeMs);
    return ms >= MIN_ESTIMATED_MS && ms <= MAX_ESTIMATED_MS ? ms : null;
  }

  // --- timers & events ---------------------------------------------------------------------------

  /** Timeouts due at `t`: provisional window, hold, end of call, Salah. */
  private expire(t: number): DetectorAction[] {
    const out: DetectorAction[] = [];
    const call = this.active;
    if (
      call?.provisional === true &&
      call.type !== "salah" &&
      t - call.startedAt >= RETRACT_WINDOW_MS
    ) {
      // Not retracted in time: the card is definitive (no action).
      call.provisional = false;
      call.consumed = [];
    }
    if (this.held.length > 0 && t - this.lastHeldAt >= this.cfg.holdMaxSec * 1000) {
      out.push({ type: "release", segments: this.held });
      this.held = [];
      this.run = null;
    }
    if (call !== null) {
      if (call.type === "salah") {
        if (t - call.startedAt >= this.cfg.salahMaxMin * 60_000) this.endEvent(call, t, out);
      } else if (t - call.lastFormulaAt >= this.cfg.endSilenceSec * 1000) {
        this.endEvent(call, t, out);
      }
    }
    return out;
  }

  private startEvent(
    type: PrayerEvent,
    t: number,
    discarded: readonly DetectorSegment[],
    out: DetectorAction[],
    opts: {
      manual?: boolean;
      run?: FormulaRun | null;
      lastFormulaAt?: number;
      provisional?: boolean;
    },
  ): void {
    const run = opts.run ?? null;
    const provisional = opts.provisional === true;
    const hideSince = Math.min(
      t - HIDE_FORMULA_WINDOW_MS,
      run?.firstAt ?? Number.POSITIVE_INFINITY,
    );
    out.push({
      type: "event-start",
      event: type,
      discarded: [...discarded],
      hideFormulaBlocksSinceMs: hideSince,
      ...(provisional ? { provisional: true } : {}),
    });
    this.held = [];
    this.run = null;
    this.active = {
      type,
      startedAt: t,
      lastFormulaAt: opts.lastFormulaAt ?? run?.lastAt ?? t,
      manual: opts.manual ?? false,
      provisional,
      consumed: provisional ? [...discarded] : [],
      run: type === "salah" ? null : run,
      recent: [],
      tasleemsBefore: 0,
      fatiha: new Set(),
      nonFatiha: 0,
    };
  }

  /**
   * Ends the active event (`call` is `this.active`); an Iqama is followed by Salah (salahMode),
   * provisional until Al-Fatiha.
   */
  private endEvent(call: ActiveEvent, t: number, out: DetectorAction[]): void {
    if (call.type === "salah") this.confirmSalah(call, out);
    out.push({ type: "event-end", event: call.type });
    this.active = null;
    if (call.type === "iqama" && this.cfg.salahMode) {
      this.startEvent("salah", t, [], out, { manual: call.manual, provisional: true });
    }
  }

  private finish(
    before: SessionMode,
    out: DetectorAction[],
    disposition: DetectorAction | null,
  ): DetectorAction[] {
    const after = this.mode;
    if (after !== before) out.push({ type: "mode", mode: after });
    if (disposition !== null) out.push(disposition);
    return out;
  }
}
