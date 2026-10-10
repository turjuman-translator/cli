// The look editor (web/customize.ts) in the fake browser of builder-dom.ts: start it against a
// server's API, and find its controls the way a person does (group title, then the label).
import type { HTMLElement as HappyHTMLElement } from "happy-dom";
import {
  $,
  all,
  type Browser,
  type BrowserOptions,
  byId,
  type I18n,
  me,
  openBrowser,
  settle,
  startPage,
} from "./builder-dom.js";

export const LOOK = "http://127.0.0.1:8765/app/look";

export interface CustomPreset {
  id: string;
  name: string;
  description: string;
  vars: Record<string, string>;
  options: Record<string, unknown>;
}

export function customPreset(
  id: string,
  name: string,
  over: Partial<CustomPreset> = {},
): CustomPreset {
  return {
    id,
    name,
    description: "",
    vars: { "--cap-text-color": "#ffcc00" },
    options: { layout: "blocks" },
    ...over,
  };
}

export interface LookServer {
  mode?: "local" | "hosted";
  loggedIn?: boolean;
  role?: "owner" | "admin" | "user";
  custom?: CustomPreset[];
  default?: string;
}

/** GET /api/auth/state, /api/auth/me and /api/presets of a server. */
export function lookServer(b: Browser, s: LookServer = {}): void {
  b.api
    .on("GET", "/api/auth/state", {
      body: {
        setupRequired: false,
        mode: s.mode ?? "local",
        signup: false,
        loggedIn: s.loggedIn ?? true,
      },
    })
    .on("GET", "/api/auth/me", { body: { me: me(s.role ?? "admin") } })
    .on("GET", "/api/presets", {
      body: { builtin: [], custom: s.custom ?? [], default: s.default ?? "mosque-dark" },
    });
}

export interface LookBoot {
  b: Browser;
  i18n: I18n;
}

export interface LookOptions extends Partial<BrowserOptions>, LookServer {
  setup?: (b: Browser) => void;
  /** Leave the first frame undrawn (the page is still waiting for it). */
  noFrame?: boolean;
}

let current: Browser | null = null;

export function lookBrowser(): Browser {
  if (current === null) throw new Error("bootLook() first");
  return current;
}

/** Open the look editor, let its requests finish and draw the first frame. */
export async function bootLook(opts: LookOptions = {}): Promise<LookBoot> {
  const b = openBrowser("customize", { url: LOOK, ...opts });
  current = b;
  lookServer(b, opts);
  opts.setup?.(b);
  const i18n = await startPage("customize");
  await settle();
  if (opts.noFrame !== true) b.frames.flush();
  return { b, i18n };
}

/** Let a change reach the screen (the editor draws in the next animation frame). */
export function frame(): void {
  lookBrowser().frames.flush();
}

/** The theme query of the "Look only" field ("" when nothing differs from the look). */
export function themeQs(): string {
  const v = byId<{ value: string }>("url-theme").value;
  return v.startsWith("(") ? "" : v;
}

export function themeParams(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(themeQs()));
}

/** A group of controls (<details>) by its title. */
export function group(title: string): HappyHTMLElement {
  const g = all("#groups details.grp").find(
    (d) => d.querySelector(".grp-title")?.textContent === title,
  );
  if (g === undefined) throw new Error(`no group "${title}"`);
  return g;
}

/** A control row by its group title and label. */
export function control(groupTitle: string, label: string): HappyHTMLElement {
  const row = [...group(groupTitle).querySelectorAll(".ctl")].find(
    (c) => c.querySelector(".ctl-label")?.textContent === label,
  );
  if (row === undefined) throw new Error(`no control "${label}" in "${groupTitle}"`);
  return row as unknown as HappyHTMLElement;
}

/** An element inside a control row. */
export function part<T = HappyHTMLElement>(row: HappyHTMLElement, selector: string): T {
  const node = row.querySelector(selector);
  if (node === null) throw new Error(`no ${selector} in the control`);
  return node as unknown as T;
}

/** The read-out next to a control's label. */
export function readout(row: HappyHTMLElement): string {
  return row.querySelector(".ctl-value")?.textContent ?? "";
}

export function modified(row: HappyHTMLElement): boolean {
  return row.classList.contains("is-mod");
}

/** A look card in the gallery (built-in) or under "Your looks" by its name. */
export function card(name: string): HappyHTMLElement {
  const c = all(".pcard").find((x) => x.querySelector(".pcard-name")?.textContent === name);
  if (c === undefined) throw new Error(`no look "${name}"`);
  return c;
}

export function toastText(): string {
  return $("#toast").textContent ?? "";
}
