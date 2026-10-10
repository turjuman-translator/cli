// Overlay (`/overlay`): captions of the local (device/file) session, or of any session with
// ?session=<id> (debug aid), for OBS Browser Sources. layout=blocks (default) shows complete
// caption blocks; layout=rollup the live roll-up (then ?lang= picks the blocks and, without
// ?track=, it follows status.primary). The look comes from the theme (preset + URL params).
// Reconnects 0.5 → 1 → 2 s; amber dot after 3 s down.
import "./overlay.css";
import type { Segment, ServerMessage, TrackId } from "../src/shared/protocol.js";
import { BlockView } from "./shared/blocks.js";
import { authFrom, exportLinks, olderLoader } from "./shared/blocks-api.js";
import { byId, fmtMs, wsUrl } from "./shared/dom.js";
import { type DisplayParams, type OverlayParams, parseOverlayParams } from "./shared/params.js";
import { type BlockSpec, RollupView } from "./shared/rollup.js";
import { CaptionState } from "./shared/state.js";
import {
  type BootedTheme,
  bootTheme,
  stepFontScale,
  themeNumber,
  toolbarVisible,
} from "./shared/theme-boot.js";
import { Toolbar } from "./shared/toolbar.js";
import { parseMessage, ReconnectingSocket } from "./shared/ws-client.js";

const DOT_AFTER_MS = 3000;

class Overlay {
  private readonly state = new CaptionState();
  private readonly dot = byId("conn", HTMLDivElement);
  private readonly debug = byId("debug", HTMLPreElement);
  private readonly host = byId("captions", HTMLDivElement);
  private readonly rollup: RollupView | null = null;
  private blocks: BlockView | null = null;
  private blocksLang: string | null = null;
  private toolbar: Toolbar | null = null;
  private shown: TrackId | null = null;
  private connected = false;
  private downSince: number | null = Date.now();
  private mode = "speech";
  private readonly inObs = window.obsstudio !== undefined;
  private readonly sock: ReconnectingSocket;

  constructor(
    private readonly p: OverlayParams,
    private readonly theme: BootedTheme,
    private readonly query: URLSearchParams,
  ) {
    const o = theme.options;
    if (o.layout === "rollup") {
      const display: DisplayParams = {
        ...p,
        lines: o.lines,
        size: o.size,
        pos: o.pos,
        bg: o.bg === "none" ? "none" : o.bg === "shadow" ? "shadow" : "band",
        partial: o.partial,
        srcScale: themeNumber(theme.vars, "--cap-src-scale") ?? p.srcScale,
        lineHeight: themeNumber(theme.vars, "--cap-line-height"),
      };
      this.rollup = new RollupView(this.host, display);
    }
    this.sock = new ReconnectingSocket({
      url: () => this.socketUrl(),
      onMessage: (data) => {
        if (typeof data !== "string") return;
        const msg = parseMessage(data);
        if (msg) this.onMessage(msg);
      },
      onState: (s, since) => {
        this.connected = s === "open";
        this.downSince = since;
        this.toolbar?.setState(this.connected ? "live" : "connecting", "");
        this.drawDot();
        if (this.p.debug) this.drawDebug();
      },
    });
  }

  start(): void {
    this.debug.classList.toggle("is-hidden", !this.p.debug);
    this.sock.start();
    setInterval(() => {
      this.drawDot();
      if (this.p.debug) this.drawDebug();
    }, 1000);
  }

  private socketUrl(): string {
    const q = new URLSearchParams();
    if (this.p.session) q.set("session", this.p.session);
    if (this.p.token) q.set("token", this.p.token);
    const qs = q.toString();
    return wsUrl(qs ? `/ws?${qs}` : "/ws");
  }

  private track(): TrackId {
    return this.state.primary ?? "soniox";
  }

  /** Blocks view, created once the session's languages are known (labels, source direction). */
  private ensureBlocks(): BlockView | null {
    if (this.rollup) return null;
    const target = this.state.langs?.targets[0] ?? this.state.session?.to ?? null;
    if (target === null) return this.blocks;
    if (this.blocks && this.blocksLang === target) return this.blocks;
    const o = this.theme.options;
    const auth = authFrom(this.query);
    this.blocks?.root.remove();
    this.toolbar?.root.remove();
    this.blocksLang = target;
    this.blocks = new BlockView(this.host, {
      show: o.show,
      quranAccent: o.quranAccent,
      quranArabic: o.quranArabic,
      partial: o.partial,
      history: o.history && !this.inObs,
      maxBlocks: o.maxBlocks,
      visibleBlocks: o.visibleBlocks,
      pos: o.pos,
      bg: o.bg === "none" || o.bg === "shadow" ? "none" : "panel",
      targetLang: target,
      sourceLang: this.state.langs?.source ?? this.state.session?.from ?? "ar",
      live: true,
      loadOlder: olderLoader(auth),
      exportLinks: (sid) => exportLinks(sid, auth),
    });
    if (toolbarVisible(this.query, o.toolbar, this.inObs)) {
      const view = this.blocks;
      const base = this.theme.vars["--cap-font-size"] ?? `${o.size}px`;
      this.toolbar = new Toolbar(document.body, {
        targetLang: target,
        showSource: o.show === "both",
        quranArabic: o.quranArabic,
        sourceToggle: o.show !== "source",
        onFontStep: (dir) => {
          stepFontScale(base, dir);
          view.refit();
        },
        onShowSource: (on) => view.setShow(on ? "both" : "target"),
        onQuranArabic: (on) => view.setQuranArabic(on),
      });
      this.toolbar.setState(this.connected ? "live" : "connecting", "");
    }
    return this.blocks;
  }

