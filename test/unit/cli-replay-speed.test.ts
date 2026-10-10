// `turjuman replay --speed n`: the fake provider replays n times faster than the recording, so the
// session sends n times less audio than the recording heard. Its token times and reconnect
// positions must be positions in that audio, or segment times run ahead of the session and
// `status` shows negative latencies.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../../src/stt/fake.js";
import type { RecordingEntry, RecordingMeta } from "../../src/stt/recording.js";
import { sonioxReplayMapper } from "../../src/stt/soniox-map.js";
import type { ProviderEvent } from "../../src/stt/types.js";

const META: RecordingMeta = {
  kind: "meta",
  provider: "soniox",
  version: 1,
  startedAt: 0,
  config: { translation: { type: "one_way", target_language: "nl" } },
};

/** Final Arabic words spoken from t−300 to t−100 ms of the recording's audio, then an endpoint. */
const said = (t: number, ar: string, session = 0): RecordingEntry => ({
  t,
  kind: "msg",
  session,
  data: {
    tokens: [
      { text: ar, is_final: true, language: "ar", start_ms: t - 300, end_ms: t - 100 },
      { text: " zei", is_final: true, language: "nl", translation_status: "translation" },
      { text: "<end>", is_final: true },
    ],
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-replay-speed-"));
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function replay(
  lines: RecordingEntry[],
  speed: number,
  loop = false,
): Promise<{ events: ProviderEvent[]; provider: FakeProvider }> {
  const file = join(dir, "provider.jsonl");
  writeFileSync(file, `${[META, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
  const provider = new FakeProvider({
    file,
    track: "soniox",
    speed,
    loop,
    mappers: { soniox: sonioxReplayMapper },
  });
  const events: ProviderEvent[] = [];
  await provider.start({ sessionId: "s1", onEvent: (e) => events.push(e) });
  return { events, provider };
}

/** [startMs, endMs] of every source token, and when it arrived. */
function sourceTimes(events: ProviderEvent[]): Array<[number?, number?, number?]> {
  return events.flatMap((e) =>
    e.type === "tokens"
      ? e.final.filter((t) => t.kind === "source").map((t) => [t.startMs, t.endMs, e.receivedAt])
      : [],
  ) as Array<[number?, number?, number?]>;
}

describe("replay faster than real time", () => {
  it("divides token times by the speed: the words never end after they arrive", async () => {
    const { events } = await replay([said(1000, " قال"), said(3000, " الله")], 4);
    await vi.advanceTimersByTimeAsync(1000);
    // Recorded at 700–900 ms and 2700–2900 ms; replayed at 250 ms and 750 ms.
    expect(sourceTimes(events)).toEqual([
      [175, 225, 250],
      [675, 725, 750],
    ]);
    // Translation tokens carry no times, and keep none.
    const nl = events
      .flatMap((e) => (e.type === "tokens" ? e.final : []))
      .find((t) => t.lang === "nl");
    expect(nl).toEqual({ text: " zei", kind: "translation", lang: "nl" });
  });

  it("passes events without audio positions on as they are", async () => {
    const busy: RecordingEntry = {
      t: 100,
      kind: "msg",
      session: 0,
      data: { error_code: 503, error_message: "Service busy" },
    };
    const { events } = await replay([busy], 4);
    await vi.advanceTimersByTimeAsync(100);
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", fatal: false, message: expect.stringContaining("Service busy") },
    ]);
  });

  it("keeps the recorded times at real time and when no audio is sent at all", async () => {
    const real = await replay([said(1000, " قال")], 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sourceTimes(real.events)).toEqual([[700, 900, 1000]]);
    const instant = await replay([said(1000, " قال")], Number.POSITIVE_INFINITY);
    expect(sourceTimes(instant.events)).toEqual([[700, 900, 1000]]);
  });

  it("places reconnects and loops in the audio sent at that speed", async () => {
    // As at real time (4.5 s of recorded audio per loop), but twice as fast: 2.25 s per loop.
    const lines: RecordingEntry[] = [
      { t: 0, kind: "session", index: 0, audioOffsetMs: 0 },
      said(400, " قال"),
      { t: 1000, kind: "session", index: 1, audioOffsetMs: 4000, gapMs: 600 },
      said(1450, " الله", 1),
    ];
    const { events, provider } = await replay(lines, 2, true);
    await vi.advanceTimersByTimeAsync(725 + 50 + 725);
    expect(events.filter((e) => e.type === "reconnected")).toEqual([
      { type: "reconnected", gapMs: 600, audioOffsetMs: 2000 },
      { type: "reconnected", gapMs: 0, audioOffsetMs: 2250 },
      { type: "reconnected", gapMs: 600, audioOffsetMs: 4250 },
    ]);
    await provider.stop();
  });
});
