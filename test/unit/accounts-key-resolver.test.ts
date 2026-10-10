import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY_PROVIDERS,
  KeyResolver,
  storedLocalKeys,
  storedLocalKeyValues,
} from "../../src/accounts/key-resolver.js";
import { MASTER_KEY_ENV, MasterKey } from "../../src/accounts/keystore.js";
import { OrgStore } from "../../src/accounts/orgs.js";
import { type LoadedConfig, loadConfig } from "../../src/config.js";
import { scrubSecrets } from "../../src/log.js";

const STORED = "soniox-stored-key-resolver-0123";
const ENV_KEY = "soniox-env-key-resolver-4567";

/** A logger whose entries are kept as parsed JSON. */
function capturedLog(): { log: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const log = pino(
    { level: "debug" },
    { write: (line: string) => entries.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { log, entries };
}

/** orgs.yaml that cannot be read right now (another program holds it, a disk error, …). */
class UnreadableOrgs extends OrgStore {
  override get(): never {
    throw new Error("EIO: i/o error, read");
  }
}

describe("key resolver: what goes wrong", () => {
  let dir: string;
  let orgs: OrgStore;
  let master: MasterKey;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolver-"));
    orgs = new OrgStore(join(dir, "orgs.yaml"));
    master = new MasterKey(join(dir, "master.key"), "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists Soniox as the only key provider", () => {
    expect(KEY_PROVIDERS).toEqual(["soniox"]);
  });

  it("never throws when orgs.yaml cannot be read: logs it and uses what is left", () => {
    const { log, entries } = capturedLog();
    const broken = new UnreadableOrgs(join(dir, "orgs.yaml"));
    const local = new KeyResolver({
      mode: "local",
      env: { sonioxApiKey: ENV_KEY },
      orgs: broken,
      master,
      log,
    });
    expect(local.resolve("local")).toEqual({ sonioxApiKey: ENV_KEY });
    const hosted = new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: ENV_KEY },
      orgs: broken,
      master,
      log,
    });
    expect(hosted.resolve("abcdefghij")).toEqual({ sonioxApiKey: null });
    expect(entries.map((e) => [e.level, e.msg, e.org])).toEqual([
      [50, "keys: orgs.yaml could not be read", "local"],
      [50, "keys: orgs.yaml could not be read", "abcdefghij"],
    ]);
    expect(JSON.stringify(entries)).toContain("EIO: i/o error");
  });

  it("logs why a stored key cannot be used, without the key, and counts it as missing", () => {
    const org = orgs.create({ name: "Al-Fath" });
    new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs,
      master,
      log: pino({ level: "silent" }),
    }).store(org.id, "soniox", STORED, { validated: true, by: null });
    const { log, entries } = capturedLog();
    const wrongMaster = new MasterKey(
      join(dir, "other.key"),
      Buffer.alloc(32, 9).toString("base64"),
    );
    const resolver = new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs,
      master: wrongMaster,
      log,
    });
    expect(resolver.resolve(org.id)).toEqual({ sonioxApiKey: null });
    // A failed decryption is remembered for this stored value: logged once, not per session.
    expect(resolver.resolve(org.id)).toEqual({ sonioxApiKey: null });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 50,
      msg: "keys: a stored key cannot be used",
      org: org.id,
      provider: "soniox",
      reason: "the key cannot be decrypted (wrong master key or tampered value)",
    });
    expect(JSON.stringify(entries)).not.toContain(STORED);
  });

  it('calls an error that is not about the key itself an "unexpected error"', () => {
    const org = orgs.create({ name: "Al-Fath" });
    new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs,
      master,
      log: pino({ level: "silent" }),
    }).store(org.id, "soniox", STORED, { validated: true, by: null });
    // master.key is a folder: reading it fails with EISDIR, not a KeyStoreError.
    const folder = join(dir, "folder.key");
    mkdirSync(folder);
    const { log, entries } = capturedLog();
    const resolver = new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs,
      master: new MasterKey(folder, ""),
      log,
    });
    expect(resolver.resolve(org.id).sonioxApiKey).toBeNull();
    expect(entries[0]).toMatchObject({ provider: "soniox", reason: "unexpected error" });
  });

  it("decrypts each stored value once, and again when another process replaces it", () => {
    const org = orgs.create({ name: "Al-Fath" });
    const decrypt = vi.spyOn(master, "decrypt");
    const resolver = new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs: new OrgStore(join(dir, "orgs.yaml")),
      master,
      log: pino({ level: "silent" }),
    });
    const other = new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs,
      master: new MasterKey(join(dir, "master.key"), ""),
      log: pino({ level: "silent" }),
    });
    other.store(org.id, "soniox", STORED, { validated: true, by: "u1" });
    expect(resolver.resolve(org.id).sonioxApiKey).toBe(STORED);
    expect(resolver.resolve(org.id).sonioxApiKey).toBe(STORED);
    expect(decrypt).toHaveBeenCalledTimes(1);
    other.store(org.id, "soniox", "soniox-replaced-key-0123456789", {
      validated: false,
      by: "u1",
    });
    expect(resolver.resolve(org.id).sonioxApiKey).toBe("soniox-replaced-key-0123456789");
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(resolver.status(org.id).soniox).toMatchObject({
      set: true,
      last4: "6789",
      validatedAt: null,
      source: "stored",
    });
  });

  it("stores with the time and the account, and forgets a removed key in the log scrubber", () => {
    const org = orgs.create({ name: "Al-Fath" });
    const resolver = new KeyResolver({
      mode: "hosted",
      env: { sonioxApiKey: null },
      orgs,
      master,
      log: pino({ level: "silent" }),
      now: () => Date.UTC(2026, 9, 9, 12, 0, 0),
    });
    const status = resolver.store(org.id, "soniox", "soniox-removed-later-0123", {
      validated: true,
      by: "u1abc",
    });
    expect(status).toEqual({
      provider: "soniox",
      set: true,
      last4: "0123",
      validatedAt: "2026-10-09T12:00:00.000Z",
      source: "stored",
    });
    expect(orgs.get(org.id)?.keyMeta.soniox).toEqual({
      last4: "0123",
      validatedAt: "2026-10-09T12:00:00.000Z",
      addedAt: "2026-10-09T12:00:00.000Z",
      addedBy: "u1abc",
    });
    expect(scrubSecrets("key soniox-removed-later-0123", [])).toBe("key [redacted]");
    expect(resolver.remove(org.id, "soniox")).toEqual({
      provider: "soniox",
      set: false,
      last4: null,
      validatedAt: null,
      source: null,
    });
    expect(scrubSecrets("key soniox-removed-later-0123", [])).toBe("key soniox-removed-later-0123");
  });
});

