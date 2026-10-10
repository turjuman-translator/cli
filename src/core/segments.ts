// Per-track segment store.
//
// Provider events → segments. Every engine instance (provider + timeline) is registered with
// `beginEngine()` and its events are routed by engine id, so an engine that is still finishing
// (a live switch, a page engine closing after silence) never mixes its tokens into the next
// engine's segments. `endEngine()` closes the engine's open segment and finalizes its pending
// native translations.
//
// Source tokens: finals append to the open segment, non-finals replace its non-final tail; an
// `endpoint` closes it. Native translation tokens (Soniox) are routed to cursor(lang): the oldest
// closed segment of the engine's CURRENT provider session whose translation is still pending and
// that is still a candidate (until the next segment closes + 500 ms, or translationGraceMs after
// its own close), else the open segment. Mirrored "none" tokens (speech already in the target
// language) go to the segment that received their source token. Done segments (closed + every
// translation final) are immutable.

import type { FrameTimeline } from "../audio/timeline.js";
import type { Segment, TextState, TrackId } from "../shared/protocol.js";
import type { ProviderCapabilities, ProviderEvent, Token } from "../stt/types.js";
import { Coalescer } from "./coalesce.js";

/** A closed segment stays a translation candidate this long after the NEXT segment closes. */
export const NEXT_CLOSE_WINDOW_MS = 500;

export interface SegmentStoreOptions {
  sessionId: string;
  track: TrackId;
  /** The session's source language ("auto" allowed); used when tokens carry no language. */
  sourceLang: string;
  targetLangs: readonly string[];
  /** Wall time (ms) of the session start: segment times are ms since then. */
  sessionStartWall: number;
  /** Default 3,000 ms. */
  translationGraceMs?: number;
  /** Arrival-timed providers: startMs = first token arrival − this (default 300 ms). */
  arrivalStartOffsetMs?: number;
  /** Segments kept in memory (default 50). */
  maxSegments?: number;
  /** Minimum interval between upserts of one segment (default 100 ms = 10/s). */
  upsertIntervalMs?: number;
  now?: () => number;
  /** Coalesced segment upsert (a copy; not called for hidden segments). */
  onUpsert?: (seg: Segment) => void;
  /** A segment closed (endpoint, reconnect, engine end, clear cut). */
  onClosed?: (seg: Segment, engineId: string) => void;
  /** A segment is done: closed and every translation final. Called once per segment. */
  onDone?: (seg: Segment, engineId: string) => void;
  /** A translation token or text arrived with no segment left to take it. */
  onLateDrop?: (info: { engineId: string; lang: string; text: string }) => void;
}

export interface EngineBinding {
  engineId: string;
  capabilities: ProviderCapabilities;
  /** The engine instance's own timeline (the frames it was sent). */
  timeline: FrameTimeline;
}

/** The engine's open segment, for the long-utterance guard. */
export interface OpenSegmentView {
  seq: number;
  text: string;
  firstTokenAt: number;
}

interface EngineState {
  id: string;
  capabilities: ProviderCapabilities;
  timeline: FrameTimeline;
  /** Provider session index; bumped on `reconnected`. */
  providerSession: number;
  /** Input position where the current provider session's audio starts. */
  audioOffsetMs: number;
  open: Rec | null;
  /** Non-final translation text per language: one global set, shown on the cursor segment. */
  nonFinalTr: Map<string, string>;
  /** Non-final mirrored translation per language, shown on the open segment. */
  mirrorNonFinal: Map<string, string>;
  /** Segment currently showing nonFinalTr[lang], and the text it was shown with. */
  shownOn: Map<string, Rec>;
  shownText: Map<string, string>;
  ended: boolean;
}

