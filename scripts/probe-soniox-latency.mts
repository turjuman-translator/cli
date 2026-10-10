// Latency probe for tuning fast blocks: how long after the speaker pauses does Soniox deliver
// the end of the utterance and its final translation? Streams a WAV through the caption page's
// VadGate, exactly like a page, and times every message against the real speech end.
// Usage: pnpm exec tsx scripts/probe-soniox-latency.ts <wav> [A|B|C|D ...]   (costs ~1 min of Soniox per variant)
//   A: max 600 ms, level 3, sensitivity 0.3        B: A + {"type":"finalize"} at the speech end
//   C: Soniox defaults (2000 ms)                   D: max 500 ms, level 3, sensitivity 0.6 + finalize
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { EnergyVad, pcmBytesToSamples } from "../src/shared/vad.js";
import { buildSonioxConfig } from "../src/stt/soniox-protocol.js";
import { VadGate } from "../web/shared/vad-gate.js";

const URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const FRAME = 1600;

interface Variant {
  name: string;
  max: number | null;
  level: number | null;
  sens: number | null;
  finalize: boolean;
}
const VARIANTS: Record<string, Variant> = {
  A: { name: "A fast 600/3/0.3", max: 600, level: 3, sens: 0.3, finalize: false },
  B: { name: "B fast + finalize at speech end", max: 600, level: 3, sens: 0.3, finalize: true },
  C: { name: "C Soniox defaults", max: null, level: null, sens: null, finalize: false },
  D: { name: "D 500/3/0.6 + finalize", max: 500, level: 3, sens: 0.6, finalize: true },
};

function readWav(file: string): Int16Array {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const b = buf.subarray(off + 8, off + 8 + size);
      return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : (s[Math.floor((s.length - 1) / 2)] ?? Number.NaN);
};

async function run(pcm: Int16Array, v: Variant, apiKey: string): Promise<void> {
  const ws = new WebSocket(URL);
  const msgs: Array<{ t: number; tokens: Array<{ text: string; final: boolean; tr: string }> }> =
    [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    const m = JSON.parse(ev.data) as {
      tokens?: Array<{ text: string; is_final: boolean; translation_status?: string }>;
      error_message?: string;
    };
    if (m.error_message) console.log(`  error: ${m.error_message}`);
    msgs.push({
      t: Date.now(),
      tokens: (m.tokens ?? []).map((k) => ({
        text: k.text,
        final: k.is_final,
        tr: k.translation_status ?? "none",
      })),
    });
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
  ws.send(
    JSON.stringify(
      buildSonioxConfig({
        apiKey,
        model: "stt-rt-v5",
        from: "ar",
        targetLanguage: "nl",
        context: null,
        endpointDetection: true,
        maxEndpointDelayMs: v.max,
        endpointLatencyLevel: v.level,
        endpointSensitivity: v.sens,
        sessionId: `probe-${v.name.slice(0, 1)}`,
      }),
    ),
  );
  const start = Date.now();
  const speechEnds: number[] = [];
  const speechStarts: number[] = [];
  // The real speech end (start of the silent run), as the page's VAD sees it.
  const vad = new EnergyVad({ thresholdDbfs: -45, minSpeechMs: 200, minSilenceMs: 300 });
  const gate = new VadGate(
    { thresholdDbfs: -45, minSpeechMs: 200, minSilenceMs: 400, hangoverMs: 800, prerollMs: 500 },
    {
      speech: () => undefined,
      frame: (s) => ws.send(new Uint8Array(s.buffer, s.byteOffset, s.byteLength)),
    },
  );
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    const frame = pcm.slice(i, i + FRAME);
    const at = (i / 16_000) * 1000;
    gate.push(frame, at);
    for (const e of vad.push(pcmBytesToSamples(new Uint8Array(frame.buffer)), at)) {
      if (e.type === "speechEnd") {
        speechEnds.push(start + e.atMs);
        if (v.finalize) ws.send(JSON.stringify({ type: "finalize" }));
      } else speechStarts.push(start + e.atMs);
    }
    const due = start + at + 100 - Date.now();
    if (due > 0) await sleep(due);
  }
  await sleep(3000);
  ws.send("");
  await sleep(1500);
  ws.close();

  // Per pause: the first <end>/<fin> after it, and the last translation token before speech resumes.
  const endDelays: number[] = [];
  const trDelays: number[] = [];
  const firstTrDelays: number[] = [];
  for (const e of speechEnds) {
    const next = speechStarts.find((s) => s > e) ?? e + 4000;
    const endMsg = msgs.find(
      (m) => m.t >= e - 300 && m.tokens.some((k) => k.text === "<end>" || k.text === "<fin>"),
    );
    if (endMsg !== undefined && endMsg.t - e < 4000) endDelays.push(endMsg.t - e);
    const trMsgs = msgs.filter(
      (m) =>
        m.t >= e - 300 &&
        m.t <= Math.max(next, e + 2500) &&
        m.tokens.some((k) => k.tr === "translation" && k.final),
    );
    const lastTr = trMsgs.at(-1);
    if (lastTr !== undefined) trDelays.push(lastTr.t - e);
    const firstTr = trMsgs[0];
    if (firstTr !== undefined) firstTrDelays.push(firstTr.t - e);
  }
  const nonFinalTr = msgs
    .flatMap((m) => m.tokens)
    .filter((k) => k.tr === "translation" && !k.final).length;
  console.log(
    `${v.name.padEnd(34)} pauses=${speechEnds.length}  <end> after pause p50=${median(endDelays)} ms  ` +
      `last translation p50=${median(trDelays)} ms  first translation p50=${median(firstTrDelays)} ms  ` +
      `non-final translation tokens=${nonFinalTr}`,
  );
}

const [wav, ...which] = process.argv.slice(2);
if (wav === undefined) throw new Error("usage: probe-soniox-latency.ts <wav> [A B C D]");
const loaded = loadConfig({ cwd: process.cwd() });
const apiKey = loaded.secrets.sonioxApiKey;
if (apiKey === null) throw new Error("SONIOX_API_KEY missing");
const pcm = readWav(wav);
for (const key of which.length > 0 ? which : ["A", "B", "C"]) {
  const v = VARIANTS[key];
  if (v !== undefined) await run(pcm, v, apiKey);
}
