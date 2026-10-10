// SRT export: "HH:MM:SS,mmm --> HH:MM:SS,mmm", sequential numbering, entries
// with empty text or missing times skipped, translations reuse their source segment's timing,
// RTL text left untouched (no direction marks are added).

import type { Segment } from "../shared/protocol.js";

export interface SrtEntry {
  startMs: number | null;
  endMs: number | null;
  text: string;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function formatSrtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(t % 1000, 3)}`;
}

/** A blank line ends an SRT block, so caption text never contains one. */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/\n\s*\n+/g, "\n");
}

export function toSrt(entries: Iterable<SrtEntry>): string {
  const blocks: string[] = [];
  for (const e of entries) {
    const text = cleanText(e.text);
    if (text === "" || e.startMs === null || e.endMs === null) continue;
    const start = Math.max(0, e.startMs);
    const end = Math.max(start, e.endMs);
    blocks.push(
      `${blocks.length + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`,
    );
  }
  return blocks.join("\n");
}

/** Source text (`lang` omitted) or the `lang` translation of each segment, as SRT. */
export function segmentsToSrt(segments: Iterable<Segment>, lang?: string): string {
  const entries: SrtEntry[] = [];
  for (const seg of segments) {
    const text = lang === undefined ? seg.source.text : (seg.translations[lang]?.text ?? "");
    entries.push({ startMs: seg.startMs, endMs: seg.endMs, text });
  }
  return toSrt(entries);
}
