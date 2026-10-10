// Streamed-minutes accounting per access key, engine and day.
// One file per month: <DATA_DIR>/usage/usage-YYYY-MM.json, flushed atomically every 30 s and on
// close(). Days are local-time calendar days. Sessions without a key count under "local"; hosted
// sessions under their organisation ("org:<orgId>").
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../paths.js";
import type { TrackId } from "../shared/protocol.js";

/** The keyId used for sessions that have no access key (exposure local, device/file sessions). */
export const LOCAL_KEY_ID = "local";

/**
 * Hosted mode: page sessions count under their organisation instead of an
 * access key, as "org:<orgId>" (minutes per organisation per day, in the same files).
 */
export function orgUsageKey(orgId: string): string {
  return `org:${orgId}`;
}

const EngineMs = z.record(z.string(), z.number().min(0));
const UsageFileSchema = z.object({
  version: z.literal(1),
  month: z.string(),
  /** day (YYYY-MM-DD) → keyId → engine → streamed ms */
  days: z.record(z.string(), z.record(z.string(), EngineMs)),
});
type UsageFile = z.output<typeof UsageFileSchema>;

export interface UsageRow {
  keyId: string;
  engine: string;
  /** Streamed minutes on the given day (`today` in report(); 0 for past months). */
  todayMinutes: number;
  monthMinutes: number;
}

export interface UsageReport {
  month: string;
  today: string;
  rows: UsageRow[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-time YYYY-MM-DD. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time YYYY-MM. */
export function monthKey(t: number): string {
  return dayKey(t).slice(0, 7);
}

export interface UsageStoreOptions {
  dir: string;
  flushIntervalMs?: number;
  now?: () => number;
  /** Called when a flush fails (e.g. a read-only data dir); the data stays in memory. */
  onError?: (err: unknown) => void;
}

export class UsageStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private data: UsageFile;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: UsageStoreOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
    this.data = this.read(monthKey(this.now()));
    const interval = opts.flushIntervalMs ?? 30_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.flush(), interval);
      this.timer.unref();
    }
  }

  private fileFor(month: string): string {
    return join(this.dir, `usage-${month}.json`);
  }

  private read(month: string): UsageFile {
    const file = this.fileFor(month);
    if (!existsSync(file)) return { version: 1, month, days: {} };
    try {
      const parsed = UsageFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success && parsed.data.month === month) return parsed.data;
      this.onError(new Error(`Ignoring unreadable usage file ${file}`));
    } catch (err) {
      this.onError(err);
    }
    return { version: 1, month, days: {} };
  }

  /** Switch to a new month file when the calendar month changed. */
  private current(): UsageFile {
    const month = monthKey(this.now());
    if (this.data.month !== month) {
      this.flush();
      this.data = this.read(month);
    }
    return this.data;
  }

  /** Add streamed time (ms) for a key (or LOCAL_KEY_ID) and engine. */
  add(keyId: string | null, engine: TrackId, ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    const data = this.current();
    const day = dayKey(this.now());
    const id = keyId ?? LOCAL_KEY_ID;
    const byKey = data.days[day] ?? {};
    const byEngine = byKey[id] ?? {};
    byEngine[engine] = (byEngine[engine] ?? 0) + ms;
    byKey[id] = byEngine;
    data.days[day] = byKey;
    this.dirty = true;
  }

  /** Streamed minutes today for a key, all engines together. */
  minutesToday(keyId: string | null): number {
    const data = this.current();
    const byEngine = data.days[dayKey(this.now())]?.[keyId ?? LOCAL_KEY_ID];
    if (byEngine === undefined) return 0;
    let ms = 0;
    for (const v of Object.values(byEngine)) ms += v;
    return ms / 60_000;
  }

  /** Minutes per key and engine for a month (default: this month) plus today's share. */
  report(opts: { month?: string } = {}): UsageReport {
    const thisMonth = monthKey(this.now());
    const month = opts.month ?? thisMonth;
    const data = month === this.current().month ? this.data : this.read(month);
    const today = dayKey(this.now());
    const rows = new Map<string, UsageRow>();
    for (const [day, byKey] of Object.entries(data.days)) {
      for (const [keyId, byEngine] of Object.entries(byKey)) {
        for (const [engine, ms] of Object.entries(byEngine)) {
          const id = `${keyId}\u0000${engine}`;
          const row = rows.get(id) ?? { keyId, engine, todayMinutes: 0, monthMinutes: 0 };
          row.monthMinutes += ms / 60_000;
          if (day === today) row.todayMinutes += ms / 60_000;
          rows.set(id, row);
        }
      }
    }
    const sorted = [...rows.values()].sort(
      (a, b) => a.keyId.localeCompare(b.keyId) || a.engine.localeCompare(b.engine),
    );
    return { month, today, rows: sorted };
  }

  /** Months that have a usage file, oldest first. */
  months(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((f) => /^usage-(\d{4}-\d{2})\.json$/.exec(f)?.[1])
      .filter((m): m is string => m !== undefined)
      .sort();
  }

  /** Write the current month atomically if anything changed. */
  flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(this.fileFor(this.data.month), `${JSON.stringify(this.data, null, 2)}\n`);
      this.dirty = false;
    } catch (err) {
      this.onError(err);
    }
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
