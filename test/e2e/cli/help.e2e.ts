// `turjuman --help`, `--version`, every command's own help, and how a wrong command, option or
// missing value is refused: exit code 2 with the usage, nothing done.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { turjuman } from "../helpers/cli.js";
import { Cleanup, type CliInstall, cliInstall } from "../helpers/cli-tools.js";
import { REPO } from "../helpers/paths.js";

const cleanup = new Cleanup();
let inst: CliInstall;
beforeAll(async () => {
  inst = await cliInstall();
  cleanup.add(() => inst.remove());
});
afterAll(() => cleanup.run());

/** Every command of `turjuman --help`, with the first line of its own help. */
const USAGE: Record<string, string> = {
  setup: "turjuman setup [--soniox-key-file <file>] [--yes]",
  start: "turjuman start [--config <file>] [--start] [--file <wav> [--loop]]",
  open: "turjuman open [app|builder|look]",
  screens: "turjuman screens <command>",
  doctor: "turjuman doctor [--config <file>] [--online]",
  devices: "turjuman devices [--config <file>] [--monitors]",
  run: "turjuman run [--config <file>] [--start] [--file <wav> [--loop]] [--dry-run] [--print]",
  replay: "turjuman replay <provider.jsonl> [--config <file>] [--speed 1] [--loop] [--print]",
  keys: "turjuman keys <command>",
  usage: "turjuman usage [--month YYYY-MM]",
  users: "turjuman users <command>",
  orgs: "turjuman orgs <command>",
  record: "turjuman record --out <file.wav> [--seconds n]",
  status: "turjuman status",
  sessions: "turjuman sessions [--limit n]",
  estimate: "turjuman estimate start",
  ctl: "turjuman ctl <action> [args]",
};

const COMMANDS = Object.keys(USAGE);

describe.concurrent("turjuman help and version", () => {
  it("prints the overview for no arguments, help, --help and -h", async () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const r = await turjuman(inst, args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/^turjuman <command> \[options\]/);
      for (const heading of ["Get started:", "More:", "Options:"])
        expect(r.stdout).toContain(heading);
      for (const command of COMMANDS) expect(r.stdout).toMatch(new RegExp(`\\b${command}\\b`));
    }
  });

  it("prints the version for --version and -v", async () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      version: string;
      bin: Record<string, string>;
    };
    for (const flag of ["--version", "-v"]) {
      const r = await turjuman(inst, [flag]);
      expect(r.code, flag).toBe(0);
      expect(r.stdout).toBe(`${pkg.version}\n`);
    }
    // "captions" is the same command: both names run the same program.
    expect(pkg.bin).toEqual({ turjuman: "dist/main.js", captions: "dist/main.js" });
  });

  it("prints each command's own help for --help, -h and help", async () => {
    await Promise.all(
      COMMANDS.flatMap((command) =>
        [["--help"], ["-h"], ["help"]].map(async (flag) => {
          const r = await turjuman(inst, [command, ...flag]);
          expect(r.code, `${command} ${flag.join(" ")}`).toBe(0);
          expect(r.stderr, `${command} ${flag.join(" ")}`).toBe("");
          expect(r.stdout.startsWith(USAGE[command] ?? "?"), `${command} ${flag}`).toBe(true);
        }),
      ),
    );
  });

  it("prints the help of setup and open for help as well", async () => {
    for (const command of ["setup", "open"]) {
      const r = await turjuman(inst, [command, "help"]);
      expect(r.code, command).toBe(0);
      expect(r.stdout.startsWith(USAGE[command] ?? "?")).toBe(true);
    }
  });

  it("help <command> prints that command's help, the same as <command> --help", async () => {
    await Promise.all(
      COMMANDS.map(async (command) => {
        const [viaHelp, viaFlag] = await Promise.all([
          turjuman(inst, ["help", command]),
          turjuman(inst, [command, "--help"]),
        ]);
        expect(viaHelp.code, command).toBe(0);
        expect(viaHelp.stdout, command).toBe(viaFlag.stdout);
      }),
    );
    const unknown = await turjuman(inst, ["help", "frob"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/^Unknown command: frob\n\nturjuman <command> \[options\]/);
  });

  it("prints the help of a subcommand's --help too", async () => {
    for (const args of [
      ["screens", "add", "--help"],
      ["keys", "add", "--help"],
      ["users", "passwd", "-h"],
      ["orgs", "disable", "--help"],
      ["setup", "--check", "--help"],
    ]) {
      const r = await turjuman(inst, args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.stdout.startsWith(USAGE[args[0] ?? ""] ?? "?"), args.join(" ")).toBe(true);
    }
  });
});

