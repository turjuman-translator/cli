// Tools for the app's end-to-end suites (test/e2e/app/): servers from the built binary in temp
// installs whose processes live in the network jail (cli-net-jail.ts: nothing reaches Soniox, a
// key check comes back "unchecked"), page sessions that replay a provider log
// (`run --fake-provider`), one Chrome with a fake microphone and a fresh context per flow, the
// app's own words in English, Dutch and Arabic, and waits that poll the page or the HTTP API.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Locator, Page } from "playwright-core";
import {
  type AppLang,
  type MsgKey,
  message,
  type PluralKey,
  plural,
  type Vars,
} from "../../../web/shared/app-i18n.js";
import { launchChrome, openPage, type WatchedPage } from "./browser.js";
import { freePort, type Instance, makeInstance, randomToken, writeWav } from "./instance.js";
import { REPO } from "./paths.js";
import { type Server, startServer } from "./server.js";

/** The preload that keeps a server off the network (shared with the CLI suites). */
const JAIL = fileURLToPath(new URL("./cli-net-jail.ts", import.meta.url));

/** A provider log whose first caption block closes after ≈ 3.5 s of audio. */
export const PAUSES = join(REPO, "test", "fixtures", "soniox-tts-pauses.jsonl");
/** How the first caption block of that log begins (its Dutch translation). */
export const FIRST_CAPTION = "In de naam van Allah";

/** Never real keys: the jail blocks the key check and the provider log replaces Soniox. */
export const FAKE_KEY = "fake-soniox-key-e2e-0000000000000001";
export const FAKE_KEY_2 = "fake-soniox-key-e2e-0000000000000002";

/** Things to undo after a test file, in reverse order (a failure never stops the rest). */
export class Cleanup {
  private readonly fns: Array<() => unknown> = [];

  add(fn: () => unknown): void {
    this.fns.push(fn);
  }

  async run(): Promise<void> {
    for (const fn of this.fns.reverse()) {
      try {
        await fn();
      } catch {
        // keep cleaning up
      }
    }
    this.fns.length = 0;
  }
}

/** One outgoing connection the jail saw (to another computer than this one). */
export interface NetAttempt {
  host: string;
  port: number;
  action: "blocked" | "redirected";
}

export interface AppServer extends Server {
  inst: Instance;
  /** The admin token made for it (in config.yaml when its `yaml` puts it there). */
  token: string;
  /** Every connection to another computer the server tried: blocked, or sent to a local
   *  stand-in when E2E_NET_REDIRECT names one. */
  netAttempts(): NetAttempt[];
}

/** A hosted server (the website and the app for many mosques) with open sign-up. */
export function hostedYaml(port: number, token: string): string {
  return `mode: hosted\nserver:\n  port: ${port}\n  token: ${token}\nhosted:\n  signup: open\nquran:\n  enabled: false\n`;
}

/** A self-hosted server on this computer only (exposure local, the default). */
export function localYaml(port: number): string {
  return `server:\n  port: ${port}\nquran:\n  enabled: false\n`;
}

/** Exposure lan on 127.0.0.1 (no HTTPS needed there): caption pages need an access key. */
export function lanYaml(port: number, token: string): string {
  return `server:\n  port: ${port}\n  exposure: lan\n  token: ${token}\nquran:\n  enabled: false\n`;
}

/**
 * `turjuman run --fake-provider <log> [args]` in a fresh install inside the network jail. `yaml`
 * gets the free port and the generated admin token.
 */
