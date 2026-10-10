// What the CLI's help texts offer, read from the built binary's `turjuman --help` and each
// `turjuman <command> --help`: the commands, their subcommands (or pages, or literal arguments)
// and their options, as "<command>" and "<command> <subcommand|--option>" entries. The inventory
// test (inventory.e2e.ts) compares them with COVERAGE below, so a command or option that is added
// to a help text without an end-to-end test, or a stale entry here, fails it.

/** The tokens of the overview: its commands, with what their lines show of each. */
export function overviewEntries(help: string): string[] {
  const entries = new Set<string>();
  let section = "";
  for (const line of help.split("\n")) {
    const heading = /^(\S.*):$/.exec(line);
    if (heading !== null) {
      section = heading[1] ?? "";
      continue;
    }
    const m = /^ {2}(\S.*?)(?: {2,}.*)?$/.exec(line);
    if (m === null || section === "") continue;
    const usage = m[1] ?? "";
    if (section === "Options") {
      for (const option of usage.split(", ")) entries.add(option.trim());
      continue;
    }
    for (const item of usage.split(", ")) {
      const [command = "", ...rest] = item.trim().split(" ");
      entries.add(command);
      for (const token of tokensOf(rest.join(" "))) entries.add(`${command} ${token}`);
    }
  }
  return [...entries];
}

/** Options (--x) and alternatives (a|b|c) in a piece of usage text. */
function tokensOf(text: string): string[] {
  const out = [...text.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map((m) => m[0]);
  for (const m of text.matchAll(/(?<![<\w-])([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)(?![\w>-])/g)) {
    out.push(...(m[1] ?? "").split("|"));
  }
  return out;
}

/** The tokens of `turjuman <command> --help`. */
export function commandEntries(command: string, help: string): string[] {
  const entries = new Set<string>([command]);
  for (const option of help.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
    entries.add(`${command} ${option[0]}`);
  }
  // Subcommands: a lowercase word at a two-space indent, followed by its arguments or description.
  for (const sub of help.matchAll(/^ {2}([a-z][a-z-]*)(?= {2,}| <| \[| --|$)/gm)) {
    entries.add(`${command} ${sub[1]}`);
  }
  // Environment variables the help names ("Env: TOKEN=… CAPTIONS_URL …").
  for (const line of help.split("\n").filter((l) => l.startsWith("Env:"))) {
    for (const v of line.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][A-Z0-9]+(?==))/g)) {
      entries.add(`${command} ${v[1]}`);
    }
  }
  // The usage lines: alternatives ([app|builder|look]) and literal arguments (estimate start).
  for (const line of help.split("\n")) {
    const usage = new RegExp(`^(?:usage: )?turjuman ${command}((?: .*)?)$`).exec(line);
    if (usage === null) continue;
    const rest = usage[1] ?? "";
    for (const token of tokensOf(rest)) {
      if (!token.startsWith("--")) entries.add(`${command} ${token}`);
    }
    const literal = /^ ([a-z][a-z-]*)(?: |$)/.exec(rest);
    if (literal !== null) entries.add(`${command} ${literal[1]}`);
  }
  return [...entries];
}

/**
 * Every entry of the help texts → the end-to-end test that covers it ("<file>: <test name>", the
 * file in test/e2e/cli/). The inventory test checks that each named test exists.
 */
