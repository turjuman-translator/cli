// A recorded Soniox khutbah (test/fixtures/soniox-tts-1.jsonl) replayed through the real engine
// factory, the session manager, fast blocks and the transcript writer: what `turjuman replay`
// and `run --fake-provider` do, without network or audio hardware.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passThroughFollower } from "../../src/compose/fast-blocks.js";
import { BlocksArchive } from "../../src/core/blocks-archive.js";
import { createEngineFactory } from "../../src/core/engines.js";
import { SessionManager } from "../../src/core/sessions.js";
import { loadLanguages } from "../../src/languages.js";
import type { ServerMessage } from "../../src/shared/protocol.js";
import { captureLog, ManualInput, tempDirs, testConfig, toneFrame } from "./helpers/core-fakes.js";

const FIXTURE = join(process.cwd(), "test", "fixtures", "soniox-tts-1.jsonl");
const temp = tempDirs("core-replay-");

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 9, 9, 13, 0, 0).getTime() });
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
});

describe("replaying a recorded Soniox session", () => {
  it("captions a local file session end to end: segments, blocks and transcript files", async () => {
    const dataDir = temp.make();
    const loaded = testConfig(dataDir, { audio: { monitorWhenIdle: false } });
    const { log } = captureLog();
    const inputs: ManualInput[] = [];
    const manager = new SessionManager({
      loaded,
      engineFactory: createEngineFactory({
        loaded,
        log,
        languages: loadLanguages(join(process.cwd(), "languages.yaml")),
        fakeProviderFile: FIXTURE,
        fakeSpeed: Number.POSITIVE_INFINITY,
      }),
      audioInputFactory: (spec) => {
        const input = new ManualInput(spec);
        inputs.push(input);
        return input;
      },
      log,
      version: "test",
      blocks: { detectorFactory: () => null, followerFactory: () => passThroughFollower() },
    });
    const starting = manager.startLocal({ source: "file", file: "/media/khutbah.wav" });
    await vi.advanceTimersByTimeAsync(0);
    const input = inputs[0];
    if (input === undefined) throw new Error("no input");
    input.frame(toneFrame());
    expect(await starting).toEqual({ ok: true, message: "live" });
    const session = manager.local();
    if (session === null) throw new Error("no session");
    const messages: ServerMessage[] = [];
    session.subscribe((m) => messages.push(m));
    // The first frame the engine gets starts the replay (all of it, at infinite speed).
    input.frame(toneFrame());
    await vi.advanceTimersByTimeAsync(3000);
    input.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.status().state).toBe("idle");

    const segments = messages.flatMap((m) => (m.type === "segment" ? [m.segment] : []));
    const finalSource = segments.filter((s) => s.closed).map((s) => s.source.text);
    expect(finalSource.length).toBeGreaterThan(1);
    expect(finalSource.join(" ")).toMatch(/[؀-ۿ]/);
    const blocks = messages.flatMap((m) => (m.type === "block.add" ? [m.block] : []));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.lang === "nl" && b.text !== "")).toBe(true);
    expect(messages.at(-1)?.type).toBe("status");
    expect(messages.some((m) => m.type === "session.ended")).toBe(true);

    // The transcript folder holds what was shown, and the archive reads it back.
    const archived = new BlocksArchive(loaded.paths.transcriptsDir).get(session.id);
    expect(archived?.blocks.map((b) => b.text)).toEqual(blocks.map((b) => b.text));
    expect(archived).toMatchObject({ from: "ar", to: "nl", kind: "file" });
    const dir = archived?.dir ?? "";
    expect(readFileSync(join(dir, "soniox", "ar.srt"), "utf8")).toContain(" --> ");
    expect(readFileSync(join(dir, "soniox", "nl.srt"), "utf8").length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "soniox", "segments.jsonl"))).toBe(true);
    const sessionLog = readFileSync(join(dir, "session.log"), "utf8");
    expect(sessionLog).toContain("input ended (end of file)");
    expect(sessionLog).toContain("stop: file ended");
    await manager.stopAll("test");
  });
});
