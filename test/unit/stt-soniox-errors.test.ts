// SonioxProvider against a local fake Soniox server: server errors (fatal or retried), the
// context fallback, dropped and refused connections, timeouts, the watchdog and backoff.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonioxContext } from "../../src/glossary.js";
import { readRecording } from "../../src/stt/recording.js";
import {
  audio,
  type FakeSoniox,
  faultyWebSocket,
  harness,
  type ServerConn,
  sleep,
  startFakeSoniox,
  startSilentServer,
  stopProviders,
  TEST_KEY,
  until,
  word,
} from "./helpers/stt-fake-soniox.js";

const CONTEXT: SonioxContext = {
  general: [{ key: "domain", value: "Friday khutbah" }],
  terms: ["التقوى"],
  translation_terms: [{ source: "التقوى", target: "taqwa" }],
};

let server: FakeSoniox;
let dir: string;

beforeEach(async () => {
  server = await startFakeSoniox();
  dir = mkdtempSync(join(tmpdir(), "stt-soniox-err-"));
});
afterEach(async () => {
  await stopProviders();
  vi.unstubAllGlobals();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function conn(i: number): ServerConn {
  const c = server.conns[i];
  if (c === undefined) throw new Error(`no connection ${i}`);
  return c;
}

const reconnectDelays = (t: ReturnType<typeof harness>): unknown[] =>
  t.log.entries.filter((e) => e.msg === "Soniox reconnect scheduled").map((e) => e.obj.delayMs);

describe("SonioxProvider: fatal errors", () => {
  it("stops on an auth error without retrying, and never shows the key", async () => {
    const t = harness(server.url);
    server.on.config = (c) =>
      c.send({
        error_code: 401,
        error_type: "unauthenticated",
        error_message: `Invalid API key ${TEST_KEY}`,
      });
    await t.start();
    await until(() => t.provider.state === "error", "the error state");
    const message = "Soniox error 401 unauthenticated: Invalid API key [redacted]";
    expect(t.errors()).toEqual([{ type: "error", fatal: true, message }]);
    expect(t.states()).toEqual(["connecting", "live", `error: ${message}`]);
    expect(t.log.messages("error")).toEqual(["Soniox fatal error; not retrying"]);
    await until(() => conn(0).closed !== null, "the closed socket");
    expect(conn(0).closed).toEqual({ code: 1000, reason: "fatal error" });
    t.provider.sendAudio(audio());
    t.provider.finalize();
    await sleep(700);
    expect(server.conns).toHaveLength(1);
    expect(t.provider.stats()).toMatchObject({ framesDropped: 1, finalizeSent: 0 });
    // The operator fixes the key and starts again.
    server.on.config = () => {};
    await t.provider.stop();
    await t.start();
    expect(t.provider.state).toBe("live");
    expect(server.conns).toHaveLength(2);
  });

  it("does not retry a rejected config once Soniox has sent tokens", async () => {
    const t = harness(server.url, { context: CONTEXT });
    server.on.config = (c) => {
      c.send({ tokens: [word(" قال", false)] });
      c.send({ error_code: 400, error_message: "bad request" });
    };
    await t.start();
    await until(() => t.provider.state === "error", "the error state");
    expect(t.errors()).toEqual([
      { type: "error", fatal: true, message: "Soniox error 400: bad request" },
    ]);
  });

  it("fails at once on a URL it cannot open, and start() still resolves", async () => {
    const t = harness("not a url");
    await t.start();
    expect(t.provider.state).toBe("error");
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]?.message).toMatch(/^Soniox: cannot open not a url: /);
    expect(t.errors()[0]?.fatal).toBe(true);
  });

  it("dials the Soniox endpoint of its region when no URL is given", async () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string) {
          throw new Error(`refused to dial ${url}`);
        }
      },
    );
    const t = harness(server.url, { url: undefined, region: "eu" });
    await t.start();
    expect(t.errors()[0]?.message).toBe(
      "Soniox: cannot open wss://stt-rt.eu.soniox.com/transcribe-websocket: refused to dial wss://stt-rt.eu.soniox.com/transcribe-websocket",
    );
  });
});

