import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanScreenName,
  GUID_RE,
  type NewScreen,
  newScreenId,
  type ScreenRecord,
  ScreenStore,
  sanitizeQuery,
  screenTarget,
  screenUrl,
} from "../../src/accounts/screens.js";
import { AccountError } from "../../src/accounts/users.js";

const IMAM = { id: "u1abc", name: "Imam" };
const CLI = { id: null, name: "cli" };
const HALL: NewScreen = { name: "Main hall", from: "ar", to: "nl", query: "", ownerId: "u1abc" };
const T0 = Date.UTC(2026, 9, 9, 10, 0, 0);

/** The AccountError a call throws (status and message), or null. */
function accountError(fn: () => unknown): { status: number; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof AccountError)) throw err;
    return { status: err.status, message: err.message };
  }
}

describe("screen links and names", () => {
  const screen = {
    guid: "0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a",
    from: "ar",
    to: "nl",
    query: "preset=mosque-dark&engine=gemini&translation=llm&size=48",
  } as ScreenRecord;

  it("makes the feed link from the GUID only", () => {
    expect(screenUrl("https://turjuman.example", screen)).toBe(
      "https://turjuman.example/feed/0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a",
    );
  });

  it("sends the feed to the caption page with its look, without the removed engine choice", () => {
    expect(screenTarget(screen)).toBe(
      "/ar/nl?preset=mosque-dark&size=48&screen=0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a",
    );
    expect(screenTarget({ ...screen, from: "auto", to: "zh/tw", query: "" })).toBe(
      "/auto/zh%2Ftw?screen=0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a",
    );
  });

  it("keeps only the look in a stored query: no screen, sig, key, token or engine", () => {
    expect(
      sanitizeQuery(
        " ?preset=hall&SCREEN=x&sig=y&key=secret&Token=t&engine=gemini&translation=llm&size=40 ",
      ),
    ).toBe("preset=hall&size=40");
    expect(sanitizeQuery("")).toBe("");
  });

  it("cleans names and makes random ids", () => {
    expect(cleanScreenName("  Main\n\thall‎ ")).toBe("Main hall");
    expect(cleanScreenName(" \u0000 ")).toBeNull();
    expect([...(cleanScreenName("é".repeat(200)) ?? "")]).toHaveLength(80);
    const ids = new Set(Array.from({ length: 50 }, () => newScreenId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{10}$/);
  });
});

describe("screen store", () => {
  let dir: string;
  let file: string;
  let now: number;
  let screens: ScreenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "screens-"));
    file = join(dir, "config", "screens.yaml");
    now = T0;
    screens = new ScreenStore(file, () => now);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a screen switched off, with a GUID link, its creator and the local organisation", () => {
    const s = screens.create(HALL, IMAM);
    expect(s).toEqual({
      id: s.id,
      guid: s.guid,
      name: "Main hall",
      ownerId: "u1abc",
      orgId: "local",
      from: "ar",
      to: "nl",
      query: "",
      enabled: false,
      ownerControl: false,
      version: 1,
      createdAt: "2026-10-09T10:00:00.000Z",
      updatedAt: "2026-10-09T10:00:00.000Z",
      lastChange: { action: "created", by: "Imam", byId: "u1abc", at: "2026-10-09T10:00:00.000Z" },
    });
    expect(s.guid).toMatch(GUID_RE);
    expect(screens.byGuid(s.guid)?.id).toBe(s.id);
    expect(screens.create({ ...HALL, orgId: "abcdefghij" }, IMAM).orgId).toBe("abcdefghij");
    expect(readFileSync(file, "utf8")).toMatch(/^# Screens: caption feeds/);
  });

  it("refuses a screen without a name", () => {
    expect(accountError(() => screens.create({ ...HALL, name: "\t" }, IMAM))).toEqual({
      status: 400,
      message: "A screen needs a name",
    });
    expect(screens.list()).toEqual([]);
  });

  it("finds a screen by GUID only while the GUID is current", () => {
    const s = screens.create(HALL, IMAM);
    expect(screens.byGuid("not-a-guid")).toBeNull();
    expect(screens.byGuid("0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a")).toBeNull();
    const next = screens.update(s.id, { regenerate: true }, "regenerated", IMAM);
    expect(next.version).toBe(2);
    expect(next.guid).not.toBe(s.guid);
    expect(screens.byGuid(s.guid)).toBeNull();
    expect(screens.byGuid(next.guid)?.id).toBe(s.id);
  });

  it("edits name, look, on/off and owner control, recording who did it and when", () => {
    const s = screens.create(HALL, IMAM);
    now = T0 + 60_000;
    const edited = screens.update(
      s.id,
      { name: "  Women's hall ", query: "preset=hall", enabled: true, ownerControl: true },
      "edited",
      CLI,
    );
    expect(edited).toMatchObject({
      name: "Women's hall",
      query: "preset=hall",
      enabled: true,
      ownerControl: true,
      version: 1,
      guid: s.guid,
      createdAt: "2026-10-09T10:00:00.000Z",
      updatedAt: "2026-10-09T10:01:00.000Z",
      lastChange: { action: "edited", by: "cli", byId: null, at: "2026-10-09T10:01:00.000Z" },
    });
    // An empty patch changes only the record of the change.
    now = T0 + 120_000;
    const same = screens.update(s.id, {}, "reset", IMAM);
    expect(same).toMatchObject({ name: "Women's hall", enabled: true, query: "preset=hall" });
    expect(same.lastChange?.action).toBe("reset");
    expect(new ScreenStore(file).get(s.id)?.updatedAt).toBe("2026-10-09T10:02:00.000Z");
  });

  it("refuses an empty new name and unknown screens", () => {
    const s = screens.create(HALL, IMAM);
    expect(accountError(() => screens.update(s.id, { name: "  " }, "edited", IMAM))).toEqual({
      status: 400,
      message: "A screen needs a name",
    });
    expect(screens.get(s.id)?.name).toBe("Main hall");
    const missing = { status: 404, message: "No such screen" };
    expect(accountError(() => screens.update("nope", {}, "edited", IMAM))).toEqual(missing);
    expect(accountError(() => screens.remove("nope"))).toEqual(missing);
  });

  it("deletes a screen; its link stops working", () => {
    const s = screens.create(HALL, IMAM);
    const other = screens.create({ ...HALL, name: "Other" }, IMAM);
    expect(screens.remove(s.id).name).toBe("Main hall");
    expect(screens.get(s.id)).toBeUndefined();
    expect(screens.byGuid(s.guid)).toBeNull();
    expect(screens.list().map((x) => x.id)).toEqual([other.id]);
  });

  it("moves the screens of a deleted account to another owner (or none)", () => {
    const a = screens.create(HALL, IMAM);
    const b = screens.create({ ...HALL, name: "B" }, IMAM);
    const c = screens.create({ ...HALL, name: "C", ownerId: "u2def" }, IMAM);
    const d = screens.create({ ...HALL, name: "D", ownerId: null }, CLI);
    expect(screens.countByOwner()).toEqual(
      new Map([
        ["u1abc", 2],
        ["u2def", 1],
      ]),
    );
    expect(screens.reassign("u1abc", "u3ghi")).toBe(2);
    expect([a, b, c, d].map((s) => screens.get(s.id)?.ownerId)).toEqual([
      "u3ghi",
      "u3ghi",
      "u2def",
      null,
    ]);
    expect(screens.reassign("u2def", null)).toBe(1);
    expect(screens.get(c.id)?.ownerId).toBeNull();
    expect(screens.reassign("nobody", "u3ghi")).toBe(0);
    expect(new ScreenStore(file).countByOwner()).toEqual(new Map([["u3ghi", 2]]));
  });

  it("deletes every screen of a deleted organisation and returns them", () => {
    const local = screens.create(HALL, IMAM);
    const a = screens.create({ ...HALL, orgId: "orgaaaaaaa" }, IMAM);
    const b = screens.create({ ...HALL, name: "B", orgId: "orgaaaaaaa" }, IMAM);
    expect(screens.inOrg("orgaaaaaaa").map((s) => s.id)).toEqual([a.id, b.id]);
    expect(screens.removeOrg("orgbbbbbbb")).toEqual([]);
    expect(screens.removeOrg("orgaaaaaaa").map((s) => s.name)).toEqual(["Main hall", "B"]);
    expect(screens.list().map((s) => s.id)).toEqual([local.id]);
    expect(screens.byGuid(a.guid)).toBeNull();
  });

  it("gives screens from before feed GUIDs a GUID once, and keeps it", () => {
    writeFileSync(
      join(dir, "old.yaml"),
      [
        "screens:",
        "  - id: s1abc",
        "    name: Hall",
        "    from: ar",
        "    to: nl",
        "    query: preset=hall",
        "    enabled: true",
        '    createdAt: "2026-01-01T00:00:00.000Z"',
        '    updatedAt: "2026-01-01T00:00:00.000Z"',
      ].join("\n"),
    );
    const old = new ScreenStore(join(dir, "old.yaml"));
    const guid = old.get("s1abc")?.guid ?? "";
    expect(guid).toMatch(GUID_RE);
    expect(readFileSync(join(dir, "old.yaml"), "utf8")).toContain(`guid: ${guid}`);
    expect(new ScreenStore(join(dir, "old.yaml")).get("s1abc")?.guid).toBe(guid);
    expect(old.get("s1abc")).toMatchObject({ enabled: true, orgId: "local", version: 1 });
  });

  it("reads an empty file, or one with no screens, as none", () => {
    writeFileSync(join(dir, "empty.yaml"), "");
    expect(new ScreenStore(join(dir, "empty.yaml")).list()).toEqual([]);
    writeFileSync(join(dir, "null.yaml"), "screens:\n");
    const none = new ScreenStore(join(dir, "null.yaml"));
    expect(none.list()).toEqual([]);
    expect(none.error).toBeNull();
    expect(none.create(HALL, IMAM).name).toBe("Main hall");
  });

  it("keeps the previous screens when screens.yaml breaks, and refuses to write", () => {
    const s = screens.create({ ...HALL }, IMAM);
    screens.update(s.id, { enabled: true }, "enabled", IMAM);
    const dup = [
      "screens:",
      ...["s1abc", "s1abc"].map(
        (id) =>
          `  - { id: ${id}, guid: 0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a, name: H, from: ar, to: nl, createdAt: x, updatedAt: x }`,
      ),
    ].join("\n");
    writeFileSync(file, dup);
    screens.reload(true);
    expect(screens.error).toContain("(root): duplicate screen id s1abc");
    expect(screens.error).toContain("(root): duplicate screen guid on screen s1abc");
    // A broken file must not switch every screen off (or on).
    expect(screens.get(s.id)?.enabled).toBe(true);
    expect(() => screens.create(HALL, IMAM)).toThrow(/duplicate screen id/);
    expect(() => screens.reassign("u1abc", null)).toThrow(/duplicate screen id/);
    writeFileSync(file, "screens:\n  - { id: x }\n");
    screens.reload(true);
    expect(screens.error).toMatch(/^Invalid .*screens\.yaml:/);
    expect(screens.error).toContain("screens.0.id:");
    writeFileSync(file, "screens: [ {id: 1 ");
    screens.reload(true);
    expect(screens.error).not.toBeNull();
    expect(screens.list().map((x) => x.id)).toEqual([s.id]);
  });
});
