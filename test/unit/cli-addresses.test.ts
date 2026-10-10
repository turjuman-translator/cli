import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { openCommand } from "../../src/cli/open.js";
import { startCommand } from "../../src/cli/start.js";
import { lanAddress, serverAddresses } from "../../src/cli/urls.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

afterEach(() => {
  removeTempDirs();
});

describe("serverAddresses on the LAN", () => {
  it("uses a host that is not loopback as the LAN address itself", () => {
    const { loaded } = configured("server:\n  host: 192.168.1.20\n  exposure: lan\n  port: 8801\n");
    expect(serverAddresses(loaded)).toEqual({
      local: "http://192.168.1.20:8801",
      lan: "http://192.168.1.20:8801",
      https: null,
      public: null,
    });
  });

  it("looks up this computer's address for 0.0.0.0, but not inside the container", () => {
    const yaml = "server:\n  host: 0.0.0.0\n  exposure: lan\n  port: 8801\n";
    const native = configured(yaml).loaded;
    const found = lanAddress();
    expect(serverAddresses(native).lan).toBe(found === null ? null : `http://${found}:8801`);
    const docker = configured(yaml, { CAPTIONS_CONTAINER: "1" }).loaded;
    expect(serverAddresses(docker)).toMatchObject({ local: "http://127.0.0.1:8801", lan: null });
  });
});

describe("turjuman open when the browser cannot be started at all", () => {
  it("reports a spawn that throws, Error or not, with exit code 1", async () => {
    const { loaded } = configured("server:\n  port: 8801\n");
    for (const thrown of [new Error("EACCES"), "no such program"]) {
      const c = capture();
      const spawn = (): ChildProcess => {
        throw thrown;
      };
      const code = await openCommand([], c.io, () => loaded, { platform: "darwin", spawn });
      expect(code).toBe(1);
      expect(c.out).toEqual(["Opening the app: http://127.0.0.1:8801/app"]);
      expect(c.err).toEqual([
        `Could not start a browser (open: ${thrown instanceof Error ? thrown.message : thrown}); open the address yourself.`,
      ]);
    }
  });
});

describe("turjuman start", () => {
  it("passes the server's error output through unchanged", async () => {
    const { dir } = configured("server:\n  port: 8801\n");
    const c = capture();
    const run = async (_args: string[], io: { out(t: string): void; err(t: string): void }) => {
      io.err("Port 8801 is in use");
      return 1;
    };
    const env = { CONFIG_DIR: dir, DATA_DIR: dir, SONIOX_API_KEY: "fake-key-for-start" };
    expect(await startCommand([], c.io, { run, env, cwd: dir, lan: null })).toBe(1);
    expect(c.err).toEqual(["Port 8801 is in use"]);
    expect(c.out).toEqual([]);
  });
});
