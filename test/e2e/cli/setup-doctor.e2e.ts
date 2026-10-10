// `turjuman setup` (the Soniox key and the first admin) and `turjuman doctor`. No request reaches
// the real Soniox: every process is in the network jail, and the Soniox host names lead to a fake
// Soniox on 127.0.0.1 (an HTTPS server with a certificate from scripts/lan-cert.sh), or nowhere
// for the "could not be reached" paths. Keys are fake ("fake-soniox-…").
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { turjuman } from "../helpers/cli.js";
import {
  baseYaml,
  Cleanup,
  type CliInstall,
  cliInstall,
  type FakeSoniox,
  login,
  startFakeSoniox,
  waitUntil,
} from "../helpers/cli-tools.js";
import { freePort, makeInstance, randomToken } from "../helpers/instance.js";
import { REPO } from "../helpers/paths.js";
import { startServer } from "../helpers/server.js";

const cleanup = new Cleanup();
let soniox: FakeSoniox;
beforeAll(async () => {
  const dir = makeInstance();
  cleanup.add(() => dir.remove());
  soniox = await startFakeSoniox(dir.dir);
  cleanup.add(() => soniox.close());
  // The fake Soniox's answer to the model list depends on the key a test uses.
  soniox.answer = (key) => {
    if (key?.includes("rejected") === true) return { status: 401, body: { error: "invalid key" } };
    if (key?.includes("down") === true) return { status: 503, body: { error: "maintenance" } };
    if (key?.includes("nomodel") === true)
      return { status: 200, body: { models: [{ id: "stt-rt-v4" }] } };
    return { status: 200, body: { models: [{ id: "stt-rt-v4" }, { id: "stt-rt-v5" }] } };
  };
});
afterAll(() => cleanup.run());

async function install(opts: Parameters<typeof cliInstall>[0] = {}): Promise<CliInstall> {
  const inst = await cliInstall({ soniox, ...opts });
  cleanup.add(() => inst.remove());
  return inst;
}

/** An install whose processes cannot reach Soniox at all (the jail refuses the connection). */
async function offline(opts: Parameters<typeof cliInstall>[0] = {}): Promise<CliInstall> {
  const inst = await cliInstall(opts);
  cleanup.add(() => inst.remove());
  return inst;
}

/** The requests the fake Soniox got with this key. */
function asked(key: string): string[] {
  return soniox.requests
    .filter((r) => r.authorization === `Bearer ${key}`)
    .map((r) => `${r.method} ${r.host}${r.path}`);
}

function envFile(inst: CliInstall): string {
  return join(inst.dir, ".env");
}

/** `text` for a RegExp. */
function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A doctor line: "[ok]   Name   detail" with the padding collapsed. */
function doctorLine(out: string, tag: "ok" | "warn" | "FAIL", name: string): string | undefined {
  const label = `[${tag}]`;
  return out
    .split("\n")
    .find((l) => l.startsWith(label) && l.slice(7).startsWith(`${name} `))
    ?.slice(7 + name.length)
    .trim();
}

