// The builder (web/picker.ts) in the fake browser of builder-dom.ts: start it against a local
// server's API, and small readers for what a person sees on its steps.
import {
  $,
  type Browser,
  type BrowserOptions,
  byId,
  change,
  doc,
  type I18n,
  languagesReply,
  me,
  openBrowser,
  settle,
  startPage,
} from "./builder-dom.js";

export const LOCAL = "http://127.0.0.1:8765/";
export const LAN = "http://192.168.1.20:8765/";

/** A local install: logged out unless asked, the test languages, only the built-in looks. */
export function localServer(b: Browser, opts: { loggedIn?: boolean; hosted?: boolean } = {}): void {
  b.api
    .on("GET", "/api/auth/state", {
      body: {
        setupRequired: false,
        mode: opts.hosted ? "hosted" : "local",
        signup: false,
        loggedIn: opts.loggedIn ?? false,
      },
    })
    .on("GET", "/api/auth/me", { body: { me: me() } })
    .on("GET", "/api/languages", languagesReply())
    .on("GET", "/api/presets", { body: { builtin: [], custom: [], default: "mosque-dark" } });
}

export interface Boot {
  b: Browser;
  i18n: I18n;
}

export interface BootOptions extends Partial<BrowserOptions> {
  /** Change the fake server before the page starts. */
  setup?: (b: Browser) => void;
  loggedIn?: boolean;
  hosted?: boolean;
}

let current: Browser | null = null;

/** The browser of the last boot(). */
export function currentBrowser(): Browser {
  if (current === null) throw new Error("boot() first");
  return current;
}

/** Open the builder and let its first requests finish. */
export async function boot(opts: BootOptions = {}): Promise<Boot> {
  const b = openBrowser("picker", { url: LOCAL, ...opts });
  current = b;
  localServer(b, {
    ...(opts.loggedIn === undefined ? {} : { loggedIn: opts.loggedIn }),
    ...(opts.hosted === undefined ? {} : { hosted: opts.hosted }),
  });
  opts.setup?.(b);
  const i18n = await startPage("picker");
  await settle();
  return { b, i18n };
}

export const value = (id: string): string => byId<{ value: string }>(id).value;
export const checked = (id: string): boolean => byId<{ checked: boolean }>(id).checked;
export const hidden = (id: string): boolean => byId<{ hidden: boolean }>(id).hidden;
export const disabled = (id: string): boolean => byId<{ disabled: boolean }>(id).disabled;
export const click = (id: string): void => byId<{ click(): void }>(id).click();
export const text = (id: string): string => (byId(id).textContent ?? "").trim();
export const step = (): string => doc.body.dataset.step ?? "";
/** The link line under the preview (host + path, the key hidden). */
export const linkSoFar = (): string => text("link-so-far");
/** The full caption link on the last step. */
export const link = (): URL => new URL(value("url"));

/** Press Next `times` times. */
export async function next(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) click("next");
  await settle(1);
}

/** Pick a radio card (layout, look, lines) the way a click does. */
export function radio(name: string, v: string): void {
  change($(`input[name=${name}][value="${v}"]`), true);
}

/** A cell of the 3×3 placement grid by its label ("Top · Left"). */
export function cell(label: string): { click(): void; focus(): void } {
  return $(`#place-mount .plc-cell[aria-label="${label}"]`) as unknown as {
    click(): void;
    focus(): void;
  };
}
