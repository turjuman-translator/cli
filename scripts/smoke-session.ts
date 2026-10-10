// Smoke test for the session layer (no network, no ffmpeg):
//   pnpm exec tsx scripts/smoke-session.ts
// Builds a SessionManager with a scripted fake Soniox provider and a fake audio input, then runs:
// a page session (speech → tokens → endpoint → silence close → reopen), a page session in the
// blocks layout (fast blocks), a local file session, the missing-key error and /health.
// Transcripts go to a temp DATA_DIR that is printed (and kept) at the end.

import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pino } from "pino";
import { FrameTimeline } from "../src/audio/timeline.js";
import { type LoadedConfig, parseConfig } from "../src/config.js";
import type {
  AudioInputApi,
  AudioInputHandlers,
  AudioInputSpec,
  CaptionSessionApi,
  EngineFactory,
  EngineRequest,
} from "../src/core/contracts.js";
import { SessionError } from "../src/core/contracts.js";
import { SegmentStore } from "../src/core/segments.js";
import { SessionManager } from "../src/core/sessions.js";
import type {
  DetectorAction,
  DetectorSegment,
  EventDetectorApi,
  MarkerId,
} from "../src/events/types.js";
import type {
  AudioState,
  PrayerEvent,
  ProviderState,
  Segment,
  ServerMessage,
  SessionMode,
  Status,
  TrackId,
} from "../src/shared/protocol.js";
import type { ProviderCapabilities, ProviderEvent, SttProvider, Token } from "../src/stt/types.js";
import { normalizeArabic } from "../src/text/arabic.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FRAME_BYTES = 3200;

// --- checks ------------------------------------------------------------------------------------

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
}

// --- fake engine ---------------------------------------------------------------------------------

interface Utterance {
  source: string[];
  translation: string[];
}

const SCRIPT: Utterance[] = [
  {
    source: ["الحمد", "لله", "رب", "العالمين"],
    translation: ["Alle", "lof", "is", "voor", "Allah,", "de", "Heer", "der", "werelden"],
  },
  {
    source: ["أيها", "المسلمون", "اتقوا", "الله"],
    translation: ["O", "moslims,", "vrees", "Allah"],
  },
  { source: ["آمين"], translation: [] },
];

/**
 * Emits one more final word every `framesPerWord` frames (plus the next word as non-final),
 * then an endpoint when the utterance is complete. Soniox flavour: provider timing and native
 * translation tokens following their source tokens.
 */
class ScriptedProvider implements SttProvider {
  readonly capabilities: ProviderCapabilities;
  framesReceived = 0;
  finalizeCalls = 0;
  stopCalls = 0;
  private current: ProviderState = "idle";
  private onEvent: ((e: ProviderEvent) => void) | null = null;
  /** Current utterance, words recognized in it, and what was already sent as final. */
  private utt = 0;
  private words = 0;
  private sentFinal = 0;
  private sentTr = 0;
  private framesInUtt = 0;
  private uttStartFrame = 0;

  constructor(
    readonly track: TrackId,
    readonly name: string,
    private readonly script: readonly Utterance[],
    private readonly opts: { native: boolean; finalAtEndpoint: boolean; framesPerWord: number },
  ) {
    this.capabilities = {
      nativeTranslation: opts.native,
      timing: "provider",
      translationFinalAtEndpoint: opts.finalAtEndpoint,
    };
  }

  get state(): ProviderState {
    return this.current;
  }

  async start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    this.onEvent = opts.onEvent;
    this.setState("connecting");
    await sleep(40);
    if (this.current === "connecting") this.setState("live");
  }

  sendAudio(frame: Uint8Array): void {
    if (frame.byteLength !== FRAME_BYTES) throw new Error("bad frame size");
    this.framesReceived++;
    const utt = this.script[this.utt];
    if (utt === undefined) return;
    if (this.framesInUtt === 0) this.uttStartFrame = this.framesReceived - 1;
    this.framesInUtt++;
    if (this.framesInUtt % this.opts.framesPerWord !== 0) return;
    this.words++;
    if (this.words >= utt.source.length) this.finish();
    else this.emit(utt, false);
  }

  finalize(): void {
    this.finalizeCalls++;
    if (this.framesInUtt > 0) this.finish();
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.framesInUtt > 0) this.finish();
    await sleep(20);
    this.setState("idle");
  }

  private setState(state: ProviderState): void {
    this.current = state;
    this.onEvent?.({ type: "state", state });
  }

  /** The utterance is complete (or force-finalized): last finals + translation, endpoint. */
  private finish(): void {
    const utt = this.script[this.utt];
    if (utt === undefined) return;
    this.words = utt.source.length;
    this.emit(utt, true);
    this.onEvent?.({ type: "endpoint", receivedAt: Date.now() });
    this.utt++;
    this.words = 0;
    this.sentFinal = 0;
    this.sentTr = 0;
    this.framesInUtt = 0;
  }

  private emit(utt: Utterance, done: boolean): void {
    const receivedAt = Date.now();
    const wordMs = this.opts.framesPerWord * 100;
    const startOf = (w: number): number => (this.uttStartFrame + w * this.opts.framesPerWord) * 100;
    const word = (w: number): Token => ({
      text: w === 0 ? (utt.source[w] ?? "") : ` ${utt.source[w] ?? ""}`,
      kind: "source",
      lang: "ar",
      startMs: startOf(w),
      endMs: startOf(w) + wordMs - 50,
    });
    const final: Token[] = [];
    for (; this.sentFinal < this.words; this.sentFinal++) final.push(word(this.sentFinal));
    if (this.opts.native) {
      // Translation lags its source: a proportional share now, the rest at the end.
      const share = done
        ? utt.translation.length
        : Math.floor((utt.translation.length * this.words) / (utt.source.length + 1));
      for (; this.sentTr < share; this.sentTr++) {
        const text = utt.translation[this.sentTr] ?? "";
        final.push({
          text: this.sentTr === 0 ? text : ` ${text}`,
          kind: "translation",
          lang: "nl",
        });
      }
    }
    const nonFinal: Token[] = [];
    if (!done && this.words < utt.source.length) {
      nonFinal.push(word(this.words));
      if (this.opts.native) nonFinal.push({ text: " …", kind: "translation", lang: "nl" });
    }
    this.onEvent?.({ type: "tokens", final, nonFinal, receivedAt });
  }
}

