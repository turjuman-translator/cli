// Smoke test for server-side audio capture with the real ffmpeg on this machine (not a unit test).
// Run: pnpm exec tsx scripts/smoke-audio.ts        (SMOKE_LOG=debug for the source's logs)
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pino } from "pino";
import {
  listDevices,
  parseArecordDevices,
  parseAvfoundationDevices,
  parseDshowDevices,
  parsePactlSources,
  runCommand,
} from "../src/audio/devices.js";
import { buildFfmpegArgs, FfmpegAudioSource, type SpawnFn } from "../src/audio/ffmpeg.js";
import { patchWavHeader, wavHeader } from "../src/audio/wav.js";
import { devicesCommand } from "../src/cli/devices.js";
import { ffprobePathFor, runDryCommand } from "../src/cli/run-dry.js";
import { loadConfig } from "../src/config.js";
import type { AudioState } from "../src/shared/protocol.js";

const ROOT = resolve(import.meta.dirname, "..");
const WAV = join(ROOT, "recordings/tts-ar.wav");
const FIXTURES = join(ROOT, "test/fixtures/devices");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = ffprobePathFor(FFMPEG);
const NET_PORT = 7123;
const TAP_WAV = "/tmp/tap.wav";
const log = pino({ level: process.env.SMOKE_LOG ?? "silent" });

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/** Real spawn that remembers the children, so the smoke can SIGSTOP one and check for orphans. */
const children: ChildProcess[] = [];
const trackingSpawn: SpawnFn = (cmd, args, options) => {
  const child = spawn(cmd, args, options);
  children.push(child);
  return child;
};

function stateRecorder(t0: () => number) {
  const states: Array<{ state: AudioState; atMs: number; lastStderr: string | null }> = [];
  return {
    states,
    onState: (state: AudioState, d: { lastStderr: string | null }) => {
      states.push({ state, atMs: Date.now() - t0(), lastStderr: d.lastStderr });
    },
    trail: () => states.map((s) => `${s.state}@${(s.atMs / 1000).toFixed(2)}s`).join(" → "),
  };
}

// --- 0. parsers and argv on fixtures ------------------------------------------------------
function fixtures(): void {
  console.log("\n== 0. parsers / argv ==");
  const avf = parseAvfoundationDevices(readFileSync(join(FIXTURES, "avfoundation.txt"), "utf8"));
  check(
    "avfoundation fixture",
    avf.length === 5 && avf[2]?.id === "2" && avf[2]?.name === "MacBook Pro Microphone",
    avf.map((d) => `[${d.id}] ${d.name}`).join(", "),
  );
  const suffixed = parseAvfoundationDevices(
    "[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] Abdullah’s Mic [uid:BuiltInMicrophoneDevice] [serial:ABC123]\n",
  );
  check(
    "avfoundation uid/serial suffix",
    suffixed[0]?.name === "Abdullah’s Mic",
    JSON.stringify(suffixed),
  );
  const dshow = parseDshowDevices(readFileSync(join(FIXTURES, "dshow.txt"), "utf8"));
  check(
    "dshow fixture",
    dshow.length === 3 &&
      dshow[1]?.name === "Microphone (Realtek(R) Audio)" &&
      (dshow[1]?.alt ?? "").startsWith("@device_cm_{33D9A762"),
    dshow.map((d) => `"${d.name}" alt=${d.alt?.slice(0, 24)}…`).join(", "),
  );
  const legacy = parseDshowDevices(
    '[dshow @ 0000] DirectShow video devices (some may be both video and audio devices)\n[dshow @ 0000]  "Cam"\n[dshow @ 0000]     Alternative name "@device_pnp_x"\n[dshow @ 0000] DirectShow audio devices\n[dshow @ 0000]  "Line (USB Audio CODEC)"\n[dshow @ 0000]     Alternative name "@device_cm_{X}\\wave_{Y}"\n',
  );
  check(
    "dshow legacy format",
    legacy.length === 1 && legacy[0]?.alt === "@device_cm_{X}\\wave_{Y}",
    JSON.stringify(legacy),
  );
  const pactlText = readFileSync(join(FIXTURES, "pactl.txt"), "utf8");
  const pulse = parsePactlSources(pactlText);
  const pulseAll = parsePactlSources(pactlText, { includeMonitors: true });
  check(
    "pactl fixture",
    pulse.length === 2 && pulseAll.length === 4,
    pulse.map((d) => d.id).join(", "),
  );
  const alsa = parseArecordDevices(readFileSync(join(FIXTURES, "arecord.txt"), "utf8"));
  check(
    "arecord fixture",
    alsa.length === 2 && alsa[1]?.id === "hw:1,0" && alsa[1]?.alt === "hw:CARD=CODEC,DEV=0",
    alsa.map((d) => `${d.id} (${d.name})`).join(", "),
  );
  const winArgs = buildFfmpegArgs({
    platform: "win32",
    input: { kind: "device", device: "Line (USB Audio CODEC)" },
    channel: "left",
    gainDb: 6,
    highpassHz: 80,
    rawTap: false,
  });
  check(
    "dshow argv",
    winArgs.includes("audio=Line (USB Audio CODEC)") &&
      winArgs.join(" ").includes("-af pan=mono|c0=c0,highpass=f=80,volume=6dB") &&
      !winArgs.includes("pipe:3"),
    winArgs.join(" "),
  );
}

