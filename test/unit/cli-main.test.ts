// src/main.ts is the `turjuman` binary: it runs the CLI with the process's arguments on import and
// turns the result into the exit code. Each test imports it afresh with its own argv.
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageVersion } from "../../src/version.js";

afterEach(() => {
  process.exitCode = undefined;
  vi.doUnmock("../../src/cli/index.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Import the binary with these arguments; what it wrote and the exit code it set. */
async function main(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  const argv = process.argv;
  process.argv = ["node", "turjuman", ...args];
  try {
    vi.resetModules();
    await import("../../src/main.js");
    await vi.waitFor(() => expect(process.exitCode).toBeDefined(), { timeout: 15_000 });
  } finally {
    process.argv = argv;
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
  }
  return { out, err, code: Number(process.exitCode) };
}

describe("the turjuman binary", () => {
  it("prints the version and exits with 0", async () => {
    expect(await main("--version")).toEqual({ out: `${packageVersion()}\n`, err: "", code: 0 });
  });

  it("writes errors to stderr and exits with the command's code", async () => {
    const result = await main("frobnicate");
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/^Unknown command: frobnicate\n/);
  });

  it("prints what the CLI throws and exits with 1", async () => {
    vi.doMock("../../src/cli/index.js", () => ({
      runCli: () => Promise.reject(new Error("Invalid config /x/config.yaml")),
    }));
    expect(await main("keys", "list")).toEqual({
      out: "",
      err: "Invalid config /x/config.yaml\n",
      code: 1,
    });
  });

  it("prints a thrown value that is not an Error as text", async () => {
    vi.doMock("../../src/cli/index.js", () => ({
      runCli: () => Promise.reject("something odd"),
    }));
    expect(await main("status")).toEqual({ out: "", err: "something odd\n", code: 1 });
  });
});
