// A session's pace: calm (the default) shows complete text in steps through the pacer, live is
// fast blocks as before. The history, snapshots, blocks.jsonl, the archive and the exports hold
// what the screens showed; Clear forgets what still waits and a stop shows it at once.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FastBlocks, passThroughFollower } from "../../src/compose/fast-blocks.js";
import type { PipelineOutput } from "../../src/compose/types.js";
import {
  BlocksArchive,
  blocksToMarkdown,
  blocksToSrt,
  blocksToTxt,
} from "../../src/core/blocks-archive.js";
import { createEngineFactory } from "../../src/core/engines.js";
import { SessionManager } from "../../src/core/sessions.js";
import { loadLanguages } from "../../src/languages.js";
import type { Block, ServerMessage } from "../../src/shared/protocol.js";
import {
  captureLog,
  ManualInput,
  silentFrame,
  src,
  tempDirs,
  testConfig,
  tr,
} from "./helpers/core-fakes.js";
import { makeSession, type SessionSetup } from "./helpers/core-session.js";

const T0 = new Date(2026, 9, 9, 13, 0, 0).getTime();
const FIXTURE = join(process.cwd(), "test", "fixtures", "soniox-tts-1.jsonl");
const temp = tempDirs("core-session-pace-");

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function blocksSession(s: SessionSetup = {}) {
  return makeSession(temp.make(), {
    ...s,
    options: { layout: "blocks", blocks: { detector: null }, ...s.options },
  });
}

type Session = ReturnType<typeof blocksSession>;

/** One sentence in three parts, 400 ms apart; `end` sends the endpoint. */
async function say(p: Session, ar: string[], nl: string[], end = true): Promise<void> {
  const provider = p.f.providers.at(-1);
  for (let i = 0; i < ar.length; i++) {
    provider?.tokens([src(ar[i] ?? "", i * 400, i * 400 + 400), tr(nl[i] ?? "")]);
    await vi.advanceTimersByTimeAsync(400);
  }
  if (end) provider?.endpoint();
}

const FIRST = {
  ar: ["الحمد لله ", "رب العالمين ", "والصلاة والسلام"],
  nl: ["Alle lof is voor Allah,", " de Heer der werelden,", " en vrede zij met de Profeet."],
};
const SECOND = {
  ar: ["أما بعد ", "فإن خير ", "الحديث كتاب الله"],
  nl: ["En verder:", " het beste woord", " is het Boek van Allah."],
};

const texts = (p: Session): string[] => p.of("block.add").map((m) => m.block.text);

function jsonl(p: Session): unknown[] {
  return readFileSync(join(p.dir() ?? "", "blocks.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);
}

describe("a calm session (the default)", () => {
  it("shows a sentence once, complete, and nothing grows on screen", async () => {
    const p = blocksSession();
    expect(p.session.pace).toBe("calm");
    p.session.speech("start");
    await flush();
    await say(p, FIRST.ar, FIRST.nl);
    expect(texts(p)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    const text = "Alle lof is voor Allah, de Heer der werelden, en vrede zij met de Profeet.";
    expect(texts(p)).toEqual([text]);
    expect(p.of("block.update")).toEqual([]);
    expect(p.of("listening").every((m) => m.partial === undefined)).toBe(true);
    const published = p.of("block.add")[0]?.block;
    expect(jsonl(p)).toEqual([published]);
    const snaps = p.session.snapshots();
    expect(snaps.find((m) => m.type === "blocks.snapshot")).toEqual({
      type: "blocks.snapshot",
      blocks: [published],
      hasMore: false,
    });
    expect(snaps.find((m) => m.type === "listening")).toEqual({ type: "listening", active: false });
    await p.session.stop("test");
  });

  it("waits for the gap, but shows the speech before a prayer card at once with the card", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    await say(p, FIRST.ar, FIRST.nl);
    await vi.advanceTimersByTimeAsync(2000);
    await say(p, SECOND.ar, SECOND.nl);
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts(p)).toHaveLength(1);
    p.session.overrideEvent("athan");
    expect(p.of("block.add").map((m) => [m.block.kind, m.block.text])).toEqual([
      ["speech", "Alle lof is voor Allah, de Heer der werelden, en vrede zij met de Profeet."],
      ["speech", "En verder: het beste woord is het Boek van Allah."],
      ["event", ""],
    ]);
    const [, speech, card] = p.of("block.add").map((m) => m.block);
    expect(speech?.createdAt).toBe(card?.createdAt);
    expect(p.of("mode").at(-1)).toEqual({ type: "mode", mode: "athan" });
    await p.session.stop("test");
  });

  it("forgets what still waits on Clear, and shows what waits when it stops", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    await say(p, FIRST.ar, FIRST.nl);
    await vi.advanceTimersByTimeAsync(2000);
    await say(p, SECOND.ar, SECOND.nl);
    await vi.advanceTimersByTimeAsync(2000);
    p.session.clear();
    expect(p.session.blocks().blocks).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(texts(p)).toHaveLength(1);
    // Still being said when the session stops: shown at once, before the end.
    await say(p, ["ثم قال "], ["Toen zei hij"], false);
    await p.session.stop("test", { fast: true });
    expect(
      p.messages
        .filter((m) => m.type === "block.add" || m.type === "session.ended")
        .map((m) => m.type),
    ).toEqual(["block.add", "block.add", "session.ended"]);
    expect(texts(p).at(-1)).toBe("Toen zei hij");
  });

  it("keeps only what was shown in blocks.jsonl, and the archive and the exports read it back", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    await say(p, FIRST.ar, FIRST.nl);
    await vi.advanceTimersByTimeAsync(2000);
    // Two sentences wait together for the gap: one bundle.
    await say(
      p,
      ["ثم قال ", "للناس إن ", "هذا خير"],
      ["Toen zei hij", " tegen de mensen", " dat het goed is."],
    );
    await vi.advanceTimersByTimeAsync(2000);
    await say(
      p,
      ["اتقوا الله ", "حق ", "تقاته"],
      ["Vrees Allah", " zoals Hij", " gevreesd moet worden."],
    );
    await vi.advanceTimersByTimeAsync(8000);
    await p.session.stop("test");
    const shown = p.of("block.add").map((m) => m.block);
    expect(shown.map((b) => b.text)).toEqual([
      "Alle lof is voor Allah, de Heer der werelden, en vrede zij met de Profeet.",
      "Toen zei hij tegen de mensen dat het goed is. Vrees Allah zoals Hij gevreesd moet worden.",
    ]);
    const lines = jsonl(p).filter((l) => (l as { type?: string }).type === undefined);
    expect(lines).toEqual(shown);
    const archived = new BlocksArchive(p.loaded.paths.transcriptsDir).get(p.session.id);
    expect(archived?.blocks).toEqual(shown);
    const all = archived?.blocks ?? [];
    expect(blocksToTxt(all)).toContain(shown[1]?.text);
    expect(blocksToSrt(all)).toContain(shown[1]?.text);
    expect(
      blocksToMarkdown(all, {
        sessionId: p.session.id,
        from: "ar",
        to: "nl",
        startedAt: T0,
      }),
    ).toContain(shown[1]?.text);
  });
});

