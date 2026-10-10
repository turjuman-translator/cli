// The Docker/make wrappers: in the Docker image (CAPTIONS_CONTAINER=1) the CLI's hints name make
// targets instead of `pnpm turjuman …`. Every hint is checked with `make -n` (a dry run: the
// recipes are printed, never run) in the repository, so a hint never names a target the Makefile
// lacks. A fake `docker` first on PATH proves that no dry run starts Docker.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, type ExpectStatic, it } from "vitest";
import { turjuman } from "../helpers/cli.js";
import {
  baseYaml,
  Cleanup,
  type CliInstall,
  cliInstall,
  fakeProgram,
  spawnCli,
} from "../helpers/cli-tools.js";
import { freePort, makeInstance, randomToken } from "../helpers/instance.js";
import { REPO } from "../helpers/paths.js";

const cleanup = new Cleanup();
let docker: { calls(): string[] };
let bin: string;
beforeAll(() => {
  const dir = makeInstance();
  cleanup.add(() => dir.remove());
  bin = join(dir.dir, "bin");
  docker = fakeProgram(bin, "docker");
});
afterAll(() => cleanup.run());

/** Runs in the Docker image, as far as the CLI can tell. */
const CONTAINER = { CAPTIONS_CONTAINER: "1" };

async function install(opts: Parameters<typeof cliInstall>[0] = {}): Promise<CliInstall> {
  const inst = await cliInstall({ ...opts, env: { ...CONTAINER, ...opts.env } });
  cleanup.add(() => inst.remove());
  return inst;
}

/** What a person types for the placeholders of a hint. */
const TYPED: Record<string, string> = { name: "amina", file: "soniox.key", id: "abc123def4" };

/**
 * `make -n <hint>` in the repository, as a person would type the hint: placeholders such as
 * <name> filled in, then parsed by bash.
 */
