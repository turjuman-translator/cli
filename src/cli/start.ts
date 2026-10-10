// `turjuman start`: the server (`turjuman run` with the same options) and,
// once it listens, where to open the app: the dashboard (/app), the builder (/app/new) and the
// look editor (/app/look), on this computer and on the LAN, HTTPS or public address when set.
// It reads the same .env files as the server (loadEnvFiles): CONFIG_DIR/.env, where
// `turjuman setup` saves the keys, and ./.env.
import { parseArgs } from "node:util";
import { storedLocalKeys } from "../accounts/key-resolver.js";
import { loadConfig, loadEnvFiles } from "../config.js";
import { turjumanCmd } from "./hint.js";
import type { CliIo } from "./index.js";
import { RUN_OPTIONS, runCommand } from "./run.js";
import { type Addresses, APP_PAGES, serverAddresses } from "./urls.js";

export interface StartDeps {
  /** The server (default: `turjuman run`). */
  run?: (args: string[], io: CliIo) => Promise<number>;
  /** Default process.env; the .env files are read into it. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** This machine's LAN address (default: looked up). */
  lan?: string | null;
}

export const START_HELP = `turjuman start [--config <file>] [--start] [--file <wav> [--loop]]

  Starts Turjuman and prints where to open the app: the dashboard with your screens (/app), the
  builder for new screens (/app/new) and the look editor (/app/look). Stop it with Ctrl-C.
  The same as "turjuman run", with the same options:
    --config <file>   another config file (default: config.yaml in the config folder)
    --start           also start server-side capture from the audio input
    --file <wav>      rehearse with a recording instead of the audio input (--loop repeats it)`;

/** The address lines printed under the server's banner. */
export function appLines(a: Addresses): string[] {
  const lines = [
    "",
    "Open the app:",
    `  Screens (dashboard):  ${a.local}${APP_PAGES.app}`,
    `  New screen (builder): ${a.local}${APP_PAGES.builder}`,
    `  Caption look:         ${a.local}${APP_PAGES.look}`,
  ];
  if (a.lan !== null) lines.push(`  On the network:       ${a.lan}${APP_PAGES.app}`);
  if (a.https !== null) lines.push(`  HTTPS:                ${a.https}${APP_PAGES.app}`);
  if (a.public !== null) lines.push(`  Public address:       ${a.public}${APP_PAGES.app}`);
  return lines;
}

/** `turjuman start [run options]`. */
export async function startCommand(
  args: string[],
  io: CliIo,
  deps: StartDeps = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(START_HELP);
    return 0;
  }
  // The options of `run`, checked before the config is loaded (a wrong option: exit 2, index.ts).
  const { values } = parseArgs({ args, options: RUN_OPTIONS });
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  // The same .env files, in the same order, as the server reads them.
  loadEnvFiles(env, cwd);
  const configFile = typeof values.config === "string" ? values.config : undefined;
  // A first start makes config.yaml for this deployment (not with --config or --dry-run).
  const loaded = loadConfig({
    env,
    cwd,
    ...(configFile === undefined ? { create: values["dry-run"] !== true } : { configFile }),
  });
  if (loaded.createdConfigFile) {
    io.err(
      `Created ${loaded.createdConfigFile} (mode ${loaded.config.mode}, exposure ${loaded.config.server.exposure}).`,
    );
  }
  if (
    loaded.config.mode === "local" &&
    loaded.secrets.sonioxApiKey === null &&
    !storedLocalKeys(loaded).soniox
  ) {
    io.err(
      `No Soniox API key yet: run "${turjumanCmd("setup")}", or add it in the app under Keys. The server starts anyway.`,
    );
  }
  const run = deps.run ?? runCommand;
  if (values["dry-run"] === true) return run(args, io);
  const lines = appLines(serverAddresses(loaded, deps.lan === undefined ? {} : { lan: deps.lan }));
  let shown = false;
  return run(args, {
    out: (text) => {
      io.out(text);
      // The server's first line is its banner, printed once it listens.
      if (!shown) {
        shown = true;
        io.out(lines.join("\n"));
      }
    },
    err: (text) => io.err(text),
  });
}
