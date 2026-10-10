// The commands that manage a server's accounts, access keys, screens and organisations: `users`,
// `keys`, `usage`, `screens` and `orgs`. They write the files in the config folder; each test
// checks that a running server acts on the change: a login, a caption page that opens with an
// access key or a screen link (/ws/page), an organisation that is switched off.
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { turjuman } from "../helpers/cli.js";
import {
  baseYaml,
  Cleanup,
  type CliInstall,
  cliInstall,
  getJson,
  login,
  openPage,
  waitUntil,
} from "../helpers/cli-tools.js";
import { randomToken } from "../helpers/instance.js";
import { REPO } from "../helpers/paths.js";
import { type Server, startServer } from "../helpers/server.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

const PAUSES = join(REPO, "test", "fixtures", "soniox-tts-pauses.jsonl");
const PASSWORD = "correct horse battery";

async function install(opts: Parameters<typeof cliInstall>[0] = {}): Promise<CliInstall> {
  const inst = await cliInstall(opts);
  cleanup.add(() => inst.remove());
  return inst;
}

/** `turjuman run --fake-provider` (page sessions replay a provider log). */
async function serve(inst: CliInstall): Promise<Server> {
  const srv = await startServer(inst, inst.port, { args: ["--fake-provider", PAUSES] });
  cleanup.add(() => srv.stop());
  return srv;
}

function hostedYaml(port: number, token = randomToken()): string {
  return `mode: hosted\nhosted:\n  signup: open\n${baseYaml(port).replace("server:\n", `server:\n  token: ${token}\n`)}`;
}

