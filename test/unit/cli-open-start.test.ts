import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { browserCommand, openCommand } from "../../src/cli/open.js";
import { startCommand } from "../../src/cli/start.js";
import { feedOrigin, lanAddress, serverAddresses } from "../../src/cli/urls.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";

const PORT = 8796;
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-open-"));
  roots.push(dir);
  return dir;
}

function writeConfig(dir: string, yaml = ""): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    `languagesFile: ${join(process.cwd(), "languages.yaml")}\n${yaml.includes("server:") ? "" : `server:\n  port: ${PORT}\n`}${yaml}`,
  );
}

function configured(yaml = ""): LoadedConfig {
  const dir = tempDir();
  writeConfig(dir, yaml);
  return loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) },
    out,
    err,
  };
}

function fakeSpawn(outcome: "spawn" | Error = "spawn") {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    setImmediate(() => {
      if (outcome === "spawn") child.emit("spawn");
      else child.emit("error", outcome);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

describe("browserCommand", () => {
  it("uses open, xdg-open, or cmd /c start with an argument list", () => {
    const url = "http://127.0.0.1:8796/app/new";
    expect(browserCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
      verbatim: false,
    });
    expect(browserCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
      verbatim: false,
    });
    expect(browserCommand(url, "freebsd").command).toBe("xdg-open");
    expect(browserCommand("https://x.example/app?a=1&b=(2)", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", '""', "https://x.example/app?a=1^&b=^(2^)"],
      verbatim: true,
    });
  });
});

describe("turjuman open", () => {
  it("opens the builder at this config's address and prints it", async () => {
    const loaded = configured();
    const { spawn, calls } = fakeSpawn();
    const c = capture();
    const code = await openCommand(["builder"], c.io, () => loaded, { platform: "darwin", spawn });
    expect(code).toBe(0);
    expect(c.out).toEqual([`Opening the builder: http://127.0.0.1:${PORT}/app/new`]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("open");
    expect(calls[0]?.args).toEqual([`http://127.0.0.1:${PORT}/app/new`]);
    expect(calls[0]?.options).toMatchObject({ stdio: "ignore", detached: true });
    expect(calls[0]?.options.shell).toBeUndefined();
  });

  it("opens /app by default and /app/look for look; hosted.publicUrl wins", async () => {
    const local = configured();
    let fake = fakeSpawn();
    let c = capture();
    expect(
      await openCommand([], c.io, () => local, {
        platform: "linux",
        env: { DISPLAY: ":0" },
        spawn: fake.spawn,
      }),
    ).toBe(0);
    expect(fake.calls[0]?.args).toEqual([`http://127.0.0.1:${PORT}/app`]);
    const hosted = configured("hosted:\n  publicUrl: https://captions.example.org\n");
    fake = fakeSpawn();
    c = capture();
    expect(
      await openCommand(["look"], c.io, () => hosted, { platform: "win32", spawn: fake.spawn }),
    ).toBe(0);
    expect(fake.calls[0]?.args).toEqual([
      "/c",
      "start",
      '""',
      "https://captions.example.org/app/look",
    ]);
    expect(fake.calls[0]?.options.windowsVerbatimArguments).toBe(true);
  });

  it("only prints the address on Linux without a desktop session", async () => {
    const loaded = configured();
    const { spawn, calls } = fakeSpawn();
    const c = capture();
    expect(
      await openCommand(["app"], c.io, () => loaded, { platform: "linux", env: {}, spawn }),
    ).toBe(0);
    expect(calls).toHaveLength(0);
    expect(c.out.join("\n")).toContain(`http://127.0.0.1:${PORT}/app`);
    expect(c.err.join("\n")).toMatch(/No desktop session/);
  });

  it("says so when no browser can be started", async () => {
    const loaded = configured();
    const { spawn } = fakeSpawn(new Error("spawn xdg-open ENOENT"));
    const c = capture();
    expect(
      await openCommand([], c.io, () => loaded, {
        platform: "linux",
        env: { DISPLAY: ":0" },
        spawn,
      }),
    ).toBe(1);
    expect(c.err.join("\n")).toMatch(
      /Could not start a browser \(xdg-open: spawn xdg-open ENOENT\)/,
    );
  });

  it("rejects unknown pages and shows help without loading the config", async () => {
    const noLoad = (): LoadedConfig => {
      throw new Error("must not load");
    };
    const c = capture();
    expect(await openCommand(["admin"], c.io, noLoad)).toBe(2);
    expect(await openCommand(["app", "look"], c.io, noLoad)).toBe(2);
    expect(await openCommand(["--browser"], c.io, noLoad)).toBe(2);
    expect(await openCommand(["--help"], c.io, noLoad)).toBe(0);
    expect(c.out.join("\n")).toContain("turjuman open [app|builder|look]");
    // `help` as the first argument too, as every command takes it.
    const h = capture();
    expect(await openCommand(["help"], h.io, noLoad)).toBe(0);
    expect(h.out[0]).toMatch(/^turjuman open \[app\|builder\|look\]/);
  });
});

describe("turjuman start", () => {
  /** A stand-in for `run`: prints a banner like the server's, then a second line. */
  function fakeRun() {
    const calls: string[][] = [];
    const run = async (args: string[], io: { out(t: string): void }): Promise<number> => {
      calls.push(args);
      io.out("Turjuman server running (test)");
      io.out("Local session: started");
      return 0;
    };
    return { run, calls };
  }

  it("runs the server with the same options and prints the app addresses under its banner", async () => {
    const dir = tempDir();
    writeConfig(dir);
    const env: NodeJS.ProcessEnv = {
      CONFIG_DIR: dir,
      DATA_DIR: dir,
      SONIOX_API_KEY: "fake-key-00000000000",
    };
    const { run, calls } = fakeRun();
    const c = capture();
    const args = ["--file", "khutbah.wav", "--loop"];
    expect(await startCommand(args, c.io, { run, env, cwd: dir, lan: null })).toBe(0);
    expect(calls).toEqual([args]);
    expect(c.out[0]).toBe("Turjuman server running (test)");
    expect(c.out[1]).toContain(`Screens (dashboard):  http://127.0.0.1:${PORT}/app`);
    expect(c.out[1]).toContain(`New screen (builder): http://127.0.0.1:${PORT}/app/new`);
    expect(c.out[1]).toContain(`Caption look:         http://127.0.0.1:${PORT}/app/look`);
    expect(c.out[1]).not.toContain("On the network");
    expect(c.out[2]).toBe("Local session: started");
    expect(c.err).toEqual([]);
  });

  it("reads the keys setup saved in CONFIG_DIR/.env, and warns when there is no Soniox key", async () => {
    const root = tempDir();
    const configDir = join(root, "config");
    writeConfig(configDir);
    writeFileSync(join(configDir, ".env"), "SONIOX_API_KEY=fake-from-config-dir-000\n");
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: "config", DATA_DIR: "data" };
    let c = capture();
    expect(await startCommand([], c.io, { run: fakeRun().run, env, cwd: root, lan: null })).toBe(0);
    expect(env.SONIOX_API_KEY).toBe("fake-from-config-dir-000");
    expect(c.err).toEqual([]);

    const bare = tempDir();
    writeConfig(bare);
    c = capture();
    const emptyEnv: NodeJS.ProcessEnv = { CONFIG_DIR: bare, DATA_DIR: bare };
    expect(
      await startCommand([], c.io, { run: fakeRun().run, env: emptyEnv, cwd: bare, lan: null }),
    ).toBe(0);
    expect(c.err.join("\n")).toMatch(/No Soniox API key yet: run "pnpm turjuman setup", or add it/);
    // In the Docker image: the make target.
    vi.stubEnv("CAPTIONS_CONTAINER", "1");
    c = capture();
    expect(
      await startCommand([], c.io, {
        run: fakeRun().run,
        env: { CONFIG_DIR: bare, DATA_DIR: bare },
        cwd: bare,
        lan: null,
      }),
    ).toBe(0);
    expect(c.err).toEqual([
      'No Soniox API key yet: run "make keys", or add it in the app under Keys. The server starts anyway.',
    ]);
  });

  it("adds the LAN, HTTPS and public addresses when they are configured", async () => {
    const dir = tempDir();
    writeConfig(
      dir,
      `server:\n  host: 0.0.0.0\n  port: ${PORT}\n  exposure: lan\n  https:\n    port: 8443\nhosted:\n  publicUrl: https://captions.example.org\n`,
    );
    mkdirSync(join(dir, "tls"));
    writeFileSync(join(dir, "tls", "server.crt"), "test certificate");
    writeFileSync(join(dir, "tls", "server.key"), "test key");
    const env: NodeJS.ProcessEnv = {
      CONFIG_DIR: dir,
      DATA_DIR: dir,
      SONIOX_API_KEY: "fake-key-00000000000",
    };
    const c = capture();
    await startCommand([], c.io, { run: fakeRun().run, env, cwd: dir, lan: "192.168.1.20" });
    expect(c.out[1]).toContain(`On the network:       http://192.168.1.20:${PORT}/app`);
    expect(c.out[1]).toContain("HTTPS:                https://192.168.1.20:8443/app");
    expect(c.out[1]).toContain("Public address:       https://captions.example.org/app");
  });

  it("passes --dry-run through without addresses, and has help", async () => {
    const dir = tempDir();
    writeConfig(dir);
    const { run, calls } = fakeRun();
    const c = capture();
    const env: NodeJS.ProcessEnv = {
      CONFIG_DIR: dir,
      DATA_DIR: dir,
      SONIOX_API_KEY: "fake-key-00000000000",
    };
    expect(await startCommand(["--dry-run"], c.io, { run, env, cwd: dir })).toBe(0);
    expect(calls).toEqual([["--dry-run"]]);
    expect(c.out.join("\n")).not.toContain("/app/new");
    const h = capture();
    expect(await startCommand(["--help"], h.io, { run })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(h.out.join("\n")).toContain("turjuman start");
  });
});

describe("addresses", () => {
  it("finds the first private IPv4 address", () => {
    expect(
      lanAddress({
        lo0: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: null,
          },
        ],
        en0: [
          {
            address: "fe80::1",
            netmask: "ffff:ffff:ffff:ffff::",
            family: "IPv6",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: null,
            scopeid: 4,
          },
          {
            address: "203.0.113.5",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: null,
          },
        ],
        en1: [
          {
            address: "172.20.1.9",
            netmask: "255.255.0.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:00",
            internal: false,
            cidr: null,
          },
        ],
      }),
    ).toBe("172.20.1.9");
    expect(lanAddress({})).toBeNull();
  });

  it("gives no HTTPS address for other devices with exposure local (it answers on 127.0.0.1)", () => {
    const dir = tempDir();
    writeConfig(dir, `server:\n  port: ${PORT}\n  https:\n    port: 8443\n`);
    mkdirSync(join(dir, "tls"));
    writeFileSync(join(dir, "tls", "server.crt"), "test certificate");
    writeFileSync(join(dir, "tls", "server.key"), "test key");
    const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
    const a = serverAddresses(loaded, { lan: "192.168.1.20" });
    expect(a.https).toBeNull();
    expect(feedOrigin(a)).toBe(`http://127.0.0.1:${PORT}`);
  });

  it("brackets IPv6 hosts and maps :: to 127.0.0.1", () => {
    expect(
      serverAddresses(configured(`server:\n  host: "::1"\n  port: ${PORT}\n`), { lan: null }).local,
    ).toBe(`http://[::1]:${PORT}`);
    // In the container the server listens on every address with exposure local.
    const dir = tempDir();
    writeConfig(dir, `server:\n  host: "::"\n  port: ${PORT}\n`);
    const anyHost = loadConfig({
      env: { CONFIG_DIR: dir, DATA_DIR: dir, CAPTIONS_CONTAINER: "1" },
      cwd: dir,
    });
    expect(anyHost.config.server.host).toBe("::");
    expect(serverAddresses(anyHost, { lan: "192.168.1.20" })).toEqual({
      local: `http://127.0.0.1:${PORT}`,
      lan: null,
      https: null,
      public: null,
    });
  });
});

