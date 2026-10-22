// The bottom-left corner of a caption page, in OBS too: a status dot and a sound bar.
// - The dot. Green: on (listening or live). Orange: connecting or reconnecting. Red: no captions
//   will come (the screen is switched off, or its link, the microphone or the server does not
//   work). What it means is its tooltip and what screen readers hear.
// - The bar, while the microphone is open: how loud this microphone hears the room. Green:
//   speech, sent to be understood. Orange: sound, but too soft (or not speech). Red: too low.
import "./status-corner.css";
import { el } from "./dom.js";

export type DotState = "on" | "wait" | "off";
export type SoundState = "good" | "soft" | "low";

export class StatusCorner {
  private readonly dot: HTMLSpanElement;
  private readonly text: HTMLSpanElement;
  private readonly bar: HTMLSpanElement;
  private readonly fill: HTMLSpanElement;
  private current: DotState | null = null;

  constructor(host: HTMLElement, lang: string) {
    this.text = el("span", { class: "sdot-text" });
    this.dot = el("span", { class: "sdot", attrs: { role: "status", lang } }, [this.text]);
    this.fill = el("span", { class: "sbar-fill" });
    this.bar = el("span", { class: "sbar", attrs: { "aria-hidden": "true", hidden: "" } }, [
      this.fill,
    ]);
    host.append(el("div", { class: "scorner" }, [this.dot, this.bar]));
  }

  get state(): DotState | null {
    return this.current;
  }

  set(state: DotState, label: string): void {
    this.current = state;
    const cls = `sdot is-${state}`;
    if (this.dot.className !== cls) this.dot.className = cls;
    if (this.text.textContent !== label) this.text.textContent = label;
    if (this.dot.title !== label) this.dot.title = label;
  }

  /** `pct` 0 to 100 of the bar; null hides it (no microphone open). */
  sound(pct: number | null, state: SoundState): void {
    this.bar.hidden = pct === null;
    if (pct === null) return;
    const cls = `sbar is-${state}`;
    if (this.bar.className !== cls) this.bar.className = cls;
    const width = `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
    if (this.fill.style.width !== width) this.fill.style.width = width;
  }
}