// --- 1. devices on this machine ---------------------------------------------------------------
async function devices(): Promise<void> {
  console.log("\n== 1. devices ==");
  const list = await listDevices({ platform: process.platform, ffmpegPath: FFMPEG });
  check(
    "listDevices",
    list.devices.length > 0,
    `${list.source}: ${list.devices.map((d) => `[${d.id}] ${d.name}`).join(", ")}`,
  );
  const loaded = loadConfig();
  const out: string[] = [];
  const code = await devicesCommand(
    [],
    { out: (s) => out.push(s), err: (s) => out.push(s) },
    loaded,
  );
  console.log(out.join("\n").replace(/^/gm, "    | "));
  check("devicesCommand", code === 0, `exit ${code}`);
  const netOut: string[] = [];
  const net = structuredClone(loaded);
  net.config.audio.input.kind = "network";
  await devicesCommand([], { out: (s) => netOut.push(s), err: (s) => netOut.push(s) }, net);
  check(
    "devicesCommand network hint",
    netOut.join("\n").includes("scripts\\audio-bridge.ps1 -List"),
    netOut[0] ?? "",
  );
}

// --- 2. dry run on the WAV --------------------------------------------------------------------
async function dryRun(): Promise<void> {
  console.log("\n== 2. dry run (real time, ~26 s) ==");
  const loaded = loadConfig();
  const out: Array<{ atMs: number; line: string }> = [];
  const err: string[] = [];
  const t0 = Date.now();
  const code = await runDryCommand({
    loaded,
    file: WAV,
    io: {
      out: (line) => {
        out.push({ atMs: Date.now() - t0, line });
        if (out.length % 25 === 1 || line.startsWith("frames=")) console.log(`    | ${line}`);
      },
      err: (line) => err.push(line),
    },
  });
  const levelLines = out.filter((o) => o.line.startsWith("rms "));
  const last = out[out.length - 1]?.line ?? "";
  const spanSec = ((levelLines.at(-1)?.atMs ?? 0) - (levelLines[0]?.atMs ?? 0)) / 1000;
  const rate = spanSec > 0 ? (levelLines.length - 1) / spanSec : 0;
  check(
    "dry-run frames vs ffprobe",
    code === 0 && last.startsWith("frames="),
    `${last} exit ${code}`,
  );
  check(
    "dry-run level rate ≤ 5/s, real time",
    rate <= 5.05 && (Date.now() - t0) / 1000 > 24,
    `${levelLines.length} level lines, ${rate.toFixed(2)}/s, took ${((Date.now() - t0) / 1000).toFixed(1)} s; states: ${err.filter((e) => e.startsWith("audio:")).join(", ")}`,
  );
}

