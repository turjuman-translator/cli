// `turjuman screens list|add|url|enable|disable|rm`: caption screens and their
// screen links, read and written straight in CONFIG_DIR/screens.yaml through ScreenStore (a running
// server re-reads the file when its mtime changes). A screen made here is what the builder would
// save: the same language-pair check as POST /api/screens and the same minimal look query
// (themeQuery: preset, layout, size; only what differs from the server's default).
import { parseArgs } from "node:util";
import {
  type Actor,
  cleanScreenName,
  type ScreenRecord,
  ScreenStore,
  sanitizeQuery,
  screenUrl,
} from "../accounts/screens.js";
import type { LoadedConfig } from "../config.js";
import { loadLanguages } from "../languages.js";
import { PresetStore } from "../presets.js";
import { BUILTIN_PRESETS, findPreset, OPTION_SPECS, themeQuery } from "../shared/theme.js";
import type { DisplayOptions } from "../shared/theme-vars.js";
import { turjumanCmd } from "./hint.js";
import type { CliIo } from "./index.js";
import { confirm, type Prompter, TerminalPrompter } from "./prompt.js";
import { type Addresses, feedOrigin, serverAddresses } from "./urls.js";
import { isParseArgsError, parseErrorText } from "./usage.js";

export interface ScreensDeps {
  /** The question of `rm` (default: the terminal). */
  prompter?: Prompter;
  /** This machine's LAN address for screen links (default: looked up). */
  lan?: string | null;
}

/** lastChange.by of changes made with the CLI. */
export const CLI_ACTOR: Actor = { id: null, name: "cli" };

const SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "add", "url", "enable", "disable", "rm"]);

function help(): string {
  return `turjuman screens <command>

  list [--json]            every screen: id, name, languages, on/off and its screen link
  add --name <name> --from <code> --to <code> [--preset <id>] [--layout blocks|rollup]
      [--size <px>] [--enable] [--json]
                           make a screen and print its screen link (it starts off unless --enable)
  url <id> [--local]       print a screen's link (--local: the http://127.0.0.1 link for OBS
                           on this computer, when the screen links use HTTPS)
  enable <id>              switch a screen on
  disable <id>             switch a screen off
  rm <id> [--yes]          delete a screen: its link stops working (asks first unless --yes)

  <id> is the id that "screens list" shows, or the screen's exact name.
  Languages: the codes in languages.yaml (ar, nl, en, ...).
  Looks (--preset): ${wrapList(BUILTIN_PRESETS.map((p) => p.id))},
    or your own, made at /app/look.
  The page listens to the default microphone of the computer that shows it; to pick another,
  edit the screen in the app (its Microphone step).
  OBS needs only the screen link. Anyone who has it can show the screen: share it like a key.`;
}

/** A comma-separated list, wrapped below 100 columns; continuation lines indented by four. */
function wrapList(items: readonly string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line === "" ? item : `${line}, ${item}`;
    // The first line follows "  Looks (--preset): " (20 columns); the others "    " (4).
    if (line !== "" && next.length > (lines.length === 0 ? 76 : 92)) {
      lines.push(`${line},`);
      line = item;
    } else line = next;
  }
  lines.push(line);
  return lines.join("\n    ");
}

interface Ctx {
  io: CliIo;
  loaded: LoadedConfig;
  store: ScreenStore;
  addresses: Addresses;
  /** The origin of screen links (feedOrigin). */
  origin: string;
  deps: ScreensDeps;
}

