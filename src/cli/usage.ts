// Usage of the commands without a help text of their own: `turjuman <command> --help` prints it,
// and a wrong option prints it under the error (exit code 2).

export const COMMAND_USAGE = {
  doctor: `turjuman doctor [--config <file>] [--online]

  Checks the setup: config, the Soniox key, the HTTPS certificate, Quran data, ffmpeg, the port
  and the connection to Soniox. --online also asks Soniox whether it accepts your key (a free
  model list). Exit code 1 when a line says [FAIL].`,
  run: `turjuman run [--config <file>] [--start] [--file <wav> [--loop]] [--dry-run] [--print]
             [--dev] [--fake-provider <provider.jsonl>]

  The server, without the app addresses that "turjuman start" prints.
    --start           also start the local session from the audio input
    --file <wav>      rehearse with a recording (--loop repeats it)
    --dry-run         only the audio input and its levels, no server
    --print           print the finished captions of the local session
    --dev             rebuild the browser pages when their source changes (development)
    --fake-provider   replay a recorded Soniox session instead of Soniox (no network, no cost)`,
  replay: `turjuman replay <provider.jsonl> [--config <file>] [--speed 1] [--loop] [--print]

  The server with a recorded Soniox session instead of Soniox: no network, no cost.`,
  record: `turjuman record --out <file.wav> [--seconds n]

  Records the audio input of server-side capture (audio.input.kind device or network) to a WAV
  file; Ctrl-C stops.`,
  status: `turjuman status

  Whether the server runs, and what it is doing: sessions, audio and latency.`,
  sessions: `turjuman sessions [--limit n]

  Recent sessions with their duration and segments (default: the last 20).`,
  estimate: `turjuman estimate start

  The cost of a session per minute and hour.`,
} as const satisfies Readonly<Record<string, string>>;

/** An unknown option or a missing value (node:util parseArgs). */
export function isParseArgsError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof err.code === "string" &&
    err.code.startsWith("ERR_PARSE_ARGS")
  );
}

/** The message of a parseArgs error, without node's long hint about positionals after "--". */
export function parseErrorText(err: Error): string {
  const text = err.message.replace(/\. To specify a positional argument[\s\S]*$/, "");
  return text.endsWith(".") ? text : `${text}.`;
}

/** `--help`, `-h`, or `help` as the first argument. */
export function asksHelp(args: readonly string[]): boolean {
  return args[0] === "help" || args.includes("--help") || args.includes("-h");
}
