// Server-side audio capture through the system ffmpeg: argument building for device / file /
// network inputs, and a supervised source that cuts 16 kHz mono frames, meters levels, restarts
// with backoff and can record the raw 48 kHz stereo tap (pipe:3) into a WAV.
import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import { posix, resolve, win32 } from "node:path";
import { Readable } from "node:stream";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { Backoff, FFMPEG_BACKOFF_MS } from "../core/backoff.js";
import type { AudioInputApi, AudioInputHandlers, AudioInputSpec } from "../core/contracts.js";
import { scrubSecrets } from "../log.js";
import type { AudioState } from "../shared/protocol.js";
import { FRAME_BYTES, FrameChunker } from "./chunker.js";
import { frameLevel, type Level, LevelMeter } from "./level.js";
import { type WavFormat, WavWriter } from "./wav.js";

// --- arguments --------------------------------------------------------------------------------

export type AudioChannel = "mix" | "left" | "right";

export interface FfmpegArgsOptions {
  platform: NodeJS.Platform;
  input: AudioInputSpec;
  channel: AudioChannel;
  gainDb: number;
  highpassHz: number;
  /** Also write the unprocessed input as 48 kHz stereo s16le to pipe:3. */
  rawTap: boolean;
}

/** Format of the raw recording tap on pipe:3. */
export const RAW_TAP_FORMAT: WavFormat = { sampleRate: 48_000, channels: 2 };
const RAW_TAP_BLOCK = RAW_TAP_FORMAT.channels * 2;

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ffmpeg: ${n}`);
  return String(Number(n.toFixed(6)));
}

/** The `-af` chain, pan → highpass → volume; null when empty (`mix` relies on `-ac 1`). */
export function buildAudioFilter(opts: {
  channel: AudioChannel;
  gainDb: number;
  highpassHz: number;
}): string | null {
  const parts: string[] = [];
  if (opts.channel === "left") parts.push("pan=mono|c0=c0");
  else if (opts.channel === "right") parts.push("pan=mono|c0=c1");
  if (opts.highpassHz > 0) parts.push(`highpass=f=${num(opts.highpassHz)}`);
  if (opts.gainDb !== 0) parts.push(`volume=${num(opts.gainDb)}dB`);
  return parts.length > 0 ? parts.join(",") : null;
}

function deviceInputArgs(platform: NodeJS.Platform, device: string): string[] {
  if (device.trim() === "") throw new Error("audio.input.device is empty");
  if (platform === "win32") {
    // One argv element: DirectShow names contain spaces and parentheses, and no shell is involved.
    return [
      "-f",
      "dshow",
      "-audio_buffer_size",
      "50",
      "-i",
      `audio=${device.replace(/^audio=/, "")}`,
    ];
  }
  if (platform === "darwin") {
    return ["-f", "avfoundation", "-i", device.startsWith(":") ? device : `:${device}`];
  }
  if (/^(?:plug)?hw:/.test(device)) return ["-f", "alsa", "-i", device];
  return ["-f", "pulse", "-i", device];
}

function fileInputArgs(
  platform: NodeJS.Platform,
  spec: { path: string; loop: boolean; startAtSec: number },
): string[] {
  if (spec.path.trim() === "") throw new Error("audio input file path is empty");
  const paths = platform === "win32" ? win32 : posix;
  const absolute = paths.isAbsolute(spec.path) ? paths.normalize(spec.path) : resolve(spec.path);
  const args = ["-re"];
  if (spec.startAtSec > 0) args.push("-ss", num(spec.startAtSec));
  if (spec.loop) args.push("-stream_loop", "-1");
  // Always `file:` + an absolute path, so names with ':' or a leading '-' stay literal.
  args.push("-i", `file:${absolute}`);
  return args;
}

function networkInputArgs(spec: { port: number; sampleRate: number; channels: number }): string[] {
  return [
    "-f",
    "s16le",
    "-ar",
    String(spec.sampleRate),
    "-ac",
    String(spec.channels),
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-fflags",
    "nobuffer",
    "-i",
    `tcp://0.0.0.0:${spec.port}?listen=1`,
  ];
}