interface Rec {
  seg: Segment;
  engine: EngineState;
  providerSession: number;
  finalSrc: string;
  nonFinalSrc: string;
  /** Final translation text per language. */
  trFinal: Map<string, string>;
  /** Arrival time of the last translation token/text attributed, per language. */
  lastTrAt: Map<string, number>;
  trTokens: Map<string, number>;
  trDone: Set<string>;
  closedAt: number | null;
  /** The segment stops being a translation candidate at this wall time. */
  candidateUntil: number;
  hidden: boolean;
  evicted: boolean;
  done: boolean;
  langFromFinal: boolean;
  /** startMs/endMs are fixed (set when the segment closed). */
  timingFrozen: boolean;
  firstReceivedAt: number;
  lastSourceReceivedAt: number;
  lastFinalReceivedAt: number | null;
  /** Input positions (ms of the engine's audio) of the source tokens. */
  finalStartIn: number | null;
  finalEndIn: number | null;
  nonFinalStartIn: number | null;
  nonFinalEndIn: number | null;
}

type TokensEvent = Extract<ProviderEvent, { type: "tokens" }>;

/** Append token text; a segment's text never starts with whitespace. */
function joinText(base: string, add: string): string {
  return base === "" ? add.trimStart() : base + add;
}

function emptyText(): TextState {
  return { text: "", finalLen: 0, final: false };
}

export class SegmentStore {
  private readonly sessionId: string;
  private readonly track: TrackId;
  private readonly sourceLang: string;
  private readonly targetLangs: readonly string[];
  private readonly targetSet: ReadonlySet<string>;
  private readonly defaultTarget: string;
  private readonly sessionStartWall: number;
  private readonly graceMs: number;
  private readonly arrivalStartOffsetMs: number;
  private readonly maxSegments: number;
  private readonly now: () => number;
  private readonly upserts: Coalescer<Rec>;

  private readonly engines = new Map<string, EngineState>();
  private current: string | null = null;
  private recs: Rec[] = [];
  private readonly dirty = new Set<Rec>();
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private timerAt: number | null = null;
  private disposed = false;

  /** Translation tokens/texts dropped because no segment could take them. */
  lateTranslationDropped = 0;
  /** Closed segments with source text. */
  closedCount = 0;

  constructor(private readonly opts: SegmentStoreOptions) {
    this.sessionId = opts.sessionId;
    this.track = opts.track;
    this.sourceLang = opts.sourceLang;
    this.targetLangs = [...opts.targetLangs];
    this.targetSet = new Set(this.targetLangs);
    this.defaultTarget = this.targetLangs[0] ?? "";
    this.sessionStartWall = opts.sessionStartWall;
    this.graceMs = opts.translationGraceMs ?? 3000;
    this.arrivalStartOffsetMs = opts.arrivalStartOffsetMs ?? 300;
    this.maxSegments = Math.max(1, opts.maxSegments ?? 50);
    this.now = opts.now ?? Date.now;
    this.upserts = new Coalescer<Rec>(
      (rec) => {
        if (!rec.hidden && !rec.evicted) this.opts.onUpsert?.(structuredClone(rec.seg));
      },
      { intervalMs: opts.upsertIntervalMs ?? 100, now: this.now },
    );
  }

  // --- engines ---------------------------------------------------------------------------

  /**
   * Register a new engine instance (every engine start; a new timeline each time). Events are
   * routed by engine id; the previous engine keeps its own open segment until `endEngine()`.
   */
  beginEngine(binding: EngineBinding): void {
    if (this.engines.has(binding.engineId)) {
      throw new Error(`engine ${binding.engineId} already registered`);
    }
    this.pruneEngines();
    this.engines.set(binding.engineId, {
      id: binding.engineId,
      capabilities: binding.capabilities,
      timeline: binding.timeline,
      providerSession: 0,
      audioOffsetMs: 0,
      open: null,
      nonFinalTr: new Map(),
      mirrorNonFinal: new Map(),
      shownOn: new Map(),
      shownText: new Map(),
      ended: false,
    });
    this.current = binding.engineId;
  }

