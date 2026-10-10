// Fast caption blocks from Soniox's streaming translation.
//
//   Soniox segment updates ─▶ final Arabic words ─▶ Quran follower (plain / undecided / Quran)
//                          └▶ final Dutch chunks ─▶ shown in order once every Arabic word behind
//                                                   them is decided ─▶ one growing block per sentence
//
// - Displayed text only grows (append-only): no flicker. One imam sentence = one block.
// - Quran: a recited ayah is shown once with the approved translation of what was recited
//   (whole waqf segments; the whole ayah when complete) and its Uthmani text; its
//   live chunks are dropped, so it is never translated twice. The block grows as the khatib
//   recites further segments. Without an approved translation a quote goes into a quoted Quran
//   block of live chunks with its verified reference.
// - Prayer events: formula-only speech is held until the detector decides; during the Salah
//   nothing at all is shown.
import type { Logger } from "pino";
import type { DetectorAction, DetectorSegment, EventDetectorApi } from "../events/types.js";
import type { Block, BlockKind, PrayerEvent, Segment, SessionMode } from "../shared/protocol.js";
import { arabicWords, endsMidSentence, normalizeArabic } from "../text/arabic.js";
import { normalizeIslamicTerms } from "../text/honorifics.js";
import type {
  EventLabels,
  FollowerResult,
  FollowerVerse,
  PipelineOutput,
  QuranFollowerApi,
} from "./types.js";

export interface FastBlocksOptions {
  sessionId: string;
  targetLang: string;
  follower: QuranFollowerApi;
  detector: EventDetectorApi | null;
  labels: EventLabels;
  now?: () => number;
  log: Logger;
  /** One blocks.jsonl line (a complete Block as JSON) per add/update. */
  persist?: (line: string) => void;
  emit: (out: PipelineOutput) => void;
}

const TICK_MS = 250;
const DETECTOR_TICK_MS = 500;
/**
 * A pause this long ends a block that reads as finished: a sentence end, or a clause end once the
 * block has SOFT_BLOCK_WORDS words (phrase-sized blocks: a breath mid-sentence does not split
 * it). After LONG_PAUSE_MS any block ends.
 */
const PARAGRAPH_PAUSE_MS = 1500;
const SOFT_BLOCK_WORDS = 14;
/** From this many words a block ends at its next clause or sentence mark, pause or not. */
const LONG_BLOCK_WORDS = 30;
const LONG_PAUSE_MS = 6000;
/** A new block never starts with fewer words than this: a shorter piece ("Met waarheid.",
 *  "Ook.") joins the previous block while that is the newest one and recent (TAIL_JOIN_MS). */
