// `turjuman setup`: the Soniox API key into CONFIG_DIR/.env, checked with Soniox
// first (the free list-models call; a key Soniox cannot be asked about is saved anyway, marked
// unchecked), then the first admin account when there is none, then the next steps. `--check`
// only checks the key that is set.
// Keys come from the terminal (not shown while typed) or from files, never from the command line:
// other users of the machine can read command lines in the process list. Keys are never printed;
// at most their last four characters, so a person can tell keys apart.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { storedLocalKeyValues } from "../accounts/key-resolver.js";
import { hashPassword, MIN_PASSWORD_LENGTH, passwordProblem } from "../accounts/passwords.js";
import {
  checkProviderKey,
  type FetchLike,
  type KeyCheck,
  PROVIDER_NAMES,
} from "../accounts/provider-check.js";
import { normalizeUsername, UserStore, usernameProblem } from "../accounts/users.js";
import type { LoadedConfig } from "../config.js";
import type { KeyProvider } from "../shared/protocol.js";
import { readEnvFile, writeEnvFile } from "./env-file.js";
import { turjumanCmd } from "./hint.js";
import type { CliIo } from "./index.js";
import { confirm, type Prompter, TerminalPrompter } from "./prompt.js";
import { APP_PAGES, serverAddresses } from "./urls.js";
import { isParseArgsError, parseErrorText } from "./usage.js";

export interface SetupDeps {
  /** How provider checks reach the network (tests: a fake, no network). */
  fetch?: FetchLike;
  /** The questions (default: the terminal, opened only when a question is asked). */
  prompter?: Prompter;
  /** Where `--check` looks first (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Standard input for a key file named "-". */
  readStdin?: () => string;
}

const PROVIDER: KeyProvider = "soniox";

export const ENV_VARS: Readonly<Record<KeyProvider, string>> = {
  soniox: "SONIOX_API_KEY",
};

const ENV_HEADER = `# Turjuman: the API key for the speech engine (Soniox), written by \`turjuman setup\`.
# Keep this file private (mode 0600); never commit or share it.
`;

const HELP = `turjuman setup [--soniox-key-file <file>] [--yes]
turjuman setup --check

  Asks for your Soniox API key, checks it with Soniox (a free call; nothing is billed), saves it
  in .env in the config folder (only you can read it) and offers to create the first admin
  account. Run it again to change the key: Enter keeps the current one.

    Soniox   https://console.soniox.com → API keys

  --check                    check the key in the environment or .env; change nothing
  --soniox-key-file <file>   read the Soniox key from a file ("-" reads standard input)
  --yes                      ask nothing (scripts): the key from the file, or the current one
                             kept; no admin account is created

  Keys are never given on the command line: other users of this computer could read them there.`;

type Obtained =
  /** A key to save (checked: ok or unchecked). */
  | { kind: "new"; key: string }
  /** The key in .env stays. */
  | { kind: "kept" }
  /** Stop with this exit code (the reason was printed). */
  | { kind: "stop"; code: number };

