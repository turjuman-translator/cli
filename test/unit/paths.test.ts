import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDirs, resolveIn, writeFileAtomic } from "../../src/paths.js";

describe("resolveDirs", () => {
  it("defaults both dirs to the working directory", () => {
    const dirs = resolveDirs({}, "/srv/app");
    expect(dirs).toEqual({ configDir: "/srv/app", dataDir: "/srv/app" });
  });

  it("honours CONFIG_DIR and DATA_DIR, resolving relative values against cwd", () => {
    const dirs = resolveDirs({ CONFIG_DIR: "/app/config", DATA_DIR: "data" }, "/srv/app");
    expect(dirs).toEqual({ configDir: "/app/config", dataDir: "/srv/app/data" });
  });

  it("ignores empty env values", () => {
    expect(resolveDirs({ CONFIG_DIR: "", DATA_DIR: "" }, "/srv/app").configDir).toBe("/srv/app");
  });
});

describe("resolveIn", () => {
  it("resolves relative paths against the base dir", () => {
    expect(resolveIn("/app/data", "transcripts")).toBe("/app/data/transcripts");
  });

  it("keeps absolute paths untouched", () => {
    expect(resolveIn("/app/data", "/mnt/usb/rec.wav")).toBe("/mnt/usb/rec.wav");
  });
});

describe("writeFileAtomic", () => {
  it("writes the content and leaves no temp files behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const file = join(dir, "config.yaml");
    writeFileAtomic(file, "a: 1\n");
    expect(readFileSync(file, "utf8")).toBe("a: 1\n");
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  it("replaces an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const file = join(dir, "keys.yaml");
    writeFileSync(file, "old");
    writeFileAtomic(file, "new");
    expect(readFileSync(resolve(file), "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["keys.yaml"]);
  });
});
