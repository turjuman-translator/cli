// The Quran follower: it follows the khatib word by word.
//
// Every final Arabic source word gets an index in a session-wide stream, counted exactly like
// `arabicWords(text)` (the pipeline's chunk watermarks use the same count). Per word the follower
// decides: plain (show its live translation) or Quran (inside a reported verse range). Until then
// a word is undecided and the caller holds its translation. A word is held only while it may
// belong to a quote:
//   * a Quran alignment (≥ 3 matching words, found through the 3-gram index) reaches the newest
//     words (a quote may be starting);
//   * a verse-intro cue was just said (قال الله تعالى, أعوذ بالله من الشيطان الرجيم, …);
//   * look-ahead: the last 2 words begin a Quran 3-gram (released when the speaker pauses: no
//     new words for `idleMs`, or the text ended with punctuation);
//   * a verified ayah is still being recited and not yet 80 % complete (a bounded wait, so a
//     whole ayah is shown once with its approved translation instead of live chunks), unless
//     the approved translation of the recited part is known (whole waqf segments, see
//     spans.ts): then the ayah is reported at once and its later words extend the report.
// Unverified holds are bounded: ≤ maxHoldWords later words while he speaks, or maxHoldMs without
// any new word (a pause); then the words are plain. Verification uses the matcher's rules on the
// recent words (precision first: an ambiguous or stoplisted quote never becomes a verse). Decisions are final: a word decided plain
// never turns into Quran later, so a verse range may start after words that were already shown.
import type { FollowerResult, FollowerVerse, QuranFollowerApi } from "../compose/types.js";
import { arabicWords } from "../text/arabic.js";
import { corpusWords, keyForm } from "./corpus.js";
import type { QuranMatcher, WindowAnalysis } from "./matcher.js";
import type { AyahSpan } from "./spans.js";

export interface FollowerOptions {
  /** Language of the approved translations (default "nl"). */
  targetLang?: string;
  /** An unverified possible quote is held at most this many later words … (default 8) */
  maxHoldWords?: number;
  /** … or until no new word arrived for this long (default 2000 ms). Measured from the last
   *  word rather than the held one, because Soniox finalizes words in batches. */
  maxHoldMs?: number;
  /** After a verse-intro cue the words wait this long without a new word (default 4500 ms): the
   *  khatib often pauses between "قال تعالى" and the recitation. */
  cueHoldMs?: number;
  /** A generic Quranic phrase (it aligns with ≥ 3 ayat, e.g. خلق السماوات والأرض) without a cue
   *  waits only this long without a new word (default 700 ms) and ≤ 4 later words: it is
   *  mostly the khatib's own wording. */
  genericHoldMs?: number;
  /**
   * A verified ayah that is not yet 80 % recited waits (undecided) for completion at most this
   * many more words (default 10; 0 = report partial verses at once) …
   */
  completeWaitWords?: number;
  /** … or this long after verification (default 6000 ms) … */
  completeWaitMs?: number;
  /** … or until no new words arrived for this long (default 2500 ms). */
  pauseReportMs?: number;
  /** An ayah reported within this window is not new again (default 120 000 ms). */
  recentMs?: number;
  /** Words of context the matcher sees (default 64). */
  windowWords?: number;
  /** No new words for this long = a pause: the look-ahead is released (default 600 ms; at once
   *  when the text ended with punctuation). */
  idleMs?: number;
  /** Salah: the stoplist does not apply (default false). */
  ignoreStoplist?: boolean;
  /** Verse-intro cues (default DEFAULT_CUES). */
  cues?: readonly string[];
}

/** Phrases a khatib uses to introduce a verse (normalized when compared; و/ف prefixes ignored). */
export const DEFAULT_CUES: readonly string[] = [
  "قال الله تعالى",
  "قال الله",
  "قال تعالى",
  "يقول الله تعالى",
  "يقول الله",
  "يقول تعالى",
  "قال سبحانه",
  "قال سبحانه وتعالى",
  "يقول سبحانه",
  "يقول سبحانه وتعالى",
  "قال الله عز وجل",
  "يقول الله عز وجل",
  "قال عز وجل",
  "يقول عز وجل",
  "قال جل وعلا",
  "يقول جل وعلا",
  "كما قال الله",
  "كما قال تعالى",
  "قوله تعالى",
  "قوله سبحانه",
  "قوله سبحانه وتعالى",
  "قوله عز وجل",
  "قول الله",
  "قول الله تعالى",
  "قول الله سبحانه وتعالى",
  "كما بين",
  "كما بين سبحانه",
  "كما بين سبحانه وتعالى",
  "كما بين الله",
  "بين الله",
  "قال عز من قائل",
  "قال المولى",
  "يقول المولى",
  "في كتابه",
  "في محكم التنزيل",
  "قال ربنا",
  "يقول ربنا",
  "يقول الحق",
  "أعوذ بالله من الشيطان الرجيم",
];