describe.concurrent("turjuman setup", () => {
  it("setup asks for the Soniox key, checks it with Soniox and creates the first admin", async ({
    expect,
  }) => {
    const inst = await install();
    const key = "fake-soniox-accepted-00000001";
    const r = await turjuman(inst, ["setup"], {
      input: [
        key,
        "y",
        "Bad Name!",
        "imam",
        "short",
        "secret-password-1",
        "secret-password-2",
        "secret-password-1",
        "secret-password-1",
        "",
      ].join("\n"),
    });
    expect(r.code, r.stderr).toBe(0);
    const env = envFile(inst);
    for (const line of [
      `Turjuman setup. Your API key is saved in ${env} (only you can read it).`,
      "Soniox API key (required: speech recognition and translation).",
      "  Get one at https://console.soniox.com → API keys.",
      "  Checking the key with Soniox...",
      "  OK: Soniox accepted the key.",
      `Saved SONIOX_API_KEY (…0001) in ${env} (mode 0600).`,
      "First admin account (to log in to the app):",
      "  Created admin account imam.",
      "Next steps:",
      "  1. Start Turjuman:  pnpm turjuman start",
      `  2. Open the app:    http://127.0.0.1:${inst.port}/app   (or: pnpm turjuman open)`,
    ]) {
      expect(r.stdout).toContain(line);
    }
    expect(r.stderr).toBe(
      "  A username has 2–32 characters: a–z, 0–9, dot, dash or underscore (starting with a letter or digit).\n" +
        "  The password needs at least 8 characters.\n" +
        "  The two passwords differ; try again.\n",
    );
    // The key is never shown, only its last four characters.
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(readFileSync(env, "utf8")).toContain(`\nSONIOX_API_KEY=${key}\n`);
    expect(asked(key)).toEqual(["GET api.soniox.com/v1/models"]);
    expect(inst.netAttempts().map((a) => `${a.action} ${a.host}:${a.port}`)).toEqual([
      "redirected api.soniox.com:443",
    ]);

    // The server reads the saved key and the admin logs in.
    const srv = await startServer(inst, inst.port, { command: "start" });
    cleanup.add(() => srv.stop());
    await waitUntil("the app addresses", () => srv.logs().includes("Caption look:"));
    expect(srv.logs()).not.toContain("No Soniox API key yet");
    expect((await login(srv.url, "imam", "secret-password-1")).status).toBe(200);
  });

  it("setup asks again when Soniox does not accept the key; Enter keeps the current key", async ({
    expect,
  }) => {
    const inst = await install();
    const first = await turjuman(inst, ["setup"], {
      input: "fake-soniox-rejected-00000001\nfake-soniox-accepted-00000002\nn\n",
    });
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("  Not accepted: Soniox did not accept this key (HTTP 401).\n");
    expect(first.stdout).toContain("Saved SONIOX_API_KEY (…0002)");
    expect(first.stdout).toContain(
      `  Skipped. Later: pnpm turjuman users add <name> --admin, or at http://127.0.0.1:${inst.port}/login.\n`,
    );
    expect(existsSync(join(inst.dir, "users.yaml"))).toBe(false);

    const again = await turjuman(inst, ["setup"], { input: "\n" });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("  Soniox API key (Enter keeps the current key …0002): ");
    expect(again.stdout).toContain("  OK: Soniox accepted the key.");
    expect(again.stdout).toContain(`No key changed; ${envFile(inst)} stays as it is (mode 0600).`);
    expect(again.stdout).toContain(
      `No admin account was made (the input ended). Later: pnpm turjuman users add <name> --admin, or at http://127.0.0.1:${inst.port}/login.`,
    );
    expect(readFileSync(envFile(inst), "utf8")).toContain(
      "SONIOX_API_KEY=fake-soniox-accepted-00000002\n",
    );
    expect(asked("fake-soniox-accepted-00000002")).toHaveLength(2);
  });

  it("setup saves a key it cannot check, marked unchecked, when Soniox cannot be reached", async ({
    expect,
  }) => {
    const inst = await offline();
    const file = inst.file("soniox.key", "fake-soniox-offline-00000001\n");
    const r = await turjuman(inst, ["setup", "--yes", "--soniox-key-file", file]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Soniox API key: from ${file}`);
    expect(r.stderr).toBe(
      "  Unchecked: Soniox could not be reached; the key was not checked. It is saved anyway; check it later with: pnpm turjuman setup --check\n",
    );
    expect(r.stdout).toContain("Saved SONIOX_API_KEY (…0001)");
    // The jail refused the connection: nothing reached Soniox.
    expect(inst.netAttempts().map((a) => `${a.action} ${a.host}:${a.port}`)).toEqual([
      "blocked api.soniox.com:443",
    ]);
    const check = await turjuman(inst, ["setup", "--check"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain(
      "  Soniox  unchecked      Soniox could not be reached; the key was not checked.\n",
    );
  });

  it("setup --yes reads the key from a file or standard input and asks nothing", async ({
    expect,
  }) => {
    const inst = await install();
    const none = await turjuman(inst, ["setup", "--yes"]);
    expect(none).toMatchObject({
      code: 2,
      stderr:
        "setup: no Soniox key: give --soniox-key-file <file>, or run setup without --yes to type it.\n",
    });
    const file = inst.file("soniox.key", "﻿\n  fake-soniox-accepted-00000003  \n");
    const fromFile = await turjuman(inst, ["setup", "--yes", "--soniox-key-file", file]);
    expect(fromFile.code).toBe(0);
    expect(fromFile.stdout).toContain("Saved SONIOX_API_KEY (…0003)");
    expect(fromFile.stdout).toContain(
      `No account yet. Create the first admin with: pnpm turjuman users add <name> --admin, or at http://127.0.0.1:${inst.port}/login.`,
    );
    const fromStdin = await turjuman(inst, ["setup", "-y", "--soniox-key-file", "-"], {
      input: "fake-soniox-accepted-00000004\n",
    });
    expect(fromStdin.code).toBe(0);
    expect(fromStdin.stdout).toContain("Soniox API key: from standard input");
    expect(fromStdin.stdout).toContain("Saved SONIOX_API_KEY (…0004)");
    const keep = await turjuman(inst, ["setup", "--yes"]);
    expect(keep.code).toBe(0);
    expect(keep.stdout).toContain("Soniox API key: keeping the current key …0004.");
    expect(keep.stdout).toContain(`No key changed; ${envFile(inst)} stays as it is (mode 0600).`);
    expect(readFileSync(envFile(inst), "utf8").match(/SONIOX_API_KEY=/g)).toHaveLength(1);
  });

  it("setup --check checks the key of the environment or .env with Soniox", async ({ expect }) => {
    const inst = await install();
    const header = `Checking the API key in the environment, ${envFile(inst)} and the app (a free call; nothing is billed):\n`;
    expect(await turjuman(inst, ["setup", "--check"])).toMatchObject({
      code: 1,
      stdout: `${header}  Soniox  missing        required: add it with pnpm turjuman setup, or in the app under Keys\n`,
    });
    inst.file(".env", "SONIOX_API_KEY=fake-soniox-accepted-00000005\n");
    expect(await turjuman(inst, ["setup", "--check"])).toMatchObject({
      code: 0,
      stdout: `${header}  Soniox  OK             key …0005\n`,
    });
    // The environment wins over .env, like for the server.
    const env = { SONIOX_API_KEY: "fake-soniox-rejected-00000006" };
    expect(await turjuman(inst, ["setup", "--check"], { env })).toMatchObject({
      code: 1,
      stdout: `${header}  Soniox  not accepted   Soniox did not accept this key (HTTP 401).\n`,
    });
    const down = { SONIOX_API_KEY: "fake-soniox-down-00000007" };
    expect(await turjuman(inst, ["setup", "--check"], { env: down })).toMatchObject({
      code: 0,
      stdout: `${header}  Soniox  unchecked      Soniox answered HTTP 503; the key was not checked.\n`,
    });
    expect(readFileSync(envFile(inst), "utf8")).toBe(
      "SONIOX_API_KEY=fake-soniox-accepted-00000005\n",
    );
  });

  it("setup refuses a key on the command line, an unreadable or empty key file and an input without a key", async ({
    expect,
  }) => {
    const inst = await install();
    const typed = await turjuman(inst, ["setup", "fake-soniox-typed-on-the-command-line"]);
    expect(typed).toMatchObject({
      code: 2,
      stdout: "",
      stderr:
        "setup: takes no arguments. The key comes from the terminal or from --soniox-key-file, never from the command line.\n",
    });
    const file = inst.file("k", "fake-soniox-accepted-00000008\n");
    expect(await turjuman(inst, ["setup", "--check", "--soniox-key-file", file])).toMatchObject({
      code: 2,
      stderr: "setup: --check checks the saved key; it takes no key file.\n",
    });
    const missing = await turjuman(inst, [
      "setup",
      "--yes",
      "--soniox-key-file",
      join(inst.dir, "nope"),
    ]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^setup: cannot read the key file: ENOENT/);
    const empty = inst.file("empty.key", "\n \n");
    expect(await turjuman(inst, ["setup", "--yes", "--soniox-key-file", empty])).toMatchObject({
      code: 2,
      stderr: `setup: the key file ${empty} is empty\n`,
    });
    expect(await turjuman(inst, ["setup", "--yes", "--soniox-key-file", "-"])).toMatchObject({
      code: 2,
      stderr: "setup: the key file (stdin) is empty\n",
    });
    const rejected = inst.file("rejected.key", "fake-soniox-rejected-00000009\n");
    expect(await turjuman(inst, ["setup", "--yes", "--soniox-key-file", rejected])).toMatchObject({
      code: 1,
      stderr:
        "  Not accepted: Soniox did not accept this key (HTTP 401).\nNothing was saved: give a Soniox key that Soniox accepts.\n",
    });
    const ended =
      "No Soniox key was given (the input ended); nothing was saved. For scripts: pnpm turjuman setup --yes --soniox-key-file <file>\n";
    expect(await turjuman(inst, ["setup"])).toMatchObject({ code: 1, stderr: ended });
    expect(await turjuman(inst, ["setup"], { input: "\n" })).toMatchObject({
      code: 1,
      stderr: `  The Soniox key is required.\n${ended}`,
    });
    expect(await turjuman(inst, ["setup"], { input: "short-key\n" })).toMatchObject({
      code: 1,
      stderr: `  Not accepted: This key is too short.\n${ended}`,
    });
    expect(existsSync(envFile(inst))).toBe(false);
  });

  it("setup on a hosted server says that every mosque adds its own key", async ({ expect }) => {
    const inst = await install({
      yaml: (port) =>
        `mode: hosted\n${baseYaml(port).replace("server:\n", `server:\n  token: ${randomToken()}\n`)}`,
    });
    expect(await turjuman(inst, ["setup"])).toMatchObject({
      code: 0,
      stdout:
        "Hosted mode: every mosque adds its own API keys in the app (/app/keys), stored encrypted.\n" +
        "There are no server keys to set. Start the server with: pnpm turjuman start\n" +
        "Keep master.key (or TURJUMAN_MASTER_KEY) safe: see\n" +
        "https://github.com/turjuman-translator/website/blob/main/docs/hosting.md\n",
    });
    expect(existsSync(envFile(inst))).toBe(false);
  });
});

