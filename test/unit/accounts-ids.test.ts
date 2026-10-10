import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgStore } from "../../src/accounts/orgs.js";
import { ScreenStore } from "../../src/accounts/screens.js";
import { UserStore } from "../../src/accounts/users.js";

// Random ids are 50+ bits, so a clash never happens by chance in a test: these queues force the
// next random values (then the real generator takes over again).
const forced = vi.hoisted(() => ({
  ints: [] as number[],
  idBytes: [] as Buffer[],
  uuids: [] as string[],
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomInt: (max: number) => forced.ints.shift() ?? actual.randomInt(max),
    randomBytes: (size: number) =>
      (size === 6 ? forced.idBytes.shift() : undefined) ?? actual.randomBytes(size),
    randomUUID: () => forced.uuids.shift() ?? actual.randomUUID(),
  };
});

const GUID_A = "0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a";
const GUID_B = "1c7d3b63-5d30-4c4d-8b5f-1a2b3c4d5e6f";
const AT = '"2026-01-01T00:00:00.000Z"';

describe("new ids never reuse an existing one", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ids-"));
  });
  afterEach(() => {
    forced.ints.length = 0;
    forced.idBytes.length = 0;
    forced.uuids.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it("organisations: draws again when the id is taken", () => {
    const file = join(dir, "orgs.yaml");
    writeFileSync(file, `orgs:\n  - { id: aaaaaaaaaa, name: First, createdAt: ${AT} }\n`);
    forced.ints.push(...Array<number>(10).fill(0), ...Array<number>(10).fill(1));
    const org = new OrgStore(file).create({ name: "Second" });
    expect(org.id).toBe("bbbbbbbbbb");
    expect(forced.ints).toEqual([]);
    expect(new OrgStore(file).list().map((o) => [o.id, o.name])).toEqual([
      ["aaaaaaaaaa", "First"],
      ["bbbbbbbbbb", "Second"],
    ]);
  });

  it("screens: draws again when the id or the GUID is taken", () => {
    const file = join(dir, "screens.yaml");
    writeFileSync(
      file,
      `screens:\n  - { id: aaaaaaaaaa, guid: ${GUID_A}, name: Hall, from: ar, to: nl, createdAt: ${AT}, updatedAt: ${AT} }\n`,
    );
    forced.ints.push(...Array<number>(10).fill(0), ...Array<number>(10).fill(1));
    forced.uuids.push(GUID_A, GUID_B);
    const screen = new ScreenStore(file).create(
      { name: "Second", from: "ar", to: "en", query: "", ownerId: null },
      { id: null, name: "cli" },
    );
    expect(screen.id).toBe("bbbbbbbbbb");
    expect(screen.guid).toBe(GUID_B);
    expect(forced.uuids).toEqual([]);
    expect(new ScreenStore(file).byGuid(GUID_A)?.name).toBe("Hall");
    expect(new ScreenStore(file).byGuid(GUID_B)?.name).toBe("Second");
  });

  it("accounts: draws again when the id is taken", () => {
    const file = join(dir, "users.yaml");
    writeFileSync(
      file,
      `users:\n  - { id: "000000000000", username: imam, displayName: Imam, role: owner, passwordHash: h, createdAt: ${AT} }\n`,
    );
    forced.idBytes.push(Buffer.alloc(6, 0), Buffer.alloc(6, 1));
    const u = new UserStore(file).insert({ username: "helper", role: "user", passwordHash: "h" });
    expect(u.id).toBe("010101010101");
    expect(forced.idBytes).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain('id: "000000000000"');
    expect(new UserStore(file).list().map((x) => x.username)).toEqual(["imam", "helper"]);
  });
});
