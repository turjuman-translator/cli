// Live Soniox smoke: streams the TTS WAVs in real time through
// SonioxProvider (ar → nl, shipped glossary), records provider.jsonl and analyses it.
// Runs: tts-ar and tts-mixed (+15 s of zeros each), and an endpoint probe (tts-ar with 2.5 s
// of zeros inserted at its natural pauses, finalize() at every other pause).
// Cost: ≈ 2.6 min of streamed audio in total. Re-analyse saved recordings for free.
//
//   pnpm exec tsx scripts/smoke-soniox.ts                  # all live runs + analysis
//   pnpm exec tsx scripts/smoke-soniox.ts --only tts-ar    # one live run (+ analysis of all)
//   pnpm exec tsx scripts/smoke-soniox.ts --analyze        # analysis of the saved recordings
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSonioxContext, loadGlossary, type SonioxContext } from "../src/glossary.js";
import { createLogger, scrubSecrets } from "../src/log.js";
import { FakeProvider } from "../src/stt/fake.js";
import { readRecording } from "../src/stt/recording.js";
import { SonioxProvider } from "../src/stt/soniox.js";
import { sonioxReplayMapper } from "../src/stt/soniox-map.js";
import { parseSonioxResponse, type SonioxToken } from "../src/stt/soniox-protocol.js";
import type { ProviderEvent, Token } from "../src/stt/types.js";

const FRAME_BYTES = 3200;
const FRAME_MS = 100;
const TARGET = "nl";
const cwd = process.cwd();
const outDir = process.env.SMOKE_OUT_DIR ?? tmpdir();

interface Run {
  name: string;
  wav: string;
  recordFile: string;
  /** Zero frames after the speech (15 s probes whether Soniox talks during silence). */
  tailFrames: number;
  /** Endpoint probe: zero frames inserted at each natural pause of the speech. */
  pauseFrames?: number;
  /** Endpoint probe: finalize() this many frames into every other inserted pause. */
  finalizeAfterFrames?: number;
}

const RUNS: Run[] = [
  {
    name: "tts-ar",
    wav: join(cwd, "recordings", "tts-ar.wav"),
    recordFile: join(cwd, "test", "fixtures", "soniox-tts-1.jsonl"),
    tailFrames: 150,
  },
  {
    name: "tts-mixed",
    wav: join(cwd, "recordings", "tts-mixed.wav"),
    recordFile: join(outDir, "soniox-tts-mixed.jsonl"),
    tailFrames: 150,
  },
  {
    name: "tts-ar-pauses",
    wav: join(cwd, "recordings", "tts-ar.wav"),
    recordFile: join(outDir, "soniox-tts-pauses.jsonl"),
    tailFrames: 40,
    pauseFrames: 25,
    finalizeAfterFrames: 3,
  },
];

// --- WAV ----------------------------------------------------------------------------------------

/** PCM bytes of a 16 kHz mono s16le WAV (walks the RIFF chunks; the header is not always 44 B). */
function readWavPcm(path: string): Uint8Array {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmtOk = false;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) {
        throw new Error(
          `${path}: need PCM s16le 16 kHz mono (got format ${format}, ${channels} ch, ${rate} Hz, ${bits} bit)`,
        );
      }
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) throw new Error(`${path}: data chunk before fmt chunk`);
      return buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function toFrames(pcm: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let o = 0; o < pcm.length; o += FRAME_BYTES) {
    const frame = new Uint8Array(FRAME_BYTES);
    frame.set(pcm.subarray(o, Math.min(o + FRAME_BYTES, pcm.length)));
    frames.push(frame);
  }
  return frames;
}

/** Frame indices at the middle of natural pauses (≥ 200 ms below −45 dBFS in 20 ms windows). */
function findPauses(pcm: Uint8Array): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const win = 320; // 20 ms
  const quiet: boolean[] = [];
  for (let o = 0; o + win * 2 <= pcm.byteLength; o += win * 2) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = view.getInt16(o + i * 2, true);
      sum += v * v;
    }
    quiet.push(10 * Math.log10(sum / win / 32768 / 32768 + 1e-12) < -45);
  }
  const mids: number[] = [];
  let start = -1;
  quiet.forEach((q, i) => {
    if (q && start < 0) start = i;
    if (!q && start >= 0) {
      if ((i - start) * 20 >= 200 && start > 15)
        mids.push(Math.round(((start + i) * 10) / FRAME_MS));
      start = -1;
    }
  });
  return mids;
}

interface Stream {
  frames: Uint8Array[];
  /** Frame index → call finalize() just before sending it. */
  finalizeAt: Set<number>;
  /** Frames up to the start of the zero tail. */
  speechFrames: number;
}

