import { type Logger, symbols } from "pino";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  addSecret,
  createLogger,
  removeSecret,
  scrubSecrets,
  terminalLine,
} from "../../src/log.js";

const at = new Date(2026, 9, 8, 12, 4, 31).getTime();
const clock = "12:04:31";
const line = (entry: Record<string, unknown>) =>
  JSON.stringify({ level: 30, time: at, pid: 1, hostname: "h", ...entry });

describe("secrets learnt at runtime (decrypted organisation keys)", () => {
  it("scrubs an added value from everything from now on", () => {
    expect(scrubSecrets("failed with runtime-secret-AAA", [])).toBe(
      "failed with runtime-secret-AAA",
    );
    addSecret("runtime-secret-AAA");
    expect(scrubSecrets("failed with runtime-secret-AAA twice runtime-secret-AAA", [])).toBe(
      "failed with [redacted] twice [redacted]",
    );
  });

  it("ignores empty and very short values (they would shred normal text)", () => {
    addSecret(null);
    addSecret(undefined);
    addSecret("");
    addSecret("abcde");
    addSecret("short", "org1:soniox");
    expect(scrubSecrets("abcde short null", [])).toBe("abcde short null");
  });

  it("keeps one value per slot: a replaced or removed key is no longer scrubbed", () => {
    addSecret("slot-value-old-123", "orgX:soniox");
    expect(scrubSecrets("slot-value-old-123", [])).toBe("[redacted]");
    addSecret("slot-value-new-456", "orgX:soniox");
    expect(scrubSecrets("slot-value-old-123 slot-value-new-456", [])).toBe(
      "slot-value-old-123 [redacted]",
    );
    removeSecret("orgX:soniox");
    expect(scrubSecrets("slot-value-new-456", [])).toBe("slot-value-new-456");
    removeSecret("never-set");
  });
});

