// Replays every prayer-event fixture (test/fixtures/events/*.json) through EventDetector with a
// simulated clock that ticks every 500 ms, as the block pipeline does, and checks the expected
// outcome: the same checks as scripts/eval-events.ts, as a vitest test.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EventDetector, type EventsConfig } from "../../src/events/detector.js";
import { analyzeFormulas, markers } from "../../src/events/markers.js";
import type { DetectorAction, DetectorSegment } from "../../src/events/types.js";
import type { SessionMode } from "../../src/shared/protocol.js";

const DIR = new URL("../fixtures/events/", import.meta.url);
const BASE = Date.UTC(2026, 9, 2, 11, 0, 0);
const TICK_MS = 500;

/** config.events defaults (src/config.ts). */
const DEFAULTS: EventsConfig = {
  enabled: true,
  silenceBeforeSec: 5,
  holdMaxSec: 75,
  endSilenceSec: 20,
  salahMode: true,
  salahMaxMin: 12,
};

interface SegmentStep {
  id: string;
  atMs: number;
  silenceBeforeMs: number;
  startMs?: number;
  endMs?: number;
  text: string;
}
interface OverrideStep {
  override: "athan" | "iqama" | "salah" | "none";
  atMs: number;
}
interface Expectation {
  events: string[];
  eventCauses?: string[];
  provisional?: boolean[];
  changes?: string[];
  retracts?: string[];
  eventEnds?: string[];
  shown: string[];
  held: string[];
  released?: string[];
  releasedBy?: Record<string, string>;
  discarded?: string[];
  suppressed?: string[];
  hideCovers?: string[];
  finalMode: SessionMode;
  modeAfter?: Record<string, SessionMode>;
  salahAfter?: Record<string, boolean>;
  markers?: Record<string, string[]>;
  formulaOnly?: Record<string, boolean>;
}
interface Scenario {
  name: string;
  config?: Partial<EventsConfig>;
  steps: Array<SegmentStep | OverrideStep>;
  endMs: number;
  expect: Expectation;
}
interface PhraseList {
  name: string;
  phrases: Array<{ text: string; markers: string[]; formulaOnly: boolean }>;
}

interface Entry {
  t: number;
  cause: string;
  action: DetectorAction;
}

function replay(sc: Scenario) {
  let clock = BASE;
  const det = new EventDetector({ ...DEFAULTS, ...sc.config }, { now: () => clock });
  const log: Entry[] = [];
  const modeAfter = new Map<string, SessionMode>();
  const salahAfter = new Map<string, boolean>();
  const segAt = new Map<string, number>();
  const texts = new Map<string, string>();
  let nextTick = BASE + TICK_MS;
  const tickUntil = (t: number): void => {
    while (nextTick <= t) {
      clock = nextTick;
      for (const action of det.tick(clock)) log.push({ t: clock, cause: "tick", action });
      nextTick += TICK_MS;
    }
  };
  for (const step of sc.steps) {
    const at = BASE + step.atMs;
    tickUntil(at);
    clock = at;
    if ("override" in step) {
      for (const action of det.override(step.override, at)) {
        log.push({ t: at, cause: "override", action });
      }
      continue;
    }
    segAt.set(step.id, at);
    texts.set(step.id, step.text);
    const seg: DetectorSegment = {
      id: step.id,
      text: step.text,
      at,
      silenceBeforeMs: step.silenceBeforeMs,
    };
    if (step.startMs !== undefined) seg.startMs = step.startMs;
    if (step.endMs !== undefined) seg.endMs = step.endMs;
    for (const action of det.onSegment(seg)) log.push({ t: at, cause: step.id, action });
    modeAfter.set(step.id, det.mode);
    salahAfter.set(step.id, det.salah);
  }
  tickUntil(BASE + sc.endMs);
  return { log, finalMode: det.mode, modeAfter, salahAfter, segAt, texts };
}

type Disposition = "shown" | "held" | "discarded" | "suppressed";

