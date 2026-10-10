// Test doubles for src/compose/fast-blocks.ts: segments as the session builds them, a scriptable
// Quran follower and event detector, a log whose messages can be read, and a pipeline harness
// that records everything FastBlocks emits and persists. Use with vi.useFakeTimers(): the
// pipeline's clock is Date.now, so advancing the timers moves its time and runs its ticker.
import type { Logger } from "pino";
import { FastBlocks, type FastBlocksOptions } from "../../../src/compose/fast-blocks.js";
import type {
  EventLabels,
  FollowerResult,
  FollowerVerse,
  PipelineOutput,
  QuranFollowerApi,
} from "../../../src/compose/types.js";
import type {
  DetectorAction,
  DetectorSegment,
  EventDetectorApi,
} from "../../../src/events/types.js";
import type { Block, PrayerEvent, Segment, SessionMode } from "../../../src/shared/protocol.js";
import { arabicWords } from "../../../src/text/arabic.js";

export const LABELS: EventLabels = {
  athan: { ar: "الأذان", title: "Athan", subtitle: "Oproep tot het gebed" },
  iqama: { ar: "الإقامة", title: "Iqama", subtitle: "Het gebed begint" },
  salah: { ar: "الصلاة", title: "Gebed", subtitle: "" },
};

export interface SegOptions {
  closed?: boolean;
  startMs?: number | null;
  endMs?: number | null;
  /** Final characters of the source (default: all). */
  srcFinal?: number;
  /** Final characters of the translation (default: all). */
  trFinal?: number;
  /** Translation language (default "nl"); null = the segment has no translation. */
  lang?: string | null;
}

/** A segment update as the session sends it: source and translation text so far. */
export function seg(id: string, src: string, tr: string, o: SegOptions = {}): Segment {
  const closed = o.closed ?? false;
  const lang = o.lang === undefined ? "nl" : o.lang;
  return {
    id,
    sessionId: "s",
    track: "soniox",
    seq: Number(id.split(":").pop() ?? 0),
    kind: "speech",
    startMs: o.startMs === undefined ? 0 : o.startMs,
    endMs: o.endMs === undefined ? 0 : o.endMs,
    source: { lang: "ar", text: src, finalLen: o.srcFinal ?? src.length, final: closed },
    translations:
      lang === null
        ? {}
        : { [lang]: { text: tr, finalLen: o.trFinal ?? tr.length, final: closed } },
    closed,
    timing: { source: "provider", firstTokenAt: 0 },
  };
}

// --- log ---------------------------------------------------------------------------------------

export interface CaptureLog {
  logger: Logger;
  messages(level: "debug" | "info" | "warn" | "error"): string[];
  entries: Array<{ level: string; msg: string; obj: Record<string, unknown> }>;
}

export function captureLog(): CaptureLog {
  const entries: CaptureLog["entries"] = [];
  const at =
    (level: string) =>
    (objOrMsg: unknown, msg?: string): void => {
      entries.push({
        level,
        msg: typeof objOrMsg === "string" ? objOrMsg : (msg ?? ""),
        obj:
          typeof objOrMsg === "object" && objOrMsg !== null
            ? (objOrMsg as Record<string, unknown>)
            : {},
      });
    };
  const logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return {
    logger: logger as unknown as Logger,
    entries,
    messages: (level) => entries.filter((e) => e.level === level).map((e) => e.msg),
  };
}

// --- follower ----------------------------------------------------------------------------------

export interface FollowerScript {
  /** After a push that took the stream from `from` to `count` words: what to report. */
  push?(count: number, from: number, text: string): Partial<FollowerResult>;
  flush?(count: number, at: number): Partial<FollowerResult>;
}

/** Counts words like the real follower; decides everything at once unless the script says. */
export function scriptedFollower(script: FollowerScript = {}): QuranFollowerApi & {
  count(): number;
  flushes: number[];
} {
  let count = 0;
  const flushes: number[] = [];
  return {
    ready: true,
    push(text: string) {
      const from = count;
      const added = arabicWords(text).length;
      count += added;
      const r = script.push?.(count, from, text) ?? {};
      return { added, decidedTo: r.decidedTo ?? count, verses: r.verses ?? [] };
    },
    flush(at: number) {
      flushes.push(at);
      const r = script.flush?.(count, at) ?? {};
      return { decidedTo: r.decidedTo ?? count, verses: r.verses ?? [] };
    },
    reset() {
      count = 0;
    },
    count: () => count,
    flushes,
  };
}