describe("terminal log lines: the less common entries", () => {
  it("keeps a long field to 160 characters and folds whitespace", () => {
    const long = "word ".repeat(60);
    const text = terminalLine(line({ msg: "m", detail: long, multi: "a\n  b" }), new Map()) ?? "";
    const detail = /detail=(.*) multi=/.exec(text)?.[1] ?? "";
    expect([...detail]).toHaveLength(160);
    expect(detail.endsWith("…")).toBe(true);
    expect(text.endsWith(" multi=a b")).toBe(true);
  });

  it("passes non-JSON text through, with or without a newline", () => {
    expect(terminalLine("pino-pretty says hi", new Map())).toBe("pino-pretty says hi");
    expect(terminalLine("{ broken json\n", new Map())).toBe("{ broken json");
  });

  it("fills in what a request entry lacks", () => {
    const requests = new Map<unknown, string>();
    expect(terminalLine(line({ msg: "incoming request", reqId: 7, req: {} }), requests)).toBeNull();
    expect(terminalLine(line({ msg: "request completed", reqId: 7, res: {} }), requests)).toBe(
      `${clock} info  ? ? ?`,
    );
    // A completion without its start (the start was before a restart of the log).
    expect(
      terminalLine(
        line({ msg: "request completed", reqId: 8, res: { statusCode: 404 }, responseTime: 0.4 }),
        requests,
      ),
    ).toBe(`${clock} info  request 404 0 ms`);
    // "incoming request" without req is an ordinary entry.
    expect(terminalLine(line({ msg: "incoming request", reqId: 9 }), requests)).toBe(
      `${clock} info  incoming request`,
    );
  });

  it("forgets unfinished requests after 1000, so the map cannot grow without bound", () => {
    const requests = new Map<unknown, string>();
    for (let i = 0; i <= 1001; i++) {
      terminalLine(
        line({ msg: "incoming request", reqId: i, req: { method: "GET", url: "/" } }),
        requests,
      );
    }
    expect(requests.size).toBe(1);
    expect(requests.get(1001)).toBe("GET /");
  });

  it("shows unknown levels as numbers, missing times as now, and empty entries", () => {
    vi.useFakeTimers({ now: at });
    try {
      expect(terminalLine(JSON.stringify({ level: 35, msg: "custom" }), new Map())).toBe(
        `${clock} 35 custom`,
      );
      expect(terminalLine(JSON.stringify({ level: 10, time: "x" }), new Map())).toBe(
        `${clock} trace (empty)`,
      );
      expect(terminalLine(line({ level: 20, msg: 42, n: 1 }), new Map())).toBe(
        `${clock} debug  n=1`,
      );
      expect(terminalLine(line({ level: 60, msg: "down" }), new Map())).toBe(`${clock} fatal down`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names an error by message, else type, else its JSON; a stack only for errors", () => {
    const map = new Map<unknown, string>();
    expect(terminalLine(line({ msg: "m", err: { type: "TypeError" } }), map)).toBe(
      `${clock} info  m err=TypeError`,
    );
    expect(terminalLine(line({ msg: "m", err: { code: 5 } }), map)).toBe(
      `${clock} info  m err={"code":5}`,
    );
    expect(
      terminalLine(line({ level: 40, msg: "m", err: { message: "x", stack: "E\n at a" } }), map),
    ).toBe(`${clock} warn  m err=x`);
    expect(terminalLine(line({ level: 50, msg: "m", err: { message: "x" } }), map)).toBe(
      `${clock} error m err=x`,
    );
    expect(terminalLine(line({ msg: "m", err: "plain text" }), map)).toBe(
      `${clock} info  m err=plain text`,
    );
  });
});

/** The destination a logger writes to (pino keeps it under a symbol). */
function streamOf(log: Logger): { fd?: number; end?: () => void } | undefined {
  return (log as unknown as Record<symbol, { fd?: number; end?: () => void } | undefined>)[
    symbols.streamSym
  ];
}

describe("createLogger", () => {
  let out: string[];
  let write: MockInstance;
  beforeEach(() => {
    out = [];
    write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  });
  afterEach(() => write.mockRestore());

  it("writes one short line per entry at a terminal, from info up by default", () => {
    const log = createLogger({ pretty: false, terminal: true });
    expect(log.level).toBe("info");
    log.debug("not shown");
    log.info({ user: "imam" }, "portal: login");
    log.child({ reqId: "r1" }).info({ req: { method: "GET", url: "/app" } }, "incoming request");
    log
      .child({ reqId: "r1" })
      .info({ res: { statusCode: 200 }, responseTime: 2.6 }, "request completed");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^\d\d:\d\d:\d\d info {2}portal: login user=imam\n$/);
    expect(out[1]).toMatch(/^\d\d:\d\d:\d\d info {2}GET \/app 200 3 ms\n$/);
  });

  it("logs from the level asked for", () => {
    const log = createLogger({ pretty: false, terminal: true, level: "warn" });
    log.info("quiet");
    log.warn("loud");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/warn {2}loud\n$/);
  });

  it("scrubs secrets from messages, keys in links and errors (message and stack)", () => {
    const log = createLogger({ pretty: false, terminal: true, secrets: ["snx-literal-secret"] });
    log.warn("connect failed for snx-literal-secret via /ar/nl?key=abc123&lines=2");
    log.info({ count: 2 }, "%s sessions", "two");
    const err = new Error("rejected snx-literal-secret");
    log.error({ err }, "engine error");
    log.warn({ err: "text with snx-literal-secret" }, "string err");
    log.warn({ err: { code: 401 } }, "object err");
    const all = out.join("");
    expect(all).not.toContain("snx-literal-secret");
    expect(all).not.toContain("abc123");
    expect(out[0]).toMatch(
      /warn {2}connect failed for \[redacted\] via \/ar\/nl\?key=\[redacted\]&lines=2\n$/,
    );
    expect(out[1]).toMatch(/info {2}two sessions count=2\n$/);
    expect(out[2]).toMatch(/^\d\d:\d\d:\d\d error engine error err=rejected \[redacted\]\n {9}at /);
    expect(out[3]).toMatch(/warn {2}string err err=text with \[redacted\]\n$/);
    expect(out[4]).toMatch(/warn {2}object err err=\{"code":401\}\n$/);
  });

  it("prints an error without stack frames on one line (no blank line after it)", () => {
    const log = createLogger({ pretty: false, terminal: true });
    const bare = new Error("no stack here");
    bare.stack = undefined;
    log.error({ err: bare }, "odd error");
    const headerOnly = new Error("only a header");
    headerOnly.stack = "Error: only a header";
    log.error({ err: headerOnly }, "short stack");
    expect(out[0]).toMatch(/error odd error err=no stack here\n$/);
    expect(out[1]).toMatch(/error short stack err=only a header\n$/);
  });

  it("writes JSON lines straight to stdout (file descriptor 1) when not at a terminal", () => {
    const log = createLogger({ pretty: false, level: "warn" });
    expect(log.level).toBe("warn");
    expect(log.isLevelEnabled("info")).toBe(false);
    expect(streamOf(log)).toMatchObject({ fd: 1 });
    expect(out).toEqual([]);
  });

  it("uses the pino-pretty transport with --dev, also at a terminal", async () => {
    const log = createLogger({ pretty: true, terminal: true, level: "silent" });
    expect(log.level).toBe("silent");
    const stream = streamOf(log);
    // A transport runs in a worker thread: not stdout's descriptor, not the terminal lines.
    expect(stream).not.toHaveProperty("fd");
    expect(stream?.constructor.name).toBe("ThreadStream");
    log.info("not shown");
    expect(out).toEqual([]);
    await new Promise<void>((resolve) => log.flush(() => resolve()));
    stream?.end?.();
  });
});