/**
 * Full ffmpeg argv (never passed through a shell). Main output: 16 kHz mono s16le on pipe:1;
 * optional raw tap: 48 kHz stereo s16le on pipe:3, before the channel/gain chain.
 * Maps the first audio stream (`0:a:0`): `0:a` fails on inputs with several audio streams
 * ("s16le muxer does not support more than one stream").
 */
export function buildFfmpegArgs(opts: FfmpegArgsOptions): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  const input = opts.input;
  switch (input.kind) {
    case "device":
      args.push(...deviceInputArgs(opts.platform, input.device));
      break;
    case "file":
      args.push(...fileInputArgs(opts.platform, input));
      break;
    case "network":
      args.push(...networkInputArgs(input));
      break;
  }
  args.push("-map", "0:a:0");
  const filter = buildAudioFilter(opts);
  if (filter !== null) args.push("-af", filter);
  args.push("-ac", "1", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le");
  args.push("-flush_packets", "1", "pipe:1");
  if (opts.rawTap) {
    args.push("-map", "0:a:0", "-ac", "2", "-ar", "48000", "-f", "s16le", "-acodec", "pcm_s16le");
    args.push("-flush_packets", "1", "pipe:3");
  }
  return args;
}

/** Map `audio.input` to an input spec; null for `kind: none`. Relative file paths resolve against baseDir (default: cwd). */
export function inputSpecFromConfig(
  audio: Config["audio"],
  opts: { baseDir?: string } = {},
): AudioInputSpec | null {
  const input = audio.input;
  switch (input.kind) {
    case "none":
      return null;
    case "device":
      return { kind: "device", device: input.device };
    case "file": {
      if (input.path === undefined || input.path.trim() === "") {
        throw new Error('audio.input.path is required when audio.input.kind is "file"');
      }
      const path = resolve(opts.baseDir ?? process.cwd(), input.path);
      return { kind: "file", path, loop: input.loop, startAtSec: input.startAtSec };
    }
    case "network":
      return { kind: "network", ...input.network };
  }
}

// --- supervised source ------------------------------------------------------------------------

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface FfmpegAudioSourceOptions {
  ffmpegPath: string;
  spec: AudioInputSpec;
  channel: AudioChannel;
  gainDb: number;
  highpassHz: number;
  silenceWarnDbfs: number;
  platform?: NodeJS.Platform;
  /** Raw tap on pipe:3. Default: on for device/network inputs except on Windows. */
  rawTap?: boolean;
  spawn?: SpawnFn;
  log: Logger;
  now?: () => number;
  /** Literal secret values scrubbed from lastStderr. */
  secrets?: readonly string[];
}

/** Supervision timings. */
export const FFMPEG_TIMING = {
  /** No bytes for this long after the first byte → stalled. */
  stallMs: 2000,
  /** Backoff resets after this long in `ok`. */
  okResetMs: 30_000,
  /** Consecutive failed starts before state `error`. */
  errorAfterFailedStarts: 5,
  /** Retry interval while in `error`. */
  errorRetryMs: 5000,
  /** SIGTERM → SIGKILL grace. */
  killGraceMs: 2000,
  watchdogMs: 250,
  /** Device/file: no first byte this long after spawn → killed (counts as a failed start). */
  firstByteTimeoutMs: 10_000,
  /** Network: a listener alive this long has bound its port (not a failed start). */
  listenSettleMs: 1000,
  /** Windows: after ffmpeg exits on Ctrl-C, wait this long for stop() before relaunching. */
  windowsInterruptGraceMs: 3000,
} as const;

/** ffmpeg's exit code after a console signal (255) and STATUS_CONTROL_C_EXIT (both encodings). */
const WINDOWS_INTERRUPT_EXIT = new Set([255, 0xc000013a, -1073741510]);

type KillReason = "stall" | "no-audio" | "deliberate" | "stop";

