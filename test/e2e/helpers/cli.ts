// Runs the real `turjuman` binary (node dist/main.js) in a test install, like a person would.
import { spawn } from "node:child_process";
import type { Instance } from "./instance.js";
import { MAIN } from "./paths.js";

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `turjuman <args>` in the install's folder. Standard input is a pipe: `input` is written to it,
 * then it is closed (an empty, closed stdin when there is no input, never a terminal).
 */
export function turjuman(
  inst: Instance,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      cwd: inst.dir,
      env: { ...inst.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `turjuman ${args.join(" ")}: no exit within ${opts.timeoutMs ?? 60_000} ms\n${stdout}\n${stderr}`,
        ),
      );
    }, opts.timeoutMs ?? 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}