describe.concurrent("turjuman doctor", () => {
  it("doctor passes a complete setup: config, key, ffmpeg, the port and the TLS handshake with Soniox", async ({
    expect,
  }) => {
    const key = "fake-soniox-accepted-00000010";
    const inst = await install();
    inst.file(".env", `SONIOX_API_KEY=${key}\n`);
    const r = await turjuman(inst, ["doctor"]);
    expect(r.code, r.stdout).toBe(0);
    expect(doctorLine(r.stdout, "ok", "Node.js")).toBe(`v${process.versions.node}`);
    expect(doctorLine(r.stdout, "ok", "Config")).toBe(join(inst.dir, "config.yaml"));
    expect(doctorLine(r.stdout, "ok", "Paths")).toBe(
      `CONFIG_DIR=${inst.dir}  DATA_DIR=${inst.dataDir}`,
    );
    expect(doctorLine(r.stdout, "ok", "Exposure")).toBe("local (this machine only)");
    expect(doctorLine(r.stdout, "ok", "Soniox API key")).toBe("set");
    expect(doctorLine(r.stdout, "ok", "Languages")).toMatch(
      /^\d+ languages \(.+languages\.yaml\)$/,
    );
    expect(doctorLine(r.stdout, "ok", "Caption layout")).toBe(
      "blocks (fast: Soniox streaming translation)",
    );
    expect(doctorLine(r.stdout, "ok", "Quran data")).toBe("disabled");
    expect(doctorLine(r.stdout, "ok", "ffmpeg")).toMatch(/^found; input formats: /);
    expect(doctorLine(r.stdout, "ok", "Port")).toBe(`127.0.0.1:${inst.port} is free`);
    expect(doctorLine(r.stdout, "ok", "TLS stt-rt.soniox.com")).toMatch(
      /^TLS handshake ok \(TLSv1\.[23]\)$/,
    );
    expect(r.stdout).toMatch(/\n\n\d+ ok, \d+ warnings, 0 failures\n$/);
    // Without --online, doctor asks Soniox nothing: only the TLS handshake (no request, no key).
    expect(asked(key)).toEqual([]);
    expect(inst.netAttempts().map((a) => `${a.action} ${a.host}:${a.port}`)).toEqual([
      "redirected stt-rt.soniox.com:443",
    ]);
  });

  it("doctor --online asks Soniox whether it accepts the key and has the model", async ({
    expect,
  }) => {
    const inst = await install();
    const cases: Array<[string, number, string, string]> = [
      ["fake-soniox-accepted-00000011", 0, "ok", "key accepted; stt-rt-v5 available"],
      [
        "fake-soniox-rejected-00000012",
        1,
        "FAIL",
        "HTTP 401 from https://api.soniox.com/v1/models",
      ],
      ["fake-soniox-nomodel-00000013", 1, "FAIL", "key accepted, but stt-rt-v5 not listed"],
    ];
    for (const [key, code, tag, detail] of cases) {
      const r = await turjuman(inst, ["doctor", "--online"], { env: { SONIOX_API_KEY: key } });
      expect(r.code, key).toBe(code);
      expect(doctorLine(r.stdout, tag as "ok" | "FAIL", "Soniox key (online)"), key).toBe(detail);
      expect(asked(key), key).toEqual(["GET api.soniox.com/v1/models"]);
    }
  });

  it("doctor fails without a key and when Soniox cannot be reached", async ({ expect }) => {
    const inst = await offline();
    const r = await turjuman(inst, ["doctor", "--online"]);
    expect(r.code).toBe(1);
    expect(doctorLine(r.stdout, "FAIL", "Soniox API key")).toBe(
      "not set (required: Soniox is the speech engine); run pnpm turjuman setup, or add it in the app under Keys",
    );
    expect(doctorLine(r.stdout, "FAIL", "TLS stt-rt.soniox.com")).toBe(
      "connect ECONNREFUSED stt-rt.soniox.com:443 (blocked by the e2e network jail)",
    );
    // No key: --online has nothing to ask.
    expect(r.stdout).not.toContain("Soniox key (online)");
    expect(r.stdout).toMatch(/\n\n\d+ ok, \d+ warnings, 2 failures\n$/);
    expect(inst.netAttempts().map((a) => `${a.action} ${a.host}:${a.port}`)).toEqual([
      "blocked stt-rt.soniox.com:443",
    ]);
  });

  it("doctor --config reads another config file; a missing or invalid one fails", async ({
    expect,
  }) => {
    const inst = await install({
      yaml: null,
      env: { SONIOX_API_KEY: "fake-soniox-accepted-00000014" },
    });
    const port = await freePort();
    const other = inst.file("other.yaml", baseYaml(port));
    const ok = await turjuman(inst, ["doctor", "--config", other]);
    expect(ok.code, ok.stdout).toBe(0);
    expect(doctorLine(ok.stdout, "ok", "Config")).toBe(other);
    expect(doctorLine(ok.stdout, "ok", "Port")).toBe(`127.0.0.1:${port} is free`);
    const missing = await turjuman(inst, ["doctor", "--config", join(inst.dir, "nope.yaml")]);
    expect(missing.code).toBe(1);
    expect(doctorLine(missing.stdout, "FAIL", "Config")).toBe(
      `Config file not found: ${join(inst.dir, "nope.yaml")}`,
    );
    const bad = inst.file("bad.yaml", "server:\n  port: not-a-port\n  colour: blue\n");
    const invalid = await turjuman(inst, ["doctor", "--config", bad]);
    expect(invalid.code).toBe(1);
    expect(doctorLine(invalid.stdout, "FAIL", "Config")).toMatch(
      new RegExp(`^Invalid config ${bad.replaceAll(".", "\\.")}`),
    );
    // The other checks still run, on the defaults.
    expect(invalid.stdout).toContain("[ok]   ffmpeg");
  });

  it("doctor sees a running Turjuman server on its port, or another program", async ({
    expect,
  }) => {
    const inst = await install({ env: { SONIOX_API_KEY: "fake-soniox-accepted-00000015" } });
    const srv = await startServer(inst, inst.port);
    cleanup.add(() => srv.stop());
    const running = await turjuman(inst, ["doctor"]);
    expect(running.code).toBe(0);
    expect(doctorLine(running.stdout, "ok", "Port")).toBe(
      `127.0.0.1:${inst.port} is in use by a running Turjuman server`,
    );
    await srv.stop();
    const blocker = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(inst.port, "127.0.0.1", resolve));
    cleanup.add(() => new Promise((resolve) => blocker.close(resolve)));
    const other = await turjuman(inst, ["doctor"]);
    expect(other.code).toBe(1);
    expect(doctorLine(other.stdout, "FAIL", "Port")).toBe(
      `127.0.0.1:${inst.port} is in use by another program`,
    );
  });

  it("doctor checks the HTTPS certificate that the lan-cert hint makes; start then serves HTTPS", async ({
    expect,
  }) => {
    const httpsPort = await freePort();
    const inst = await install({
      yaml: (port) =>
        baseYaml(port).replace("server:\n", `server:\n  https:\n    port: ${httpsPort}\n`),
      env: { SONIOX_API_KEY: "fake-soniox-accepted-00000016" },
    });
    const before = await turjuman(inst, ["doctor"]);
    expect(before.code).toBe(1);
    const tls = join(inst.dir, "tls");
    // The folder relative to the working folder, or absolute when that is shorter to say (on
    // macOS the working folder is /private/var/…, the config folder /var/…).
    expect(doctorLine(before.stdout, "FAIL", "HTTPS")).toMatch(
      new RegExp(
        `^port ${httpsPort}, but ${esc(join(tls, "server.crt"))} and ${esc(join(tls, "server.key"))} are missing; run bash scripts/lan-cert\\.sh (tls|${esc(tls)})$`,
      ),
    );
    expect(doctorLine(before.stdout, "warn", "Exposure")).toBe(
      `local: HTTPS (port ${httpsPort}) answers on this computer only; other devices need exposure: lan`,
    );
    // The command the hint names, from the repository.
    execFileSync("bash", [join(REPO, "scripts", "lan-cert.sh"), tls], { stdio: "pipe" });
    const after = await turjuman(inst, ["doctor"]);
    expect(after.code, after.stdout).toBe(0);
    expect(doctorLine(after.stdout, "ok", "HTTPS")).toMatch(
      new RegExp(`^port ${httpsPort}, valid until \\d{4}-\\d\\d-\\d\\d$`),
    );

    const srv = await startServer(inst, inst.port, { command: "start" });
    cleanup.add(() => srv.stop());
    await waitUntil("the HTTPS line", () => srv.logs().includes("  HTTPS:"));
    expect(srv.logs()).toContain(`  HTTPS:            https://127.0.0.1:${httpsPort}/\n`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: httpsPort,
          path: "/health",
          ca: readFileSync(join(tls, "ca.crt")),
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it("doctor on a hosted server checks the mode, the exposure, the generated admin token and the master key", async ({
    expect,
  }) => {
    const inst = await install({
      yaml: (port) => `mode: hosted\nhosted:\n  signup: closed\n${baseYaml(port)}`,
      env: { SONIOX_API_KEY: "fake-soniox-accepted-00000017" },
    });
    const r = await turjuman(inst, ["doctor", "--online"]);
    expect(r.code, r.stdout).toBe(0);
    expect(doctorLine(r.stdout, "ok", "Mode")).toBe(
      "hosted (sign-up closed; each mosque adds its own API keys)",
    );
    expect(doctorLine(r.stdout, "warn", "Hosted")).toBe(
      "exposure local: mosques need HTTPS to log in and use microphones; use exposure public behind an HTTPS proxy",
    );
    // The operator's token is generated on first use, never pasted.
    expect(doctorLine(r.stdout, "ok", "Admin token")).toBe(
      `generated, in ${join(inst.dir, "admin.token")}`,
    );
    expect(doctorLine(r.stdout, "warn", "API keys in .env")).toBe(
      "not used in hosted mode: every mosque adds its own keys in the app",
    );
    expect(doctorLine(r.stdout, "ok", "Master key")).toBe(
      `created with the first stored key (${join(inst.dir, "master.key")}); back it up apart from orgs.yaml`,
    );
    // A hosted server's keys belong to the mosques: --online asks nothing.
    expect(r.stdout).not.toContain("Soniox key (online)");
    expect(asked("fake-soniox-accepted-00000017")).toEqual([]);
  });
});
