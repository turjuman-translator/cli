// Caption toolbar: "Live vertaling" + live dot, language chip, A− / A+, toggles (source text,
// Quran Arabic) and fullscreen. Labels follow the target language.
import "./toolbar.css";
import { el } from "./dom.js";
import { uiLabels } from "./i18n.js";

export type ToolbarState = "live" | "idle" | "connecting" | "error";

export interface ToolbarOptions {
  targetLang: string;
  /** Replaces "Live vertaling" (e.g. the archive). */
  label?: string;
  showSource: boolean;
  quranArabic: boolean;
  /** Hide the source toggle (e.g. show=source pages). */
  sourceToggle?: boolean;
  meter?: boolean;
  onFontStep(dir: -1 | 1): void;
  onShowSource(on: boolean): void;
  onQuranArabic(on: boolean): void;
}

export class Toolbar {
  readonly root: HTMLDivElement;
  private readonly dot: HTMLSpanElement;
  private readonly stateText: HTMLSpanElement;
  private readonly level: HTMLSpanElement | null = null;

  constructor(host: HTMLElement, o: ToolbarOptions) {
    const t = uiLabels(o.targetLang);
    this.dot = el("span", { class: "tb-dot s-connecting" });
    this.stateText = el("span", { class: "tb-state" });
    const chip = el("span", { class: "tb-chip", text: o.targetLang.toUpperCase().slice(0, 5) });
    const live = el("span", { class: "tb-live" }, [
      this.dot,
      el("span", { class: "tb-label", text: o.label ?? t.live }),
    ]);
    const btn = (text: string, title: string, onClick: (b: HTMLButtonElement) => void) => {
      const b = el("button", {
        class: "tb-btn",
        text,
        attrs: { type: "button", title, "aria-label": title },
      });
      b.addEventListener("click", () => onClick(b));
      return b;
    };
    const toggle = (text: string, on: boolean, onChange: (v: boolean) => void) => {
      const b = btn(text, text, (self) => {
        const next = self.getAttribute("aria-pressed") !== "true";
        self.setAttribute("aria-pressed", String(next));
        onChange(next);
      });
      b.setAttribute("aria-pressed", String(on));
      return b;
    };
    const smaller = btn("A−", t.smaller, () => o.onFontStep(-1));
    const larger = btn("A+", t.larger, () => o.onFontStep(1));
    const source = toggle(t.source, o.showSource, o.onShowSource);
    source.hidden = o.sourceToggle === false;
    const quran = toggle(t.quran, o.quranArabic, o.onQuranArabic);
    const full = btn("⛶", t.fullscreen, () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void document.documentElement.requestFullscreen?.().catch(() => undefined);
    });
    full.hidden = !document.fullscreenEnabled;

    const parts: HTMLElement[] = [live, chip, this.stateText];
    if (o.meter) {
      this.level = el("span", { class: "tb-level" });
      parts.push(el("span", { class: "tb-meter", attrs: { title: "Microphone" } }, [this.level]));
    }
    parts.push(el("span", { class: "tb-sep" }), smaller, larger, source, quran, full);
    this.root = el("div", { class: "tb", attrs: { role: "toolbar" } }, parts);
    host.append(this.root);
  }

  setState(state: ToolbarState, text: string, title = ""): void {
    const cls = `tb-dot s-${state}`;
    if (this.dot.className !== cls) this.dot.className = cls;
    if (this.stateText.textContent !== text) this.stateText.textContent = text;
    this.dot.title = title || text;
  }

  /** Microphone level, −60 … 0 dBFS. */
  setLevel(rmsDbfs: number, speaking: boolean): void {
    if (!this.level) return;
    const pct = Math.max(0, Math.min(100, ((rmsDbfs + 60) / 60) * 100));
    this.level.style.width = `${pct.toFixed(0)}%`;
    this.level.style.background = speaking ? "#34d17a" : "#4fa3ff";
  }
}