interface ChildRun {
  readonly proc: ChildProcess;
  readonly tap: boolean;
  readonly spawnedAt: number;
  gotBytes: boolean;
  lastByteAt: number;
  listening: boolean;
  exited: boolean;
  killReason: KillReason | null;
  killTimer: NodeJS.Timeout | null;
  stderrCarry: string;
  /** Partial sample frame of the raw tap, kept so restarts never misalign a recording. */
  rawCarry: Uint8Array | null;
  readonly exitWaiters: Array<() => void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * AudioInputApi over a supervised ffmpeg child. States: `idle` → (`waiting-for-bridge` for
 * network) → `ok` on the first byte; `stalled` after 2 s without bytes → kill → `restarting`
 * with backoff 0.5 → 1 → 2 → 5 s (reset after 30 s of ok); file EOF → `ended`; 5 failed
 * starts in a row → `error` (still retried every 5 s). Nothing is restarted while stopping.
 */
export class FfmpegAudioSource implements AudioInputApi {
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly secrets: readonly string[];
  private readonly rawTapDefault: boolean;
  private rawTapWanted: boolean;
  private readonly backoff = new Backoff(FFMPEG_BACKOFF_MS);
  private readonly chunker = new FrameChunker(FRAME_BYTES);
  private readonly meter: LevelMeter;

  private current: AudioState = "idle";
  private stderrLine: string | null = null;
  private handlers: AudioInputHandlers | null = null;
  private running = false;
  private child: ChildRun | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private failedStarts = 0;
  private okSince: number | null = null;
  private frames = 0;
  private lastFrameWallMs: number | null = null;
  private recorder: { writer: WavWriter; startedAt: number } | null = null;
  private rawListener: ((chunk: Uint8Array) => void) | null = null;
  private stopping: Promise<void> | null = null;
  private handlerErrors = 0;

  constructor(private readonly opts: FfmpegAudioSourceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.secrets = opts.secrets ?? [];
    const tapKind = opts.spec.kind === "device" || opts.spec.kind === "network";
    this.rawTapDefault = opts.rawTap ?? (tapKind && this.platform !== "win32");
    this.rawTapWanted = this.rawTapDefault;
    this.meter = new LevelMeter({ silenceWarnDbfs: opts.silenceWarnDbfs });
    buildFfmpegArgs(this.argsOptions(false)); // fail fast on a bad spec, not inside the restart loop
  }

  get state(): AudioState {
    return this.current;
  }

  /** Last non-empty ffmpeg stderr line (secrets scrubbed), or null. */
  get lastStderr(): string | null {
    return this.stderrLine;
  }

  /** Frames delivered to onFrame since start(). */
  get framesEmitted(): number {
    return this.frames;
  }

  /** Wall time (ms) of the last frame, or null. */
  get lastFrameAt(): number | null {
    return this.lastFrameWallMs;
  }

  /** The level stayed below silenceWarnDbfs for 10 s. */
  get noSignal(): boolean {
    return this.meter.noSignal;
  }

  /** The most recently published level. */
  get level(): Level | null {
    return this.meter.last;
  }

  get recording(): { path: string; startedAt: number } | null {
    const rec = this.recorder;
    return rec === null ? null : { path: rec.writer.path, startedAt: rec.startedAt };
  }

  /** Whether the running ffmpeg writes the raw tap. */
  get rawTapActive(): boolean {
    return this.child?.tap ?? false;
  }

  start(handlers: AudioInputHandlers): void {
    if (this.running) throw new Error("audio input already started");
    if (this.stopping !== null) throw new Error("audio input is still stopping");
    this.handlers = handlers;
    this.running = true;
    this.failedStarts = 0;
    this.okSince = null;
    this.frames = 0;
    this.lastFrameWallMs = null;
    this.stderrLine = null;
    this.backoff.reset();
    this.meter.reset();
    this.setState("idle");
    this.spawnChild();
  }

  /** Kill ffmpeg (SIGTERM, SIGKILL after 2 s), finalize a recording; resolves once it exited. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /**
   * Start (path) or stop (null) writing the raw tap (48 kHz stereo s16le) into a WAV. Where the
   * tap is off by default (Windows, file inputs) starting a recording restarts ffmpeg once with
   * the tap; call it before start() to avoid that. Stopping finalizes the WAV header.
   */
  async setRecording(path: string | null): Promise<void> {
    await this.closeRecorder();
    if (path === null) {
      this.rawTapWanted = this.rawTapDefault; // applies from the next (re)start
      return;
    }
    const writer: WavWriter = new WavWriter(path, RAW_TAP_FORMAT, {
      onError: (err) => {
        this.log.error({ err, path }, "recording write failed; recording stopped");
        if (this.recorder?.writer === writer) void this.setRecording(null);
      },
    });
    this.recorder = { writer, startedAt: this.now() };
    this.log.info({ path }, "recording raw input");
    this.rawTapWanted = true;
    const run = this.child;
    if (run !== null && !run.exited && !run.tap && run.killReason === null) {
      this.log.info("restarting ffmpeg to enable the raw tap");
      this.kill(run, "deliberate");
    }
  }