export async function appServer(
  cleanup: Cleanup,
  opts: {
    yaml: (port: number, token: string) => string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    /** Write files into the install's folder before the server starts. */
    prepare?: (dir: string) => void;
  },
): Promise<AppServer> {
  const port = await freePort();
  const token = randomToken();
  const inst = makeInstance({ yaml: opts.yaml(port, token) });
  cleanup.add(() => inst.remove());
  opts.prepare?.(inst.dir);
  const netLog = join(inst.dir, "net.log");
  Object.assign(inst.env, {
    NODE_OPTIONS: [inst.env.NODE_OPTIONS, `--import="${JAIL}"`].filter(Boolean).join(" "),
    E2E_NET_LOG: netLog,
    E2E_NET_REDIRECT: "",
  });
  const srv = await startServer(inst, port, {
    args: ["--fake-provider", PAUSES, ...(opts.args ?? [])],
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  cleanup.add(() => srv.stop());
  return {
    ...srv,
    inst,
    token,
    netAttempts: () =>
      existsSync(netLog)
        ? readFileSync(netLog, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as NetAttempt)
        : [],
  };
}

/** One Chrome for a test file: its fake microphone plays a looping tone (speech to the VAD). */
export async function chrome(cleanup: Cleanup, dir: string): Promise<Browser> {
  const wav = writeWav(join(dir, "mic.wav"), { seconds: 4, tone: true });
  const browser = await launchChrome({ fakeMicWav: wav });
  cleanup.add(() => browser.close());
  return browser;
}

/** A fresh context (own cookies and storage) with one page that records its problems. */
export async function tab(
  browser: Browser,
  base: string,
  opts: { width?: number; height?: number; isMobile?: boolean } = {},
): Promise<WatchedPage> {
  const w = await openPage(browser, opts);
  await w.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await w.page.addInitScript({ content: TOAST_RECORDER });
  return w;
}

/**
 * Runs in every page (a string: this file is type-checked without the DOM library): each toast
 * the page shows is written down, so a test sees it even when the toast is gone again (they hide
 * after a few seconds, and a busy machine may look later than that).
 */
const TOAST_RECORDER = `
window.__toasts = [];
let last = "";
new MutationObserver(() => {
  const node = document.getElementById("toast");
  const text = node === null || node.hidden ? "" : (node.textContent || "").trim();
  if (text !== "" && text !== last) window.__toasts.push(text);
  last = text;
}).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
`;

/** Wait for a toast with this text (each toast counts once). */
export async function toasted(page: Page, text: string, timeoutMs = 10_000): Promise<void> {
  let seen = "";
  await waitUntil(
    () => `the toast "${text}" (toasts so far: ${seen})`,
    async () => {
      const r = (await page.evaluate(
        `(() => { const all = window.__toasts ?? []; const i = all.indexOf(${JSON.stringify(text)}); if (i >= 0) all.splice(i, 1); return { found: i >= 0, all }; })()`,
      )) as { found: boolean; all: string[] };
      seen = JSON.stringify(r.all);
      return r.found;
    },
    timeoutMs,
  );
}

/** The problems a page recorded so far, which are then forgotten. */
export function takeProblems(w: WatchedPage): string[] {
  return w.problems.splice(0, w.problems.length);
}

/** The browser's own console line for a request the server refused with `status`. */
export function refused(status: number): RegExp {
  return new RegExp(
    `^console: Failed to load resource: the server responded with a status of ${status}\\b`,
  );
}

/** The app's words (web/shared/app-i18n.ts) in a language. */
export function say(l: AppLang, key: MsgKey, vars?: Vars): string {
  return message(l, key, vars);
}

/** The app's counted words ("Connected", "3 screens") in a language. */
export function sayN(l: AppLang, key: PluralKey, n: number): string {
  return plural(l, key, n);
}

/** The exact text, as a whole-string pattern for Playwright's text matching. */
export function exactly(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

/** Poll `check` until it returns something other than undefined/false. */
export async function waitUntil<T>(
  what: string | (() => string),
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${typeof what === "string" ? what : what()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Wait until the locator's text (trimmed) matches. */
export async function textOf(
  locator: Locator,
  want: string | RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  let last = "";
  return waitUntil(
    () => `"${String(want)}" in ${String(locator)} (last: "${last}")`,
    async () => {
      // No auto-wait: an element that is gone (or not there yet) reads as "".
      last =
        (await locator.count()) > 0
          ? ((await locator
              .first()
              .textContent({ timeout: 1000 })
              .catch(() => "")) ?? "")
          : "";
      last = last.trim();
      return (typeof want === "string" ? last === want : want.test(last)) ? last : undefined;
    },
    timeoutMs,
  );
}

/** What the caption page publishes about itself (window.__captionStats). */
export interface CaptionStats {
  state: string;
  sessionId: string | null;
  /** Caption blocks on the page (layout blocks). */
  blocks: number;
  /** Final source segments seen live (layout rollup). */
  finals: number;
  screen: { guid: string; state: string } | null;
}

export function captionStats(page: Page): Promise<CaptionStats | null> {
  // A string: this file is type-checked without the DOM library.
  return page.evaluate("window.__captionStats ?? null") as Promise<CaptionStats | null>;
}

/** Wait for the caption page's stats to satisfy `ok`. */
export async function waitForStats(
  page: Page,
  what: string,
  ok: (s: CaptionStats) => boolean,
  timeoutMs = 20_000,
): Promise<CaptionStats> {
  let last: CaptionStats | null = null;
  return waitUntil(
    () => `${what} (last stats: ${JSON.stringify(last)})`,
    async () => {
      // A page that is navigating (a screen reloading its link) has no stats for a moment.
      last = await captionStats(page).catch(() => null);
      return last !== null && ok(last) ? last : undefined;
    },
    timeoutMs,
  );
}

/** <html lang> and <html dir> of a page. */
export async function htmlLangDir(page: Page): Promise<{ lang: string; dir: string }> {
  return (await page.evaluate(
    "({ lang: document.documentElement.lang, dir: document.documentElement.dir })",
  )) as { lang: string; dir: string };
}

/** A CSS custom property as the page computes it on <html>. */
export async function cssVar(page: Page, name: string): Promise<string> {
  return String(
    await page.evaluate(
      `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`,
    ),
  );
}

/** The login cookie of a browser context, for API checks next to the page. */
export async function cookieHeader(w: WatchedPage): Promise<string> {
  const cookies = await w.context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** A JSON request to the server, like the app makes it (same origin, JSON body). */
export async function api(
  base: string,
  method: string,
  path: string,
  opts: { cookie?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (method !== "GET") headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(opts.body ?? {}) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    // not JSON: the text itself
  }
  return { status: res.status, body };
}
