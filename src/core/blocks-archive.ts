// Archived caption blocks + exports.
//
// Ended sessions are read back from DATA_DIR/transcripts/<YYYY-MM-DD_HHmm>_<sessionId>/blocks.jsonl:
// every line that carries a block (`{type:"block.add"|"block.update", block}`, `{op, block}`, a
// bare Block, or a `blocks.snapshot`) is replayed as an upsert by block id, so the result is each
// block's final state, ordered by seq. Unreadable lines (e.g. a torn last line) are skipped.
// session.jsonl `start` / `stop` markers give the pair and the start/end times.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Block } from "../shared/protocol.js";
import { toSrt } from "./srt.js";

/** Session ids are short base32 strings; anything else never touches the file system. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PAGE = 200;
const CACHE_SIZE = 8;

const EventLabel = z.object({ ar: z.string(), title: z.string(), subtitle: z.string() });
const BlockSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int(),
  // Older archives (the removed caption composer) may hold "hadith" blocks: read as speech.
  kind: z
    .enum(["speech", "quran", "hadith", "dua", "event"])
    .transform((kind) => (kind === "hadith" ? "speech" : kind)),
  text: z.string().default(""),
  ref: z.string().nullable().default(null),
  src: z.string().nullable().default(null),
  quranText: z.string().nullable().optional(),
  event: z
    .object({
      type: z.enum(["athan", "iqama", "salah"]),
      active: z.boolean(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      label: EventLabel.optional(),
    })
    .optional(),
  lang: z.string().default(""),
  segmentIds: z.array(z.string()).default([]),
  createdAt: z.number().default(0),
  startMs: z.number().nullable().optional(),
  endMs: z.number().nullable().optional(),
  hidden: z.boolean().optional(),
});

export interface ArchivedSession {
  sessionId: string;
  dir: string;
  /** Final state of every block, ordered by seq (hidden ones included, flagged). */
  blocks: Block[];
  startedAt: number | null;
  endedAt: number | null;
  from: string | null;
  to: string | null;
  kind: string | null;
  /** The organisation; null in sessions from before organisations existed ("local"). */
  orgId: string | null;
  /** Lines that could not be read (torn writes, foreign content). */
  skippedLines: number;
}

export interface BlockPage {
  blocks: Block[];
  hasMore: boolean;
}

/** The newest `limit` blocks with seq < `before` (all when `before` is undefined). */
export function pageBlocks(
  blocks: readonly Block[],
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): BlockPage {
  const limit = Math.max(1, Math.min(MAX_PAGE, opts.limit ?? 100));
  const before = opts.before;
  const eligible = before === undefined ? blocks : blocks.filter((b) => b.seq < before);
  const start = Math.max(0, eligible.length - limit);
  return { blocks: eligible.slice(start), hasMore: start > 0 };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The block(s) a blocks.jsonl line carries, whatever wrapper the writer used. */
function blocksOfLine(line: Record<string, unknown>): unknown[] {
  if (Array.isArray(line.blocks)) return line.blocks;
  if (asRecord(line.block) !== null) return [line.block];
  if (typeof line.id === "string" && typeof line.seq === "number") return [line];
  return [];
}

/** Replay blocks.jsonl text into final block states (upsert by id), ordered by seq. */
export function replayBlocks(text: string): {
  blocks: Block[];
  endedAt: number | null;
  skipped: number;
} {
  const byId = new Map<string, Block>();
  let endedAt: number | null = null;
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let line: Record<string, unknown> | null;
    try {
      line = asRecord(JSON.parse(trimmed));
    } catch {
      line = null;
    }
    if (line === null) {
      skipped++;
      continue;
    }
    if (line.type === "session.ended" && typeof line.endedAt === "number") {
      endedAt = line.endedAt;
      continue;
    }
    const carried = blocksOfLine(line);
    if (carried.length === 0) {
      skipped++;
      continue;
    }
    for (const candidate of carried) {
      const parsed = BlockSchema.safeParse(candidate);
      if (parsed.success) byId.set(parsed.data.id, parsed.data);
      else skipped++;
    }
  }
  const blocks = [...byId.values()].sort((a, b) => a.seq - b.seq);
  return { blocks, endedAt, skipped };
}

interface SessionMeta {
  startedAt: number | null;
  endedAt: number | null;
  from: string | null;
  to: string | null;
  kind: string | null;
  orgId: string | null;
}

function readSessionMeta(dir: string): SessionMeta {
  const meta: SessionMeta = {
    startedAt: null,
    endedAt: null,
    from: null,
    to: null,
    kind: null,
    orgId: null,
  };
  const file = join(dir, "session.jsonl");
  if (!existsSync(file)) return meta;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return meta;
  }
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: Record<string, unknown> | null;
    try {
      line = asRecord(JSON.parse(raw));
    } catch {
      continue;
    }
    if (line === null) continue;
    const t = typeof line.t === "number" ? line.t : null;
    if (line.type === "start") {
      meta.startedAt = t;
      if (typeof line.from === "string") meta.from = line.from;
      if (typeof line.to === "string") meta.to = line.to;
      if (typeof line.kind === "string") meta.kind = line.kind;
      if (typeof line.orgId === "string") meta.orgId = line.orgId;
    } else if (line.type === "stop") {
      meta.endedAt = t;
    }
  }
  return meta;
}

/** Reads ended sessions' blocks from the transcripts folder (small mtime-keyed cache). */
export class BlocksArchive {
  private readonly cache = new Map<string, { stamp: string; session: ArchivedSession }>();

  constructor(readonly transcriptsDir: string) {}

