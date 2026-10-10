import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { LoadedConfig } from "../config.js";
import type { CliIo } from "./index.js";

interface Marker {
  t?: number;
  type?: string;
  [key: string]: unknown;
}

export interface SessionRecord {
  folder: string;
  id: string;
  startedAt: number | null;
  kind: string;
  pair: string;
  engines: string;
  durationMs: number | null;
  reason: string | null;
  segments: number;
}

function readMarkers(file: string): Marker[] {
  if (!existsSync(file)) return [];
  const out: Marker[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Marker);
    } catch {
      // skip a torn last line (crash)
    }
  }
  return out;
}

function countSegments(folder: string): number {
  let n = 0;
  for (const entry of readdirSync(folder)) {
    const file = join(folder, entry, "segments.jsonl");
    if (existsSync(file))
      n += readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "").length;
  }
  return n;
}

/** The minute in a folder name `<YYYY-MM-DD_HHmm>_<id>` (local time), or 0. */
function folderTime(name: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/.exec(name);
  if (m === null) return 0;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/**
 * Recent sessions from DATA_DIR/transcripts/<YYYY-MM-DD_HHmm>_<id>/session.jsonl, newest first:
 * by the start marker's time (the folder name has only the minute, and a random id after it).
 */
export function listSessions(transcriptsDir: string, limit = 20): SessionRecord[] {
  if (!existsSync(transcriptsDir)) return [];
  const sessions = readdirSync(transcriptsDir)
    .filter((name) => statSync(join(transcriptsDir, name)).isDirectory())
    .map((name) => {
      const markers = readMarkers(join(transcriptsDir, name, "session.jsonl"));
      const start = markers.find((m) => m.type === "start");
      const startedAt = typeof start?.t === "number" ? start.t : null;
      return { name, markers, start, startedAt, sortAt: startedAt ?? folderTime(name) };
    })
    .sort((a, b) => b.sortAt - a.sortAt || b.name.localeCompare(a.name))
    .slice(0, limit);
  return sessions.map(({ name, markers, start, startedAt }) => {
    const folder = join(transcriptsDir, name);
    const stop = [...markers].reverse().find((m) => m.type === "stop");
    const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
    return {
      folder,
      id: name.split("_").slice(2).join("_") || name,
      startedAt,
      kind: str(start?.kind, "?"),
      pair: `${str(start?.from, "?")}→${str(start?.to, "?")}`,
      engines: str(start?.engines, "?"),
      durationMs: typeof stop?.durationMs === "number" ? stop.durationMs : null,
      reason: typeof stop?.reason === "string" ? stop.reason : null,
      segments: countSegments(folder),
    };
  });
}

function duration(ms: number | null): string {
  if (ms === null) return "running?";
  const s = Math.round(ms / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** `turjuman sessions [--limit n]`: recent sessions with duration, engines and outcome. */
export function sessionsCommand(args: string[], io: CliIo, loaded: LoadedConfig): number {
  // A wrong option throws: exit 2 with the usage (index.ts).
  const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
  const limit = Number.parseInt(values.limit ?? "20", 10) || 20;
  const list = listSessions(loaded.paths.transcriptsDir, limit);
  if (list.length === 0) {
    io.out(`No sessions yet in ${loaded.paths.transcriptsDir}`);
    return 0;
  }
  for (const s of list) {
    const when = s.startedAt === null ? "?" : new Date(s.startedAt).toLocaleString();
    io.out(
      `${s.id.padEnd(10)} ${when.padEnd(22)} ${s.kind.padEnd(6)} ${s.pair.padEnd(8)} ${s.engines.padEnd(24)} ${duration(s.durationMs).padStart(8)}  ${String(s.segments).padStart(4)} seg  ${s.reason ?? ""}`,
    );
  }
  io.out(`Folders: ${loaded.paths.transcriptsDir}`);
  return 0;
}
