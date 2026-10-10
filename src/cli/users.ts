// `turjuman users add|list|passwd|remove`: the accounts of the app.
// Passwords come from stdin when it is piped; otherwise one is generated and printed once.
import { parseArgs } from "node:util";
import { generatePassword, hashPassword, passwordProblem } from "../accounts/passwords.js";
import { ScreenStore } from "../accounts/screens.js";
import {
  normalizeUsername,
  type UserRecord,
  UserStore,
  usernameProblem,
} from "../accounts/users.js";
import type { LoadedConfig } from "../config.js";
import { turjumanCmd } from "./hint.js";
import { serverAddresses } from "./urls.js";
import { isParseArgsError } from "./usage.js";

export interface UsersIo {
  out(text: string): void;
  err(text: string): void;
}

export interface UsersOptions {
  /** The piped password (first line of stdin), or null when stdin is a terminal or empty. */
  readPassword?: () => Promise<string | null>;
}

export const USERS_HELP = `turjuman users <command>

  add <username> [--admin] [--name "Display name"]
                    create an account for the app (/app); the password is read from stdin when
                    piped (echo '…' | turjuman users add …), otherwise generated and printed once
  list              list accounts: role, status, last login, screens
  passwd <username|e-mail>
                    set a new password (stdin or generated); logs the account out everywhere
  remove <username|e-mail>
                    delete an account (its screens keep running; then only admins manage them)`;

const STDIN_WAIT_MS = 5000;

