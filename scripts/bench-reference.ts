// Benchmark the caption blocks against a reference captioning of the same audio.
// WAV → the page's VadGate → /ws/page (blocks layout) → our blocks, timed on arrival; then the
// final blocks are scored against a reference list of {arabic, translation:{<to>}} segments
// (for example the bayaan.ai front-page demo, kept outside the repo):
//   * blocks: count, tiny blocks (< 4 words), words per block;
//   * delay: time from the end of the newest spoken word in a block to that text on screen;
//   * wording: chrF (character n-gram F-score) of our text per reference segment;
//   * Quran refs and honorific glyphs found vs the reference.
// Usage: pnpm exec tsx scripts/bench-reference.ts --wav <abs.wav> --ref <reference.json>
//          [--port 8765] [--to nl] [--tail-sec 12] [--out bench/reference] [--replay <events.json>]
// --replay re-scores a saved run without streaming (no cost). A live run costs money (Soniox).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Block, PageServerMessage, VadParams } from "../src/shared/protocol.js";
import { VadGate } from "../web/shared/vad-gate.js";

const { values } = parseArgs({
  options: {
    wav: { type: "string" },
    ref: { type: "string" },
    port: { type: "string", default: "8765" },
    from: { type: "string", default: "ar" },
    to: { type: "string", default: "nl" },
    key: { type: "string" },
    "tail-sec": { type: "string", default: "12" },
    out: { type: "string", default: "bench/reference" },
    replay: { type: "string" },
    /** The run's provider.jsonl (transcripts.recordProviderMessages): pauses from word timing. */
    provider: { type: "string" },
    /** Gap between two words that counts as a pause for the pause → text metric (ms). */
    "pause-ms": { type: "string", default: "700" },
    label: { type: "string", default: "run" },
  },
});

interface RefSegment {
  id: number;
  startTime: number;
  endTime: number;
  arabic: string;
  translation: Record<string, string>;
}

interface Arrival {
  /** ms since the hello was sent (≈ session time). */
  t: number;
  kind: "add" | "update";
  block: Block;
}

interface RunLog {
  label: string;
  wav: string;
  audioStartMs: number;
  arrivals: Arrival[];
}

const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readPcm16Mono16k(file: string): Int16Array {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: not a WAV file`);
  }
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      fmtOk = format === 1 && channels === 1 && rate === 16_000 && bits === 16;
      if (!fmtOk) throw new Error(`${file}: need PCM 16 kHz mono s16le (convert with ffmpeg)`);
    } else if (id === "data") {
      if (!fmtOk) throw new Error(`${file}: data before fmt`);
      const bytes = buf.subarray(body, body + Math.min(size, buf.length - body));
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    }
    off = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

async function stream(wav: string): Promise<RunLog> {
  const pcm = readPcm16Mono16k(wav);
  const ws = new WebSocket(`ws://127.0.0.1:${values.port}/ws/page`);
  ws.binaryType = "arraybuffer";
  const arrivals: Arrival[] = [];
  let helloAt = 0;
  let ready: VadParams | null = null;
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data) as PageServerMessage;
    const t = Date.now() - helloAt;
    if (msg.type === "ready") ready = msg.vad;
    else if (msg.type === "error") console.error(`ERROR ${msg.code}: ${msg.message}`);
    else if (msg.type === "block.add" || msg.type === "block.update") {
      const kind = msg.type === "block.add" ? "add" : "update";
      arrivals.push({ t, kind, block: msg.block });
      const b = msg.block;
      const tag = b.kind === "event" ? `EVENT ${b.event?.type}` : b.kind.toUpperCase();
      console.log(
        `[${(t / 1000).toFixed(1).padStart(5)} s] ${kind === "add" ? "+" : "~"} #${b.seq} ${tag}${
          b.ref ? ` (${b.ref})` : ""
        }${b.hidden ? " hidden" : ""}: ${b.text}`,
      );
    }
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("WebSocket error")));
  });
  helloAt = Date.now();
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      from: values.from,
      to: values.to,
      ...(values.key ? { key: values.key } : {}),
      resume: null,
      client: { obs: false, ua: "bench-reference" },
      format: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1, frameMs: 100 },
      layout: "blocks",
    }),
  );
  for (let i = 0; i < 50 && ready === null; i++) await sleep(100);
  if (ready === null) throw new Error("no ready from the server");
  const gate = new VadGate(ready, {
    speech: (state) => ws.send(JSON.stringify({ type: "speech", state })),
    frame: (samples) =>
      ws.send(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)),
  });
  const start = Date.now();
  const audioStartMs = start - helloAt;
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
    const at = (i / 16_000) * 1000;
    gate.push(pcm.slice(i, i + FRAME_SAMPLES), at);
    const due = start + at + 100 - Date.now();
    if (due > 0) await sleep(due);
  }
  for (let k = 0; k < 20; k++) {
    gate.push(new Int16Array(FRAME_SAMPLES), (pcm.length / 16_000) * 1000 + k * 100);
  }
  await sleep(Number(values["tail-sec"]) * 1000);
  ws.close();
  await sleep(300);
  return { label: values.label, wav, audioStartMs, arrivals };
}