  /**
   * The engine stopped: close its open segment (non-final text is dropped) and finalize its
   * pending native translations. Later events from it are ignored.
   */
  endEngine(engineId: string): void {
    const eng = this.engines.get(engineId);
    if (eng === undefined || eng.ended) return;
    if (eng.open !== null) this.closeRec(eng.open);
    eng.ended = true;
    eng.nonFinalTr.clear();
    eng.mirrorNonFinal.clear();
    this.endOp();
  }

  // --- provider path -----------------------------------------------------------------------

  /** Apply one provider event, routed to `engineId` (default: the latest engine). */
  apply(e: ProviderEvent, engineId?: string): void {
    const id = engineId ?? this.current;
    const eng = id === null ? undefined : this.engines.get(id);
    if (eng === undefined || eng.ended || this.disposed) return;
    switch (e.type) {
      case "tokens":
        this.onTokens(eng, e);
        break;
      case "endpoint":
        if (eng.open !== null) this.closeRec(eng.open);
        break;
      case "reconnected":
        this.onReconnected(eng, e.audioOffsetMs);
        break;
      default:
        return;
    }
    this.endOp();
  }

  // --- display -----------------------------------------------------------------------------

  /**
   * Cut every open segment (closed and hidden; later tokens of the same utterance open a
   * new visible segment) and hide every existing segment. Transcripts are unaffected.
   */
  clear(): void {
    for (const eng of this.engines.values()) {
      if (eng.open !== null && !eng.ended) this.closeRec(eng.open, true);
    }
    for (const rec of this.recs) {
      rec.hidden = true;
      this.upserts.cancel(rec);
    }
    this.endOp();
  }

  /** Visible segments, oldest first (copies). */
  snapshot(): Segment[] {
    return this.recs
      .filter((rec) => !rec.hidden && !rec.evicted && !this.isEmptyClosed(rec))
      .map((rec) => structuredClone(rec.seg));
  }

  /** The engine's open segment (for the long-utterance guard), or null. */
  openSegment(engineId: string): OpenSegmentView | null {
    const rec = this.engines.get(engineId)?.open ?? null;
    if (rec === null) return null;
    return {
      seq: rec.seg.seq,
      text: joinText(rec.finalSrc, rec.nonFinalSrc),
      firstTokenAt: rec.seg.timing.firstTokenAt,
    };
  }

  // --- lifecycle ---------------------------------------------------------------------------

  /** Session stop: end every engine and finalize every segment as it stands (all done). */
  finalizeAll(): void {
    for (const eng of this.engines.values()) {
      if (eng.open !== null) this.closeRec(eng.open);
      eng.ended = true;
      eng.nonFinalTr.clear();
      eng.mirrorNonFinal.clear();
    }
    for (const rec of [...this.recs]) {
      if (rec.done) continue;
      if (rec.closedAt === null) this.closeRec(rec);
      for (const lang of this.targetLangs) this.finalizeLang(rec, lang);
      this.checkDone(rec);
    }
    this.endOp();
    this.upserts.flushAll();
  }

  /** Emit pending upserts now. */
  flush(): void {
    this.upserts.flushAll();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.upserts.dispose();
  }

  // --- internals: tokens ---------------------------------------------------------------------