// --- 3+4. network listener + bridge sender + raw-tap recording ----------------------------------
async function network(): Promise<void> {
  console.log(`\n== 3/4. network listener on ${NET_PORT} + raw-tap recording ==`);
  let t0 = Date.now();
  const rec = stateRecorder(() => t0);
  const source = new FfmpegAudioSource({
    ffmpegPath: FFMPEG,
    spec: { kind: "network", port: NET_PORT, sampleRate: 48_000, channels: 2 },
    channel: "left",
    gainDb: 0,
    highpassHz: 0,
    silenceWarnDbfs: -50,
    log,
    spawn: trackingSpawn,
  });
  let levels = 0;
  t0 = Date.now();
  source.start({ onFrame: () => {}, onLevel: () => levels++, onState: rec.onState });
  await sleep(2000);
  check(
    "waiting-for-bridge before the sender",
    source.state === "waiting-for-bridge" && source.framesEmitted === 0,
    `state ${source.state}, frames ${source.framesEmitted}, tap ${source.rawTapActive}`,
  );

  const sender = spawn(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-re",
      "-i",
      WAV,
      "-ac",
      "2",
      "-ar",
      "48000",
    ].concat(["-f", "s16le", `tcp://127.0.0.1:${NET_PORT}?tcp_nodelay=1`]),
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let senderErr = "";
  sender.stderr?.on("data", (d: Buffer) => {
    senderErr += d.toString();
  });
  const senderStart = Date.now();
  const gotOk = await waitFor(() => source.state === "ok", 3000);
  const okAfterMs = Date.now() - senderStart;
  check("state ok once the bridge sends", gotOk, `after ${okAfterMs} ms ${senderErr.trim()}`);

  // 4. record 3 s of the raw tap while the bridge streams
  await sleep(1000);
  rmSync(TAP_WAV, { force: true });
  await source.setRecording(TAP_WAV);
  const recStart = Date.now();
  await sleep(3000);
  await source.setRecording(null);
  const recSec = (Date.now() - recStart) / 1000;

  await sleep(Math.max(0, 5000 - (Date.now() - senderStart)));
  const framesAtKill = source.framesEmitted;
  const streamedSec = (Date.now() - senderStart) / 1000;
  sender.kill("SIGTERM");
  check(
    "frames while the bridge streamed",
    Math.abs(framesAtKill - streamedSec * 10) <= 8,
    `${framesAtKill} frames in ${streamedSec.toFixed(2)} s (≈${(streamedSec * 10).toFixed(0)} expected), ${levels} level events`,
  );
  const killedAt = Date.now() - t0;
  const relaunched = await waitFor(
    () =>
      source.state === "waiting-for-bridge" &&
      rec.states.some((s) => s.atMs >= killedAt && s.state === "restarting"),
    4000,
  );
  check("listener relaunches into waiting-for-bridge", relaunched, rec.trail());
  await source.stop();
  check("stop → idle", source.state === "idle", source.state);

  // WAV header check
  const size = statSync(TAP_WAV).size;
  const head = readFileSync(TAP_WAV).subarray(0, 44);
  const view = new DataView(head.buffer, head.byteOffset, 44);
  const riff = view.getUint32(4, true);
  const data = view.getUint32(40, true);
  const probe = await runCommand(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "stream=sample_rate,channels:format=duration",
    "-of",
    "default=nw=1",
    TAP_WAV,
  ]);
  const probeText = (probe?.stdout ?? "").trim().replace(/\n/g, " ");
  const durMatch = /duration=([\d.]+)/.exec(probeText);
  const dur = durMatch ? Number(durMatch[1]) : Number.NaN;
  check(
    "tap WAV header sizes",
    riff === size - 8 && data === size - 44 && data % 4 === 0,
    `file ${size} B, RIFF ${riff}, data ${data}`,
  );
  check(
    "tap WAV ffprobe",
    probeText.includes("sample_rate=48000") &&
      probeText.includes("channels=2") &&
      Math.abs(dur - recSec) < 0.3,
    `${probeText} (recorded for ${recSec.toFixed(2)} s)`,
  );
}

