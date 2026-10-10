// SonioxProvider against a local fake Soniox server: the session, audio, tokens, finalize,
// keepalive, stop and the provider.jsonl recording. Never the real Soniox, never a real key.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SonioxContext } from "../../src/glossary.js";
import { readRecording } from "../../src/stt/recording.js";
import {
  audio,
  type FakeSoniox,
  harness,
  marker,
  type ServerConn,
  sleep,
  startFakeSoniox,
  stopProviders,
  TEST_KEY,
  translated,
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
  dir = mkdtempSync(join(tmpdir(), "stt-soniox-"));
});
afterEach(async () => {
  await stopProviders();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function conn(i: number): ServerConn {
  const c = server.conns[i];
  if (c === undefined) throw new Error(`no connection ${i}`);
  return c;
}

describe("SonioxProvider: the session", () => {
  it("sends the session config first, then the audio buffered before the socket opened", async () => {
    const t = harness(server.url, {
      context: CONTEXT,
      languageHints: ["en"],
      maxEndpointDelayMs: 1200,
      endpointLatencyLevel: 1,
      endpointSensitivity: 0.2,
    });
    expect(t.provider.state).toBe("idle");
    const first = audio(1);
    t.provider.sendAudio(first);
    first.fill(9); // the caller reuses its buffer: the provider keeps a copy
    t.provider.sendAudio(audio(2));
    await t.start("sess-42");
    expect(t.provider.state).toBe("live");
    expect(t.states()).toEqual(["connecting", "live"]);
    await until(() => conn(0).frames.length === 2, "the buffered frames");
    expect(conn(0).config).toEqual({
      api_key: TEST_KEY,
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true,
      client_reference_id: "sess-42",
      language_hints: ["ar", "en"],
      max_endpoint_delay_ms: 1200,
      endpoint_latency_adjustment_level: 1,
      endpoint_sensitivity: 0.2,
      translation: { type: "one_way", target_language: "nl" },
      context: CONTEXT,
    });
    expect(conn(0).frames.map((f) => [f.length, f[0]])).toEqual([
      [3200, 1],
      [3200, 2],
    ]);
    t.provider.sendAudio(audio(3));
    await until(() => conn(0).frames.length === 3, "a live frame");
    expect(t.provider.stats()).toEqual({
      framesIn: 3,
      framesSent: 3,
      framesDropped: 0,
      sessions: 1,
      reconnects: 0,
      messages: 0,
      finalizeSent: 0,
      finalizeSkipped: 0,
      keepalivesSent: 0,
    });
    // The first session starts at the start of the audio: no `reconnected`.
    expect(t.events.some((e) => e.type === "reconnected")).toBe(false);
  });

  it("states what it can do and on which track", () => {
    const t = harness(server.url, { track: "soniox", translationFinalAtEndpoint: true });
    expect(t.provider.track).toBe("soniox");
    expect(t.provider.capabilities).toEqual({
      nativeTranslation: true,
      timing: "provider",
      translationFinalAtEndpoint: true,
    });
    const asr = harness(server.url, { targetLanguage: null });
    expect(asr.provider.capabilities).toEqual({
      nativeTranslation: false,
      timing: "provider",
      translationFinalAtEndpoint: false,
    });
  });

  it("keeps only the newest audio before the connection and says where the session starts", async () => {
    const t = harness(server.url, { timings: { preConnectFrames: 3, tickMs: 20 } });
    for (let i = 1; i <= 5; i++) t.provider.sendAudio(audio(i));
    await t.start();
    await until(() => conn(0).frames.length === 3, "the kept frames");
    expect(conn(0).frames.map((f) => f[0])).toEqual([3, 4, 5]);
    expect(t.events).toContainEqual({ type: "reconnected", gapMs: 0, audioOffsetMs: 200 });
    expect(t.provider.stats()).toMatchObject({ framesDropped: 2, reconnects: 0, sessions: 1 });
  });

  it("turns Soniox frames into tokens and endpoints, mirroring Dutch words Soniox kept", async () => {
    const before = Date.now();
    const t = harness(server.url);
    server.on.config = (c) => {
      c.send({
        tokens: [
          word(" الحمد", true, 100, 400),
          translated(" Lof"),
          {
            text: " Allah",
            is_final: true,
            language: "nl",
            translation_status: "none",
            start_ms: 400,
            end_ms: 600,
          },
          marker("<end>"),
          word(" لله", false, 600, 800),
        ],
        total_audio_proc_ms: 900,
      });
      // Soniox's <fin> after the same words closes nothing new: dropped.
      c.send({ tokens: [marker("<fin>")] });
    };
    await t.start();
    await until(() => t.provider.stats().messages === 2, "both frames");
    const after = Date.now();
    const types = t.events.filter((e) => e.type !== "state").map((e) => e.type);
    expect(types).toEqual(["tokens", "endpoint", "tokens", "tokens"]);
    const [first, , second] = t.events.filter((e) => e.type !== "state");
    expect(first).toMatchObject({
      type: "tokens",
      final: [
        { text: " الحمد", kind: "source", lang: "ar", startMs: 100, endMs: 400 },
        { text: " Lof", kind: "translation", lang: "nl" },
        { text: " Allah", kind: "source", lang: "nl", startMs: 400, endMs: 600 },
        { text: " Allah", kind: "translation", lang: "nl" },
      ],
      nonFinal: [],
    });
    expect(second).toMatchObject({
      type: "tokens",
      final: [],
      nonFinal: [{ text: " لله", kind: "source", lang: "ar", startMs: 600, endMs: 800 }],
    });
    for (const e of t.events) {
      if (e.type === "tokens" || e.type === "endpoint") {
        expect(e.receivedAt).toBeGreaterThanOrEqual(before);
        expect(e.receivedAt).toBeLessThanOrEqual(after);
      }
    }
  });

  it("ignores binary, invalid and malformed frames, and keeps the good tokens of a frame", async () => {
    const file = join(dir, "provider.jsonl");
    const t = harness(server.url, { recordFile: file });
    server.on.config = (c) => {
      c.sendBinary(new Uint8Array([1, 2, 3]));
      c.sendText("this is not JSON");
      c.send({ tokens: "not a list" });
      c.send({ tokens: [{ text: 5 }, word(" قال", true)] });
    };
    await t.start();
    await until(() => t.events.some((e) => e.type === "tokens"), "the good token");
    expect(t.finalText("source")).toBe(" قال");
    expect(t.log.messages("warn")).toEqual([
      "Soniox sent a binary frame; ignored",
      "Soniox sent invalid JSON; ignored",
      "Soniox frame failed validation; ignored",
      "Soniox frame had malformed tokens",
    ]);
    expect(t.log.entries.find((e) => e.msg === "Soniox frame had malformed tokens")?.obj).toEqual({
      dropped: 1,
    });
    await t.provider.stop();
    // Every JSON frame is recorded as it came, even one that failed validation.
    const msgs = readRecording(file).lines.filter((l) => l.kind === "msg");
    expect(msgs.map((l) => l.data)).toEqual([
      { tokens: "not a list" },
      { tokens: [{ text: 5 }, word(" قال", true)] },
      { tokens: [], finished: true },
    ]);
  });
});

describe("SonioxProvider: finalize", () => {
  it("sends finalize when live, at most once per interval", async () => {
    const t = harness(server.url, { timings: { finalizeMinIntervalMs: 150, tickMs: 20 } });
    t.provider.finalize(); // not started: nothing to finalize
    await t.start();
    t.provider.finalize();
    t.provider.finalize();
    await until(() => conn(0).controls.length === 1, "the first finalize");
    expect(t.provider.stats()).toMatchObject({ finalizeSent: 1, finalizeSkipped: 1 });
    expect(t.log.messages("debug")).toContain("finalize skipped (rate limit)");
    await sleep(200);
    t.provider.finalize();
    await until(() => conn(0).controls.length === 2, "the second finalize");
    expect(conn(0).controls).toEqual(["finalize", "finalize"]);
    expect(t.provider.stats().finalizeSent).toBe(2);
  });

  it("finalizes at a pause in Soniox's word timing, once per pause", async () => {
    const t = harness(server.url, { pauseFinalizeMs: 500 });
    await t.start();
    const c = conn(0);
    const pending = word(" الله", false, 600, 900);
    c.send({ tokens: [pending], total_audio_proc_ms: 1000 });
    c.send({ tokens: [pending], total_audio_proc_ms: 1500 });
    c.send({ tokens: [pending], total_audio_proc_ms: 2000 });
    await until(() => t.provider.stats().messages === 3, "three frames");
    await until(() => c.controls.length === 1, "the pause finalize");
    await sleep(50);
    expect(c.controls).toEqual(["finalize"]);
    expect(t.provider.stats().finalizeSent).toBe(1);
  });

  it("keeps pause finalizes 600 ms after any finalize", async () => {
    const t = harness(server.url, { pauseFinalizeMs: 500 });
    await t.start();
    const c = conn(0);
    t.provider.finalize();
    c.send({ tokens: [word(" قال", false, 100, 400)], total_audio_proc_ms: 1000 });
    await until(() => t.provider.stats().messages === 1, "the frame");
    await sleep(700);
    expect(c.controls).toEqual(["finalize"]); // the pause right after it was skipped
    c.send({ tokens: [word(" الله", false, 1100, 1400)], total_audio_proc_ms: 2000 });
    await until(() => c.controls.length === 2, "the later pause finalize");
    expect(c.controls).toEqual(["finalize", "finalize"]);
  });
});

describe("SonioxProvider: keepalive", () => {
  it("sends keepalive only when no audio has gone out for a while", async () => {
    const t = harness(server.url, { timings: { keepaliveAfterMs: 400, tickMs: 20 } });
    await t.start();
    for (let i = 0; i < 10; i++) {
      t.provider.sendAudio(audio());
      await sleep(20);
    }
    expect(conn(0).controls).toEqual([]);
    await until(() => conn(0).controls.includes("keepalive"), "a keepalive", 3000);
    expect(t.provider.stats().keepalivesSent).toBeGreaterThanOrEqual(1);
  });
});

describe("SonioxProvider: stop", () => {
  it("ends the stream gracefully: silence, finalize, end of stream, then waits for finished", async () => {
    const file = join(dir, "provider.jsonl");
    const t = harness(server.url, { recordFile: file });
    server.on.end = (c) => {
      c.send({ tokens: [word(" آمين", true), translated(" Amen")] });
      c.send({ tokens: [], finished: true });
      c.close(1000, "");
    };
    await t.start();
    t.provider.sendAudio(audio(7));
    await until(() => conn(0).frames.length === 1, "the audio");
    const stopping = t.provider.stop();
    t.provider.sendAudio(audio(8)); // while stopping: dropped
    await stopping;
    expect(t.provider.state).toBe("idle");
    expect(t.states()).toEqual(["connecting", "live", "idle"]);
    expect(t.finalText("source")).toBe(" آمين");
    expect(t.finalText("translation")).toBe(" Amen");
    const c = conn(0);
    expect(c.frames.map((f) => [f.length, f.every((b) => b === 0)])).toEqual([
      [3200, false],
      [3200, true],
      [3200, true],
    ]);
    expect(c.controls).toEqual(["finalize", ""]);
    expect(t.provider.stats()).toMatchObject({ framesIn: 2, framesSent: 1, framesDropped: 1 });
    expect(t.log.messages("warn")).toEqual([]);
    const lines = readRecording(file).lines;
    expect(lines.map((l) => l.kind)).toEqual(["session", "msg", "msg", "close"]);
    expect(lines.at(-1)).toMatchObject({ kind: "close", session: 0 });
  });

  it("gives up waiting for finished after the stop timeout (shorter when fast)", async () => {
    const t = harness(server.url, {
      timings: { stopTimeoutMs: 250, fastStopTimeoutMs: 100, tickMs: 20 },
    });
    server.on.end = () => {};
    await t.start();
    let began = Date.now();
    await t.provider.stop();
    expect(Date.now() - began).toBeGreaterThanOrEqual(240);
    await t.start();
    began = Date.now();
    await t.provider.stop({ fast: true });
    expect(Date.now() - began).toBeLessThan(250 + 200);
    const timeouts = t.log.entries.filter(
      (e) => e.msg === "Soniox did not confirm end of stream in time",
    );
    expect(timeouts.map((e) => e.obj)).toEqual([{ timeoutMs: 250 }, { timeoutMs: 100 }]);
  });

  it("stops at once when Soniox closes instead of confirming, or reports an error", async () => {
    const t = harness(server.url);
    server.on.end = (c) => c.close(1000, "");
    await t.start();
    let began = Date.now();
    await t.provider.stop();
    expect(Date.now() - began).toBeLessThan(1000);
    server.on.end = (c) => c.send({ error_code: 503, error_message: "shutting down" });
    await t.start();
    began = Date.now();
    await t.provider.stop();
    expect(Date.now() - began).toBeLessThan(2000);
    expect(t.log.entries.find((e) => e.msg === "Soniox error while stopping")?.obj).toEqual({
      message: "Soniox error 503: shutting down",
    });
    expect(t.errors()).toEqual([]);
  });

  it("does not finalize at a pause while stopping", async () => {
    const t = harness(server.url, { pauseFinalizeMs: 500 });
    server.on.end = (c) => {
      c.send({ tokens: [word(" الله", false, 600, 900)], total_audio_proc_ms: 2000 });
      c.send({ tokens: [], finished: true });
    };
    await t.start();
    await t.provider.stop();
    expect(conn(0).controls).toEqual(["finalize", ""]);
  });

  it("returns the same stop to every caller, and start() waits for it", async () => {
    const t = harness(server.url);
    await t.start();
    const a = t.provider.stop();
    const b = t.provider.stop();
    expect(b).toBe(a);
    const restarted = t.start("sess-2");
    await a;
    await restarted;
    expect(t.provider.state).toBe("live");
    await until(() => (server.conns[1]?.config ?? null) !== null, "the second config");
    expect(conn(1).config?.client_reference_id).toBe("sess-2");
    await expect(t.start()).rejects.toThrow("SonioxProvider: already started");
  });

  it("does nothing on stop() before start()", async () => {
    const t = harness(server.url);
    await t.provider.stop();
    expect(t.provider.state).toBe("idle");
    expect(t.events).toEqual([]);
    expect(server.conns).toHaveLength(0);
  });

  it("continues after a restart: a new session placed after all audio so far", async () => {
    const file = join(dir, "provider.jsonl");
    const t = harness(server.url, { recordFile: file });
    await t.start();
    for (let i = 0; i < 3; i++) t.provider.sendAudio(audio());
    await until(() => conn(0).frames.length === 3, "the first audio");
    await t.provider.stop();
    t.provider.sendAudio(audio()); // between sessions: buffered for the next one
    await sleep(30);
    await t.start("sess-2");
    await until(() => server.conns[1]?.frames.length === 1, "the buffered frame");
    const reconnected = t.events.find((e) => e.type === "reconnected");
    expect(reconnected).toMatchObject({ type: "reconnected", audioOffsetMs: 300 });
    expect(reconnected?.type === "reconnected" && reconnected.gapMs).toBeGreaterThanOrEqual(25);
    expect(t.provider.stats()).toMatchObject({ sessions: 2, reconnects: 1, framesIn: 4 });
    await t.provider.stop();
    // One recording: the meta line once, both sessions.
    const text = readFileSync(file, "utf8");
    expect(text.match(/"kind":"meta"/g)).toHaveLength(1);
    const sessions = readRecording(file).lines.filter((l) => l.kind === "session");
    expect(sessions).toMatchObject([
      { kind: "session", index: 0, audioOffsetMs: 0 },
      { kind: "session", index: 1, audioOffsetMs: 300 },
    ]);
    expect(sessions[1]).toHaveProperty("gapMs");
  });
});

describe("SonioxProvider: recording", () => {
  it("never writes the key: a redacted config, and scrubbed frames", async () => {
    const file = join(dir, "provider.jsonl");
    const t = harness(server.url, { recordFile: file });
    server.on.config = (c) => c.send({ tokens: [word(` ${TEST_KEY}`, true)] });
    await t.start();
    await until(() => t.events.some((e) => e.type === "tokens"), "the echo");
    await t.provider.stop();
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(TEST_KEY);
    const rec = readRecording(file);
    expect(rec.meta).toMatchObject({ provider: "soniox", version: 1 });
    expect(rec.meta.config).toMatchObject({ api_key: "[redacted]", model: "stt-rt-v5" });
  });

  it("captions without a recording when its folder cannot be made", async () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    const t = harness(server.url, { recordFile: join(blocker, "provider.jsonl") });
    await t.start();
    expect(t.provider.state).toBe("live");
    expect(t.log.messages("warn")).toEqual(["cannot open provider recording"]);
  });

  it("stops recording, not captioning, when the file fails", async () => {
    const t = harness(server.url, { recordFile: dir }); // a directory: the open fails
    server.on.config = (c) => c.send({ tokens: [word(" قال", true)] });
    await t.start();
    await until(
      () => t.log.messages("warn").includes("provider recording failed; recording stopped"),
      "the recording warning",
    );
    await until(() => t.finalText("source") === " قال", "the tokens");
  });
});
