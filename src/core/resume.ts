// Resume-after-restart marker for the local (device/file) session.
// Written when a local session goes live, refreshed while live, removed on deliberate stops.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../paths.js";

// Not strict: a marker from an older version also names its engine choice (mode, provider,
// translation); those fields are ignored (the session resumes on Soniox).
const MarkerSchema = z.object({
  sessionId: z.string(),
  startedAt: z.number(),
  lastAliveAt: z.number(),
  resumes: z.number().int().min(0),
  inputKind: z.enum(["device", "network", "file", "page"]),
});

export type ActiveSessionMarker = z.output<typeof MarkerSchema>;

/** Resume at most this many times in a row (a crash loop must not bill forever). */
export const MAX_RESUMES = 3;

function markerFile(stateDir: string): string {
  return join(stateDir, "active-session.json");
}

export function readMarker(stateDir: string): ActiveSessionMarker | null {
  const file = markerFile(stateDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeMarker(stateDir: string, marker: ActiveSessionMarker): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(markerFile(stateDir), `${JSON.stringify(marker, null, 2)}\n`);
}

export function clearMarker(stateDir: string): void {
  rmSync(markerFile(stateDir), { force: true });
}

/**
 * Resume only a recently-alive, live-input session that hasn't already been resumed too often,
 * and never in dev mode (tsx watch restarts on every save).
 */
export function shouldResume(
  marker: ActiveSessionMarker,
  opts: { now: number; windowMin: number; dev: boolean },
): boolean {
  if (opts.dev) return false;
  if (marker.inputKind !== "device" && marker.inputKind !== "network") return false;
  if (marker.resumes >= MAX_RESUMES) return false;
  return opts.now - marker.lastAliveAt < opts.windowMin * 60_000;
}
