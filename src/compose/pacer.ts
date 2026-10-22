// Calm captions: the pacing stage between fast blocks and the session.
//
//   FastBlocks ─▶ growing speech and dua blocks ("members"), out of sight until each is closed
//              │      └▶ bundles of related closed members ─▶ one complete block per step
//              └▶ Quran verses, prayer cards (and their updates), mode ─▶ at once
//
// - A step is one moment in which one or more blocks appear together. The next step waits
//   gapAfter(characters shown in the previous one): 2 s plus the time to read them at 15
//   characters a second, at least 6 s and at most 20 s. It comes at the first moment after that
//   when a closed member is waiting.
// - Consecutive closed members share a bundle; a long pause, a new point («أما بعد», «عباد الله»,
//   …), a change between speech and dua, or the word cap starts the next one. One bundle per
//   step, the oldest first. A bundle over the cap, or a second one waiting, goes out at the
//   shortest gap, so the delay never keeps growing.
// - A verse or a prayer card first brings out all speech said before it, in the same step.
// - The history, snapshots and blocks.jsonl hold the published blocks, never the members.
import type { Logger } from "pino";
import type { Block, PrayerEvent, Segment, SessionMode } from "../shared/protocol.js";
import { arabicWords } from "../text/arabic.js";
import type { BlockPipeline, PipelineOutput } from "./types.js";

/** The pace of calm captions, each a one-line change. */
export const CALM = {
  /** The shortest and the longest wait between two steps. */
  minGapMs: 6000,
  maxGapMs: 20_000,
  /** The reading speed the wait is measured with, plus a moment for the eyes to move on. */
  readCharsPerSec: 15,
  baseGapMs: 2000,
  /** A bundle holds at most this many words. */
  maxBundleWords: 55,
  /** A pause this long between two members starts a new bundle. */
  longPauseMs: 6000,
  /** "listening" after this long of speech with nothing shown and nothing waiting. */
  listeningAfterMs: 20_000,
} as const;

/** How a khatib opens a new point: a member that starts with one starts a new bundle. */
export const NEW_POINT_OPENERS: readonly string[] = [
  "أما بعد",
  "عباد الله",
  "أيها الناس",
  "أيها المسلمون",
  "أيها المؤمنون",
  "اعلموا",
];

const OPENER_WORDS = NEW_POINT_OPENERS.map((o) => arabicWords(o));
const TICK_MS = 250;

/** The wait after a step that showed `chars` characters. */
export function gapAfter(chars: number): number {
  const ms = CALM.baseGapMs + (chars * 1000) / CALM.readCharsPerSec;
  return Math.min(CALM.maxGapMs, Math.max(CALM.minGapMs, ms));
}

/** The Arabic starts with one of NEW_POINT_OPENERS (normalized, whole words), also after «يا»
 *  or with «و» or «ف» on the first word: «يا عباد الله», «واعلموا». */
export function opensNewPoint(src: string | null): boolean {
  let words = arabicWords(src ?? "");
  if (words[0] === "يا") words = words.slice(1);
  const [first = "", ...rest] = words;
  const starts = [words];
  if (/^[وف]./.test(first)) starts.push([first.slice(1), ...rest]);
  return starts.some((ws) => OPENER_WORDS.some((o) => o.every((w, i) => ws[i] === w)));
}

/** What the paced pipeline gives fast blocks to talk back with. */
export interface PacerHooks {
  emit: (out: PipelineOutput) => void;
  closed: (block: Block) => void;
}

export interface PacerOptions {
  sessionId: string;
  now?: () => number;
  log: Logger;
  /** One blocks.jsonl line (a complete Block as JSON) per published add/update. */
  persist?: (line: string) => void;
  emit: (out: PipelineOutput) => void;
  /** The pipeline whose blocks are paced (FastBlocks), made with the pacer's hooks. */
  inner: (hooks: PacerHooks) => BlockPipeline;
}

interface Member {
  /** Its latest state in the inner pipeline. */
  block: Block;
  /** A verse or a prayer card: published at once, its updates pass through. */
  exempt: boolean;
  closed: boolean;
  /** When its first text and its last change arrived. */
  firstAt: number;
  lastAt: number;
  /** The published block it is part of. */
  bundle: Bundle | null;
}

interface Bundle {
  block: Block;
  members: readonly Member[];
}

function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

function wordsOf(members: readonly Member[]): number {
  return members.reduce((n, m) => n + countWords(m.block.text), 0);
}

