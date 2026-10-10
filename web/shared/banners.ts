// Readable error/warning banners on a transparent page (inside OBS there is no console).
import { el } from "./dom.js";

export type BannerKind = "error" | "warn" | "info";

export interface BannerAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

interface Entry {
  node: HTMLDivElement;
  sig: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Banners {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly host: HTMLElement) {}

  /** Show (or update) the banner `key`; `ttlMs` hides it automatically. */
  set(
    key: string,
    kind: BannerKind,
    text: string,
    opts: { action?: BannerAction; ttlMs?: number } = {},
  ): void {
    const sig = `${kind}|${text}|${opts.action?.label ?? ""}`;
    let entry = this.entries.get(key);
    if (entry && entry.sig !== sig) {
      entry.node.remove();
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const node = el("div", { class: `banner ${kind}`, text });
      const action = opts.action;
      if (action?.href) {
        node.append(" ", el("a", { text: action.label, attrs: { href: action.href } }));
      } else if (action?.onClick) {
        const btn = el("button", { text: action.label, attrs: { type: "button" } });
        btn.addEventListener("click", action.onClick);
        node.append(btn);
      }
      this.host.append(node);
      entry = { node, sig, timer: null };
      this.entries.set(key, entry);
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (opts.ttlMs !== undefined) {
      entry.timer = setTimeout(() => this.clear(key), opts.ttlMs);
    }
  }

  clear(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.node.remove();
    this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }
}