export function verse(over: Partial<FollowerVerse> & { ref: string }): FollowerVerse {
  return {
    from: 0,
    to: 1,
    complete: true,
    approved: null,
    uthmani: null,
    isNew: true,
    ...over,
  };
}

// --- detector ----------------------------------------------------------------------------------

export interface ScriptedDetector extends EventDetectorApi {
  mode: SessionMode;
  salah: boolean;
  segments: DetectorSegment[];
  /** Actions for the next tick() calls, in order. */
  tickQueue: DetectorAction[][];
  ticks: number[];
  onSegmentFn: (s: DetectorSegment) => DetectorAction[];
  overrideFn: (event: PrayerEvent | "none", now: number) => DetectorAction[];
  formula: RegExp;
}

/** A detector that passes every segment unless a test scripts otherwise. */
export function scriptedDetector(): ScriptedDetector {
  const d: ScriptedDetector = {
    mode: "speech",
    salah: false,
    segments: [],
    tickQueue: [],
    ticks: [],
    onSegmentFn: (s) => [{ type: "pass", segment: s }],
    overrideFn: () => [],
    formula: /^\s*(الله أكبر|حي على|أشهد أن)[\s؀-ۿ]*$/,
    onSegment(s) {
      d.segments.push(s);
      return d.onSegmentFn(s);
    },
    tick(now) {
      d.ticks.push(now);
      return d.tickQueue.shift() ?? [];
    },
    override(event, now) {
      return d.overrideFn(event, now);
    },
    isFormulaOnly(text) {
      return d.formula.test(text);
    },
    markers: () => [],
  };
  return d;
}

// --- pipeline ----------------------------------------------------------------------------------

export interface Pipeline {
  fb: FastBlocks;
  out: PipelineOutput[];
  persisted: Block[];
  log: CaptureLog;
  /** The current snapshot (every block, hidden ones too). */
  blocks(): Block[];
  /** Texts of the visible non-event blocks, in order. */
  shown(): string[];
  /** block.add / block.update messages for one block id. */
  history(id: string): PipelineOutput[];
}

export function pipeline(
  over: Partial<FastBlocksOptions> & { persistThrows?: boolean } = {},
): Pipeline {
  const out: PipelineOutput[] = [];
  const persisted: Block[] = [];
  const log = captureLog();
  const { persistThrows, ...opts } = over;
  const fb = new FastBlocks({
    sessionId: "s",
    targetLang: "nl",
    follower: scriptedFollower(),
    detector: null,
    labels: LABELS,
    now: () => Date.now(),
    log: log.logger,
    persist: (line) => {
      if (persistThrows === true) throw new Error("disk full");
      persisted.push(JSON.parse(line) as Block);
    },
    emit: (o) => out.push(o),
    ...opts,
  });
  const blocks = (): Block[] => fb.blocks({ limit: 500 }).blocks;
  return {
    fb,
    out,
    persisted,
    log,
    blocks,
    shown: () =>
      blocks()
        .filter((b) => b.kind !== "event" && b.hidden !== true)
        .map((b) => b.text),
    history: (id) =>
      out.filter((o) => (o.type === "block.add" || o.type === "block.update") && o.block.id === id),
  };
}

/** Every update of a block only appends to its text (Quran: its closing quote may move). */
export function appendOnly(out: readonly PipelineOutput[]): boolean {
  const last = new Map<string, string>();
  for (const o of out) {
    if (o.type !== "block.add" && o.type !== "block.update") continue;
    const prev = last.get(o.block.id);
    if (prev !== undefined && o.block.kind !== "event" && !o.block.text.startsWith(prev)) {
      if (!(o.block.kind === "quran" && o.block.text.startsWith(prev.replace(/"$/, "")))) {
        return false;
      }
    }
    last.set(o.block.id, o.block.text);
  }
  return true;
}
