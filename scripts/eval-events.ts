// Replays the prayer-event fixtures (test/fixtures/events/*.json) through EventDetector with a
// simulated clock (tick every 500 ms, as the block pipeline does) and prints PASS/FAIL per
// scenario, with the time from the first fragment of a call to its card. Not a vitest test:
//   pnpm exec tsx scripts/eval-events.ts [--verbose] [name-filter]
//
// Two fixture kinds:
//   - scenarios: ordered steps (segments with atMs / silenceBeforeMs and optional startMs / endMs
//     in session ms, or operator overrides) and the expected outcome (events, provisional cards,
//     changes, retracts, shown / held / released / discarded / suppressed segment ids, modes,
//     hidden-block window, time to card);
//   - phrase lists: texts with their expected markers and formula-only flag (fuzzy matching).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseConfig } from "../src/config.js";
import { EventDetector, type EventsConfig } from "../src/events/detector.js";
import { analyzeFormulas, formulaShare, markers } from "../src/events/markers.js";
import type { DetectorAction, DetectorSegment } from "../src/events/types.js";
import type { SessionMode } from "../src/shared/protocol.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "test", "fixtures", "events");
/** Friday 2026-10-02 13:00 CEST; fixture times (atMs, startMs, endMs) are session ms from here. */
const BASE = Date.UTC(2026, 9, 2, 11, 0, 0);
const TICK_MS = 500;

const Mode = z.enum(["speech", "held", "athan", "iqama", "salah"]);
const PrayerEvent = z.enum(["athan", "iqama", "salah"]);
const Marker = z.enum([
  "TAKBIR",
  "SHAHADA1",
  "SHAHADA2",
  "HAYYA_SALAH",
  "HAYYA_FALAH",
  "QAD_QAMAT",
  "FAJR",
  "TAHLIL",
]);
const Ids = z.array(z.string());

const SegmentStep = z.strictObject({
  id: z.string().min(1),
  atMs: z.number(),
  silenceBeforeMs: z.number(),
  /** Session ms of the speech (delivery rate); optional. */
  startMs: z.number().optional(),
  endMs: z.number().optional(),
  text: z.string(),
  note: z.string().optional(),
});
const OverrideStep = z.strictObject({
  override: z.enum(["athan", "iqama", "salah", "none"]),
  atMs: z.number(),
  note: z.string().optional(),
});

const Expect = z.strictObject({
  /** event-start types, in order. */
  events: z.array(PrayerEvent),
  /** What started each event: a segment id, "tick" or "override". */
  eventCauses: Ids.optional(),
  /** Per event-start: shown as provisional. */
  provisional: z.array(z.boolean()).optional(),
  /** event-change actions, as "athan>iqama", in order. */
  changes: Ids.optional(),
  /** event-retract actions: the retracted event types, in order. */
  retracts: z.array(PrayerEvent).optional(),
  eventEnds: z.array(PrayerEvent).optional(),
  /** Segments shown (pass, release, or released by a retract), in order. */
  shown: Ids,
  /** Segments that were ever held (set). */
  held: Ids,
  released: Ids.optional(),
  /** held id → what released it: the arriving segment id, "tick" or "override". */
  releasedBy: z.record(z.string(), z.string()).optional(),
  /** Segments whose final disposition is discarded (by an event-start) / suppressed. */
  discarded: Ids.optional(),
  suppressed: Ids.optional(),
  /** Passed segments whose blocks the next event-start must hide (hideFormulaBlocksSinceMs). */
  hideCovers: Ids.optional(),
  /** The first card appears at most this long after its first fragment's speech start. */
  cardWithinMs: z.number().optional(),
  finalMode: Mode,
  modeAfter: z.record(z.string(), Mode).optional(),
  salahAfter: z.record(z.string(), z.boolean()).optional(),
  markers: z.record(z.string(), z.array(Marker)).optional(),
  formulaOnly: z.record(z.string(), z.boolean()).optional(),
});

const Scenario = z.strictObject({
  name: z.string(),
  description: z.string(),
  /** Overrides of config.events. */
  config: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(z.union([SegmentStep, OverrideStep])),
  /** Keep ticking until this time. */
  endMs: z.number(),
  expect: Expect,
});
type Scenario = z.infer<typeof Scenario>;

const PhraseList = z.strictObject({
  name: z.string(),
  description: z.string(),
  phrases: z.array(
    z.strictObject({
      text: z.string(),
      markers: z.array(Marker),
      formulaOnly: z.boolean(),
      note: z.string().optional(),
    }),
  ),
});
type PhraseList = z.infer<typeof PhraseList>;

