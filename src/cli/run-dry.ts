// `turjuman run --dry-run`: the audio input and levels only,
// no provider. With a file, the frame count at EOF must match the ffprobe duration within ±1 %.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Logger, pino } from "pino";
import { FRAME_BYTES } from "../audio/chunker.js";
import { runCommand } from "../audio/devices.js";
import { createAudioSource, inputSpecFromConfig, type SpawnFn } from "../audio/ffmpeg.js";
import type { LoadedConfig } from "../config.js";
import type { AudioInputSpec } from "../core/contracts.js";

export interface RunDryIo {
  out(text: string): void;
  err(text: string): void;
}

export interface RunDryOptions {
  loaded: LoadedConfig;
  /** `--file`: play this file once instead of the configured input. */
  file?: string;
  io: RunDryIo;
  /** Stops the run (Ctrl-C). Without it, SIGINT/SIGTERM/SIGHUP (and SIGBREAK) are handled here. */
  signal?: AbortSignal;
  log?: Logger;
  /** Media duration in seconds, or null when unknown (default: ffprobe next to ffmpeg). */
  probeDuration?: (file: string) => Promise<number | null>;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
}

/** Frame count within ±1 % of the file duration (and never stricter than ±1 frame). */
export const FRAME_TOLERANCE_PCT = 1;
/** 3,200-byte frames of 16 kHz mono s16le = 100 ms. */
const FRAME_MS = (FRAME_BYTES / 2 / 16_000) * 1000;

/** The ffprobe next to an ffmpeg path: only the basename changes (`…/bin/ffmpeg.exe` → `…/bin/ffprobe.exe`). */
export function ffprobePathFor(ffmpegPath: string): string {
  const cut = Math.max(ffmpegPath.lastIndexOf("/"), ffmpegPath.lastIndexOf("\\"));
  const dir = ffmpegPath.slice(0, cut + 1);
  const base = ffmpegPath.slice(cut + 1);
  if (/ffmpeg/i.test(base)) return dir + base.replace(/ffmpeg/i, "ffprobe");
  return `${dir}ffprobe${/\.exe$/i.test(base) ? ".exe" : ""}`;
}

/** `ffprobe -v error -show_entries format=duration -of csv=p=0 file:<path>` → seconds, or null. */
export async function probeDurationSec(ffprobePath: string, file: string): Promise<number | null> {
  const result = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    `file:${file}`,
  ]);
  if (result === null || result.code !== 0) return null;
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function describeInput(spec: AudioInputSpec): string {
  switch (spec.kind) {
    case "device":
      return `device ${JSON.stringify(spec.device)}`;
    case "file":
      return `file ${spec.path}${spec.loop ? " (loop)" : ""}${spec.startAtSec > 0 ? ` from ${spec.startAtSec} s` : ""}`;
    case "network":
      return `network: listening on tcp port ${spec.port} for the audio bridge (${spec.sampleRate} Hz, ${spec.channels} ch)`;
  }
}

const PROBLEM_STATES = new Set(["stalled", "restarting", "error"]);

