import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GUID_RE, ScreenStore } from "../../src/accounts/screens.js";
import type { Prompter } from "../../src/cli/prompt.js";
import { lookQuery, type ScreensDeps, screensCommand } from "../../src/cli/screens-cmd.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";
import { themeQuery } from "../../src/shared/theme.js";

const PORT = 8796;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A temp CONFIG_DIR/DATA_DIR with config.yaml; never the repo's config/. */
function configDir(yaml = ""): { dir: string; loaded: LoadedConfig; store: ScreenStore } {
  const dir = mkdtempSync(join(tmpdir(), "cli-screens-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "config.yaml"),
    `languagesFile: ${join(process.cwd(), "languages.yaml")}\n${yaml.includes("server:") ? "" : `server:\n  port: ${PORT}\n`}${yaml}`,
  );
  const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
  return { dir, loaded, store: new ScreenStore(loaded.paths.screensFile) };
}

function cli(loaded: LoadedConfig, deps: ScreensDeps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) };
  return {
    out,
    err,
    run: (...args: string[]) => screensCommand(args, io, () => loaded, { lan: null, ...deps }),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

function answers(...list: Array<string | null>): Prompter & { asked: number } {
  const p = {
    asked: 0,
    interrupted: false,
    ask: async () => {
      p.asked++;
      return list.shift() ?? null;
    },
    askSecret: async () => null,
    close: () => {},
  };
  return p;
}

describe("turjuman screens add", () => {
  it("creates a screen (off, actor cli) like the builder would and prints its feed link", async () => {
    const { loaded, store } = configDir();
    const c = cli(loaded);
    expect(await c.run("add", "--name", "Main hall", "--from", "ar", "--to", "nl")).toBe(0);
    const [screen] = store.list();
    expect(screen).toMatchObject({
      name: "Main hall",
      from: "ar",
      to: "nl",
      query: "",
      enabled: false,
      ownerId: null,
      lastChange: { action: "created", by: "cli", byId: null },
    });
    expect(screen?.guid).toMatch(GUID_RE);
    const text = c.out.join("\n");
    expect(text).toContain(`Created screen ${screen?.id} "Main hall" (ar → nl, off).`);
    expect(text).toContain(`Screen link for OBS: http://127.0.0.1:${PORT}/feed/${screen?.guid}`);
    expect(text).toContain(`pnpm turjuman screens enable ${screen?.id}`);
  });

  it("writes the builder's look query for --preset/--layout/--size, and --enable switches it on", async () => {
    const { loaded, store } = configDir();
    const c = cli(loaded);
    const args = ["add", "--name", "Hall", "--from", "AR", "--to", "en", "--enable"];
    expect(
      await c.run(...args, "--preset", "mosque-light", "--layout", "rollup", "--size", "60"),
    ).toBe(0);
    const [screen] = store.list();
    expect(screen?.from).toBe("ar");
    expect(screen?.enabled).toBe(true);
    expect(screen?.lastChange).toMatchObject({ action: "enabled", by: "cli" });
    expect(screen?.query).toBe(
      themeQuery(
        "mosque-light",
        {},
        { layout: "rollup", size: 60 },
        { defaultPreset: "mosque-dark" },
      ),
    );
    expect(screen?.query).toContain("preset=mosque-light");
    expect(screen?.query).toContain("layout=rollup");
    expect(screen?.query).toContain("size=60");
    expect(c.out.join("\n")).toContain("(ar → en, on)");
  });

  it("omits the server's default preset, like the builder, and knows custom presets", async () => {
    const { dir, loaded } = configDir();
    expect(lookQuery(loaded, { preset: "mosque-dark" })).toBe("");
    expect(lookQuery(loaded, {})).toBe("");
    writeFileSync(
      join(dir, "presets.yaml"),
      "presets:\n  - id: my-look\n    name: My look\n    options: { layout: rollup }\n",
    );
    expect(lookQuery(loaded, { preset: "my-look" })).toBe("preset=my-look");
    const other = configDir("display:\n  preset: mosque-light\n").loaded;
    expect(lookQuery(other, { preset: "mosque-dark" })).toBe("preset=mosque-dark");
    expect(lookQuery(other, { preset: "mosque-light" })).toBe("");
  });

  it("refuses bad input with exit code 2 and writes nothing", async () => {
    const { loaded } = configDir();
    const c = cli(loaded);
    const base = ["add", "--name", "Hall", "--from", "ar", "--to", "nl"];
    const cases: Array<[string[], RegExp]> = [
      [["add", "--from", "ar", "--to", "nl"], /give the screen a name/],
      [["add", "--name", "   ", "--from", "ar", "--to", "nl"], /give the screen a name/],
      [["add", "--name", "Hall", "--from", "ar"], /give the languages/],
      [["add", "--name", "Hall", "--from", "ar", "--to", "ar"], /must differ/],
      [["add", "--name", "Hall", "--from", "xx", "--to", "nl"], /Unknown source language "xx"/],
      [["add", "--name", "Hall", "--from", "ar", "--to", "auto"], /cannot be "auto"/],
      [[...base, "--preset", "neon"], /unknown preset "neon"/],
      [[...base, "--layout", "grid"], /--layout is blocks or rollup/],
      [[...base, "--size", "5"], /--size is a whole number of pixels from 8 to 300/],
      [[...base, "--size", "big"], /--size/],
      [[...base, "--colour", "red"], /Unknown option '--colour'/],
    ];
    for (const [args, message] of cases) {
      c.clear();
      expect(await c.run(...args)).toBe(2);
      expect(c.err.join("\n")).toMatch(message);
    }
    expect(existsSync(loaded.paths.screensFile)).toBe(false);
  });

  it("is refused in hosted mode (every mosque makes its own screens)", async () => {
    const { loaded } = configDir("mode: hosted\n");
    const c = cli(loaded);
    expect(await c.run("add", "--name", "Hall", "--from", "ar", "--to", "nl")).toBe(2);
    expect(c.err.join("\n")).toMatch(/hosted mode/);
  });

  it("prints JSON with --json", async () => {
    const { loaded } = configDir();
    const c = cli(loaded);
    expect(await c.run("add", "--name", "Hall", "--from", "ar", "--to", "nl", "--json")).toBe(0);
    const view = JSON.parse(c.out.join("\n")) as { id: string; url: string; enabled: boolean };
    expect(view.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/feed/`));
    expect(view.enabled).toBe(false);
  });
});

describe("turjuman screens list / url / enable / disable / rm", () => {
  async function twoScreens() {
    const env = configDir();
    const c = cli(env.loaded);
    await c.run("add", "--name", "Main hall", "--from", "ar", "--to", "nl");
    await new Promise((r) => setTimeout(r, 5));
    await c.run("add", "--name", "Sisters", "--from", "ar", "--to", "en", "--enable");
    const all = env.store.list();
    const hall = all.find((s) => s.name === "Main hall");
    const sisters = all.find((s) => s.name === "Sisters");
    if (hall === undefined || sisters === undefined) throw new Error("screens missing");
    c.clear();
    return { ...env, c, hall, sisters };
  }

  it("lists one line per screen with id, name, languages, on/off and the feed link", async () => {
    const { c, hall, sisters } = await twoScreens();
    expect(await c.run("list")).toBe(0);
    const lines = c.out.join("\n").split("\n");
    expect(lines[0]).toMatch(/^ID\s+NAME\s+LANGUAGES\s+STATE\s+SCREEN LINK$/);
    expect(lines).toHaveLength(3);
    // Newest first, like the app.
    expect(lines[1]).toMatch(
      new RegExp(
        `^${sisters.id}\\s+Sisters\\s+ar → en\\s+on\\s+http://127\\.0\\.0\\.1:${PORT}/feed/${sisters.guid}$`,
      ),
    );
    expect(lines[2]).toMatch(
      new RegExp(`^${hall.id}\\s+Main hall\\s+ar → nl\\s+off\\s+.*/feed/${hall.guid}$`),
    );
    c.clear();
    expect(await c.run("list", "--links")).toBe(0);
    expect(c.out.join("\n")).toContain(hall.guid);
  });

  it("lists machine-readable JSON with --json", async () => {
    const { c, hall } = await twoScreens();
    expect(await c.run("list", "--json")).toBe(0);
    const list = JSON.parse(c.out.join("\n")) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      id: hall.id,
      name: "Main hall",
      from: "ar",
      to: "nl",
      enabled: false,
      url: `http://127.0.0.1:${PORT}/feed/${hall.guid}`,
    });
  });

  it("says how to make the first screen when there is none", async () => {
    const { loaded } = configDir();
    const c = cli(loaded);
    expect(await c.run("list")).toBe(0);
    expect(c.out.join("\n")).toMatch(/No screens yet/);
    c.clear();
    expect(await c.run("list", "--json")).toBe(0);
    expect(JSON.parse(c.out.join("\n"))).toEqual([]);
  });

  it("prints a feed link by id or by exact name", async () => {
    const { c, hall } = await twoScreens();
    expect(await c.run("url", hall.id)).toBe(0);
    expect(c.out).toEqual([`http://127.0.0.1:${PORT}/feed/${hall.guid}`]);
    c.clear();
    expect(await c.run("url", "main HALL")).toBe(0);
    expect(c.out).toEqual([`http://127.0.0.1:${PORT}/feed/${hall.guid}`]);
    c.clear();
    expect(await c.run("url", "nope")).toBe(1);
    expect(c.err.join("\n")).toMatch(/no screen "nope"/);
    expect(await c.run("url")).toBe(2);
    expect(await c.run("url", "Main", "hall")).toBe(2);
  });

  it("asks for an id when two screens share a name", async () => {
    const { loaded } = configDir();
    const c = cli(loaded);
    await c.run("add", "--name", "Hall", "--from", "ar", "--to", "nl");
    await c.run("add", "--name", "Hall", "--from", "ar", "--to", "en");
    c.clear();
    expect(await c.run("url", "Hall")).toBe(1);
    expect(c.err.join("\n")).toMatch(/2 screens are called "Hall"; use an id/);
  });

  it("switches screens on and off (actor cli) and leaves an unchanged screen alone", async () => {
    const { c, hall, store } = await twoScreens();
    expect(await c.run("enable", hall.id)).toBe(0);
    expect(store.get(hall.id)).toMatchObject({
      enabled: true,
      lastChange: { action: "enabled", by: "cli" },
    });
    expect(c.out.join("\n")).toContain(`Screen ${hall.id} "Main hall" is now on.`);
    const updatedAt = store.get(hall.id)?.updatedAt;
    c.clear();
    expect(await c.run("enable", hall.id)).toBe(0);
    expect(c.out.join("\n")).toContain("is on already");
    expect(store.get(hall.id)?.updatedAt).toBe(updatedAt);
    expect(await c.run("disable", "Main hall")).toBe(0);
    expect(store.get(hall.id)).toMatchObject({
      enabled: false,
      lastChange: { action: "disabled", by: "cli" },
    });
    expect(await c.run("disable", "missing")).toBe(1);
  });

  it("deletes only after a yes, or with --yes", async () => {
    const { c, hall, sisters, store, loaded } = await twoScreens();
    const no = answers("n");
    expect(await cli(loaded, { prompter: no }).run("rm", hall.id)).toBe(1);
    expect(no.asked).toBe(1);
    expect(store.get(hall.id)).toBeDefined();
    const silent = cli(loaded, { prompter: answers(null) });
    expect(await silent.run("rm", hall.id)).toBe(1);
    expect(silent.out.join("\n")).toMatch(/Not deleted \(no answer; add --yes/);
    expect(await cli(loaded, { prompter: answers("y") }).run("rm", hall.id)).toBe(0);
    expect(store.get(hall.id)).toBeUndefined();
    const never = answers();
    expect(await cli(loaded, { prompter: never }).run("rm", sisters.id, "--yes")).toBe(0);
    expect(never.asked).toBe(0);
    expect(store.list()).toEqual([]);
    expect(await c.run("rm", sisters.id, "--yes")).toBe(1);
  });

  it("shows help and rejects unknown commands", async () => {
    const { loaded } = configDir();
    const c = cli(loaded);
    expect(await c.run()).toBe(2);
    expect(await c.run("help")).toBe(0);
    expect(c.out.join("\n")).toContain("mosque-dark");
    const noLoad = await screensCommand(["add", "--help"], { out: () => {}, err: () => {} }, () => {
      throw new Error("must not load");
    });
    expect(noLoad).toBe(0);
    expect(await c.run("frobnicate")).toBe(2);
  });
});

