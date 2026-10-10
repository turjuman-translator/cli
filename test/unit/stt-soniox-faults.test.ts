// SonioxProvider when the socket itself misbehaves (sends or closes that fail, a lagging close
// handshake), when its consumer throws, and when a socket callback fails inside: the captions go
// on, nothing crashes. A local fake Soniox server; never the real Soniox.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  until,
  word,
} from "./helpers/stt-fake-soniox.js";

let server: FakeSoniox;
let dir: string;

beforeEach(async () => {
  server = await startFakeSoniox();
  dir = mkdtempSync(join(tmpdir(), "stt-soniox-faults-"));
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

describe("SonioxProvider: sends that fail", () => {
  it("reconnects when the session config cannot be sent", async () => {
    vi.stubGlobal(
      "WebSocket",
      faultyWebSocket({
        send: (data, socket) =>
          socket === 0 && typeof data === "string" ? new Error("socket broke") : undefined,
      }),
    );
    const t = harness(server.url);
    await t.start();
    expect(t.states()).toEqual(["connecting", "reconnecting: could not send the session config"]);
    expect(t.log.entries.find((e) => e.msg === "Soniox send failed")?.obj).toEqual({
      err: "socket broke",
    });
    await until(() => t.provider.state === "live", "the second attempt", 3000);
    await until(() => (server.conns[1]?.config ?? null) !== null, "the config");
    expect(conn(0).config).toBeNull();
    expect(t.provider.stats().sessions).toBe(1);
  });

  it("counts audio frames that could not be sent as dropped", async () => {
    let broken = false;
    vi.stubGlobal(
      "WebSocket",
      faultyWebSocket({
        send: (data) => (broken && typeof data !== "string" ? new Error("EPIPE") : undefined),
      }),
    );
    const t = harness(server.url);
    await t.start();
    broken = true;
    t.provider.sendAudio(audio());
    t.provider.sendAudio(audio());
    broken = false;
    t.provider.sendAudio(audio());
    await until(() => conn(0).frames.length === 1, "the frame that went out");
    expect(t.provider.stats()).toMatchObject({ framesIn: 3, framesSent: 1, framesDropped: 2 });
  });

  it("counts no finalize or keepalive that could not be sent", async () => {
    let broken = false;
    vi.stubGlobal(
      "WebSocket",
      faultyWebSocket({
        // A non-Error throw, as some socket shims do.
        send: (data) => (broken && typeof data === "string" ? "link down" : undefined),
      }),
    );
    const t = harness(server.url, {
      pauseFinalizeMs: 500,
      timings: { keepaliveAfterMs: 100, tickMs: 20 },
    });
    await t.start();
    broken = true;
    t.provider.finalize();
    conn(0).send({ tokens: [word(" الله", false, 600, 900)], total_audio_proc_ms: 2000 });
    await until(() => t.provider.stats().messages === 1, "the pause frame");
    await sleep(250);
    expect(t.provider.stats()).toMatchObject({ finalizeSent: 0, keepalivesSent: 0 });
    expect(t.log.entries.filter((e) => e.msg === "Soniox send failed")[0]?.obj).toEqual({
      err: "link down",
    });
    // The link heals: the next finalize is not held back by the failed one.
    broken = false;
    t.provider.finalize();
    await until(() => conn(0).controls.includes("finalize"), "the finalize");
    await until(() => conn(0).controls.includes("keepalive"), "a keepalive");
    expect(t.provider.stats().finalizeSent).toBe(1);
  });
});

describe("SonioxProvider: closes that fail or lag", () => {
  it("ignores a socket it dropped but could not close: its frames are recorded, not shown", async () => {
    const file = join(dir, "provider.jsonl");
    vi.stubGlobal(
      "WebSocket",
      faultyWebSocket({ close: (socket) => (socket === 0 ? "close refused" : undefined) }),
    );
    const t = harness(server.url, { recordFile: file });
    await t.start();
    conn(0).send({ error_code: 503, error_message: "busy" });
    await until(() => t.provider.state === "reconnecting", "reconnecting");
    expect(t.log.entries.find((e) => e.msg === "Soniox close failed")?.obj).toEqual({
      err: "close refused",
    });
    expect(conn(0).closed).toBeNull();
    conn(0).send({ tokens: [word(" قديم", true)] });
    await until(() => t.provider.state === "live", "the new session", 3000);
    await t.provider.stop();
    expect(t.finalText("source")).toBe("");
    const late = readRecording(file).lines.find(
      (l) => l.kind === "msg" && JSON.stringify(l.data).includes("قديم"),
    );
    expect(late).toMatchObject({ kind: "msg", session: 0 });
  });

  it("ignores a dropped connection that opens late, and anything it sends", async () => {
    const file = join(dir, "provider.jsonl");
    vi.stubGlobal(
      "WebSocket",
      faultyWebSocket({ close: (socket) => (socket === 0 ? new Error("stuck") : undefined) }),
    );
    server.delayNextUpgrade(300);
    server.on.connect = (c) => {
      if (server.conns.length === 1) c.send({ tokens: [word(" متأخر", true)] });
    };
    const t = harness(server.url, {
      recordFile: file,
      timings: { connectTimeoutMs: 100, tickMs: 20 },
    });
    await t.start();
    expect(t.states()).toEqual(["connecting", "reconnecting: connect timeout"]);
    await until(() => t.provider.state === "live", "the second attempt", 3000);
    await until(() => (server.conns[1]?.config ?? null) !== null, "the live config");
    // The late socket opened and spoke, but never became a session.
    expect(conn(0).config).toBeNull();
    await t.provider.stop();
    expect(t.finalText("source")).toBe("");
    expect(t.events.some((e) => e.type === "reconnected")).toBe(false);
    const lines = readRecording(file).lines;
    expect(lines.filter((l) => l.kind === "session")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("متأخر");
  });

  it("does not hold stop() for a lagging close handshake, and records the pending close", async () => {
    const file = join(dir, "provider.jsonl");
    vi.stubGlobal("WebSocket", faultyWebSocket({ closeDelayMs: 1500 }));
    server.on.end = (c) => c.send({ tokens: [], finished: true }); // and no close
    const t = harness(server.url, { recordFile: file });
    await t.start();
    const began = Date.now();
    await t.provider.stop({ fast: true });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(readRecording(file).lines.at(-1)).toEqual({
      t: expect.any(Number),
      kind: "close",
      session: 0,
      reason: "stopped (server close pending)",
    });
    await until(() => conn(0).closed !== null, "the late close", 3000);
  });

  it("records no close for a connection that never went live", async () => {
    const silent = await startSilentServer();
    try {
      const file = join(dir, "provider.jsonl");
      vi.stubGlobal("WebSocket", faultyWebSocket({ closeDelayMs: 1500 }));
      const t = harness(silent.url, { recordFile: file });
      const starting = t.start();
      await sleep(30);
      await t.provider.stop({ fast: true });
      await starting;
      expect(readRecording(file).lines).toEqual([]);
    } finally {
      await silent.close();
    }
  });

  it("stops without waiting when Soniox has already finished the stream", async () => {
    const t = harness(server.url, { timings: { stopTimeoutMs: 3000, tickMs: 20 } });
    server.on.config = (c) => c.send({ tokens: [], finished: true });
    server.on.end = () => {}; // would otherwise make stop() wait for the timeout
    await t.start();
    await until(() => t.provider.stats().messages === 1, "the finished frame");
    const began = Date.now();
    await t.provider.stop();
    expect(Date.now() - began).toBeLessThan(2000);
    expect(t.log.messages("warn")).toEqual([]);
  });
});

describe("SonioxProvider: errors in handlers and callbacks", () => {
  it("logs a throwing event handler and keeps delivering", async () => {
    const seen: string[] = [];
    const t = harness(server.url);
    server.on.config = (c) => {
      c.send({ tokens: [word(" قال", true)] });
      c.send({ tokens: [word(" الله", true)] });
    };
    await t.provider.start({
      sessionId: "s",
      onEvent: (e) => {
        seen.push(e.type);
        if (e.type === "tokens") throw new Error("consumer bug");
      },
    });
    await until(() => seen.filter((x) => x === "tokens").length === 2, "both frames");
    expect(t.log.messages("error")).toEqual([
      "provider event handler threw",
      "provider event handler threw",
    ]);
    await t.provider.stop();
    expect(seen.at(-1)).toBe("state");
  });

  it("survives an internal error in a socket callback", async () => {
    const t = harness(server.url);
    t.log.throwOnce("Soniox sent invalid JSON; ignored");
    server.on.config = (c) => {
      c.sendText("{broken");
      c.send({ tokens: [word(" قال", true)] });
    };
    await t.start();
    await until(() => t.finalText("source") === " قال", "the next frame");
    const internal = t.log.entries.find((e) => e.msg === "Soniox provider internal error");
    expect(internal?.obj).toMatchObject({ what: "message" });
    expect(t.provider.state).toBe("live");
  });
});
