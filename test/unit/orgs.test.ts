import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyResolver } from "../../src/accounts/key-resolver.js";
import { MasterKey } from "../../src/accounts/keystore.js";
import { cleanOrgName, OrgStore } from "../../src/accounts/orgs.js";
import { ScreenStore } from "../../src/accounts/screens.js";
import { UserStore } from "../../src/accounts/users.js";
import { scrubSecrets } from "../../src/log.js";
import { PresetStore } from "../../src/presets.js";

const SONIOX = "soniox-stored-key-0123456789";
const ENV = { sonioxApiKey: "soniox-env-key-0123456789" };
const silent = pino({ level: "silent" });

describe("organisations", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orgs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("has an implicit local organisation that is written once it changes", () => {
    const orgs = new OrgStore(join(dir, "orgs.yaml"));
    expect(orgs.list()).toEqual([]);
    expect(orgs.get("local")?.name).toBe("Local");
    expect(orgs.get("nope")).toBeUndefined();
    orgs.rename("local", "  Masjid   An-Nour ");
    expect(orgs.get("local")?.name).toBe("Masjid An-Nour");
    expect(orgs.list().map((o) => o.id)).toEqual(["local"]);
  });

  it("creates, disables and stores keys (encrypted only), mode 0600, re-read on change", () => {
    const file = join(dir, "orgs.yaml");
    const orgs = new OrgStore(file);
    const org = orgs.create({ name: "Al-Fath" });
    expect(org.id).toMatch(/^[a-z2-7]{10}$/);
    const master = new MasterKey(join(dir, "master.key"), "");
    const resolver = new KeyResolver({ mode: "hosted", env: ENV, orgs, master, log: silent });
    resolver.store(org.id, "soniox", SONIOX, { validated: true, by: "u1" });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(SONIOX);
    expect(text).toContain("enc:v1:");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const other = new OrgStore(file);
    expect(other.get(org.id)?.keyMeta.soniox?.last4).toBe("6789");
    other.setDisabled(org.id, true);
    expect(orgs.get(org.id)?.disabled).toBe(true);
  });

  it("keeps the previous organisations when the file breaks", () => {
    const file = join(dir, "orgs.yaml");
    const orgs = new OrgStore(file);
    const org = orgs.create({ name: "Al-Fath" });
    writeFileSync(file, "orgs: [ {id: 1 ");
    expect(orgs.get(org.id)?.name).toBe("Al-Fath");
    expect(orgs.error).not.toBeNull();
    expect(() => orgs.create({ name: "Another" })).toThrow();
  });

  it("reads an older orgs.yaml with a Gemini key (removed engine): ignored, dropped on write", () => {
    const file = join(dir, "orgs.yaml");
    const meta = `{ last4: "6789", validatedAt: null, addedAt: "2026-09-01T00:00:00.000Z", addedBy: null }`;
    writeFileSync(
      file,
      `orgs:\n  - id: local\n    name: Local\n    createdAt: "2026-09-01T00:00:00.000Z"\n` +
        `    keys: { soniox: "enc:v1:c29uaW94", gemini: "enc:v1:Z2VtaW5p" }\n` +
        `    keyMeta: { soniox: ${meta}, gemini: ${meta} }\n`,
    );
    const orgs = new OrgStore(file);
    expect(orgs.error).toBeNull();
    const local = orgs.get("local");
    expect(local?.keys).toEqual({ soniox: "enc:v1:c29uaW94" });
    expect(Object.keys(local?.keyMeta ?? {})).toEqual(["soniox"]);
    orgs.rename("local", "Masjid");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("enc:v1:c29uaW94");
    expect(text).not.toContain("gemini");
  });

  it("cleans names", () => {
    expect(cleanOrgName("  ")).toBeNull();
    expect(cleanOrgName("Masjid\u0000 Taiba")).toBe("Masjid Taiba");
    expect([...(cleanOrgName("x".repeat(200)) ?? "")].length).toBe(80);
  });

  it("moves accounts and screens from older files into the local organisation", () => {
    const users = join(dir, "users.yaml");
    writeFileSync(
      users,
      `users:\n  - id: u1abc\n    username: imam\n    displayName: Imam\n    role: admin\n    passwordHash: scrypt$x\n    createdAt: "2026-01-01T00:00:00.000Z"\n`,
    );
    const screens = join(dir, "screens.yaml");
    writeFileSync(
      screens,
      `screens:\n  - id: s1abc\n    guid: 0b6c2a52-4c2f-4b3c-9a4e-0f1e2d3c4b5a\n    name: Hall\n    from: ar\n    to: nl\n    createdAt: "2026-01-01T00:00:00.000Z"\n    updatedAt: "2026-01-01T00:00:00.000Z"\n`,
    );
    expect(new UserStore(users).get("u1abc")?.orgId).toBe("local");
    expect(new UserStore(users).get("u1abc")?.email).toBeNull();
    expect(new ScreenStore(screens).get("s1abc")?.orgId).toBe("local");
  });

  it("scopes custom presets per organisation; local presets stay without orgId", () => {
    const file = join(dir, "presets.yaml");
    const presets = new PresetStore(file, new Set(["mosque-dark"]));
    expect(presets.upsert({ id: "hall", name: "Hall" }).ok).toBe(true);
    expect(presets.upsert({ id: "hall", name: "Their hall" }, "org2").ok).toBe(true);
    expect(presets.list().map((p) => p.name)).toEqual(["Hall"]);
    expect(presets.list("org2").map((p) => p.name)).toEqual(["Their hall"]);
    expect(presets.get("hall", "org3")).toBeUndefined();
    const text = readFileSync(file, "utf8");
    expect(text.match(/orgId/g)?.length).toBe(1);
    expect(new PresetStore(file).list("org2")).toHaveLength(1);
    expect(presets.remove("hall", "org2").ok).toBe(true);
    expect(presets.list()).toHaveLength(1);
    expect(presets.upsert({ id: "x", name: "X" }, "org2").ok).toBe(true);
    expect(presets.removeOrg("org2")).toBe(1);
    expect(presets.list().map((p) => p.id)).toEqual(["hall"]);
  });
});