describe("SonioxProvider: retried errors", () => {
  it("reconnects after a server error and places the new session after the dropped audio", async () => {
    const file = join(dir, "provider.jsonl");
    const t = harness(server.url, { recordFile: file });
    await t.start();
    for (let i = 0; i < 3; i++) t.provider.sendAudio(audio());
    await until(() => conn(0).frames.length === 3, "the first audio");
    conn(0).send({ error_code: 503, error_type: "service_unavailable", error_message: "busy" });
    await until(() => t.provider.state === "reconnecting", "reconnecting");
    const message = "Soniox error 503 service_unavailable: busy";
    expect(t.errors()).toEqual([{ type: "error", fatal: false, message }]);
    expect(t.states()).toContain(`reconnecting: ${message}`);
    t.provider.sendAudio(audio()); // while reconnecting: dropped, but counted
    t.provider.sendAudio(audio());
    await until(() => t.provider.state === "live", "the second session", 3000);
    const reconnected = t.events.find((e) => e.type === "reconnected");
    expect(reconnected).toMatchObject({ audioOffsetMs: 500 });
    expect(reconnected?.type === "reconnected" && reconnected.gapMs).toBeGreaterThanOrEqual(400);
    expect(reconnectDelays(t)).toEqual([500]);
    expect(t.provider.stats()).toMatchObject({
      sessions: 2,
      reconnects: 1,
      framesIn: 5,
      framesSent: 3,
      framesDropped: 2,
    });
    await t.provider.stop();
    const lines = readRecording(file).lines;
    expect(lines.filter((l) => l.kind === "session")).toMatchObject([
      { index: 0, audioOffsetMs: 0 },
      { index: 1, audioOffsetMs: 500 },
    ]);
    expect(lines.filter((l) => l.kind === "close").map((l) => l.session)).toEqual([0, 1]);
  });

  it("opens a new session at once when Soniox ends one at its duration cap (413)", async () => {
    const t = harness(server.url);
    server.on.config = (c) => {
      if (server.conns.length === 1) c.send({ error_code: 413, error_message: "max duration" });
    };
    await t.start();
    await until(() => server.conns.length === 2, "the new connection");
    expect(reconnectDelays(t)).toEqual([0]);
    expect(t.errors()).toEqual([
      { type: "error", fatal: false, message: "Soniox error 413: max duration" },
    ]);
  });

  it("retries a rejected config with less context: translation terms first, then all of it", async () => {
    const t = harness(server.url, { context: CONTEXT });
    server.on.config = (c) => {
      if (c.config?.context !== undefined) {
        c.send({ error_code: 400, error_type: "invalid_request", error_message: "bad context" });
      }
    };
    await t.start();
    await until(() => (server.conns[2]?.config ?? null) !== null, "the third config");
    await until(() => t.provider.state === "live" && server.conns[2]?.closed === null, "live");
    expect(conn(0).config?.context).toEqual(CONTEXT);
    expect(conn(1).config?.context).toEqual({ general: CONTEXT.general, terms: CONTEXT.terms });
    expect(conn(2).config).not.toHaveProperty("context");
    expect(t.errors()).toEqual([
      {
        type: "error",
        fatal: false,
        message:
          "Soniox error 400 invalid_request: bad context (retrying without translation_terms)",
      },
      {
        type: "error",
        fatal: false,
        message: "Soniox error 400 invalid_request: bad context (retrying without context)",
      },
    ]);
    expect(reconnectDelays(t)).toEqual([0, 0]);
    // The fallback sticks: a restart does not send the rejected context again.
    await t.provider.stop();
    await t.start("sess-2");
    await until(() => (server.conns[3]?.config ?? null) !== null, "the fourth config");
    expect(conn(3).config).not.toHaveProperty("context");
    expect(conn(3).config?.client_reference_id).toBe("sess-2");
  });

  it("gives up when even the config without context is rejected", async () => {
    const t = harness(server.url, { context: { text: "khutbah" } });
    server.on.config = (c) => c.send({ error_code: 400, error_message: "bad" });
    await t.start();
    await until(() => t.provider.state === "error", "the error state");
    expect(t.errors()).toEqual([
      { type: "error", fatal: false, message: "Soniox error 400: bad (retrying without context)" },
      { type: "error", fatal: true, message: "Soniox error 400: bad" },
    ]);
    expect(server.conns).toHaveLength(2);
  });
});