/** A command-line mistake: exit code 2. */
class UsageError extends Error {}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...cell].length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function newestFirst(list: ScreenRecord[]): ScreenRecord[] {
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What `--json` shows of a screen: its link, and the one for this computer. */
function view(s: ScreenRecord, ctx: Ctx) {
  return {
    id: s.id,
    name: s.name,
    from: s.from,
    to: s.to,
    enabled: s.enabled,
    url: screenUrl(ctx.origin, s),
    localUrl: screenUrl(ctx.addresses.local, s),
    query: s.query,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** The screen links use HTTPS for other devices; OBS on this computer can use 127.0.0.1. */
function viaHttps(ctx: Ctx): boolean {
  return ctx.origin !== ctx.addresses.local && ctx.addresses.public === null;
}

/** By id, or by exact (case-insensitive) name when only one screen has it. */
function findScreen(store: ScreenStore, ref: string | undefined): ScreenRecord {
  if (ref === undefined || ref.trim() === "") {
    throw new UsageError(`give a screen id (see: ${turjumanCmd("screens list")})`);
  }
  const byId = store.get(ref.trim());
  if (byId !== undefined) return byId;
  const name = ref.trim().toLowerCase();
  const named = store.list().filter((s) => s.name.toLowerCase() === name);
  const only = named[0];
  if (named.length === 1 && only !== undefined) return only;
  if (named.length > 1) {
    throw new Error(
      `${named.length} screens are called "${ref.trim()}"; use an id: ${named.map((s) => s.id).join(", ")}`,
    );
  }
  throw new Error(`no screen "${ref.trim()}" (see: ${turjumanCmd("screens list")})`);
}

/** The one <id> argument of url/enable/disable/rm. */
function oneScreen(store: ScreenStore, positionals: string[]): ScreenRecord {
  if (positionals.length > 1) {
    throw new UsageError('give one screen (quote a name with spaces: "Main hall")');
  }
  return findScreen(store, positionals[0]);
}

function list(args: string[], ctx: Ctx): number {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      // The old `captions screens list --links`: links are always shown now.
      links: { type: "boolean", default: false },
    },
  });
  const screens = newestFirst(ctx.store.list());
  if (ctx.store.error !== null) ctx.io.err(`Warning: ${ctx.store.error}`);
  if (values.json) {
    ctx.io.out(
      JSON.stringify(
        screens.map((s) => view(s, ctx)),
        null,
        2,
      ),
    );
    return 0;
  }
  if (screens.length === 0) {
    ctx.io.out(
      `No screens yet. Make one: ${turjumanCmd('screens add --name "Main hall" --from ar --to nl')}\n` +
        `or in the app: ${ctx.addresses.public ?? ctx.addresses.local}/app/new`,
    );
    return 0;
  }
  // Hosted servers: screens belong to organisations (the operator sees them all).
  const orgs = screens.some((s) => s.orgId !== "local");
  const rows = [["ID", "NAME", ...(orgs ? ["ORG"] : []), "LANGUAGES", "STATE", "SCREEN LINK"]];
  for (const s of screens) {
    rows.push([
      s.id,
      s.name,
      ...(orgs ? [s.orgId] : []),
      `${s.from} → ${s.to}`,
      s.enabled ? "on" : "off",
      screenUrl(ctx.origin, s),
    ]);
  }
  ctx.io.out(table(rows));
  if (viaHttps(ctx)) {
    ctx.io.out(
      `\nThe links use HTTPS, for other devices. OBS on this computer can use ${ctx.addresses.local}/feed/…: ${turjumanCmd("screens url <id> --local")}`,
    );
  }
  return 0;
}

/** The look query the builder would save for this preset/layout/size (without "?"). */
export function lookQuery(
  loaded: LoadedConfig,
  look: { preset?: string; layout?: string; size?: string },
): string {
  const custom = new PresetStore(
    loaded.paths.presetsFile,
    new Set(BUILTIN_PRESETS.map((p) => p.id)),
  ).list();
  const defaultPreset = loaded.config.display.preset;
  let presetId = defaultPreset;
  if (look.preset !== undefined) {
    const preset = findPreset(look.preset, custom);
    if (preset === undefined) {
      throw new UsageError(
        `unknown preset "${look.preset}" (built in: ${BUILTIN_PRESETS.map((p) => p.id).join(", ")}; ` +
          "custom ones come from /app/look)",
      );
    }
    presetId = preset.id;
  }
  const options: Partial<DisplayOptions> = {};
  if (look.layout !== undefined) {
    if (look.layout !== "blocks" && look.layout !== "rollup") {
      throw new UsageError(`--layout is blocks or rollup, not "${look.layout}"`);
    }
    options.layout = look.layout;
  }
  if (look.size !== undefined) {
    const kind = OPTION_SPECS.size.kind;
    const [min, max] = kind.type === "int" ? [kind.min, kind.max] : [8, 300];
    const size = Number(look.size);
    if (!Number.isInteger(size) || size < min || size > max) {
      throw new UsageError(`--size is a whole number of pixels from ${min} to ${max}`);
    }
    options.size = size;
  }
  return sanitizeQuery(themeQuery(presetId, {}, options, { custom, defaultPreset }));
}