  private onTokens(eng: EngineState, e: TokensEvent): void {
    const at = e.receivedAt;
    // Finals, in order. Source tokens spoken in a target language may be followed by their
    // mirrored translation token (same text and language): it belongs to the same segment.
    const mirrors: Array<{ text: string; lang: string; rec: Rec }> = [];
    for (const t of e.final) {
      if (t.kind === "source") {
        const rec = this.appendFinalSource(eng, t, at);
        if (t.lang !== undefined && this.targetSet.has(t.lang)) {
          mirrors.push({ text: t.text, lang: t.lang, rec });
        }
        continue;
      }
      if (!eng.capabilities.nativeTranslation) continue;
      const lang = t.lang ?? this.defaultTarget;
      if (!this.targetSet.has(lang)) continue;
      const mi = mirrors.findIndex((m) => m.lang === lang && m.text === t.text);
      const mirror = mi >= 0 ? mirrors.splice(mi, 1)[0] : undefined;
      if (mirror !== undefined) this.addTranslation(mirror.rec, lang, t.text, at);
      else this.routeTranslation(eng, lang, t.text, at);
    }

    // Non-finals replace the previous non-final set.
    let hasSource = false;
    let src = "";
    let startIn: number | null = null;
    let endIn: number | null = null;
    let lang: string | undefined;
    const tr = new Map<string, string>();
    const mirrored = new Map<string, string>();
    const mirrorCandidates: Array<{ text: string; lang: string }> = [];
    for (const t of e.nonFinal) {
      if (t.kind === "source") {
        hasSource = true;
        src += t.text;
        if (t.startMs !== undefined && startIn === null) startIn = eng.audioOffsetMs + t.startMs;
        if (t.endMs !== undefined) endIn = eng.audioOffsetMs + t.endMs;
        lang ??= t.lang;
        if (t.lang !== undefined && this.targetSet.has(t.lang)) {
          mirrorCandidates.push({ text: t.text, lang: t.lang });
        }
        continue;
      }
      if (!eng.capabilities.nativeTranslation) continue;
      const trLang = t.lang ?? this.defaultTarget;
      if (!this.targetSet.has(trLang)) continue;
      const mi = mirrorCandidates.findIndex((m) => m.lang === trLang && m.text === t.text);
      if (mi >= 0) {
        mirrorCandidates.splice(mi, 1);
        mirrored.set(trLang, (mirrored.get(trLang) ?? "") + t.text);
      } else {
        tr.set(trLang, (tr.get(trLang) ?? "") + t.text);
      }
    }

    if (hasSource) {
      const rec = this.ensureOpen(eng, at);
      rec.nonFinalSrc = src;
      rec.nonFinalStartIn = startIn;
      rec.nonFinalEndIn = endIn;
      rec.lastSourceReceivedAt = at;
      if (!rec.langFromFinal && lang !== undefined) rec.seg.source.lang = lang;
      this.touch(rec);
    } else if (eng.open !== null && eng.open.nonFinalSrc !== "") {
      eng.open.nonFinalSrc = "";
      eng.open.nonFinalStartIn = null;
      eng.open.nonFinalEndIn = null;
      this.touch(eng.open);
    }

    if (eng.capabilities.nativeTranslation) {
      eng.nonFinalTr = tr;
      const changed = !sameMap(eng.mirrorNonFinal, mirrored);
      eng.mirrorNonFinal = mirrored;
      if (changed && eng.open !== null) this.touch(eng.open);
    }
  }

  private appendFinalSource(eng: EngineState, t: Token, at: number): Rec {
    const rec = this.ensureOpen(eng, at);
    rec.finalSrc = joinText(rec.finalSrc, t.text);
    rec.lastFinalReceivedAt = at;
    rec.lastSourceReceivedAt = at;
    if (t.startMs !== undefined && rec.finalStartIn === null) {
      rec.finalStartIn = eng.audioOffsetMs + t.startMs;
    }
    if (t.endMs !== undefined) rec.finalEndIn = eng.audioOffsetMs + t.endMs;
    if (!rec.langFromFinal && t.lang !== undefined) {
      rec.seg.source.lang = t.lang;
      rec.langFromFinal = true;
    }
    this.touch(rec);
    return rec;
  }

  private routeTranslation(eng: EngineState, lang: string, text: string, at: number): void {
    const rec = this.cursor(eng, lang);
    if (rec === null) {
      this.dropLate(eng.id, lang, text);
      return;
    }
    this.addTranslation(rec, lang, text, at);
  }

  private addTranslation(rec: Rec, lang: string, text: string, at: number): void {
    if (rec.done || rec.trDone.has(lang)) {
      this.dropLate(rec.engine.id, lang, text);
      return;
    }
    rec.trFinal.set(lang, joinText(rec.trFinal.get(lang) ?? "", text));
    rec.trTokens.set(lang, (rec.trTokens.get(lang) ?? 0) + 1);
    rec.lastTrAt.set(lang, at);
    this.touch(rec);
  }