function outcome(log: readonly Entry[]) {
  const o = {
    events: [] as Array<{ type: string; cause: string; provisional: boolean; hideSince: number }>,
    changes: [] as string[],
    retracts: [] as string[],
    eventEnds: [] as string[],
    shown: [] as string[],
    held: new Set<string>(),
    released: new Set<string>(),
    releasedBy: new Map<string, string>(),
    final: new Map<string, Disposition>(),
    violations: [] as string[],
    lastMode: null as SessionMode | null,
  };
  const set = (id: string, d: Disposition): void => {
    if (o.final.get(id) === "shown") o.violations.push(`${id}: ${d} after it was shown`);
    if (d === "shown") o.shown.push(id);
    o.final.set(id, d);
  };
  for (const { cause, action: a } of log) {
    switch (a.type) {
      case "pass":
        set(a.segment.id, "shown");
        break;
      case "hold":
        o.held.add(a.segment.id);
        set(a.segment.id, "held");
        break;
      case "release":
        for (const s of a.segments) {
          o.released.add(s.id);
          o.releasedBy.set(s.id, cause);
          set(s.id, "shown");
        }
        break;
      case "suppress":
        set(a.segment.id, "suppressed");
        break;
      case "event-start":
        o.events.push({
          type: a.event,
          cause,
          provisional: a.provisional === true,
          hideSince: a.hideFormulaBlocksSinceMs,
        });
        for (const s of a.discarded) set(s.id, "discarded");
        break;
      case "event-change":
        o.changes.push(`${a.from}>${a.to}`);
        break;
      case "event-retract":
        o.retracts.push(a.event);
        for (const s of a.released) {
          o.released.add(s.id);
          o.releasedBy.set(s.id, cause);
          set(s.id, "shown");
        }
        break;
      case "event-end":
        o.eventEnds.push(a.event);
        break;
      case "mode":
        o.lastMode = a.mode;
        break;
    }
  }
  return o;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, data: JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as unknown }));

describe("event fixtures (replayed with a 500 ms tick)", () => {
  it("has the scenario and phrase fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  for (const { file, data } of fixtures) {
    if (typeof data === "object" && data !== null && "phrases" in data) {
      const list = data as PhraseList;
      it(`${list.name}: markers and formula-only per phrase`, () => {
        for (const p of list.phrases) {
          expect(sorted(markers(p.text)), p.text).toEqual(sorted(p.markers));
          expect(analyzeFormulas(p.text).formulaOnly, p.text).toBe(p.formulaOnly);
        }
      });
      continue;
    }
    const sc = data as Scenario;
    it(`${sc.name} (${file})`, () => {
      const r = replay(sc);
      const o = outcome(r.log);
      const e = sc.expect;
      expect(o.violations).toEqual([]);
      expect(o.events.map((x) => x.type)).toEqual(e.events);
      if (e.eventCauses !== undefined) expect(o.events.map((x) => x.cause)).toEqual(e.eventCauses);
      if (e.provisional !== undefined) {
        expect(o.events.map((x) => x.provisional)).toEqual(e.provisional);
      }
      if (e.changes !== undefined) expect(o.changes).toEqual(e.changes);
      if (e.retracts !== undefined) expect(o.retracts).toEqual(e.retracts);
      if (e.eventEnds !== undefined) expect(o.eventEnds).toEqual(e.eventEnds);
      expect(o.shown).toEqual(e.shown);
      expect(sorted(o.held)).toEqual(sorted(e.held));
      if (e.released !== undefined) expect(sorted(o.released)).toEqual(sorted(e.released));
      const finalIds = (d: Disposition): string[] =>
        sorted([...o.final.entries()].filter(([, v]) => v === d).map(([k]) => k));
      if (e.discarded !== undefined) expect(finalIds("discarded")).toEqual(sorted(e.discarded));
      if (e.suppressed !== undefined) expect(finalIds("suppressed")).toEqual(sorted(e.suppressed));
      for (const [id, by] of Object.entries(e.releasedBy ?? {})) {
        expect(o.releasedBy.get(id), `released ${id}`).toBe(by);
      }
      expect(r.finalMode).toBe(e.finalMode);
      if (o.lastMode !== null) expect(o.lastMode).toBe(r.finalMode);
      for (const [id, mode] of Object.entries(e.modeAfter ?? {})) {
        expect(r.modeAfter.get(id), `mode after ${id}`).toBe(mode);
      }
      for (const [id, salah] of Object.entries(e.salahAfter ?? {})) {
        expect(r.salahAfter.get(id), `salah after ${id}`).toBe(salah);
      }
      for (const id of e.hideCovers ?? []) {
        const at = r.segAt.get(id) ?? Number.NaN;
        expect(
          o.events.some((x) => x.hideSince <= at),
          `hide ${id}`,
        ).toBe(true);
      }
      for (const [id, want] of Object.entries(e.markers ?? {})) {
        expect(sorted(markers(r.texts.get(id) ?? "")), `markers ${id}`).toEqual(sorted(want));
      }
      for (const [id, want] of Object.entries(e.formulaOnly ?? {})) {
        expect(analyzeFormulas(r.texts.get(id) ?? "").formulaOnly, `formulaOnly ${id}`).toBe(want);
      }
      // Every segment ends shown, discarded or suppressed (or still held in mode "held").
      for (const id of r.segAt.keys()) {
        const d = o.final.get(id);
        expect(d, `${id} disposition`).toBeDefined();
        if (r.finalMode !== "held") expect(d, `${id} still held`).not.toBe("held");
      }
    });
  }
});
