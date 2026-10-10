import { parseArgs } from "node:util";
import { type LoadedConfig, loadConfig } from "../config.js";
import { packageVersion } from "../version.js";
import { CTL_HELP, ctlCommand } from "./ctl.js";
import { DEVICES_HELP, devicesCommand } from "./devices.js";
import { exitCodeFor, formatResults, realDoctorDeps, runDoctor } from "./doctor.js";
import { estimateCommand } from "./estimate.js";
import { KEYS_HELP, keysCommand, USAGE_HELP, usageCommand } from "./keys.js";
import { openCommand } from "./open.js";
import { ORGS_HELP, orgsCommand } from "./orgs.js";
import { recordCommand } from "./record.js";
import { replayCommand, runCommand } from "./run.js";
import { screensCommand } from "./screens-cmd.js";
import { sessionsCommand } from "./sessions.js";
import { setupCommand } from "./setup.js";
import { START_HELP, startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { asksHelp, COMMAND_USAGE, isParseArgsError, parseErrorText } from "./usage.js";
import { USERS_HELP, usersCommand } from "./users.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** Config for commands that work without one (status, ctl): null when loading fails. */
function tryLoadConfig(): LoadedConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

const HELP = `turjuman <command> [options]          ("captions" is the same command)

Get started:
  setup                                 save your Soniox key (checked with Soniox) and create the
                                        first admin account
  setup --check                         ask Soniox whether it accepts the key that is set
  start [--config <file>]               start the server and print where to open the app
  open [app|builder|look]               open the app, the screen builder or the look editor
  screens list|add|url|enable|disable|rm
                                        screens and their screen links
  doctor [--config <file>] [--online]   check the setup (nothing is billed; --online also asks
                                        Soniox whether it accepts your key)

More:
  status                                whether the server runs: sessions, audio, latency
  sessions [--limit n]                  recent sessions
  users add|list|passwd|remove          accounts for the app (/app)
  keys add|list|revoke, usage           access keys for caption pages without a screen link (not
                                        the Soniox key), and the minutes each one used
  estimate start                        the cost per minute and per hour
  run [--config <file>] [--file <wav>] [--start] [--dry-run]
                                        the server, without printing the app addresses
  orgs list|disable|enable <id>         organisations of a hosted server (the operator's commands)

Server-side capture (Turjuman reads the audio input itself) and testing:
  devices [--monitors]                  list the audio inputs
  ctl start|stop|clear|kill|sessions    control the local session of a running server
  record --out <file.wav>               record the audio input to a WAV file
  replay <provider.jsonl> [--speed 1]   the server with a recorded Soniox session (no network)

Options:
  --help, -h       this help; "turjuman help <command>" for a command's own
  --version, -v    print the version`;

export { packageVersion } from "../version.js";

/** `turjuman <command> --help` without loading the config (setup, start, open and screens print
 *  their own). */
const COMMAND_HELP: Readonly<Record<string, string>> = {
  ...COMMAND_USAGE,
  keys: KEYS_HELP,
  usage: USAGE_HELP,
  users: USERS_HELP,
  orgs: ORGS_HELP,
  ctl: CTL_HELP,
  devices: DEVICES_HELP,
  start: START_HELP,
};

async function doctor(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string" }, online: { type: "boolean", default: false } },
  });
  let loaded: Awaited<ReturnType<typeof loadConfig>> | Error;
  try {
    loaded = loadConfig(values.config === undefined ? {} : { configFile: values.config });
  } catch (err) {
    loaded = err instanceof Error ? err : new Error(String(err));
  }
  const ffmpegPath = loaded instanceof Error ? "ffmpeg" : loaded.config.audio.ffmpegPath;
  const results = await runDoctor(loaded, realDoctorDeps(ffmpegPath), { online: values.online });
  io.out(formatResults(results));
  return exitCodeFor(results);
}

/** Dispatch one CLI invocation; returns the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const about = rest[0];
  // `turjuman help <command>`: that command's own help.
  if (command === "help" && about !== undefined && !about.startsWith("-")) {
    return runCli([about, "--help"], io);
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out(packageVersion());
    return 0;
  }
  const help = COMMAND_HELP[command];
  if (help !== undefined && asksHelp(rest)) {
    io.out(help);
    return 0;
  }
  try {
    return await dispatch(command, rest, io);
  } catch (err) {
    // A wrong option: exit code 2, with the command's usage.
    if (!isParseArgsError(err)) throw err;
    io.err(
      `turjuman ${command}: ${parseErrorText(err)}\n\n${help ?? `See: turjuman ${command} --help`}`,
    );
    return 2;
  }
}

async function dispatch(command: string, rest: string[], io: CliIo): Promise<number> {
  if (command === "doctor") return doctor(rest, io);
  if (command === "status") {
    parseArgs({ args: rest, options: {} }); // takes no options
    return statusCommand(io, tryLoadConfig());
  }
  if (command === "devices") return devicesCommand(rest, io, tryLoadConfig());
  if (command === "setup") return setupCommand(rest, io, () => loadConfig());
  if (command === "start") return startCommand(rest, io);
  if (command === "open") return openCommand(rest, io, () => loadConfig());
  if (command === "run") return runCommand(rest, io);
  if (command === "replay") return replayCommand(rest, io);
  if (command === "keys") return keysCommand(rest, io, loadConfig());
  if (command === "usage") return usageCommand(rest, io, loadConfig());
  if (command === "users") return usersCommand(rest, io, loadConfig());
  if (command === "orgs") return orgsCommand(rest, io, loadConfig());
  if (command === "screens") return screensCommand(rest, io, () => loadConfig());
  if (command === "sessions") return sessionsCommand(rest, io, loadConfig());
  if (command === "record") return recordCommand(rest, io, loadConfig());
  if (command === "ctl") return ctlCommand(rest, io, tryLoadConfig());
  if (command === "estimate") return estimateCommand(rest, io, loadConfig());
  io.err(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}
