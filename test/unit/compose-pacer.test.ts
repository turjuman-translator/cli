// The pacer (calm captions) around a scripted inner pipeline: steps and their gaps, bundles and
// where they break, the oldest-first queue, verses and cards at once, hidden and changed members,
// the listening dots, Clear, the drain at the end and the published history.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALM, gapAfter, NEW_POINT_OPENERS, opensNewPoint } from "../../src/compose/pacer.js";
import type { Block } from "../../src/shared/protocol.js";
import { seg } from "./helpers/compose-fast-blocks.js";
import { type PacerHarness, pacerHarness, words } from "./helpers/compose-pacer.js";

const T0 = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Let the pacer step what the inner pipeline just said (it waits for the end of the turn). */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const texts = (p: PacerHarness): string[] => p.adds().map((b) => b.text);
const at = (p: PacerHarness): Array<[string, number]> =>
  p.adds().map((b) => [b.text, b.createdAt - T0]);

/** A first step with this many characters, so the members after it wait together. */
async function firstStep(p: PacerHarness, chars: number): Promise<void> {
  p.inner.say("a".repeat(chars));
  await settle();
}

describe("gapAfter and the constants", () => {
  it("waits 2 s plus the reading time at 15 characters a second, from 6 to 20 s", () => {
    expect(CALM).toEqual({
      minGapMs: 6000,
      maxGapMs: 20_000,
      readCharsPerSec: 15,
      baseGapMs: 2000,
      maxBundleWords: 55,
      longPauseMs: 6000,
      listeningAfterMs: 20_000,
    });
    expect(gapAfter(0)).toBe(6000);
    expect(gapAfter(60)).toBe(6000);
    expect(gapAfter(75)).toBe(7000);
    expect(gapAfter(150)).toBe(12_000);
    expect(gapAfter(270)).toBe(20_000);
    expect(gapAfter(5000)).toBe(20_000);
  });

  it("knows how a new point opens, in normalized Arabic and as whole words", () => {
    for (const o of NEW_POINT_OPENERS) expect(opensNewPoint(`${o}، فإن التقوى خير`), o).toBe(true);
    expect(opensNewPoint("أَمَّا بَعْدُ: فإن خير الحديث")).toBe(true);
    expect(opensNewPoint("إعلموا رحمكم الله")).toBe(true);
    expect(opensNewPoint("يا أيها الناس، اتقوا ربكم")).toBe(true);
    expect(opensNewPoint("يا عباد الله")).toBe(true);
    expect(opensNewPoint("واعلموا أن الله")).toBe(true);
    expect(opensNewPoint("فاعلموا")).toBe(true);
    expect(opensNewPoint("يا رب")).toBe(false);
    expect(opensNewPoint("يا")).toBe(false);
    expect(opensNewPoint("وقال")).toBe(false);
    expect(opensNewPoint("و")).toBe(false);
    expect(opensNewPoint("قال عباد الله")).toBe(false);
    expect(opensNewPoint("أيها")).toBe(false);
    expect(opensNewPoint("اعلموهم")).toBe(false);
    expect(opensNewPoint("")).toBe(false);
    expect(opensNewPoint(null)).toBe(false);
  });
});

