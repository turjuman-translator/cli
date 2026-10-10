// provider.jsonl recordings (debug recording; FakeProvider input; fixtures).
// Format: RecordingLine in ./types.ts. Line 1 is `meta`, then {t, kind, …} lines.
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { scrubSecrets } from "../log.js";
import type { RecordingLine } from "./types.js";

export type RecordingMeta = Extract<RecordingLine, { kind: "meta" }>;
export type RecordingEntry = Exclude<RecordingLine, { kind: "meta" }>;

export interface Recording {
  meta: RecordingMeta;
  lines: RecordingEntry[];
}

const num = z.number();

const MetaSchema = z.object({
  kind: z.literal("meta"),
  provider: z.string().min(1),
  version: z.literal(1),
  startedAt: num,
  config: z.unknown().optional(),
});

const EntrySchema = z.discriminatedUnion("kind", [
  z.object({
    t: num,
    kind: z.literal("session"),
    index: z.number().int().min(0),
    audioOffsetMs: num,
    gapMs: num.optional(),
    leg: num.optional(),
  }),
  z.object({
    t: num,
    kind: z.literal("msg"),
    session: num.optional(),
    leg: num.optional(),
    data: z.unknown(),
  }),
  z.object({
    t: num,
    kind: z.literal("close"),
    session: num.optional(),
    leg: num.optional(),
    code: num.optional(),
    reason: z.string().optional(),
  }),
  z.object({ t: num, kind: z.literal("switch"), from: num, to: num }),
]);

function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? `${i.path.map(String).join(".")}: ` : ""}${i.message}`)
    .join("; ");
}

/** Parse provider.jsonl text. Throws on invalid lines; a torn last line (crash) is skipped. */
export function parseRecording(text: string, source = "recording"): Recording {
  const rows = text.split("\n");
  const lastContent = rows.findLastIndex((r) => r.trim() !== "");
  const tornTail = !text.endsWith("\n");
  let meta: RecordingMeta | null = null;
  const lines: RecordingEntry[] = [];
  for (const [i, row] of rows.entries()) {
    const s = row.trim();
    if (s === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(s);
    } catch {
      if (i === lastContent && tornTail && meta !== null) break;
      throw new Error(`${source}:${i + 1}: invalid JSON`);
    }
    if (meta === null) {
      const m = MetaSchema.safeParse(raw);
      if (!m.success)
        throw new Error(`${source}:${i + 1}: first line must be meta (${issues(m.error)})`);
      meta = m.data;
      continue;
    }
    const e = EntrySchema.safeParse(raw);
    if (!e.success) throw new Error(`${source}:${i + 1}: ${issues(e.error)}`);
    lines.push(e.data);
  }
  if (meta === null) throw new Error(`${source}: empty recording (no meta line)`);
  return { meta, lines };
}

/** Read and validate a provider.jsonl file. */
export function readRecording(path: string): Recording {
  return parseRecording(readFileSync(path, "utf8"), path);
}

/** Only the meta line (cheap enough for constructors). */
export function readRecordingMeta(path: string): RecordingMeta {
  return readRecording(path).meta;
}

export interface RecordingWriterOptions {
  /** Append to an existing recording instead of starting a new one (no meta line written). */
  append?: boolean;
  /** Literal secrets scrubbed from every line (defence in depth; callers redact too). */
  secrets?: readonly string[];
  /** Called once on the first write error; later writes are dropped. */
  onError?: (err: Error) => void;
}

/**
 * Append-only JSONL writer for provider recordings (generic; Soniox writes them). Writes the
 * meta line on creation; `write` never throws; `close` flushes and is idempotent.
 */
export class RecordingWriter {
  readonly path: string;
  private readonly stream: WriteStream;
  private readonly secrets: readonly string[];
  private failed = false;
  private closing: Promise<void> | null = null;

  constructor(path: string, meta: RecordingMeta, opts: RecordingWriterOptions = {}) {
    this.path = path;
    this.secrets = opts.secrets ?? [];
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: opts.append === true ? "a" : "w" });
    // A stream emits 'error' at most once (it is destroyed with it), so onError runs once.
    this.stream.on("error", (err: Error) => {
      this.failed = true;
      opts.onError?.(err);
    });
    if (opts.append !== true) this.writeLine(meta);
  }

  write(line: RecordingEntry): void {
    this.writeLine(line);
  }

  close(): Promise<void> {
    if (this.closing === null) {
      this.closing = new Promise<void>((resolve) => {
        if (this.stream.destroyed) {
          resolve();
          return;
        }
        this.stream.end(() => resolve());
        this.stream.once("error", () => resolve());
      });
    }
    return this.closing;
  }

  private writeLine(line: RecordingLine): void {
    if (this.failed || this.closing !== null) return;
    let json: string;
    try {
      json = JSON.stringify(line);
    } catch {
      return;
    }
    this.stream.write(`${scrubSecrets(json, this.secrets)}\n`);
  }
}
