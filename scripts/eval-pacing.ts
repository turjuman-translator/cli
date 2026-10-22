// Calm versus live caption blocks on the recorded Soniox sessions (test/fixtures/soniox-*.jsonl),
// in simulated time. Each recording runs through the real pipeline twice: the fake provider
// replays it into a local session (fast blocks, plus the pacer when calm), with the Quran
// follower when the Quran data is in DATA_DIR (default: ./data). No network, no audio.
//   pnpm exec tsx scripts/eval-pacing.ts [--loop 5] [--verbose]
// --loop n: the longest recording is also replayed n times in a row, as a longer session.
// --verbose: every calm step with its text.
// Per run: visible changes per minute of speech (new blocks, and text that grows or changes), the
// gaps between steps (moments in which blocks appear), the delay from the end of the speech to
// the moment its text is complete on screen, the words per block, and the Quran blocks with their
// delay against the live run. What a stop shows at once is left out. The recordings hold no
// verse, so a khutbah passage with 3:102 recited in it also runs through fast blocks and the
// Quran follower: when fast blocks verified the verse, and when the screen showed it.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { createBlocksDeps } from "../src/cli/run.js";
import { FastBlocks } from "../src/compose/fast-blocks.js";
import { Pacer } from "../src/compose/pacer.js";
import type { EventLabels, PipelineOutput, QuranFollowerApi } from "../src/compose/types.js";
import { type LoadedConfig, parseConfig } from "../src/config.js";
import { createEngineFactory } from "../src/core/engines.js";
import { type SessionBlocksDeps, SessionManager } from "../src/core/sessions.js";
import { SilentAudioInput } from "../src/core/silent-input.js";
import { loadLanguages } from "../src/languages.js";
import { resolveIn } from "../src/paths.js";
import { createQuranFollower } from "../src/quran/follower.js";
import type { Block, CaptionPace, Segment, ServerMessage } from "../src/shared/protocol.js";
import { readRecording } from "../src/stt/recording.js";

const REPO = join(import.meta.dirname, "..");
const FIXTURES = join(REPO, "test", "fixtures");
const START = Date.UTC(2026, 9, 9, 11, 0, 0);

// --- simulated time --------------------------------------------------------------------------

interface Timer {
  at: number;
  fn: () => void;
  every: number | null;
}

/** setTimeout, setInterval and Date.now on a clock that only moves when told to. */
class SimClock {
  now = START;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();
  private readonly realImmediate = globalThis.setImmediate;

  install(): void {
    const handle = (id: number) => ({
      id,
      unref() {
        return this;
      },
      ref() {
        return this;
      },
      hasRef: () => true,
      refresh() {
        return this;
      },
      [Symbol.toPrimitive]: () => id,
    });
    const add = (fn: () => void, ms: number | undefined, repeat: boolean) => {
      const id = ++this.seq;
      const wait = Math.max(0, Number(ms) || 0);
      this.timers.set(id, { at: this.now + wait, fn, every: repeat ? Math.max(1, wait) : null });
      return handle(id);
    };
    const clear = (h: unknown): void => {
      const id = typeof h === "object" && h !== null ? (h as { id: number }).id : Number(h);
      this.timers.delete(id);
    };
    const g = globalThis as Record<string, unknown>;
    g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      add(() => fn(...args), ms, false);
    g.setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      add(() => fn(...args), ms, true);
    g.clearTimeout = clear;
    g.clearInterval = clear;
    Date.now = () => this.now;
  }

  reset(): void {
    this.timers.clear();
    this.now = START;
  }

  /** Run every timer due until `until`, in time order, letting promises settle in between. */
  async runUntil(until: number): Promise<void> {
    for (;;) {
      let next: [number, Timer] | null = null;
      for (const e of this.timers) {
        if (next === null || e[1].at < next[1].at) next = e;
      }
      if (next === null || next[1].at > until) break;
      const [id, t] = next;
      this.now = Math.max(this.now, t.at);
      if (t.every === null) this.timers.delete(id);
      else t.at += t.every;
      t.fn();
      await this.settle();
    }
    this.now = Math.max(this.now, until);
    await this.settle();
  }

  private settle(): Promise<void> {
    return new Promise((resolve) => this.realImmediate(resolve));
  }
}

