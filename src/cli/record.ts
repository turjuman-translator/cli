import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createAudioSource, inputSpecFromConfig, type SpawnFn } from "../audio/ffmpeg.js";
import type { LoadedConfig } from "../config.js";
import { createLogger } from "../log.js";
import type { CliIo } from "./index.js";

export interface RecordDeps {
  /** How ffmpeg is started (default: node's spawn). */
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
}

/**
 * `turjuman record --out <file.wav> [--seconds n]`: records the configured input
 * BEFORE the channel/gain/resample chain, as a 48 kHz stereo WAV (ffmpeg raw tap). Ctrl-C stops
 * cleanly with a valid WAV header. A running service that already listens on the bridge port
 * (audio.input.kind: network) holds that port: stop its monitor or session first.
 */
export async function recordCommand(
  args: string[],
  io: CliIo,
  loaded: LoadedConfig,
  deps: RecordDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { out: { type: "string" }, seconds: { type: "string" } },
  });
  if (values.out === undefined) {
    io.err("usage: turjuman record --out <file.wav> [--seconds n]");
    return 2;
  }
  const spec = inputSpecFromConfig(loaded.config.audio, { baseDir: loaded.paths.dataDir });
  if (spec === null || spec.kind === "file") {
    io.err("turjuman record needs audio.input.kind device or network in config.yaml");
    return 2;
  }
  const seconds = values.seconds === undefined ? null : Number.parseFloat(values.seconds);
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) {
    io.err("turjuman record: --seconds must be a positive number of seconds");
    return 2;
  }
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  const log = createLogger({ pretty: false, level: "warn" });
  const source = createAudioSource(loaded.config.audio, spec, {
    log,
    rawTap: true,
    spawn: deps.spawn,
    platform: deps.platform,
  });
  await source.setRecording(out);

  let frames = 0;
  source.start({
    onFrame: () => {
      frames++;
    },
    onState: (state, detail) => {
      if (state === "error" || state === "stalled")
        io.err(`audio: ${state}${detail.lastStderr ? ` (${detail.lastStderr})` : ""}`);
      if (state === "waiting-for-bridge")
        io.out(`waiting for the audio bridge on port ${loaded.config.audio.input.network.port}…`);
    },
  });
  io.out(
    `recording ${spec.kind} input to ${out}${seconds === null ? "; Ctrl-C to stop" : ` for ${seconds} s`}`,
  );

  await new Promise<void>((done) => {
    const timer = seconds === null ? null : setTimeout(done, seconds * 1000);
    const onSignal = (): void => {
      if (timer !== null) clearTimeout(timer);
      done();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  await source.stop();
  io.out(`saved ${out} (${(frames / 10).toFixed(1)} s captured)`);
  return 0;
}