// --- scoring -------------------------------------------------------------------------------

const AR_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
function arabicKey(text: string): string[] {
  return text
    .replace(AR_DIACRITICS, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^ء-ي\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => (w.length > 3 && (w.startsWith("و") || w.startsWith("ف")) ? w.slice(1) : w));
}

function dutchNorm(text: string): string {
  return text
    .toLowerCase()
    .replace(/\((?:qur[’']?an )?\d+:\d+(?:-\d+)?\)/g, " ")
    .replace(/[ﷺﷻ﷾﷿]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** chrF (β = 2): character n-gram (1..6) F-score, words joined without spaces per n-gram. */
export function chrF(hyp: string, ref: string, beta = 2): number {
  const h = dutchNorm(hyp).replace(/ /g, "");
  const r = dutchNorm(ref).replace(/ /g, "");
  if (h.length === 0 || r.length === 0) return 0;
  let precSum = 0;
  let recSum = 0;
  let orders = 0;
  for (let n = 1; n <= 6; n++) {
    const grams = (s: string) => {
      const m = new Map<string, number>();
      for (let i = 0; i + n <= s.length; i++) {
        const g = s.slice(i, i + n);
        m.set(g, (m.get(g) ?? 0) + 1);
      }
      return m;
    };
    const hg = grams(h);
    const rg = grams(r);
    let hTot = 0;
    let rTot = 0;
    let match = 0;
    for (const c of hg.values()) hTot += c;
    for (const c of rg.values()) rTot += c;
    for (const [g, c] of hg) match += Math.min(c, rg.get(g) ?? 0);
    if (hTot === 0 || rTot === 0) continue;
    precSum += match / hTot;
    recSum += match / rTot;
    orders++;
  }
  if (orders === 0) return 0;
  const p = precSum / orders;
  const rc = recSum / orders;
  if (p + rc === 0) return 0;
  return ((1 + beta * beta) * p * rc) / (beta * beta * p + rc);
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? Number.NaN;
}

/** A real pause: ≥ 700 ms between two words (shorter gaps are mostly elongated vowels/breaths);
 *  --pause-ms 1500 measures sentence ends of a deliberate speaker instead. */
const PAUSE_GAP_MS = Number(values["pause-ms"]);

/**
 * Pause starts (session ms) from Soniox's final source-word timing: a gap ≥ PAUSE_GAP_MS.
 * The page streams continuously when the room is never silent (audio ms ≈ session ms − start).
 */
function pausesFromProvider(file: string, run: RunLog): number[] {
  const words: Array<{ start: number; end: number }> = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const o = JSON.parse(line) as {
      kind?: string;
      data?: {
        tokens?: Array<{
          text: string;
          start_ms?: number;
          end_ms?: number;
          is_final?: boolean;
          translation_status?: string;
        }>;
      };
    };
    if (o.kind !== "msg") continue;
    for (const t of o.data?.tokens ?? []) {
      if (!t.is_final || t.translation_status === "translation") continue;
      if (typeof t.start_ms !== "number" || typeof t.end_ms !== "number") continue;
      if (t.text.startsWith("<")) continue;
      words.push({ start: t.start_ms, end: t.end_ms });
    }
  }
  words.sort((a, b) => a.start - b.start);
  const out: number[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (a !== undefined && b !== undefined && b.start - a.end >= PAUSE_GAP_MS) {
      out.push(run.audioStartMs + a.end);
    }
  }
  const last = words[words.length - 1];
  if (last !== undefined) out.push(run.audioStartMs + last.end);
  return out;
}

/** Phrase ends (session ms) of the audio: the page's VAD gate run offline over the WAV. */
function phraseEnds(run: RunLog): number[] {
  if (values.provider !== undefined) return pausesFromProvider(resolve(values.provider), run);
  let pcm: Int16Array;
  try {
    pcm = readPcm16Mono16k(run.wav);
  } catch {
    return [];
  }
  const vad: VadParams = {
    thresholdDbfs: -45,
    minSpeechMs: 200,
    minSilenceMs: 300,
    hangoverMs: 400,
    prerollMs: 500,
  };
  const ends: number[] = [];
  const gate = new VadGate(vad, {
    speech: (state, atMs) => {
      if (state === "end" && typeof atMs === "number") {
        ends.push(run.audioStartMs + atMs - vad.minSilenceMs - vad.hangoverMs);
      }
    },
    frame: () => {},
  });
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
    gate.push(pcm.slice(i, i + FRAME_SAMPLES), (i / 16_000) * 1000);
  }
  for (let k = 0; k < 20; k++) {
    gate.push(new Int16Array(FRAME_SAMPLES), (pcm.length / 16_000) * 1000 + k * 100);
  }
  return ends;
}

function score(run: RunLog, ref: RefSegment[], to: string): string {
  const finals = new Map<string, Block>();
  const firstSeen = new Map<string, number>();
  const delays: number[] = [];
  const lastText = new Map<string, string>();
  for (const a of run.arrivals) {
    const b = a.block;
    finals.set(b.id, b);
    if (!firstSeen.has(b.id)) firstSeen.set(b.id, a.t);
    const grew = b.text !== (lastText.get(b.id) ?? "") && !b.hidden && b.kind !== "event";
    lastText.set(b.id, b.text);
    if (grew && typeof b.endMs === "number") delays.push(a.t - b.endMs);
  }
  const blocks = [...finals.values()]
    .filter((b) => !b.hidden && b.kind !== "event" && b.text.trim() !== "")
    .sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  const sizes = blocks.map((b) => words(b.text)).sort((a, b) => a - b);
  const tiny = blocks.filter((b) => words(b.text) < 4);
  const sortedDelays = [...delays].sort((a, b) => a - b);
  lines.push(`# Benchmark: ${run.label}`);
  lines.push("");
  lines.push(`audio: ${run.wav}`);
  lines.push("");
  lines.push("| metric | ours | reference |");
  lines.push("|---|---|---|");
  const refWords = ref.map((r) => words(r.translation[to] ?? "")).sort((a, b) => a - b);
  lines.push(`| blocks | ${blocks.length} | ${ref.length} |`);
  lines.push(
    `| tiny blocks (< 4 words) | ${tiny.length}${
      tiny.length > 0 ? ` (${tiny.map((b) => `"${b.text}"`).join(", ")})` : ""
    } | ${ref.filter((r) => words(r.translation[to] ?? "") < 4).length} |`,
  );
  lines.push(
    `| words per block (median / min / max) | ${pct(sizes, 0.5)} / ${sizes[0] ?? 0} / ${
      sizes[sizes.length - 1] ?? 0
    } | ${pct(refWords, 0.5)} / ${refWords[0] ?? 0} / ${refWords[refWords.length - 1] ?? 0} |`,
  );
  lines.push(
    `| delay: spoken word → on screen (p50 / p90 / max, ms) | ${Math.round(
      pct(sortedDelays, 0.5),
    )} / ${Math.round(pct(sortedDelays, 0.9))} / ${Math.round(
      sortedDelays[sortedDelays.length - 1] ?? Number.NaN,
    )} (n=${sortedDelays.length}) | ≈2000–2500 (demo: segment start + 2 s; claimed live ≈2.5 s) |`,
  );
  // Pause → text: for every pause of the speaker, the time until text that reaches the end of
  // what he said before it is on screen (any block, Quran included).
  const grow = run.arrivals
    .filter((a) => a.block.kind !== "event" && a.block.hidden !== true && a.block.text !== "")
    .map((a) => ({ t: a.t, end: a.block.kind === "quran" ? a.t : (a.block.endMs ?? -1) }));
  const pauseDelays: number[] = [];
  for (const e of phraseEnds(run)) {
    const hit = grow.find((g) => g.t >= e && g.end >= e - 250);
    if (hit !== undefined) pauseDelays.push(hit.t - e);
  }
  pauseDelays.sort((a, b) => a - b);
  lines.push(
    `| pause → text of what was said before it (p50 / p90 / max, ms) | ${Math.round(
      pct(pauseDelays, 0.5),
    )} / ${Math.round(pct(pauseDelays, 0.9))} / ${Math.round(
      pauseDelays[pauseDelays.length - 1] ?? Number.NaN,
    )} (n=${pauseDelays.length}) | – |`,
  );
  // Coherence proxy: Dutch sentences of ≤ 3 words ("Aan.", "of.", "Met taqwa.") among all sentences.
  const sentenceStats = (texts: string[]) => {
    const sents = texts
      .flatMap((t) => t.split(/(?<=[.!?…])\s+/))
      .map((x) => words(x))
      .filter((n) => n > 0);
    const frag = sents.filter((n) => n <= 3).length;
    const mean = sents.reduce((a, b) => a + b, 0) / Math.max(1, sents.length);
    return `${sents.length} sentences, mean ${mean.toFixed(1)} words, ${frag} of ≤ 3 words (${Math.round((100 * frag) / Math.max(1, sents.length))} %)`;
  };
  lines.push(
    `| sentences (coherence) | ${sentenceStats(blocks.filter((b) => b.kind !== "quran").map((b) => b.text))} | ${sentenceStats(ref.map((r) => r.translation[to] ?? ""))} |`,
  );
  const ourRefs = blocks.filter((b) => b.ref).map((b) => b.ref);
  const refRefs = ref
    .map((r) => /\(Qur[’']?an (\d+:\d+(?:-\d+)?)\)/.exec(r.translation[to] ?? "")?.[1])
    .filter((x): x is string => x !== undefined);
  lines.push(`| Quran refs | ${ourRefs.join(", ") || "none"} | ${refRefs.join(", ")} |`);
  const glyphs = (s: string) => (s.match(/[ﷺﷻ﷾﷿]/g) ?? []).length;
  const verbose = (s: string) =>
    (s.match(/de Verhevene|de Allerhoogste|Verheven is Hij/gi) ?? []).length;
  const ourText = blocks.map((b) => b.text).join(" ");
  const refText = ref.map((r) => r.translation[to] ?? "").join(" ");
  lines.push(
    `| honorific glyphs / spelled-out ("de Verhevene") | ${glyphs(ourText)} / ${verbose(
      ourText,
    )} | ${glyphs(refText)} / ${verbose(refText)} |`,
  );

  // Map each of our blocks to a reference segment: an in-order word alignment (LCS) of our
  // Arabic sources against the reference Arabic; a block goes to the segment most of its aligned
  // words belong to. Blocks with no aligned word (speech the reference left out) join the
  // segment before them; blocks after the last aligned one lie beyond the reference.
  const ours: Array<{ w: string; b: number }> = [];
  blocks.forEach((b, bi) => {
    for (const w of arabicKey(b.src ?? b.quranText ?? "")) ours.push({ w, b: bi });
  });
  const theirs: Array<{ w: string; s: number }> = [];
  ref.forEach((r, si) => {
    for (const w of arabicKey(r.arabic)) theirs.push({ w, s: si });
  });
  const n = ours.length;
  const m = theirs.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = L[i] as Int32Array;
      const next = L[i + 1] as Int32Array;
      row[j] =
        ours[i]?.w === theirs[j]?.w
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const votes = blocks.map(() => new Map<number, number>());
  for (let i = 0, j = 0; i < n && j < m; ) {
    const a = ours[i];
    const t = theirs[j];
    if (a === undefined || t === undefined) break;
    if (a.w === t.w) {
      const v = votes[a.b] as Map<number, number>;
      v.set(t.s, (v.get(t.s) ?? 0) + 1);
      i++;
      j++;
    } else if (((L[i + 1] as Int32Array)[j] ?? 0) >= ((L[i] as Int32Array)[j + 1] ?? 0)) i++;
    else j++;
  }
  const segOf: Array<number | null> = votes.map((v) => {
    let best: number | null = null;
    let bestN = 0;
    for (const [s, c] of v) {
      if (c > bestN) {
        bestN = c;
        best = s;
      }
    }
    return best;
  });
  let lastAssigned = -1;
  segOf.forEach((s, i) => {
    if (s !== null) lastAssigned = i;
  });
  const assigned = new Map<number, Block[]>();
  const extra: Block[] = [];
  let prev: number | null = null;
  blocks.forEach((b, i) => {
    let s = segOf[i] ?? null;
    if (s === null && i < lastAssigned) s = prev ?? 0;
    if (s === null) {
      extra.push(b);
      return;
    }
    prev = s;
    const list = assigned.get(s) ?? [];
    list.push(b);
    assigned.set(s, list);
  });
  const chrfs: number[] = [];
  lines.push("");
  lines.push("## Side by side");
  lines.push("");
  lines.push("| # | reference | ours | chrF |");
  lines.push("|---|---|---|---|");
  ref.forEach((r, i) => {
    const mine = assigned.get(i) ?? [];
    const text = mine.map((b) => `${b.text}${b.ref ? ` (${b.ref})` : ""}`).join(" ⏐ ");
    const s = chrF(mine.map((b) => b.text).join(" "), r.translation[to] ?? "");
    chrfs.push(s);
    lines.push(
      `| ${r.id} | ${(r.translation[to] ?? "").replace(/\|/g, "/")} | ${
        text.replace(/\|/g, "/") || "–"
      } | ${(s * 100).toFixed(0)} |`,
    );
  });
  const meanChrf = chrfs.reduce((a, b) => a + b, 0) / Math.max(1, chrfs.length);
  // Whole-text chrF: everything we showed for the reference's stretch of speech vs all of the
  // reference text (independent of where either side puts block boundaries).
  const covered = blocks.filter((b) => !extra.includes(b));
  const wholeChrf = chrF(
    covered.map((b) => b.text).join(" "),
    ref.map((r) => r.translation[to] ?? "").join(" "),
  );
  lines.push("");
  lines.push(`mean chrF over the reference segments: ${(meanChrf * 100).toFixed(1)}`);
  lines.push(`whole-text chrF (same stretch of speech): ${(wholeChrf * 100).toFixed(1)}`);
  lines.push("");
  lines.push("## All our blocks (⟵ Arabic source)");
  lines.push("");
  for (const b of blocks) {
    const shown = firstSeen.get(b.id) ?? 0;
    lines.push(
      `- #${b.seq} ${b.kind}${b.ref ? ` ${b.ref}` : ""} @${(shown / 1000).toFixed(1)} s, ${words(
        b.text,
      )} w: ${b.text}  ⟵ ${b.src ?? ""}`,
    );
  }
  if (extra.length > 0) {
    lines.push("");
    lines.push(`(${extra.length} blocks beyond the reference's coverage)`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  if (values.ref === undefined) throw new Error("--ref <reference.json> is required");
  const ref = JSON.parse(readFileSync(resolve(values.ref), "utf8")) as RefSegment[];
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  let run: RunLog;
  if (values.replay !== undefined) {
    run = JSON.parse(readFileSync(resolve(values.replay), "utf8")) as RunLog;
  } else {
    if (values.wav === undefined) throw new Error("--wav <file.wav> is required");
    run = await stream(resolve(values.wav));
    writeFileSync(join(outDir, `${values.label}.events.json`), JSON.stringify(run));
  }
  const report = score(run, ref, values.to);
  writeFileSync(join(outDir, `${run.label}.report.md`), `${report}\n`);
  console.log(`\n${report}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