export class Pacer implements BlockPipeline {
  private readonly opts: PacerOptions;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly inner: BlockPipeline;
  /** Members by their id in the inner pipeline. */
  private readonly members = new Map<string, Member>();
  /** Not yet published, in the order they were said. */
  private pending: Member[] = [];
  /** Published, oldest first. */
  private readonly shown: Bundle[] = [];
  private seq = 0;
  private lastStep: { at: number; chars: number } | null = null;
  private innerListening = false;
  private innerListeningSince = 0;
  private listening = false;
  /** Inside a call into the inner pipeline: its output is stepped when the call returns. */
  private depth = 0;
  private stepQueued = false;
  private readonly ticker: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(opts: PacerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log.child({ component: "pacer" });
    this.inner = opts.inner({
      emit: (out) => this.fromInner(out),
      closed: (block) => this.memberClosed(block),
    });
    this.ticker = setInterval(() => this.pump(), TICK_MS);
    this.ticker.unref?.();
  }

  // --- BlockPipeline ------------------------------------------------------------------------------

  update(seg: Segment): void {
    this.call(() => this.inner.update(seg));
  }

  speech(state: "start" | "end", at: number): void {
    this.call(() => this.inner.speech(state, at));
  }

  overrideEvent(event: PrayerEvent | "none"): void {
    this.call(() => this.inner.overrideEvent(event));
  }

  get mode(): SessionMode {
    return this.inner.mode;
  }

  /** Never the live Arabic partial: a calm screen shows only published text. */
  listeningState(): { active: boolean } {
    return { active: this.listening };
  }