describe("SonioxProvider: lost connections", () => {
  it("reconnects when Soniox closes the connection, and records the close", async () => {
    const file = join(dir, "provider.jsonl");
    const t = harness(server.url, { recordFile: file });
    await t.start();
    conn(0).close(1011, "internal error");
    await until(() => t.provider.state === "reconnecting", "reconnecting");
    expect(t.states()).toContain("reconnecting: connection closed (1011 internal error)");
    expect(t.log.messages("warn")).toContain("Soniox connection closed (1011 internal error)");
    await until(() => t.provider.state === "live", "the second session", 3000);
    await t.provider.stop();
    expect(readRecording(file).lines.find((l) => l.kind === "close")).toMatchObject({
      session: 0,
      code: 1011,
      reason: "internal error",
    });
  });

  it("keeps retrying a refused connection with a growing delay until stopped", async () => {
    const t = harness(server.refusingUrl);
    await t.start(); // resolves once the first attempt has failed
    expect(t.provider.state).toBe("reconnecting");
    expect(t.states()).toEqual(["connecting", "reconnecting: connection failed (1006)"]);
    expect(t.log.messages("debug")).toContain("Soniox socket error (close follows)");
    await until(() => reconnectDelays(t).length === 2, "the second attempt", 3000);
    expect(reconnectDelays(t)).toEqual([500, 1000]);
    t.provider.sendAudio(audio()); // while reconnecting: dropped
    await t.provider.stop();
    expect(t.provider.state).toBe("idle");
    await sleep(1100);
    expect(reconnectDelays(t)).toHaveLength(2);
    expect(t.provider.stats()).toMatchObject({ sessions: 0, framesDropped: 1 });
  });

  it("abandons a connection that does not open in time", async () => {
    const silent = await startSilentServer();
    try {
      const t = harness(silent.url, { timings: { connectTimeoutMs: 100, tickMs: 20 } });
      t.provider.sendAudio(audio()); // buffered, then dropped with the attempt
      await t.start();
      expect(t.states()).toEqual(["connecting", "reconnecting: connect timeout"]);
      expect(t.log.entries.find((e) => e.msg === "Soniox connect timeout")?.obj).toEqual({
        timeoutMs: 100,
      });
      // The dropped attempt's own error is not reported.
      await sleep(50);
      expect(t.log.messages("debug")).not.toContain("Soniox socket error (close follows)");
      expect(t.provider.stats().framesDropped).toBe(1);
      await t.provider.stop();
    } finally {
      await silent.close();
    }
  });

  it("can be stopped while still connecting, which ends start()", async () => {
    const silent = await startSilentServer();
    try {
      const t = harness(silent.url);
      t.provider.sendAudio(audio());
      const starting = t.start();
      await sleep(50);
      expect(t.provider.state).toBe("connecting");
      await t.provider.stop();
      await starting;
      expect(t.provider.state).toBe("idle");
      expect(t.provider.stats()).toMatchObject({ sessions: 0, framesDropped: 1 });
    } finally {
      await silent.close();
    }
  });

  it("reconnects when audio flows but Soniox stays silent (watchdog)", async () => {
    const t = harness(server.url, { timings: { watchdogMs: 300, tickMs: 20 } });
    await t.start();
    for (let i = 0; i < 4; i++) t.provider.sendAudio(audio());
    await until(() => t.errors().length === 1, "the watchdog", 3000);
    expect(t.errors()[0]?.fatal).toBe(false);
    expect(t.errors()[0]?.message).toMatch(
      /^Soniox connection stalled \(no server message for \d+ s while sending audio\); reconnecting$/,
    );
    expect(t.log.messages("warn")).toContain("Soniox connection stalled; reconnecting");
    await until(() => conn(0).closed !== null, "the dropped socket");
    expect(conn(0).closed).toEqual({ code: 1000, reason: "stalled" });
    await until(() => t.provider.state === "live", "the new session", 3000);
  });

  it("does not trip the watchdog while Soniox answers", async () => {
    const t = harness(server.url, { timings: { watchdogMs: 300, tickMs: 20 } });
    await t.start();
    for (let i = 0; i < 8; i++) {
      t.provider.sendAudio(audio());
      if (i % 2 === 1) conn(0).send({ tokens: [] });
      await sleep(60);
    }
    expect(t.errors()).toEqual([]);
  });

  it("reconnects when the send buffer stays over the limit on two checks", async () => {
    let reported = 0;
    vi.stubGlobal(
      "WebSocket",
      faultyWebSocket({
        // Socket 0: one spike, then congested for good. Socket 1: fine.
        bufferedAmount: (i) => {
          if (i !== 0) return undefined;
          reported++;
          return reported === 1 ? 100_000 : reported === 2 ? 0 : 100_000;
        },
      }),
    );
    const t = harness(server.url);
    await t.start();
    await until(() => t.errors().length === 1, "the backpressure restart", 3000);
    expect(reported).toBeGreaterThanOrEqual(4);
    expect(t.errors()[0]?.message).toBe(
      "Soniox connection stalled (send buffer at 100000 bytes); reconnecting",
    );
    await until(() => t.provider.state === "live" && server.conns.length === 2, "reconnected");
  });

  it("starts the backoff over once a session has stayed up", async () => {
    const t = harness(server.url, { timings: { backoffResetAfterMs: 50, tickMs: 20 } });
    server.on.config = (c) => {
      // The first session drops at once; the second after 150 ms (past the reset).
      setTimeout(() => c.close(1011, "drop"), server.conns.length === 1 ? 0 : 150);
    };
    await t.start();
    await until(() => reconnectDelays(t).length === 2, "two reconnects", 4000);
    expect(reconnectDelays(t)).toEqual([500, 500]);
  });
});
