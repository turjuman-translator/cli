// `turjuman keys add|list|revoke` and `turjuman usage`: access keys for remote caption pages.
import { parseArgs } from "node:util";
import { type AccessKeyInfo, KeyStore } from "../auth/keys.js";
import type { LoadedConfig } from "../config.js";
import { LOCAL_KEY_ID, monthKey, UsageStore } from "../core/usage.js";
import { turjumanCmd } from "./hint.js";
import { isParseArgsError } from "./usage.js";

export interface KeysIo {
  out(text: string): void;
  err(text: string): void;
}

export const KEYS_HELP = `turjuman keys <command>

  add --label <name> [--daily-minutes <n>] [--expires <date>]
                    create an access key for remote caption pages; it is printed once
                    (only its SHA-256 hash is stored in keys.yaml)
  list              list keys: labels, limits, last use (never the keys themselves)
  revoke <id>       delete a key; pages using it are refused from then on`;

export const USAGE_HELP = `turjuman usage [--month YYYY-MM]

  Streamed minutes per access key and engine: today and this month (or the given month).`;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DD HH:mm`, or "-". */
function when(iso: string | undefined): string {
  if (iso === undefined) return "-";
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

/** An expiry given as a date without a time (stored as midnight UTC) is shown as that date. */
function expiry(iso: string | undefined): string {
  if (iso !== undefined && /T00:00:00(\.000)?Z$/.test(iso)) return iso.slice(0, 10);
  return when(iso);
}

function describeLimits(k: AccessKeyInfo): string {
  const daily = k.dailyMinutes === null ? "no daily limit" : `daily limit ${k.dailyMinutes} min`;
  const expires = k.expires === undefined ? "" : `; expires ${expiry(k.expires)}`;
  return `${daily}${expires}`;
}

function keysAdd(args: string[], io: KeysIo, store: KeyStore, loaded: LoadedConfig): number {
  // "--daily-minutes -3" is a wrong number, not a missing value (parseArgs calls it ambiguous).
  const minutesAt = args.indexOf("--daily-minutes");
  if (minutesAt >= 0 && /^-\d/.test(args[minutesAt + 1] ?? "")) {
    io.err("keys add: --daily-minutes must be a positive number");
    return 2;
  }
  const { values } = parseArgs({
    args,
    options: {
      label: { type: "string" },
      "daily-minutes": { type: "string" },
      expires: { type: "string" },
    },
  });
  if (values.label === undefined || values.label.trim() === "") {
    io.err('keys add: --label "<name>" is required');
    return 2;
  }
  let dailyMinutes: number | null = null;
  if (values["daily-minutes"] !== undefined) {
    dailyMinutes = Number(values["daily-minutes"]);
    if (!Number.isFinite(dailyMinutes) || dailyMinutes <= 0) {
      io.err("keys add: --daily-minutes must be a positive number");
      return 2;
    }
  }
  if (values.expires !== undefined && Number.isNaN(Date.parse(values.expires))) {
    io.err("keys add: --expires must be a date, e.g. 2027-01-01");
    return 2;
  }
  const { id, key, entry } = store.add({
    label: values.label,
    dailyMinutes,
    ...(values.expires === undefined ? {} : { expires: values.expires }),
  });
  const { config } = loaded;
  const host =
    config.server.exposure === "public" ? "<your-domain>" : `<server>:${config.server.port}`;
  const scheme = config.server.exposure === "public" ? "https" : "http";
  io.out(`Created access key ${id} "${entry.label}" (${describeLimits(entry)})`);
  io.out("");
  io.out(`  ${key}`);
  io.out("");
  io.out(`This is the only time the key is shown; ${store.file} keeps only its hash.`);
  io.out(`Add it to caption page URLs as ?key=…, e.g. ${scheme}://${host}/ar/nl?key=${key}`);
  if (config.server.exposure === "local") {
    io.out('Note: server.exposure is "local", where pages need no key (keys apply to lan/public).');
  }
  return 0;
}