interface LogEntry {
  t: number;
  cause: string;
  action: DetectorAction;
}

interface Replay {
  log: LogEntry[];
  finalMode: SessionMode;
  modeAfter: Map<string, SessionMode>;
  salahAfter: Map<string, boolean>;
  segAt: Map<string, number>;
  /** Session ms when a segment's speech started (startMs, else its atMs). */
  segStart: Map<string, number>;
  texts: Map<string, string>;
}

function eventsConfig(overrides: Record<string, unknown> | undefined): EventsConfig {
  const parsed = parseConfig(
    { events: overrides ?? {} },
    { inContainer: false, bindAddress: null },
  );
  if (!parsed.ok) throw new Error(`invalid fixture config: ${parsed.errors.join("; ")}`);
  return parsed.config.events;
}

function replay(sc: Scenario): Replay {
  let clock = BASE;
  const det = new EventDetector(eventsConfig(sc.config), { now: () => clock });
  const log: LogEntry[] = [];
  const modeAfter = new Map<string, SessionMode>();
  const salahAfter = new Map<string, boolean>();
  const segAt = new Map<string, number>();
  const segStart = new Map<string, number>();
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
    segStart.set(step.id, step.startMs ?? step.atMs);
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
  return { log, finalMode: det.mode, modeAfter, salahAfter, segAt, segStart, texts };
}

type Disposition = "shown" | "held" | "discarded" | "suppressed";

interface CardEvent {
  type: string;
  cause: string;
  t: number;
  hideSince: number;
  provisional: boolean;
  /** Segment the call's first fragment (its first discarded segment), if any. */
  first: string | null;
}

interface Outcome {
  events: CardEvent[];
  changes: string[];
  retracts: string[];
  eventEnds: string[];
  shown: string[];
  held: Set<string>;
  released: Set<string>;
  releasedBy: Map<string, string>;
  final: Map<string, Disposition>;
  /** Invalid disposition transitions (e.g. shown twice). */
  violations: string[];
  lastModeAction: SessionMode | null;
}

function outcome(log: readonly LogEntry[]): Outcome {
  const o: Outcome = {
    events: [],
    changes: [],
    retracts: [],
    eventEnds: [],
    shown: [],
    held: new Set(),
    released: new Set(),
    releasedBy: new Map(),
    final: new Map(),
    violations: [],
    lastModeAction: null,
  };
  const set = (id: string, d: Disposition, cause: string): void => {
    const prev = o.final.get(id);
    if (prev === "shown") o.violations.push(`${id}: ${d} after it was shown (${cause})`);
    if (d === "shown") o.shown.push(id);
    o.final.set(id, d);
  };
  for (const { cause, action: a } of log) {
    switch (a.type) {
      case "pass":
        set(a.segment.id, "shown", cause);
        break;
      case "hold":
        o.held.add(a.segment.id);
        set(a.segment.id, "held", cause);
        break;
      case "release":
        for (const s of a.segments) {
          o.released.add(s.id);
          o.releasedBy.set(s.id, cause);
          set(s.id, "shown", cause);
        }
        break;
      case "suppress":
        set(a.segment.id, "suppressed", cause);
        break;
      case "event-start":
        o.events.push({
          type: a.event,
          cause,
          t: 0,
          hideSince: a.hideFormulaBlocksSinceMs,
          provisional: a.provisional === true,
          first: a.discarded[0]?.id ?? null,
        });
        for (const s of a.discarded) set(s.id, "discarded", cause);
        break;
      case "event-change":
        o.changes.push(`${a.from}>${a.to}`);
        break;
      case "event-retract":
        o.retracts.push(a.event);
        for (const s of a.released) {
          o.released.add(s.id);
          o.releasedBy.set(s.id, cause);
          set(s.id, "shown", cause);
        }
        break;
      case "event-end":
        o.eventEnds.push(a.event);
        break;
      case "mode":
        o.lastModeAction = a.mode;
        break;
    }
  }
  let i = 0;
  for (const { t, action } of log) {
    if (action.type !== "event-start") continue;
    const ev = o.events[i++];
    if (ev !== undefined) ev.t = t;
  }
  return o;
}

/** Time from a call's first fragment (speech start) to its card, in ms (null: no fragment). */
function cardDelay(ev: CardEvent, r: Replay): number | null {
  if (ev.first === null || ev.cause === "override") return null;
  const start = r.segStart.get(ev.first);
  return start === undefined ? null : ev.t - BASE - start;
}