function makeDryRun(hint: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!hint.startsWith("make ")) throw new Error(`not a make command: ${hint}`);
  const typed = hint.slice("make ".length).replaceAll(/<(\w+)>/g, (_, w: string) => TYPED[w] ?? w);
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", `/usr/bin/make -n ${typed}`],
      { cwd: REPO, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** The make commands a text names: `make <target>` and its VAR=value arguments. */
function hintsIn(text: string): string[] {
  const found = text.matchAll(
    /\bmake [a-z][\w-]*(?: [A-Z_]+=(?:'[^']*'|"[^"]*"|[^\s;,)]+))*(?=$|[\s;,).])/gm,
  );
  return [...new Set([...found].map((m) => m[0]))];
}

/** Each hint: printed by the CLI in the Docker image, and a target the Makefile has. */
async function checkHints(
  expect: ExpectStatic,
  output: string,
  wanted: string[],
  recipe: Record<string, string> = {},
): Promise<void> {
  for (const hint of wanted) expect(output, hint).toContain(hint);
  for (const hint of hintsIn(output)) {
    const r = await makeDryRun(hint);
    expect(r.code, `${hint}: ${r.stderr}`).toBe(0);
    const runs = recipe[hint];
    if (runs !== undefined) expect(r.stdout, hint).toContain(runs);
  }
}

describe.concurrent("turjuman's make hints in the Docker image", () => {
  it("doctor names make keys, make quran-data, make lan-cert and make status", async ({
    expect,
  }) => {
    const httpsPort = await freePort();
    const inst = await install({
      yaml: (port) => `server:\n  port: ${port}\n  https:\n    port: ${httpsPort}\n`,
    });
    const r = await turjuman(inst, ["doctor"]);
    expect(r.code).toBe(1);
    await checkHints(
      expect,
      r.stdout,
      [
        "run make keys, or add it in the app under Keys",
        "(by hand: make quran-data);",
        "are missing; run make lan-cert",
        "(HTTP_PORT in .env; make status shows whether it runs)",
      ],
      {
        "make keys": "captions setup",
        "make quran-data": "scripts/quran-data.ts",
        "make lan-cert": "scripts/lan-cert.sh config/tls",
        "make status": " status",
      },
    );
  });

  it("setup names make keys, make doctor ONLINE=1, make up, make admin, make user-add and make cli", async ({
    expect,
  }) => {
    const inst = await install();
    const check = await turjuman(inst, ["setup", "--check"]);
    await checkHints(expect, check.stdout, ["add it with make keys"]);
    const ended = await turjuman(inst, ["setup"]);
    await checkHints(
      expect,
      ended.stderr,
      ["For scripts: make cli ARGS='setup --yes --soniox-key-file <file>'"],
      {
        "make cli ARGS='setup --yes --soniox-key-file <file>'":
          "setup --yes --soniox-key-file soniox.key",
      },
    );
    // Soniox cannot be reached from the jail: the key is saved unchecked.
    const file = inst.file("soniox.key", "fake-soniox-container-00000001\n");
    const saved = await turjuman(inst, ["setup", "--yes", "--soniox-key-file", file]);
    expect(saved.code).toBe(0);
    await checkHints(
      expect,
      saved.stdout + saved.stderr,
      [
        "check it later with: make doctor ONLINE=1",
        "Create the first admin with: make user-add USERNAME=<name> ADMIN=1",
        "1. Start Turjuman:  make up",
        "(or: make admin)",
      ],
      {
        "make doctor ONLINE=1": "captions doctor --online",
        "make user-add USERNAME=<name> ADMIN=1": "users add 'amina' --admin",
        "make up": "up -d --wait",
        "make admin": "/app",
      },
    );
    const hosted = await install({
      yaml: (port) =>
        `mode: hosted\n${baseYaml(port).replace("server:\n", `server:\n  token: ${randomToken()}\n`)}`,
    });
    const r = await turjuman(hosted, ["setup"]);
    await checkHints(expect, r.stdout, ["Start the server with: make up"]);
  });

  it("users, screens and devices name make user-add, make cli, make screens, make bridge-list and make bridge", async ({
    expect,
  }) => {
    const inst = await install({
      yaml: (port) => baseYaml(port, "audio:\n  input:\n    kind: network\n"),
    });
    await checkHints(expect, (await turjuman(inst, ["users", "list"])).stdout, [
      "Create the first admin with: make user-add USERNAME=<name> ADMIN=1",
    ]);
    await checkHints(expect, (await turjuman(inst, ["users", "add"])).stderr, [
      "give exactly one username, e.g. make user-add USERNAME=abdullah ADMIN=1",
    ]);
    const screensAdd = 'screens add --name "Main hall" --from ar --to nl';
    await checkHints(
      expect,
      (await turjuman(inst, ["screens", "list"])).stdout,
      [`Make one: make cli ARGS='${screensAdd}'`],
      { [`make cli ARGS='${screensAdd}'`]: screensAdd },
    );
    const add = await turjuman(inst, [
      "screens",
      "add",
      "--name",
      "Hall",
      "--from",
      "ar",
      "--to",
      "nl",
    ]);
    await checkHints(expect, add.stdout, [
      "It is off: switch it on with: make cli ARGS='screens enable ",
    ]);
    await checkHints(
      expect,
      (await turjuman(inst, ["screens", "url", "nope"])).stderr,
      ["(see: make screens)"],
      { "make screens": "screens list" },
    );
    await checkHints(
      expect,
      (await turjuman(inst, ["devices"])).stdout,
      ["(or: make bridge-list)", 'e.g. make bridge DEVICE="Line (USB Audio CODEC)".'],
      { "make bridge-list": "audio-bridge" },
    );
  });

  it("run names make status when its port is in use", async ({ expect }) => {
    const inst = await install();
    const blocker = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(inst.port, "127.0.0.1", resolve));
    cleanup.add(() => new Promise((resolve) => blocker.close(resolve)));
    const r = await turjuman(inst, ["run"]);
    expect(r.code).toBe(1);
    await checkHints(expect, r.stderr, ["is Turjuman running already? (make status)"]);
  });

  it("start names make keys in the Docker image when there is no Soniox key", async ({
    expect,
  }) => {
    const inst = await install();
    const start = spawnCli(inst, ["start"]);
    cleanup.add(() => start.stop());
    await start.waitFor("No Soniox API key yet");
    await checkHints(
      expect,
      start.stderr(),
      ['No Soniox API key yet: run "make keys", or add it in the app under Keys.'],
      { "make keys": "captions setup" },
    );
    expect(start.stderr()).not.toContain("pnpm");
  });

  it("keys and orgs name make cli in the Docker image", async ({ expect }) => {
    const inst = await install();
    const addKey = `make cli ARGS='keys add --label "<name>"'`;
    await checkHints(
      expect,
      (await turjuman(inst, ["keys", "list"])).stdout,
      [`Create one with: ${addKey}`],
      { [addKey]: 'keys add --label "amina"' },
    );
    await checkHints(expect, (await turjuman(inst, ["keys", "revoke"])).stderr, [
      "(see make cli ARGS='keys list')",
    ]);
    const orgs = await turjuman(inst, ["orgs", "disable"]);
    await checkHints(expect, orgs.stderr, [
      "Which organisation? make cli ARGS='orgs disable <id>' (see make cli ARGS='orgs list')",
    ]);
  });

  it("every make target in src/cli/hint.ts exists (make -n, Docker never started)", async ({
    expect,
  }) => {
    const source = readFileSync(join(REPO, "src", "cli", "hint.ts"), "utf8");
    const targets = [...new Set([...source.matchAll(/["'`]make ([a-z][\w-]*)/g)].map((m) => m[1]))];
    expect(targets.sort()).toEqual(
      [
        "admin",
        "cli",
        "doctor",
        "keys",
        "lan-cert",
        "quran-data",
        "screens",
        "status",
        "up",
        "user-add",
        "users",
      ].sort(),
    );
    for (const target of targets) {
      const r = await makeDryRun(`make ${target}`);
      expect(r.code, `make ${target}: ${r.stderr}`).toBe(0);
    }
    // A target the Makefile lacks fails the same check.
    expect((await makeDryRun("make no-such-target")).code).toBe(2);
  });
});

it("no make dry run started Docker", ({ expect }) => {
  expect(docker.calls()).toEqual([]);
});