describe.concurrent("turjuman usage errors", () => {
  it("refuses an unknown command with exit code 2 and the overview", async () => {
    const r = await turjuman(inst, ["frobnicate", "--now"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^Unknown command: frobnicate\n\nturjuman <command> \[options\]/);
  });

  it("refuses an unknown option of every command with exit code 2 and its usage", async () => {
    const cases: Array<[string[], string]> = [
      [["doctor", "--bogus"], "turjuman doctor: Unknown option '--bogus'."],
      [["run", "--bogus"], "turjuman run: Unknown option '--bogus'."],
      [["replay", "x.jsonl", "--bogus"], "turjuman replay: Unknown option '--bogus'."],
      [["record", "--bogus"], "turjuman record: Unknown option '--bogus'."],
      [["status", "--bogus"], "turjuman status: Unknown option '--bogus'."],
      [["sessions", "--bogus"], "turjuman sessions: Unknown option '--bogus'."],
      [["estimate", "--bogus"], "turjuman estimate: Unknown option '--bogus'."],
      [["usage", "--bogus"], "turjuman usage: Unknown option '--bogus'."],
      [["devices", "--bogus"], "turjuman devices: Unknown option '--bogus'."],
      [["start", "--bogus"], "turjuman start: Unknown option '--bogus'."],
      [["setup", "--bogus"], "setup: Unknown option '--bogus'."],
      [["open", "--bogus"], "open: Unknown option '--bogus'."],
      [["keys", "add", "--bogus"], "turjuman keys: Unknown option '--bogus'."],
      [["users", "add", "amina", "--bogus"], "turjuman users: Unknown option '--bogus'."],
      [["orgs", "list", "--bogus"], "turjuman orgs: Unknown option '--bogus'."],
      [["screens", "list", "--bogus"], "screens list: Unknown option '--bogus'."],
    ];
    await Promise.all(
      cases.map(async ([args, message]) => {
        const r = await turjuman(inst, args);
        const what = args.join(" ");
        expect(r.code, what).toBe(2);
        expect(r.stdout, what).toBe("");
        expect(r.stderr.startsWith(`${message}\n\n`), `${what}:\n${r.stderr}`).toBe(true);
        expect(r.stderr, what).toContain(USAGE[args[0] ?? ""] ?? "?");
      }),
    );
  });

  it("refuses an unknown subcommand with exit code 2 and the command's help", async () => {
    const cases: Array<[string[], string]> = [
      [["keys", "frob"], "Unknown keys command: frob"],
      [["users", "frob"], "Unknown users command: frob"],
      [["orgs", "frob"], "Unknown orgs command: frob"],
      [["screens", "frob"], "Unknown screens command: frob"],
      [["open", "frob"], "open: choose app, builder or look"],
      [["estimate", "stop"], "usage: turjuman estimate start"],
      [["ctl", "frob"], `ctl: unknown action frob\n\n${USAGE.ctl}`],
    ];
    await Promise.all(
      cases.map(async ([args, message]) => {
        const r = await turjuman(inst, args);
        const what = args.join(" ");
        expect(r.code, what).toBe(2);
        expect(r.stdout, what).toBe("");
        expect(r.stderr.startsWith(message), `${what}:\n${r.stderr}`).toBe(true);
      }),
    );
  });

  it("prints the command's help with exit code 2 when the subcommand is missing", async () => {
    await Promise.all(
      ["keys", "users", "orgs", "screens", "ctl"].map(async (command) => {
        const r = await turjuman(inst, [command]);
        expect(r.code, command).toBe(2);
        expect(r.stdout, command).toBe("");
        expect(r.stderr.startsWith(USAGE[command] ?? "?"), command).toBe(true);
      }),
    );
  });

  it("refuses an option without its value with exit code 2", async () => {
    const cases: Array<[string[], string]> = [
      [["run", "--config"], "turjuman run: Option '--config <value>' argument missing."],
      [["doctor", "--config"], "turjuman doctor: Option '--config <value>' argument missing."],
      [["sessions", "--limit"], "turjuman sessions: Option '--limit <value>' argument missing."],
      [["record", "--out"], "turjuman record: Option '--out <value>' argument missing."],
      [
        ["setup", "--soniox-key-file"],
        "setup: Option '--soniox-key-file <value>' argument missing.",
      ],
      [["screens", "add", "--name"], "screens add: Option '--name <value>' argument missing."],
    ];
    await Promise.all(
      cases.map(async ([args, message]) => {
        const r = await turjuman(inst, args);
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.stderr.startsWith(`${message}\n\n`), `${args.join(" ")}:\n${r.stderr}`).toBe(true);
      }),
    );
  });

  it("refuses an unknown option of keys list and users list", async () => {
    for (const command of ["keys", "users"]) {
      const r = await turjuman(inst, [command, "list", "--bogus"]);
      expect(r.code, command).toBe(2);
      expect(r.stdout, command).toBe("");
      expect(r.stderr.startsWith(`turjuman ${command}: Unknown option '--bogus'.\n\n`)).toBe(true);
      expect(r.stderr).toContain(USAGE[command] ?? "?");
    }
  });
});