function buildStream(run: Run): Stream {
  const speech = toFrames(readWavPcm(run.wav));
  const zero = new Uint8Array(FRAME_BYTES);
  const frames: Uint8Array[] = [];
  const finalizeAt = new Set<number>();
  const pauses = run.pauseFrames === undefined ? [] : findPauses(readWavPcm(run.wav));
  speech.forEach((frame, k) => {
    const p = pauses.indexOf(k);
    if (p >= 0 && run.pauseFrames !== undefined) {
      if (p % 2 === 0 && run.finalizeAfterFrames !== undefined) {
        finalizeAt.add(frames.length + run.finalizeAfterFrames);
      }
      for (let i = 0; i < run.pauseFrames; i++) frames.push(zero);
    }
    frames.push(frame);
  });
  const speechFrames = frames.length;
  for (let i = 0; i < run.tailFrames; i++) frames.push(zero);
  return { frames, finalizeAt, speechFrames };
}

// --- live run ------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sec = (ms: number): string => `${(ms / 1000).toFixed(2).padStart(6)}s`;
const text = (tokens: Token[], kind: Token["kind"]): string =>
  tokens
    .filter((t) => t.kind === kind)
    .map((t) => t.text)
    .join("");

async function liveRun(run: Run, apiKey: string, context: SonioxContext | null): Promise<void> {
  const { frames, finalizeAt, speechFrames } = buildStream(run);
  const log = createLogger({
    pretty: false,
    level: process.env.LOG_LEVEL ?? "warn",
    secrets: [apiKey],
  });
  const provider = new SonioxProvider({
    apiKey,
    region: "default",
    model: "stt-rt-v5",
    from: "ar",
    languageHints: ["ar"],
    targetLanguage: TARGET,
    context,
    endpointDetection: true,
    maxEndpointDelayMs: null,
    recordFile: run.recordFile,
    log,
  });
  let streamStart = 0;
  const at = (): string => sec(Date.now() - streamStart);
  let nonFinalMsgs = 0;
  const onEvent = (e: ProviderEvent): void => {
    switch (e.type) {
      case "tokens": {
        const src = text(e.final, "source");
        const tr = text(e.final, "translation");
        if (src !== "") console.log(`[${at()}] ar  ${JSON.stringify(src)}`);
        if (tr !== "") console.log(`[${at()}] ${TARGET}  ${JSON.stringify(tr)}`);
        if (e.nonFinal.length > 0) nonFinalMsgs++;
        break;
      }
      case "endpoint":
        console.log(`[${at()}] <endpoint>`);
        break;
      default:
        console.log(`[${at()}] ${e.type} ${scrubSecrets(JSON.stringify(e), [apiKey])}`);
    }
  };

  console.log(
    `\n=== ${run.name}: ${(speechFrames * FRAME_MS) / 1000} s audio + ${(run.tailFrames * FRAME_MS) / 1000} s zeros; finalize at frames [${[...finalizeAt].join(",")}] ===`,
  );
  const startCalledAt = Date.now();
  streamStart = startCalledAt;
  await provider.start({ sessionId: `smoke-${run.name}-${startCalledAt}`, onEvent });
  if (provider.state !== "live") {
    console.error(`provider state ${provider.state}; aborting`);
    await provider.stop({ fast: true });
    process.exitCode = 1;
    return;
  }
  streamStart = Date.now();
  for (const [k, frame] of frames.entries()) {
    await sleep(streamStart + k * FRAME_MS - Date.now());
    if (k === speechFrames) console.log(`[${at()}] --- speech done; streaming zeros ---`);
    if (finalizeAt.has(k)) {
      console.log(`[${at()}] --- finalize() ---`);
      provider.finalize();
    }
    provider.sendAudio(frame);
  }
  console.log(`[${at()}] --- stop() ---`);
  await provider.stop();
  console.log(
    `[${at()}] stopped. first frame at t=${streamStart - startCalledAt} ms; messages with non-finals: ${nonFinalMsgs}; stats ${JSON.stringify(provider.stats())}`,
  );
}

// --- analysis ------------------------------------------------------------------------------------

interface Msg {
  t: number;
  session: number;
  tokens: SonioxToken[];
  totalAudioProcMs: number | null;
  finalAudioProcMs: number | null;
  finished: boolean;
  error: string | null;
}

type Cls = "S" | "T" | "N" | "E" | "F";