const fmtList = (xs: Iterable<string>): string => `[${[...xs].join(", ")}]`;
const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

function checkScenario(sc: Scenario, r: Replay): string[] {
  const o = outcome(r.log);
  const e = sc.expect;
  const fails: string[] = [...o.violations];
  const listCheck = (what: string, want: readonly string[] | undefined, got: readonly string[]) => {
    if (want !== undefined && !sameList(want, got)) {
      fails.push(`${what}: expected ${fmtList(want)}, got ${fmtList(got)}`);
    }
  };
  const setCheck = (what: string, want: readonly string[] | undefined, got: Iterable<string>) => {
    if (want !== undefined && !sameSet(want, got)) {
      fails.push(`${what}: expected ${fmtList([...want].sort())}, got ${fmtList([...got].sort())}`);
    }
  };
  const finalIds = (d: Disposition): string[] =>
    [...o.final.entries()].filter(([, v]) => v === d).map(([k]) => k);
  listCheck(
    "events",
    e.events,
    o.events.map((x) => x.type),
  );
  listCheck(
    "eventCauses",
    e.eventCauses,
    o.events.map((x) => x.cause),
  );
  if (e.provisional !== undefined) {
    const got = o.events.map((x) => x.provisional);
    if (got.length !== e.provisional.length || got.some((p, i) => p !== e.provisional?.[i])) {
      fails.push(`provisional: expected [${e.provisional.join(", ")}], got [${got.join(", ")}]`);
    }
  }
  listCheck("changes", e.changes, o.changes);
  listCheck("retracts", e.retracts, o.retracts);
  listCheck("eventEnds", e.eventEnds, o.eventEnds);
  listCheck("shown", e.shown, o.shown);
  setCheck("held", e.held, o.held);
  setCheck("released", e.released, o.released);
  setCheck("discarded", e.discarded, finalIds("discarded"));
  setCheck("suppressed", e.suppressed, finalIds("suppressed"));
  for (const [id, by] of Object.entries(e.releasedBy ?? {})) {
    const got = o.releasedBy.get(id) ?? "(not released)";
    if (got !== by) fails.push(`releasedBy ${id}: expected ${by}, got ${got}`);
  }
  const first = o.events[0];
  if (e.cardWithinMs !== undefined) {
    const delay = first === undefined ? null : cardDelay(first, r);
    if (delay === null || delay > e.cardWithinMs) {
      fails.push(`card: expected within ${e.cardWithinMs} ms of the first fragment, got ${delay}`);
    }
  }
  if (r.finalMode !== e.finalMode) {
    fails.push(`finalMode: expected ${e.finalMode}, got ${r.finalMode}`);
  }
  if (o.lastModeAction !== null && o.lastModeAction !== r.finalMode) {
    fails.push(`last mode action ${o.lastModeAction} disagrees with detector.mode ${r.finalMode}`);
  }
  for (const [id, mode] of Object.entries(e.modeAfter ?? {})) {
    const got = r.modeAfter.get(id);
    if (got !== mode)
      fails.push(`mode after ${id}: expected ${mode}, got ${got ?? "(no segment)"}`);
  }
  for (const [id, salah] of Object.entries(e.salahAfter ?? {})) {
    const got = r.salahAfter.get(id);
    if (got !== salah) fails.push(`salah after ${id}: expected ${salah}, got ${String(got)}`);
  }
  for (const id of e.hideCovers ?? []) {
    const at = r.segAt.get(id);
    const ev = at === undefined ? undefined : o.events.find((x) => x.hideSince <= at);
    if (ev === undefined) fails.push(`hideCovers ${id}: no event-start hides blocks from ${id}`);
  }
  for (const [id, want] of Object.entries(e.markers ?? {})) {
    const got = markers(r.texts.get(id) ?? "");
    if (!sameSet(want, got)) {
      fails.push(`markers ${id}: expected ${fmtList(want)}, got ${fmtList(got)}`);
    }
  }
  for (const [id, want] of Object.entries(e.formulaOnly ?? {})) {
    const text = r.texts.get(id) ?? "";
    const got = analyzeFormulas(text).formulaOnly;
    if (got !== want) {
      fails.push(
        `formulaOnly ${id}: expected ${want}, got ${got} (share ${formulaShare(text).toFixed(2)})`,
      );
    }
  }
  // Invariant: every segment ends up shown, discarded or suppressed (or is still held when the
  // scenario ends in mode "held").
  for (const id of r.segAt.keys()) {
    const d = o.final.get(id);
    if (d === undefined) fails.push(`invariant: ${id} got no disposition`);
    else if (d === "held" && r.finalMode !== "held") fails.push(`invariant: ${id} is still held`);
  }
  return fails;
}