/** First line of piped stdin (null for a terminal, an empty pipe, or nothing within 5 s). */
export function readPipedPassword(
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string | null> {
  if (stdin.isTTY === true) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Runs once: it removes every listener and the timer that could call it again.
    const finish = (): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", finish);
      stdin.pause();
      stdin.destroy();
      const text = Buffer.concat(chunks).toString("utf8");
      const line = (text.split(/\r?\n/)[0] ?? "").trim();
      resolve(line === "" ? null : line);
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      chunks.push(buf);
      size += buf.length;
      if (size > 4096 || buf.includes(0x0a)) finish();
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    stdin.on("data", onData);
    stdin.on("end", finish);
    stdin.on("error", finish);
    stdin.resume();
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DD HH:mm`, or "-". */
function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

/** The password to set: piped, or generated (then printed once). */
async function newPassword(
  opts: UsersOptions,
): Promise<{ password: string; generated: boolean } | { error: string }> {
  const piped = await (opts.readPassword ?? (() => readPipedPassword()))();
  if (piped === null) return { password: generatePassword(16), generated: true };
  const problem = passwordProblem(piped);
  return problem === null ? { password: piped, generated: false } : { error: problem };
}

async function usersAdd(
  args: string[],
  io: UsersIo,
  store: UserStore,
  loaded: LoadedConfig,
  opts: UsersOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { admin: { type: "boolean", default: false }, name: { type: "string" } },
  });
  const raw = positionals[0];
  if (raw === undefined || positionals.length > 1) {
    io.err(
      `users add: give exactly one username, e.g. ${turjumanCmd("users add abdullah --admin")}`,
    );
    return 2;
  }
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem !== null) {
    io.err(`users add: ${problem}`);
    return 2;
  }
  if (store.byUsername(username) !== undefined) {
    io.err(`users add: the username "${username}" is already taken`);
    return 1;
  }
  const pw = await newPassword(opts);
  if ("error" in pw) {
    io.err(`users add: ${pw.error}`);
    return 2;
  }
  const user = store.insert({
    username,
    ...(values.name === undefined ? {} : { displayName: values.name }),
    role: values.admin === true ? "admin" : "user",
    passwordHash: await hashPassword(pw.password),
  });
  io.out(
    `Created ${user.role === "admin" ? "admin" : "user"} account ${user.username} (${user.displayName}).`,
  );
  if (pw.generated) {
    io.out("");
    io.out(`  Password: ${pw.password}`);
    io.out("");
    io.out("This is the only time the password is shown; users.yaml keeps only a hash.");
  }
  const here = serverAddresses(loaded, { lan: null });
  io.out(
    `Log in at ${here.public ?? here.local}/login${here.public === null ? " on this computer" : ""}.`,
  );
  return 0;
}

function usersList(args: string[], io: UsersIo, store: UserStore, screens: ScreenStore): number {
  parseArgs({ args, options: {} }); // takes nothing (a wrong option: exit 2, index.ts)
  const users = store.list();
  if (store.error !== null) io.err(`Warning: ${store.error}`);
  if (users.length === 0) {
    io.out(
      `No accounts (${store.file}). Create the first admin with: ${turjumanCmd("users add <name> --admin")}`,
    );
    return 0;
  }
  const counts = screens.countByOwner();
  // Hosted servers: accounts log in by e-mail and belong to an organisation.
  const emails = users.some((u) => u.email !== null);
  const orgs = users.some((u) => u.orgId !== "local");
  const head = ["ID", "USERNAME", "NAME", "ROLE", "STATUS", "CREATED", "LAST LOGIN", "SCREENS"];
  const rows = [
    [
      ...head.slice(0, 2),
      ...(emails ? ["E-MAIL"] : []),
      ...(orgs ? ["ORG"] : []),
      ...head.slice(2),
    ],
  ];
  for (const u of users) {
    rows.push([
      u.id,
      u.username,
      ...(emails ? [u.email ?? "-"] : []),
      ...(orgs ? [u.orgId] : []),
      u.displayName,
      u.role,
      u.disabled ? "disabled" : "active",
      when(u.createdAt),
      when(u.lastLoginAt),
      String(counts.get(u.id) ?? 0),
    ]);
  }
  io.out(table(rows));
  return 0;
}

/** The arguments of passwd and remove: names only (a wrong option: exit 2, index.ts). */
function oneName(args: string[]): string[] {
  return parseArgs({ args, allowPositionals: true, options: {} }).positionals;
}

/** An account by username or e-mail address (hosted accounts log in by e-mail). */
function findUser(store: UserStore, name: string): UserRecord | string {
  const user = name.includes("@") ? store.byEmail(name) : store.byUsername(name);
  return user ?? `no account "${name.includes("@") ? name.trim() : normalizeUsername(name)}"`;
}

async function usersPasswd(
  args: string[],
  io: UsersIo,
  store: UserStore,
  opts: UsersOptions,
): Promise<number> {
  const [name, ...extra] = oneName(args);
  if (name === undefined || extra.length > 0) {
    io.err("users passwd: give exactly one username or e-mail address");
    return 2;
  }
  const user = findUser(store, name);
  if (typeof user === "string") {
    io.err(`users passwd: ${user}`);
    return 1;
  }
  const pw = await newPassword(opts);
  if ("error" in pw) {
    io.err(`users passwd: ${pw.error}`);
    return 2;
  }
  store.update(user.id, { passwordHash: await hashPassword(pw.password) });
  io.out(`New password set for ${user.username}; it is logged out on every device.`);
  if (pw.generated) {
    io.out("");
    io.out(`  Password: ${pw.password}`);
    io.out("");
    io.out("This is the only time the password is shown.");
  }
  return 0;
}

function usersRemove(args: string[], io: UsersIo, store: UserStore, screens: ScreenStore): number {
  const [name, ...extra] = oneName(args);
  if (name === undefined || extra.length > 0) {
    io.err("users remove: give exactly one username or e-mail address");
    return 2;
  }
  const user = findUser(store, name);
  if (typeof user === "string") {
    io.err(`users remove: ${user}`);
    return 1;
  }
  store.remove(user.id);
  const moved = screens.reassign(user.id, null);
  io.out(
    `Removed account ${user.username}.` +
      (moved > 0 ? ` Its ${moved} screen(s) keep running and are now managed by the admins.` : ""),
  );
  return 0;
}

/** `turjuman users add|list|passwd|remove`. */
export async function usersCommand(
  args: string[],
  io: UsersIo,
  loaded: LoadedConfig,
  opts: UsersOptions = {},
): Promise<number> {
  const [sub, ...rest] = args;
  const store = new UserStore(loaded.paths.usersFile);
  const screens = new ScreenStore(loaded.paths.screensFile);
  try {
    switch (sub) {
      case "add":
        return await usersAdd(rest, io, store, loaded, opts);
      case "list":
        return usersList(rest, io, store, screens);
      case "passwd":
        return await usersPasswd(rest, io, store, opts);
      case "remove":
        return usersRemove(rest, io, store, screens);
      case "help":
      case "--help":
      case "-h":
        io.out(USERS_HELP);
        return 0;
      default:
        io.err(sub === undefined ? USERS_HELP : `Unknown users command: ${sub}\n\n${USERS_HELP}`);
        return 2;
    }
  } catch (err) {
    if (isParseArgsError(err)) throw err; // a wrong option: exit 2 with the usage (index.ts)
    io.err(`users ${sub ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