interface Created {
  req: EngineRequest;
  provider: ScriptedProvider;
}

function makeFactory(created: Created[], finalAtEndpoint: boolean): EngineFactory {
  return (req) => {
    const provider = new ScriptedProvider(req.track, `${req.track}-${created.length + 1}`, SCRIPT, {
      native: true,
      finalAtEndpoint,
      framesPerWord: 3,
    });
    created.push({ req, provider });
    return { provider };
  };
}

// --- fake audio input ----------------------------------------------------------------------------

function toneFrame(n: number, amplitude = 0.1): Uint8Array {
  const out = new Uint8Array(FRAME_BYTES);
  const view = new DataView(out.buffer);
  for (let i = 0; i < FRAME_BYTES / 2; i++) {
    const t = (n * 1600 + i) / 16_000;
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 440 * t) * amplitude * 32767), true);
  }
  return out;
}

class FakeInput implements AudioInputApi {
  private current: AudioState = "idle";
  private timer: NodeJS.Timeout | null = null;
  frames = 0;
  started = false;
  stopped = false;

  constructor(
    private readonly spec: AudioInputSpec,
    private readonly intervalMs: number,
    private readonly opts: { amplitude?: number; maxFrames?: number } = {},
  ) {}

  get state(): AudioState {
    return this.current;
  }

  get lastStderr(): string | null {
    return null;
  }

  start(handlers: AudioInputHandlers): void {
    this.started = true;
    this.current = "ok";
    handlers.onState?.("ok", { lastStderr: null });
    const maxFrames = this.opts.maxFrames ?? 400;
    this.timer = setInterval(() => {
      handlers.onFrame(toneFrame(this.frames++, this.opts.amplitude ?? 0.1), Date.now());
      if (this.spec.kind === "file" && !this.spec.loop && this.frames >= maxFrames) {
        void this.stop();
        this.current = "ended";
        handlers.onState?.("ended", { lastStderr: null });
        handlers.onEnded?.();
      }
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.current = "idle";
    this.stopped = true;
  }
}

// --- helpers ---------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function merge(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof b === "object" &&
      b !== null
        ? merge(b as Raw, v as Raw)
        : v;
  }
  return out;
}

const KEYS: LoadedConfig["secrets"] = { sonioxApiKey: "fake-soniox" };