describe("key resolver", () => {
  let dir: string;
  let orgs: OrgStore;
  let master: MasterKey;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keys-"));
    orgs = new OrgStore(join(dir, "orgs.yaml"));
    master = new MasterKey(join(dir, "master.key"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("local mode: .env first, then stored keys", () => {
    const resolver = new KeyResolver({ mode: "local", env: ENV, orgs, master, log: silent });
    resolver.store("local", "soniox", SONIOX, { validated: false, by: null });
    expect(resolver.resolve("local")).toEqual({ sonioxApiKey: ENV.sonioxApiKey });
    expect(resolver.status("local").soniox).toMatchObject({
      set: true,
      source: "env",
      last4: "6789",
    });
    const noEnv = new KeyResolver({
      mode: "local",
      env: { sonioxApiKey: null },
      orgs,
      master,
      log: silent,
    });
    expect(noEnv.resolve("local")).toEqual({ sonioxApiKey: SONIOX });
    expect(noEnv.status("local").soniox).toMatchObject({
      set: true,
      source: "stored",
      validatedAt: null,
    });
  });

  it("hosted mode: only the organisation's own keys, none when disabled", () => {
    const resolver = new KeyResolver({ mode: "hosted", env: ENV, orgs, master, log: silent });
    const a = orgs.create({ name: "A" });
    const b = orgs.create({ name: "B" });
    resolver.store(a.id, "soniox", SONIOX, { validated: true, by: null });
    expect(resolver.resolve(a.id)).toEqual({ sonioxApiKey: SONIOX });
    expect(resolver.resolve(b.id)).toEqual({ sonioxApiKey: null });
    expect(resolver.resolve("local").sonioxApiKey).toBeNull();
    expect(resolver.status(b.id).soniox).toMatchObject({ set: false, source: null });
    orgs.setDisabled(a.id, true);
    expect(resolver.resolve(a.id).sonioxApiKey).toBeNull();
    orgs.setDisabled(a.id, false);
    resolver.remove(a.id, "soniox");
    expect(resolver.resolve(a.id).sonioxApiKey).toBeNull();
  });

  it("decrypts from the file (another process stored it) and scrubs it from logs", () => {
    const a = orgs.create({ name: "A" });
    new KeyResolver({ mode: "hosted", env: ENV, orgs, master, log: silent }).store(
      a.id,
      "soniox",
      "soniox-decrypted-key-abcdef",
      { validated: true, by: null },
    );
    const fresh = new KeyResolver({
      mode: "hosted",
      env: ENV,
      orgs: new OrgStore(join(dir, "orgs.yaml")),
      master: new MasterKey(join(dir, "master.key"), ""),
      log: silent,
    });
    expect(fresh.resolve(a.id).sonioxApiKey).toBe("soniox-decrypted-key-abcdef");
    expect(scrubSecrets("failed with soniox-decrypted-key-abcdef", [])).toBe(
      "failed with [redacted]",
    );
  });

  it("never recreates a lost master.key while keys are sealed with it", () => {
    const a = orgs.create({ name: "A" });
    const resolver = new KeyResolver({ mode: "hosted", env: ENV, orgs, master, log: silent });
    resolver.store(a.id, "soniox", SONIOX, { validated: true, by: null });
    rmSync(join(dir, "master.key"));
    const fresh = new KeyResolver({
      mode: "hosted",
      env: ENV,
      orgs,
      master: new MasterKey(join(dir, "master.key"), ""),
      log: silent,
    });
    const b = orgs.create({ name: "B" });
    expect(() => fresh.store(b.id, "soniox", SONIOX, { validated: true, by: null })).toThrow(
      /master.key is missing/,
    );
  });

  it("a key that cannot be decrypted counts as missing", () => {
    const a = orgs.create({ name: "A" });
    new KeyResolver({ mode: "hosted", env: ENV, orgs, master, log: silent }).store(
      a.id,
      "soniox",
      SONIOX,
      { validated: true, by: null },
    );
    rmSync(join(dir, "master.key"));
    const fresh = new KeyResolver({
      mode: "hosted",
      env: ENV,
      orgs: new OrgStore(join(dir, "orgs.yaml")),
      master: new MasterKey(join(dir, "master.key"), ""),
      log: silent,
    });
    expect(fresh.resolve(a.id).sonioxApiKey).toBeNull();
    expect(fresh.status(a.id).soniox.set).toBe(false);
  });
});
