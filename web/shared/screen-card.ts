// Screen status card: shown instead of captions while a signed screen is switched off
// ("Live vertaling staat uit"), or when its link is invalid / required. Calm by design: a slow
// breathing indicator (off) or a still one (link problems), no flashing.
import "./screen-card.css";
import { dirFor } from "../../src/shared/lang.js";
import { el } from "./dom.js";
import { uiLabels } from "./i18n.js";

export type ScreenCardKind = "off" | "invalid" | "required";

export class ScreenCard {
  private readonly wrap: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly body: HTMLParagraphElement;
  private readonly name: HTMLParagraphElement;
  private kind: ScreenCardKind | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    host: HTMLElement,
    private readonly targetLang: string,
  ) {
    this.title = el("h1", { class: "scr-title" });
    this.body = el("p", { class: "scr-body" });
    this.name = el("p", { class: "scr-name" });
    const pulse = el("div", { class: "scr-pulse", attrs: { "aria-hidden": "true" } }, [
      el("span", { class: "scr-ring" }),
      el("span", { class: "scr-dot" }),
    ]);
    const card = el("div", { class: "scr-card", attrs: { lang: targetLang } }, [
      pulse,
      this.title,
      this.body,
      this.name,
    ]);
    card.dir = dirFor(targetLang);
    this.wrap = el("div", { class: "scr-wrap", attrs: { role: "status", "aria-live": "polite" } }, [
      card,
    ]);
    this.wrap.hidden = true;
    host.append(this.wrap);
  }

  get shown(): ScreenCardKind | null {
    return this.kind;
  }

  show(kind: ScreenCardKind, screenName: string | null): void {
    const t = uiLabels(this.targetLang);
    const [title, body] =
      kind === "off"
        ? [t.screenOffTitle, t.screenOffBody]
        : kind === "invalid"
          ? [t.linkInvalidTitle, t.linkInvalidBody]
          : [t.screenRequiredTitle, t.screenRequiredBody];
    if (this.title.textContent !== title) this.title.textContent = title;
    if (this.body.textContent !== body) this.body.textContent = body;
    const name = screenName ?? "";
    if (this.name.textContent !== name) this.name.textContent = name;
    this.wrap.classList.toggle("is-off", kind === "off");
    this.wrap.classList.toggle("is-problem", kind !== "off");
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.kind === null) {
      this.wrap.hidden = false;
      void this.wrap.offsetHeight; // start the fade-in from opacity 0
    }
    this.wrap.classList.add("is-shown");
    this.kind = kind;
  }

  hide(): void {
    if (this.kind === null) return;
    this.kind = null;
    this.wrap.classList.remove("is-shown");
    // No timer runs here: show() cancels it, and a second hide() returns above.
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.wrap.hidden = true;
    }, 500);
  }
}