// --- one run ----------------------------------------------------------------------------------

interface Seen {
  t: number;
  m: ServerMessage;
}

interface Run {
  name: string;
  pace: CaptionPace;
  startedAt: number;
  seen: Seen[];
  /** When the session was asked to stop (what it shows then is not measured). */
  stopAt: number;
}

function loadedFor(dataDir: string, transcripts: string, pace: CaptionPace): LoadedConfig {
  const parsed = parseConfig(
    {
      audio: { monitorWhenIdle: false },
      session: { autoStopAfterSilenceMin: 600, maxDurationMin: 600 },
      captions: { pace },
    },
    { inContainer: false, bindAddress: null },
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  const config = parsed.config;
  return {
    config,
    paths: {
      configDir: REPO,
      dataDir,
      configFile: null,
      languagesFile: join(REPO, "languages.yaml"),
      glossariesDir: join(REPO, "glossaries"),
      keysFile: join(transcripts, "keys.yaml"),
      usersFile: join(transcripts, "users.yaml"),
      screensFile: join(transcripts, "screens.yaml"),
      secretFile: join(transcripts, "secret.key"),
      orgsFile: join(transcripts, "orgs.yaml"),
      masterKeyFile: join(transcripts, "master.key"),
      tlsCertFile: join(transcripts, "server.crt"),
      tlsKeyFile: join(transcripts, "server.key"),
      tlsCaFile: join(transcripts, "ca.crt"),
      transcriptsDir: transcripts,
      recordingsDir: join(transcripts, "recordings"),
      benchDir: join(transcripts, "bench"),
      stateDir: join(transcripts, "state"),
      usageDir: join(transcripts, "usage"),
      presetsFile: join(transcripts, "presets.yaml"),
      quranDir: join(dataDir, "quran"),
      quranTextFile: resolveIn(dataDir, config.quran.textFile),
      quranUthmaniFile: resolveIn(dataDir, config.quran.uthmaniFile),
      quranTranslations: Object.fromEntries(
        Object.entries(config.quran.translations).map(([l, f]) => [l, resolveIn(dataDir, f)]),
      ),
      exportsDir: join(transcripts, "exports"),
    },
    secrets: { sonioxApiKey: "eval" },
    warnings: [],
    context: { inContainer: false, bindAddress: null },
  };
}

async function run(
  clock: SimClock,
  file: string,
  name: string,
  pace: CaptionPace,
  loops: number,
  deps: { dataDir: string; blocks: SessionBlocksDeps },
): Promise<Run> {
  clock.reset();
  const tmp = mkdtempSync(join(tmpdir(), "eval-pacing-"));
  try {
    const loaded = loadedFor(deps.dataDir, tmp, pace);
    const log = pino({ level: "silent" });
    const manager = new SessionManager({
      loaded,
      engineFactory: createEngineFactory({
        loaded,
        log,
        languages: loadLanguages(loaded.paths.languagesFile),
        fakeProviderFile: file,
        fakeSpeed: 1,
        fakeLoop: loops > 1,
      }),
      audioInputFactory: () => new SilentAudioInput(),
      log,
      version: "eval",
      blocks: deps.blocks,
    });
    let started: { ok: boolean; message: string } | null = null;
    void manager.startLocal({ source: "file", file: "/eval/khutbah.wav" }).then((r) => {
      started = r;
    });
    for (let i = 0; i < 200 && started === null; i++) await clock.runUntil(clock.now + 100);
    if (started === null) throw new Error(`${name}: the session did not start`);
    const session = manager.local();
    const result: { ok: boolean; message: string } = started;
    if (!result.ok || session === null) throw new Error(`${name}: ${result.message}`);
    const seen: Seen[] = [];
    session.subscribe((m) => seen.push({ t: Date.now(), m }));
    const lines = readRecording(file).lines;
    const length = lines[lines.length - 1]?.t ?? 0;
    await clock.runUntil(clock.now + length * loops + 30_000);
    const stopAt = clock.now;
    const stopping = manager.stopAll("eval done");
    await clock.runUntil(clock.now + 15_000);
    await stopping;
    return { name, pace, startedAt: session.info().startedAt, seen, stopAt };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- measures ---------------------------------------------------------------------------------

interface Measures {
  minutes: number;
  changesPerMin: number;
  steps: number[];
  gaps: number[];
  lags: number[];
  words: number[];
  quran: Array<{ ref: string; at: number }>;
}

function measure(r: Run): Measures {
  const seen = r.seen.filter((s) => s.t < r.stopAt);
  const segments = seen.flatMap((s) => (s.m.type === "segment" ? [s.m.segment] : []));
  const starts = segments.flatMap((s) => (s.startMs === null ? [] : [s.startMs]));
  const ends = segments.flatMap((s) => (s.endMs === null ? [] : [s.endMs]));
  const minutes = (Math.max(...ends) - Math.min(...starts)) / 60_000;
  const last = new Map<string, Block>();
  const history = new Map<string, Array<{ t: number; b: Block }>>();
  const steps: number[] = [];
  const quran: Measures["quran"] = [];
  let changes = 0;
  for (const { t, m } of seen) {
    if (m.type !== "block.add" && m.type !== "block.update") continue;
    const b = m.block;
    const prev = last.get(b.id);
    if (m.type === "block.add" && b.hidden !== true) {
      changes++;
      if (steps.at(-1) !== t) steps.push(t);
      if (b.kind === "quran" && b.ref !== null) quran.push({ ref: b.ref, at: t });
    } else if (
      m.type === "block.update" &&
      b.kind !== "event" &&
      b.hidden !== true &&
      prev !== undefined &&
      prev.text !== b.text
    ) {
      changes++;
    }
    last.set(b.id, b);
    history.set(b.id, [...(history.get(b.id) ?? []), { t, b }]);
  }
  const lags: number[] = [];
  const words: number[] = [];
  for (const [id, b] of last) {
    if (b.kind === "event" || b.hidden === true || b.text.trim() === "") continue;
    if (b.kind !== "quran") words.push(b.text.trim().split(/\s+/).length);
    if (typeof b.endMs !== "number") continue;
    const complete = history.get(id)?.find((h) => h.b.text === b.text);
    if (complete !== undefined) lags.push(complete.t - (r.startedAt + b.endMs));
  }
  return {
    minutes,
    changesPerMin: changes / minutes,
    steps,
    gaps: steps.slice(1).map((s, i) => s - (steps[i] as number)),
    lags,
    words,
    quran,
  };
}

/** Delays of the calm run's verses against the live run's (matched by ref, in order). */
function quranDelays(live: Measures, calm: Measures): number[] {
  const byRef = new Map<string, number[]>();
  for (const q of live.quran) byRef.set(q.ref, [...(byRef.get(q.ref) ?? []), q.at]);
  const out: number[] = [];
  for (const q of calm.quran) {
    const at = byRef.get(q.ref)?.shift();
    if (at !== undefined) out.push(q.at - at);
  }
  return out;
}

// --- a recited verse ---------------------------------------------------------------------------

/** A khutbah passage: speech, the cue, 3:102 recited more slowly, speech again. */
const PASSAGE: ReadonlyArray<{ ar: string; nl: string; msPerWord: number; pauseMs: number }> = [
  {
    ar: "أيها الناس اتقوا ربكم واعلموا أن الدنيا دار ممر وليست دار مقر",
    nl: "O mensen, vrees jullie Heer en weet dat deze wereld een doorgang is en geen verblijf.",
    msPerWord: 400,
    pauseMs: 1200,
  },
  { ar: "قال الله تعالى", nl: "Allah de Verhevene zegt:", msPerWord: 400, pauseMs: 1000 },
  {
    ar: "يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون",
    nl: "O jullie die geloven, vrees Allah zoals Hij gevreesd moet worden, en sterf niet anders dan als moslims.",
    msPerWord: 550,
    pauseMs: 1200,
  },
  {
    ar: "فاتقوا الله عباد الله وأطيعوه في السر والعلن",
    nl: "Vrees dus Allah, dienaren van Allah, en gehoorzaam Hem in het verborgene en in het openbaar.",
    msPerWord: 400,
    pauseMs: 1500,
  },
];

function segment(
  n: number,
  ar: string,
  nl: string,
  closed: boolean,
  startMs: number,
  endMs: number,
): Segment {
  return {
    id: `q:soniox:${n}`,
    sessionId: "q",
    track: "soniox",
    seq: n,
    kind: "speech",
    startMs,
    endMs,
    source: { lang: "ar", text: ar, finalLen: ar.length, final: closed },
    translations: { nl: { text: nl, finalLen: nl.length, final: closed } },
    closed,
    timing: { source: "provider", firstTokenAt: 0 },
  };
}

/** When fast blocks verified each verse, and when the screen showed it. */
async function quranCase(
  clock: SimClock,
  follower: QuranFollowerApi,
  labels: EventLabels,
  pace: CaptionPace,
): Promise<{ refs: string[]; verified: number[]; shown: number[] }> {
  clock.reset();
  const out = { refs: [] as string[], verified: [] as number[], shown: [] as number[] };
  const log = pino({ level: "silent" });
  const isVerse = (o: PipelineOutput): o is Extract<PipelineOutput, { type: "block.add" }> =>
    o.type === "block.add" && o.block.kind === "quran";
  const tap =
    (emit: (o: PipelineOutput) => void) =>
    (o: PipelineOutput): void => {
      if (isVerse(o)) out.verified.push(Date.now());
      emit(o);
    };
  const screen = (o: PipelineOutput): void => {
    if (!isVerse(o)) return;
    out.shown.push(Date.now());
    out.refs.push(o.block.ref ?? "");
  };
  const base = {
    sessionId: "q",
    targetLang: "nl",
    follower,
    detector: null,
    labels,
    now: () => Date.now(),
    log,
  };
  const pipeline =
    pace === "live"
      ? new FastBlocks({ ...base, emit: tap(screen) })
      : new Pacer({
          sessionId: "q",
          log,
          emit: screen,
          inner: (hooks) =>
            new FastBlocks({ ...base, emit: tap(hooks.emit), closed: hooks.closed }),
        });
  let t = 0;
  for (const [i, part] of PASSAGE.entries()) {
    const ar = part.ar.split(" ");
    const nl = part.nl.split(" ");
    const startMs = t;
    for (let n = 1; n <= ar.length; n++) {
      await clock.runUntil(clock.now + part.msPerWord);
      t += part.msPerWord;
      const tr = nl.slice(0, Math.round((n / ar.length) * nl.length)).join(" ");
      pipeline.update(segment(i + 1, ar.slice(0, n).join(" "), tr, n === ar.length, startMs, t));
    }
    await clock.runUntil(clock.now + part.pauseMs);
    t += part.pauseMs;
  }
  await clock.runUntil(clock.now + 30_000);
  pipeline.close();
  return out;
}

// --- report -------------------------------------------------------------------------------------

function pct(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? null;
}

const sec = (ms: number | null): string => (ms === null ? "-" : (ms / 1000).toFixed(1));
const num = (n: number | null): string => (n === null ? "-" : String(n));

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
}

const HEAD = [
  "recording",
  "pace",
  "speech min",
  "changes/min",
  "steps",
  "gap s min/med/max",
  "lag s med/p95",
  "words med/max",
  "quran n, delay s med/max",
];
const WIDTHS = [26, 5, 10, 11, 5, 17, 13, 13, 24];

function line(name: string, pace: CaptionPace, m: Measures, quran: number[] | null): string {
  return row(
    [
      name,
      pace,
      m.minutes.toFixed(1),
      m.changesPerMin.toFixed(1),
      String(m.steps.length),
      `${sec(pct(m.gaps, 0))}/${sec(pct(m.gaps, 0.5))}/${sec(pct(m.gaps, 1))}`,
      `${sec(pct(m.lags, 0.5))}/${sec(pct(m.lags, 0.95))}`,
      `${num(pct(m.words, 0.5))}/${num(pct(m.words, 1))}`,
      quran === null
        ? `${m.quran.length}`
        : `${quran.length}, ${sec(pct(quran, 0.5))}/${sec(pct(quran, 1))}`,
    ],
    WIDTHS,
  );
}

function pooled(all: readonly Measures[]): Measures {
  const minutes = all.reduce((n, m) => n + m.minutes, 0);
  return {
    minutes,
    changesPerMin: all.reduce((n, m) => n + m.changesPerMin * m.minutes, 0) / minutes,
    steps: all.flatMap((m) => m.steps),
    gaps: all.flatMap((m) => m.gaps),
    lags: all.flatMap((m) => m.lags),
    words: all.flatMap((m) => m.words),
    quran: all.flatMap((m) => m.quran),
  };
}

function printSteps(r: Run): void {
  let prev: number | null = null;
  for (const { t, m } of r.seen) {
    if (t >= r.stopAt) break;
    if (m.type !== "block.add" || m.block.hidden === true) continue;
    const gap = prev === null || t === prev ? "" : ` (+${sec(t - prev)} s)`;
    prev = t;
    const words = m.block.text.trim() === "" ? 0 : m.block.text.trim().split(/\s+/).length;
    console.log(
      `   ${sec(t - r.startedAt).padStart(6)} s${gap.padEnd(11)} ${m.block.kind.padEnd(6)} ${String(words).padStart(3)} w  ${m.block.text.slice(0, 90)}`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { loop: { type: "string", default: "5" }, verbose: { type: "boolean" } },
  });
  const loops = Math.max(1, Math.round(Number(values.loop) || 1));
  const dataDir = process.env.DATA_DIR ?? join(REPO, "data");
  const quiet = pino({ level: "silent" });
  const base = loadedFor(dataDir, tmpdir(), "calm");
  const blocks = createBlocksDeps(base, quiet, null).deps;
  const follow = (): QuranFollowerApi =>
    blocks.followerFactory?.("nl") ?? createQuranFollower(null, { targetLang: "nl" });
  const files = readdirSync(FIXTURES)
    .filter((f) => /^soniox-.*\.jsonl$/.test(f))
    .sort()
    .map((f) => join(FIXTURES, f));
  const clock = new SimClock();
  clock.install();
  const cases: Array<{ name: string; file: string; loops: number }> = files.map((file) => ({
    name: basename(file, ".jsonl"),
    file,
    loops: 1,
  }));
  if (loops > 1 && files.length > 0) {
    const longest = files
      .map((file) => ({ file, t: readRecording(file).lines.at(-1)?.t ?? 0 }))
      .sort((a, b) => b.t - a.t)[0];
    if (longest !== undefined) {
      cases.push({
        name: `${basename(longest.file, ".jsonl")} x${loops}`,
        file: longest.file,
        loops,
      });
    }
  }
  console.log(`Quran data: ${dataDir}`);
  console.log(row(HEAD, WIDTHS));
  const lives: Measures[] = [];
  const calms: Measures[] = [];
  const delays: number[] = [];
  const verbose: Run[] = [];
  for (const c of cases) {
    const live = measure(await run(clock, c.file, c.name, "live", c.loops, { dataDir, blocks }));
    const calmRun = await run(clock, c.file, c.name, "calm", c.loops, { dataDir, blocks });
    const calm = measure(calmRun);
    const d = quranDelays(live, calm);
    console.log(line(c.name, "live", live, null));
    console.log(line(c.name, "calm", calm, d));
    if (c.loops === 1) {
      lives.push(live);
      calms.push(calm);
      delays.push(...d);
    }
    if (values.verbose === true) verbose.push(calmRun);
  }
  if (lives.length > 1) {
    console.log(line("all recordings once", "live", pooled(lives), null));
    console.log(line("all recordings once", "calm", pooled(calms), delays));
  }
  console.log("\nQuran: 3:102 recited inside a khutbah passage (fast blocks, the Quran follower)");
  if (!follow().ready) {
    console.log(`   skipped: no Quran data in ${dataDir}`);
  } else {
    const labels = base.config.events.labels.nl as EventLabels;
    for (const pace of ["live", "calm"] as const) {
      const q = await quranCase(clock, follow(), labels, pace);
      const delays = q.shown.map((at, i) => at - (q.verified[i] ?? at));
      console.log(
        `   ${pace}: ${q.refs.join(", ") || "no verse"}, verified at ${q.verified.map((v) => `${sec(v - START)} s`).join(", ")}, shown ${delays.map((d) => `${sec(d)} s`).join(", ")} later`,
      );
    }
  }
  for (const r of verbose) {
    console.log(`\n${r.name}, calm steps:`);
    printSteps(r);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
