import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgStore } from "../../src/accounts/orgs.js";
import { ScreenStore } from "../../src/accounts/screens.js";
import { UserStore } from "../../src/accounts/users.js";
import { runCli } from "../../src/cli/index.js";
import { ORGS_HELP, orgsCommand } from "../../src/cli/orgs.js";
import { orgUsageKey, UsageStore } from "../../src/core/usage.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

const HOSTED = "mode: hosted\n";
const SEALED = "enc:v1:not-a-real-key";

function cells(line: string | undefined): string[] {
  return (line ?? "").split(/ {2,}/);
}

describe("turjuman orgs list", () => {
  it("explains local mode and an empty hosted server", async () => {
    const c = capture();
    expect(await orgsCommand(["list"], c.io, configured().loaded)).toBe(0);
    expect(await orgsCommand(["list"], c.io, configured(HOSTED).loaded)).toBe(0);
    expect(c.out).toEqual([
      "Local mode: one organisation (this server). Hosted mode is set with mode: hosted.",
      "No organisations yet: mosques sign up at /signup.",
    ]);
  });

  it("lists organisations oldest first with owner, accounts, screens, keys and minutes", async () => {
    const { loaded } = configured(HOSTED);
    let t = Date.parse("2026-01-01T00:00:00Z");
    const orgs = new OrgStore(loaded.paths.orgsFile, () => (t += 60_000));
    const first = orgs.create({ name: "Masjid An-Nour" });
    const second = orgs.create({ name: "Al-Fath" });
    orgs.setKey(first.id, "soniox", SEALED, {
      last4: "abcd",
      validatedAt: null,
      addedAt: "x",
      addedBy: null,
    });
    orgs.setDisabled(second.id, true);
    const users = new UserStore(loaded.paths.usersFile);
    const owner = users.insert({
      username: "imam-1",
      role: "owner",
      passwordHash: "scrypt$x",
      orgId: first.id,
      email: "imam@example.nl",
    });
    users.insert({ username: "helper-1", role: "user", passwordHash: "scrypt$x", orgId: first.id });
    users.insert({
      username: "owner-2",
      role: "owner",
      passwordHash: "scrypt$x",
      orgId: second.id,
    });
    const screens = new ScreenStore(loaded.paths.screensFile);
    const actor = { name: "cli", id: null };
    for (const name of ["Hall", "Women"]) {
      screens.create(
        { name, from: "ar", to: "nl", query: "", ownerId: owner.id, orgId: first.id },
        actor,
      );
    }
    const usage = new UsageStore({ dir: loaded.paths.usageDir, flushIntervalMs: 0 });
    usage.add(orgUsageKey(first.id), "soniox", 150_000);
    usage.add(orgUsageKey(first.id), "soniox", 30_000);
    usage.add("some-access-key", "soniox", 60_000); // not an organisation: the local one's
    usage.close();

    const c = capture();
    expect(await orgsCommand(["list"], c.io, loaded)).toBe(0);
    const lines = (c.out[0] ?? "").split("\n");
    expect(lines.map(cells)).toEqual([
      ["ID", "NAME", "STATE", "OWNER", "ACCOUNTS", "SCREENS", "KEYS", "MIN/MONTH"],
      [first.id, "Masjid An-Nour", "on", "imam@example.nl", "2", "2", "soniox", "3.0"],
      [second.id, "Al-Fath", "disabled", "owner-2", "1", "0", "-", "0.0"],
    ]);
    expect(lines[1]?.indexOf("imam@example.nl")).toBe(lines[0]?.indexOf("OWNER"));
    expect(c.err).toEqual([]);
  });

  it("shows - for an organisation without an owner, and counts its keyless minutes as local", async () => {
    const { loaded } = configured(HOSTED);
    const orgs = new OrgStore(loaded.paths.orgsFile);
    // The local organisation gets a record once it is changed; access-key minutes are its.
    const localOrg = orgs.setDisabled("local", false);
    const usage = new UsageStore({ dir: loaded.paths.usageDir, flushIntervalMs: 0 });
    usage.add("key-1", "soniox", 120_000);
    usage.add(null, "soniox", 60_000);
    usage.close();
    const c = capture();
    expect(await orgsCommand(["list"], c.io, loaded)).toBe(0);
    expect((c.out[0] ?? "").split("\n").map(cells)[1]).toEqual([
      localOrg.id,
      "Local",
      "on",
      "-",
      "0",
      "0",
      "-",
      "3.0",
    ]);
  });

  it("warns about a broken orgs.yaml", async () => {
    const { loaded } = configured(HOSTED);
    writeFileSync(loaded.paths.orgsFile, "orgs:\n  - id: ''\n");
    const c = capture();
    expect(await orgsCommand(["list"], c.io, loaded)).toBe(0);
    expect(c.err[0]).toMatch(/^Warning: Invalid .*orgs\.yaml/);
    expect(c.out).toEqual(["No organisations yet: mosques sign up at /signup."]);
  });
});