// --- 5. stall → kill → restart ----------------------------------------------------------------
async function stall(): Promise<void> {
  console.log("\n== 5. stall (SIGSTOP ffmpeg) → stalled → restarting → ok ==");
  let t0 = Date.now();
  const rec = stateRecorder(() => t0);
  const before = children.length;
  const source = new FfmpegAudioSource({
    ffmpegPath: FFMPEG,
    spec: { kind: "file", path: WAV, loop: true, startAtSec: 0 },
    channel: "mix",
    gainDb: 0,
    highpassHz: 0,
    silenceWarnDbfs: -50,
    log,
    spawn: trackingSpawn,
  });
  t0 = Date.now();
  source.start({ onFrame: () => {}, onState: rec.onState });
  await waitFor(() => source.state === "ok", 3000);
  await sleep(500);
  const victim = children[before];
  victim?.kill("SIGSTOP");
  const stoppedAt = Date.now() - t0;
  const recovered = await waitFor(
    () => source.state === "ok" && rec.states.some((s) => s.state === "stalled"),
    8000,
  );
  const stalledAt = rec.states.find((s) => s.state === "stalled")?.atMs ?? Number.NaN;
  check(
    "stall detected and recovered",
    recovered && stalledAt - stoppedAt >= 1900 && stalledAt - stoppedAt <= 2600,
    `stalled ${((stalledAt - stoppedAt) / 1000).toFixed(2)} s after SIGSTOP; ${rec.trail()}`,
  );
  await source.stop();
}

// --- 6. failed starts → error -----------------------------------------------------------------
async function failedStarts(): Promise<void> {
  console.log("\n== 6. missing ffmpeg → 5 failed starts → error (~8.5 s) ==");
  let t0 = Date.now();
  const rec = stateRecorder(() => t0);
  const source = new FfmpegAudioSource({
    ffmpegPath: "/nonexistent/ffmpeg",
    spec: { kind: "device", device: "0" },
    channel: "mix",
    gainDb: 0,
    highpassHz: 0,
    silenceWarnDbfs: -50,
    log,
  });
  t0 = Date.now();
  source.start({ onFrame: () => {}, onState: rec.onState });
  const errored = await waitFor(() => source.state === "error", 11_000);
  const at = (Date.now() - t0) / 1000;
  check(
    "error after 5 failed starts",
    errored && at > 8 && at < 9.5,
    `${rec.trail()}; lastStderr: ${source.lastStderr}`,
  );
  await source.stop();
}

// --- 7. crash-left WAV repair -----------------------------------------------------------------
async function wavRepair(): Promise<void> {
  console.log("\n== 7. WAV left by a crash → patchWavHeader ==");
  const path = "/tmp/smoke-crash.wav";
  const fd = openSync(path, "w");
  writeSync(fd, wavHeader({ sampleRate: 48_000, channels: 2 }, null));
  writeSync(fd, new Uint8Array(192_000 + 3)); // 1 s + a partial sample frame
  closeSync(fd);
  const before = await runCommand(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    path,
  ]);
  const dataBytes = patchWavHeader(path);
  const after = await runCommand(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    path,
  ]);
  check(
    "patchWavHeader",
    dataBytes === 192_000 && statSync(path).size === 192_044 && Number(after?.stdout.trim()) === 1,
    `unpatched ffprobe duration=${before?.stdout.trim() || before?.stderr.trim()}; patched data=${dataBytes} B, duration=${after?.stdout.trim()}`,
  );
  rmSync(path, { force: true });
}

async function main(): Promise<void> {
  fixtures();
  await devices();
  await dryRun();
  await network();
  await stall();
  await failedStarts();
  await wavRepair();
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  check(
    "no orphaned ffmpeg children",
    alive.length === 0,
    `${children.length} spawned, ${alive.length} alive`,
  );
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
