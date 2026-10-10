// Caption page `/:from/:to`: captures this
// machine's microphone, streams speech (VAD-gated) to the server over /ws/page and renders what
// comes back: complete caption blocks (layout=blocks, default) or the live roll-up
// (layout=rollup). The look comes from the theme (preset + URL params, src/shared/theme.ts).
// States: requesting-mic → connecting → listening → live, or error (readable banner; mic and
// server problems heal by themselves). With a signed screen link (?screen=&sig=)
// the page connects first and only opens the microphone once the server says `ready`; a
// switched-off screen ("off") releases the mic and shows a calm card until it is enabled again.
import "./caption.css";
import { LatencyMatcher } from "../src/shared/latency-match.js";
import type {
  PageErrorCode,
  ScreenLink,
  ScreenState,
  Segment,
  SessionMode,
  Status,
  TrackId,
  VadParams,
} from "../src/shared/protocol.js";
import { type BannerAction, Banners } from "./shared/banners.js";
import { BlockView } from "./shared/blocks.js";
import { authFrom, exportLinks, olderLoader } from "./shared/blocks-api.js";
import { byId, fmtMs } from "./shared/dom.js";
import { uiLabels } from "./shared/i18n.js";
import { MicCapture, type MicProblem } from "./shared/mic.js";
import { type PageConnState, type PageDataMessage, PageSocket } from "./shared/page-ws.js";
import {
  type DisplayParams,
  type PageParams,
  parsePageParams,
  type Show,
} from "./shared/params.js";
import { type BlockSpec, RollupView } from "./shared/rollup.js";
import { ScreenCard } from "./shared/screen-card.js";
import { CaptionState } from "./shared/state.js";
import {
  type BootedTheme,
  bootTheme,
  stepFontScale,
  themeNumber,
  toolbarVisible,
} from "./shared/theme-boot.js";
import { Toolbar, type ToolbarState } from "./shared/toolbar.js";
import { VadGate } from "./shared/vad-gate.js";

type PageState = "requesting-mic" | "connecting" | "listening" | "live" | "off" | "error";

const DEFAULT_VAD: VadParams = {
  thresholdDbfs: -45,
  minSpeechMs: 200,
  minSilenceMs: 400,
  hangoverMs: 800,
  prerollMs: 500,
};
/** Show "server unreachable" only after this long without a connection. */
const UNREACHABLE_AFTER_MS = 2500;

const STATE_TEXT: Record<PageState, string> = {
  "requesting-mic": "Requesting microphone…",
  connecting: "Connecting…",
  listening: "Listening",
  live: "Live",
  off: "Off",
  error: "Error",
};

/** `?screen=<guid>` (/feed/<guid> redirects here), or no screen feed at all. */
function screenLinkFrom(query: URLSearchParams): ScreenLink | null {
  const guid = query.get("screen")?.trim();
  return guid ? { guid } : null;
}

function parsePath(pathname: string): { from: string; to: string } | null {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const from = decodeURIComponent(parts[0]).trim();
    const to = decodeURIComponent(parts[1]).trim();
    return from && to ? { from, to } : null;
  } catch {
    return null;
  }
}

function rollupBlocks(show: Show, from: string, to: string): BlockSpec[] {
  const source: BlockSpec = { role: "source", lang: from };
  const translation: BlockSpec = { role: "translation", lang: to };
  if (show === "source") return [source];
  if (show === "target") return [translation];
  return [source, translation];
}

function insecureText(): string {
  // A screen's feed link is its key: never print it on a page that may be on a public TV.
  if (new URLSearchParams(window.location.search).has("screen")) {
    return (
      "Microphone needs HTTPS. On the computer that runs Turjuman, use the screen's link that " +
      "starts with http://127.0.0.1 (in the app: Show on a screen); on other computers, its HTTPS link."
    );
  }
  const port = window.location.port || "8765";
  const local = `http://127.0.0.1:${port}${window.location.pathname}`;
  return `Microphone needs HTTPS (or localhost). Open this page via https:// or on this machine at ${local}`;
}

