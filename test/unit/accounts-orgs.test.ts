import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_ORG_ID, ORG_ID_RE, OrgStore } from "../../src/accounts/orgs.js";
import { AccountError } from "../../src/accounts/users.js";

const SEALED = "enc:v1:aXY:dGFn:Y3Q";
const META = {
  last4: "1234",
  validatedAt: null,
  addedAt: "2026-10-01T00:00:00.000Z",
  addedBy: null,
};

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

describe("organisation store: edits and mistakes", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orgstore-"));
    file = join(dir, "config", "orgs.yaml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates an organisation with a fresh id and the creation time, in a new folder", () => {
    const orgs = new OrgStore(file, () => Date.UTC(2026, 9, 9));
    const org = orgs.create({ name: "  Masjid\tAn-Nour  " });
    expect(org).toEqual({
      id: org.id,
      name: "Masjid An-Nour",
      createdAt: "2026-10-09T00:00:00.000Z",
      disabled: false,
      keys: {},
      keyMeta: {},
    });
    expect(org.id).toMatch(ORG_ID_RE);
    expect(readFileSync(file, "utf8")).toMatch(/^# Organisations\. Managed by the app/);
    expect(new OrgStore(file).get(org.id)?.name).toBe("Masjid An-Nour");
  });

  it("refuses an empty name when creating or renaming", () => {
    const orgs = new OrgStore(file);
    expect(accountError(() => orgs.create({ name: " \u0000 " }))).toEqual({
      status: 400,
      message: "Give your mosque or organisation a name",
    });
    const org = orgs.create({ name: "Al-Fath" });
    expect(accountError(() => orgs.rename(org.id, "​"))).toEqual({
      status: 400,
      message: "Give your mosque or organisation a name",
    });
    expect(orgs.get(org.id)?.name).toBe("Al-Fath");
  });

  it("answers 404 for an organisation that does not exist (local always exists)", () => {
    const orgs = new OrgStore(file);
    const missing = { status: 404, message: "No such organisation" };
    expect(accountError(() => orgs.rename("nope", "X"))).toEqual(missing);
    expect(accountError(() => orgs.setDisabled("nope", true))).toEqual(missing);
    expect(accountError(() => orgs.removeKey("nope", "soniox"))).toEqual(missing);
    expect(accountError(() => orgs.remove("nope"))).toEqual(missing);
    expect(accountError(() => orgs.remove(LOCAL_ORG_ID))).toEqual(missing);
    expect(orgs.setDisabled(LOCAL_ORG_ID, false).name).toBe("Local");
  });

  it("stores only encrypted keys, and removes them again", () => {
    const orgs = new OrgStore(file);
    const org = orgs.create({ name: "Al-Fath" });
    expect(() => orgs.setKey(org.id, "soniox", "plain-text-key-0123", META)).toThrow(
      "setKey expects an encrypted key",
    );
    expect(orgs.get(org.id)?.keys).toEqual({});
    const withKey = orgs.setKey(org.id, "soniox", SEALED, META);
    expect(withKey.keys).toEqual({ soniox: SEALED });
    expect(withKey.keyMeta).toEqual({ soniox: META });
    // What the caller gets is a copy: changing it changes nothing stored.
    withKey.keys.soniox = "enc:v1:changed";
    if (withKey.keyMeta.soniox !== undefined) withKey.keyMeta.soniox.last4 = "0000";
    expect(orgs.get(org.id)?.keys.soniox).toBe(SEALED);
    expect(orgs.get(org.id)?.keyMeta.soniox?.last4).toBe("1234");
    const without = orgs.removeKey(org.id, "soniox");
    expect(without.keys).toEqual({});
    expect(without.keyMeta).toEqual({});
    expect(new OrgStore(file).get(org.id)?.keys).toEqual({});
  });

  it("deletes an organisation record (and only that one)", () => {
    const orgs = new OrgStore(file);
    const a = orgs.create({ name: "A" });
    const b = orgs.create({ name: "B" });
    expect(orgs.remove(a.id).name).toBe("A");
    expect(orgs.list().map((o) => o.id)).toEqual([b.id]);
    expect(new OrgStore(file).get(a.id)).toBeUndefined();
  });

  it("reads an empty file, or one with no organisations, as none", () => {
    writeFileSync(join(dir, "empty.yaml"), "");
    expect(new OrgStore(join(dir, "empty.yaml")).list()).toEqual([]);
    expect(new OrgStore(join(dir, "empty.yaml")).error).toBeNull();
    writeFileSync(join(dir, "null.yaml"), "orgs:\n");
    const orgs = new OrgStore(join(dir, "null.yaml"));
    expect(orgs.list()).toEqual([]);
    expect(orgs.create({ name: "First" }).name).toBe("First");
    expect(orgs.list()).toHaveLength(1);
  });

  it("reports an invalid orgs.yaml with every problem, and refuses to write until fixed", () => {
    const bad = join(dir, "bad.yaml");
    writeFileSync(
      bad,
      [
        "orgs:",
        "  - { id: abcdefghij, name: A, createdAt: x }",
        "  - { id: abcdefghij, name: B, createdAt: x }",
        "  - { id: 'bad id', name: '', createdAt: x }",
      ].join("\n"),
    );
    const orgs = new OrgStore(bad);
    expect(orgs.list()).toEqual([]);
    const error = orgs.error ?? "";
    expect(error).toContain(`Invalid ${bad}:`);
    expect(error).toContain("orgs.2.id:");
    expect(error).toContain("orgs.2.name:");
    expect(() => orgs.create({ name: "C" })).toThrow(/Invalid .*bad\.yaml/);
    writeFileSync(
      bad,
      [
        "orgs:",
        "  - { id: abcdefghij, name: A, createdAt: x }",
        "  - { id: abcdefghij, name: B, createdAt: x }",
      ].join("\n"),
    );
    orgs.reload(true);
    expect(orgs.error).toContain("(root): duplicate organisation abcdefghij");
    writeFileSync(bad, "orgs:\n  - { id: abcdefghij, name: A, createdAt: x }\n");
    orgs.reload(true);
    expect(orgs.error).toBeNull();
    expect(orgs.list().map((o) => o.name)).toEqual(["A"]);
  });

  it("forgets every organisation when orgs.yaml is deleted", () => {
    const orgs = new OrgStore(file);
    const org = orgs.create({ name: "A" });
    rmSync(file);
    expect(orgs.get(org.id)).toBeUndefined();
    expect(orgs.list()).toEqual([]);
    expect(orgs.get(LOCAL_ORG_ID)?.name).toBe("Local");
  });
});
