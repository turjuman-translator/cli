import { describe, expect, it } from "vitest";
import { terminalLine } from "../../src/log.js";

const at = new Date(2026, 9, 8, 12, 4, 31).getTime();
const line = (entry: Record<string, unknown>) =>
  JSON.stringify({ level: 30, time: at, pid: 1, hostname: "h", ...entry });

describe("terminal log lines (turjuman start at a terminal)", () => {
  it("shows time, level, message and the fields on one line", () => {
    const requests = new Map<unknown, string>();
    expect(
      terminalLine(line({ msg: "portal: login", user: "imam", ip: "127.0.0.1" }), requests),
    ).toBe("12:04:31 info  portal: login user=imam ip=127.0.0.1");
    expect(terminalLine(line({ level: 40, msg: "slow", detail: { a: 1 } }), requests)).toBe(
      '12:04:31 warn  slow detail={"a":1}',
    );
  });

  it("turns a request into one line when it completes", () => {
    const requests = new Map<unknown, string>();
    const incoming = line({
      msg: "incoming request",
      reqId: "req-1",
      req: { method: "GET", url: "/app" },
    });
    expect(terminalLine(incoming, requests)).toBeNull();
    const done = line({
      msg: "request completed",
      reqId: "req-1",
      res: { statusCode: 200 },
      responseTime: 3.4,
    });
    expect(terminalLine(done, requests)).toBe("12:04:31 info  GET /app 200 3 ms");
    expect(requests.size).toBe(0);
  });

  it("prints an error's message, and its stack for errors", () => {
    const requests = new Map<unknown, string>();
    const text = terminalLine(
      line({
        level: 50,
        msg: "HTTPS not started",
        err: {
          type: "Error",
          message: "ENOENT: no such file",
          stack: "Error: ENOENT\n    at open (fs.js:1)",
        },
      }),
      requests,
    );
    expect(text).toBe(
      "12:04:31 error HTTPS not started err=ENOENT: no such file\n         at open (fs.js:1)",
    );
  });

  it("passes a line that is not JSON through", () => {
    expect(terminalLine("plain text\n", new Map())).toBe("plain text");
  });
});