describe("feed link origins", () => {
  async function urlOf(yaml: string, deps: ScreensDeps = {}, setup?: (dir: string) => void) {
    const { dir, loaded } = configDir(yaml);
    setup?.(dir);
    const c = cli(loaded, deps);
    await c.run("add", "--name", "Hall", "--from", "ar", "--to", "nl");
    c.clear();
    await c.run("list", "--json");
    const [view] = JSON.parse(c.out.join("\n")) as Array<{ url: string }>;
    return view?.url.replace(/\/feed\/.*$/, "");
  }

  it("uses hosted.publicUrl when it is set", async () => {
    expect(await urlOf("hosted:\n  publicUrl: https://captions.example.org/\n")).toBe(
      "https://captions.example.org",
    );
  });

  it("uses this machine's address in local exposure (127.0.0.1 for 0.0.0.0)", async () => {
    expect(await urlOf("")).toBe(`http://127.0.0.1:${PORT}`);
  });

  it("uses HTTPS on the LAN when its certificate exists, else this computer (never plain-http LAN)", async () => {
    const lan = `server:\n  host: 0.0.0.0\n  port: ${PORT}\n  exposure: lan\n`;
    // A caption page on http://<lan-ip> cannot open the microphone, not even on this computer.
    expect(await urlOf(lan, { lan: "192.168.1.20" })).toBe(`http://127.0.0.1:${PORT}`);
    expect(await urlOf(lan, { lan: null })).toBe(`http://127.0.0.1:${PORT}`);
    const https = `server:\n  host: 0.0.0.0\n  port: ${PORT}\n  exposure: lan\n  https:\n    port: 8443\n`;
    expect(await urlOf(https, { lan: "192.168.1.20" })).toBe(`http://127.0.0.1:${PORT}`);
    const withCert = (dir: string) => {
      mkdirSync(join(dir, "tls"));
      writeFileSync(join(dir, "tls", "server.crt"), "test certificate");
      writeFileSync(join(dir, "tls", "server.key"), "test key");
    };
    expect(await urlOf(https, { lan: "192.168.1.20" }, withCert)).toBe("https://192.168.1.20:8443");
  });

  it("with HTTPS links, also gives this computer's 127.0.0.1 link (list note, add, url --local, JSON)", async () => {
    const { dir, loaded } = configDir(
      `server:\n  host: 0.0.0.0\n  port: ${PORT}\n  exposure: lan\n  https:\n    port: 8443\n`,
    );
    mkdirSync(join(dir, "tls"));
    writeFileSync(join(dir, "tls", "server.crt"), "test certificate");
    writeFileSync(join(dir, "tls", "server.key"), "test key");
    const c = cli(loaded, { lan: "192.168.1.20" });
    expect(await c.run("add", "--name", "Hall", "--from", "ar", "--to", "nl")).toBe(0);
    const [screen] = new ScreenStore(loaded.paths.screensFile).list();
    const local = `http://127.0.0.1:${PORT}/feed/${screen?.guid}`;
    expect(c.out.join("\n")).toContain(
      `Screen link for OBS: https://192.168.1.20:8443/feed/${screen?.guid}`,
    );
    expect(c.out.join("\n")).toContain(`On this computer:  ${local}`);
    c.clear();
    expect(await c.run("url", "Hall", "--local")).toBe(0);
    expect(c.out).toEqual([local]);
    c.clear();
    await c.run("list");
    expect(c.out.join("\n")).toContain("OBS on this computer can use");
    expect(c.out.join("\n")).toContain("pnpm turjuman screens url <id> --local");
    c.clear();
    await c.run("list", "--json");
    expect(JSON.parse(c.out.join("\n"))[0]).toMatchObject({ localUrl: local });
  });

  it("prints no 127.0.0.1 note when the links are this computer's own", async () => {
    const { loaded } = configDir();
    const c = cli(loaded);
    await c.run("add", "--name", "Hall", "--from", "ar", "--to", "nl");
    expect(c.out.join("\n")).not.toContain("On this computer");
    c.clear();
    await c.run("list");
    expect(c.out.join("\n")).not.toContain("--local");
  });
});