  /** Roll-up: `lang` list → blocks (the session's source language is the source block). */
  private rollupBlocks(): BlockSpec[] | null {
    const source = this.state.langs?.source ?? this.state.session?.from ?? null;
    if (source === null) return null;
    const targets = this.state.langs?.targets ?? [];
    return this.p.langs.map((lang): BlockSpec => {
      if (lang !== source && targets.includes(lang)) return { role: "translation", lang };
      if (lang === source) return { role: "source", lang };
      // from=auto: a language that isn't a target is shown as the (auto-detected) source.
      if (source === "auto") return { role: "source", lang: "auto" };
      return { role: "translation", lang };
    });
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "blocks.snapshot":
        this.ensureBlocks()?.snapshot(msg.blocks, msg.hasMore);
        break;
      case "block.add":
        this.ensureBlocks()?.add(msg.block);
        break;
      case "block.update":
        this.ensureBlocks()?.update(msg.block);
        break;
      case "listening":
        this.blocks?.listening(msg.active, msg.partial);
        break;
      case "mode":
        this.mode = msg.mode;
        break;
      case "session.ended":
        this.blocks?.ended(msg.endedAt, null);
        break;
      default:
        this.onSegments(msg);
    }
    if (this.p.debug) this.drawDebug();
  }

  private onSegments(msg: ServerMessage): void {
    const change = this.state.apply(msg);
    if (change.kind === "hello" || change.kind === "snapshot") this.ensureBlocks();
    if (change.kind === "clear" && this.blocks) {
      if (change.track === "all" || change.track === this.track()) this.blocks.reset();
    }
    const view = this.rollup;
    if (!view) return;
    if (change.kind === "hello" || change.kind === "snapshot") {
      const b = this.rollupBlocks();
      if (b) view.setBlocks(b);
    }
    const t = this.track();
    if (t !== this.shown) {
      this.shown = t;
      view.reset();
    }
    if (change.kind === "clear" && (change.track === "all" || change.track === t)) view.clear();
    if (change.kind === "snapshot" || change.kind === "segments" || change.kind === "clear") {
      view.update(this.state.segments(t));
    }
  }

  private segmentLatency(s: Segment, lang: string): string {
    const started = this.state.session?.startedAt;
    if (started === undefined || s.endMs === null) return "–";
    const end = started + s.endMs;
    const src = s.timing.sourceFinalAt;
    const tr = s.timing.translationFinalAt?.[lang];
    const f = (at: number | undefined): string => (at === undefined ? "–" : fmtMs(at - end));
    return `src ${f(src)} ${lang} ${f(tr)}`;
  }

  private drawDebug(): void {
    const st = this.state.status;
    const t = this.track();
    const target = this.state.langs?.targets[0] ?? "nl";
    const recent = this.rollup
      ? this.state
          .segments(t)
          .slice(-4)
          .map(
            (s) =>
              `  #${s.seq} ${s.closed ? "closed" : "open  "} ${this.segmentLatency(s, target)}`,
          )
      : [];
    const lines = [
      `link     ${this.connected ? "connected" : `down ${this.downSince ? Math.round((Date.now() - this.downSince) / 1000) : 0} s`}`,
      `layout   ${this.rollup ? "rollup" : "blocks"}  preset ${this.theme.presetId}  mode ${this.mode}`,
      `track    ${t}  session ${this.state.session?.id ?? this.p.session ?? "–"}`,
      `status   ${st?.state ?? "–"}  provider ${st?.provider ?? "–"}  audio ${st?.audio.state ?? "–"}`,
      `latency  p50 ${fmtMs(st?.latency.p50Ms)} p95 ${fmtMs(st?.latency.p95Ms)} (n=${st?.latency.n ?? 0})`,
      this.rollup
        ? `blocks   ${this.rollup.blockSpecs.map((b) => `${b.role}:${b.lang}`).join(", ") || "–"}`
        : `blocks   ${this.blocks?.blockCount ?? 0} rendered`,
      ...recent,
    ];
    const text = lines.join("\n");
    if (this.debug.textContent !== text) this.debug.textContent = text;
  }

  private drawDot(): void {
    const showDot =
      this.p.debug ||
      (!this.connected && this.downSince !== null && Date.now() - this.downSince > DOT_AFTER_MS);
    this.dot.classList.toggle("is-hidden", !showDot);
    this.dot.classList.toggle("is-ok", this.connected);
  }
}

async function main(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const theme = await bootTheme(query);
  new Overlay(parseOverlayParams(query), theme, query).start();
}

void main();
