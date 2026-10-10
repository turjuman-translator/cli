// The inventory of the CLI: every command and option that `turjuman --help` and each
// `turjuman <command> --help` of the built binary offer must have an end-to-end test (COVERAGE in
// inventory.ts), and every entry of that table must still be in a help text and name a test
// that exists and runs (not skipped, not an expected failure).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { turjuman } from "../helpers/cli.js";
import { Cleanup, cliInstall } from "../helpers/cli-tools.js";
import { COVERAGE, commandEntries, overviewEntries } from "./inventory.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

/** Every entry of the help texts of the built binary. */
async function helpEntries(): Promise<Set<string>> {
  const inst = await cliInstall();
  cleanup.add(() => inst.remove());
  const overview = await turjuman(inst, ["--help"]);
  const entries = new Set(overviewEntries(overview.stdout));
  const commands = [...entries].filter((e) => !e.includes(" ") && !e.startsWith("-"));
  await Promise.all(
    commands.map(async (command) => {
      const help = await turjuman(inst, [command, "--help"]);
      if (help.code !== 0) throw new Error(`turjuman ${command} --help: exit ${help.code}`);
      for (const entry of commandEntries(command, help.stdout)) entries.add(entry);
    }),
  );
  return entries;
}

describe("the CLI inventory", () => {
  it("every command and option of the help texts has an end-to-end test, and nothing else is in the table", async () => {
    const entries = await helpEntries();
    // A sanity check of the parser: the overview's commands and a few options of each kind.
    for (const entry of [
      "setup --check",
      "screens add",
      "run --fake-provider",
      "ctl TOKEN",
      "-v",
    ]) {
      expect(entries.has(entry), entry).toBe(true);
    }
    const missing = [...entries].filter((e) => !Object.hasOwn(COVERAGE, e)).sort();
    const stale = Object.keys(COVERAGE)
      .filter((e) => !entries.has(e))
      .sort();
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it("every test the table names exists and runs", () => {
    for (const [entry, ref] of Object.entries(COVERAGE)) {
      const [file = "", ...rest] = ref.split(": ");
      const name = rest.join(": ");
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
      const at = source.indexOf(JSON.stringify(name));
      expect(at, `${entry} → ${ref}: no such test`).toBeGreaterThan(-1);
      // The call the title belongs to: it(…), not it.skip(…) or it.fails(…).
      const call = /\bit(\.\w+)?\(\s*$/.exec(source.slice(Math.max(0, at - 40), at));
      expect(call?.[1], `${entry} → ${ref}`).toBeUndefined();
      expect(call, `${entry} → ${ref}: not a test title`).not.toBeNull();
    }
  });
});
