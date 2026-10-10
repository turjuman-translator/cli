// Loading an app page under happy-dom: the page's own HTML from web/<page>.html, the address it
// was opened on, the app language, the fake server behind fetch(), and navigation caught (a
// redirect is recorded, never followed: happy-dom would fetch the address). Pages start on
// import, so each test imports a fresh copy after vi.resetModules().
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MockInstance, vi } from "vitest";
import type { FakeServer } from "./web-app-server.js";

const WEB = join(import.meta.dirname, "..", "..", "..", "web");

export type PageName = "login" | "signup" | "admin" | "keys" | "archive";

export interface Navigation {
  assign: MockInstance<(url: string | URL) => void>;
  replace: MockInstance<(url: string | URL) => void>;
  reload: MockInstance<() => void>;
  /** location.href = … (and location.search = …, which sets it). */
  href: MockInstance<(url: string) => void>;
  /** window.open(): how happy-dom follows a link that was clicked. */
  open: ReturnType<typeof vi.fn>;
}

/** Put the page's <body> from its template into the document. */
export function loadBody(page: PageName): void {
  const html = readFileSync(join(WEB, `${page}.html`), "utf8");
  const m = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  if (!m) throw new Error(`no <body> in ${page}.html`);
  document.body.innerHTML = m[2] ?? "";
  document.body.className = /class="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "";
}

export function setUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
}

let realOpen: typeof window.open | null = null;

export function trapNavigation(): Navigation {
  const open = vi.fn(() => null);
  // Assigned, not stubbed: happy-dom's own window (which a clicked link calls) gets it too.
  realOpen ??= window.open;
  window.open = open;
  return {
    assign: vi.spyOn(window.location, "assign").mockImplementation(() => {}),
    replace: vi.spyOn(window.location, "replace").mockImplementation(() => {}),
    reload: vi.spyOn(window.location, "reload").mockImplementation(() => {}),
    href: vi.spyOn(window.location, "href", "set").mockImplementation(() => {}),
    open,
  };
}

type Listener = [EventTarget, string, EventListenerOrEventListenerObject, unknown];
const added: Listener[] = [];
const originals = new Map<EventTarget, EventTarget["addEventListener"]>();

/** Listeners a page puts on window and document outlive its test: they are taken off again in
 *  cleanup(), so an older copy of a page never answers a later test's events. */
function trackListeners(): void {
  for (const target of [window, document] as EventTarget[]) {
    if (originals.has(target)) continue;
    const original = target.addEventListener;
    originals.set(target, original);
    (target as { addEventListener: EventTarget["addEventListener"] }).addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener) added.push([target, type, listener, options]);
      return original.call(target, type, listener, options);
    } as EventTarget["addEventListener"];
  }
}

/** Let every pending promise chain run (real setImmediate: fake timers don't hold it). */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Fake timers for the page's own timeouts (poll, toast); setImmediate stays real for settle(). */
export function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: new Date("2026-10-09T12:00:00Z"),
  });
}

export interface Opened {
  nav: Navigation;
  server: FakeServer;
}

/**
 * Open a page: `url` is the address (default http://localhost:3000), `lang` the app language the
 * browser remembered (null: none), and `load` imports the page module (a literal import, so the
 * bundler sees it).
 */
export async function openPage(
  page: PageName,
  server: FakeServer,
  load: () => Promise<unknown>,
  opts: { url?: string; lang?: "en" | "nl" | "ar" | null } = {},
): Promise<Opened> {
  vi.resetModules();
  trackListeners();
  setUrl(opts.url ?? "http://localhost:3000/");
  try {
    if (opts.lang) localStorage.setItem("tj-app-lang", opts.lang);
    else localStorage.removeItem("tj-app-lang");
    localStorage.removeItem("tj-lang");
  } catch {
    // no storage
  }
  document.title = "";
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
  loadBody(page);
  vi.stubGlobal("fetch", server.fetch);
  const nav = trapNavigation();
  await load();
  await settle();
  return { nav, server };
}

/** After each test: listeners off, timers and spies back. */
export function cleanup(): void {
  for (const [target, type, listener, options] of added.splice(0)) {
    target.removeEventListener(type, listener, options as EventListenerOptions);
  }
  if (realOpen) window.open = realOpen;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of document.querySelectorAll("dialog")) d.remove();
  document.body.innerHTML = "";
}

// --- reading and driving the page ------------------------------------------------------------

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`no ${sel}`);
  return node;
}

export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(sel)];
}

export function text(sel: string, root: ParentNode = document): string {
  return ($(sel, root).textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Type into a field (value + an input event, as a person typing does). */
export function type(sel: string | HTMLInputElement, value: string): void {
  const input = typeof sel === "string" ? $<HTMLInputElement>(sel) : sel;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Click and let the page answer. */
export async function click(sel: string | Element): Promise<void> {
  const node = typeof sel === "string" ? $(sel) : sel;
  (node as HTMLElement).click();
  await settle();
}

/** The open sheet (a <dialog>), the last one opened. */
export function sheet(): HTMLDialogElement {
  const all = $$<HTMLDialogElement>("dialog[open]");
  const last = all[all.length - 1];
  if (!last) throw new Error("no open sheet");
  return last;
}

/** A button in `root` by its visible text. */
export function buttonByText(label: string, root: ParentNode = document): HTMLButtonElement {
  const b = $$<HTMLButtonElement>("button", root).find(
    (x) => (x.textContent ?? "").replace(/\s+/g, " ").trim() === label,
  );
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

/** The toast's text ("" when hidden). */
export function toastText(): string {
  const node = document.getElementById("toast");
  return node && !node.hidden ? (node.textContent ?? "").trim() : "";
}