function loadedConfig(
  dataDir: string,
  secrets: LoadedConfig["secrets"],
  over: Raw = {},
): LoadedConfig {
  const parsed = parseConfig(
    merge(
      {
        pages: { closeAfterSilenceSec: 2, resumeGraceSec: 1 },
        session: { autoStopAfterSilenceMin: 1, maxDurationMin: 5 },
        transcripts: { recordProviderMessages: true },
      },
      over,
    ),
    { inContainer: false, bindAddress: null },
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  const repo = process.cwd();
  return {
    config: parsed.config,
    paths: {
      configDir: repo,
      dataDir,
      configFile: null,
      languagesFile: join(repo, "languages.yaml"),
      glossariesDir: join(repo, "glossaries"),
      keysFile: join(dataDir, "keys.yaml"),
      usersFile: join(dataDir, "users.yaml"),
      screensFile: join(dataDir, "screens.yaml"),
      secretFile: join(dataDir, "secret.key"),
      orgsFile: join(dataDir, "orgs.yaml"),
      masterKeyFile: join(dataDir, "master.key"),
      tlsCertFile: join(dataDir, "tls", "server.crt"),
      tlsKeyFile: join(dataDir, "tls", "server.key"),
      tlsCaFile: join(dataDir, "tls", "ca.crt"),
      transcriptsDir: join(dataDir, "transcripts"),
      recordingsDir: join(dataDir, "recordings"),
      benchDir: join(dataDir, "bench"),
      stateDir: join(dataDir, "state"),
      usageDir: join(dataDir, "usage"),
      presetsFile: join(dataDir, "presets.yaml"),
      quranDir: join(dataDir, "quran"),
      quranTextFile: join(dataDir, "quran", "quran-simple-clean.txt"),
      quranUthmaniFile: join(dataDir, "quran", "quran-uthmani.txt"),
      quranTranslations: {},
      exportsDir: join(dataDir, "exports"),
    },
    secrets,
    warnings: [],
    context: { inContainer: false, bindAddress: null },
  };
}

function describe(msg: ServerMessage): string | null {
  switch (msg.type) {
    case "segment": {
      const s = msg.segment;
      const tr = s.translations.nl;
      const trText = tr === undefined ? "" : `${tr.text}${tr.final ? " ✓" : ""}`;
      return (
        `segment ${s.track}#${s.seq} ${s.closed ? "closed" : "open  "} ` +
        `[${s.startMs ?? "-"}–${s.endMs ?? "-"} ms] ar="${s.source.text}" (final ${s.source.finalLen}) ` +
        `nl="${trText}"`
      );
    }
    case "clear":
      return `clear ${msg.track}`;
    case "level":
      return null;
    case "status":
      return null;
    default:
      return msg.type;
  }
}

function statusLine(s: Status): string {
  const page = s.page === undefined ? "" : ` page=${JSON.stringify(s.page)}`;
  const tracks = s.tracks
    .map((t) => `${t.track}:${t.active ? "on" : "off"}/${t.provider}/$${t.costUsd}`)
    .join(" ");
  return `status state=${s.state} primary=${s.primary} provider=${s.provider} [${tracks}]${page}${s.error === undefined ? "" : ` error="${s.error}"`}`;
}

function watch(
  session: CaptionSessionApi,
  label: string,
): { statuses: Status[]; stop: () => void } {
  const statuses: Status[] = [];
  let lastLine = "";
  const stop = session.subscribe((msg) => {
    if (msg.type === "status") {
      statuses.push(msg.status);
      const line = statusLine(msg.status);
      if (line !== lastLine) console.log(`    [${label}] ${line}`);
      lastLine = line;
      return;
    }
    const line = describe(msg);
    if (line !== null) console.log(`    [${label}] ${line}`);
  });
  return { statuses, stop };
}

async function pushFrames(session: CaptionSessionApi, count: number, start: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    session.pushFrame(toneFrame(start + i));
    await sleep(100);
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function printTranscripts(root: string, sessionId: string): string | null {
  const transcripts = join(root, "transcripts");
  const folder = readdirSync(transcripts).find((d) => d.endsWith(`_${sessionId}`));
  if (folder === undefined) {
    console.log(`    (no transcripts folder for ${sessionId})`);
    return null;
  }
  const dir = join(transcripts, folder);
  console.log(`    transcripts/${folder}/`);
  for (const f of listFiles(dir)) {
    console.log(`      ${relative(dir, f)} (${statSync(f).size} B)`);
  }
  return dir;
}

// --- scenarios -----------------------------------------------------------------------------------

async function pageSoniox(dataDir: string): Promise<void> {
  console.log("\n== page session: soniox (translation final at endpoint) ==");
  const created: Created[] = [];
  const usage: Record<string, number> = {};
  const manager = new SessionManager({
    loaded: loadedConfig(dataDir, KEYS, { display: { layout: "rollup" } }),
    engineFactory: makeFactory(created, true),
    audioInputFactory: (spec) => new FakeInput(spec, 100),
    log: pino({ level: process.env.LOG_LEVEL ?? "warn" }),
    version: "smoke",
  });
  const session = manager.createPage({
    from: "ar",
    to: "nl",
    keyId: null,
    keyLabel: "smoke",
    client: { obs: false, ua: "smoke" },
    onUsage: (engine, ms) => {
      usage[engine] = (usage[engine] ?? 0) + ms;
    },
  });
  const w = watch(session, "page");
  check(created.length === 0, "no engine before the first speech (lazy open)");
  session.speech("start");
  check(created.length === 1, "speech start opens one engine");
  await pushFrames(session, 13, 0); // 4 words × 3 frames → endpoint at frame 12
  await sleep(250);
  const segs = session.snapshots()[0];
  const first = segs?.type === "snapshot" ? segs.segments[0] : undefined;
  check(first?.closed === true, "first utterance closed at its endpoint");
  check(
    first?.source.text === "الحمد لله رب العالمين",
    `source text assembled: "${first?.source.text}"`,
  );
  check(first?.translations.nl?.final === true, "native translation final at the endpoint");
  check(
    first?.translations.nl?.text === "Alle lof is voor Allah, de Heer der werelden",
    `translation assembled: "${first?.translations.nl?.text}"`,
  );
  check(
    first?.startMs !== null && first?.endMs !== null,
    `timing set: ${first?.startMs}–${first?.endMs} ms`,
  );
  check(session.status().page?.engineOpen === true, "engine stays open after the utterance");
  await pushFrames(session, 4, 13); // second utterance in progress
  session.speech("end");
  check(created[0]?.provider.finalizeCalls === 1, "speech end → provider.finalize()");
  await sleep(300);
  console.log("    … waiting closeAfterSilenceSec (2 s)");
  await sleep(2300);
  const st = session.status();
  check(st.page?.engineOpen === false, "engine closed after closeAfterSilenceSec of silence");
  check(created[0]?.provider.stopCalls === 1, "provider.stop() called once");
  check(
    (usage.soniox ?? 0) > 1500,
    `usage reported for the engine-open time: ${usage.soniox ?? 0} ms`,
  );
  session.speech("start");
  check(created.length === 2, "next speech opens a NEW engine instance");
  await pushFrames(session, 4, 17);
  session.speech("end");
  await sleep(300);
  check(created[1]?.provider.framesReceived === 4, "new engine got the frames after the reopen");
  const snap = session.snapshots()[0];
  const n = snap?.type === "snapshot" ? snap.segments.length : 0;
  check(n === 3, `three visible segments (two utterances + the reopened one): ${n}`);
  session.detach();
  session.attach();
  check(manager.get(session.id) === session, "detach + attach within the grace keeps the session");
  await session.stop("smoke done");
  check(session.status().state === "idle", "stopped session is idle");
  check(manager.get(session.id) === undefined, "stopped page session is removed from the registry");
  w.stop();
  const dir = printTranscripts(dataDir, session.id);
  if (dir !== null) {
    const srt = readFileSync(join(dir, "soniox", "ar.srt"), "utf8");
    const nl = readFileSync(join(dir, "soniox", "nl.srt"), "utf8");
    console.log("    --- soniox/ar.srt ---");
    console.log(srt.replace(/^/gm, "    "));
    console.log("    --- soniox/nl.srt ---");
    console.log(nl.replace(/^/gm, "    "));
    console.log("    --- session.log ---");
    console.log(readFileSync(join(dir, "session.log"), "utf8").replace(/^/gm, "    "));
    check(srt.includes("00:00:") && srt.includes(" --> "), "ar.srt has SRT timestamps");
    check(nl.includes("Alle lof is voor Allah"), "nl.srt has the translation");
    const jsonl = readFileSync(join(dir, "soniox", "segments.jsonl"), "utf8")
      .trim()
      .split("\n");
    check(jsonl.length === 3, `segments.jsonl has one line per done segment: ${jsonl.length}`);
  }
}

async function localFile(dataDir: string): Promise<void> {
  console.log("\n== local file session: soniox ==");
  const created: Created[] = [];
  const inputs: FakeInput[] = [];
  const manager = new SessionManager({
    loaded: loadedConfig(dataDir, KEYS, { display: { layout: "rollup" } }),
    engineFactory: makeFactory(created, true),
    audioInputFactory: (spec) => {
      const input = new FakeInput(spec, 100);
      inputs.push(input);
      return input;
    },
    log: pino({ level: process.env.LOG_LEVEL ?? "warn" }),
    version: "smoke",
  });
  const start = await manager.startLocal({ source: "file", file: "/fake/khutbah.wav" });
  check(start.ok, `startLocal: ${start.message}`);
  const local = manager.local();
  if (local === null) {
    check(false, "local session exists");
    return;
  }
  const w = watch(local, "local");
  const again = await manager.startLocal({ source: "file", file: "/fake/khutbah.wav" });
  check(!again.ok && again.message.startsWith("already live"), `second Start: ${again.message}`);
  await sleep(1800);
  const st = local.status();
  check(
    st.primary === "soniox" && st.tracks.length === 1 && st.tracks[0]?.active === true,
    "one track: soniox, active",
  );
  const snap = local.snapshots()[0];
  const seg = snap?.type === "snapshot" ? snap.segments[0] : undefined;
  check(
    seg?.source.text === "الحمد لله رب العالمين" && seg.translations.nl?.final === true,
    `local segment with Soniox's translation: "${seg?.translations.nl?.text}"`,
  );
  const health = manager.health();
  check(
    health.local?.state === "live" && health.sessions.length === 1,
    "health lists the live local session",
  );
  const stop = await manager.stopLocal("operator stop");
  check(stop.ok, `stopLocal: ${stop.message}`);
  check(local.status().state === "idle", "local session idle after stop");
  check(
    created.every((c) => c.provider.stopCalls >= 1),
    `every engine was stopped (${created.length} engines)`,
  );
  w.stop();
  const dir = printTranscripts(dataDir, local.id);
  if (dir !== null) {
    console.log("    --- session.jsonl markers ---");
    const markers = readFileSync(join(dir, "session.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { type: string }).type);
    console.log(`    ${markers.join(", ")}`);
    check(
      markers.includes("start") && markers.includes("engine-open") && markers.includes("stop"),
      "start, engine-open and stop markers written",
    );
  }
}

async function errors(dataDir: string): Promise<void> {
  console.log("\n== limits and errors ==");
  const manager = new SessionManager({
    loaded: loadedConfig(dataDir, KEYS),
    engineFactory: makeFactory([], true),
    audioInputFactory: (spec) => new FakeInput(spec, 100),
    log: pino({ level: "silent" }),
    version: "smoke",
  });
  const noKey = new SessionManager({
    loaded: loadedConfig(dataDir, { sonioxApiKey: null }),
    engineFactory: makeFactory([], true),
    audioInputFactory: (spec) => new FakeInput(spec, 100),
    log: pino({ level: "silent" }),
    version: "smoke",
  });
  const req = {
    from: "ar",
    to: "nl",
    keyId: null,
    keyLabel: null,
    client: { obs: false, ua: "smoke" },
  };
  const code = (fn: () => unknown): string => {
    try {
      fn();
      return "ok";
    } catch (err) {
      return err instanceof SessionError ? err.code : String(err);
    }
  };
  check(
    code(() => noKey.createPage(req)) === "engine_unavailable",
    "no SONIOX_API_KEY → engine_unavailable",
  );
  const made = [0, 1, 2].map(() => code(() => manager.createPage(req)));
  check(
    made.every((c) => c === "ok"),
    "three page sessions",
  );
  const health = manager.health();
  check(
    health.ok && health.sessions.length === 3 && health.local === null,
    "health lists 3 page sessions",
  );
  const local = await manager.startLocal({ source: "device" });
  check(!local.ok, `device start with audio.input.kind none: ${local.message}`);
  await manager.stopAll("smoke shutdown");
  check(manager.list().length === 0, "stopAll stops every session");
}

async function storeRules(): Promise<void> {
  console.log(
    "\n== SegmentStore rules (native, translationFinalAtEndpoint=false, grace 600 ms) ==",
  );
  const t0 = Date.now();
  const done: Segment[] = [];
  const store = new SegmentStore({
    sessionId: "s",
    track: "soniox",
    sourceLang: "ar",
    targetLangs: ["nl"],
    sessionStartWall: t0,
    translationGraceMs: 600,
    onDone: (seg) => done.push(seg),
  });
  // 6 s of audio delivered with a constant 20 ms delay: wallAt(ms) = t0 + ms + 20.
  const timeline = new FrameTimeline({ originWallMs: t0 });
  for (let i = 0; i < 60; i++) timeline.push(t0 + (i + 1) * 100 + 20);
  store.beginEngine({
    engineId: "e1",
    capabilities: {
      nativeTranslation: true,
      timing: "provider",
      translationFinalAtEndpoint: false,
    },
    timeline,
  });
  const src = (text: string, startMs: number, endMs: number, lang = "ar"): Token => ({
    text,
    kind: "source",
    lang,
    startMs,
    endMs,
  });
  const tr = (text: string): Token => ({ text, kind: "translation", lang: "nl" });
  const tokens = (final: Token[], nonFinal: Token[] = []): ProviderEvent => ({
    type: "tokens",
    final,
    nonFinal,
    receivedAt: Date.now(),
  });
  const seg = (seq: number): Segment | undefined => store.snapshot().find((s) => s.seq === seq);

  store.apply(tokens([src("الحمد", 0, 400), src(" لله", 400, 800)], [src(" رب", 800, 1000)]), "e1");
  check(
    seg(1)?.source.text === "الحمد لله رب" && seg(1)?.source.finalLen === "الحمد لله".length,
    "finals append, non-finals shown after them (finalLen = final part)",
  );
  store.apply(tokens([], [src(" ربّ", 800, 1000), src(" العالمين", 1000, 1400)]), "e1");
  check(seg(1)?.source.text === "الحمد لله ربّ العالمين", "non-finals are replaced");
  store.apply(
    tokens([src(" رب", 800, 1000), src(" العالمين", 1000, 1400), tr("Alle lof")], [tr(" is…")]),
    "e1",
  );
  check(seg(1)?.translations.nl?.text === "Alle lof is…", "translation: final + non-final tail");
  store.apply({ type: "endpoint", receivedAt: Date.now() }, "e1");
  const closed = seg(1);
  check(closed?.closed === true && closed.source.final, "endpoint closes the segment");
  check(
    closed?.startMs === 20 && closed?.endMs === 1420,
    `provider timing via the timeline: ${closed?.startMs}–${closed?.endMs} ms`,
  );
  check(closed?.translations.nl?.final === false, "translation still pending after <end>");
  const lateAt = Date.now();
  store.apply(tokens([tr(" is voor Allah")]), "e1");
  check(
    seg(1)?.translations.nl?.text === "Alle lof is voor Allah",
    "late translation after <end> → closed segment",
  );
  store.apply(tokens([src("أيها", 1500, 1900)]), "e1");
  await sleep(700);
  check(seg(1)?.translations.nl?.final === true, "translation final after the grace");
  check(
    seg(1)?.timing.translationFinalAt?.nl === lateAt,
    "translationFinalAt = last token arrival (not the timer)",
  );
  store.apply(tokens([src(" المسلمون", 1900, 2400), tr("O moslims")]), "e1");
  check(
    seg(2)?.translations.nl?.text === "O moslims",
    "after the grace, tokens go to the open segment",
  );
  store.apply({ type: "endpoint", receivedAt: Date.now() }, "e1");
  store.apply(tokens([src("آمين", 2500, 2900)]), "e1");
  store.apply({ type: "endpoint", receivedAt: Date.now() }, "e1");
  await sleep(700);
  check(
    seg(3)?.translations.nl?.final === true && seg(3)?.translations.nl?.text === "",
    "zero-token segment finalizes empty after the grace",
  );
  check(done.length === 3, `three segments done: ${done.length}`);
  store.apply(tokens([src(" goedemorgen", 3000, 3400, "nl"), tr(" goedemorgen")]), "e1");
  check(
    seg(4)?.source.lang === "nl" && seg(4)?.translations.nl?.text === "goedemorgen",
    "mirrored 'none' token → same segment",
  );
  store.apply({ type: "reconnected", gapMs: 1000, audioOffsetMs: 4000 }, "e1");
  check(seg(4)?.closed === true, "reconnect closes the open segment");
  store.apply(tokens([src("بسم", 0, 300)]), "e1");
  check(seg(5)?.startMs === 4020, `reconnect offset applied: startMs ${seg(5)?.startMs}`);
  store.clear();
  check(store.snapshot().length === 0, "clear() hides everything");
  store.apply(tokens([], [src(" الله", 300, 600)]), "e1");
  check(
    store.snapshot().length === 1 && seg(6)?.source.text === "الله",
    "after clear, the utterance continues in a new visible segment",
  );
  store.endEngine("e1");
  store.finalizeAll();
  store.dispose();
  check(
    store.lateTranslationDropped === 0,
    `late translations dropped: ${store.lateTranslationDropped}`,
  );
}

/** A provider whose connect fails with an auth error (fatal, no retry). */
class FatalProvider implements SttProvider {
  readonly track: TrackId = "soniox";
  readonly capabilities: ProviderCapabilities = {
    nativeTranslation: true,
    timing: "provider",
    translationFinalAtEndpoint: true,
  };
  private current: ProviderState = "idle";
  stopCalls = 0;

  get state(): ProviderState {
    return this.current;
  }

  async start(opts: { sessionId: string; onEvent: (e: ProviderEvent) => void }): Promise<void> {
    this.current = "connecting";
    opts.onEvent({ type: "state", state: "connecting" });
    await sleep(20);
    this.current = "error";
    opts.onEvent({ type: "error", fatal: true, message: "401 Unauthorized: invalid API key" });
    opts.onEvent({ type: "state", state: "error" });
    throw new Error("401 Unauthorized: invalid API key");
  }

  sendAudio(): void {}
  finalize(): void {}
  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

async function extras(dataDir: string): Promise<void> {
  console.log("\n== cost guard, file EOF, idle monitor, fatal error, long-utterance guard ==");
  const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });
  const device = { audio: { input: { kind: "device", device: "Line (USB Audio CODEC)" } } };

  // Silence auto-stop (autoStopAfterSilenceMin 0.03 = 1.8 s) on a silent device input.
  {
    const manager = new SessionManager({
      loaded: loadedConfig(dataDir, KEYS, {
        ...device,
        audio: { ...device.audio, monitorWhenIdle: false },
        session: { autoStopAfterSilenceMin: 0.03 },
      }),
      engineFactory: makeFactory([], true),
      audioInputFactory: (spec) => new FakeInput(spec, 100, { amplitude: 0 }),
      log,
      version: "smoke",
    });
    const r = await manager.startLocal({ source: "device" });
    check(r.ok, `silent device session started: ${r.message}`);
    check(manager.local()?.status().audio.state === "ok", "audio state ok while frames arrive");
    await sleep(3200);
    const st = manager.local()?.status();
    check(
      st?.state === "idle" && st.error?.startsWith("auto-stopped") === true,
      `silence cost guard stopped the session: ${st?.state} "${st?.error}"`,
    );
  }

  // File end → stop("file ended").
  {
    const manager = new SessionManager({
      loaded: loadedConfig(dataDir, KEYS),
      engineFactory: makeFactory([], true),
      audioInputFactory: (spec) => new FakeInput(spec, 100, { maxFrames: 12 }),
      log,
      version: "smoke",
    });
    const r = await manager.startLocal({ source: "file", file: "/fake/short.wav" });
    check(r.ok, `file session started: ${r.message}`);
    await sleep(1800);
    const local = manager.local();
    check(
      local?.status().state === "idle",
      `file session stopped at end of file: ${local?.status().state}`,
    );
    check(local?.status().session?.file === "/fake/short.wav", "session info carries the file");
  }

  // Idle monitor: levels before Start, released for the session, restored after Stop.
  {
    const inputs: FakeInput[] = [];
    const manager = new SessionManager({
      loaded: loadedConfig(dataDir, KEYS, device),
      engineFactory: makeFactory([], true),
      audioInputFactory: (spec) => {
        const input = new FakeInput(spec, 100);
        inputs.push(input);
        return input;
      },
      log,
      version: "smoke",
    });
    const seen: ServerMessage[] = [];
    const unsubscribe = manager.subscribeMonitor((msg) => seen.push(msg));
    await sleep(700);
    const levels = seen.filter((m) => m.type === "level").length;
    check(levels >= 2 && levels <= 5, `monitor levels at ≤5/s: ${levels} in 0.7 s`);
    check(
      seen.some((m) => m.type === "status" && m.status.state === "idle"),
      "monitor status (idle)",
    );
    const r = await manager.startLocal({ source: "device" });
    check(r.ok && inputs[0]?.stopped === true, "Start stops the monitor before opening the input");
    check(inputs[1]?.started === true && inputs.length === 2, "the session has its own input");
    await manager.stopLocal("operator stop");
    await sleep(50);
    check(inputs.length === 3 && inputs[2]?.started === true, "monitor restored after Stop");
    unsubscribe();
    await manager.stopAll("smoke shutdown");
    check(
      inputs.every((i) => !i.started || i.stopped),
      "stopAll stops every input",
    );
  }

  // Fatal provider error on a page: the session stays and shows the error.
  {
    const fatal = new FatalProvider();
    const manager = new SessionManager({
      loaded: loadedConfig(dataDir, KEYS),
      engineFactory: () => ({ provider: fatal }),
      audioInputFactory: (spec) => new FakeInput(spec, 100),
      log,
      version: "smoke",
    });
    const page = manager.createPage({
      from: "ar",
      to: "nl",
      keyId: null,
      keyLabel: null,
      client: { obs: true, ua: "smoke" },
    });
    page.speech("start");
    await pushFrames(page, 3, 0);
    const st = page.status();
    check(
      st.state === "error" && st.error?.includes("401") === true,
      `fatal error shown: ${st.state} "${st.error}"`,
    );
    check(
      manager.get(page.id) === page && fatal.stopCalls === 1,
      "session kept; failed provider closed",
    );
    page.speech("end");
    page.speech("start");
    check(fatal.stopCalls === 1, "no reconnect loop after a fatal error");
    await manager.stopAll("smoke shutdown");
  }

  // Long-utterance guard: forceFinalizeAfterWords 2 → forced finalize at 3 words.
  {
    const created: Created[] = [];
    const manager = new SessionManager({
      loaded: loadedConfig(dataDir, KEYS, { stt: { soniox: { forceFinalizeAfterWords: 2 } } }),
      engineFactory: makeFactory(created, true),
      audioInputFactory: (spec) => new FakeInput(spec, 100),
      log,
      version: "smoke",
    });
    const page = manager.createPage({
      from: "ar",
      to: "nl",
      keyId: null,
      keyLabel: null,
      client: { obs: false, ua: "smoke" },
    });
    page.speech("start");
    await pushFrames(page, 9, 0);
    check(
      (created[0]?.provider.finalizeCalls ?? 0) === 1,
      `guard called finalize() once: ${created[0]?.provider.finalizeCalls}`,
    );
    await page.stop("smoke done");
    const folder = readdirSync(join(dataDir, "transcripts")).find((d) => d.endsWith(`_${page.id}`));
    const jsonl =
      folder === undefined
        ? ""
        : readFileSync(join(dataDir, "transcripts", folder, "session.jsonl"), "utf8");
    check(jsonl.includes('"type":"guard"'), "guard marker in session.jsonl");
  }
}

// --- caption blocks ------------------------------------------------------------------------------

const FORMULA_WORDS = new Set(
  [
    "الله اكبر",
    "اشهد ان لا اله الا الله",
    "اشهد ان محمدا رسول الله",
    "حي على الصلاه",
    "حي على الفلاح",
    "قد قامت الصلاه",
  ].flatMap((p) => normalizeArabic(p).split(" ")),
);

function formulaOnly(text: string): boolean {
  const words = normalizeArabic(text)
    .split(" ")
    .filter((w) => w !== "");
  return words.length > 0 && words.every((w) => FORMULA_WORDS.has(w));
}

/** Minimal rule detector: formula-only after ≥5 s silence → hold; "حي على" → Athan. */
class FakeDetector implements EventDetectorApi {
  mode: SessionMode = "speech";
  readonly salah = false;
  private held: DetectorSegment[] = [];

  isFormulaOnly(text: string): boolean {
    return formulaOnly(text);
  }

  markers(): MarkerId[] {
    return [];
  }

  onSegment(seg: DetectorSegment): DetectorAction[] {
    const formula = formulaOnly(seg.text);
    if (this.mode === "athan" || this.mode === "iqama") {
      if (formula) return [{ type: "suppress", segment: seg }];
      const ended = this.mode;
      this.mode = "speech";
      return [
        { type: "event-end", event: ended },
        { type: "mode", mode: "speech" },
        { type: "pass", segment: seg },
      ];
    }
    if (formula && (this.held.length > 0 || seg.silenceBeforeMs >= 5000)) {
      this.held.push(seg);
      if (normalizeArabic(seg.text).includes("حي علي")) {
        const discarded = this.held;
        this.held = [];
        this.mode = "athan";
        return [
          {
            type: "event-start",
            event: "athan",
            discarded,
            hideFormulaBlocksSinceMs: seg.at - 60_000,
          },
          { type: "mode", mode: "athan" },
        ];
      }
      const actions: DetectorAction[] = [{ type: "hold", segment: seg }];
      if (this.mode !== "held") {
        this.mode = "held";
        actions.push({ type: "mode", mode: "held" });
      }
      return actions;
    }
    if (this.held.length > 0) {
      const released = this.held;
      this.held = [];
      this.mode = "speech";
      return [
        { type: "release", segments: released },
        { type: "mode", mode: "speech" },
        { type: "pass", segment: seg },
      ];
    }
    return [{ type: "pass", segment: seg }];
  }

  tick(): DetectorAction[] {
    return [];
  }

  override(event: PrayerEvent | "none", now: number): DetectorAction[] {
    const previous = this.mode;
    if (event === "none") {
      this.mode = "speech";
      return previous === "athan" || previous === "iqama" || previous === "salah"
        ? [
            { type: "event-end", event: previous },
            { type: "mode", mode: "speech" },
          ]
        : [{ type: "mode", mode: "speech" }];
    }
    this.mode = event;
    return [
      { type: "event-start", event, discarded: [], hideFormulaBlocksSinceMs: now - 60_000 },
      { type: "mode", mode: event },
    ];
  }
}

async function pageBlocks(dataDir: string): Promise<void> {
  console.log("\n== page session in blocks layout (fast blocks from Soniox's translation) ==");
  const created: Created[] = [];
  const manager = new SessionManager({
    loaded: loadedConfig(dataDir, KEYS),
    engineFactory: makeFactory(created, true),
    audioInputFactory: (spec) => new FakeInput(spec, 100),
    log: pino({ level: process.env.LOG_LEVEL ?? "warn" }),
    version: "smoke",
    blocks: { detectorFactory: () => new FakeDetector() },
  });
  const session = manager.createPage({
    from: "ar",
    to: "nl",
    keyId: null,
    keyLabel: "blocks",
    client: { obs: true, ua: "smoke" },
  });
  const messages: ServerMessage[] = [];
  const unsubscribe = session.subscribe((m) => messages.push(m));
  check(session.status().layout === "blocks", "layout blocks (default from config.display)");
  session.speech("start");
  check(
    created[0]?.req.fastBlocks === true && created[0]?.provider.capabilities.nativeTranslation,
    "Soniox translates itself, with the fast-blocks endpoint settings",
  );
  await pushFrames(session, 13, 0);
  session.speech("end");
  await sleep(600);
  const blockText = (): string =>
    messages
      .flatMap((m) => (m.type === "block.add" || m.type === "block.update" ? [m.block] : []))
      .filter((b) => b.kind === "speech")
      .map((b) => b.text)
      .join(" | ");
  check(
    blockText().includes("Alle lof is voor Allah"),
    `block from Soniox's translation: "${blockText()}"`,
  );
  const snap = session.snapshots();
  const blocksSnap = snap.find((m) => m.type === "blocks.snapshot");
  check(
    blocksSnap?.type === "blocks.snapshot" && blocksSnap.blocks.length >= 1,
    "snapshots include blocks.snapshot",
  );
  check(
    snap.some((m) => m.type === "mode" && m.mode === "speech"),
    "snapshots include the mode",
  );
  const segSnap = snap.find((m) => m.type === "snapshot");
  check(
    segSnap?.type === "snapshot" &&
      segSnap.segments[0]?.translations.nl?.text === "Alle lof is voor Allah, de Heer der werelden",
    "segments keep Soniox's translation",
  );
  session.overrideEvent("athan");
  await sleep(50);
  check(
    messages.some(
      (m) => m.type === "block.add" && m.block.kind === "event" && m.block.event?.type === "athan",
    ),
    "overrideEvent → event card",
  );
  check(
    messages.some((m) => m.type === "mode" && m.mode === "athan"),
    "overrideEvent → mode athan",
  );
  session.overrideEvent("none");
  await sleep(300);
  const added = messages.filter((m) => m.type === "block.add").length;
  const history = session.blocks({ limit: 10 });
  check(
    history.blocks.length === added && !history.hasMore,
    `session.blocks() returns the history (${history.blocks.length} of ${added} added)`,
  );
  const paged = session.blocks({ limit: 1 });
  check(paged.blocks.length === 1 && paged.hasMore, "session.blocks({limit:1}) → hasMore");
  await session.stop("smoke done");
  check(
    messages.some((m) => m.type === "session.ended"),
    "session.ended emitted on stop",
  );
  unsubscribe();
  const folder = readdirSync(join(dataDir, "transcripts")).find((d) =>
    d.endsWith(`_${session.id}`),
  );
  const blocksFile =
    folder === undefined ? "" : join(dataDir, "transcripts", folder, "blocks.jsonl");
  const lines = blocksFile === "" ? [] : readFileSync(blocksFile, "utf8").trim().split("\n");
  check(lines.length >= 3, `blocks.jsonl in the session folder: ${lines.length} lines`);

  // Without the block dependencies a session keeps the rollup layout.
  const rollup = new SessionManager({
    loaded: loadedConfig(dataDir, KEYS),
    engineFactory: makeFactory([], true),
    audioInputFactory: (spec) => new FakeInput(spec, 100),
    log: pino({ level: "silent" }),
    version: "smoke",
  });
  const fallbackPage = rollup.createPage({
    from: "ar",
    to: "nl",
    keyId: null,
    keyLabel: null,
    client: { obs: false, ua: "smoke" },
  });
  check(fallbackPage.status().layout === "rollup", "no block dependencies → rollup layout");
  await rollup.stopAll("smoke shutdown");

  // A local file session in blocks layout (speech events from the server-side VAD).
  const localBlocks: ServerMessage[] = [];
  const started = await manager.startLocal({ source: "file", file: "/fake/khutbah.wav" });
  const local = manager.local();
  const unsubLocal = local?.subscribe((m) => localBlocks.push(m));
  check(
    started.ok && local?.status().layout === "blocks",
    `local file session in blocks layout: ${started.message}`,
  );
  await sleep(1800);
  const localAdds = localBlocks.filter((m) => m.type === "block.add").length;
  check(localAdds >= 1, `local session produces blocks: ${localAdds}`);
  await manager.stopLocal("smoke done");
  check(
    localBlocks.some((m) => m.type === "session.ended"),
    "local session.ended on stop",
  );
  unsubLocal?.();
  await manager.stopAll("smoke shutdown");
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "captions-smoke-"));
  console.log(`DATA_DIR=${dataDir}`);
  await pageBlocks(dataDir);
  await storeRules();
  await extras(dataDir);
  await pageSoniox(dataDir);
  await localFile(dataDir);
  await errors(dataDir);
  console.log(
    `\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`} (transcripts kept in ${dataDir})`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
