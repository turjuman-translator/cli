import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configEnvFile,
  envValue,
  loadEnvInto,
  mergeEnv,
  readEnvFile,
  writeEnvFile,
} from "../../src/cli/env-file.js";

// Fake keys only: nothing here is a real credential.
const NEW_SONIOX = "fake-soniox-key-0000000000000000";
const NEW_MASTER = "fake-master-key-1111111111111111";

const EXISTING = `# Turjuman settings
# (comment kept)

SONIOX_API_KEY=old-soniox-value-00000000
DOMAIN=captions.example.org
export OTHER="two words # not a comment"
CERT="-----BEGIN
SONIOX_API_KEY=this-line-belongs-to-CERT
-----END"
TURJUMAN_MASTER_KEY=
UID=501
`;

describe("mergeEnv", () => {
  it("replaces only the two keys and keeps every other line, comment and blank line", () => {
    const out = mergeEnv(EXISTING, { SONIOX_API_KEY: NEW_SONIOX, TURJUMAN_MASTER_KEY: NEW_MASTER });
    expect(out).toBe(`# Turjuman settings
# (comment kept)

SONIOX_API_KEY=${NEW_SONIOX}
DOMAIN=captions.example.org
export OTHER="two words # not a comment"
CERT="-----BEGIN
SONIOX_API_KEY=this-line-belongs-to-CERT
-----END"
TURJUMAN_MASTER_KEY=${NEW_MASTER}
UID=501
`);
    const parsed = parseEnv(out);
    expect(parsed.SONIOX_API_KEY).toBe(NEW_SONIOX);
    expect(parsed.TURJUMAN_MASTER_KEY).toBe(NEW_MASTER);
    expect(parsed.CERT).toBe("-----BEGIN\nSONIOX_API_KEY=this-line-belongs-to-CERT\n-----END");
    expect(parsed.OTHER).toBe("two words # not a comment");
    expect(parsed.DOMAIN).toBe("captions.example.org");
  });

  it("leaves a key that is not in the update alone", () => {
    const out = mergeEnv(EXISTING, { SONIOX_API_KEY: NEW_SONIOX });
    expect(out).toContain("\nTURJUMAN_MASTER_KEY=\n");
    expect(parseEnv(out).SONIOX_API_KEY).toBe(NEW_SONIOX);
  });

  it("appends missing keys and creates text from nothing", () => {
    expect(mergeEnv("DOMAIN=x\n", { TURJUMAN_MASTER_KEY: NEW_MASTER })).toBe(
      `DOMAIN=x\nTURJUMAN_MASTER_KEY=${NEW_MASTER}\n`,
    );
    expect(mergeEnv("DOMAIN=x", { SONIOX_API_KEY: NEW_SONIOX })).toBe(
      `DOMAIN=x\nSONIOX_API_KEY=${NEW_SONIOX}\n`,
    );
    expect(mergeEnv("", { SONIOX_API_KEY: NEW_SONIOX, TURJUMAN_MASTER_KEY: "" })).toBe(
      `SONIOX_API_KEY=${NEW_SONIOX}\nTURJUMAN_MASTER_KEY=\n`,
    );
  });

  it("keeps the first assignment's place and export prefix, and drops later duplicates", () => {
    const out = mergeEnv(
      "export SONIOX_API_KEY=a-old-key-000000000\nX=1\nSONIOX_API_KEY=b-old-key-000000000\n",
      { SONIOX_API_KEY: NEW_SONIOX },
    );
    expect(out).toBe(`export SONIOX_API_KEY=${NEW_SONIOX}\nX=1\n`);
    expect(parseEnv(out).SONIOX_API_KEY).toBe(NEW_SONIOX);
  });

  it("replaces a quoted multi-line value of the key itself as a whole", () => {
    const out = mergeEnv('A=1\nSONIOX_API_KEY="old\nstill-old"\nB=2\n', {
      SONIOX_API_KEY: NEW_SONIOX,
    });
    expect(out).toBe(`A=1\nSONIOX_API_KEY=${NEW_SONIOX}\nB=2\n`);
  });

  it("keeps Windows line endings", () => {
    const out = mergeEnv("# keys\r\nSONIOX_API_KEY=old-old-old-old-old\r\nUID=1\r\n", {
      SONIOX_API_KEY: NEW_SONIOX,
    });
    expect(out).toBe(`# keys\r\nSONIOX_API_KEY=${NEW_SONIOX}\r\nUID=1\r\n`);
  });
});