describe("a live session", () => {
  it("grows the sentence on screen, as fast blocks makes it", async () => {
    const p = blocksSession({ options: { pace: "live" } });
    p.session.speech("start");
    await flush();
    await say(p, FIRST.ar, FIRST.nl);
    expect(texts(p)).toEqual(["Alle lof is voor Allah,"]);
    expect(p.of("block.update").map((m) => m.block.text)).toEqual([
      "Alle lof is voor Allah, de Heer der werelden,",
      "Alle lof is voor Allah, de Heer der werelden, en vrede zij met de Profeet.",
    ]);
    await p.session.stop("test");
  });

  it("sends exactly what fast blocks alone makes of a recorded khutbah", async () => {
    const dataDir = temp.make();
    const loaded = testConfig(dataDir, {
      audio: { monitorWhenIdle: false },
      captions: { pace: "live" },
    });
    const { log } = captureLog();
    const inputs: ManualInput[] = [];
    const manager = new SessionManager({
      loaded,
      engineFactory: createEngineFactory({
        loaded,
        log,
        languages: loadLanguages(join(process.cwd(), "languages.yaml")),
        fakeProviderFile: FIXTURE,
        fakeSpeed: 1,
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
    // Fast blocks on its own, made at the same moment as the session's, fed the same segments.
    const alone: PipelineOutput[] = [];
    const bare = new FastBlocks({
      sessionId: "bare",
      targetLang: "nl",
      follower: passThroughFollower(),
      detector: null,
      labels: loaded.config.events.labels.nl as NonNullable<
        (typeof loaded.config.events.labels)[string]
      >,
      now: () => Date.now(),
      log,
      emit: (o) => alone.push(o),
    });
    const starting = manager.startLocal({ source: "file", file: "/media/khutbah.wav" });
    await flush();
    inputs[0]?.frame(silentFrame());
    expect(await starting).toEqual({ ok: true, message: "live" });
    const session = manager.local();
    if (session === null) throw new Error("no session");
    const sent: ServerMessage[] = [];
    session.subscribe((m) => {
      if (m.type === "segment") bare.update(m.segment);
      else sent.push(m);
    });
    inputs[0]?.frame(silentFrame());
    await vi.advanceTimersByTimeAsync(60_000);
    const ofBlocks = (msgs: readonly (ServerMessage | PipelineOutput)[], id: string): string[] =>
      msgs
        .filter((m) => ["block.add", "block.update", "mode", "listening"].includes(m.type))
        .map((m) => JSON.stringify(m).replaceAll(`"${id}:b`, '"S:b'));
    const fromSession = ofBlocks(sent, session.id);
    const count = (type: string): number =>
      fromSession.filter((m) => m.includes(`"type":"${type}"`)).length;
    expect([count("block.add"), count("block.update")]).toEqual([5, 3]);
    expect(fromSession).toEqual(ofBlocks(alone, "bare"));
    bare.close();
    await manager.stopAll("test");
  });
});

describe("blocks the pacer never saw", () => {
  it("are not in a calm session's history", async () => {
    const p = blocksSession();
    p.session.speech("start");
    await flush();
    await say(p, FIRST.ar, FIRST.nl, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(p.session.blocks()).toEqual({ blocks: [], hasMore: false });
    const kinds = new Set(p.messages.map((m) => m.type));
    expect(kinds.has("block.add")).toBe(false);
    await p.session.stop("test", { fast: true });
    const block = p.of("block.add")[0]?.block as Block;
    expect(p.session.snapshots().find((m) => m.type === "blocks.snapshot")).toMatchObject({
      blocks: [block],
    });
  });
});