class CaptionPage {
  private readonly banners = new Banners(byId("banners", HTMLDivElement));
  private readonly layout: "blocks" | "rollup";
  private readonly rollup: RollupView | null = null;
  private readonly blocks: BlockView | null = null;
  private readonly toolbar: Toolbar | null = null;
  private readonly showBar: boolean;
  private readonly state = new CaptionState();
  private readonly sock: PageSocket;
  private readonly mic: MicCapture;
  private gate: VadGate;
  private readonly latSource = new LatencyMatcher();
  private readonly latTrans = new LatencyMatcher();
  private readonly latBlocks = new LatencyMatcher();
  private readonly seenSourceFinal = new Set<string>();
  private readonly seenTransFinal = new Set<string>();
  private finals = 0;
  private blocksSeen = 0;
  private mode: SessionMode = "speech";
  private pageState: PageState = "requesting-mic";
  private micOk = false;
  private micProblem: MicProblem | null = null;
  private wsReady = false;
  private wsFatal = false;
  private connState: PageConnState = "connecting";
  private downSince: number | null = null;
  /** The socket was open at least once: a later "connecting" is a reconnect. */
  private linked = false;
  private sockStarted = false;
  /** Soniox is the only engine: its track is always the one shown. */
  private readonly shownTrack: TrackId = "soniox";
  private rms = -100;
  private peak = -100;
  private clock: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private vad: VadParams = DEFAULT_VAD;
  // Screens
  private readonly screenLink: ScreenLink | null;
  private screenState: ScreenState | null = null;
  private screenName: string | null = null;
  private linkProblem: "invalid" | "required" | null = null;
  private readonly card: ScreenCard;
  private readonly dom = {
    bar: byId("statusbar", HTMLDivElement),
    dot: byId("st-dot", HTMLSpanElement),
    state: byId("st-state", HTMLSpanElement),
    pair: byId("st-pair", HTMLSpanElement),
    level: byId("st-level", HTMLSpanElement),
    mic: byId("st-mic", HTMLSpanElement),
    debug: byId("debug", HTMLPreElement),
    banners: byId("banners", HTMLDivElement),
  };