export const COVERAGE: Readonly<Record<string, string>> = {
  "--help": "help.e2e.ts: prints the overview for no arguments, help, --help and -h",
  "-h": "help.e2e.ts: prints the overview for no arguments, help, --help and -h",
  "--version": "help.e2e.ts: prints the version for --version and -v",
  "-v": "help.e2e.ts: prints the version for --version and -v",
  setup:
    "setup-doctor.e2e.ts: setup asks for the Soniox key, checks it with Soniox and creates the first admin",
  "setup --check":
    "setup-doctor.e2e.ts: setup --check checks the key of the environment or .env with Soniox",
  "setup --soniox-key-file":
    "setup-doctor.e2e.ts: setup --yes reads the key from a file or standard input and asks nothing",
  "setup --yes":
    "setup-doctor.e2e.ts: setup --yes reads the key from a file or standard input and asks nothing",
  start:
    "server.e2e.ts: start prints the server banner and where to open the app, and stops cleanly on Ctrl-C",
  "start --config":
    "server.e2e.ts: start --config --file --loop rehearses with a recording from another config file",
  "start --file":
    "server.e2e.ts: start --config --file --loop rehearses with a recording from another config file",
  "start --loop":
    "server.e2e.ts: start --config --file --loop rehearses with a recording from another config file",
  "start --start":
    "server.e2e.ts: start --start and run --start start the local session from the audio input (the audio bridge)",
  open: "server.e2e.ts: open opens the app, the builder and the look editor in the browser of this computer",
  "open app":
    "server.e2e.ts: open opens the app, the builder and the look editor in the browser of this computer",
  "open builder":
    "server.e2e.ts: open opens the app, the builder and the look editor in the browser of this computer",
  "open look":
    "server.e2e.ts: open opens the app, the builder and the look editor in the browser of this computer",
  screens:
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens list":
    "accounts.e2e.ts: screens add --preset --layout --size --enable --json and screens list --json show the look and the link",
  "screens add":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens url":
    "accounts.e2e.ts: screens url prints a screen's link by id or name, --local the one for OBS on this computer",
  "screens enable":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens disable":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens rm": "accounts.e2e.ts: screens rm asks first; no, no answer and yes",
  "screens --json":
    "accounts.e2e.ts: screens add --preset --layout --size --enable --json and screens list --json show the look and the link",
  "screens --name":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens --from":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens --to":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  "screens --preset":
    "accounts.e2e.ts: screens add --preset --layout --size --enable --json and screens list --json show the look and the link",
  "screens --layout":
    "accounts.e2e.ts: screens add --preset --layout --size --enable --json and screens list --json show the look and the link",
  "screens --size":
    "accounts.e2e.ts: screens add --preset --layout --size --enable --json and screens list --json show the look and the link",
  "screens --enable":
    "accounts.e2e.ts: screens add --preset --layout --size --enable --json and screens list --json show the look and the link",
  "screens --local":
    "accounts.e2e.ts: screens url prints a screen's link by id or name, --local the one for OBS on this computer",
  "screens --yes":
    "accounts.e2e.ts: screens add makes a screen that the app shows; its link shows captions once screens enable switches it on",
  doctor:
    "setup-doctor.e2e.ts: doctor passes a complete setup: config, key, ffmpeg, the port and the TLS handshake with Soniox",
  "doctor --config":
    "setup-doctor.e2e.ts: doctor --config reads another config file; a missing or invalid one fails",
  "doctor --online":
    "setup-doctor.e2e.ts: doctor --online asks Soniox whether it accepts the key and has the model",
  devices:
    "audio.e2e.ts: devices lists the audio inputs as audio.input.device must name them, and finds the configured one",
  "devices --config":
    "audio.e2e.ts: devices --config with the audio bridge says to list the inputs on the host; --monitors lists too",
  "devices --monitors":
    "audio.e2e.ts: devices --config with the audio bridge says to list the inputs on the host; --monitors lists too",
  run: "server.e2e.ts: run --config serves the caption pages of another config file without the app addresses, and stops on SIGTERM",
  "run --config":
    "server.e2e.ts: run --config serves the caption pages of another config file without the app addresses, and stops on SIGTERM",
  "run --start":
    "server.e2e.ts: start --start and run --start start the local session from the audio input (the audio bridge)",
  "run --file":
    "server.e2e.ts: run --fake-provider --file plays a recording through a provider log and --print prints the captions",
  "run --loop":
    "server.e2e.ts: run --file --loop repeats the recording until the session is stopped",
  "run --dry-run":
    "audio.e2e.ts: run --dry-run --file plays a WAV, prints its levels and checks its frames against its duration",
  "run --print":
    "server.e2e.ts: run --fake-provider --file plays a recording through a provider log and --print prints the captions",
  "run --dev": "server.e2e.ts: run --dev logs for a person to read and starts the page watcher",
  "run --fake-provider":
    "server.e2e.ts: run --fake-provider --file plays a recording through a provider log and --print prints the captions",
  replay:
    "server.e2e.ts: replay plays a provider log: captions over /ws, --print, status, ctl sessions, sessions and transcripts",
  "replay --config":
    "server.e2e.ts: replay --loop starts the provider log over at its end; replay --config reads another config file",
  "replay --speed":
    "server.e2e.ts: replay plays a provider log: captions over /ws, --print, status, ctl sessions, sessions and transcripts",
  "replay --loop":
    "server.e2e.ts: replay --loop starts the provider log over at its end; replay --config reads another config file",
  "replay --print":
    "server.e2e.ts: replay plays a provider log: captions over /ws, --print, status, ctl sessions, sessions and transcripts",
  keys: "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "keys add":
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "keys list":
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "keys revoke":
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "keys --label":
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "keys --daily-minutes":
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "keys --expires":
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  usage:
    "accounts.e2e.ts: keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes",
  "usage --month":
    "server.e2e.ts: sessions --limit shows that many sessions; usage --month shows another month",
  users:
    "accounts.e2e.ts: users add creates an admin who logs in to the running app with the piped password",
  "users add":
    "accounts.e2e.ts: users add creates an admin who logs in to the running app with the piped password",
  "users list":
    "accounts.e2e.ts: users add without a piped password prints a generated one once; users list shows the accounts",
  "users passwd":
    "accounts.e2e.ts: users passwd sets a new password and logs the account out; users remove deletes it",
  "users remove":
    "accounts.e2e.ts: users passwd sets a new password and logs the account out; users remove deletes it",
  "users --admin":
    "accounts.e2e.ts: users add creates an admin who logs in to the running app with the piped password",
  "users --name":
    "accounts.e2e.ts: users add creates an admin who logs in to the running app with the piped password",
  orgs: "accounts.e2e.ts: orgs list shows the organisations that signed up; disable stops their logins and enable lets them in again",
  "orgs list":
    "accounts.e2e.ts: orgs list shows the organisations that signed up; disable stops their logins and enable lets them in again",
  "orgs disable":
    "accounts.e2e.ts: orgs list shows the organisations that signed up; disable stops their logins and enable lets them in again",
  "orgs enable":
    "accounts.e2e.ts: orgs list shows the organisations that signed up; disable stops their logins and enable lets them in again",
  record:
    "audio.e2e.ts: record --out --seconds records the audio bridge to a 48 kHz stereo WAV file",
  "record --out":
    "audio.e2e.ts: record --out --seconds records the audio bridge to a 48 kHz stereo WAV file",
  "record --seconds":
    "audio.e2e.ts: record --out --seconds records the audio bridge to a 48 kHz stereo WAV file",
  status:
    "server.e2e.ts: replay plays a provider log: captions over /ws, --print, status, ctl sessions, sessions and transcripts",
  sessions:
    "server.e2e.ts: replay plays a provider log: captions over /ws, --print, status, ctl sessions, sessions and transcripts",
  "sessions --limit":
    "server.e2e.ts: sessions --limit shows that many sessions; usage --month shows another month",
  estimate:
    "server.e2e.ts: estimate start prints the cost of a session per minute and per hour from the config's prices",
  "estimate start":
    "server.e2e.ts: estimate start prints the cost of a session per minute and per hour from the config's prices",
  ctl: "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl start":
    "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl stop":
    "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl clear":
    "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl kill":
    "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl sessions":
    "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl --file":
    "server.e2e.ts: ctl starts, clears, stops and kills the local session of a running server",
  "ctl TOKEN":
    "server.e2e.ts: status, ctl and start on a hosted server: the operator's token comes from the config",
  "ctl CAPTIONS_URL":
    "server.e2e.ts: status and ctl say when no server answers, or when it answers with an error",
};
