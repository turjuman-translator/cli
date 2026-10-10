import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDirs } from "./helpers/core-fakes.js";

// The archive checks that blocks.jsonl exists before it stats it; a file removed in between
// (an operator cleaning up while a page reads the history) is the only way stat can fail.
const failStat = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      if (failStat.on) throw Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" });
      return fs.statSync(...args);
    },
  };
});

const { BlocksArchive } = await import("../../src/core/blocks-archive.js");

const temp = tempDirs("core-archive-stat-");
afterEach(() => {
  failStat.on = false;
  temp.cleanup();
});

describe("BlocksArchive when blocks.jsonl vanishes", () => {
  it("returns null instead of throwing", () => {
    const root = temp.make();
    mkdirSync(join(root, "x_s1"));
    writeFileSync(join(root, "x_s1", "blocks.jsonl"), '{"id":"b","seq":1,"kind":"speech"}\n');
    const archive = new BlocksArchive(root);
    failStat.on = true;
    expect(archive.get("s1")).toBeNull();
    failStat.on = false;
    expect(archive.get("s1")?.blocks).toHaveLength(1);
  });
});