function keysList(args: string[], io: KeysIo, store: KeyStore): number {
  parseArgs({ args, options: {} }); // takes nothing (a wrong option: exit 2, index.ts)
  const keys = store.list();
  if (store.error !== null) io.err(`Warning: ${store.error}`);
  if (keys.length === 0) {
    io.out(
      `No access keys (${store.file}). Create one with: ${turjumanCmd('keys add --label "<name>"')}`,
    );
    return 0;
  }
  const rows = [["ID", "LABEL", "DAILY MIN", "EXPIRES", "CREATED", "LAST USED"]];
  for (const k of keys) {
    rows.push([
      k.id,
      k.label,
      k.dailyMinutes === null ? "-" : String(k.dailyMinutes),
      expiry(k.expires),
      when(k.createdAt),
      when(k.lastUsedAt),
    ]);
  }
  io.out(table(rows));
  return 0;
}

/** `turjuman keys add|list|revoke`. */
export async function keysCommand(
  args: string[],
  io: KeysIo,
  loaded: LoadedConfig,
): Promise<number> {
  const [sub, ...rest] = args;
  const store = new KeyStore(loaded.paths.keysFile);
  try {
    switch (sub) {
      case "add":
        return keysAdd(rest, io, store, loaded);
      case "list":
        return keysList(rest, io, store);
      case "revoke": {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        const id = positionals[0];
        if (id === undefined || positionals.length > 1) {
          io.err(`keys revoke: give exactly one key id (see ${turjumanCmd("keys list")})`);
          return 2;
        }
        const removed = store.revoke(id);
        if (removed === undefined) {
          io.err(`keys revoke: no key with id ${id}`);
          return 1;
        }
        io.out(`Revoked key ${removed.id} "${removed.label}".`);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        io.out(KEYS_HELP);
        return 0;
      default:
        io.err(sub === undefined ? KEYS_HELP : `Unknown keys command: ${sub}\n\n${KEYS_HELP}`);
        return 2;
    }
  } catch (err) {
    if (isParseArgsError(err)) throw err; // a wrong option: exit 2 with the usage (index.ts)
    io.err(`keys ${sub ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function minutes(n: number): string {
  return n.toFixed(1);
}

/** `turjuman usage [--month YYYY-MM]`: streamed minutes per key and engine. */
export async function usageCommand(
  args: string[],
  io: KeysIo,
  loaded: LoadedConfig,
): Promise<number> {
  // A wrong option throws: exit 2 with the usage (index.ts).
  const { values } = parseArgs({
    args,
    options: { month: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help === true) {
    io.out(USAGE_HELP);
    return 0;
  }
  if (values.month !== undefined && !/^\d{4}-\d{2}$/.test(values.month)) {
    io.err("usage: --month must look like 2026-10");
    return 2;
  }
  const store = new UsageStore({ dir: loaded.paths.usageDir, flushIntervalMs: 0 });
  const thisMonth = monthKey(Date.now());
  const month = values.month ?? thisMonth;
  const report = store.report({ month });
  const keys = new Map(new KeyStore(loaded.paths.keysFile).list().map((k) => [k.id, k]));
  const current = month === thisMonth;
  io.out(
    current
      ? `Streamed minutes per key and engine (today ${report.today}, month ${month})`
      : `Streamed minutes per key and engine (month ${month})`,
  );
  if (report.rows.length === 0) {
    io.out(`No usage recorded (${loaded.paths.usageDir}).`);
    return 0;
  }
  const header = current
    ? ["KEY", "LABEL", "ENGINE", "TODAY", "MONTH", "DAILY LIMIT"]
    : ["KEY", "LABEL", "ENGINE", "MONTH"];
  const rows = [header];
  let today = 0;
  let total = 0;
  for (const r of report.rows) {
    const key = keys.get(r.keyId);
    const label = r.keyId === LOCAL_KEY_ID ? "(no key / local)" : (key?.label ?? "(revoked key)");
    const limit =
      key?.dailyMinutes === undefined || key.dailyMinutes === null ? "-" : String(key.dailyMinutes);
    today += r.todayMinutes;
    total += r.monthMinutes;
    rows.push(
      current
        ? [r.keyId, label, r.engine, minutes(r.todayMinutes), minutes(r.monthMinutes), limit]
        : [r.keyId, label, r.engine, minutes(r.monthMinutes)],
    );
  }
  rows.push(
    current
      ? ["total", "", "", minutes(today), minutes(total), ""]
      : ["total", "", "", minutes(total)],
  );
  io.out(table(rows));
  if (current) io.out("(The server writes usage every 30 s; the last half minute may be missing.)");
  return 0;
}