interface Run {
  io: CliIo;
  loaded: LoadedConfig;
  envFile: string;
  interactive: boolean;
  prompter: () => Prompter;
  fetch: FetchLike | undefined;
  readStdin: () => string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The last four characters, so a person can recognise a key without seeing it. */
function tail(key: string): string {
  return `…${key.slice(-4)}`;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/** The first non-empty line of a key file ("-": standard input), or a problem. */
function readKeyFile(path: string, readStdin: () => string): { key: string } | { error: string } {
  let text: string;
  try {
    text = path === "-" ? readStdin() : readFileSync(path, "utf8");
  } catch (err) {
    return { error: `cannot read the key file: ${errorText(err)}` };
  }
  const line = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined)
    return { error: `the key file ${path === "-" ? "(stdin)" : path} is empty` };
  return { key: line };
}

/** Check a key with its provider and say what came of it. */
async function checkKey(run: Run, provider: KeyProvider, key: string): Promise<KeyCheck> {
  const name = PROVIDER_NAMES[provider];
  run.io.out(`  Checking the key with ${name}...`);
  const result = await checkProviderKey(
    provider,
    key,
    run.fetch === undefined ? {} : { fetch: run.fetch },
  );
  if (result.result === "ok") {
    run.io.out(`  OK: ${name} accepted the key.`);
  } else if (result.result === "unchecked") {
    run.io.err(
      `  Unchecked: ${result.message} It is saved anyway; check it later with: ${turjumanCmd("setup --check")}`,
    );
  } else {
    run.io.err(`  Not accepted: ${result.message}`);
  }
  return result;
}

/** Null from the prompter: Ctrl-C cancels everything; the end of the input ends this question. */
function endOfInput(run: Run, what: string): Obtained {
  if (run.prompter().interrupted) {
    run.io.err("Setup cancelled; nothing was saved.");
    return { kind: "stop", code: 130 };
  }
  run.io.err(
    `No ${what} was given (the input ended); nothing was saved. ` +
      `For scripts: ${turjumanCmd("setup --yes --soniox-key-file <file>")}`,
  );
  return { kind: "stop", code: 1 };
}

/** Ask on the terminal until the provider accepts a key (or it cannot be checked). */
async function askKey(run: Run, provider: KeyProvider, current: string | null): Promise<Obtained> {
  const name = PROVIDER_NAMES[provider];
  run.io.out("");
  run.io.out(`${name} API key (required: speech recognition and translation).`);
  run.io.out("  Get one at https://console.soniox.com → API keys.");
  let existing = current;
  for (;;) {
    const hint = existing !== null ? ` (Enter keeps the current key ${tail(existing)})` : "";
    const answer = await run.prompter().askSecret(`  ${name} API key${hint}: `);
    if (answer === null) return endOfInput(run, `${name} key`);
    const typed = answer.trim();
    if (typed === "") {
      if (existing === null) {
        run.io.err(`  The ${name} key is required.`);
        continue;
      }
      if ((await checkKey(run, provider, existing)).result !== "rejected") return { kind: "kept" };
      run.io.err(`  Enter a new ${name} key.`);
      existing = null;
      continue;
    }
    if ((await checkKey(run, provider, typed)).result !== "rejected") {
      return { kind: "new", key: typed };
    }
  }
}

/** One provider's key: from its file, from the terminal, or the current one kept. */
async function obtainKey(
  run: Run,
  provider: KeyProvider,
  file: string | undefined,
  current: string | null,
): Promise<Obtained> {
  const name = PROVIDER_NAMES[provider];
  if (file !== undefined) {
    run.io.out("");
    run.io.out(`${name} API key: from ${file === "-" ? "standard input" : file}`);
    const read = readKeyFile(file, run.readStdin);
    if ("error" in read) {
      run.io.err(`setup: ${read.error}`);
      return { kind: "stop", code: 2 };
    }
    if ((await checkKey(run, provider, read.key)).result === "rejected") {
      run.io.err(`Nothing was saved: give a ${name} key that ${name} accepts.`);
      return { kind: "stop", code: 1 };
    }
    return { kind: "new", key: read.key };
  }
  if (run.interactive) return askKey(run, provider, current);
  if (current !== null) {
    run.io.out(`${name} API key: keeping the current key ${tail(current)}.`);
    return { kind: "kept" };
  }
  run.io.err(
    "setup: no Soniox key: give --soniox-key-file <file>, or run setup without --yes to type it.",
  );
  return { kind: "stop", code: 2 };
}

/**
 * Offer the first admin account when there is none (local mode: setup ends earlier on a hosted
 * server). Returns an exit code to stop.
 */
async function firstAdmin(run: Run): Promise<number | null> {
  const { io, loaded } = run;
  const store = new UserStore(loaded.paths.usersFile);
  const count = store.count();
  if (store.error !== null) {
    io.err(`Warning: ${store.error}`);
    io.err(
      `  Fix that file, then create the first admin: ${turjumanCmd("users add <name> --admin")}`,
    );
    return null;
  }
  if (count > 0) {
    io.out(`Accounts: ${count} already (${turjumanCmd("users list")}).`);
    return null;
  }
  const later = `${turjumanCmd("users add <name> --admin")}, or at ${serverAddresses(loaded, { lan: null }).local}/login`;
  if (!run.interactive) {
    io.out(`No account yet. Create the first admin with: ${later}.`);
    return null;
  }
  const p = run.prompter();
  const stopped = (): number | null => {
    if (p.interrupted) {
      io.err("Cancelled: the keys are saved; no admin account was made.");
      return 130;
    }
    io.out(`No admin account was made (the input ended). Later: ${later}.`);
    return null;
  };
  io.out("");
  io.out("First admin account (to log in to the app):");
  const create = await confirm(p, "  Create it now?", true);
  if (create === null) return stopped();
  if (!create) {
    io.out(`  Skipped. Later: ${later}.`);
    return null;
  }
  let username = "";
  for (;;) {
    const raw = await p.ask("  Username: ");
    if (raw === null) return stopped();
    username = normalizeUsername(raw);
    const problem = usernameProblem(username);
    if (problem !== null) io.err(`  ${problem}.`);
    else if (store.byUsername(username) !== undefined) io.err(`  "${username}" is taken.`);
    else break;
  }
  let password = "";
  for (;;) {
    const first = await p.askSecret(`  Password (at least ${MIN_PASSWORD_LENGTH} characters): `);
    if (first === null) return stopped();
    const problem = passwordProblem(first);
    if (problem !== null) {
      io.err(`  ${problem}.`);
      continue;
    }
    const again = await p.askSecret("  Password again: ");
    if (again === null) return stopped();
    if (again === first) {
      password = first;
      break;
    }
    io.err("  The two passwords differ; try again.");
  }
  const user = store.insert({
    username,
    role: "admin",
    passwordHash: await hashPassword(password),
  });
  io.out(`  Created admin account ${user.username}.`);
  return null;
}

/**
 * `turjuman setup --check`: OK, not accepted or unchecked; exit 1 when the key fails or is missing.
 * The key the server uses: the environment or .env first, else the one added in the app.
 */
async function checkKeys(
  io: CliIo,
  envFile: string,
  env: NodeJS.ProcessEnv,
  fetch: FetchLike | undefined,
  inApp: Record<KeyProvider, string | null>,
): Promise<number> {
  const fromFile = readEnvFile(envFile);
  io.out(
    `Checking the API key in the environment, ${envFile} and the app (a free call; nothing is billed):`,
  );
  const provider = PROVIDER;
  const name = PROVIDER_NAMES[provider].padEnd(7);
  const own = nonEmpty(env[ENV_VARS[provider]]) ?? nonEmpty(fromFile[ENV_VARS[provider]]);
  const key = own ?? inApp[provider];
  if (key === null) {
    io.out(
      `  ${name} missing        required: add it with ${turjumanCmd("setup")}, or in the app under Keys`,
    );
    return 1;
  }
  const where = own === null ? " (added in the app)" : "";
  const result = await checkProviderKey(provider, key, fetch === undefined ? {} : { fetch });
  if (result.result === "ok") {
    io.out(`  ${name} OK             key ${tail(key)}${where}`);
    return 0;
  }
  if (result.result === "unchecked") {
    io.out(`  ${name} unchecked      ${result.message}${where}`);
    return 0;
  }
  io.out(`  ${name} not accepted   ${result.message}${where}`);
  return 1;
}

/** `turjuman setup [--check] [--soniox-key-file f] [--yes]`. */
export async function setupCommand(
  args: string[],
  io: CliIo,
  load: () => LoadedConfig,
  deps: SetupDeps = {},
): Promise<number> {
  let values: {
    check: boolean;
    yes: boolean;
    help: boolean;
    "soniox-key-file"?: string | undefined;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        check: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
        "soniox-key-file": { type: "string" },
      },
    }));
  } catch (err) {
    io.err(`setup: ${isParseArgsError(err) ? parseErrorText(err) : errorText(err)}\n\n${HELP}`);
    return 2;
  }
  if (values.help || args[0] === "help") {
    io.out(HELP);
    return 0;
  }
  if (positionals.length > 0) {
    // Never echo it: it may be a key typed on the command line.
    io.err(
      "setup: takes no arguments. The key comes from the terminal or from --soniox-key-file, " +
        "never from the command line.",
    );
    return 2;
  }
  const sonioxFile = values["soniox-key-file"];
  if (values.check && sonioxFile !== undefined) {
    io.err("setup: --check checks the saved key; it takes no key file.");
    return 2;
  }
  const loaded = load();
  if (loaded.config.mode === "hosted") {
    // Hosted mode never uses server-wide keys: each mosque adds its own in the app.
    io.out(
      "Hosted mode: every mosque adds its own API keys in the app (/app/keys), stored encrypted.\n" +
        `There are no server keys to set. Start the server with: ${turjumanCmd("start")}\n` +
        "Keep master.key (or TURJUMAN_MASTER_KEY) safe: see\n" +
        "https://github.com/turjuman-translator/website/blob/main/docs/hosting.md",
    );
    return 0;
  }
  const envFile = join(loaded.paths.configDir, ".env");
  if (values.check) {
    return checkKeys(
      io,
      envFile,
      deps.env ?? process.env,
      deps.fetch,
      storedLocalKeyValues(loaded),
    );
  }

  let prompter: Prompter | null = deps.prompter ?? null;
  const run: Run = {
    io,
    loaded,
    envFile,
    interactive: !values.yes,
    prompter: () => {
      prompter ??= new TerminalPrompter();
      return prompter;
    },
    fetch: deps.fetch,
    readStdin: deps.readStdin ?? (() => readFileSync(0, "utf8")),
  };
  try {
    const current = readEnvFile(envFile);
    io.out(`Turjuman setup. Your API key is saved in ${envFile} (only you can read it).`);
    const variable = ENV_VARS[PROVIDER];
    const got = await obtainKey(run, PROVIDER, sonioxFile, nonEmpty(current[variable]));
    if (got.kind === "stop") return got.code;
    io.out("");
    if (got.kind === "new") {
      writeEnvFile(envFile, { [variable]: got.key }, ENV_HEADER);
      io.out(`Saved ${variable} (${tail(got.key)}) in ${envFile} (mode 0600).`);
    } else if (existsSync(envFile)) {
      chmodSync(envFile, 0o600);
      io.out(`No key changed; ${envFile} stays as it is (mode 0600).`);
    }
    const stop = await firstAdmin(run);
    if (stop !== null) return stop;
    io.out("");
    io.out("Next steps:");
    io.out(`  1. Start Turjuman:  ${turjumanCmd("start")}`);
    io.out(
      `  2. Open the app:    ${serverAddresses(loaded, { lan: null }).local}${APP_PAGES.app}   (or: ${turjumanCmd("open")})`,
    );
    return 0;
  } catch (err) {
    io.err(`setup: ${errorText(err)}`);
    return 1;
  } finally {
    prompter?.close();
  }
}