  constructor(
    private readonly from: string,
    private readonly to: string,
    private readonly p: PageParams,
    private readonly theme: BootedTheme,
    query: URLSearchParams,
    private readonly inObs: boolean,
  ) {
    const o = theme.options;
    this.layout = o.layout === "rollup" ? "rollup" : "blocks";
    this.showBar = toolbarVisible(query, o.toolbar, inObs);
    const host = byId("captions", HTMLDivElement);
    const auth = authFrom(query);
    this.screenLink = screenLinkFrom(query);
    this.card = new ScreenCard(document.body, to);

    if (this.layout === "rollup") {
      // The theme already gives roll-up its natural defaults (bg band, partial on).
      const display: DisplayParams = {
        ...p,
        lines: o.lines,
        size: o.size,
        pos: o.pos,
        bg: rollupBg(o.bg),
        partial: o.partial,
        // Scales stay integer-px geometry in rollup.ts; the theme only provides the factors.
        srcScale: themeNumber(theme.vars, "--cap-src-scale") ?? p.srcScale,
        lineHeight: themeNumber(theme.vars, "--cap-line-height"),
      };
      this.rollup = new RollupView(host, display);
      this.rollup.setBlocks(rollupBlocks(o.show, from, to));
    } else {
      this.blocks = new BlockView(host, {
        show: o.show,
        quranAccent: o.quranAccent,
        quranArabic: o.quranArabic,
        partial: o.partial,
        history: o.history && !inObs,
        maxBlocks: o.maxBlocks,
        visibleBlocks: o.visibleBlocks,
        pos: o.pos,
        bg: o.bg === "none" || o.bg === "shadow" ? "none" : "panel",
        targetLang: to,
        sourceLang: from,
        live: true,
        loadOlder: olderLoader(auth),
        exportLinks: (sid) => exportLinks(sid, auth),
      });
      if (this.showBar) {
        this.toolbar = new Toolbar(document.body, {
          targetLang: to,
          showSource: o.show === "both",
          quranArabic: o.quranArabic,
          sourceToggle: o.show !== "source",
          meter: true,
          onFontStep: (dir) => {
            stepFontScale(this.baseFont(), dir);
            this.blocks?.refit();
          },
          onShowSource: (on) => this.blocks?.setShow(on ? "both" : "target"),
          onQuranArabic: (on) => this.blocks?.setQuranArabic(on),
        });
      }
    }
    this.gate = this.makeGate(DEFAULT_VAD);

    this.sock = new PageSocket(
      {
        from,
        to,
        key: p.key,
        layout: this.layout,
        screen: this.screenLink,
      },
      {
        onReady: (msg) => {
          this.wsReady = true;
          this.wsFatal = false;
          this.banners.clear("server");
          this.banners.clear("ws");
          // Fresh gate with the server's thresholds; ongoing speech re-triggers with pre-roll.
          this.vad = msg.vad;
          this.gate = this.makeGate(msg.vad);
          if (this.screenLink) {
            // A ready screen session is enabled: show captions and (re)open the microphone.
            this.screenState = "enabled";
            this.linkProblem = null;
            this.card.hide();
            document.body.classList.remove("is-screen-off");
            this.mic.start();
          }
          this.update();
        },
        onError: (code, message, retryInMs) => this.onWsError(code, message, retryInMs),
        onData: (msg) => this.onData(msg),
        onScreen: (state, name) => this.onScreen(state, name),
        onState: (s, downSince) => {
          this.connState = s;
          this.downSince = downSince;
          if (s === "handshake") this.linked = true;
          if (s !== "ready") this.wsReady = false;
          if (s === "stopped") this.wsFatal = true;
          this.update();
        },
      },
    );

    this.mic = new MicCapture(
      { mic: p.mic, ch: p.ch, dsp: p.dsp, nativeRate: p.nativeRate },
      {
        onFrame: (f) => {
          this.rms = f.rmsDbfs;
          this.peak = f.peakDbfs;
          this.gate.push(f.samples, this.frameStart());
          this.drawLevel();
        },
        onRunning: (info) => {
          this.micOk = true;
          this.micProblem = null;
          this.banners.clear("mic");
          this.dom.mic.textContent = info.label;
          this.dom.mic.title = `${info.label} · ${info.sampleRate} Hz${info.resampling ? " (resampled)" : ""}`;
          if (!this.sockStarted) {
            this.sockStarted = true;
            this.sock.start();
          }
          this.update();
        },
        onProblem: (problem, retryInMs) => this.onMicProblem(problem, retryInMs),
        // "No microphone matches …" names this computer's microphones: only with ?debug=1, never
        // on a public screen.
        onWarning: (text) => {
          if (text && this.p.debug) this.banners.set("mic-warn", "warn", text, { ttlMs: 60_000 });
          else this.banners.clear("mic-warn");
        },
      },
    );
  }

  start(): void {
    const top = this.theme.options.pos === "top";
    // Roll-up keeps its status bar; blocks use the toolbar instead.
    const statusBar = this.layout === "rollup" && this.showBar;
    this.dom.bar.classList.add(top ? "at-bottom" : "at-top");
    this.dom.banners.classList.toggle("at-bottom", top && this.layout === "rollup");
    this.dom.bar.classList.toggle("is-hidden", !statusBar);
    document.body.classList.toggle("has-statusbar", this.showBar);
    document.body.classList.add(`layout-${this.layout}`);
    this.dom.debug.classList.toggle("is-hidden", !this.p.debug);
    this.dom.pair.textContent = `${this.from} → ${this.to}`;
    document.title = `${uiLabels(this.to).live} · ${this.from} → ${this.to}`;

    document.addEventListener("visibilitychange", () => this.onVisibility());
    // Some browsers keep the AudioContext suspended until a user gesture.
    const resume = (): void => void this.mic.resume();
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);