function cls(t: SonioxToken): Cls {
  if (t.text === "<end>") return "E";
  if (t.text === "<fin>") return "F";
  if (t.translation_status === "translation") return "T";
  if (t.translation_status === "none") return "N";
  return "S";
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? null;
}

const stat = (v: number[]): string =>
  v.length === 0
    ? "n=0"
    : `n=${v.length} p50=${pct(v, 50)} p95=${pct(v, 95)} min=${Math.min(...v)} max=${Math.max(...v)}`;

interface Seg {
  index: number;
  src: string;
  tr: string;
  srcTokens: number;
  trTokens: number;
  mirrored: number;
  lastSrcEndMs: number | null;
  lastSrcFinalT: number | null;
  lastTrFinalT: number | null;
  endT: number | null;
  marker: "<end>" | "<fin>" | null;
  late: number;
}

/** Replays a recording through FakeProvider + sonioxReplayMapper (speed ∞). */
async function replayCounts(
  file: string,
): Promise<{ endpoints: number; tokens: number; src: string; tr: string }> {
  const fake = new FakeProvider({
    file,
    track: "soniox",
    speed: Number.POSITIVE_INFINITY,
    mappers: { soniox: sonioxReplayMapper },
  });
  const out = { endpoints: 0, tokens: 0, src: "", tr: "" };
  await fake.start({
    sessionId: "replay",
    onEvent: (e) => {
      if (e.type === "endpoint") out.endpoints++;
      if (e.type !== "tokens") return;
      out.tokens++;
      out.src += text(e.final, "source");
      out.tr += text(e.final, "translation");
    },
  });
  await fake.stop();
  return out;
}