export async function runDryCommand(opts: RunDryOptions): Promise<number> {
  const { loaded, io } = opts;
  const audio = loaded.config.audio;

  let spec: AudioInputSpec | null;
  try {
    // audio.input.path is relative to DATA_DIR, as for the server; --file to the working folder.
    spec =
      opts.file !== undefined
        ? { kind: "file", path: resolve(opts.file), loop: false, startAtSec: 0 }
        : inputSpecFromConfig(audio, { baseDir: loaded.paths.dataDir });
  } catch (err) {
    io.err(`turjuman run --dry-run: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (spec === null) {
    io.err(
      'turjuman run --dry-run: audio.input.kind is "none" (no server-side capture); pass --file <wav> or set audio.input.kind',
    );
    return 2;
  }
  if (spec.kind === "file" && !existsSync(spec.path)) {
    io.err(`turjuman run --dry-run: file not found: ${spec.path}`);
    return 2;
  }

  const checked = spec.kind === "file" && !spec.loop ? spec : null;
  const probe =
    opts.probeDuration ??
    ((file: string) => probeDurationSec(ffprobePathFor(audio.ffmpegPath), file));
  const durationPromise = checked === null ? null : probe(checked.path);

  const secrets = [loaded.secrets.sonioxApiKey, loaded.config.server.token].filter(
    (s): s is string => s !== null && s !== "",
  );
  let source: ReturnType<typeof createAudioSource>;
  try {
    source = createAudioSource(audio, spec, {
      log: opts.log ?? pino({ level: "silent" }),
      secrets,
      platform: opts.platform,
      spawn: opts.spawn,
    });
  } catch (err) {
    io.err(`turjuman run --dry-run: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const checkFrames = async (): Promise<number> => {
    const frames = source.framesEmitted;
    const duration = durationPromise === null ? null : await durationPromise;
    if (checked === null || duration === null) {
      io.err(`frames=${frames}; could not read the file duration with ffprobe`);
      return 1;
    }
    const expected = (Math.max(0, duration - checked.startAtSec) * 1000) / FRAME_MS;
    const deltaPct = expected > 0 ? ((frames - expected) / expected) * 100 : frames === 0 ? 0 : 100;
    const sign = deltaPct > 0 ? "+" : "";
    io.out(`frames=${frames} expected≈${expected.toFixed(1)} (Δ=${sign}${deltaPct.toFixed(2)}%)`);
    // ±1 %, but never less than one frame: a trailing partial frame is never emitted.
    const slack = Math.max((FRAME_TOLERANCE_PCT / 100) * expected, 1);
    return Math.abs(frames - expected) <= slack ? 0 : 1;
  };

  io.err(`dry run (audio and levels only, no provider): ${describeInput(spec)}; Ctrl-C to stop`);
  const fromFile = spec.kind === "file";

  return new Promise<number>((resolveRun) => {
    let finished = false;
    const cleanups: Array<() => void> = [];
    /** The first of Ctrl-C and the end of the file wins; the work starts only then. */
    const finish = (work: () => Promise<number>): void => {
      if (finished) return;
      finished = true;
      for (const cleanup of cleanups) cleanup();
      work().then(resolveRun, (err: unknown) => {
        io.err(`turjuman run --dry-run: ${err instanceof Error ? err.message : String(err)}`);
        resolveRun(1);
      });
    };
    const interrupt = (): void =>
      finish(async () => {
        await source.stop();
        io.err(`stopped after ${source.framesEmitted} frames`);
        return 0;
      });

    if (opts.signal !== undefined) {
      const signal = opts.signal;
      signal.addEventListener("abort", interrupt, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", interrupt));
    } else {
      const platform = opts.platform ?? process.platform;
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      if (platform === "win32") signals.push("SIGBREAK");
      for (const s of signals) process.on(s, interrupt);
      cleanups.push(() => {
        for (const s of signals) process.off(s, interrupt);
      });
    }

    source.start({
      onFrame: () => {},
      onLevel: (level) => {
        const flag = source.noSignal ? "  NO SIGNAL" : "";
        io.out(
          `rms ${level.rmsDbfs.toFixed(1)} dBFS  peak ${level.peakDbfs.toFixed(1)} dBFS  frames ${source.framesEmitted}${flag}`,
        );
      },
      onState: (state, { lastStderr }) => {
        const problem = PROBLEM_STATES.has(state);
        const why = problem && lastStderr !== null ? ` (${lastStderr})` : "";
        if (problem && fromFile) {
          // ffmpeg fails on a file the same way every time: end instead of retrying it. A microtask
          // later, so that the retry the source schedules now is there for stop() to cancel.
          queueMicrotask(() =>
            finish(async () => {
              await source.stop();
              io.err(`turjuman run --dry-run: ffmpeg could not read the file${why}`);
              return 1;
            }),
          );
          return;
        }
        io.err(`audio: ${state}${why}`);
      },
      onEnded: () =>
        finish(async () => {
          await source.stop();
          return checkFrames();
        }),
    });
    if (opts.signal?.aborted === true) interrupt();
  });
}