const UNDECIDED = 0;
const PLAIN = 1;
const VERSE = 2;
/** Coverage of an ayah from which its approved translation may be shown. */
const COMPLETE = 0.8;
/** An unverified alignment is alive while its last matching word is this close to the newest. */
const ALIVE_GAP = 1;
/** … a verse being followed tolerates one more unmatched word (recognizer errors). */
const ALIVE_GAP_VERSE = 2;
/** Words of an alignment that is still growing may wait this many words longer (a long ayah
 *  needs 8 matching words, more when a near-duplicate ayah competes, e.g. 5:8 / 4:135). */
const GROW_EXTRA_WORDS = 4;
/** A cue without any Quran alignment after this many words is released early. */
const CUE_EARLY_RELEASE = 4;
/** A word this close after a reported verse may be its tail (one of the ayah's next words). */
const TAIL_GAP = 3;
const TAIL_REACH = 6;
/** An unverified alignment found at this many ayat is a generic phrase (short hold, no cue). */
const GENERIC_AYAT = 3;
const GENERIC_HOLD_WORDS = 4;
const PUNCT_END = /[.!?؟،,;:؛…»"”)\]]\s*$/;

interface VerseState {
  ayah: number;
  ref: string;
  /** Stream indices of the words assigned to this ayah (undecided or Quran). */
  words: Set<number>;
  /** … of which matched the ayah text (similarity ≥ threshold). */
  ok: Set<number>;
  from: number;
  to: number;
  reported: boolean;
  /** Changed since the last report. */
  dirty: boolean;
  verifiedAt: number;
  verifiedN: number;
  lastIdx: number;
  /** First and last matched word position in the ayah (simple-clean words), or -1. */
  posMin: number;
  posMax: number;
}

/** Counts words and decides everything at once (no Quran data). */
function passThrough(): QuranFollowerApi {
  let count = 0;
  return {
    ready: false,
    push(text: string) {
      const added = arabicWords(text).length;
      count += added;
      return { added, decidedTo: count, verses: [] };
    },
    flush() {
      return { decidedTo: count, verses: [] };
    },
    reset() {
      count = 0;
    },
  };
}

class QuranFollower implements QuranFollowerApi {
  readonly ready = true;
  private readonly matcher: QuranMatcher;
  private readonly targetLang: string;
  private readonly maxHoldWords: number;
  private readonly maxHoldMs: number;
  private readonly cueHoldMs: number;
  private readonly genericHoldMs: number;
  private readonly completeWaitWords: number;
  private readonly completeWaitMs: number;
  private readonly pauseReportMs: number;
  private readonly recentMs: number;
  private readonly windowWords: number;
  private readonly idleMs: number;
  private readonly ignoreStoplist: boolean;
  private readonly cues: string[][];

  private forms: string[] = [];
  private keys: string[] = [];
  private arrived: number[] = [];
  private disp: number[] = [];
  private owner: (VerseState | null)[] = [];
  private decided = 0;
  private lastPushAt = Number.NEGATIVE_INFINITY;
  private lastPunct = false;
  /** First word after the latest verse-intro cue. */
  private cue: { from: number } | null = null;
  private states: VerseState[] = [];
  private readonly shownAt = new Map<string, number>();
  private cacheN = -1;
  private cacheWs = 0;
  private cache: WindowAnalysis = { matches: [], live: [] };

  constructor(matcher: QuranMatcher, opts: FollowerOptions) {
    this.matcher = matcher;
    this.targetLang = opts.targetLang ?? "nl";
    this.maxHoldWords = opts.maxHoldWords ?? 8;
    this.maxHoldMs = opts.maxHoldMs ?? 2000;
    this.cueHoldMs = opts.cueHoldMs ?? 4500;
    this.genericHoldMs = opts.genericHoldMs ?? 700;
    this.completeWaitWords = opts.completeWaitWords ?? 10;
    this.completeWaitMs = opts.completeWaitMs ?? 6000;
    this.pauseReportMs = opts.pauseReportMs ?? 2500;
    this.recentMs = opts.recentMs ?? 120_000;
    this.windowWords = Math.max(16, opts.windowWords ?? 64);
    this.idleMs = opts.idleMs ?? 600;
    this.ignoreStoplist = opts.ignoreStoplist ?? false;
    this.cues = (opts.cues ?? DEFAULT_CUES)
      .map((c) => corpusWords(c).map(keyForm))
      .filter((c) => c.length > 0);
  }

  push(text: string, at: number): FollowerResult & { added: number } {
    const forms = corpusWords(text);
    for (const f of forms) {
      this.forms.push(f);
      this.keys.push(keyForm(f));
      this.arrived.push(at);
      this.disp.push(UNDECIDED);
      this.owner.push(null);
      this.checkCue();
    }
    if (forms.length > 0) {
      this.lastPushAt = at;
      this.lastPunct = PUNCT_END.test(text);
    }
    return { ...this.step(at, false), added: forms.length };
  }

  flush(at: number): FollowerResult {
    return this.step(at, true);
  }

  reset(): void {
    this.forms = [];
    this.keys = [];
    this.arrived = [];
    this.disp = [];
    this.owner = [];
    this.decided = 0;
    this.lastPushAt = Number.NEGATIVE_INFINITY;
    this.lastPunct = false;
    this.cue = null;
    this.states = [];
    this.shownAt.clear();
    this.cacheN = -1;
    this.cache = { matches: [], live: [] };
  }

  // --- internals --------------------------------------------------------------------------------

  /** A cue phrase ending at the newest word: hold the words after it. */
  private checkCue(): void {
    const n = this.keys.length;
    for (const cue of this.cues) {
      if (cue.length > n) continue;
      if (cue.every((k, i) => this.keys[n - cue.length + i] === k)) {
        this.cue = { from: n };
        return;
      }
    }
  }

  private analysis(): { ws: number; a: WindowAnalysis } {
    const n = this.forms.length;
    if (this.cacheN !== n) {
      const ws = Math.max(0, n - this.windowWords);
      this.cache = this.matcher.analyzeWords(this.forms.slice(ws), {
        ignoreStoplist: this.ignoreStoplist,
      });
      this.cacheWs = ws;
      this.cacheN = n;
    }
    return { ws: this.cacheWs, a: this.cache };
  }

  /** Word j may continue verse state s: it arrived within recentMs of the state's last word
   *  (later, the same ayah is a new quote, as isNew says). */
  private continues(s: VerseState, j: number): boolean {
    return (this.arrived[j] as number) - (this.arrived[s.lastIdx] as number) < this.recentMs;
  }

  private stateFor(ayah: number, j: number, at: number, n: number): VerseState | null {
    for (let k = this.states.length - 1; k >= 0; k--) {
      const s = this.states[k];
      if (
        s !== undefined &&
        s.ayah === ayah &&
        j >= s.from - 3 &&
        j <= s.to + 3 &&
        this.continues(s, j)
      ) {
        return s;
      }
    }
    const ref = this.matcher.ayahRef(ayah);
    if (ref === null) return null;
    const s: VerseState = {
      ayah,
      ref,
      words: new Set(),
      ok: new Set(),
      from: j,
      to: j + 1,
      reported: false,
      dirty: true,
      verifiedAt: at,
      verifiedN: n,
      lastIdx: j,
      posMin: -1,
      posMax: -1,
    };
    this.states.push(s);
    return s;
  }

  /** Approved translation + Uthmani text of the recited part of a verse state (or null). */
  private span(s: VerseState): AyahSpan | null {
    if (s.posMin < 0) return null;
    return this.matcher.ayahSpan(s.ayah, s.posMin, s.posMax, this.targetLang);
  }

  private step(at: number, flushing: boolean): FollowerResult {
    const n = this.forms.length;
    const verses: FollowerVerse[] = [];
    if (this.decided >= n && this.states.every((s) => s.reported && !s.dirty)) {
      return { decidedTo: n, verses };
    }
    const { ws, a } = this.analysis();

    // 1. Verified quotes: assign their undecided words to per-ayah states.
    for (const m of a.matches) {
      const byW = new Map<number, { ayah: number; pos: number; ok: boolean }>();
      for (const p of m.pairs) byW.set(p.w, p);
      let ayah = -1;
      for (let w = m.wStart; w < m.wEnd; w++) {
        const p = byW.get(w);
        if (p !== undefined) ayah = p.ayah;
        if (ayah < 0) continue;
        const j = ws + w;
        if (this.disp[j] !== UNDECIDED || this.owner[j] !== null) continue;
        const s = this.stateFor(ayah, j, at, n);
        if (s === null) continue;
        s.words.add(j);
        if (p?.ok === true) {
          // p.ayah === s.ayah here: `ayah` was just set from p, and stateFor() keeps the ayah.
          s.ok.add(j);
          s.posMin = s.posMin < 0 ? p.pos : Math.min(s.posMin, p.pos);
          s.posMax = Math.max(s.posMax, p.pos);
        }
        s.from = Math.min(s.from, j);
        s.to = Math.max(s.to, j + 1);
        s.lastIdx = Math.max(s.lastIdx, j);
        s.dirty = true;
        this.owner[j] = s;
      }
    }

    // 1b. The tail of a verse the alignment could not bridge (the recognizer dropped words in
    //     between: "… الكتاب وال | بالقسط"): a word right after a reported verse that is exactly
    //     one of the ayah's next words joins it, with the words in between, but only while those
    //     are all undecided (a word decided plain was shown; the verse never covers it again).
    for (const s of this.states) {
      if (!s.reported || s.posMax < 0) continue;
      for (let j = s.lastIdx + 1; j < n && j <= s.lastIdx + TAIL_GAP; j++) {
        if (this.disp[j] !== UNDECIDED || this.owner[j] !== null || !this.continues(s, j)) break;
        const form = this.forms[j] as string; // j < n
        const pos = this.matcher.ayahNextPos(s.ayah, form, s.posMax + 1, TAIL_REACH);
        if (pos < 0) continue;
        for (let k = s.lastIdx + 1; k <= j; k++) {
          s.words.add(k);
          this.owner[k] = s;
        }
        s.ok.add(j);
        s.posMax = pos;
        s.lastIdx = j;
        s.to = Math.max(s.to, j + 1);
        s.dirty = true;
      }
    }

    // 2. Report verified ayat: at once when complete, else once the recitation moves on, stops,
    //    or the wait budget is spent; extensions of reported ayat right away.
    const ordered = [...this.states].sort((x, y) => x.from - y.from);
    for (const s of ordered) {
      if (!s.dirty) continue;
      const len = Math.max(1, this.matcher.ayahWordCount(s.ayah));
      const complete = s.ok.size / len >= COMPLETE;
      if (!s.reported) {
        const needed = Math.ceil(COMPLETE * len) - s.ok.size;
        const budget = this.completeWaitWords - (n - s.verifiedN);
        const movedOn = this.states.some(
          (t) => t !== s && t.ayah > s.ayah && t.from > s.lastIdx && t.from <= s.lastIdx + 4,
        );
        const stopped = s.lastIdx < n - 1 - ALIVE_GAP_VERSE;
        const timeUp =
          at - s.verifiedAt >= this.completeWaitMs || at - this.lastPushAt >= this.pauseReportMs;
        const spanKnown = this.span(s) !== null;
        if (!(complete || spanKnown || movedOn || stopped || timeUp || needed > budget)) continue;
      }
      for (const j of s.words) if (this.disp[j] === UNDECIDED) this.disp[j] = VERSE;
      const recent = (this.shownAt.get(s.ref) ?? Number.NEGATIVE_INFINITY) > at - this.recentMs;
      const isNew = !s.reported && !recent;
      if (isNew) {
        this.shownAt.set(s.ref, at);
        for (const [ref, t] of this.shownAt) if (t <= at - this.recentMs) this.shownAt.delete(ref);
      }
      s.reported = true;
      s.dirty = false;
      const span = this.span(s);
      verses.push({
        ref: s.ref,
        from: s.from,
        to: s.to,
        complete: complete || span?.full === true,
        approved:
          span?.text ?? (complete ? this.matcher.approvedText(s.ref, this.targetLang) : null),
        uthmani: span?.arabic ?? this.matcher.verseText(s.ref),
        partial: span !== null && !span.full,
        isNew,
      });
    }

    // 3. Holds: the undecided suffix from `holdStart` waits.
    let holdStart = n;
    for (const s of this.states) {
      if (!s.reported) holdStart = Math.min(holdStart, s.from);
    }
    let aliveSinceCue = false;
    /** Words of an alignment that is still growing (they may wait a little longer). */
    let growFrom = n;
    /** Ayat the alive unverified alignments start in (≥ GENERIC_AYAT: a generic phrase). */
    const aliveAyat = new Set<number>();
    let aliveFollowing = false;
    for (const l of a.live) {
      const start = ws + l.wStart;
      const last = ws + l.wEnd - 1;
      let following = false;
      for (let j = start; j <= last && !following; j++)
        following = (this.owner[j] ?? null) !== null;
      const gap = following ? ALIVE_GAP_VERSE : ALIVE_GAP;
      if (last < n - 1 - gap) continue;
      holdStart = Math.min(holdStart, start);
      growFrom = Math.min(growFrom, start);
      if (following) aliveFollowing = true;
      else aliveAyat.add(l.ayah);
      if (this.cue !== null && start >= this.cue.from - 1) aliveSinceCue = true;
    }
    const generic = !aliveFollowing && aliveAyat.size >= GENERIC_AYAT;
    const silentMs = at - this.lastPushAt;
    if (this.cue !== null) {
      const cue = this.cue;
      const words = n - cue.from;
      const expired =
        words >= this.maxHoldWords ||
        silentMs >= this.cueHoldMs ||
        (words >= CUE_EARLY_RELEASE && !aliveSinceCue);
      if (expired) this.cue = null;
      else if (cue.from < n) holdStart = Math.min(holdStart, cue.from);
    }
    const paused = this.lastPunct || (flushing && silentMs >= this.idleMs);
    if (!paused && n >= 2 && this.disp[n - 2] === UNDECIDED) {
      const f1 = this.forms[n - 1] as string; // n ≥ 2
      const f2 = this.forms[n - 2] as string;
      if (this.matcher.couldStartQuote([f2, f1])) holdStart = Math.min(holdStart, n - 2);
    }

    // 4. Bounds for unverified holds: a word waits ≤ maxHoldWords later words (more while its
    //    alignment keeps growing), or until maxHoldMs pass without any new word (cueHoldMs for
    //    the words after a live verse-intro cue).
    let releaseTo = 0;
    const cued = this.cue !== null;
    // A generic phrase the recognizer already closed with punctuation (an endpoint: the khatib
    // paused) is his own wording: no wait at all.
    const genericMs = this.lastPunct ? 0 : this.genericHoldMs;
    const holdMs = cued ? this.cueHoldMs : generic ? genericMs : this.maxHoldMs;
    for (let j = Math.max(this.decided, holdStart); j < n; j++) {
      if (this.disp[j] !== UNDECIDED || this.owner[j] !== null) continue;
      const words =
        generic && !cued
          ? GENERIC_HOLD_WORDS
          : j >= growFrom
            ? this.maxHoldWords + GROW_EXTRA_WORDS
            : this.maxHoldWords;
      if (n - 1 - j >= words || silentMs >= holdMs) releaseTo = j + 1;
    }

    // 5. Decide: everything before the hold (or past its bound) that is not a verified-but-
    //    unreported ayah word is plain.
    const plainTo = Math.max(holdStart, releaseTo);
    for (let j = this.decided; j < plainTo && j < n; j++) {
      if (this.disp[j] === UNDECIDED && this.owner[j] === null) this.disp[j] = PLAIN;
    }
    while (this.decided < n && this.disp[this.decided] !== UNDECIDED) this.decided++;

    // Forget reported ayat that left the matcher's window.
    if (this.states.length > 32) {
      const floor = n - this.windowWords;
      this.states = this.states.filter((s) => !s.reported || s.lastIdx >= floor);
    }
    return { decidedTo: this.decided, verses };
  }
}

/**
 * The Quran follower for a session. With no matcher, or one without data, it
 * only counts words and decides everything at once.
 */
export function createQuranFollower(
  matcher: QuranMatcher | null,
  opts: FollowerOptions = {},
): QuranFollowerApi {
  if (matcher === null || !matcher.ready) return passThrough();
  return new QuranFollower(matcher, opts);
}