async function analyze(run: Run): Promise<void> {
  if (!existsSync(run.recordFile)) {
    console.log(`\n### ${run.name}: no recording at ${run.recordFile}`);
    return;
  }
  const stream = buildStream(run);
  const speechMs = stream.speechFrames * FRAME_MS;
  const { meta, lines } = readRecording(run.recordFile);
  const msgs: Msg[] = [];
  const sessions = lines.filter((l) => l.kind === "session");
  for (const l of lines) {
    if (l.kind !== "msg") continue;
    const p = parseSonioxResponse(l.data);
    if (!p.ok) continue;
    msgs.push({
      t: l.t,
      session: l.session ?? 0,
      tokens: p.msg.tokens,
      totalAudioProcMs: p.msg.totalAudioProcMs,
      finalAudioProcMs: p.msg.finalAudioProcMs,
      finished: p.msg.finished,
      error: p.msg.error === null ? null : JSON.stringify(p.msg.error),
    });
  }
  const firstFrameT = sessions[0]?.t ?? 0; // frames start right after start() resolves
  const tailStartT = firstFrameT + speechMs;
  const lastT = lines.at(-1)?.t ?? 0;
  console.log(`\n### ${run.name}  (${run.recordFile})`);
  console.log(
    `meta.config has api_key=${JSON.stringify((meta.config as { api_key?: unknown } | undefined)?.api_key)}; sessions=${sessions.length}; msgs=${msgs.length}; errors=${msgs.filter((m) => m.error !== null).length}; finished=${msgs.some((m) => m.finished)}`,
  );
  console.log(
    `speech ${speechMs} ms; first frame ≈ t=${firstFrameT}; tail (zeros) from t≈${tailStartT}; last line t=${lastT}`,
  );

  // Final-token stream (in arrival order) and segments split at <end>/<fin>.
  const segs: Seg[] = [];
  const newSeg = (): Seg => ({
    index: segs.length,
    src: "",
    tr: "",
    srcTokens: 0,
    trTokens: 0,
    mirrored: 0,
    lastSrcEndMs: null,
    lastSrcFinalT: null,
    lastTrFinalT: null,
    endT: null,
    marker: null,
    late: 0,
  });
  let cur = newSeg();
  let prevClosed: Seg | null = null; // the segment closed by the last marker, until the next source token
  let nonFinalTr = 0;
  let nonFinalTrMsgs = 0;
  const noneLangs = new Map<string, number>();
  const origLangs = new Map<string, number>();
  const trLangs = new Map<string, number>();
  const trSrcLangs = new Map<string, number>();
  const noneSamples: string[] = [];
  let noneRun = "";
  const bump = (m: Map<string, number>, k: string | null | undefined): void => {
    const key = k ?? "(absent)";
    m.set(key, (m.get(key) ?? 0) + 1);
  };
  const msgsWithTrAfterEndInSameMsg: number[] = [];
  // Per-message latencies for continuous speech (no endpoint needed): arrival − (first frame +
  // end_ms of the newest final source token).
  const srcChunkLat: number[] = [];
  const trChunkLat: number[] = [];
  let newestSrcEndMs: number | null = null;

  for (const m of msgs) {
    const nf = m.tokens.filter((t) => t.is_final !== true && cls(t) === "T");
    nonFinalTr += nf.length;
    if (nf.length > 0) nonFinalTrMsgs++;
    let sawEndInMsg = false;
    let msgSrcEnd: number | null = null;
    let msgHasTr = false;
    for (const t of m.tokens) {
      if (t.is_final !== true) continue;
      const c = cls(t);
      if (c === "N") {
        bump(noneLangs, t.language);
        noneRun += t.text;
      } else if (noneRun !== "" && c !== "E" && c !== "F") {
        noneSamples.push(noneRun);
        noneRun = "";
      }
      if (c === "S") bump(origLangs, t.language);
      if (c === "T") {
        bump(trLangs, t.language);
        bump(trSrcLangs, t.source_language);
      }
      if (c === "E" || c === "F") {
        if (noneRun !== "") {
          noneSamples.push(noneRun);
          noneRun = "";
        }
        cur.endT = m.t;
        cur.marker = c === "E" ? "<end>" : "<fin>";
        segs.push(cur);
        prevClosed = cur;
        cur = newSeg();
        sawEndInMsg = true;
        continue;
      }
      if (c === "S" || c === "N") {
        prevClosed = null;
        cur.src += t.text;
        cur.srcTokens++;
        if (typeof t.end_ms === "number") {
          cur.lastSrcEndMs = t.end_ms;
          msgSrcEnd = t.end_ms;
          newestSrcEndMs = t.end_ms;
        }
        cur.lastSrcFinalT = m.t;
        if (c === "N" && t.language === TARGET) {
          cur.tr += t.text;
          cur.mirrored++;
          cur.lastTrFinalT = m.t;
        }
        continue;
      }
      msgHasTr = true;
      // Translation token: belongs to the open segment unless no source token followed the
      // last marker yet; then it is a late translation of the segment that just closed.
      if (prevClosed !== null) {
        prevClosed.tr += t.text;
        prevClosed.trTokens++;
        prevClosed.late++;
        prevClosed.lastTrFinalT = m.t;
        if (sawEndInMsg) msgsWithTrAfterEndInSameMsg.push(m.t);
      } else {
        cur.tr += t.text;
        cur.trTokens++;
        cur.lastTrFinalT = m.t;
      }
    }
    if (msgSrcEnd !== null) srcChunkLat.push(m.t - (firstFrameT + msgSrcEnd));
    if (msgHasTr && newestSrcEndMs !== null) trChunkLat.push(m.t - (firstFrameT + newestSrcEndMs));
  }
  if (cur.srcTokens > 0 || cur.trTokens > 0) segs.push(cur);
  // Segments whose translation has tokens both before and after their marker
  const spanning = segs.filter((s) => s.late > 0 && s.trTokens > s.late).length;

  const late = segs.filter((s) => s.late > 0);
  const redundant = segs.filter((s) => s.srcTokens === 0 && s.trTokens === 0);
  const replay = await replayCounts(run.recordFile);
  const finalSrc = segs.map((s) => s.src).join("");
  const finalTr = segs.map((s) => s.tr).join("");
  console.log(
    `markers: ${segs.filter((s) => s.marker !== null).length}, redundant (no token since the previous marker): ${redundant.length}; replay → ${replay.endpoints} endpoint events, ${replay.tokens} tokens events; replay text == recording: source ${replay.src === finalSrc}, translation ${replay.tr === finalTr}`,
  );
  const zeroTr = segs.filter((s) => s.src.trim() !== "" && s.tr.trim() === "");
  console.log(
    `segments: ${segs.length} (closed by marker: ${segs.filter((s) => s.endT !== null).length})`,
  );
  for (const s of segs) {
    const spokenT = s.lastSrcEndMs === null ? null : firstFrameT + s.lastSrcEndMs;
    const lat = (x: number | null): string =>
      x === null || spokenT === null ? "-" : `${x - spokenT}`;
    console.log(
      `  #${s.index} end_ms=${s.lastSrcEndMs} srcFinal+${lat(s.lastSrcFinalT)} ${s.marker ?? "open"}+${lat(s.endT)} trFinal+${lat(s.lastTrFinalT)} late=${s.late} mirrored=${s.mirrored}`,
    );
    console.log(`     ar: ${JSON.stringify(s.src.trim())}`);
    console.log(`     ${TARGET}: ${JSON.stringify(s.tr.trim())}`);
  }
  console.log(
    `Q1 translation tokens after a marker (late): ${late.reduce((n, s) => n + s.late, 0)} tokens in ${late.length} segments; in the same message as the marker: ${msgsWithTrAfterEndInSameMsg.length}`,
  );
  console.log(`   translation runs spanning a marker: ${spanning}`);
  console.log(
    `Q2 non-final translation tokens: ${nonFinalTr} (in ${nonFinalTrMsgs} of ${msgs.length} messages)`,
  );
  console.log(
    `Q3 segments with source text but zero translation: ${zeroTr.length} ${zeroTr.map((s) => `#${s.index} ${JSON.stringify(s.src.trim())}`).join(" | ")}`,
  );
  console.log(
    `Q4 "none" token languages: ${JSON.stringify(Object.fromEntries(noneLangs))}; original: ${JSON.stringify(Object.fromEntries(origLangs))}; translation: ${JSON.stringify(Object.fromEntries(trLangs))}; translation source_language: ${JSON.stringify(Object.fromEntries(trSrcLangs))}`,
  );
  if (noneRun !== "") noneSamples.push(noneRun);
  for (const s of noneSamples.slice(0, 8)) console.log(`   none run: ${JSON.stringify(s)}`);

  // Q5: messages while only zeros were being sent (from 2 s after the speech until stop()).
  const tail = msgs.filter((m) => m.t >= tailStartT + 2000);
  const gaps = tail.slice(1).map((m, i) => m.t - (tail[i]?.t ?? m.t));
  console.log(
    `Q5 messages during the zero tail (t ≥ ${tailStartT + 2000}): ${tail.length}; with tokens: ${tail.filter((m) => m.tokens.length > 0).length}; gaps ${stat(gaps)}`,
  );
  const proc = tail.map((m) => `${m.t}:${m.totalAudioProcMs}/${m.finalAudioProcMs}`);
  console.log(
    `   t:total_audio_proc_ms/final_audio_proc_ms ${proc.slice(0, 6).join(" ")} … ${proc.slice(-4).join(" ")}`,
  );
  const allGaps = msgs.slice(1).map((m, i) => m.t - (msgs[i]?.t ?? m.t));
  console.log(`   all message gaps ${stat(allGaps)}`);

  // Q6: latency from the end of a segment's speech (last final source end_ms) to arrivals.
  const lat = (pick: (s: Seg) => number | null): number[] =>
    segs.flatMap((s) => {
      const v = pick(s);
      return s.lastSrcEndMs === null || v === null ? [] : [v - (firstFrameT + s.lastSrcEndMs)];
    });
  console.log(
    `Q6 latency after end of speech (ms): source final ${stat(lat((s) => s.lastSrcFinalT))}`,
  );
  console.log(`   endpoint ${stat(lat((s) => s.endT))}`);
  console.log(
    `   translation final ${stat(lat((s) => (s.tr.trim() === "" ? null : s.lastTrFinalT)))}`,
  );
  console.log(`   per message: source final ${stat(srcChunkLat)}`);
  console.log(`   per message: translation final ${stat(trChunkLat)}`);
  // finalize() → <fin> round trip (finalize is called just before frame k is sent).
  const finLat: number[] = [];
  for (const k of stream.finalizeAt) {
    const calledT = firstFrameT + k * FRAME_MS;
    const fin = msgs.find((m) => m.t >= calledT && m.tokens.some((t) => t.text === "<fin>"));
    if (fin !== undefined) finLat.push(fin.t - calledT);
  }
  if (stream.finalizeAt.size > 0) console.log(`   finalize() → <fin> ${stat(finLat)}`);
}

// --- main ----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.argv.includes("--analyze")) {
    if (existsSync(join(cwd, ".env"))) process.loadEnvFile(join(cwd, ".env"));
    const apiKey = process.env.SONIOX_API_KEY ?? "";
    if (apiKey === "") throw new Error("SONIOX_API_KEY is not set (.env)");
    const glossary = loadGlossary(join(cwd, "glossaries"), "ar", TARGET);
    const built =
      glossary === null ? null : buildSonioxContext(glossary.glossary, { nativeTranslation: true });
    console.log(
      `glossary: ${glossary?.file ?? "none"}; context ≈ ${built?.estimatedTokens ?? 0} tokens; truncated: ${built?.truncated.join(",") || "-"}`,
    );
    const onlyIdx = process.argv.indexOf("--only");
    const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;
    for (const run of RUNS) {
      if (only === undefined || only === run.name)
        await liveRun(run, apiKey, built?.context ?? null);
    }
  }
  for (const run of RUNS) await analyze(run);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
