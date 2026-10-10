// `turjuman orgs list|disable|enable`: the server operator's view of the
// organisations of a hosted server. Works on orgs.yaml directly; a running server picks the change
// up through its mtime (a disabled organisation's accounts are logged out and its caption pages
// stop within about ten seconds). Keys are never printed: only whether they are set.
import { parseArgs } from "node:util";
import { KEY_PROVIDERS } from "../accounts/key-resolver.js";
import { LOCAL_ORG_ID, OrgStore } from "../accounts/orgs.js";
import { ScreenStore } from "../accounts/screens.js";
import { UserStore } from "../accounts/users.js";
import type { LoadedConfig } from "../config.js";
import { orgUsageKey, UsageStore } from "../core/usage.js";
import { turjumanCmd } from "./hint.js";
import { isParseArgsError } from "./usage.js";

export interface OrgsIo {
  out(text: string): void;
  err(text: string): void;
}

export const ORGS_HELP = `turjuman orgs <command>              (the server's operator; hosted mode)

  list              organisations: name, state, owner, accounts, screens, keys, minutes this month
  disable <id>      switch an organisation off: its accounts are logged out and its screens stop
  enable <id>       switch it on again`;

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

function list(io: OrgsIo, loaded: LoadedConfig): number {
  const orgs = new OrgStore(loaded.paths.orgsFile);
  const users = new UserStore(loaded.paths.usersFile);
  const screens = new ScreenStore(loaded.paths.screensFile);
  const entries = orgs.list();
  if (orgs.error !== null) io.err(`Warning: ${orgs.error}`);
  if (entries.length === 0) {
    io.out(
      loaded.config.mode === "hosted"
        ? "No organisations yet: mosques sign up at /signup."
        : "Local mode: one organisation (this server). Hosted mode is set with mode: hosted.",
    );
    return 0;
  }
  const usage = new UsageStore({ dir: loaded.paths.usageDir, flushIntervalMs: 0 });
  // Hosted sessions count as "org:<id>"; everything else (access keys, local) is the local one's.
  const minutes = new Map<string, number>();
  for (const row of usage.report().rows) {
    const id = row.keyId.startsWith("org:") ? row.keyId : orgUsageKey(LOCAL_ORG_ID);
    minutes.set(id, (minutes.get(id) ?? 0) + row.monthMinutes);
  }
  const rows = [["ID", "NAME", "STATE", "OWNER", "ACCOUNTS", "SCREENS", "KEYS", "MIN/MONTH"]];
  for (const org of entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const members = users.inOrg(org.id);
    const owner = members.find((u) => u.role === "owner");
    const keys = KEY_PROVIDERS.filter((p) => org.keys[p] !== undefined);
    const used = minutes.get(orgUsageKey(org.id)) ?? 0;
    rows.push([
      org.id,
      org.name,
      org.disabled ? "disabled" : "on",
      owner?.email ?? owner?.username ?? "-",
      String(members.length),
      String(screens.inOrg(org.id).length),
      keys.length === 0 ? "-" : keys.join(","),
      used.toFixed(1),
    ]);
  }
  io.out(table(rows));
  return 0;
}

function setDisabled(
  io: OrgsIo,
  loaded: LoadedConfig,
  id: string | undefined,
  disabled: boolean,
): number {
  if (id === undefined || id === "") {
    io.err(
      `Which organisation? ${turjumanCmd(`orgs ${disabled ? "disable" : "enable"} <id>`)} (see ${turjumanCmd("orgs list")})`,
    );
    return 2;
  }
  const orgs = new OrgStore(loaded.paths.orgsFile);
  if (orgs.list().every((o) => o.id !== id)) {
    io.err(`No organisation "${id}" (see ${turjumanCmd("orgs list")})`);
    return 1;
  }
  const org = orgs.setDisabled(id, disabled);
  io.out(
    disabled
      ? `Disabled ${org.name} (${org.id}): its accounts are logged out and its screens stop.`
      : `Enabled ${org.name} (${org.id}).`,
  );
  return 0;
}

/** `turjuman orgs list|disable|enable`. */
export async function orgsCommand(
  args: string[],
  io: OrgsIo,
  loaded: LoadedConfig,
): Promise<number> {
  const [sub, ...rest] = args;
  try {
    // list takes nothing; enable/disable exactly one id (a wrong option: exit 2, index.ts)
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    const id = positionals[0];
    if (positionals.length > (sub === "list" ? 0 : 1)) {
      io.err(`Too many arguments.\n\n${ORGS_HELP}`);
      return 2;
    }
    switch (sub) {
      case "list":
        return list(io, loaded);
      case "disable":
        return setDisabled(io, loaded, id, true);
      case "enable":
        return setDisabled(io, loaded, id, false);
      case "help":
      case "--help":
      case "-h":
        io.out(ORGS_HELP);
        return 0;
      default:
        io.err(sub === undefined ? ORGS_HELP : `Unknown orgs command: ${sub}\n\n${ORGS_HELP}`);
        return 2;
    }
  } catch (err) {
    if (isParseArgsError(err)) throw err;
    io.err(`orgs ${sub ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