describe("steps", () => {
  it("keeps a growing member out of sight and publishes it complete once it closes", async () => {
    const p = pacerHarness();
    const m = p.inner.add("Alle lof", {
      src: "الحمد لله",
      segmentIds: ["s1"],
      startMs: 100,
      endMs: 900,
    });
    await settle();
    p.inner.change(m, { text: "Alle lof is voor Allah,", endMs: 1500 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.out).toEqual([]);
    p.inner.change(m, {
      text: "Alle lof is voor Allah, de Heer der werelden.",
      src: "الحمد لله رب العالمين",
      endMs: 2400,
    });
    p.inner.finish(m);
    await settle();
    const published: Block = {
      id: "p:b1",
      seq: 1,
      kind: "speech",
      text: "Alle lof is voor Allah, de Heer der werelden.",
      ref: null,
      src: "الحمد لله رب العالمين",
      lang: "nl",
      segmentIds: ["s1"],
      createdAt: T0 + 60_000,
      startMs: 100,
      endMs: 2400,
    };
    expect(p.out).toEqual([{ type: "block.add", block: published }]);
    expect(p.persisted).toEqual([published]);
    expect(p.pacer.blocks()).toEqual({ blocks: [published], hasMore: false });
  });

  it("waits the gap the last step's characters ask for, then publishes at the first moment one is closed", async () => {
    const p = pacerHarness();
    // The very first step needs no wait.
    await firstStep(p, 150);
    p.inner.say("Twee.");
    await vi.advanceTimersByTimeAsync(11_750);
    expect(texts(p)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(at(p).at(-1)).toEqual(["Twee.", 12_000]);
    // Its gap (6 s) has long passed when the next member closes: that one goes out at once.
    await vi.advanceTimersByTimeAsync(10_000);
    p.inner.say("Drie.");
    await settle();
    expect(at(p).at(-1)).toEqual(["Drie.", 22_000]);
    expect(p.pacer.blocks().blocks.map((b) => b.seq)).toEqual([1, 2, 3]);
  });

  it("joins the closed members that waited together into one block", async () => {
    const p = pacerHarness();
    await firstStep(p, 10);
    p.inner.say("Tweede zin.", { src: "الثانية", segmentIds: ["s2"], startMs: 1000, endMs: 2000 });
    p.inner.say("Derde zin.", {
      src: " الثالثة ",
      segmentIds: ["s2", "s3"],
      startMs: 2100,
      endMs: 3000,
    });
    p.inner.say(" ", { src: null, segmentIds: ["s3"], startMs: 3100, endMs: 3200 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(p.adds()[1]).toEqual({
      id: "p:b2",
      seq: 2,
      kind: "speech",
      text: "Tweede zin. Derde zin.",
      ref: null,
      src: "الثانية الثالثة",
      lang: "nl",
      segmentIds: ["s2", "s3"],
      createdAt: T0 + 6000,
      startMs: 1000,
      endMs: 3200,
    });
  });

  it("never publishes a member that is still growing, however long it takes", async () => {
    const p = pacerHarness();
    p.inner.add("Een lange zin die maar doorgaat");
    p.inner.say("Daarna.");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.adds()).toEqual([]);
  });
});

describe("bundles", () => {
  /** "Start." first; then two members wait together: texts of what was published by +6 s. */
  async function pair(first: Partial<Block>, second: Partial<Block>, t1 = "Een.", t2 = "Twee.") {
    const p = pacerHarness();
    await firstStep(p, 10);
    p.inner.say(t1, first);
    p.inner.say(t2, second);
    await vi.advanceTimersByTimeAsync(6000);
    return texts(p).slice(1);
  }

  it("start anew after a long pause between the members' speech", async () => {
    expect(await pair({ startMs: 0, endMs: 1000 }, { startMs: 7000, endMs: 8000 })).toEqual([
      "Een.",
    ]);
    expect(await pair({ startMs: 0, endMs: 1000 }, { startMs: 6999, endMs: 8000 })).toEqual([
      "Een. Twee.",
    ]);
  });

  it("measure the pause by arrival when the speech has no times", async () => {
    const run = async (pauseMs: number, second: Partial<Block> = {}): Promise<string[]> => {
      const p = pacerHarness();
      await firstStep(p, 270);
      p.inner.say("Een.", { startMs: 0, endMs: 1000 });
      await vi.advanceTimersByTimeAsync(pauseMs);
      p.inner.say("Twee.", second);
      await vi.advanceTimersByTimeAsync(20_000 - pauseMs);
      return texts(p).slice(1);
    };
    expect(await run(6000)).toEqual(["Een.", "Twee."]);
    expect(await run(5750)).toEqual(["Een. Twee."]);
    expect(await run(6000, { startMs: 3000, endMs: 4000 })).toEqual(["Een. Twee."]);
  });

  it("start anew at a new point", async () => {
    for (const o of NEW_POINT_OPENERS) {
      expect(await pair({ src: "قال" }, { src: `${o} فإن` }), o).toEqual(["Een."]);
    }
    expect(await pair({ src: "قال" }, { src: "فإن خير الحديث" })).toEqual(["Een. Twee."]);
  });

  it("start anew between speech and a dua, both ways", async () => {
    expect(await pair({ kind: "speech" }, { kind: "dua" })).toEqual(["Een."]);
    expect(await pair({ kind: "dua" }, { kind: "speech" })).toEqual(["Een."]);
    expect(await pair({ kind: "dua" }, { kind: "dua" })).toEqual(["Een. Twee."]);
  });

  it("hold at most 55 words: the member that would go over starts the next", async () => {
    expect(await pair({}, {}, words(30, "a"), words(25, "b"))).toEqual([
      `${words(30, "a")} ${words(25, "b")}`,
    ]);
    expect(await pair({}, {}, words(30, "a"), words(26, "b"))).toEqual([words(30, "a")]);
  });

  it("keep a member longer than the cap on its own, and let it out at the shortest gap", async () => {
    const p = pacerHarness();
    await firstStep(p, 270);
    p.inner.say(words(60, "woord"));
    p.inner.say("Kort.");
    await vi.advanceTimersByTimeAsync(5750);
    expect(texts(p)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(at(p).at(-1)).toEqual([words(60, "woord"), 6000]);
    // 60 words take more than 20 s to read; "Kort." waits the longest gap.
    await vi.advanceTimersByTimeAsync(19_750);
    expect(texts(p)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(at(p).at(-1)).toEqual(["Kort.", 26_000]);
  });
});

describe("the queue", () => {
  it("publishes the oldest bundle at each step, 6 s apart while another one waits", async () => {
    const p = pacerHarness();
    await firstStep(p, 270);
    p.inner.say("Een.", { kind: "speech" });
    p.inner.say("O Allah.", { kind: "dua" });
    p.inner.say("Twee.", { kind: "speech" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(at(p).slice(1)).toEqual([
      ["Een.", 6000],
      ["O Allah.", 12_000],
      ["Twee.", 18_000],
    ]);
    expect(p.adds().map((b) => b.kind)).toEqual(["speech", "speech", "dua", "speech"]);
  });

  it("reaches a steady state with speech at 150 words a minute", async () => {
    const p = pacerHarness();
    // Sentences of 8 to 16 words of six characters, one after the other, for 30 minutes.
    const closedAt = new Map<string, number>();
    let t = 0;
    let n = 0;
    const word = "woord";
    while (t < 30 * 60_000) {
      const count = 8 + ((n * 7) % 9);
      const ms = count * 400;
      await vi.advanceTimersByTimeAsync(ms);
      t += ms;
      n++;
      const id = `seg${n}`;
      p.inner.say(Array.from({ length: count }, () => word).join(" "), {
        segmentIds: [id],
        startMs: t - ms,
        endMs: t,
      });
      closedAt.set(id, Date.now());
    }
    await vi.advanceTimersByTimeAsync(120_000);
    const blocks = p.adds();
    // Every sentence was published once, in order, and no bundle is over the cap.
    expect(blocks.flatMap((b) => b.segmentIds)).toEqual([...closedAt.keys()]);
    for (const b of blocks) expect(b.text.split(" ").length).toBeLessThanOrEqual(55);
    // Never two steps closer than 6 s, never one waiting more than 20 s while speech is waiting.
    const steps = p.steps();
    const gaps = steps.slice(1).map((s, i) => s - (steps[i] as number));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(6000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(20_250);
    // The delay from a sentence's end to its step stays bounded and does not keep growing.
    const lag = (from: number, to: number): number =>
      Math.max(
        ...blocks
          .filter((b) => b.createdAt - T0 >= from && b.createdAt - T0 < to)
          .flatMap((b) => b.segmentIds.map((id) => b.createdAt - (closedAt.get(id) as number))),
      );
    const early = lag(5 * 60_000, 15 * 60_000);
    const late = lag(20 * 60_000, 30 * 60_000);
    expect(early).toBeLessThanOrEqual(30_000);
    expect(late).toBeLessThanOrEqual(early + 2000);
  });
});

describe("verses, prayer cards and mode", () => {
  it("publishes a verse at once, after all the speech said before it, in the same step", async () => {
    const p = pacerHarness();
    await firstStep(p, 270);
    await vi.advanceTimersByTimeAsync(3000);
    p.inner.say("Een.");
    p.inner.say("O Allah, vergeef ons.", { kind: "dua" });
    p.inner.say("En Hij zei:");
    const v = p.inner.add("Allah, er is geen god dan Hij", {
      kind: "quran",
      ref: "2:255",
      quranText: "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ",
      segmentIds: ["s9"],
    });
    await settle();
    expect(at(p).slice(1)).toEqual([
      ["Een.", 3000],
      ["O Allah, vergeef ons.", 3000],
      ["En Hij zei:", 3000],
      ["Allah, er is geen god dan Hij", 3000],
    ]);
    const verse = p.adds()[4];
    expect(verse).toEqual({
      ...v,
      id: "p:b5",
      seq: 5,
      createdAt: T0 + 3000,
    });
    // It grows as he recites: the changes pass through at once.
    p.inner.change(v, { text: "Allah, er is geen god dan Hij, de Levende" });
    await settle();
    expect(p.updates()).toEqual([{ ...verse, text: "Allah, er is geen god dan Hij, de Levende" }]);
    // The step started the gap again, measured with all its characters.
    const wait = gapAfter(
      "Een.O Allah, vergeef ons.En Hij zei:Allah, er is geen god dan Hij".length,
    );
    p.inner.say("Daarna.");
    await vi.advanceTimersByTimeAsync(wait - 250);
    expect(texts(p)).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(texts(p)).toHaveLength(6);
    expect((p.adds()[5]?.createdAt ?? 0) - T0 - 3000).toBeGreaterThanOrEqual(wait);
  });

  it("counts a verse alone as a step too", async () => {
    const p = pacerHarness();
    p.inner.add("x".repeat(150), { kind: "quran", ref: "1:1" });
    await settle();
    p.inner.say("Daarna.");
    await vi.advanceTimersByTimeAsync(11_750);
    expect(texts(p)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(texts(p)).toHaveLength(2);
  });

  it("puts a prayer card up at once after the speech before it, and passes its changes on", async () => {
    const p = pacerHarness();
    await firstStep(p, 270);
    p.inner.say("Een.");
    const card = p.inner.add("", {
      kind: "event",
      event: { type: "athan", active: true, startedAt: T0 },
      segmentIds: [],
    });
    p.inner.emit({ type: "mode", mode: "athan" });
    // Mode goes out at once, before the step.
    expect(p.out.at(-1)).toEqual({ type: "mode", mode: "athan" });
    await settle();
    expect(
      p
        .adds()
        .slice(1)
        .map((b) => b.kind),
    ).toEqual(["speech", "event"]);
    p.inner.change(card, {
      event: { type: "athan", active: false, startedAt: T0, endedAt: T0 + 9 },
    });
    p.inner.change(card, { hidden: true });
    expect(p.updates().map((b) => [b.id, b.event?.active, b.hidden])).toEqual([
      ["p:b3", false, undefined],
      ["p:b3", false, true],
    ]);
    expect(p.pacer.blocks().blocks.at(-1)).toMatchObject({ id: "p:b3", hidden: true });
  });

  it("shows a verse's latest state when it changed before it went out, and drops a hidden card", async () => {
    const p = pacerHarness();
    const v = p.inner.add("Kort", { kind: "quran", ref: "1:1" });
    p.inner.change(v, { text: "Kort en langer" });
    const card = p.inner.add("", {
      kind: "event",
      event: { type: "iqama", active: true, startedAt: T0 },
    });
    p.inner.change(card, { hidden: true });
    await settle();
    expect(texts(p)).toEqual(["Kort en langer"]);
    // A quoted verse closes too: nothing happens.
    p.inner.finish(v);
    p.inner.change(card, { event: { type: "iqama", active: false, startedAt: T0 } });
    await settle();
    expect(p.out).toHaveLength(1);
  });

  it("drops formula speech that fast blocks hides in the turn its card arrives", async () => {
    const p = pacerHarness();
    await firstStep(p, 270);
    const kept = p.inner.say("Een.");
    const formula = p.inner.say("Allah is de Grootste.");
    p.inner.add("", { kind: "event", event: { type: "athan", active: true, startedAt: T0 } });
    p.inner.change(formula, { hidden: true });
    await settle();
    expect(
      p
        .adds()
        .slice(1)
        .map((b) => [b.kind, b.text]),
    ).toEqual([
      ["speech", kept.text],
      ["event", ""],
    ]);
  });

  it("tells the mode of the inner pipeline", () => {
    const p = pacerHarness();
    expect(p.pacer.mode).toBe("speech");
    p.inner.mode = "salah";
    expect(p.pacer.mode).toBe("salah");
  });
});

describe("hidden and changed members", () => {
  it("drops a hidden member that is still waiting", async () => {
    const p = pacerHarness();
    await firstStep(p, 10);
    p.inner.say("Een.");
    const b = p.inner.say("Twee.");
    p.inner.change(b, { hidden: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(texts(p).slice(1)).toEqual(["Een."]);
  });

  it("rebuilds a published block from its visible members, and hides it when none is left", async () => {
    const p = pacerHarness();
    const a = p.inner.add("Een.", { src: "واحد", segmentIds: ["s1"], startMs: 0, endMs: 1000 });
    const b = p.inner.add("Twee.", {
      src: "اثنان",
      segmentIds: ["s2"],
      startMs: 1100,
      endMs: 2000,
    });
    p.inner.finish(a);
    p.inner.finish(b);
    await settle();
    const published = p.adds()[0] as Block;
    expect(published).toMatchObject({ text: "Een. Twee.", segmentIds: ["s1", "s2"] });
    p.inner.change(a, { hidden: true });
    expect(p.updates()).toEqual([
      {
        ...published,
        text: "Twee.",
        src: "اثنان",
        segmentIds: ["s2"],
        startMs: 1100,
        endMs: 2000,
      },
    ]);
    p.inner.change(b, { hidden: true });
    expect(p.updates().at(-1)).toEqual({ ...p.updates()[0], hidden: true });
    expect(p.pacer.blocks().blocks).toEqual([p.updates().at(-1)]);
    expect(p.persisted.map((x) => x.text)).toEqual(["Een. Twee.", "Twee.", "Twee."]);
  });

  it("follows a text fix-up and a change of kind of a published member", async () => {
    const p = pacerHarness();
    const a = p.inner.say("Een,");
    const b = p.inner.say("twee.");
    await settle();
    p.inner.change(a, { text: "Eén," });
    expect(p.updates().at(-1)).toMatchObject({ id: "p:b1", text: "Eén, twee.", kind: "speech" });
    p.inner.change(a, { kind: "dua" });
    expect(p.updates().at(-1)).toMatchObject({ id: "p:b1", text: "Eén, twee.", kind: "dua" });
    p.inner.change(b, { text: "twee!" });
    expect(p.updates().at(-1)).toMatchObject({ text: "Eén, twee!" });
  });

  it("bundles by the latest kind of a waiting member", async () => {
    const p = pacerHarness();
    await firstStep(p, 10);
    p.inner.say("Een.");
    const b = p.inner.say("Twee.");
    p.inner.change(b, { kind: "dua" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(
      p
        .adds()
        .slice(1)
        .map((x) => [x.kind, x.text]),
    ).toEqual([
      ["speech", "Een."],
      ["dua", "Twee."],
    ]);
  });

  it("ignores a change of a block it never saw", async () => {
    const p = pacerHarness();
    const ghost: Block = {
      id: "i:b99",
      seq: 99,
      kind: "speech",
      text: "?",
      ref: null,
      src: null,
      lang: "nl",
      segmentIds: [],
      createdAt: T0,
    };
    p.inner.emit({ type: "block.update", block: ghost });
    p.inner.finish(ghost);
    await settle();
    expect(p.out).toEqual([]);
  });
});

describe("listening dots", () => {
  it("light up only after 20 s of speech with nothing shown and nothing waiting, never with a partial", async () => {
    const p = pacerHarness();
    p.inner.emit({ type: "listening", active: true, partial: "الحمد" });
    await vi.advanceTimersByTimeAsync(19_750);
    expect(p.listening()).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(p.listening()).toEqual([true]);
    expect(p.pacer.listeningState()).toEqual({ active: true });
    expect(p.out).toEqual([{ type: "listening", active: true }]);
    // Text arrives: the dots go, and stay off while it waits.
    const m = p.inner.add("Eindelijk");
    await settle();
    expect(p.listening()).toEqual([true, false]);
    p.inner.emit({ type: "listening", active: false });
    p.inner.emit({ type: "listening", active: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.listening()).toEqual([true, false]);
    p.inner.finish(m);
    await settle();
    // Published at +50 s: 20 s later, with the speech still heard, the dots come back.
    await vi.advanceTimersByTimeAsync(19_750);
    expect(p.listening()).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(250);
    expect(p.listening()).toEqual([true, false, true]);
    p.inner.emit({ type: "listening", active: false });
    await settle();
    expect(p.listening()).toEqual([true, false, true, false]);
    expect(p.pacer.listeningState()).toEqual({ active: false });
  });
});

describe("Clear, the drain and the history", () => {
  it("forgets the shown and the waiting blocks on Clear; the next bundle needs no wait", async () => {
    const p = pacerHarness();
    const first = p.inner.say("a".repeat(270));
    await settle();
    p.inner.say("Wacht.");
    p.pacer.clearHistory();
    expect(p.inner.calls).toEqual(["clear"]);
    expect(p.pacer.blocks()).toEqual({ blocks: [], hasMore: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(texts(p)).toHaveLength(1);
    p.inner.change(first, { hidden: true });
    p.inner.say("Nieuw.");
    await settle();
    expect(p.updates()).toEqual([]);
    expect(p.adds().map((b) => [b.id, b.text, b.createdAt - T0])).toEqual([
      ["p:b1", "a".repeat(270), 0],
      ["p:b2", "Nieuw.", 30_000],
    ]);
  });

  it("publishes everything waiting at once when the session stops", async () => {
    const p = pacerHarness();
    await firstStep(p, 270);
    p.inner.say("Een.");
    p.inner.say("O Allah.", { kind: "dua" });
    const open = p.inner.add("Nog bezig.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(texts(p)).toHaveLength(1);
    // Fast blocks closes the open block when it drains, and may still show a verse and speech.
    p.inner.onCall = () => {
      p.inner.finish(open);
      p.inner.add("Een vers", { kind: "quran", ref: "1:2" });
      p.inner.say("Laatste.");
    };
    await p.pacer.drain(5000);
    expect(p.inner.calls).toEqual(["drain 5000"]);
    expect(at(p).slice(1)).toEqual([
      ["Een.", 1000],
      ["O Allah.", 1000],
      ["Nog bezig.", 1000],
      ["Een vers", 1000],
      ["Laatste.", 1000],
    ]);
    // Nothing waiting: nothing more.
    await p.pacer.drain(1000);
    expect(texts(p)).toHaveLength(6);
  });

  it("closes the inner pipeline once and stops its ticker", () => {
    const p = pacerHarness();
    expect(vi.getTimerCount()).toBe(1);
    p.pacer.close();
    p.pacer.close();
    expect(p.inner.closedCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pages back through the published blocks and hands out copies", async () => {
    const p = pacerHarness();
    for (const t of ["Een.", "Twee.", "Drie."]) {
      p.inner.say(t);
      await vi.advanceTimersByTimeAsync(6000);
    }
    expect(p.pacer.blocks({ limit: 2 })).toMatchObject({ hasMore: true });
    expect(p.pacer.blocks({ limit: 2 }).blocks.map((b) => b.text)).toEqual(["Twee.", "Drie."]);
    expect(p.pacer.blocks({ before: 3, limit: 1 }).blocks.map((b) => b.text)).toEqual(["Twee."]);
    expect(p.pacer.blocks({ before: 2 })).toMatchObject({ hasMore: false });
    expect(p.pacer.blocks({ limit: 0 }).blocks).toHaveLength(1);
    expect(p.pacer.blocks({ limit: 9999 }).blocks).toHaveLength(3);
    const copy = p.pacer.blocks().blocks[0] as Block;
    copy.text = "changed";
    expect(p.pacer.blocks().blocks[0]?.text).toBe("Een.");
  });

  it("warns when blocks.jsonl can't be written, and still publishes", async () => {
    const p = pacerHarness({ persistThrows: true });
    p.inner.say("Een.");
    await settle();
    expect(texts(p)).toEqual(["Een."]);
    expect(p.log.messages("warn")).toEqual(["blocks.jsonl write failed"]);
  });
});

describe("calls into the inner pipeline", () => {
  it("passes every input on and steps what it said when the call returns", () => {
    const p = pacerHarness();
    p.inner.onCall = () => p.inner.say("Meteen.");
    p.pacer.update(seg("s:1", "", ""));
    expect(texts(p)).toEqual(["Meteen."]);
    p.pacer.speech("start", 5);
    p.pacer.overrideEvent("athan");
    expect(p.inner.calls).toEqual(["update s:1", "speech start 5", "override athan"]);
  });
});