  blocks(opts: { before?: number; limit?: number } = {}): { blocks: Block[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
    const before = opts.before;
    const eligible =
      before === undefined ? this.shown : this.shown.filter((b) => b.block.seq < before);
    const slice = eligible.slice(Math.max(0, eligible.length - limit));
    return {
      blocks: slice.map((b) => structuredClone(b.block)),
      hasMore: eligible.length > slice.length,
    };
  }

  /** Reset: the shown blocks and the waiting ones are forgotten; seq keeps counting. */
  clearHistory(): void {
    this.inner.clearHistory();
    this.members.clear();
    this.pending = [];
    this.shown.length = 0;
    // Nothing is left on screen to read: the next bundle need not wait.
    this.lastStep = null;
  }

  /** Session stop: fast blocks shows what it may, then everything waiting appears at once. */
  async drain(maxWaitMs: number): Promise<void> {
    this.depth++;
    try {
      await this.inner.drain(maxWaitMs);
    } finally {
      this.depth--;
    }
    const now = this.now();
    if (this.pending.length > 0) this.step(this.pending.length, now);
    this.updateListening(now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.inner.close();
  }

  // --- from fast blocks -----------------------------------------------------------------------------

  private call(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
    this.pump();
  }

  private fromInner(out: PipelineOutput): void {
    const now = this.now();
    switch (out.type) {
      case "block.add":
      case "block.update":
        this.onBlock(out.block, out.type === "block.add", now);
        break;
      case "mode":
        this.opts.emit(out);
        break;
      case "listening":
        if (out.active && !this.innerListening) this.innerListeningSince = now;
        this.innerListening = out.active;
        break;
    }
    this.later();
  }

  private onBlock(block: Block, added: boolean, now: number): void {
    if (added) {
      const exempt = block.kind === "quran" || block.kind === "event";
      const member: Member = {
        block,
        exempt,
        closed: false,
        firstAt: now,
        lastAt: now,
        bundle: null,
      };
      this.members.set(block.id, member);
      this.pending.push(member);
      return;
    }
    const m = this.members.get(block.id);
    // A block from before a Clear.
    if (m === undefined) return;
    m.block = block;
    m.lastAt = now;
    if (m.bundle !== null) this.rebuild(m.bundle);
    else if (block.hidden === true) this.drop(m);
  }

  private memberClosed(block: Block): void {
    const m = this.members.get(block.id);
    // A quoted verse closes too: it went out at once.
    if (m === undefined || m.exempt) return;
    m.block = block;
    m.closed = true;
    this.later();
  }

  /** Output that came from fast blocks' own ticker: stepped once it has said everything. */
  private later(): void {
    if (this.depth > 0 || this.stepQueued) return;
    this.stepQueued = true;
    queueMicrotask(() => {
      this.stepQueued = false;
      this.pump();
    });
  }

  private drop(m: Member): void {
    this.pending = this.pending.filter((p) => p !== m);
    this.members.delete(m.block.id);
  }

  // --- steps ----------------------------------------------------------------------------------------

  /** After every input, on fast blocks' output and every tick: verses and cards at once (with the
   *  speech before them), else the oldest bundle once its gap has passed. */
  private pump(): void {
    const now = this.now();
    const lastExempt = this.pending.findLastIndex((m) => m.exempt);
    if (lastExempt >= 0) this.step(lastExempt + 1, now);
    else this.stepIfDue(now);
    this.updateListening(now);
  }

  private stepIfDue(now: number): void {
    const ready: Member[] = [];
    for (const m of this.pending) {
      if (!m.closed) break;
      ready.push(m);
    }
    const [oldest, next] = this.bundles(ready);
    if (oldest === undefined) return;
    const last = this.lastStep;
    if (last !== null) {
      // A second bundle waiting, or one over the cap: the shortest gap keeps the delay bounded.
      const crowded = next !== undefined || wordsOf(oldest) > CALM.maxBundleWords;
      const wait = crowded ? CALM.minGapMs : gapAfter(last.chars);
      if (now - last.at < wait) return;
    }
    this.step(oldest.length, now);
  }

  /** Publish the first `count` waiting members together: speech in bundles, verses and cards as
   *  they are. The next step waits for the characters shown here. */
  private step(count: number, now: number): void {
    const items = this.pending.splice(0, count);
    let chars = 0;
    let speech: Member[] = [];
    const flushSpeech = (): void => {
      for (const b of this.bundles(speech)) chars += this.publish(b, now);
      speech = [];
    };
    for (const m of items) {
      if (!m.exempt) {
        speech.push(m);
        continue;
      }
      flushSpeech();
      chars += this.publish([m], now);
    }
    flushSpeech();
    this.lastStep = { at: now, chars };
  }

  /** Consecutive speech members split into bundles. */
  private bundles(members: readonly Member[]): Member[][] {
    const out: Member[][] = [];
    let current: Member[] = [];
    let words = 0;
    for (const m of members) {
      const prev = current.at(-1);
      const n = countWords(m.block.text);
      if (prev !== undefined && !this.startsBundle(prev, m, words)) {
        current.push(m);
        words += n;
        continue;
      }
      current = [m];
      out.push(current);
      words = n;
    }
    return out;
  }

  /** A long pause, a new point, speech after dua (or dua after speech), or the word cap. */
  private startsBundle(prev: Member, next: Member, words: number): boolean {
    const a = prev.block;
    const b = next.block;
    if (a.kind !== b.kind) return true;
    const pause =
      typeof a.endMs === "number" && typeof b.startMs === "number"
        ? b.startMs - a.endMs
        : next.firstAt - prev.lastAt;
    if (pause >= CALM.longPauseMs || opensNewPoint(b.src)) return true;
    return words + countWords(b.text) > CALM.maxBundleWords;
  }

  /** One new block for these members; the characters it shows. */
  private publish(members: readonly Member[], now: number): number {
    const seq = ++this.seq;
    const id = `${this.opts.sessionId}:b${seq}`;
    const bundle: Bundle = { block: this.compose(members, id, seq, now), members };
    for (const m of members) m.bundle = bundle;
    this.shown.push(bundle);
    this.persist(bundle.block);
    this.opts.emit({ type: "block.add", block: structuredClone(bundle.block) });
    return bundle.block.text.length;
  }

  /** A member of a published block changed: a verse or a card passes its change through; a
   *  bundle follows its visible members, and is hidden when none is left. */
  private rebuild(bundle: Bundle): void {
    const { id, seq, createdAt } = bundle.block;
    const visible = bundle.members.filter((m) => m.exempt || m.block.hidden !== true);
    bundle.block =
      visible.length > 0
        ? this.compose(visible, id, seq, createdAt)
        : { ...bundle.block, hidden: true };
    this.persist(bundle.block);
    this.opts.emit({ type: "block.update", block: structuredClone(bundle.block) });
  }

  /** The published block of `members` (a verse or a card: itself, under its published id). */
  private compose(members: readonly Member[], id: string, seq: number, createdAt: number): Block {
    const first = members[0] as Member;
    if (first.exempt) return { ...structuredClone(first.block), id, seq, createdAt };
    const last = members[members.length - 1] as Member;
    const src = members
      .map((m) => m.block.src?.trim() ?? "")
      .filter((s) => s !== "")
      .join(" ");
    return {
      id,
      seq,
      kind: first.block.kind,
      text: members
        .map((m) => m.block.text.trim())
        .filter((t) => t !== "")
        .join(" "),
      ref: null,
      src: src === "" ? null : src,
      lang: first.block.lang,
      segmentIds: [...new Set(members.flatMap((m) => m.block.segmentIds))],
      createdAt,
      startMs: first.block.startMs ?? null,
      endMs: last.block.endMs ?? null,
    };
  }

  private persist(b: Block): void {
    try {
      this.opts.persist?.(JSON.stringify(b));
    } catch (err) {
      this.log.warn({ err }, "blocks.jsonl write failed");
    }
  }

  // --- listening --------------------------------------------------------------------------------------

  /** Listening only when the khatib has been heard for a long time with nothing shown and nothing
   *  waiting; never while a bundle waits for its step. */
  private updateListening(now: number): void {
    const since = Math.max(this.innerListeningSince, this.lastStep?.at ?? 0);
    const active =
      this.innerListening && this.pending.length === 0 && now - since >= CALM.listeningAfterMs;
    if (active === this.listening) return;
    this.listening = active;
    this.opts.emit({ type: "listening", active });
  }
}