describe("runCli registration", () => {
  it("lists the new commands in the help", async () => {
    const c = capture();
    expect(await runCli(["--help"], c.io)).toBe(0);
    const help = c.out.join("\n");
    expect(help).toMatch(/^turjuman <command>/);
    for (const line of [
      "setup",
      "setup --check",
      "start [--config <file>]",
      "open [app|builder|look]",
      "screens list|add|url|enable|disable|rm",
      "orgs list|disable|enable <id>",
    ]) {
      expect(help).toContain(`  ${line}`);
    }
  });

  it("dispatches setup, start, open and screens (their help needs no config)", async () => {
    for (const argv of [
      ["setup", "--help"],
      ["start", "--help"],
      ["open", "--help"],
      ["screens", "help"],
    ]) {
      const c = capture();
      expect(await runCli(argv, c.io)).toBe(0);
      expect(c.out.join("\n")).toContain(`turjuman ${argv[0]}`);
    }
  });

  it("every command takes --help (exit 0, its usage), also the ones that need a config", async () => {
    for (const command of [
      "doctor",
      "run",
      "replay",
      "record",
      "status",
      "sessions",
      "estimate",
      "keys",
      "usage",
      "users",
      "orgs",
      "ctl",
      "devices",
    ]) {
      const c = capture();
      expect(await runCli([command, "--help"], c.io), command).toBe(0);
      expect(c.out.join("\n"), command).toMatch(new RegExp(`^(usage: )?turjuman ${command}\\b`));
      expect(c.out.join("\n"), command).not.toMatch(/captions (users|keys|ctl)\b|\/admin\b/);
    }
  });

  it("every command stops a wrong option the same way: exit 2, a short message, its usage", async () => {
    for (const argv of [
      ["users", "add", "--frob"],
      ["keys", "add", "--frob"],
      ["status", "--frob"],
      ["sessions", "--frob"],
      ["estimate", "start", "--frob"],
      ["orgs", "list", "--frob"],
      ["start", "--frob"],
      ["run", "--frob"],
      ["record", "--frob"],
    ]) {
      const c = capture();
      expect(await runCli(argv, c.io), argv.join(" ")).toBe(2);
      const text = c.err.join("\n");
      expect(text, argv.join(" ")).toMatch(
        new RegExp(`^turjuman ${argv[0]}: Unknown option '--frob'\\.\\n`),
      );
      expect(text, argv.join(" ")).not.toMatch(
        /To specify a positional argument|No Soniox API key/,
      );
      expect(c.out, argv.join(" ")).toEqual([]);
    }
  });

  it("help <command> prints that command's help; help <unknown> refuses it", async () => {
    for (const command of ["setup", "open", "screens", "keys", "ctl", "status"]) {
      const viaHelp = capture();
      const viaFlag = capture();
      expect(await runCli(["help", command], viaHelp.io), command).toBe(0);
      expect(await runCli([command, "--help"], viaFlag.io), command).toBe(0);
      expect(viaHelp.out, command).toEqual(viaFlag.out);
      expect(viaHelp.out.join("\n"), command).toMatch(new RegExp(`^turjuman ${command}\\b`));
    }
    const c = capture();
    expect(await runCli(["help", "frob"], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/^Unknown command: frob\n\nturjuman <command> \[options\]/);
    // `help --help` is still the overview.
    const overview = capture();
    expect(await runCli(["help", "--help"], overview.io)).toBe(0);
    expect(overview.out[0]).toMatch(/^turjuman <command> \[options\]/);
  });

  it("a wrong option exits 2 with the command's usage", async () => {
    const c = capture();
    expect(await runCli(["doctor", "--frobnicate"], c.io)).toBe(2);
    const text = c.err.join("\n");
    expect(text).toMatch(/^turjuman doctor: Unknown option '--frobnicate'/);
    expect(text).toContain("turjuman doctor [--config <file>] [--online]");
  });
});
