import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe("runCli", () => {
  it("prints help with no command", async () => {
    const c = capture();
    expect(await runCli([], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/doctor/);
  });

  it("prints the package version", async () => {
    const c = capture();
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(await runCli(["--version"], c.io)).toBe(0);
    expect(c.out.join("")).toBe(pkg.version);
  });

  it("rejects unknown commands with exit code 2", async () => {
    const c = capture();
    expect(await runCli(["frobnicate"], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/Unknown command: frobnicate/);
  });
});
