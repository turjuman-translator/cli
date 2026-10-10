import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/paths.js";

describe("writeFileAtomic: bytes, modes and failures", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes bytes as given", () => {
    const file = join(dir, "audio.bin");
    writeFileAtomic(file, new Uint8Array([0, 1, 2, 255]));
    expect([...readFileSync(file)]).toEqual([0, 1, 2, 255]);
  });

  it("creates a file holding secrets with mode 0600, others with 0644", () => {
    if (process.platform === "win32") return;
    writeFileAtomic(join(dir, "secret.key"), "s\n", 0o600);
    writeFileAtomic(join(dir, "presets.yaml"), "presets: []\n");
    expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "presets.yaml")).mode & 0o777 & ~0o022).toBe(0o644 & ~0o022);
  });

  it("leaves the target and no temp file behind when the rename fails", () => {
    // The target is a folder with something in it: renaming a file over it always fails.
    const target = join(dir, "config.yaml");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "kept");
    expect(() => writeFileAtomic(target, "a: 1\n")).toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM/);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("kept");
  });

  it("throws when the folder does not exist, creating nothing", () => {
    expect(() => writeFileAtomic(join(dir, "missing", "x.yaml"), "x")).toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
