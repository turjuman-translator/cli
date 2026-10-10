// Session transcripts.
//
// DATA_DIR/transcripts/<YYYY-MM-DD_HHmm>_<sessionId>/   (local time; TZ decides)
//   session.log            human-readable events + latency/cost summary at stop
//   session.jsonl          machine-readable markers {t, type, ...}
//   blocks.jsonl           caption blocks: one complete Block per line; a later line
//                          with the same id supersedes the earlier one (hidden, event end)
//   <track>/segments.jsonl done segments, appended as they finalize
//   <track>/<src>.srt      source text  (rewritten atomically every ~10 segments and at stop)
//   <track>/<to>.srt       translation  (reuses the source timing)
//   <track>/provider.jsonl raw provider messages (transcripts.recordProviderMessages)
//
// The folder is created lazily by `materialize()` (page sessions create it at their first
// engine open, so an idle OBS page leaves no empty folders). Lines written before that are kept
// in memory. File-system errors are logged once and never interrupt captioning.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { writeFileAtomic } from "../paths.js";
import type { Segment, TrackId } from "../shared/protocol.js";
import { TRACK_IDS } from "../shared/protocol.js";
import { segmentsToSrt } from "./srt.js";

/** Rewrite the SRTs after this many done segments. */
export const SRT_EVERY = 10;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `<YYYY-MM-DD_HHmm>_<sessionId>` in local time. */
export function sessionFolderName(startedAt: number, sessionId: string): string {
  const d = new Date(startedAt);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date}_${pad2(d.getHours())}${pad2(d.getMinutes())}_${sessionId}`;
}

/** `YYYY-MM-DD HH:MM:SS.mmm` in local time. */
export function localTimestamp(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${date} ${time}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** Most common detected source language (for from=auto), or null. */
function detectedLang(segments: readonly Segment[]): string | null {
  const counts = new Map<string, number>();
  for (const s of segments) {
    if (s.source.lang === "auto" || s.source.text.trim() === "") continue;
    counts.set(s.source.lang, (counts.get(s.source.lang) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

/** SRT file names for a track: source (`<from>` or the detected language) and target. */
export function srtNames(
  from: string,
  to: string,
  segments: readonly Segment[],
): { source: string; target: string } {
  const src = from !== "auto" ? from : (detectedLang(segments) ?? "source");
  return { source: src === to ? `${src}.source.srt` : `${src}.srt`, target: `${to}.srt` };
}

export interface SessionTranscriptOptions {
  /** paths.transcriptsDir */
  rootDir: string;
  sessionId: string;
  startedAt: number;
  from: string;
  to: string;
  /** transcripts.srt */
  srt: boolean;
  log: Logger;
  now?: () => number;
}

export class SessionTranscript {
  readonly dir: string;
  private isMaterialized = false;
  private failed = false;
  private readonly pendingLog: string[] = [];
  private readonly pendingJsonl: string[] = [];
  private readonly pendingBlocks: string[] = [];
  private readonly tracks = new Map<TrackId, TrackTranscript>();
  private readonly now: () => number;

  constructor(readonly opts: SessionTranscriptOptions) {
    this.dir = join(opts.rootDir, sessionFolderName(opts.startedAt, opts.sessionId));
    this.now = opts.now ?? Date.now;
  }

  get materialized(): boolean {
    return this.isMaterialized;
  }

  /** Create the folder and flush the lines buffered so far. Idempotent. */
  materialize(): boolean {
    if (this.isMaterialized) return true;
    if (this.failed) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.isMaterialized = true;
      if (this.pendingLog.length > 0) {
        appendFileSync(join(this.dir, "session.log"), this.pendingLog.join(""));
      }
      if (this.pendingJsonl.length > 0) {
        appendFileSync(join(this.dir, "session.jsonl"), this.pendingJsonl.join(""));
      }
      if (this.pendingBlocks.length > 0) {
        appendFileSync(join(this.dir, "blocks.jsonl"), this.pendingBlocks.join(""));
      }
      this.pendingLog.length = 0;
      this.pendingJsonl.length = 0;
      this.pendingBlocks.length = 0;
      for (const t of this.tracks.values()) t.materialize();
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** One human-readable line in session.log. */
  logLine(text: string): void {
    const line = `${localTimestamp(this.now())} ${text}\n`;
    if (!this.isMaterialized) {
      if (!this.failed) this.pendingLog.push(line);
      return;
    }
    this.append("session.log", line);
  }

  /** One machine-readable marker in session.jsonl. */
  marker(type: string, data: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({ t: this.now(), type, ...data })}\n`;
    if (!this.isMaterialized) {
      if (!this.failed) this.pendingJsonl.push(line);
      return;
    }
    this.append("session.jsonl", line);
  }

  /** One blocks.jsonl line (a complete Block as JSON, from the block pipeline). */
  appendBlock(json: string): void {
    const line = `${json}\n`;
    if (!this.isMaterialized) {
      if (!this.failed) this.pendingBlocks.push(line);
      return;
    }
    this.append("blocks.jsonl", line);
  }

  /** The per-track writer (`<track>/`). */
  track(id: TrackId): TrackTranscript {
    let t = this.tracks.get(id);
    if (t === undefined) {
      t = new TrackTranscript(this, id);
      this.tracks.set(id, t);
      if (this.isMaterialized) t.materialize();
    }
    return t;
  }

  /** Session stop: final SRTs for every track. */
  finish(): void {
    for (const t of this.tracks.values()) t.writeSrts();
  }

  /** @internal Only once materialized (every caller checks). */
  append(relPath: string, text: string): void {
    try {
      appendFileSync(join(this.dir, relPath), text);
    } catch (err) {
      this.fail(err);
    }
  }

  /** @internal Only once materialized (writeSrts checks). */
  writeAtomic(relPath: string, text: string): void {
    try {
      writeFileAtomic(join(this.dir, relPath), text);
    } catch (err) {
      this.fail(err);
    }
  }

  /** @internal */
  fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.opts.log.error(
      { err, dir: this.dir },
      "transcript write failed; transcripts may be incomplete",
    );
  }
}