  /** The session's transcript folder (`*_<id>`), newest first if several match; null if none. */
  findDir(sessionId: string): string | null {
    if (!SESSION_ID.test(sessionId) || !existsSync(this.transcriptsDir)) return null;
    let names: string[];
    try {
      names = readdirSync(this.transcriptsDir);
    } catch {
      return null;
    }
    const match = names
      .filter((n) => n.endsWith(`_${sessionId}`))
      .sort()
      .pop();
    return match === undefined ? null : join(this.transcriptsDir, match);
  }

  /** blocks.jsonl of a session folder (root first, then track subfolders), or null. */
  private blocksFile(dir: string): string | null {
    const root = join(dir, "blocks.jsonl");
    if (existsSync(root)) return root;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = join(dir, entry.name, "blocks.jsonl");
        if (existsSync(nested)) return nested;
      }
    } catch {
      // unreadable folder: no blocks
    }
    return null;
  }

  /** The archived session, or null when it has no transcript folder with blocks. */
  get(sessionId: string): ArchivedSession | null {
    const dir = this.findDir(sessionId);
    if (dir === null) return null;
    const file = this.blocksFile(dir);
    if (file === null) return null;
    let stamp: string;
    try {
      const st = statSync(file);
      stamp = `${file}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
    const hit = this.cache.get(sessionId);
    if (hit !== undefined && hit.stamp === stamp) return hit.session;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const replayed = replayBlocks(text);
    const meta = readSessionMeta(dir);
    const session: ArchivedSession = {
      sessionId,
      dir,
      blocks: replayed.blocks,
      startedAt: meta.startedAt,
      endedAt: replayed.endedAt ?? meta.endedAt,
      from: meta.from,
      to: meta.to,
      kind: meta.kind,
      orgId: meta.orgId,
      skippedLines: replayed.skipped,
    };
    this.cache.delete(sessionId);
    this.cache.set(sessionId, { stamp, session });
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value as string; // size > CACHE_SIZE ≥ 1
      this.cache.delete(oldest);
    }
    return session;
  }
}

// --- exports -------------------------------------------------------------------------------

export type ExportFormat = "txt" | "md" | "srt";

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local HH:MM. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local YYYY-MM-DD HH:MM. */
function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(ms)}`;
}

/** "2:285-286" → "2:285–286", as the captions show a range. */
function displayRef(ref: string): string {
  return ref.replace(/(\d)-(\d)/g, "$1–$2");
}

const EVENT_TITLES = { athan: "Athan", iqama: "Iqama", salah: "Salah" } as const;

/** "Athan · 13:02" (label title in the target language when the block carries one). */
export function eventLine(block: Block): string {
  const ev = block.event;
  if (ev === undefined) return "Event";
  const title =
    ev.label?.title !== undefined && ev.label.title !== "" ? ev.label.title : EVENT_TITLES[ev.type];
  return `${title} · ${clock(ev.startedAt)}`;
}

/** The text a reader sees: Quran blocks quoted with their reference. */
function blockText(block: Block): string {
  const text = block.text.trim();
  if (block.kind !== "quran") return text;
  const quoted = /^["“«„]/.test(text) ? text : `"${text}"`;
  return block.ref === null ? quoted : `${quoted} (${displayRef(block.ref)})`;
}

function visible(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => b.hidden !== true);
}

export function blocksToTxt(blocks: readonly Block[]): string {
  const lines = visible(blocks)
    .map((b) => (b.kind === "event" ? `[${eventLine(b)}]` : blockText(b)))
    .filter((l) => l !== "");
  return lines.length === 0 ? "" : `${lines.join("\n\n")}\n`;
}

export interface ExportMeta {
  sessionId: string;
  from: string | null;
  to: string | null;
  startedAt: number | null;
}

export function blocksToMarkdown(blocks: readonly Block[], meta: ExportMeta): string {
  const pair = meta.from !== null && meta.to !== null ? ` · ${meta.from} → ${meta.to}` : "";
  const when = meta.startedAt !== null ? ` · ${dateTime(meta.startedAt)}` : "";
  const out = [`# Captions${pair}${when}`, "", `Session \`${meta.sessionId}\``, ""];
  for (const b of visible(blocks)) {
    if (b.kind === "event") {
      const end = b.event?.endedAt !== undefined ? `–${clock(b.event.endedAt)}` : "";
      out.push(`- **event**: ${eventLine(b)}${end}`);
      continue;
    }
    const text = blockText(b);
    if (text !== "") out.push(`- **${b.kind}**: ${text.replace(/\n+/g, " ")}`);
  }
  return `${out.join("\n")}\n`;
}

export function blocksToSrt(blocks: readonly Block[]): string {
  return toSrt(
    visible(blocks)
      .filter((b) => b.kind !== "event")
      .map((b) => ({ startMs: b.startMs ?? null, endMs: b.endMs ?? null, text: blockText(b) })),
  );
}

export function renderExport(
  format: ExportFormat,
  blocks: readonly Block[],
  meta: ExportMeta,
): string {
  if (format === "txt") return blocksToTxt(blocks);
  if (format === "md") return blocksToMarkdown(blocks, meta);
  return blocksToSrt(blocks);
}

/** Download name: captions_<YYYY-MM-DD>_<id>.<ext> (date omitted when unknown). */
export function exportFileName(meta: ExportMeta, format: ExportFormat): string {
  const date = meta.startedAt === null ? "" : `${dateTime(meta.startedAt).slice(0, 10)}_`;
  const safeId = meta.sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return `captions_${date}${safeId}.${format}`;
}