  /** Translation cursor: oldest pending candidate of the engine's current provider session, else open. */
  private cursor(eng: EngineState, lang: string): Rec | null {
    const now = this.now();
    for (const rec of this.recs) {
      if (rec.engine !== eng || rec.providerSession !== eng.providerSession) continue;
      if (rec.done || rec.closedAt === null || rec.trDone.has(lang)) continue;
      if (now >= rec.candidateUntil) continue;
      return rec;
    }
    return eng.open;
  }

  private onReconnected(eng: EngineState, audioOffsetMs: number): void {
    // The previous provider session's open utterance is lost (non-finals are never confirmed);
    // its pending native translations are finalized as they stand by settle().
    if (eng.open !== null) this.closeRec(eng.open);
    eng.providerSession++;
    eng.audioOffsetMs = audioOffsetMs;
    eng.nonFinalTr = new Map();
    eng.mirrorNonFinal = new Map();
  }

  // --- internals: segment lifecycle -----------------------------------------------------------

  private ensureOpen(eng: EngineState, at: number): Rec {
    if (eng.open !== null) return eng.open;
    const seq = ++this.seq;
    const translations: Record<string, TextState> = {};
    for (const lang of this.targetLangs) translations[lang] = emptyText();
    const seg: Segment = {
      id: `${this.sessionId}:${this.track}:${seq}`,
      sessionId: this.sessionId,
      track: this.track,
      seq,
      kind: "speech",
      startMs: null,
      endMs: null,
      source: { lang: this.sourceLang, ...emptyText() },
      translations,
      closed: false,
      timing: { source: eng.capabilities.timing, firstTokenAt: at },
    };
    const rec: Rec = {
      seg,
      engine: eng,
      providerSession: eng.providerSession,
      finalSrc: "",
      nonFinalSrc: "",
      trFinal: new Map(),
      lastTrAt: new Map(),
      trTokens: new Map(),
      trDone: new Set(),
      closedAt: null,
      candidateUntil: Number.POSITIVE_INFINITY,
      hidden: false,
      evicted: false,
      done: false,
      langFromFinal: false,
      timingFrozen: false,
      firstReceivedAt: at,
      lastSourceReceivedAt: at,
      lastFinalReceivedAt: null,
      finalStartIn: null,
      finalEndIn: null,
      nonFinalStartIn: null,
      nonFinalEndIn: null,
    };
    this.recs.push(rec);
    eng.open = rec;
    this.evict();
    return rec;
  }

  /** Close an engine's open segment (every caller passes one: `eng.open` or a still-open rec). */
  private closeRec(rec: Rec, cut = false): void {
    const eng = rec.engine;
    const now = this.now();
    rec.closedAt = now;
    rec.candidateUntil = now + this.graceMs;
    rec.seg.closed = true;
    rec.nonFinalSrc = "";
    rec.nonFinalStartIn = null;
    rec.nonFinalEndIn = null;
    if (eng.open === rec) {
      eng.open = null;
      eng.mirrorNonFinal = new Map();
    }
    if (rec.lastFinalReceivedAt !== null) rec.seg.timing.sourceFinalAt = rec.lastFinalReceivedAt;
    if (cut) rec.seg.meta = { ...(rec.seg.meta ?? {}), cut: true };
    // Older pending segments of this provider session stop being candidates 500 ms later.
    for (const other of this.recs) {
      if (other === rec || other.engine !== eng || other.providerSession !== rec.providerSession) {
        continue;
      }
      if (other.closedAt === null || other.done || other.seg.seq > rec.seg.seq) continue;
      other.candidateUntil = Math.min(other.candidateUntil, now + NEXT_CLOSE_WINDOW_MS);
    }
    const hasSource = rec.finalSrc.trim() !== "";
    if (hasSource) this.closedCount++;
    this.refresh(rec);
    this.touch(rec);
    this.opts.onClosed?.(structuredClone(rec.seg), eng.id);
    // Nothing to translate (empty segment): done at once.
    if (!hasSource && !this.hasTranslationText(rec)) {
      for (const lang of this.targetLangs) this.finalizeLang(rec, lang);
    }
    this.checkDone(rec);
  }

