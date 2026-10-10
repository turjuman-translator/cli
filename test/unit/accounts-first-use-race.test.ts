import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/accounts/keystore.js";
import { SigningSecret } from "../../src/accounts/secret.js";

// Another process (the CLI next to the server) creates the file between this process's look at
// it (stat: missing) and its own attempt to create it.
const race = vi.hoisted(() => ({ file: "", content: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (path: string) => {
      if (race.file !== "" && path === race.file) {
        race.file = "";
        actual.writeFileSync(path, race.content, { mode: 0o600 });
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), {
          code: "ENOENT",
        });
      }
      return actual.statSync(path);
    },
  };
});

describe("a key file created by another process at the same moment is used, never replaced", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "race-"));
  });
  afterEach(() => {
    race.file = "";
    rmSync(dir, { recursive: true, force: true });
  });

  it("master.key: keys stored by either process stay readable", () => {
    const file = join(dir, "master.key");
    const theirs = randomBytes(32);
    race.file = file;
    race.content = `${theirs.toString("base64url")}\n`;
    const sealed = new MasterKey(file, "").encrypt("org1", "soniox", "soniox-key-0123456789");
    expect(race.file).toBe("");
    expect(readFileSync(file, "utf8")).toBe(race.content);
    const their = new MasterKey(join(dir, "unused.key"), theirs.toString("base64"));
    expect(their.decrypt("org1", "soniox", sealed)).toBe("soniox-key-0123456789");
  });

  it("secret.key: logins signed by either process stay valid", () => {
    const file = join(dir, "secret.key");
    const theirs = randomBytes(32);
    race.file = file;
    race.content = `${theirs.toString("base64url")}\n`;
    const mac = new SigningSecret(file, "").sign("session:payload");
    expect(race.file).toBe("");
    expect(readFileSync(file, "utf8")).toBe(race.content);
    expect(mac).toBe(createHmac("sha256", theirs).update("session:payload").digest("base64url"));
  });
});