export class TrackTranscript {
  readonly dir: string;
  private readonly done: Segment[] = [];
  private readonly pending: string[] = [];
  private sinceSrt = 0;
  private engines = 0;

  constructor(
    private readonly session: SessionTranscript,
    readonly track: TrackId,
  ) {
    this.dir = join(session.dir, track);
  }

  /** @internal */
  materialize(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.session.fail(err);
      return;
    }
    if (this.pending.length > 0) {
      this.session.append(join(this.track, "segments.jsonl"), this.pending.join(""));
      this.pending.length = 0;
    }
  }

  /** A done segment: append to segments.jsonl; rewrite the SRTs every SRT_EVERY segments. */
  addDone(seg: Segment): void {
    const hasText =
      seg.source.text.trim() !== "" ||
      Object.values(seg.translations).some((t) => t.text.trim() !== "");
    if (!hasText) return;
    this.done.push(seg);
    const line = `${JSON.stringify(seg)}\n`;
    if (this.session.materialized) this.session.append(join(this.track, "segments.jsonl"), line);
    else this.pending.push(line);
    if (++this.sinceSrt >= SRT_EVERY) this.writeSrts();
  }

  /** Rewrite `<src>.srt` and `<to>.srt` atomically. */
  writeSrts(): void {
    this.sinceSrt = 0;
    const { from, to, srt } = this.session.opts;
    if (!srt || !this.session.materialized) return;
    const sorted = [...this.done].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    const names = srtNames(from, to, sorted);
    this.session.writeAtomic(join(this.track, names.source), segmentsToSrt(sorted));
    this.session.writeAtomic(join(this.track, names.target), segmentsToSrt(sorted, to));
  }

  /** Where the next engine instance records provider messages (provider.jsonl, provider-2.jsonl…). */
  nextRecordFile(): string {
    this.engines++;
    return join(this.dir, this.engines === 1 ? "provider.jsonl" : `provider-${this.engines}.jsonl`);
  }

  get segments(): number {
    return this.done.length;
  }
}

/**
 * Boot repair: rebuild SRTs that are missing next to a `segments.jsonl` (a crash before
 * the last rewrite). Returns the files written.
 */
export function regenerateMissingSrts(transcriptsDir: string, log: Logger): string[] {
  const written: string[] = [];
  if (!existsSync(transcriptsDir)) return written;
  for (const session of readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    for (const track of TRACK_IDS) {
      const dir = join(transcriptsDir, session.name, track);
      const file = join(dir, "segments.jsonl");
      if (!existsSync(file)) continue;
      try {
        const segments: Segment[] = [];
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (line.trim() === "") continue;
          segments.push(JSON.parse(line) as Segment);
        }
        segments.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
        const from = segments.find((s) => s.source.lang !== "auto")?.source.lang ?? "auto";
        const targets = new Set(segments.flatMap((s) => Object.keys(s.translations)));
        for (const to of targets) {
          const names = srtNames(from, to, segments);
          const src = join(dir, names.source);
          if (!existsSync(src)) {
            writeFileAtomic(src, segmentsToSrt(segments));
            written.push(src);
          }
          const tgt = join(dir, names.target);
          if (!existsSync(tgt)) {
            writeFileAtomic(tgt, segmentsToSrt(segments, to));
            written.push(tgt);
          }
        }
      } catch (err) {
        log.warn({ err, file }, "could not regenerate SRTs from segments.jsonl");
      }
    }
  }
  return written;
}