  /** Mark a translation final. */
  private finalizeLang(rec: Rec, lang: string): void {
    if (rec.trDone.has(lang)) return;
    rec.trDone.add(lang);
    const finalText = rec.trFinal.get(lang) ?? "";
    const last = rec.lastTrAt.get(lang);
    if (finalText !== "" && last !== undefined) {
      rec.seg.timing.translationFinalAt = { ...rec.seg.timing.translationFinalAt, [lang]: last };
    }
    if (rec.engine.shownOn.get(lang) === rec) rec.engine.shownOn.delete(lang);
    this.touch(rec);
  }

  private checkDone(rec: Rec): void {
    if (rec.done || rec.closedAt === null) return;
    for (const lang of this.targetLangs) if (!rec.trDone.has(lang)) return;
    this.refresh(rec);
    rec.done = true;
    this.touch(rec);
    this.opts.onDone?.(structuredClone(rec.seg), rec.engine.id);
  }

  /** Native translations: finalize segments that can no longer receive tokens. */
  private settle(): void {
    const now = this.now();
    for (const rec of this.recs) {
      if (rec.done || rec.closedAt === null) continue;
      const eng = rec.engine;
      if (!eng.capabilities.nativeTranslation) continue;
      for (const lang of this.targetLangs) {
        if (rec.trDone.has(lang)) continue;
        const stale =
          eng.ended || rec.providerSession !== eng.providerSession || now >= rec.candidateUntil;
        if (stale) {
          this.finalizeLang(rec, lang);
        } else if (eng.capabilities.translationFinalAtEndpoint && !this.showsNonFinal(rec, lang)) {
          this.finalizeLang(rec, lang);
        }
      }
      this.checkDone(rec);
    }
  }

  /** The segment currently displays the engine's global non-final translation tokens. */
  private showsNonFinal(rec: Rec, lang: string): boolean {
    const nf = rec.engine.nonFinalTr.get(lang) ?? "";
    return nf !== "" && this.cursor(rec.engine, lang) === rec;
  }

  /** Move the global non-final translation sets to their cursor segments. */
  private updateShown(): void {
    for (const eng of this.engines.values()) {
      if (!eng.capabilities.nativeTranslation) continue;
      for (const lang of this.targetLangs) {
        const nf = eng.nonFinalTr.get(lang) ?? "";
        const target = nf === "" || eng.ended ? null : this.cursor(eng, lang);
        const prev = eng.shownOn.get(lang) ?? null;
        if (target === null) eng.shownOn.delete(lang);
        else eng.shownOn.set(lang, target);
        if (prev !== target && prev !== null) this.touch(prev);
        if (target !== null && (prev !== target || eng.shownText.get(lang) !== nf)) {
          this.touch(target);
        }
        eng.shownText.set(lang, nf);
      }
    }
  }

  /** End of every public operation: settle, refresh changed segments, emit, re-arm the timer. */
  private endOp(): void {
    if (this.disposed) return;
    this.updateShown();
    this.settle();
    this.updateShown();
    const changed = [...this.dirty];
    this.dirty.clear();
    for (const rec of changed) {
      this.refresh(rec);
      if (!rec.hidden && !rec.evicted) this.upserts.push(rec);
    }
    this.armTimer();
  }