describe("turjuman orgs disable and enable", () => {
  it("switches an organisation off and on again", async () => {
    const { loaded } = configured(HOSTED);
    const orgs = new OrgStore(loaded.paths.orgsFile);
    const org = orgs.create({ name: "Masjid An-Nour" });
    const c = capture();
    expect(await orgsCommand(["disable", org.id], c.io, loaded)).toBe(0);
    expect(orgs.get(org.id)?.disabled).toBe(true);
    expect(await orgsCommand(["enable", org.id], c.io, loaded)).toBe(0);
    expect(orgs.get(org.id)?.disabled).toBe(false);
    expect(c.out).toEqual([
      `Disabled Masjid An-Nour (${org.id}): its accounts are logged out and its screens stop.`,
      `Enabled Masjid An-Nour (${org.id}).`,
    ]);
  });

  it("asks which organisation, and says when there is no such one", async () => {
    const { loaded } = configured(HOSTED);
    const c = capture();
    expect(await orgsCommand(["disable"], c.io, loaded)).toBe(2);
    expect(await orgsCommand(["enable", ""], c.io, loaded)).toBe(2);
    expect(await orgsCommand(["enable", "nope"], c.io, loaded)).toBe(1);
    expect(c.err).toEqual([
      "Which organisation? pnpm turjuman orgs disable <id> (see pnpm turjuman orgs list)",
      "Which organisation? pnpm turjuman orgs enable <id> (see pnpm turjuman orgs list)",
      'No organisation "nope" (see pnpm turjuman orgs list)',
    ]);
    // In the Docker image the hints are make commands.
    vi.stubEnv("CAPTIONS_CONTAINER", "1");
    c.clear();
    expect(await orgsCommand(["enable", "nope"], c.io, loaded)).toBe(1);
    expect(c.err).toEqual([`No organisation "nope" (see make cli ARGS='orgs list')`]);
  });

  it("reports a file it cannot change with exit code 1", async () => {
    const { loaded } = configured(HOSTED);
    const orgs = new OrgStore(loaded.paths.orgsFile);
    const org = orgs.create({ name: "Masjid" });
    // Valid when listed, broken by the time it is written (another process edits it).
    const store = vi.spyOn(OrgStore.prototype, "setDisabled").mockImplementation(() => {
      throw new Error("orgs.yaml is read-only");
    });
    const c = capture();
    expect(await orgsCommand(["disable", org.id], c.io, loaded)).toBe(1);
    expect(c.err).toEqual(["orgs disable: orgs.yaml is read-only"]);
    expect(store).toHaveBeenCalledOnce();
  });

  it("refuses extra arguments, unknown commands and none at all with exit code 2", async () => {
    const { loaded } = configured(HOSTED);
    const cases: Array<[string[], string]> = [
      [["list", "extra"], `Too many arguments.\n\n${ORGS_HELP}`],
      [["disable", "a", "b"], `Too many arguments.\n\n${ORGS_HELP}`],
      [["rename", "a"], `Unknown orgs command: rename\n\n${ORGS_HELP}`],
      [[], ORGS_HELP],
    ];
    for (const [args, message] of cases) {
      const c = capture();
      expect(await orgsCommand(args, c.io, loaded)).toBe(2);
      expect(c.err).toEqual([message]);
    }
    for (const sub of ["help", "--help", "-h"]) {
      const c = capture();
      expect(await orgsCommand([sub], c.io, loaded)).toBe(0);
      expect(c.out).toEqual([ORGS_HELP]);
    }
  });

  it("runCli refuses an option with the orgs usage", async () => {
    const { dir } = configured(HOSTED);
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["orgs", "list", "--all"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman orgs: Unknown option '--all'.\n\n${ORGS_HELP}`);
    c.clear();
    expect(await runCli(["orgs", "list"], c.io)).toBe(0);
    expect(c.out).toEqual(["No organisations yet: mosques sign up at /signup."]);
  });
});