function describe(a: DetectorAction): string {
  switch (a.type) {
    case "pass":
    case "hold":
    case "suppress":
      return `${a.type} ${a.segment.id}`;
    case "release":
      return `release ${fmtList(a.segments.map((s) => s.id))}`;
    case "event-start": {
      const since = ((a.hideFormulaBlocksSinceMs - BASE) / 1000).toFixed(1);
      const kind = a.provisional === true ? " (provisional)" : "";
      return `event-start ${a.event}${kind} discarded=${fmtList(a.discarded.map((s) => s.id))} hideSince=${since}s`;
    }
    case "event-change":
      return `event-change ${a.from} → ${a.to}`;
    case "event-retract":
      return `event-retract ${a.event} released=${fmtList(a.released.map((s) => s.id))}`;
    case "event-end":
      return `event-end ${a.event}`;
    case "mode":
      return `mode ${a.mode}`;
  }
}

function trace(r: Replay): string[] {
  const lines: string[] = [];
  let key = "";
  let parts: string[] = [];
  const flush = (): void => {
    if (parts.length > 0) lines.push(`      ${key}  ${parts.join("; ")}`);
    parts = [];
  };
  for (const entry of r.log) {
    const k = `+${((entry.t - BASE) / 1000).toFixed(1).padStart(6)}s ${entry.cause.padEnd(8)}`;
    if (k !== key) {
      flush();
      key = k;
    }
    parts.push(describe(entry.action));
  }
  flush();
  return lines;
}

function runPhraseList(list: PhraseList): string[] {
  const fails: string[] = [];
  for (const p of list.phrases) {
    const got = markers(p.text);
    const a = analyzeFormulas(p.text);
    if (!sameSet(p.markers, got) || a.formulaOnly !== p.formulaOnly) {
      fails.push(
        `"${p.text}": expected ${fmtList(p.markers)} formulaOnly=${p.formulaOnly}, got ${fmtList(got)} formulaOnly=${a.formulaOnly} (share ${a.share.toFixed(2)})`,
      );
    }
  }
  return fails;
}

function summary(r: Replay): string {
  const o = outcome(r.log);
  const events = o.events.map((x) => {
    const delay = cardDelay(x, r);
    const card = delay === null ? "" : ` card +${(delay / 1000).toFixed(1)}s`;
    return `${x.type}${x.provisional ? "?" : ""}(${x.cause}${card})`;
  });
  const extra = [...o.changes.map((c) => `change ${c}`), ...o.retracts.map((x) => `retract ${x}`)];
  const finals = [...o.final.values()];
  const n = (d: Disposition): number => finals.filter((x) => x === d).length;
  return `events: ${[...events, ...extra].join(" ") || "none"} · shown ${o.shown.length} · held ${o.held.size} · released ${o.released.size} · discarded ${n("discarded")} · suppressed ${n("suppressed")} · final ${r.finalMode}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const filter = args.find((a) => !a.startsWith("--")) ?? "";
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json") && f.includes(filter))
    .sort();
  let failed = 0;
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    const asList = PhraseList.safeParse(raw);
    if (asList.success) {
      const fails = runPhraseList(asList.data);
      const n = asList.data.phrases.length;
      console.log(
        `${fails.length === 0 ? "PASS" : "FAIL"}  ${asList.data.name}: ${n - fails.length}/${n} phrases`,
      );
      for (const f of fails) console.log(`      ✗ ${f}`);
      if (fails.length > 0) failed++;
      continue;
    }
    const sc = Scenario.safeParse(raw);
    if (!sc.success) {
      console.log(`FAIL  ${file}: invalid fixture: ${sc.error.message}`);
      failed++;
      continue;
    }
    const r = replay(sc.data);
    const fails = checkScenario(sc.data, r);
    console.log(`${fails.length === 0 ? "PASS" : "FAIL"}  ${sc.data.name}: ${summary(r)}`);
    for (const f of fails) console.log(`      ✗ ${f}`);
    if (fails.length > 0 || verbose) for (const line of trace(r)) console.log(line);
    if (fails.length > 0) failed++;
  }
  console.log(
    failed === 0
      ? `\nall ${files.length} fixtures pass`
      : `\n${failed} of ${files.length} fixtures FAIL`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
