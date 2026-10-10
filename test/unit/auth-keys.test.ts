import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKey, hashKey, KeyStore } from "../../src/auth/keys.js";
import { TRACK_IDS } from "../../src/shared/protocol.js";

// Fault injection for the paths the file system never takes on its own: a write that fails, a
// file removed right after it was written, a parser that throws something other than an Error,
// and a random id that collides. By default every mock delegates to the real implementation.
const faults = vi.hoisted(() => ({
  write: "real" as "real" | "fail" | "vanish",
  ids: [] as string[],
}));

vi.mock("../../src/paths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/paths.js")>();
  return {
    ...real,
    writeFileAtomic: (file: string, data: string | Uint8Array, mode?: number) => {
      if (faults.write === "fail") throw new Error("EROFS: read-only file system");
      real.writeFileAtomic(file, data, mode);
      if (faults.write === "vanish") rmSync(file);
    },
  };
});

vi.mock("yaml", async (importOriginal) => {
  const real = await importOriginal<typeof import("yaml")>();
  return {
    ...real,
    parse: (src: string, ...rest: unknown[]) => {
      if (src.includes("THROW-A-STRING")) throw "not an Error object";
      return (real.parse as (s: string, ...r: unknown[]) => unknown)(src, ...rest);
    },
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    randomBytes: (size: number) => {
      const id = size === 4 ? faults.ids.shift() : undefined;
      return id === undefined ? real.randomBytes(size) : Buffer.from(id, "hex");
    },
  };
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("access keys (keys.yaml)", () => {
  let dir: string;
  let file: string;
  let clock: { t: number };
  let store: KeyStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keys-"));
    file = join(dir, "conf", "keys.yaml");
    clock = { t: Date.parse("2026-10-08T12:00:00Z") };
    store = new KeyStore(file, () => clock.t);
    faults.write = "real";
    faults.ids = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * keys.yaml written by hand (or by another process), each time with a distinct mtime: some file
   * systems keep the same mtime for writes within a few milliseconds.
   */
  let stamp = 0;
  const writeKeys = (body: string) => {
    mkdirSync(join(dir, "conf"), { recursive: true });
    writeFileSync(file, body);
    stamp += 1;
    utimesSync(file, 1_700_000_000 + stamp, 1_700_000_000 + stamp);
  };
  const entryYaml = (id: string, key: string, extra = "") =>
    `  - id: ${id}\n    label: L-${id}\n    keyHash: ${sha256(key)}\n    createdAt: "2026-01-01T00:00:00.000Z"\n${extra}`;

  it("hashes keys with SHA-256 and generates 43-character base64url keys", () => {
    expect(hashKey("abc")).toBe(sha256("abc"));
    const a = generateKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(a);
  });

  it("without a file: no keys, no error, and nothing verifies", () => {
    expect(store.list()).toEqual([]);
    expect(store.error).toBeNull();
    expect(store.get("nope")).toBeUndefined();
    expect(store.verify("anything")).toBeNull();
    expect(store.revoke("nope")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("adds a key: shown once, stored only as a hash (0600), with defaults", () => {
    const { id, key, entry } = store.add({ label: "  Screen hall  " });
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(entry).toEqual({
      id,
      label: "Screen hall",
      dailyMinutes: null,
      engines: [...TRACK_IDS],
      createdAt: "2026-10-08T12:00:00.000Z",
    });
    const body = readFileSync(file, "utf8");
    expect(body).toMatch(/^# Access keys for remote caption pages/);
    expect(body).toContain(hashKey(key));
    expect(body).not.toContain(key);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.list()).toEqual([entry]);
    expect(store.get(id)).toEqual(entry);
    expect(JSON.stringify(store.list())).not.toContain("keyHash");
    // Another store (the server) reads the same file.
    expect(new KeyStore(file).list()).toEqual([entry]);
  });

  it("adds a key with a daily budget, engines (deduplicated) and an expiry", () => {
    const { entry } = store.add({
      label: "guest",
      dailyMinutes: 90,
      engines: ["soniox", "soniox"],
      expires: "2026-12-31",
    });
    expect(entry.dailyMinutes).toBe(90);
    expect(entry.engines).toEqual(["soniox"]);
    expect(entry.expires).toBe("2026-12-31T00:00:00.000Z");
  });

  it("refuses bad requests", () => {
    expect(() => store.add({ label: "   " })).toThrow("A key needs a --label");
    for (const dailyMinutes of [0, -5, Number.NaN]) {
      expect(() => store.add({ label: "x", dailyMinutes })).toThrow(
        "--daily-minutes must be a positive number",
      );
    }
    expect(() => store.add({ label: "x", engines: [] })).toThrow(
      "--engines needs at least one engine",
    );
    expect(() => store.add({ label: "x", expires: "someday" })).toThrow(
      "--expires: not a date: someday",
    );
    expect(existsSync(file)).toBe(false);
  });

  it("draws a new id when the random one is taken", () => {
    const first = store.add({ label: "a" });
    faults.ids = [first.id, first.id, "0badc0de"];
    const second = store.add({ label: "b" });
    expect(second.id).toBe("0badc0de");
    expect(store.list().map((k) => k.id)).toEqual([first.id, "0badc0de"]);
  });

  it("revokes a key: it stops verifying, the others keep working", () => {
    const a = store.add({ label: "a" });
    const b = store.add({ label: "b" });
    expect(store.revoke(a.id)).toEqual(a.entry);
    expect(store.revoke(a.id)).toBeUndefined();
    expect(store.verify(a.key)).toBeNull();
    expect(store.verify(b.key)?.id).toBe(b.id);
    expect(store.list().map((k) => k.id)).toEqual([b.id]);
  });

  it("verifies a key against every entry and records its last use at most once a minute", () => {
    const a = store.add({ label: "a" });
    const b = store.add({ label: "b" });
    expect(store.verify("wrong")).toBeNull();
    expect(store.verify(b.key)?.id).toBe(b.id);
    const used = () => store.get(b.id)?.lastUsedAt;
    expect(used()).toBe("2026-10-08T12:00:00.000Z");
    clock.t += 59_999;
    store.verify(b.key);
    expect(used()).toBe("2026-10-08T12:00:00.000Z");
    clock.t += 1;
    store.verify(b.key);
    expect(used()).toBe("2026-10-08T12:01:00.000Z");
    expect(store.get(a.id)?.lastUsedAt).toBeUndefined();
  });

  it("an expired key no longer verifies", () => {
    const { key } = store.add({ label: "a", expires: "2026-10-08T13:00:00Z" });
    expect(store.verify(key)).not.toBeNull();
    clock.t = Date.parse("2026-10-08T13:00:00Z");
    expect(store.verify(key)).toBeNull();
  });

  it("the empty key never verifies, even when the file holds its hash", () => {
    writeKeys(`keys:\n${entryYaml("e0", "")}`);
    expect(store.list().map((k) => k.id)).toEqual(["e0"]);
    expect(store.verify("")).toBeNull();
  });

  it("the first of two entries with the same hash wins", () => {
    writeKeys(`keys:\n${entryYaml("d1", "dup")}${entryYaml("d2", "dup")}`);
    expect(store.verify("dup")?.id).toBe("d1");
  });

  it("re-reads the file when it changes, appears or disappears", () => {
    writeKeys(`keys:\n${entryYaml("k1", "one")}`);
    expect(store.list().map((k) => k.id)).toEqual(["k1"]);
    writeKeys(`keys:\n${entryYaml("k1", "one")}${entryYaml("k2", "two")}`);
    expect(store.verify("two")?.id).toBe("k2");
    rmSync(file);
    expect(store.list()).toEqual([]);
    expect(store.verify("two")).toBeNull();
  });

  it("an empty file or `keys:` without entries means no keys", () => {
    writeKeys("# nothing yet\n");
    expect(store.list()).toEqual([]);
    expect(store.error).toBeNull();
    writeKeys("keys:\n");
    store.reload(true);
    expect(store.list()).toEqual([]);
    expect(store.error).toBeNull();
    expect(store.add({ label: "first" }).entry.label).toBe("first");
  });

  it("an invalid file keeps the previous keys, reports why, and blocks edits", () => {
    writeKeys(`keys:\n${entryYaml("k1", "one")}`);
    expect(store.verify("one")?.id).toBe("k1");
    writeKeys(`keys:\n  - id: k1\n    keyHash: nothex\n`);
    expect(store.error).toMatch(/^Invalid .*keys\.yaml:\n {2}- keys\.0\./);
    expect(store.verify("one")?.id).toBe("k1");
    expect(() => store.add({ label: "x" })).toThrow(/^Invalid /);
    expect(() => store.revoke("k1")).toThrow(/^Invalid /);

    writeKeys("keys: [unclosed\n");
    store.reload(true);
    expect(store.error).not.toBeNull();
    expect(store.list().map((k) => k.id)).toEqual(["k1"]);

    writeKeys("THROW-A-STRING\n");
    store.reload(true);
    expect(store.error).toBe("not an Error object");

    writeKeys(`keys:\n${entryYaml("k3", "three")}`);
    expect(store.error).toBeNull();
    expect(store.list().map((k) => k.id)).toEqual(["k3"]);
  });

  it("verification still works when lastUsedAt cannot be saved", () => {
    const { key, id } = store.add({ label: "a" });
    clock.t += 120_000;
    faults.write = "fail";
    expect(store.verify(key)?.id).toBe(id);
    faults.write = "real";
    expect(readFileSync(file, "utf8")).not.toContain("lastUsedAt");
    expect(new KeyStore(file).get(id)?.lastUsedAt).toBeUndefined();
  });

  it("an add fails when the file cannot be written, and leaves no key that works", () => {
    const kept = store.add({ label: "kept" });
    faults.write = "fail";
    expect(() => store.add({ label: "a" })).toThrow("EROFS");
    faults.write = "real";
    // Only the key that was saved exists, in this store and in a fresh one.
    expect(store.list().map((k) => k.label)).toEqual(["kept"]);
    expect(new KeyStore(file).list().map((k) => k.label)).toEqual(["kept"]);
    expect(store.verify(kept.key)?.id).toBe(kept.id);
  });

  it("a revoke that cannot be written keeps the key (listed and working)", () => {
    const { key, id } = store.add({ label: "a" });
    faults.write = "fail";
    expect(() => store.revoke(id)).toThrow("EROFS");
    faults.write = "real";
    expect(store.get(id)?.label).toBe("a");
    expect(store.verify(key)?.id).toBe(id);
    expect(store.revoke(id)?.id).toBe(id);
    expect(store.verify(key)).toBeNull();
  });

  it("an add whose write fails before the file exists leaves no file", () => {
    faults.write = "fail";
    expect(() => store.add({ label: "a" })).toThrow("EROFS");
    expect(existsSync(file)).toBe(false);
    faults.write = "real";
    expect(store.list()).toEqual([]);
  });

  it("does not resurrect a key file removed while a key was being verified", () => {
    const { key, id } = store.add({ label: "a" });
    clock.t += 120_000;
    // The CLI removes keys.yaml between the check and the lastUsedAt write.
    const racing = new KeyStore(file, () => {
      if (existsSync(file)) rmSync(file);
      return clock.t;
    });
    expect(racing.verify(key)?.id).toBe(id);
    expect(existsSync(file)).toBe(false);
  });

  it("an add succeeds when the file is removed right after the write, and a new file is read", () => {
    faults.write = "vanish";
    expect(store.add({ label: "a" }).key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    faults.write = "real";
    expect(existsSync(file)).toBe(false);
    writeKeys(`keys:\n${entryYaml("k9", "nine")}`);
    expect(store.list().map((k) => k.id)).toEqual(["k9"]);
  });
});
