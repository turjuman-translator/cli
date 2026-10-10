import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

// `turjuman open` starts the browser of this computer: here a fake that only says it started.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(spawn).mockImplementation((() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
  for (const name of ["SONIOX_API_KEY", "CAPTIONS_CONTAINER", "DISPLAY", "WAYLAND_DISPLAY"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

/** CONFIG_DIR, DATA_DIR and the working folder of the commands that load the config. */
function useConfig(yaml = "server:\n  port: 8802\n"): string {
  const { dir } = configured(yaml);
  vi.stubEnv("CONFIG_DIR", dir);
  vi.stubEnv("DATA_DIR", dir);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  return dir;
}

describe("runCli: commands that load the config when they need it", () => {
  it("setup --check reads the config folder's .env", async () => {
    useConfig();
    const c = capture();
    expect(await runCli(["setup", "--check"], c.io)).toBe(1);
    expect(c.out[1]).toMatch(/^ {2}Soniox +missing +required: add it with pnpm turjuman setup/);
  });

  it("open prints the app's address and starts the browser", async () => {
    useConfig();
    const c = capture();
    expect(await runCli(["open", "look"], c.io)).toBe(0);
    expect(c.out).toEqual(["Opening the look editor: http://127.0.0.1:8802/app/look"]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("screens list reads screens.yaml of the config folder", async () => {
    useConfig();
    const c = capture();
    expect(await runCli(["screens", "list"], c.io)).toBe(0);
    expect(c.text()).toMatch(/No screens yet/);
  });

  it("throws what is not a wrong option (main prints it and exits with 1)", async () => {
    const dir = useConfig();
    writeFileSync(join(dir, "config.yaml"), "server: [not, a, map]\n");
    const c = capture();
    await expect(runCli(["keys", "list"], c.io)).rejects.toThrow(/^Invalid config /);
    expect(c.err).toEqual([]);
  });
});