const MIN_NEW_BLOCK_WORDS = 4;
const TAIL_JOIN_MS = 10_000;
/** A quote intro of at most this many words ("En Hij ﷾ zei:") joins the previous block too. */
const INTRO_JOIN_WORDS = 7;
const ENDS_INTRO = /:["”’»)\]]*$/;
/** A held sentence mark is shown (and its block ends) after this long without text or speech. */
const HELD_MARK_MS = 2500;
/** The sentence mark Soniox puts on a segment it cut mid-sentence. */
const CUT_MARK = /(?<![.…])([.!?؟])(\s*)$/;
/** Dutch words that start a continuation in lower case (after Soniox's "..." the sentence goes on). */
const NL_CONTINUATION = new Set(
  (
    "als en maar of want dat die wat wie om met in op aan van voor door bij naar uit over tot " +
    "zelfs ook dan wanneer terwijl zodat opdat omdat indien hoewel tenzij totdat de het een " +
    "deze dit zij wij jullie ze we zich zo zoals niet geen nog al alle er hier daar waar hoe " +
    "toen nu sinds na tegen zonder onder boven binnen buiten moet moeten kan kunnen zal zullen " +
    "wil willen mag mogen is was waren heeft hebben had hadden wordt worden werd werden zou " +
    "zouden dient dienen hoort gaat gaan komt komen betaalt onze ons hun mijn uw jouw je jij " +
    "hij men iemand niemand elke ieder iedere veel sommige beide"
  ).split(" "),
);
/** A block never grows beyond this many words (a new block starts at the next chunk). */
const MAX_BLOCK_WORDS = 45;
/** A sentence end closes the block only once it has this many words ("Ja." joins the next). */
const MIN_BLOCK_WORDS = 6;
/** Listening dots when speech has been heard this long without new text. */
const LISTENING_AFTER_MS = 2000;
/** The same ayah is not shown twice within this window. */
const VERSE_RECENT_MS = 120_000;
/** Safety: a chunk held for a prayer call this long is dropped (never shown late). */
const MAX_HOLD_MS = 90_000;
/** Safety: words the Quran follower leaves undecided this long are shown as plain speech. */
const MAX_UNDECIDED_MS = 15_000;
/** Keep this many segments' bookkeeping (older, fully decided ones are dropped). */
const MAX_SEGMENTS = 300;
/**
 * Sentence end inside a chunk: one . ! ? ؟ (+ closing quotes) followed by whitespace. Soniox ends a
 * segment with "..." when the sentence continues, so an ellipsis is never a sentence end.
 */
const SENTENCE_BREAK = /(?<![.…])[.!?؟](?![.…])["”’»)\]]*\s+(?=\S)/g;
const ENDS_SENTENCE = /(?<![.…])[.!?؟]["”’»)\]]*$/;
const ENDS_CLAUSE = /[,;:،؛–\u2014]["”’»)\]]*$/;
/** A trailing "..." / "…" (Soniox: the sentence continues in the next segment). */
const TRAILING_ELLIPSIS = /\s*(?:\.{2,}|…)\s*$/;

type SegDisposition = "live" | "formula" | "held" | "pass" | "suppressed";

interface SegState {
  id: string;
  wordFrom: number;
  wordTo: number;
  /** Characters of the final Arabic text already given to the follower. */
  srcFed: number;
  srcText: string;
  /** Characters of the final Dutch text already queued as chunks. */
  trTaken: number;
  /** Word watermark of the last queued chunk. */
  chunkW: number;
  /** Source-text character watermark of the last queued chunk (for the block's Arabic line). */
  chunkSrc: number;
  closed: boolean;
  det: SegDisposition;
  startMs: number | null;
  endMs: number | null;
}

interface Chunk {
  segId: string;
  text: string;
  /** Arabic words behind this chunk: [wFrom, wTo). */
  wFrom: number;
  wTo: number;
  /** The Arabic behind this chunk (a slice of its segment's final source text). */
  src: string;
  at: number;
}

interface VerseInstance {
  key: string;
  ref: string;
  from: number;
  to: number;
  /** "approved": show the approved ayah once, drop its live chunks; "partial": quote the live chunks. */
  mode: "approved" | "partial";
  approved: string | null;
  uthmani: string | null;
  emitted: boolean;
  shownChunks: number;
  /** The emitted Quran block (approved mode): updated when the recited span grows. */
  block: Block | null;
}

interface OpenBlock {
  block: Block;
  raw: string;
  words: number;
  lastAt: number;
  added: boolean;
  verseKey: string | null;
  /** Segment of the last appended chunk (a new segment's first token has no leading space). */
  lastSegId: string | null;
  /** A sentence mark held back because the Arabic was cut mid-sentence:
   *  dropped when the next chunk continues the sentence, shown after HELD_MARK_MS otherwise. */
  held: string;
}

type Verdict =
  | { kind: "wait" }
  | { kind: "show" }
  | { kind: "drop"; verse: VerseInstance | null }
  | { kind: "quran"; verse: VerseInstance };

/** Counts words and decides everything at once (no Quran data, or Quran disabled). */
export function passThroughFollower(): QuranFollowerApi {
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

export class FastBlocks {
  private readonly opts: FastBlocksOptions;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly segs = new Map<string, SegState>();
  private readonly segOrder: SegState[] = [];
  private readonly queue: Chunk[] = [];
  private readonly verses: VerseInstance[] = [];
  private readonly recentAyat = new Map<string, number>();
  private readonly all: Block[] = [];
  private wordCount = 0;
  private decidedTo = 0;
  private seq = 0;
  private open: OpenBlock | null = null;
  /** The newest speech/dua block (open or closed): a tiny next piece may join it. */
  private lastSpeech: OpenBlock | null = null;
  private activeEvent: Block | null = null;
  private lastMode: SessionMode = "speech";
  private listening = false;
  private lastSpeechAt: number | null = null;
  private lastTextAt = 0;
  private lastDetectorTick = 0;
  private readonly ticker: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(opts: FastBlocksOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log.child({ component: "fast-blocks" });
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
  }

  // --- inputs ----------------------------------------------------------------------------------

  /** Every update of the primary track's segment (source + translation text so far). */
  update(seg: Segment): void {
    if (this.closed) return;
    const now = this.now();
    let st = this.segs.get(seg.id);
    if (st === undefined) {
      st = {
        id: seg.id,
        wordFrom: this.wordCount,
        wordTo: this.wordCount,
        srcFed: 0,
        srcText: "",
        trTaken: 0,
        chunkW: this.wordCount,
        chunkSrc: 0,
        closed: false,
        // During a prayer every segment waits for the detector: suppressed once the prayer is
        // confirmed, shown only if a provisional prayer is withdrawn (a talk after an Iqama).
        det: this.salahActive() ? "formula" : "live",
        startMs: seg.startMs,
        endMs: seg.endMs,
      };
      this.segs.set(seg.id, st);
      this.segOrder.push(st);
      this.prune();
    }
    if (seg.startMs !== null) st.startMs = st.startMs ?? seg.startMs;
    if (seg.endMs !== null) st.endMs = seg.endMs;

    const srcFinal = seg.source.text.slice(0, seg.source.finalLen);
    if (srcFinal.length > st.srcFed) {
      const delta = srcFinal.slice(st.srcFed);
      st.srcFed = srcFinal.length;
      st.srcText = srcFinal;
      const res = this.safeFollower(() => this.opts.follower.push(delta, now), delta);
      st.wordTo += res.added;
      this.wordCount += res.added;
      this.applyFollower(res);
      if (st.det === "live" || (st.det === "formula" && !this.salahActive())) {
        st.det = this.formulaGuard(st);
      }
      if (st.det === "live" && st.wordTo - st.wordFrom >= 4) this.releaseStaleHolds(st);
    }

    const tr = seg.translations[this.opts.targetLang];
    if (tr !== undefined) {
      const finalTr = tr.text.slice(0, tr.finalLen);
      if (finalTr.length > st.trTaken) {
        const wTo = Math.max(st.chunkW, st.wordTo);
        this.queue.push({
          segId: st.id,
          text: finalTr.slice(st.trTaken),
          wFrom: st.chunkW,
          wTo,
          src: st.srcText.slice(st.chunkSrc).trim(),
          at: now,
        });
        st.chunkW = wTo;
        st.chunkSrc = st.srcText.length;
        st.trTaken = finalTr.length;
      }
    }

    if (!seg.closed && seg.source.text.trim() !== "") this.heardSpeech(now);
    if (seg.closed && !st.closed) {
      st.closed = true;
      this.applyFollower(this.safeFollower(() => this.opts.follower.flush(now), ""));
      this.closeSegment(st, now);
    }
    this.flow(now);
  }

  /** Page speech events (VAD): used for the listening indicator and a prompt flush. */
  speech(state: "start" | "end", at: number): void {
    if (this.closed) return;
    if (state === "start") this.heardSpeech(at);
    else {
      this.applyFollower(this.safeFollower(() => this.opts.follower.flush(at), ""));
      this.flow(at);
    }
  }

  overrideEvent(event: PrayerEvent | "none"): void {
    if (this.closed) return;
    const now = this.now();
    const detector = this.opts.detector;
    if (detector !== null) {
      // Like its other calls: a failing detector must not break the operator's request.
      let actions: DetectorAction[] = [];
      try {
        actions = detector.override(event, now);
      } catch (err) {
        this.log.error({ err, event }, "event detector override failed; ignored");
      }
      this.apply(actions, now);
    } else if (event === "none") {
      this.endEventIfAny(now);
      this.setMode("speech");
    } else {
      // No detector: the operator's card is the mode (a manual Salah is silent too).
      this.startEvent(event, now, null, false);
      this.setMode(event);
    }
    this.flow(now);
  }

  get mode(): SessionMode {
    return this.opts.detector?.mode ?? this.lastMode;
  }

  listeningState(): { active: boolean; partial?: string } {
    return { active: this.listening };
  }

  blocks(opts: { before?: number; limit?: number } = {}): { blocks: Block[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
    const before = opts.before;
    const eligible = before === undefined ? this.all : this.all.filter((b) => b.seq < before);
    const slice = eligible.slice(Math.max(0, eligible.length - limit));
    return {
      blocks: slice.map((b) => structuredClone(b)),
      hasMore: eligible.length > slice.length,
    };
  }

  /**
   * Reset: forget the shown blocks (later snapshots are empty) and start the next words in a
   * fresh block. Pending chunks belong to speech before the reset: dropped.
   * blocks.jsonl keeps everything; seq keeps counting.
   */
  clearHistory(): void {
    this.all.length = 0;
    this.open = null;
    this.lastSpeech = null;
    this.queue.length = 0;
    for (const v of this.verses) v.block = null;
    this.activeEvent = null;
  }

  /** Session stop: decide everything still pending, show what may be shown, close the block. */
  async drain(_maxWaitMs: number): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    this.applyFollower(this.safeFollower(() => this.opts.follower.flush(now + 60_000), ""));
    for (const st of this.segOrder) {
      // Formula speech still held at the end is never shown (it may be a prayer call).
      if (st.det === "formula" || st.det === "held") st.det = "suppressed";
    }
    this.decidedTo = Math.max(this.decidedTo, this.wordCount);
    this.flow(now);
    this.closeOpen(now);
    this.setListening(false);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
  }

  // --- follower -------------------------------------------------------------------------------

  private safeFollower(
    fn: () => FollowerResult & { added?: number },
    text: string,
  ): FollowerResult & { added: number } {
    try {
      const res = fn();
      return { ...res, added: res.added ?? 0 };
    } catch (err) {
      // The follower must never stall captions: count the words and decide them as plain.
      this.log.error({ err }, "quran follower failed; words shown as plain speech");
      const added = arabicWords(text).length;
      return { added, decidedTo: this.wordCount + added, verses: [] };
    }
  }

  private applyFollower(res: FollowerResult): void {
    this.decidedTo = Math.max(this.decidedTo, Math.min(res.decidedTo, this.wordCount));
    for (const v of res.verses) this.addVerse(v);
  }

  private addVerse(v: FollowerVerse): void {
    const now = this.now();
    const existing = this.verses.find(
      (x) => x.ref === v.ref && v.from <= x.to + 2 && v.to >= x.from - 2,
    );
    if (existing !== undefined) {
      existing.from = Math.min(existing.from, v.from);
      existing.to = Math.max(existing.to, v.to);
      if (v.approved === null) return;
      // Approved text became known before any live chunk of it was shown: show it instead.
      if (existing.mode === "partial" && existing.shownChunks === 0) existing.mode = "approved";
      // The recited span grew (the next waqf segment): the block shows the longer span.
      if (existing.mode === "approved" && v.approved !== existing.approved) {
        existing.approved = v.approved;
        existing.uthmani = v.uthmani;
        this.refreshVerseBlock(existing, v.approved);
      }
      return;
    }
    const shownRecently = (this.recentAyat.get(v.ref) ?? -Infinity) > now - VERSE_RECENT_MS;
    const approved = v.approved !== null;
    this.verses.push({
      key: `${v.ref}@${v.from}`,
      ref: v.ref,
      from: v.from,
      to: v.to,
      mode: approved || shownRecently || !v.isNew ? "approved" : "partial",
      approved: v.approved,
      uthmani: v.uthmani,
      // A repeat of an ayah shown in the last 2 minutes is only suppressed, never shown again.
      emitted: shownRecently || (!v.isNew && !approved),
      shownChunks: 0,
      block: null,
    });
    if (this.verses.length > 200) this.verses.splice(0, this.verses.length - 200);
  }

  // --- segments & events ----------------------------------------------------------------------

  private formulaGuard(st: SegState): SegDisposition {
    return this.isFormula(st.srcText) ? "formula" : "live";
  }

  /** Formula-only speech by the detector's rules (never without a detector, or when it fails). */
  private isFormula(text: string): boolean {
    const detector = this.opts.detector;
    if (detector === null || text.trim() === "") return false;
    try {
      return detector.isFormulaOnly(text);
    } catch {
      return false;
    }
  }

  private closeSegment(st: SegState, now: number): void {
    const detector = this.opts.detector;
    if (detector === null || st.srcText.trim() === "") {
      // Without a detector a card started by hand silences what is said meanwhile.
      if (detector === null && this.manualEventActive()) st.det = "suppressed";
      else if (st.det !== "suppressed") st.det = "pass";
      return;
    }
    const ds: DetectorSegment = {
      id: st.id,
      text: st.srcText,
      at: now,
      silenceBeforeMs: this.silenceBefore(st),
    };
    if (st.startMs !== null) ds.startMs = st.startMs;
    if (st.endMs !== null) ds.endMs = st.endMs;
    let actions: DetectorAction[] = [];
    try {
      actions = detector.onSegment(ds);
    } catch (err) {
      this.log.error({ err }, "event detector failed; segment shown");
    }
    this.apply(actions, now);
    if (st.det === "live" || st.det === "formula") st.det = "pass";
  }

  private silenceBefore(st: SegState): number {
    const i = this.segOrder.indexOf(st);
    const prev = i > 0 ? this.segOrder[i - 1] : undefined;
    if (prev === undefined) return st.startMs ?? 1_000_000;
    if (st.startMs === null || prev.endMs === null) return 0;
    return Math.max(0, st.startMs - prev.endMs);
  }

  private apply(actions: readonly DetectorAction[], now: number): void {
    for (const a of actions) {
      switch (a.type) {
        case "pass":
          this.setDet(a.segment.id, "pass");
          break;
        case "hold":
          this.setDet(a.segment.id, "held");
          this.setListening(true);
          break;
        case "release":
          for (const s of a.segments) this.setDet(s.id, "pass");
          break;
        case "suppress":
          this.setDet(a.segment.id, "suppressed");
          break;
        case "event-start":
          for (const s of a.discarded) this.setDet(s.id, "suppressed");
          this.startEvent(a.event, now, a.hideFormulaBlocksSinceMs, a.provisional === true);
          break;
        case "event-change":
          this.changeEvent(a.to, now);
          break;
        case "event-retract":
          for (const s of a.released) this.setDet(s.id, "pass");
          this.retractEvent(now);
          break;
        case "event-end":
          this.endEventIfAny(now);
          break;
        case "mode":
          this.setMode(a.mode);
          break;
      }
    }
  }

  /**
   * Clear speech (4+ words, not a formula) after a held fragment such as a lone "من": the
   * detector will release the fragment when this segment closes; release it now so the
   * captions behind it don't wait for the whole sentence.
   */
  private releaseStaleHolds(current: SegState): void {
    if (this.activeEvent?.event?.active === true || this.salahActive()) return;
    const mode = this.opts.detector?.mode ?? "speech";
    if (mode !== "speech" && mode !== "held") return;
    for (const st of this.segOrder) {
      if (st === current) break;
      if (st.det === "held" && st.closed) st.det = "pass";
    }
  }

  private setDet(id: string, det: SegDisposition): void {
    const st = this.segs.get(id);
    if (st !== undefined) st.det = det;
  }

  /** An event card started by hand is on screen and no detector decides. */
  private manualEventActive(): boolean {
    return this.opts.detector === null && this.activeEvent?.event?.active === true;
  }

  private salahActive(): boolean {
    return (
      this.opts.detector?.salah === true ||
      this.opts.detector?.mode === "salah" ||
      (this.activeEvent?.event?.type === "salah" && this.activeEvent.event.active)
    );
  }

  private setMode(mode: SessionMode): void {
    if (mode === "salah") {
      // Nothing said in the prayer is shown: open segments wait for the detector's decision.
      for (const st of this.segOrder) if (!st.closed && st.det === "live") st.det = "formula";
      this.closeOpen(this.now());
    }
    if (mode === this.lastMode) return;
    this.lastMode = mode;
    this.opts.emit({ type: "mode", mode });
  }

  private label(event: PrayerEvent): { ar: string; title: string; subtitle: string } {
    return this.opts.labels[event];
  }

  private startEvent(
    event: PrayerEvent,
    now: number,
    hideFormulaSinceMs: number | null,
    provisional: boolean,
  ): void {
    this.closeOpen(now);
    if (this.activeEvent?.event?.active === true) this.endEventIfAny(now);
    // Everything held for this call belongs to it: never shown, never blocking later captions.
    // A prayer: open segments wait for the detector (a provisional prayer may be withdrawn).
    for (const st of this.segOrder) {
      if (event !== "salah" && (st.det === "held" || st.det === "formula")) st.det = "suppressed";
      if (event === "salah" && !st.closed && st.det === "live") {
        st.det = provisional ? "formula" : "suppressed";
      }
    }
    const block = this.addBlock({
      kind: "event",
      text: "",
      ref: null,
      src: null,
      event: { type: event, active: true, startedAt: now, label: this.label(event) },
      segmentIds: [],
      startMs: null,
      endMs: null,
    });
    this.activeEvent = block;
    if (provisional) this.log.info({ event }, "provisional prayer-call card");
    if (hideFormulaSinceMs !== null) this.hideFormulaBlocks(hideFormulaSinceMs);
  }

  private changeEvent(to: PrayerEvent, _now: number): void {
    const card = this.activeEvent;
    if (card?.event === undefined) return;
    card.event = { ...card.event, type: to, label: this.label(to) };
    this.updateBlock(card);
  }

  private retractEvent(now: number): void {
    const card = this.activeEvent;
    if (card === null) return;
    card.hidden = true;
    if (card.event !== undefined) card.event = { ...card.event, active: false, endedAt: now };
    this.updateBlock(card);
    this.activeEvent = null;
  }

  private endEventIfAny(now: number): void {
    const card = this.activeEvent;
    if (card?.event === undefined || !card.event.active) {
      this.activeEvent = null;
      return;
    }
    card.event = { ...card.event, active: false, endedAt: now };
    this.updateBlock(card);
    this.activeEvent = null;
  }

  /** Only at the end of startEvent(), which has closed the open block. */
  private hideFormulaBlocks(sinceMs: number): void {
    for (const b of this.all) {
      if (b.createdAt < sinceMs || b.hidden === true || b.kind === "event") continue;
      if (!this.isFormula(b.src ?? "")) continue;
      b.hidden = true;
      this.updateBlock(b);
    }
  }

  // --- chunk flow ------------------------------------------------------------------------------

  private flow(now: number): void {
    for (let c = this.queue[0]; c !== undefined; c = this.queue[0]) {
      const verdict = this.classify(c);
      if (verdict.kind === "wait") break;
      this.queue.shift();
      this.emitReadyVerses(c.wFrom, now);
      if (verdict.kind === "drop") {
        if (verdict.verse !== null) this.emitVerse(verdict.verse, now);
        continue;
      }
      if (verdict.kind === "quran") {
        this.appendQuran(c, verdict.verse, now);
        continue;
      }
      this.appendSpeech(c, now);
    }
    this.emitReadyVerses(this.queue[0]?.wFrom ?? Number.POSITIVE_INFINITY, now);
  }

  private classify(c: Chunk): Verdict {
    const st = this.segs.get(c.segId);
    if (st !== undefined) {
      if (st.det === "formula" || st.det === "held") return { kind: "wait" };
      if (st.det === "suppressed") return { kind: "drop", verse: null };
      if (this.salahActive() && st.det === "live") {
        st.det = "formula";
        return { kind: "wait" };
      }
    }
    // The Arabic words behind the chunk (a chunk without new words belongs to the last word).
    let from = c.wFrom;
    const to = c.wTo;
    if (to <= from) {
      if (st === undefined || from <= st.wordFrom) return { kind: "show" };
      from = to - 1;
    }
    if (to > this.decidedTo) return { kind: "wait" };
    const n = to - from;
    let approvedWords = 0;
    let partialWords = 0;
    let approvedVerse: VerseInstance | null = null;
    let partialVerse: VerseInstance | null = null;
    for (const v of this.verses) {
      const overlap = Math.min(to, v.to) - Math.max(from, v.from);
      if (overlap <= 0) continue;
      if (v.mode === "approved") {
        approvedWords += overlap;
        approvedVerse ??= v;
      } else {
        partialWords += overlap;
        partialVerse ??= v;
      }
    }
    if (approvedWords * 2 >= n) return { kind: "drop", verse: approvedVerse };
    if (partialVerse !== null && partialWords * 2 >= n)
      return { kind: "quran", verse: partialVerse };
    return { kind: "show" };
  }

  /** Approved ayat start where their words start: once every chunk before them is shown. */
  private emitReadyVerses(nextChunkFrom: number, now: number): void {
    for (const v of this.verses) {
      if (v.emitted || v.mode !== "approved") continue;
      if (v.from > this.decidedTo) continue;
      if (nextChunkFrom < v.from) continue;
      this.emitVerse(v, now);
    }
  }

  /**
   * An approved ayah obeys the same rules as live text: never during a prayer (it waits for the
   * detector's decision and is dropped once the prayer is confirmed), never from suppressed speech.
   */
  private verseGate(v: VerseInstance): "show" | "wait" | "drop" {
    const segs = this.segOrder.filter((st) => st.wordFrom < v.to && st.wordTo > v.from);
    if (segs.some((st) => st.det === "suppressed")) return "drop";
    if (segs.some((st) => st.det === "held" || st.det === "formula")) return "wait";
    if (this.salahActive() && !segs.every((st) => st.det === "pass")) return "wait";
    return "show";
  }

  private emitVerse(v: VerseInstance, now: number): void {
    // Every verse that reaches here unemitted is approved with its text: addVerse marks the
    // others emitted (a repeat or an extension without text), and only approved ones are emitted.
    const approved = v.approved;
    if (v.emitted || approved === null) return;
    const gate = this.verseGate(v);
    if (gate === "wait") return;
    v.emitted = true;
    if (gate === "drop") return;
    this.recentAyat.set(v.ref, now);
    this.closeOpen(now);
    v.block = this.addBlock({
      kind: "quran",
      text: this.verseText(approved),
      ref: v.ref,
      src: null,
      quranText: v.uthmani,
      segmentIds: this.segIdsForWords(v.from, v.to),
      startMs: null,
      endMs: null,
    });
    this.markText(now);
  }

  /** Approved verse text as shown: verbatim, no quotes (the block's style and ref mark it as
   *  Quran), so a longer recited span simply grows the text. */
  private verseText(approved: string): string {
    return normalizeIslamicTerms(approved.trim(), this.opts.targetLang, { quran: true });
  }

  /**
   * The khatib recited more of an ayah already shown: its block shows the longer span. (A verse
   * block has no Arabic line, so it is never hidden as formula speech.)
   */
  private refreshVerseBlock(v: VerseInstance, approved: string): void {
    const b = v.block;
    if (b === null) return;
    const text = this.verseText(approved);
    if (text === b.text && (v.uthmani ?? null) === (b.quranText ?? null)) return;
    b.text = text;
    b.quranText = v.uthmani;
    b.segmentIds = this.segIdsForWords(v.from, v.to);
    this.updateBlock(b);
    this.markText(this.now());
  }

  private appendQuran(c: Chunk, v: VerseInstance, now: number): void {
    v.shownChunks += 1;
    if (this.open === null || this.open.verseKey !== v.key) {
      this.closeOpen(now);
      this.recentAyat.set(v.ref, now);
      this.open = this.newOpen("quran", v.ref, v.key, c, now);
      this.open.raw = '"';
    }
    this.appendText(this.open, c.text, c, now);
  }

  private appendSpeech(c: Chunk, now: number): void {
    // The Arabic was cut on a word that cannot end a sentence («… على.»): Soniox's period after
    // the Dutch is not a sentence end. It is held back so the next chunk continues the sentence.
    let held = "";
    if (c.src !== "" && endsMidSentence(c.src)) {
      const m = CUT_MARK.exec(c.text);
      if (m !== null) {
        held = m[0].trimEnd(); // the match is the mark and the spaces after it
        c = { ...c, text: c.text.slice(0, m.index) };
      }
    }
    this.appendSpeechText(c, now);
    if (held !== "" && this.open !== null && this.open.lastSegId === c.segId) this.open.held = held;
  }

  private appendSpeechText(c: Chunk, now: number): void {
    let open = this.open;
    const tail = open?.raw.trimEnd() ?? "";
    if (
      open !== null &&
      (open.verseKey !== null ||
        this.pauseEnds(open, now) ||
        (open.words >= MIN_BLOCK_WORDS && ENDS_SENTENCE.test(tail)) ||
        (open.words >= LONG_BLOCK_WORDS && open.held === "" && ENDS_CLAUSE.test(tail)))
    ) {
      this.closeOpen(now);
      open = null;
    }
    let text = c.text;
    // A sentence that ends inside the chunk completes the block; the rest (never empty: a break
    // is followed by text) starts a new one.
    const cut = lastSentenceBreak(text);
    if (cut > 0) {
      const head = text.slice(0, cut);
      const target = open ?? this.openFor(c, head, now);
      this.appendText(target, head, c, now);
      if (target.words >= MIN_BLOCK_WORDS) {
        this.closeOpen(now);
        open = null;
      } else {
        open = target;
      }
      text = text.slice(cut);
    }
    if (open !== null && open.words + countWords(text) > MAX_BLOCK_WORDS) {
      this.closeOpen(now);
      open = null;
    }
    const target = open ?? this.openFor(c, text, now);
    this.appendText(target, text, c, now);
  }

  /**
   * A pause ends the block when it reads as finished: a sentence end, or a clause end once the
   * block is long. A breath mid-sentence keeps it open; a long silence ends any block.
   */
  private pauseEnds(open: OpenBlock, now: number): boolean {
    // Quiet = no new text *and* no speech: while the khatib is still talking (Soniox's words
    // not yet final) an unfinished sentence stays open, however long that takes.
    const quiet = now - Math.max(open.lastAt, this.lastSpeechAt ?? Number.NEGATIVE_INFINITY);
    if (quiet < PARAGRAPH_PAUSE_MS) return false;
    if (quiet >= LONG_PAUSE_MS || open.block.kind === "quran") return true;
    // A sentence mark held after a mid-sentence cut: the sentence did not go on.
    if (open.held !== "") return quiet >= HELD_MARK_MS;
    const raw = open.raw.replace(TRAILING_ELLIPSIS, "").trimEnd();
    if (ENDS_SENTENCE.test(raw)) return true;
    return ENDS_CLAUSE.test(raw) && open.words >= SOFT_BLOCK_WORDS;
  }

  /**
   * The block for a piece that would start a new one: a tiny complete sentence ("Met waarheid.",
   * "Ook.") joins the previous block. The start of a new sentence opens a block (it will grow).
   */
  private openFor(c: Chunk, piece: string, now: number): OpenBlock {
    const prev = this.lastSpeech;
    const shown = normalizeIslamicTerms(piece, this.opts.targetLang, { src: c.src }).trimEnd();
    const words = countWords(shown);
    const tiny = words < MIN_NEW_BLOCK_WORDS && ENDS_SENTENCE.test(shown);
    const intro = words <= INTRO_JOIN_WORDS && ENDS_INTRO.test(shown);
    if (
      prev !== null &&
      (tiny || intro) &&
      prev.added &&
      prev.block.hidden !== true &&
      this.all[this.all.length - 1] === prev.block &&
      now - prev.lastAt <= TAIL_JOIN_MS &&
      prev.words + words <= MAX_BLOCK_WORDS
    ) {
      this.open = prev;
      return prev;
    }
    return this.openSpeech(c, now);
  }

  private openSpeech(c: Chunk, now: number): OpenBlock {
    const st = this.segs.get(c.segId);
    const first = st === undefined ? "" : (normalizeArabic(st.srcText).split(" ")[0] ?? "");
    const kind: BlockKind = first === "اللهم" || first === "ربنا" ? "dua" : "speech";
    this.open = this.newOpen(kind, null, null, c, now);
    this.lastSpeech = this.open;
    return this.open;
  }

  private newOpen(
    kind: BlockKind,
    ref: string | null,
    verseKey: string | null,
    c: Chunk,
    now: number,
  ): OpenBlock {
    const st = this.segs.get(c.segId);
    const block: Block = {
      id: `${this.opts.sessionId}:b${++this.seq}`,
      seq: this.seq,
      kind,
      text: "",
      ref,
      src: null,
      lang: this.opts.targetLang,
      segmentIds: [c.segId],
      createdAt: now,
      startMs: st?.startMs ?? null,
      endMs: st?.endMs ?? null,
    };
    return {
      block,
      raw: "",
      words: 0,
      lastAt: now,
      added: false,
      verseKey,
      lastSegId: null,
      held: "",
    };
  }

  private appendText(open: OpenBlock, text: string, c: Chunk, now: number): void {
    let piece = open.raw === "" || open.raw === '"' ? text.trimStart() : text;
    if (piece === "") return;
    // Soniox starts each segment's translation without a space: keep words apart.
    if (
      open.lastSegId !== null &&
      open.lastSegId !== c.segId &&
      !/\s$/.test(open.raw) &&
      !/^\s/.test(piece)
    ) {
      piece = ` ${piece}`;
    }
    open.lastSegId = c.segId;
    // The sentence continues: the "..." Soniox put at the segment end goes away (or the sentence
    // mark held back after a mid-sentence cut is dropped), and the next word is not a sentence
    // start ("En niet als het …", not "En niet Als het …").
    const continues = TRAILING_ELLIPSIS.test(open.raw) || open.held !== "";
    if (continues && !/^\s*[.!?…]/.test(piece)) {
      open.raw = open.raw.replace(TRAILING_ELLIPSIS, "");
      open.held = "";
      piece = this.lowerContinuation(piece);
      if (!/^\s/.test(piece)) piece = ` ${piece}`;
    } else if (open.held !== "") {
      piece = `${open.held}${piece}`;
      open.held = "";
    }
    open.raw += piece;
    open.words += countWords(piece);
    open.lastAt = now;
    const st = this.segs.get(c.segId);
    const b = open.block;
    if (!b.segmentIds.includes(c.segId)) b.segmentIds.push(c.segId);
    // The block's Arabic line: exactly the source behind its chunks.
    if (c.src !== "") b.src = [b.src ?? "", c.src].filter((x) => x !== "").join(" ");
    if (st?.endMs !== null && st?.endMs !== undefined) b.endMs = st.endMs;
    b.text = this.shownText(open);
    if (b.text === "") return;
    if (!open.added) {
      open.added = true;
      b.createdAt = now;
      this.all.push(b);
      this.persist(b);
      this.opts.emit({ type: "block.add", block: structuredClone(b) });
    } else {
      this.updateBlock(b);
    }
    this.markText(now);
  }

  /** The first word of a continuation in lower case ("Aan anderen" → "aan anderen"). */
  private lowerContinuation(piece: string): string {
    if (!this.opts.targetLang.toLowerCase().startsWith("nl")) return piece;
    return piece.replace(
      /^(\s*)(\p{Lu})(\p{Ll}*)/u,
      (m, sp: string, first: string, rest: string) =>
        NL_CONTINUATION.has(`${first}${rest}`.toLowerCase())
          ? `${sp}${first.toLowerCase()}${rest}`
          : m,
    );
  }

  /** Show a held sentence mark after all (the sentence did not continue). */
  private releaseHeld(open: OpenBlock): void {
    if (open.held === "") return;
    open.raw = `${open.raw.trimEnd()}${open.held}`;
    open.held = "";
    if (!open.added) return;
    open.block.text = this.shownText(open);
    this.updateBlock(open.block);
  }

  private shownText(open: OpenBlock): string {
    const quran = open.block.kind === "quran";
    const raw = open.raw.replace(TRAILING_ELLIPSIS, "");
    return normalizeIslamicTerms(raw, this.opts.targetLang, { quran, src: open.block.src ?? "" });
  }

  private closeOpen(now: number): void {
    const open = this.open;
    this.open = null;
    if (open === null) return;
    this.releaseHeld(open);
    if (!open.added) return;
    if (open.block.kind === "quran" && !open.raw.trimEnd().endsWith('"')) {
      open.raw = `${open.raw.trimEnd()}"`;
      open.block.text = this.shownText(open);
      this.updateBlock(open.block);
    }
    open.lastAt = now;
  }

  // --- blocks ---------------------------------------------------------------------------------

  private addBlock(fields: Omit<Block, "id" | "seq" | "lang" | "createdAt">): Block {
    const now = this.now();
    const block: Block = {
      ...fields,
      id: `${this.opts.sessionId}:b${++this.seq}`,
      seq: this.seq,
      lang: this.opts.targetLang,
      createdAt: now,
    };
    this.all.push(block);
    this.persist(block);
    this.opts.emit({ type: "block.add", block: structuredClone(block) });
    return block;
  }

  private updateBlock(b: Block): void {
    this.persist(b);
    this.opts.emit({ type: "block.update", block: structuredClone(b) });
  }

  private persist(b: Block): void {
    try {
      this.opts.persist?.(JSON.stringify(b));
    } catch (err) {
      this.log.warn({ err }, "blocks.jsonl write failed");
    }
  }

  private segIdsForWords(from: number, to: number): string[] {
    return this.segOrder.filter((s) => s.wordFrom < to && s.wordTo > from).map((s) => s.id);
  }

  // --- listening & housekeeping -----------------------------------------------------------------

  private heardSpeech(at: number): void {
    this.lastSpeechAt = at;
  }

  private markText(now: number): void {
    this.lastTextAt = now;
    this.setListening(false);
  }

  private setListening(active: boolean): void {
    if (active === this.listening) return;
    this.listening = active;
    this.opts.emit({ type: "listening", active });
  }

  /** Every TICK_MS until close() clears the interval. */
  private tick(): void {
    const now = this.now();
    const detector = this.opts.detector;
    if (detector !== null && now - this.lastDetectorTick >= DETECTOR_TICK_MS) {
      this.lastDetectorTick = now;
      try {
        this.apply(detector.tick(now), now);
      } catch (err) {
        this.log.error({ err }, "event detector tick failed");
      }
    }
    this.applyFollower(this.safeFollower(() => this.opts.follower.flush(now), ""));
    this.unstick(now);
    this.flow(now);
    // A pause ends a finished-looking block (a held sentence mark is shown then): the next words
    // open a new one.
    if (this.open !== null && this.pauseEnds(this.open, now)) this.closeOpen(now);
    // Listening dots: the imam is speaking but no new text for a while, or a call is held.
    const speaking = this.lastSpeechAt !== null && now - this.lastSpeechAt < 1500;
    const waiting = speaking && now - this.lastTextAt >= LISTENING_AFTER_MS;
    const held = this.segOrder.some((s) => !s.closed && (s.det === "held" || s.det === "formula"));
    this.setListening(!this.salahActive() && (waiting || held));
  }

  /** Safety net: a detector or follower slip must never freeze the captions. */
  private unstick(now: number): void {
    const head = this.queue[0];
    if (head === undefined) return;
    const waited = now - head.at;
    const st = this.segs.get(head.segId);
    if (st !== undefined && (st.det === "held" || st.det === "formula") && waited >= MAX_HOLD_MS) {
      this.log.warn({ segment: st.id }, "held speech dropped after the hold limit");
      st.det = "suppressed";
      return;
    }
    if (head.wTo > this.decidedTo && waited >= MAX_UNDECIDED_MS) {
      this.log.warn({ words: head.wTo - this.decidedTo }, "undecided words shown as plain speech");
      this.decidedTo = Math.min(this.wordCount, Math.max(this.decidedTo, head.wTo));
    }
  }

  private prune(): void {
    while (this.segOrder.length > MAX_SEGMENTS) {
      const oldest = this.segOrder[0];
      if (oldest === undefined || !oldest.closed) break;
      if (this.queue.some((c) => c.segId === oldest.id)) break;
      this.segOrder.shift();
      this.segs.delete(oldest.id);
    }
  }
}

/** Index just after the last sentence end that is followed by more text, or -1. */
function lastSentenceBreak(text: string): number {
  SENTENCE_BREAK.lastIndex = 0;
  let cut = -1;
  for (let m = SENTENCE_BREAK.exec(text); m !== null; m = SENTENCE_BREAK.exec(text)) {
    cut = m.index + m[0].length;
  }
  return cut;
}

function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}