function add(args: string[], ctx: Ctx): number {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      preset: { type: "string" },
      layout: { type: "string" },
      size: { type: "string" },
      enable: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const { loaded, io } = ctx;
  if (loaded.config.mode === "hosted") {
    throw new UsageError(
      "in hosted mode every mosque makes its own screens in the app; this adds screens in local mode",
    );
  }
  const name = cleanScreenName(values.name ?? "");
  if (name === null) throw new UsageError('give the screen a name: --name "Main hall"');
  const from = values.from?.trim().toLowerCase() ?? "";
  const to = values.to?.trim().toLowerCase() ?? "";
  if (from === "" || to === "") {
    throw new UsageError("give the languages: --from <code> --to <code>, e.g. --from ar --to nl");
  }
  // Like POST /api/screens: the caption page must accept the pair.
  const pairProblem = loadLanguages(loaded.paths.languagesFile).validatePair(from, to);
  if (pairProblem !== null) throw new UsageError(pairProblem);
  const query = lookQuery(loaded, {
    ...(values.preset === undefined ? {} : { preset: values.preset }),
    ...(values.layout === undefined ? {} : { layout: values.layout }),
    ...(values.size === undefined ? {} : { size: values.size }),
  });
  let screen = ctx.store.create({ name, from, to, query, ownerId: null }, CLI_ACTOR);
  if (values.enable) screen = ctx.store.update(screen.id, { enabled: true }, "enabled", CLI_ACTOR);
  const url = screenUrl(ctx.origin, screen);
  if (values.json) {
    io.out(JSON.stringify(view(screen, ctx), null, 2));
    return 0;
  }
  io.out(
    `Created screen ${screen.id} "${screen.name}" (${screen.from} → ${screen.to}, ${screen.enabled ? "on" : "off"}).`,
  );
  io.out(`Screen link for OBS: ${url}`);
  if (viaHttps(ctx)) io.out(`On this computer:  ${screenUrl(ctx.addresses.local, screen)}`);
  if (!screen.enabled)
    io.out(`It is off: switch it on with: ${turjumanCmd(`screens enable ${screen.id}`)}`);
  return 0;
}

function url(args: string[], ctx: Ctx): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { local: { type: "boolean", default: false } },
  });
  const origin = values.local ? ctx.addresses.local : ctx.origin;
  ctx.io.out(screenUrl(origin, oneScreen(ctx.store, positionals)));
  return 0;
}

function setEnabled(args: string[], ctx: Ctx, on: boolean): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const screen = oneScreen(ctx.store, positionals);
  const state = on ? "on" : "off";
  if (screen.enabled === on) {
    ctx.io.out(`Screen ${screen.id} "${screen.name}" is ${state} already.`);
    return 0;
  }
  ctx.store.update(screen.id, { enabled: on }, on ? "enabled" : "disabled", CLI_ACTOR);
  ctx.io.out(`Screen ${screen.id} "${screen.name}" is now ${state}.`);
  // A running server applies the change to the open screen pages within a few seconds.
  ctx.io.out(
    on
      ? "Screens that are open start showing captions within a few seconds."
      : "Captions on screens that are open stop within a few seconds.",
  );
  return 0;
}

async function rm(args: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean", short: "y", default: false } },
  });
  const screen = oneScreen(ctx.store, positionals);
  if (!values.yes) {
    const prompter = ctx.deps.prompter ?? new TerminalPrompter();
    let sure: boolean | null;
    try {
      sure = await confirm(
        prompter,
        `Delete screen ${screen.id} "${screen.name}" (${screen.from} → ${screen.to})? Its link stops working.`,
        false,
      );
    } finally {
      prompter.close();
    }
    if (sure !== true) {
      ctx.io.out(
        `Not deleted${sure === null ? " (no answer; add --yes to delete without asking)" : ""}.`,
      );
      return 1;
    }
  }
  ctx.store.remove(screen.id);
  ctx.io.out(
    `Deleted screen ${screen.id} "${screen.name}". Its link no longer works; pages still showing it stop within a few seconds.`,
  );
  return 0;
}

/** `turjuman screens list|add|url|enable|disable|rm`. */
export async function screensCommand(
  args: string[],
  io: CliIo,
  load: () => LoadedConfig,
  deps: ScreensDeps = {},
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    io.err(help());
    return 2;
  }
  const asksHelp = (a: string): boolean => a === "help" || a === "--help" || a === "-h";
  if (asksHelp(sub) || rest.some((a) => a === "--help" || a === "-h")) {
    io.out(help());
    return 0;
  }
  if (!SUBCOMMANDS.has(sub)) {
    io.err(`Unknown screens command: ${sub}\n\n${help()}`);
    return 2;
  }
  const loaded = load();
  const addresses = serverAddresses(loaded, deps.lan === undefined ? {} : { lan: deps.lan });
  const ctx: Ctx = {
    io,
    loaded,
    store: new ScreenStore(loaded.paths.screensFile),
    addresses,
    origin: feedOrigin(addresses),
    deps,
  };
  try {
    switch (sub) {
      case "list":
        return list(rest, ctx);
      case "add":
        return add(rest, ctx);
      case "url":
        return url(rest, ctx);
      case "enable":
        return setEnabled(rest, ctx, true);
      case "disable":
        return setEnabled(rest, ctx, false);
      default:
        return await rm(rest, ctx);
    }
  } catch (err) {
    if (isParseArgsError(err)) {
      io.err(`screens ${sub}: ${parseErrorText(err)}\n\n${help()}`);
      return 2;
    }
    io.err(`screens ${sub}: ${errorText(err)}`);
    return err instanceof UsageError ? 2 : 1;
  }
}
