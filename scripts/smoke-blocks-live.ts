// Live end-to-end check of the caption-block chain without a browser:
// WAV → the page's VadGate → /ws/page (hello layout=blocks) → Soniox → fast blocks (Quran
// follower, prayer-event detector) → block messages, printed as they arrive and summarized at the
// end.
// Usage: pnpm exec tsx scripts/smoke-blocks-live.ts [--wav recordings/khutbah-sim-ar.wav]
//          [--port 8765] [--from ar] [--to nl] [--layout blocks] [--key K] [--tail-sec 25]
//          [--out $TMPDIR/turjuman-e2e/blocks-live.log]
// Costs money (Soniox): run it deliberately.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Block, PageServerMessage, VadParams } from "../src/shared/protocol.js";
import { VadGate } from "../web/shared/vad-gate.js";

const { values } = parseArgs({
  options: {
    wav: { type: "string", default: "recordings/khutbah-sim-ar.wav" },
    port: { type: "string", default: "8765" },
    from: { type: "string", default: "ar" },
    to: { type: "string", default: "nl" },
    layout: { type: "string", default: "blocks" },
    key: { type: "string" },
    "tail-sec": { type: "string", default: "25" },
    out: { type: "string", default: join(tmpdir(), "turjuman-e2e", "blocks-live.log") },
  },
});

const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
  const t0 = Date.now();
  const log = (line: string) => {
    const stamped = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${line}`;
    console.log(stamped);
    appendFileSync(out, `${stamped}\n`);
  };

  const pcm = readPcm16Mono16k(resolve(values.wav));
  log(`wav ${values.wav}: ${(pcm.length / 16_000).toFixed(1)} s`);

  const ws = new WebSocket(`ws://127.0.0.1:${values.port}/ws/page`);
  ws.binaryType = "arraybuffer";
  const blocks = new Map<string, Block>();
  // Latency after a pause: wall time of each VAD speech end, and the delay of text after it.
  const pauses: number[] = [];
  const textDelays: number[] = [];
  const addTimes: number[] = [];
  let audioStart = 0;
  const noteText = (now: number) => {
    const last = pauses.filter((p) => p <= now).pop();
    if (last !== undefined && now - last < 3000) textDelays.push(now - last);
  };
  let ready: VadParams | null = null;
  let ended = false;
  let listening = false;

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data) as PageServerMessage;
    switch (msg.type) {
      case "ready":
        ready = msg.vad;
        log(`ready session=${msg.sessionId}`);
        break;
      case "error":
        log(`ERROR ${msg.code}: ${msg.message}`);
        break;
      case "blocks.snapshot":
        for (const b of msg.blocks) blocks.set(b.id, b);
        break;
      case "block.add": {
        const b = msg.block;
        blocks.set(b.id, b);
        addTimes.push(Date.now());
        if (b.kind !== "event") noteText(Date.now());
        const tag = b.kind === "event" ? `EVENT ${b.event?.type}` : b.kind.toUpperCase();
        log(`+ ${tag}${b.ref ? ` (${b.ref})` : ""}: ${b.text}${b.src ? `   ⟵ ${b.src}` : ""}`);
        break;
      }
      case "block.update": {
        const b = msg.block;
        const prev = blocks.get(b.id);
        blocks.set(b.id, b);
        if (b.hidden || b.event) {
          log(
            `~ #${b.seq} ${b.hidden ? "hidden" : `event ${b.event?.type} active=${b.event?.active}`}`,
          );
        } else {
          const grown =
            prev !== undefined && b.text.startsWith(prev.text)
              ? b.text.slice(prev.text.length)
              : ` ⟲ ${b.text}`;
          log(`  #${b.seq} +${grown}`);
          noteText(Date.now());
        }
        break;
      }
      case "mode":
        log(`mode → ${msg.mode}`);
        break;
      case "listening":
        if (msg.active !== listening) {
          listening = msg.active;
          log(`listening ${msg.active ? "on" : "off"}`);
        }
        break;
      case "session.ended":
        ended = true;
        log("session.ended");
        break;
      default:
        break;
    }
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("WebSocket error")));
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      from: values.from,
      to: values.to,
      ...(values.key ? { key: values.key } : {}),
      resume: null,
      client: { obs: false, ua: "smoke-blocks-live" },
      format: { codec: "pcm_s16le", sampleRate: 16_000, channels: 1, frameMs: 100 },
      layout: values.layout,
    }),
  );
  for (let i = 0; i < 50 && ready === null; i++) await sleep(100);
  if (ready === null) {
    log("no ready from the server");
    ws.close();
    return 1;
  }

  const gate = new VadGate(ready, {
    speech: (state, atMs) => {
      if (state === "end") pauses.push(audioStart + atMs);
      ws.send(JSON.stringify({ type: "speech", state }));
    },
    frame: (samples) =>
      ws.send(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)),
  });
  const start = Date.now();
  audioStart = start;
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
    const frame = pcm.slice(i, i + FRAME_SAMPLES);
    const at = (i / 16_000) * 1000;
    gate.push(frame, at);
    const due = start + at + 100 - Date.now();
    if (due > 0) await sleep(due);
  }
  // Trailing silence so the gate closes its hangover.
  for (let k = 0; k < 20; k++)
    gate.push(new Int16Array(FRAME_SAMPLES), (pcm.length / 16_000) * 1000 + k * 100);
  log(`audio done; waiting ${values["tail-sec"]} s for the pipeline`);
  await sleep(Number(values["tail-sec"]) * 1000);
  ws.close();
  await sleep(500);

  const list = [...blocks.values()].sort((a, b) => a.seq - b.seq);
  const kinds = new Map<string, number>();
  for (const b of list) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  log(
    `summary: ${list.length} blocks ${JSON.stringify(Object.fromEntries(kinds))}; ended=${ended}`,
  );
  log(
    `quran refs: ${
      list
        .filter((b) => b.ref)
        .map((b) => b.ref)
        .join(", ") || "none"
    }`,
  );
  log(
    `events: ${
      list
        .filter((b) => b.kind === "event")
        .map((b) => b.event?.type)
        .join(", ") || "none"
    }`,
  );
  log(`hidden: ${list.filter((b) => b.hidden).length}`);
  const sorted = [...textDelays].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? Number.NaN;
  log(
    `text after a pause (VAD end → text on screen): p50=${pct(0.5)} ms p90=${pct(0.9)} ms n=${sorted.length}`,
  );
  let burst = 0;
  for (const t of addTimes) {
    burst = Math.max(burst, addTimes.filter((u) => Math.abs(u - t) <= 150).length);
  }
  log(`largest burst of new blocks within 150 ms: ${burst}`);
  return list.length > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
