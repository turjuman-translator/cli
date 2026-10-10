// A real Turjuman server for an end-to-end test: `node dist/main.js run` in a test install, on the
// port its config.yaml names. Started and stopped like an operator would (SIGINT).
import { type ChildProcess, spawn } from "node:child_process";
import type { Instance } from "./instance.js";
import { MAIN } from "./paths.js";

export interface Server {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  inst: Instance;
  /** Everything the server printed so far (stdout and stderr). */
  logs(): string;
  stop(): Promise<void>;
  /** Resolves with the exit code (or signal) once the process has ended. */
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Start `turjuman run [args]` (or `start`, or `replay <provider.jsonl>`) and wait until /health
 * answers 200. The install's config.yaml must set `server.port` to `port` (see freePort()).
 */
export async function startServer(
  inst: Instance,
  port: number,
  opts: {
    command?: "run" | "start" | "replay";
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<Server> {
  const child: ChildProcess = spawn(
    process.execPath,
    [MAIN, opts.command ?? "run", ...(opts.args ?? [])],
    { cwd: inst.dir, env: { ...inst.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    if (exited) throw new Error(`the server exited before it answered:\n${output}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`the server did not answer /health in time:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    inst,
    logs: () => output,
    exited: () => exit,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill("SIGINT");
      }),
  };
}
