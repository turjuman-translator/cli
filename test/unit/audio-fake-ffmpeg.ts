// Test doubles for src/audio/ffmpeg.ts: a scriptable ffmpeg child process (no real process, no
// devices) behind an injectable spawn(), and a silent pino-like logger whose calls can be read.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { Logger } from "pino";
import { vi } from "vitest";
import type { SpawnFn } from "../../src/audio/ffmpeg.js";

/** A fake ffmpeg child: the test emits its output and decides when (and how) it exits. */
export class FakeFfmpeg extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  /** The raw tap (fd 3), when spawned with `stdio[3] = "pipe"`. */
  readonly tap: Readable | null;
  readonly stdio: unknown[];
  readonly signals: string[] = [];
  pid: number | undefined = 4242;
  /** Runs on every kill() (default: nothing; the process exits only when the test says so). */
  onKill: (signal: string) => void = () => {};

  constructor(
    readonly command: string,
    readonly args: string[],
    tap: boolean,
  ) {
    super();
    this.tap = tap ? new Readable({ read() {} }) : null;
    this.stdio = [null, this.stdout, this.stderr, this.tap ?? undefined];
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    this.onKill(signal);
    return true;
  }

  /** Main output (16 kHz mono s16le on pipe:1). */
  out(bytes: Uint8Array): void {
    this.stdout.emit("data", Buffer.from(bytes));
  }

  /** Raw tap output (pipe:3). */
  raw(bytes: Uint8Array | number[]): void {
    this.tap?.emit("data", Buffer.from(Uint8Array.from(bytes)));
  }

  /** stderr text (the source sets utf8 encoding, so it receives strings). */
  err(text: string): void {
    this.stderr.emit("data", text);
  }

  exit(code: number | null, signal: string | null = null): void {
    this.emit("close", code, signal);
  }

  fail(err: Error): void {
    this.emit("error", err);
  }
}

export interface FakeSpawn {
  spawn: SpawnFn;
  procs: FakeFfmpeg[];
  /** The most recently spawned process. */
  last(): FakeFfmpeg;
  /** Make the next spawn() call throw this value. */
  throwOnce(value: unknown): void;
}

export function fakeSpawn(): FakeSpawn {
  const procs: FakeFfmpeg[] = [];
  let toThrow: { value: unknown } | null = null;
  const spawn: SpawnFn = (command, args, options) => {
    if (toThrow !== null) {
      const { value } = toThrow;
      toThrow = null;
      throw value;
    }
    const stdio = options.stdio as unknown[];
    const proc = new FakeFfmpeg(command, args, stdio[3] === "pipe");
    procs.push(proc);
    return proc as unknown as ChildProcess;
  };
  return {
    spawn,
    procs,
    last() {
      const p = procs[procs.length - 1];
      if (p === undefined) throw new Error("nothing spawned");
      return p;
    },
    throwOnce(value) {
      toThrow = { value };
    },
  };
}

export interface FakeLog {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  logger: Logger;
  /** Messages logged at a level (the last argument of each call). */
  messages(level: "debug" | "info" | "warn" | "error"): string[];
}

export function fakeLog(): FakeLog {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    ...log,
    logger: log as unknown as Logger,
    messages(level) {
      return log[level].mock.calls.map((args) => String(args[args.length - 1]));
    },
  };
}