describe("the keys added in the app, for doctor, setup and start (local mode)", () => {
  let dir: string;
  let loaded: LoadedConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-keys-"));
    vi.stubEnv(MASTER_KEY_ENV, undefined);
    loaded = loadConfig({ env: { CONFIG_DIR: dir }, cwd: dir });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function storeLocal(key: string): void {
    new KeyResolver({
      mode: "local",
      env: { sonioxApiKey: null },
      orgs: new OrgStore(loaded.paths.orgsFile),
      master: new MasterKey(loaded.paths.masterKeyFile),
      log: pino({ level: "silent" }),
    }).store("local", "soniox", key, { validated: false, by: null });
  }

  it("are missing on a new install", () => {
    expect(storedLocalKeyValues(loaded)).toEqual({ soniox: null });
    expect(storedLocalKeys(loaded)).toEqual({ soniox: false });
  });

  it("are read from orgs.yaml with master.key, and never the .env key", () => {
    storeLocal(STORED);
    expect(storedLocalKeyValues(loaded)).toEqual({ soniox: STORED });
    expect(storedLocalKeys(loaded)).toEqual({ soniox: true });
    const withEnv = { ...loaded, secrets: { sonioxApiKey: ENV_KEY } };
    expect(storedLocalKeyValues(withEnv)).toEqual({ soniox: STORED });
  });

  it("count as missing when master.key is lost or orgs.yaml is broken (never throws)", () => {
    storeLocal(STORED);
    const other = new MasterKey(join(dir, "elsewhere.key"), Buffer.alloc(32, 3).toString("base64"));
    expect(storedLocalKeyValues(loaded, other)).toEqual({ soniox: null });
    expect(storedLocalKeys(loaded, other)).toEqual({ soniox: false });
    writeFileSync(loaded.paths.orgsFile, "orgs: [ {id: 1 ");
    expect(storedLocalKeyValues(loaded)).toEqual({ soniox: null });
    expect(storedLocalKeys(loaded)).toEqual({ soniox: false });
  });
});