describe("envValue", () => {
  it("writes plain keys bare and quotes the rest so Node reads them back unchanged", () => {
    expect(envValue("AIzaFAKE-key_value.123")).toBe("AIzaFAKE-key_value.123");
    expect(envValue("")).toBe("");
    for (const tricky of ["ab#cd-1234567890", "a$HOME-1234567890", 'q"uote-1234567890', "x y z"]) {
      const line = `K=${envValue(tricky)}`;
      expect(parseEnv(line).K).toBe(tricky);
    }
    expect(envValue("ab#cd")).toBe("'ab#cd'");
    expect(envValue("it's")).toBe(`"it's"`);
  });

  it("refuses values that no quoting can hold", () => {
    expect(() => envValue("a'b\"c")).toThrow(/quote/);
    expect(() => envValue("two\nlines")).toThrow(/single line/);
  });
});

describe(".env files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-env-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new file with mode 0600 and the header", () => {
    const file = join(dir, "sub", ".env");
    writeEnvFile(file, { SONIOX_API_KEY: NEW_SONIOX }, "# header\n");
    expect(readFileSync(file, "utf8")).toBe(`# header\nSONIOX_API_KEY=${NEW_SONIOX}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("updates an existing file atomically: a new inode, mode 0600, no temp file left", () => {
    const file = join(dir, ".env");
    writeFileSync(file, EXISTING, { mode: 0o644 });
    const before = statSync(file);
    expect(before.mode & 0o777).toBe(0o644);
    writeEnvFile(file, { SONIOX_API_KEY: NEW_SONIOX });
    const after = statSync(file);
    expect(after.mode & 0o777).toBe(0o600);
    // Replaced by rename (temp file + rename), not rewritten in place.
    expect(after.ino).not.toBe(before.ino);
    expect(readdirSync(dir)).toEqual([".env"]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# (comment kept)");
    expect(text).toContain("DOMAIN=captions.example.org");
    expect(readEnvFile(file).SONIOX_API_KEY).toBe(NEW_SONIOX);
  });

  it("updates a symlinked .env where it points and keeps the link", () => {
    const real = join(dir, "secrets", "turjuman.env");
    mkdirSync(join(dir, "secrets"));
    writeFileSync(real, "UID=1\n");
    const link = join(dir, ".env");
    symlinkSync(real, link);
    writeEnvFile(link, { TURJUMAN_MASTER_KEY: NEW_MASTER });
    expect(statSync(link).isFile()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`UID=1\nTURJUMAN_MASTER_KEY=${NEW_MASTER}\n`);
  });

  it("reads nothing from a missing file and never overrides variables that are set", () => {
    expect(readEnvFile(join(dir, "missing.env"))).toEqual({});
    const file = join(dir, ".env");
    writeFileSync(file, "SONIOX_API_KEY=from-file-000000000000\nDOMAIN=x\n");
    const env: NodeJS.ProcessEnv = { SONIOX_API_KEY: "from-shell-00000000000" };
    expect(loadEnvInto(file, env)).toBe(true);
    expect(env.SONIOX_API_KEY).toBe("from-shell-00000000000");
    expect(env.DOMAIN).toBe("x");
    expect(loadEnvInto(join(dir, "missing.env"), env)).toBe(false);
  });

  it("puts setup's .env in CONFIG_DIR, or the working directory", () => {
    expect(configEnvFile({}, dir)).toBe(join(dir, ".env"));
    expect(configEnvFile({ CONFIG_DIR: "config" }, dir)).toBe(join(dir, "config", ".env"));
  });
});