    if (this.screenLink) {
      // Screen links ask the server first: a disabled screen never opens the microphone.
      this.sockStarted = true;
      this.sock.start();
    } else {
      this.mic.start();
    }
    void this.keepAwake();
    setInterval(() => this.tick(), 1000);
    this.update();
  }

  // --- signed screens ---------------------------------------------------------------------------

  private onScreen(state: ScreenState, name: string): void {
    // The look of this screen changed in the portal: load the feed link again.
    if (state === "reload") {
      if (this.screenLink) location.replace(`/feed/${encodeURIComponent(this.screenLink.guid)}`);
      return;
    }
    this.screenState = state;
    this.screenName = name || null;
    this.linkProblem = null;
    if (state === "disabled") {
      this.wsReady = false;
      this.releaseMic();
      // Fade the captions away: the next enabled session starts clean.
      this.blocks?.fadeAndReset();
      this.rollup?.fadeAway();
      this.card.show("off", this.screenName);
      document.body.classList.add("is-screen-off");
    } else {
      this.card.hide();
      document.body.classList.remove("is-screen-off");
      // A new session (never a resume); the microphone opens on `ready`.
      this.sock.rehello();
    }
    this.update();
  }

  /** Stop streaming and give the microphone back (tracks stopped, worklet/context closed). */
  private releaseMic(): void {
    this.mic.stop();
    this.micOk = false;
    this.micProblem = null;
    this.banners.clear("mic");
    this.banners.clear("mic-warn");
    this.gate = this.makeGate(this.vad);
    this.rms = -100;
    this.peak = -100;
    this.drawLevel();
  }

  private baseFont(): string {
    return this.theme.vars["--cap-font-size"] ?? `${this.theme.options.size}px`;
  }

  // --- audio → VAD gate → socket ---------------------------------------------------------------

  private makeGate(vad: VadParams): VadGate {
    return new VadGate(vad, {
      speech: (state, atMs) => {
        this.sock.sendSpeech(state);
        if (state === "end") {
          this.latSource.speechEnd(atMs);
          this.latTrans.speechEnd(atMs);
          this.latBlocks.speechEnd(atMs);
        }
        this.update();
      },
      frame: (samples) => {
        this.sock.sendFrame(samples);
      },
    });
  }

  /** Page-clock start time of the next 100 ms frame (contiguous; re-anchored after gaps). */
  private frameStart(): number {
    const expected = performance.now() - 100;
    if (this.clock === null || Math.abs(this.clock - expected) > 500) this.clock = expected;
    const t = this.clock;
    this.clock += 100;
    return t;
  }

  // --- server messages ---------------------------------------------------------------------------

  private onData(msg: PageDataMessage): void {
    const now = performance.now();
    switch (msg.type) {
      case "blocks.snapshot":
        this.blocks?.snapshot(msg.blocks, msg.hasMore);
        break;
      case "block.add":
        if (msg.block.kind !== "event" && !msg.block.hidden) {
          this.blocksSeen++;
          this.latBlocks.final(now);
        }
        this.blocks?.add(msg.block);
        break;
      case "block.update":
        this.blocks?.update(msg.block);
        break;
      case "mode":
        this.mode = msg.mode;
        break;
      case "listening":
        this.blocks?.listening(msg.active, msg.partial);
        break;
      case "session.ended":
        this.blocks?.ended(msg.endedAt, this.sock.sessionId);
        break;
      case "clear":
        // Reset: both renderers empty; the empty blocks.snapshot that follows applies.
        if (msg.track === "all" || msg.track === this.shownTrack) this.blocks?.reset();
        this.onSegments(msg, now);
        break;
      default:
        this.onSegments(msg, now);
    }
    this.update();
  }

  private onSegments(
    msg: Extract<PageDataMessage, { type: "snapshot" | "segment" | "clear" | "status" }>,
    now: number,
  ): void {
    if (msg.type === "segment") this.noteFinals(msg.segment, now, true);
    if (msg.type === "snapshot") for (const s of msg.segments) this.noteFinals(s, now, false);
    const change = this.state.apply(msg);
    const view = this.rollup;
    if (!view) return;
    if (change.kind === "clear") {
      if (change.track === "all" || change.track === this.shownTrack) view.clear();
    }
    if (change.kind !== "status" && change.kind !== "none") {
      view.update(this.state.segments(this.shownTrack));
    }
  }

  /** Count finals and feed page-side latency (live segment messages only, not snapshots). */
  private noteFinals(seg: Segment, now: number, live: boolean): void {
    if (seg.source.final && !this.seenSourceFinal.has(seg.id)) {
      this.seenSourceFinal.add(seg.id);
      if (live) {
        this.finals++;
        this.latSource.final(now);
      }
    }
    const tr = seg.translations[this.to];
    if (tr?.final && !this.seenTransFinal.has(seg.id)) {
      this.seenTransFinal.add(seg.id);
      if (live) this.latTrans.final(now);
    }
    for (const set of [this.seenSourceFinal, this.seenTransFinal]) {
      if (set.size > 500) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
      }
    }
  }

  private onWsError(code: PageErrorCode, message: string, retryInMs: number | null): void {
    this.wsReady = false;
    if (code === "screen_invalid" || code === "screen_required") {
      // A calm card instead of a banner; the socket retries at most once a minute.
      this.linkProblem = code === "screen_invalid" ? "invalid" : "required";
      this.screenState = null;
      this.releaseMic();
      this.blocks?.fadeAndReset();
      this.rollup?.fadeAway();
      this.card.show(this.linkProblem, this.screenName);
      document.body.classList.add("is-screen-off");
      this.update();
      return;
    }
    // The server's own words end as a sentence before "Retrying …" follows.
    const said = /[.!?؟]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
    const retry =
      retryInMs === null
        ? ""
        : retryInMs >= 60_000
          ? ` Retrying every ${Math.round(retryInMs / 60_000)} min.`
          : ` Retrying in ${Math.round(retryInMs / 1000)} s.`;
    let text: string;
    let action: BannerAction | undefined;
    switch (code) {
      case "unauthorized":
        // The server says what is missing: an access key, a screen link or a login (hosted).
        text = `${said}${retry}`;
        break;
      case "quota_exceeded":
        text = `Daily limit reached for this access key.${retry}`;
        break;
      case "bad_language":
        text = `Unsupported language pair ${this.from} → ${this.to}. ${said}`;
        action = {
          label: "Choose languages",
          href: `/app/new?error=${encodeURIComponent(`Unsupported language pair ${this.from} → ${this.to}`)}`,
        };
        this.wsFatal = true;
        break;
      case "engine_unavailable":
        text = `The speech engine is unavailable on the server. ${said}${retry}`;
        break;
      default:
        text = `Server error: ${said}${retry}`;
    }
    this.banners.set("ws", "error", text.trim(), action ? { action } : {});
    this.update();
  }

  private onMicProblem(problem: MicProblem, retryInMs: number | null): void {
    this.micOk = problem.kind === "suspended";
    this.micProblem = problem.kind === "suspended" ? null : problem;
    const every = retryInMs ? ` Retrying every ${Math.round(retryInMs / 1000)} s.` : "";
    switch (problem.kind) {
      case "insecure":
        this.banners.set("mic", "error", insecureText());
        break;
      case "denied":
        this.banners.set(
          "mic",
          "error",
          `Microphone access was denied. Allow the microphone for this site${
            this.inObs ? " (OBS: start OBS with --enable-media-stream)" : ""
          }.${every}`,
        );
        break;
      case "notfound":
        this.banners.set("mic", "error", `Microphone not found.${every}`);
        break;
      case "busy":
        this.banners.set("mic", "error", `The microphone can't be opened (in use?).${every}`);
        break;
      case "suspended":
        this.banners.set("mic", "info", "Audio is paused by the browser.", {
          action: { label: "Start audio", onClick: () => void this.mic.resume() },
        });
        break;
      default:
        this.banners.set("mic", "error", `Microphone error: ${problem.detail}.${every}`);
    }
    this.update();
  }

  // --- state, status bar / toolbar, debug --------------------------------------------------------

  private computeState(): PageState {
    if (this.linkProblem) return "error";
    if (this.screenState === "disabled") return "off";
    if (this.micProblem || this.wsFatal) return "error";
    if (!this.micOk) return "requesting-mic";
    if (!this.wsReady) return this.banners.has("ws") ? "error" : "connecting";
    return this.gate.sending ? "live" : "listening";
  }

  private update(): void {
    const next = this.computeState();
    this.pageState = next;
    // Compared with the DOM, not the previous state: the first state needs its class too.
    const dotClass = `st-dot s-${next}`;
    if (this.dom.dot.className !== dotClass) this.dom.dot.className = dotClass;
    let text = STATE_TEXT[next];
    if (next === "connecting" && this.linked && this.downSince !== null) text = "Reconnecting…";
    if (next === "off") text = uiLabels(this.to).off;
    if (next === "error") {
      if (this.linkProblem === "invalid") text = uiLabels(this.to).linkInvalidTitle;
      else if (this.linkProblem === "required") text = uiLabels(this.to).screenRequiredTitle;
      else if (this.micProblem?.kind === "insecure") text = "Needs HTTPS";
      else if (this.micProblem) text = "Microphone problem";
      else text = "Server problem";
    }
    if (this.dom.state.textContent !== text) this.dom.state.textContent = text;
    if (this.toolbar) {
      const kind: ToolbarState =
        next === "live"
          ? "live"
          : next === "listening" || next === "off"
            ? "idle"
            : next === "error"
              ? "error"
              : "connecting";
      const short =
        next === "live" || next === "listening"
          ? ""
          : next === "connecting"
            ? uiLabels(this.to).connecting
            : text;
      this.toolbar.setState(kind, short, text);
    }
    this.publishStats();
    if (this.p.debug) this.drawDebug();
  }

  private tick(): void {
    // "Server unreachable" after a few seconds without a connection (not on a normal connect).
    // Not while the calm card shows: an old or unknown link (the socket retries once a minute) or
    // a switched-off screen keeps its card, never a red banner on a public screen.
    const calm = this.linkProblem !== null || this.screenState === "disabled";
    const down =
      this.sockStarted &&
      !this.wsFatal &&
      !calm &&
      !this.sock.ready &&
      this.downSince !== null &&
      Date.now() - this.downSince > UNREACHABLE_AFTER_MS &&
      !this.banners.has("ws");
    if (down) {
      this.banners.set("server", "error", "Can't reach the caption server. Reconnecting…");
    } else if (calm || this.sock.ready || this.downSince === null) {
      // Connected again (a switched-off screen never becomes `ready`), or the card took over.
      this.banners.clear("server");
    }
    this.update();
  }

  private drawLevel(): void {
    // −60 … 0 dBFS → 0 … 100 %
    const pct = Math.max(0, Math.min(100, ((this.rms + 60) / 60) * 100));
    this.dom.level.style.width = `${pct.toFixed(0)}%`;
    this.dom.level.style.background = this.gate.sending ? "#3ddc84" : "#4fa3ff";
    this.toolbar?.setLevel(this.rms, this.gate.sending);
    if (this.p.debug) this.drawDebug();
  }

  private status(): Status | null {
    return this.state.status;
  }

  private drawDebug(): void {
    const st = this.status();
    const track = st?.tracks.find((t) => t.track === this.shownTrack);
    const ls = this.latSource.stats();
    const lt = this.latTrans.stats();
    const lb = this.latBlocks.stats();
    const lines = [
      `state     ${this.pageState}${this.gate.sending ? " (sending speech)" : ""}`,
      `session   ${this.sock.sessionId ?? "–"}  link ${this.connState}`,
      `layout    ${this.layout}  preset ${this.theme.presetId}  mode ${this.mode}`,
      `screen    ${this.screenLink ? `${this.screenLink.guid.slice(0, 8)}… ${this.screenState ?? this.linkProblem ?? "…"}${this.screenName ? ` (${this.screenName})` : ""}` : "–"}  mic ${this.mic.running ? "open" : "released"}`,
      `level     ${this.rms.toFixed(1)} dBFS  peak ${this.peak.toFixed(1)}`,
      `mic       ${this.mic.label ?? "–"} @ ${this.mic.sampleRate ?? "?"} Hz${this.mic.resampling ? " (resampled)" : ""}`,
      `engine    soniox  provider ${st?.provider ?? "–"}  session ${st?.state ?? "–"}`,
      `page      speaking ${st?.page?.speaking ?? "–"}  engineOpen ${st?.page?.engineOpen ?? "–"}  min ${st?.page?.streamedMinutes?.toFixed(2) ?? "–"}`,
      `frames    sent ${this.sock.framesSent}  dropped ${this.sock.framesDropped}`,
      `segments  ${this.state.segments(this.shownTrack).length}  finals ${this.finals}  blocks ${this.blocksSeen}`,
      `latency   blocks p50 ${fmtMs(lb.p50Ms)} p95 ${fmtMs(lb.p95Ms)} (n=${lb.n})`,
      `          src p50 ${fmtMs(ls.p50Ms)} p95 ${fmtMs(ls.p95Ms)} (n=${ls.n})`,
      `          ${this.to} p50 ${fmtMs(lt.p50Ms)} p95 ${fmtMs(lt.p95Ms)} (n=${lt.n})`,
      `server    p50 ${fmtMs(track?.latency.translation.p50Ms)} p95 ${fmtMs(track?.latency.translation.p95Ms)}${track?.lastError ? `  err ${track.lastError}` : ""}`,
    ];
    const text = lines.join("\n");
    if (this.dom.debug.textContent !== text) this.dom.debug.textContent = text;
  }

  private publishStats(): void {
    const ls = this.latSource.stats();
    const lt = this.latTrans.stats();
    const lb = this.latBlocks.stats();
    const showsTranslation = this.theme.options.show !== "source";
    const segmentLatency = showsTranslation && lt.n > 0 ? lt : ls;
    window.__captionStats = {
      state: this.pageState,
      sessionId: this.sock.sessionId,
      layout: this.layout,
      mode: this.mode,
      segments: this.state.segments(this.shownTrack).length,
      finals: this.finals,
      blocks: this.blocks?.blockCount ?? 0,
      latency: this.layout === "blocks" ? lb : segmentLatency,
      latencyBlocks: lb,
      latencySource: ls,
      latencyTranslation: lt,
      framesSent: this.sock.framesSent,
      speaking: this.gate.sending,
      sampleRate: this.mic.sampleRate,
      resampling: this.mic.resampling,
      micLabel: this.mic.label,
      screen: this.screenLink
        ? {
            guid: this.screenLink.guid,
            state: this.linkProblem ?? this.screenState ?? "pending",
          }
        : null,
    };
  }

  // --- page lifecycle ------------------------------------------------------------------------------

  private onVisibility(): void {
    if (document.hidden) {
      this.banners.set(
        "hidden",
        "warn",
        "This page is in the background. Some browsers stop the microphone; keep it visible.",
      );
    } else {
      this.banners.clear("hidden");
      void this.keepAwake();
    }
  }

  private async keepAwake(): Promise<void> {
    if (this.inObs || !("wakeLock" in navigator) || document.hidden) return;
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // not allowed (battery saver, iframe, …): captions still work
    }
  }
}

function rollupBg(bg: string): DisplayParams["bg"] {
  return bg === "none" ? "none" : bg === "shadow" ? "shadow" : "band";
}

async function main(): Promise<void> {
  const inObs = window.obsstudio !== undefined;
  const query = new URLSearchParams(window.location.search);
  const params = parsePageParams(query, inObs);
  const path = parsePath(window.location.pathname);
  if (!path) {
    const banners = new Banners(byId("banners", HTMLDivElement));
    banners.set(
      "path",
      "error",
      "This isn't a caption page address (expected /<from>/<to>, e.g. /ar/nl).",
      {
        action: { label: "Choose languages", href: "/app/new" },
      },
    );
    return;
  }
  const theme = await bootTheme(query);
  const page = new CaptionPage(path.from, path.to, params, theme, query, inObs);
  page.start();
}

void main();