  private armTimer(): void {
    const now = this.now();
    let next: number | null = null;
    for (const rec of this.recs) {
      if (rec.done || rec.closedAt === null || !rec.engine.capabilities.nativeTranslation) continue;
      if (rec.candidateUntil > now && (next === null || rec.candidateUntil < next)) {
        next = rec.candidateUntil;
      }
    }
    if (next === this.timerAt) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = next;
    if (next === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = null;
        this.endOp();
      },
      Math.max(0, next - now) + 1,
    );
  }

  /** Recompute the public view of a segment (done segments are immutable). */
  private refresh(rec: Rec): void {
    if (rec.done) return;
    const seg = rec.seg;
    const eng = rec.engine;
    const closed = rec.closedAt !== null;
    seg.source = {
      lang: seg.source.lang,
      text: joinText(rec.finalSrc, closed ? "" : rec.nonFinalSrc),
      finalLen: rec.finalSrc.length,
      final: closed,
    };
    for (const lang of this.targetLangs) {
      const finalText = rec.trFinal.get(lang) ?? "";
      const isDone = rec.trDone.has(lang);
      let tail = "";
      if (!isDone) {
        if (eng.shownOn.get(lang) === rec) tail += eng.nonFinalTr.get(lang) ?? "";
        if (eng.open === rec) tail += eng.mirrorNonFinal.get(lang) ?? "";
      }
      seg.translations[lang] = {
        text: joinText(finalText, tail),
        finalLen: finalText.length,
        final: isDone,
      };
    }
    // Times are fixed when the segment closes: the timeline's offset estimate keeps improving
    // with later frames, but a closed segment's times must not move afterwards.
    if (rec.timingFrozen) return;
    if (eng.capabilities.timing === "provider") {
      const startIn = rec.finalStartIn ?? rec.nonFinalStartIn;
      const endIn = closed ? rec.finalEndIn : (rec.nonFinalEndIn ?? rec.finalEndIn);
      seg.startMs = startIn === null ? null : this.sessionMs(eng.timeline.wallAt(startIn));
      seg.endMs = endIn === null ? null : this.sessionMs(eng.timeline.wallAt(endIn));
    } else {
      seg.startMs = this.sessionMs(rec.firstReceivedAt - this.arrivalStartOffsetMs);
      seg.endMs = this.sessionMs(rec.lastFinalReceivedAt ?? rec.lastSourceReceivedAt);
    }
    if (seg.startMs !== null && seg.endMs !== null && seg.endMs < seg.startMs) {
      seg.endMs = seg.startMs;
    }
    if (closed) rec.timingFrozen = true;
  }

  private sessionMs(wall: number): number {
    return Math.max(0, Math.round(wall - this.sessionStartWall));
  }

  private touch(rec: Rec): void {
    this.dirty.add(rec);
  }

  private hasTranslationText(rec: Rec): boolean {
    for (const lang of this.targetLangs) {
      if ((rec.trFinal.get(lang) ?? "") !== "") {
        return true;
      }
    }
    return false;
  }

  private isEmptyClosed(rec: Rec): boolean {
    if (rec.closedAt === null || rec.seg.source.text !== "") return false;
    return Object.values(rec.seg.translations).every((t) => t.text === "");
  }

  private dropLate(engineId: string, lang: string, text: string): void {
    this.lateTranslationDropped++;
    this.opts.onLateDrop?.({ engineId, lang, text });
  }

  /** Keep the last `maxSegments`; an evicted segment is finalized first (transcripts). */
  private evict(): void {
    while (this.recs.length > this.maxSegments) {
      const rec = this.recs[0] as Rec; // length > maxSegments ≥ 1
      if (!rec.done) {
        if (rec.closedAt === null) this.closeRec(rec);
        for (const lang of this.targetLangs) this.finalizeLang(rec, lang);
        this.checkDone(rec);
      }
      // Done now, so no engine shows a non-final translation on it (finalizeLang let go).
      this.recs.shift();
      rec.evicted = true;
      this.dirty.delete(rec);
      this.upserts.cancel(rec);
    }
  }

  /** Forget ended engines that no kept segment refers to (long page sessions). */
  private pruneEngines(): void {
    const used = new Set<EngineState>();
    for (const rec of this.recs) used.add(rec.engine);
    for (const [id, eng] of this.engines) {
      if (eng.ended && !used.has(eng)) this.engines.delete(id);
    }
  }
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