  /** Receives raw tap chunks (48 kHz stereo s16le, whole sample frames) while the tap is on. */
  setRawListener(listener: ((chunk: Uint8Array) => void) | null): void {
    this.rawListener = listener;
  }

  // --- internals --------------------------------------------------------------------------

  private argsOptions(rawTap: boolean): FfmpegArgsOptions {
    return {
      platform: this.platform,
      input: this.opts.spec,
      channel: this.opts.channel,
      gainDb: this.opts.gainDb,
      highpassHz: this.opts.highpassHz,
      rawTap,
    };
  }

  private spawnChild(): void {
    this.restartTimer = null;
    if (!this.running || this.child !== null) return;
    const tap = this.rawTapWanted;
    const args = buildFfmpegArgs(this.argsOptions(tap));
    const stdio: StdioOptions = ["ignore", "pipe", "pipe", tap ? "pipe" : "ignore"];
    let proc: ChildProcess;
    try {
      proc = this.spawnFn(this.opts.ffmpegPath, args, { stdio, windowsHide: true });
    } catch (err) {
      this.noteStderr(`cannot start ${this.opts.ffmpegPath}: ${errorMessage(err)}`);
      this.afterExit(null, null);
      return;
    }
    const now = this.now();
    const run: ChildRun = {
      proc,
      tap,
      spawnedAt: now,
      gotBytes: false,
      lastByteAt: now,
      listening: false,
      exited: false,
      killReason: null,
      killTimer: null,
      stderrCarry: "",
      rawCarry: null,
      exitWaiters: [],
    };
    this.child = run;
    this.chunker.reset();
    this.log.debug({ pid: proc.pid, args }, "ffmpeg spawned");

    const pipeError = (err: Error): void => this.log.debug({ err }, "ffmpeg pipe error");
    proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(run, chunk));
    proc.stdout?.on("error", pipeError);
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (text: string) => this.onStderr(run, text));
    proc.stderr?.on("error", pipeError);
    const tapStream = proc.stdio[3];
    if (tapStream instanceof Readable) {
      // Always drained: a full fd-3 pipe would block ffmpeg and stall pipe:1 too.
      tapStream.on("data", (chunk: Buffer) => this.onRaw(run, chunk));
      tapStream.on("error", pipeError);
    }
    proc.on("error", (err) => this.onProcError(run, err));
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
      this.finish(run, code, signal),
    );

    if (this.opts.spec.kind === "network" && this.current !== "error") {
      this.setState("waiting-for-bridge");
    }
    this.startWatchdog();
  }

  private onStdout(run: ChildRun, chunk: Buffer): void {
    if (run !== this.child || (run.killReason !== null && run.killReason !== "deliberate")) return;
    const now = this.now();
    run.lastByteAt = now;
    if (!run.gotBytes) {
      run.gotBytes = true;
      this.failedStarts = 0;
      this.okSince = now;
      this.setState("ok");
    }
    for (const frame of this.chunker.push(chunk)) {
      if (!this.running) break;
      this.frames++;
      this.lastFrameWallMs = now;
      this.call(() => this.handlers?.onFrame(frame, now));
      const published = this.meter.push(frameLevel(frame), now);
      if (published !== null) this.call(() => this.handlers?.onLevel?.(published));
    }
  }

  private onStderr(run: ChildRun, text: string): void {
    const parts = (run.stderrCarry + text).split(/\r\n|\r|\n/);
    run.stderrCarry = (parts.pop() as string).slice(-2000); // split() returns ≥ 1 part
    for (const part of parts) {
      const line = part.trim();
      if (line !== "") this.noteStderr(line);
    }
  }

  private noteStderr(line: string): void {
    const clean = scrubSecrets(line, this.secrets).slice(0, 500);
    this.stderrLine = clean;
    if (this.current === "error") this.log.debug({ stderr: clean }, "ffmpeg");
    else this.log.warn({ stderr: clean }, "ffmpeg");
  }

  private onRaw(run: ChildRun, chunk: Buffer): void {
    if (run !== this.child) return;
    let data: Uint8Array = chunk;
    if (run.rawCarry !== null) {
      const joined = new Uint8Array(run.rawCarry.byteLength + chunk.byteLength);
      joined.set(run.rawCarry);
      joined.set(chunk, run.rawCarry.byteLength);
      data = joined;
      run.rawCarry = null;
    }
    const usable = data.byteLength - (data.byteLength % RAW_TAP_BLOCK);
    if (usable < data.byteLength) run.rawCarry = data.slice(usable);
    if (usable === 0) return;
    const aligned = usable === data.byteLength ? data : data.subarray(0, usable);
    this.recorder?.writer.write(aligned);
    const listener = this.rawListener;
    if (listener !== null) this.call(() => listener(aligned));
  }

  private onProcError(run: ChildRun, err: Error): void {
    if (run.proc.pid === undefined) {
      // Spawn failed (ENOENT, EACCES): there is no process, and 'close' may never follow.
      this.noteStderr(`cannot start ${this.opts.ffmpegPath}: ${err.message}`);
      this.finish(run, null, null);
    } else {
      this.log.warn({ err }, "ffmpeg process error");
    }
  }

  private finish(run: ChildRun, code: number | null, signal: NodeJS.Signals | null): void {
    if (run.exited) return;
    run.exited = true;
    if (run.killTimer !== null) clearTimeout(run.killTimer);
    const tail = run.stderrCarry.trim();
    run.stderrCarry = "";
    if (tail !== "") this.noteStderr(tail);
    for (const done of run.exitWaiters.splice(0)) done();
    if (this.child !== run) return;
    this.child = null;
    this.stopWatchdog();
    this.chunker.reset();
    if (!this.running) return;
    const level = run.killReason === "deliberate" ? "debug" : "info";
    this.log[level](
      { code, signal, killed: run.killReason, gotBytes: run.gotBytes, lastStderr: this.stderrLine },
      "ffmpeg exited",
    );
    this.afterExit(run, code);
  }

  /**
   * Decide what follows an exit while running (both callers check `running` first): relaunch,
   * end of file, backoff or error.
   */
  private afterExit(run: ChildRun | null, code: number | null): void {
    const reason = run?.killReason ?? null;
    const spec = this.opts.spec;
    if (reason === "deliberate") {
      this.spawnChild();
      return;
    }
    if (spec.kind === "file" && !spec.loop && reason === null && code === 0) {
      this.running = false;
      this.setState("ended");
      this.call(() => this.handlers?.onEnded?.());
      return;
    }
    if (reason === null && this.platform === "win32" && WINDOWS_INTERRUPT_EXIT.has(code ?? 0)) {
      // Windows Ctrl-C / console close reaches ffmpeg too (exit 255): the app is about to call
      // stop(). Not a crash: no state change, no backoff step; relaunch only if it does not.
      this.log.info({ code }, "ffmpeg exited on a console interrupt");
      this.restartTimer = setTimeout(() => {
        this.setState("restarting");
        this.spawnChild();
      }, FFMPEG_TIMING.windowsInterruptGraceMs);
      return;
    }
    const gotBytes = run?.gotBytes ?? false;
    if (!gotBytes && !(run?.listening ?? false)) this.failedStarts++;
    this.okSince = null;
    let delay: number;
    if (this.failedStarts >= FFMPEG_TIMING.errorAfterFailedStarts) {
      delay = FFMPEG_TIMING.errorRetryMs;
      this.setState("error");
    } else {
      // The bridge disconnected (normal): relaunch the listener with the first backoff step.
      if (spec.kind === "network" && gotBytes && reason === null) this.backoff.reset();
      delay = this.backoff.next();
      this.setState("restarting");
    }
    this.restartTimer = setTimeout(() => this.spawnChild(), delay);
  }

  private tick(): void {
    const run = this.child;
    if (run === null || run.exited || run.killReason !== null) return;
    const now = this.now();
    if (run.gotBytes) {
      if (now - run.lastByteAt >= FFMPEG_TIMING.stallMs) {
        this.log.warn({ silentMs: now - run.lastByteAt }, "ffmpeg stalled");
        this.setState("stalled");
        this.kill(run, "stall");
      } else if (
        this.okSince !== null &&
        now - this.okSince >= FFMPEG_TIMING.okResetMs &&
        this.backoff.attempts > 0
      ) {
        this.backoff.reset();
      }
      return;
    }
    if (this.opts.spec.kind === "network") {
      // Waiting for the bridge is normal: never restarted for silence.
      if (!run.listening && now - run.spawnedAt >= FFMPEG_TIMING.listenSettleMs) {
        run.listening = true;
        this.failedStarts = 0;
        this.setState("waiting-for-bridge");
      }
      return;
    }
    if (now - run.spawnedAt >= FFMPEG_TIMING.firstByteTimeoutMs) {
      this.log.warn({ waitedMs: now - run.spawnedAt }, "ffmpeg produced no audio; restarting");
      this.kill(run, "no-audio");
    }
  }

  /**
   * SIGTERM, then SIGKILL after the grace period (finish() clears the timer on exit). Callers only
   * kill a running child: with a first reason only while it has none, or "stop" at any time.
   */
  private kill(run: ChildRun, reason: KillReason): void {
    run.killReason = reason;
    try {
      run.proc.kill("SIGTERM");
    } catch (err) {
      this.log.warn({ err }, "could not signal ffmpeg");
    }
    run.killTimer ??= setTimeout(() => run.proc.kill("SIGKILL"), FFMPEG_TIMING.killGraceMs);
  }

  private async shutdown(): Promise<void> {
    this.running = false;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopWatchdog();
    const run = this.child;
    if (run !== null && !run.exited) {
      await new Promise<void>((resolveExit) => {
        const safety = setTimeout(resolveExit, FFMPEG_TIMING.killGraceMs + 3000);
        safety.unref();
        run.exitWaiters.push(() => {
          clearTimeout(safety);
          resolveExit();
        });
        this.kill(run, "stop");
      });
    }
    this.child = null;
    this.chunker.reset();
    await this.closeRecorder();
    if (this.current !== "ended") this.setState("idle");
  }

  private async closeRecorder(): Promise<void> {
    const rec = this.recorder;
    if (rec === null) return;
    this.recorder = null;
    try {
      const bytes = await rec.writer.close();
      const seconds = bytes / (RAW_TAP_FORMAT.sampleRate * RAW_TAP_BLOCK);
      this.log.info({ path: rec.writer.path, seconds }, "recording saved");
    } catch (err) {
      this.log.error({ err, path: rec.writer.path }, "could not finalize the recording");
    }
  }

  private startWatchdog(): void {
    this.watchdog ??= setInterval(() => this.tick(), FFMPEG_TIMING.watchdogMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private setState(state: AudioState): void {
    if (state === this.current) return;
    this.current = state;
    const detail = { lastStderr: this.stderrLine };
    const level =
      state === "error" ? "error" : state === "stalled" || state === "restarting" ? "warn" : "info";
    this.log[level]({ audioState: state, lastStderr: this.stderrLine }, `audio ${state}`);
    this.call(() => this.handlers?.onState?.(state, detail));
  }

  /** Run a consumer callback; a throwing consumer must not take the capture down. */
  private call(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.handlerErrors++;
      if (this.handlerErrors === 1 || this.handlerErrors % 100 === 0) {
        this.log.error({ err, count: this.handlerErrors }, "audio input handler threw");
      }
    }
  }
}

/** An FfmpegAudioSource configured from `audio.*` (channel, gain, high-pass, silence threshold). */
export function createAudioSource(
  audio: Config["audio"],
  spec: AudioInputSpec,
  deps: {
    log: Logger;
    secrets?: readonly string[];
    platform?: NodeJS.Platform;
    spawn?: SpawnFn;
    rawTap?: boolean;
    now?: () => number;
  },
): FfmpegAudioSource {
  return new FfmpegAudioSource({
    ffmpegPath: audio.ffmpegPath,
    spec,
    channel: audio.channel,
    gainDb: audio.gainDb,
    highpassHz: audio.highpassHz,
    silenceWarnDbfs: audio.silenceWarnDbfs,
    ...deps,
  });
}