describe.concurrent("turjuman users", () => {
  it("users add creates an admin who logs in to the running app with the piped password", async ({
    expect,
  }) => {
    const inst = await install();
    const srv = await serve(inst);
    const r = await turjuman(inst, ["users", "add", "amina", "--admin", "--name", "Amina B"], {
      input: `${PASSWORD}\n`,
    });
    expect(r).toMatchObject({
      code: 0,
      stderr: "",
      stdout:
        "Created admin account amina (Amina B).\n" +
        `Log in at ${srv.url}/login on this computer.\n`,
    });
    const ok = await login(srv.url, "amina", PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.me).toMatchObject({ username: "amina", displayName: "Amina B", role: "admin" });
    expect((await login(srv.url, "amina", "not the password")).status).toBe(401);
  });

  it("users add without a piped password prints a generated one once; users list shows the accounts", async ({
    expect,
  }) => {
    const inst = await install();
    const empty = await turjuman(inst, ["users", "list"]);
    expect(empty).toMatchObject({
      code: 0,
      stdout: `No accounts (${join(inst.dir, "users.yaml")}). Create the first admin with: pnpm turjuman users add <name> --admin\n`,
    });
    const srv = await serve(inst);
    const r = await turjuman(inst, ["users", "add", "bilal"]);
    expect(r.code).toBe(0);
    const password = /^ {2}Password: (\S+)$/m.exec(r.stdout)?.[1] ?? "";
    expect(password).toMatch(/^\S{16}$/);
    expect(r.stdout).toBe(
      "Created user account bilal (bilal).\n\n" +
        `  Password: ${password}\n\n` +
        "This is the only time the password is shown; users.yaml keeps only a hash.\n" +
        `Log in at ${srv.url}/login on this computer.\n`,
    );
    const ok = await login(srv.url, "bilal", password);
    expect(ok.status).toBe(200);
    expect(ok.body.me).toMatchObject({ username: "bilal", role: "user" });

    const list = await turjuman(inst, ["users", "list"]);
    expect(list.code).toBe(0);
    const [head, row] = list.stdout.trimEnd().split("\n");
    expect(head).toMatch(/^ID\s+USERNAME\s+NAME\s+ROLE\s+STATUS\s+CREATED\s+LAST LOGIN\s+SCREENS$/);
    // The login above is the last login.
    expect(row).toMatch(
      /^\w+\s+bilal\s+bilal\s+user\s+active\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+0$/,
    );
    expect(list.stdout).not.toContain(password);
  });

  it("users passwd sets a new password and logs the account out; users remove deletes it", async ({
    expect,
  }) => {
    const inst = await install();
    const srv = await serve(inst);
    await turjuman(inst, ["users", "add", "imam", "--admin"], { input: `${PASSWORD}\n` });
    const before = await login(srv.url, "imam", PASSWORD);
    expect(before.status).toBe(200);
    expect((await getJson(srv.url, "/api/auth/me", before.cookie)).status).toBe(200);

    const passwd = await turjuman(inst, ["users", "passwd", "imam"], {
      input: "a new long password\n",
    });
    expect(passwd).toMatchObject({
      code: 0,
      stdout: "New password set for imam; it is logged out on every device.\n",
    });
    await waitUntil(
      "the old login to end",
      async () => (await getJson(srv.url, "/api/auth/me", before.cookie)).status === 401,
    );
    expect((await login(srv.url, "imam", PASSWORD)).status).toBe(401);
    expect((await login(srv.url, "imam", "a new long password")).status).toBe(200);

    const generated = await turjuman(inst, ["users", "passwd", "imam"]);
    expect(generated.code).toBe(0);
    const password = /^ {2}Password: (\S+)$/m.exec(generated.stdout)?.[1] ?? "";
    expect(generated.stdout).toContain("This is the only time the password is shown.");
    expect((await login(srv.url, "imam", password)).status).toBe(200);

    // The last admin stays (else nobody could manage the server); other accounts can go.
    expect(await turjuman(inst, ["users", "remove", "imam"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "users remove: This is the last enabled admin account; make another admin first\n",
    });
    await turjuman(inst, ["users", "add", "zaid"], { input: `${PASSWORD}\n` });
    expect((await login(srv.url, "zaid", PASSWORD)).status).toBe(200);
    const removed = await turjuman(inst, ["users", "remove", "zaid"]);
    expect(removed).toMatchObject({ code: 0, stdout: "Removed account zaid.\n" });
    await waitUntil(
      "the removed account's login to fail",
      async () => (await login(srv.url, "zaid", PASSWORD)).status === 401,
    );
    const list = await turjuman(inst, ["users", "list"]);
    expect(list.stdout).toContain(" imam ");
    expect(list.stdout).not.toContain(" zaid ");
  });

  it("users refuses a missing, taken or invalid name, a short password and an unknown account", async ({
    expect,
  }) => {
    const inst = await install();
    await turjuman(inst, ["users", "add", "amina"], { input: `${PASSWORD}\n` });
    const cases: Array<[string[], string, number, string]> = [
      [
        ["add"],
        "",
        2,
        "users add: give exactly one username, e.g. pnpm turjuman users add abdullah --admin\n",
      ],
      [
        ["add", "a", "b"],
        "",
        2,
        "users add: give exactly one username, e.g. pnpm turjuman users add abdullah --admin\n",
      ],
      [["add", "amina"], "", 1, 'users add: the username "amina" is already taken\n'],
      [
        ["add", "Bad Name!"],
        "",
        2,
        "users add: A username has 2–32 characters: a–z, 0–9, dot, dash or underscore (starting with a letter or digit)\n",
      ],
      [["add", "carol"], "short\n", 2, "users add: The password needs at least 8 characters\n"],
      [["passwd", "ghost"], "", 1, 'users passwd: no account "ghost"\n'],
      [["passwd"], "", 2, "users passwd: give exactly one username or e-mail address\n"],
      [
        ["passwd", "amina"],
        "short\n",
        2,
        "users passwd: The password needs at least 8 characters\n",
      ],
      [["remove", "ghost@example.org"], "", 1, 'users remove: no account "ghost@example.org"\n'],
      [["remove", "a", "b"], "", 2, "users remove: give exactly one username or e-mail address\n"],
    ];
    for (const [args, input, code, stderr] of cases) {
      const r = await turjuman(inst, ["users", ...args], { input });
      expect(r, args.join(" ")).toMatchObject({ code, stderr, stdout: "" });
    }
  });
});

describe.concurrent("turjuman keys and usage", () => {
  it("keys add prints an access key once; a caption page on the network opens with it until keys revoke, and usage counts its minutes", async ({
    expect,
  }) => {
    const token = randomToken();
    const inst = await install({
      yaml: (port) =>
        baseYaml(port).replace("server:\n", `server:\n  exposure: lan\n  token: ${token}\n`),
    });
    const empty = await turjuman(inst, ["keys", "list"]);
    expect(empty.stdout).toBe(
      `No access keys (${join(inst.dir, "keys.yaml")}). Create one with: pnpm turjuman keys add --label "<name>"\n`,
    );
    const srv = await serve(inst);
    const add = await turjuman(inst, [
      "keys",
      "add",
      "--label",
      "Zaal 2",
      "--daily-minutes",
      "90",
      "--expires",
      "2099-01-01",
    ]);
    expect(add.code).toBe(0);
    // A date without a time is shown as that date.
    const id =
      /^Created access key (\w+) "Zaal 2" \(daily limit 90 min; expires 2099-01-01\)$/m.exec(
        add.stdout,
      )?.[1];
    const key = /^ {2}(\S{20,})$/m.exec(add.stdout)?.[1] ?? "";
    expect(id).toBeDefined();
    expect(add.stdout).toContain(
      `This is the only time the key is shown; ${join(inst.dir, "keys.yaml")} keeps only its hash.\n` +
        `Add it to caption page URLs as ?key=…, e.g. http://<server>:${inst.port}/ar/nl?key=${key}\n`,
    );
    expect(add.stdout).not.toContain('server.exposure is "local"');

    // A caption page on another device: refused without the key, live with it.
    const without = await openPage(srv.url, { from: "ar", to: "nl" });
    expect(without.first).toMatchObject({ type: "error", code: "unauthorized" });
    without.close();
    const page = await openPage(srv.url, { from: "ar", to: "nl", key });
    expect(page.first).toMatchObject({ type: "ready", limits: { dailyMinutesLeft: 90 } });
    // Half a second of speech (real time, as a page sends it): the engine opens, and its minutes
    // count for the key until the server stops.
    page.send(JSON.stringify({ type: "speech", state: "start" }));
    for (let i = 0; i < 5; i++) {
      page.send(new Uint8Array(3200));
      await new Promise((r) => setTimeout(r, 100));
    }
    page.close();

    const list = await turjuman(inst, ["keys", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^ID\s+LABEL\s+DAILY MIN\s+EXPIRES\s+CREATED\s+LAST USED$/m);
    expect(list.stdout).toMatch(
      new RegExp(
        `^${id}\\s+Zaal 2\\s+90\\s+2099-01-01\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`,
        "m",
      ),
    );
    expect(list.stdout).not.toContain(key);

    const revoke = await turjuman(inst, ["keys", "revoke", id ?? ""]);
    expect(revoke).toMatchObject({ code: 0, stdout: `Revoked key ${id} "Zaal 2".\n` });
    const refused = await openPage(srv.url, { from: "ar", to: "nl", key });
    expect(refused.first).toMatchObject({ type: "error", code: "unauthorized" });
    refused.close();

    // The server writes usage when it stops (and every 30 s).
    await srv.stop();
    const usage = await turjuman(inst, ["usage"]);
    expect(usage.code).toBe(0);
    expect(usage.stdout).toMatch(
      /^Streamed minutes per key and engine \(today \d{4}-\d\d-\d\d, month \d{4}-\d\d\)$/m,
    );
    expect(usage.stdout).toMatch(/^KEY\s+LABEL\s+ENGINE\s+TODAY\s+MONTH\s+DAILY LIMIT$/m);
    expect(usage.stdout).toMatch(
      new RegExp(`^${id}\\s+\\(revoked key\\)\\s+soniox\\s+\\d+\\.\\d\\s+\\d+\\.\\d\\s+-$`, "m"),
    );
    expect(usage.stdout).toMatch(/^total\s+\d+\.\d\s+\d+\.\d$/m);
    expect(usage.stdout).toContain(
      "(The server writes usage every 30 s; the last half minute may be missing.)",
    );
    const month = /month (\d{4}-\d\d)/.exec(usage.stdout)?.[1] ?? "";
    const byMonth = await turjuman(inst, ["usage", "--month", month]);
    expect(byMonth.stdout).toBe(usage.stdout);
    expect(inst.netAttempts()).toEqual([]);
  });

  it("keys add on a local server says that its pages need no key", async ({ expect }) => {
    const inst = await install();
    const add = await turjuman(inst, ["keys", "add", "--label", "OBS"]);
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/^Created access key \w+ "OBS" \(no daily limit\)$/m);
    expect(add.stdout).toContain(
      'Note: server.exposure is "local", where pages need no key (keys apply to lan/public).\n',
    );
  });

  it("keys refuses a missing label, a wrong limit or date and an unknown id", async ({
    expect,
  }) => {
    const inst = await install();
    const cases: Array<[string[], number, string]> = [
      [["add"], 2, 'keys add: --label "<name>" is required\n'],
      [["add", "--label", " "], 2, 'keys add: --label "<name>" is required\n'],
      [
        ["add", "--label", "x", "--daily-minutes", "0"],
        2,
        "keys add: --daily-minutes must be a positive number\n",
      ],
      [
        ["add", "--label", "x", "--daily-minutes=-5"],
        2,
        "keys add: --daily-minutes must be a positive number\n",
      ],
      // A negative number is a wrong limit, not a missing value.
      [
        ["add", "--label", "x", "--daily-minutes", "-3"],
        2,
        "keys add: --daily-minutes must be a positive number\n",
      ],
      [
        ["add", "--label", "x", "--expires", "tomorrow"],
        2,
        "keys add: --expires must be a date, e.g. 2027-01-01\n",
      ],
      [["revoke"], 2, "keys revoke: give exactly one key id (see pnpm turjuman keys list)\n"],
      [
        ["revoke", "a", "b"],
        2,
        "keys revoke: give exactly one key id (see pnpm turjuman keys list)\n",
      ],
      [["revoke", "nope"], 1, "keys revoke: no key with id nope\n"],
    ];
    for (const [args, code, stderr] of cases) {
      const r = await turjuman(inst, ["keys", ...args]);
      expect(r, args.join(" ")).toMatchObject({ code, stderr, stdout: "" });
    }
  });
});

describe.concurrent("turjuman screens", () => {
  it("screens add makes a screen that the app shows; its link shows captions once screens enable switches it on", async ({
    expect,
  }) => {
    const inst = await install();
    const empty = await turjuman(inst, ["screens", "list"]);
    expect(empty.stdout).toBe(
      'No screens yet. Make one: pnpm turjuman screens add --name "Main hall" --from ar --to nl\n' +
        `or in the app: http://127.0.0.1:${inst.port}/app/new\n`,
    );
    const add = await turjuman(inst, [
      "screens",
      "add",
      "--name",
      "Main hall",
      "--from",
      "ar",
      "--to",
      "nl",
    ]);
    expect(add.code).toBe(0);
    const [, id, guid] =
      /^Created screen (\w+) "Main hall" \(ar → nl, off\)\.\nScreen link for OBS: http:\/\/127\.0\.0\.1:\d+\/feed\/([\w-]+)\n/.exec(
        add.stdout,
      ) ?? [];
    expect(id).toBeDefined();
    expect(add.stdout).toContain(
      `It is off: switch it on with: pnpm turjuman screens enable ${id}\n`,
    );
    const srv = await serve(inst);

    // The screen link sends OBS to the caption page with the screen's languages.
    const feed = await fetch(`${srv.url}/feed/${guid}`, { redirect: "manual" });
    expect(feed.status).toBe(302);
    expect(feed.headers.get("location")).toMatch(new RegExp(`^/ar/nl\\?.*screen=${guid}`));
    // The app shows the screen to an admin.
    await turjuman(inst, ["users", "add", "admin", "--admin"], { input: `${PASSWORD}\n` });
    const { cookie } = await login(srv.url, "admin", PASSWORD);
    const screens = await getJson(srv.url, "/api/screens", cookie);
    expect(JSON.stringify(screens.body)).toContain(`"id":"${id}"`);
    expect(JSON.stringify(screens.body)).toContain('"name":"Main hall"');

    // Off: the page waits (parked). On: the parked page hears it and a page goes live. Off
    // again: the live page is stopped and parked. (The server applies screens.yaml every 2 s.)
    const guidOf = { guid: guid ?? "" };
    const parked = await openPage(srv.url, { from: "ar", to: "nl", screen: guidOf });
    cleanup.add(() => parked.close());
    expect(parked.first).toMatchObject({ type: "screen", state: "disabled", name: "Main hall" });
    expect(await turjuman(inst, ["screens", "enable", id ?? ""])).toMatchObject({
      code: 0,
      stdout: `Screen ${id} "Main hall" is now on.\nScreens that are open start showing captions within a few seconds.\n`,
    });
    expect((await turjuman(inst, ["screens", "enable", "main hall"])).stdout).toBe(
      `Screen ${id} "Main hall" is on already.\n`,
    );
    await waitUntil("the parked page to hear the screen is on", () =>
      parked.messages.some((m) => m.type === "screen" && m.state === "enabled"),
    );
    parked.close();
    const on = await openPage(srv.url, { from: "ar", to: "nl", screen: guidOf });
    cleanup.add(() => on.close());
    expect(on.first).toMatchObject({ type: "ready" });
    expect(await turjuman(inst, ["screens", "disable", id ?? ""])).toMatchObject({
      code: 0,
      stdout: `Screen ${id} "Main hall" is now off.\nCaptions on screens that are open stop within a few seconds.\n`,
    });
    await waitUntil("the live page to hear the screen is off", () =>
      on.messages.some((m) => m.type === "screen" && m.state === "disabled"),
    );
    on.close();
    // Deleted: the link no longer works.
    expect((await turjuman(inst, ["screens", "rm", id ?? "", "--yes"])).code).toBe(0);
    const gone = await waitUntil("the deleted screen's link to stop working", async () => {
      const p = await openPage(srv.url, { from: "ar", to: "nl", screen: { guid: guid ?? "" } });
      p.close();
      return p.first.type === "error" ? p : undefined;
    });
    expect(gone.first).toMatchObject({ type: "error", code: "screen_invalid" });
  });

  it("screens enable and disable reach an open screen link even right after screens add (no change is lost between two checks)", async ({
    expect,
  }) => {
    const inst = await install();
    const srv = await serve(inst);
    const screenOf = async (name: string): Promise<{ id: string; guid: string }> => {
      const add = await turjuman(inst, [
        "screens",
        "add",
        "--name",
        name,
        "--from",
        "ar",
        "--to",
        "nl",
      ]);
      const [, id = "", guid = ""] =
        /^Created screen (\w+) .*\nScreen link for OBS: \S+\/feed\/([\w-]+)\n/.exec(add.stdout) ??
        [];
      return { id, guid };
    };
    const told = (page: { messages: Array<Record<string, unknown>> }, state: string) =>
      page.messages.some((m) => m.type === "screen" && m.state === state);

    // Made, opened (OBS waits) and switched on at once: the waiting page hears it.
    const hall = await screenOf("Hall");
    const obs = await openPage(srv.url, { from: "ar", to: "nl", screen: { guid: hall.guid } });
    cleanup.add(() => obs.close());
    expect(obs.first).toMatchObject({ type: "screen", state: "disabled", name: "Hall" });
    expect((await turjuman(inst, ["screens", "enable", hall.id])).code).toBe(0);
    await waitUntil("the waiting page to hear the screen is on", () => told(obs, "enabled"), 6000);

    // Switched on, a page goes live, switched off again at once: the live page stops.
    const gallery = await screenOf("Gallery");
    await new Promise((r) => setTimeout(r, 2500)); // the server has seen it off
    expect((await turjuman(inst, ["screens", "enable", gallery.id])).code).toBe(0);
    const live = await openPage(srv.url, { from: "ar", to: "nl", screen: { guid: gallery.guid } });
    cleanup.add(() => live.close());
    expect(live.first).toMatchObject({ type: "ready" });
    expect((await turjuman(inst, ["screens", "disable", gallery.id])).code).toBe(0);
    await waitUntil("the live page to hear the screen is off", () => told(live, "disabled"), 6000);
    expect(live.messages.some((m) => m.type === "session.ended")).toBe(true);
  });

  it("screens add --preset --layout --size --enable --json and screens list --json show the look and the link", async ({
    expect,
  }) => {
    const inst = await install();
    const add = await turjuman(inst, [
      "screens",
      "add",
      "--name",
      "Gallery",
      "--from",
      "ar",
      "--to",
      "en",
      "--preset",
      "high-contrast",
      "--layout",
      "rollup",
      "--size",
      "48",
      "--enable",
      "--json",
    ]);
    expect(add.code).toBe(0);
    const screen = JSON.parse(add.stdout) as Record<string, unknown>;
    const link = `http://127.0.0.1:${inst.port}/feed/`;
    expect(screen).toMatchObject({
      name: "Gallery",
      from: "ar",
      to: "en",
      enabled: true,
      query: "preset=high-contrast&layout=rollup&size=48",
    });
    expect(String(screen.url).startsWith(link)).toBe(true);
    expect(screen.localUrl).toBe(screen.url);
    await turjuman(inst, ["screens", "add", "--name", "Main hall", "--from", "ar", "--to", "nl"]);

    const json = await turjuman(inst, ["screens", "list", "--json"]);
    const all = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
    expect(all.map((s) => s.name)).toEqual(["Main hall", "Gallery"]);
    expect(all[1]).toEqual(screen);

    const list = await turjuman(inst, ["screens", "list"]);
    expect(list.code).toBe(0);
    const lines = list.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+NAME\s+LANGUAGES\s+STATE\s+SCREEN LINK$/);
    expect(lines[1]).toMatch(new RegExp(`^\\w+\\s+Main hall\\s+ar → nl\\s+off\\s+${link}[\\w-]+$`));
    expect(lines[2]).toBe(`${screen.id}  Gallery    ar → en    on     ${screen.url}`);
  });

  it("screens url prints a screen's link by id or name, --local the one for OBS on this computer", async ({
    expect,
  }) => {
    const inst = await install({
      yaml: (port) => baseYaml(port, "hosted:\n  publicUrl: https://captions.example.org\n"),
    });
    const add = await turjuman(inst, [
      "screens",
      "add",
      "--name",
      "Main hall",
      "--from",
      "ar",
      "--to",
      "nl",
      "--json",
    ]);
    const screen = JSON.parse(add.stdout) as { id: string; url: string; localUrl: string };
    expect(screen.url).toMatch(/^https:\/\/captions\.example\.org\/feed\/[\w-]+$/);
    expect(screen.localUrl).toBe(
      screen.url.replace("https://captions.example.org", `http://127.0.0.1:${inst.port}`),
    );
    for (const ref of [screen.id, "main hall", "MAIN HALL"]) {
      expect(await turjuman(inst, ["screens", "url", ref])).toMatchObject({
        code: 0,
        stdout: `${screen.url}\n`,
      });
    }
    expect(await turjuman(inst, ["screens", "url", screen.id, "--local"])).toMatchObject({
      code: 0,
      stdout: `${screen.localUrl}\n`,
    });
  });

  it("screens rm asks first; no, no answer and yes", async ({ expect }) => {
    const inst = await install();
    const add = await turjuman(inst, [
      "screens",
      "add",
      "--name",
      "Gallery",
      "--from",
      "ar",
      "--to",
      "en",
      "--json",
    ]);
    const { id } = JSON.parse(add.stdout) as { id: string };
    const question = `Delete screen ${id} "Gallery" (ar → en)? Its link stops working. [y/N] \n`;
    expect(await turjuman(inst, ["screens", "rm", id], { input: "n\n" })).toMatchObject({
      code: 1,
      stdout: `${question}Not deleted.\n`,
    });
    expect(await turjuman(inst, ["screens", "rm", id])).toMatchObject({
      code: 1,
      stdout: `${question}Not deleted (no answer; add --yes to delete without asking).\n`,
    });
    expect(
      await turjuman(inst, ["screens", "rm", "Gallery"], { input: "maybe\ny\n" }),
    ).toMatchObject({
      code: 0,
      stdout: `${question}${question}Deleted screen ${id} "Gallery". Its link no longer works; pages still showing it stop within a few seconds.\n`,
    });
    expect((await turjuman(inst, ["screens", "list"])).stdout).toMatch(/^No screens yet\./);
  });

  it("screens refuses a wrong name, language, look or id, and screens made by the CLI in hosted mode", async ({
    expect,
  }) => {
    const inst = await install();
    await turjuman(inst, ["screens", "add", "--name", "Main hall", "--from", "ar", "--to", "nl"]);
    await turjuman(inst, ["screens", "add", "--name", "Main hall", "--from", "ar", "--to", "en"]);
    const cases: Array<[string[], number, RegExp | string]> = [
      [
        ["add", "--from", "ar", "--to", "nl"],
        2,
        'screens add: give the screen a name: --name "Main hall"\n',
      ],
      [
        ["add", "--name", "Y", "--from", "ar"],
        2,
        "screens add: give the languages: --from <code> --to <code>, e.g. --from ar --to nl\n",
      ],
      [
        ["add", "--name", "Y", "--from", "ar", "--to", "xx"],
        2,
        'screens add: Unknown target language "xx"\n',
      ],
      [
        ["add", "--name", "Y", "--from", "ar", "--to", "nl", "--preset", "nope"],
        2,
        /^screens add: unknown preset "nope" \(built in: mosque-dark, /,
      ],
      [
        ["add", "--name", "Y", "--from", "ar", "--to", "nl", "--layout", "grid"],
        2,
        'screens add: --layout is blocks or rollup, not "grid"\n',
      ],
      [
        ["add", "--name", "Y", "--from", "ar", "--to", "nl", "--size", "2"],
        2,
        "screens add: --size is a whole number of pixels from 8 to 300\n",
      ],
      [["url", "nope"], 1, 'screens url: no screen "nope" (see: pnpm turjuman screens list)\n'],
      [
        ["url", "a", "b"],
        2,
        'screens url: give one screen (quote a name with spaces: "Main hall")\n',
      ],
      [
        ["url", "Main hall"],
        1,
        /^screens url: 2 screens are called "Main hall"; use an id: \w+, \w+\n$/,
      ],
      [["enable"], 2, "screens enable: give a screen id (see: pnpm turjuman screens list)\n"],
      [
        ["disable", "nope"],
        1,
        'screens disable: no screen "nope" (see: pnpm turjuman screens list)\n',
      ],
      [
        ["rm", "nope", "--yes"],
        1,
        'screens rm: no screen "nope" (see: pnpm turjuman screens list)\n',
      ],
    ];
    for (const [args, code, stderr] of cases) {
      const r = await turjuman(inst, ["screens", ...args]);
      expect(r.code, args.join(" ")).toBe(code);
      expect(r.stdout, args.join(" ")).toBe("");
      if (typeof stderr === "string") expect(r.stderr, args.join(" ")).toBe(stderr);
      else expect(r.stderr, args.join(" ")).toMatch(stderr);
    }
    const hosted = await install({ yaml: (port) => hostedYaml(port) });
    const r = await turjuman(hosted, [
      "screens",
      "add",
      "--name",
      "X",
      "--from",
      "ar",
      "--to",
      "nl",
    ]);
    expect(r).toMatchObject({
      code: 2,
      stderr:
        "screens add: in hosted mode every mosque makes its own screens in the app; this adds screens in local mode\n",
    });
  });
});

describe.concurrent("turjuman orgs", () => {
  /** A mosque signs up on the hosted server (POST /api/auth/signup). */
  async function signup(base: string, orgName: string, email: string): Promise<void> {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgName, name: "Imam", email, password: PASSWORD }),
    });
    if (res.status !== 201) throw new Error(`sign-up: HTTP ${res.status} ${await res.text()}`);
  }

  it("orgs list shows the organisations that signed up; disable stops their logins and enable lets them in again", async ({
    expect,
  }) => {
    const inst = await install({ yaml: (port) => hostedYaml(port) });
    expect((await turjuman(inst, ["orgs", "list"])).stdout).toBe(
      "No organisations yet: mosques sign up at /signup.\n",
    );
    const srv = await serve(inst);
    await signup(srv.url, "Masjid An-Nur", "imam@example.org");

    const list = await turjuman(inst, ["orgs", "list"]);
    expect(list.code).toBe(0);
    const [head, row] = list.stdout.trimEnd().split("\n");
    expect(head).toMatch(/^ID\s+NAME\s+STATE\s+OWNER\s+ACCOUNTS\s+SCREENS\s+KEYS\s+MIN\/MONTH$/);
    const id = /^(\S+)\s+Masjid An-Nur\s+on\s+imam@example\.org\s+1\s+0\s+-\s+0\.0$/.exec(
      row ?? "",
    )?.[1];
    expect(id, list.stdout).toBeDefined();
    // Hosted accounts log in by e-mail and belong to an organisation.
    const users = await turjuman(inst, ["users", "list"]);
    expect(users.stdout).toMatch(/^ID\s+USERNAME\s+E-MAIL\s+ORG\s+NAME\s+ROLE\s+STATUS/);
    expect(users.stdout).toMatch(
      new RegExp(`imam@example\\.org\\s+${id}\\s+Imam\\s+owner\\s+active`),
    );

    expect(await turjuman(inst, ["orgs", "disable", id ?? ""])).toMatchObject({
      code: 0,
      stdout: `Disabled Masjid An-Nur (${id}): its accounts are logged out and its screens stop.\n`,
    });
    const refused = await waitUntil("the server to refuse the organisation", async () => {
      const r = await login(srv.url, "imam@example.org", PASSWORD);
      return r.status === 403 ? r : undefined;
    });
    expect(refused.body.message).toBe(
      "This organisation is disabled; contact the server's operator",
    );
    expect((await turjuman(inst, ["orgs", "list"])).stdout).toMatch(/Masjid An-Nur\s+disabled\s+/);

    expect(await turjuman(inst, ["orgs", "enable", id ?? ""])).toMatchObject({
      code: 0,
      stdout: `Enabled Masjid An-Nur (${id}).\n`,
    });
    await waitUntil(
      "the organisation's login to work again",
      async () => (await login(srv.url, "imam@example.org", PASSWORD)).status === 200,
    );
    // users passwd by e-mail works for hosted accounts.
    const passwd = await turjuman(inst, ["users", "passwd", "imam@example.org"], {
      input: "a new long password\n",
    });
    expect(passwd.code).toBe(0);
    await waitUntil(
      "the new password",
      async () => (await login(srv.url, "imam@example.org", "a new long password")).status === 200,
    );
  });

  it("orgs refuses a missing or unknown id and extra arguments; a local server has one organisation", async ({
    expect,
  }) => {
    const inst = await install({ yaml: (port) => hostedYaml(port) });
    const cases: Array<[string[], number, string]> = [
      [
        ["disable"],
        2,
        "Which organisation? pnpm turjuman orgs disable <id> (see pnpm turjuman orgs list)\n",
      ],
      [
        ["enable"],
        2,
        "Which organisation? pnpm turjuman orgs enable <id> (see pnpm turjuman orgs list)\n",
      ],
      [["disable", "nope"], 1, 'No organisation "nope" (see pnpm turjuman orgs list)\n'],
    ];
    for (const [args, code, stderr] of cases) {
      expect(await turjuman(inst, ["orgs", ...args]), args.join(" ")).toMatchObject({
        code,
        stderr,
        stdout: "",
      });
    }
    for (const args of [
      ["list", "x"],
      ["enable", "a", "b"],
    ]) {
      const r = await turjuman(inst, ["orgs", ...args]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr.startsWith("Too many arguments.\n\nturjuman orgs <command>")).toBe(true);
    }
    const local = await install();
    expect(await turjuman(local, ["orgs", "list"])).toMatchObject({
      code: 0,
      stdout: "Local mode: one organisation (this server). Hosted mode is set with mode: hosted.\n",
    });
  });
});
