import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserStore } from "../../src/accounts/users.js";
import { usersCommand } from "../../src/cli/users.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";

describe("turjuman users with e-mail accounts (hosted)", () => {
  let dir: string;
  let loaded: LoadedConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "users-email-"));
    loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists e-mail and organisation, and finds accounts by e-mail", async () => {
    const store = new UserStore(loaded.paths.usersFile);
    const user = store.insert({
      username: "imam-k3x9",
      role: "owner",
      passwordHash: "scrypt$old",
      orgId: "abcdefghij",
      email: "imam@example.nl",
    });
    const out: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: (t: string) => void out.push(t) };
    expect(await usersCommand(["list"], io, loaded)).toBe(0);
    expect(out.join("\n")).toMatch(/E-MAIL\s+ORG/);
    expect(out.join("\n")).toContain("imam@example.nl");
    const code = await usersCommand(["passwd", "Imam@Example.NL"], io, loaded, {
      readPassword: async () => "a-new-password-123",
    });
    expect(code).toBe(0);
    expect(new UserStore(loaded.paths.usersFile).get(user.id)?.passwordHash).not.toBe("scrypt$old");
    expect(await usersCommand(["passwd", "nobody@example.nl"], io, loaded)).toBe(1);
  });
});
