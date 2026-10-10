// A small browser for the builder (web/picker.ts) and the look editor (web/customize.ts) under
// happy-dom: the page's own HTML, a fake of the server's API (fetch), animation frames that run
// when the test says so, element sizes, a ResizeObserver that fires on demand, and a fake
// microphone (getUserMedia, enumerateDevices, AudioContext).
// Types come from happy-dom itself (the root tsconfig has no DOM library), and the pages are
// imported by a computed path so the type checker leaves the browser code to web/tsconfig.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as macrotask } from "node:timers/promises";
import type { HTMLElement as HappyHTMLElement, Window as HappyWindow } from "happy-dom";
import { vi } from "vitest";

export const win = globalThis as unknown as HappyWindow;
export const doc = win.document;

// --- the page ------------------------------------------------------------------------------------

export type Page = "picker" | "customize";

/** Put the <body> of web/<page>.html (with its class) into the document. */
export function loadBody(page: Page): void {
  const html = readFileSync(join(process.cwd(), "web", `${page}.html`), "utf8");
  const m = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  if (m === null) throw new Error(`web/${page}.html has no <body>`);
  for (const a of [...doc.body.attributes]) doc.body.removeAttribute(a.name);
  const cls = /class="([^"]*)"/.exec(m[1] ?? "")?.[1];
  if (cls !== undefined) doc.body.className = cls;
  doc.body.innerHTML = m[2] ?? "";
  doc.documentElement.removeAttribute("lang");
  doc.documentElement.removeAttribute("dir");
  doc.title = "Turjuman";
}

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

/** A promise the test settles (a reply that arrives when the test says so). */
export function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every pending promise (fetch replies, then-chains) run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await macrotask();
}

export function $(selector: string): HappyHTMLElement {
  const node = doc.querySelector(selector);
  if (node === null) throw new Error(`no ${selector} on the page`);
  return node as unknown as HappyHTMLElement;
}

export function byId<T = HappyHTMLElement>(id: string): T {
  const node = doc.getElementById(id);
  if (node === null) throw new Error(`no #${id} on the page`);
  return node as unknown as T;
}

export function all(selector: string): HappyHTMLElement[] {
  return [...doc.querySelectorAll(selector)] as unknown as HappyHTMLElement[];
}

export function fire(node: unknown, type: string): void {
  (node as HappyHTMLElement).dispatchEvent(new win.Event(type, { bubbles: true }));
}

/** Set a field's value and fire `input` (sliders, text fields). */
export function input(node: unknown, value: string): void {
  (node as { value: string }).value = value;
  fire(node, "input");
}

/** Set a select's (or checkbox's) state and fire `change`. */
export function change(node: unknown, value?: string | boolean): void {
  if (typeof value === "boolean") (node as { checked: boolean }).checked = value;
  else if (value !== undefined) (node as { value: string }).value = value;
  fire(node, "change");
}

export function key(
  node: unknown,
  name: string,
  init: { isComposing?: boolean; cancelable?: boolean } = {},
): HappyKeyboardEvent {
  const ev = new win.KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: init.cancelable ?? true,
    isComposing: init.isComposing ?? false,
  });
  (node as HappyHTMLElement).dispatchEvent(ev);
  return ev as unknown as HappyKeyboardEvent;
}

interface HappyKeyboardEvent {
  defaultPrevented: boolean;
}

// --- listeners on window and document (removed between tests: each test imports a fresh page) ----

type Listener = Parameters<HappyWindow["addEventListener"]>[1];
const added: Array<{ target: "window" | "document"; type: string; fn: Listener }> = [];

function trackListeners(): void {
  for (const which of ["window", "document"] as const) {
    const target = which === "window" ? win : doc;
    const original = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, fn, options) => {
      added.push({ target: which, type, fn });
      original(type, fn, options);
    });
  }
}

function removeListeners(): void {
  for (const { target, type, fn } of added.splice(0)) {
    (target === "window" ? win : doc).removeEventListener(type, fn);
  }
}

// --- animation frames ----------------------------------------------------------------------------

export class Frames {
  now = 1000;
  private next = 1;
  private readonly queue = new Map<number, (t: number) => void>();

  install(): void {
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void): number => {
      const id = this.next++;
      this.queue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      this.queue.delete(id);
    });
    vi.spyOn(win.performance, "now").mockImplementation(() => this.now);
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Run the frames asked for so far, `dt` ms after the last ones. */
  flush(dt = 16): void {
    this.now += dt;
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const cb of due) cb(this.now);
  }
}

// --- sizes and ResizeObserver --------------------------------------------------------------------

const widths = new WeakMap<object, number>();
const heights = new WeakMap<object, number>();
let defaultWidth = 320;
let defaultHeight = 180;

/** Every element's clientWidth/clientHeight unless set per element. */
export function setDefaultSize(w: number, h = Math.round((w * 9) / 16)): void {
  defaultWidth = w;
  defaultHeight = h;
}

export function setSize(node: unknown, w: number, h?: number): void {
  widths.set(node as object, w);
  if (h !== undefined) heights.set(node as object, h);
}

export class FakeResizeObserver {
  static readonly all: FakeResizeObserver[] = [];
  readonly targets = new Set<unknown>();
  constructor(private readonly cb: (entries: Array<{ target: unknown }>) => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(t: unknown): void {
    this.targets.add(t);
  }
  unobserve(t: unknown): void {
    this.targets.delete(t);
  }
  disconnect(): void {
    this.targets.clear();
  }
  /** The observed elements changed size (all of them, or just `target`). */
  static resize(target?: unknown): void {
    for (const o of FakeResizeObserver.all) {
      const entries = [...o.targets].filter((t) => target === undefined || t === target);
      if (entries.length > 0) o.cb(entries.map((t) => ({ target: t })));
    }
  }
}

function installSizes(): void {
  const proto = win.HTMLElement.prototype as object;
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get(this: object) {
      return widths.get(this) ?? defaultWidth;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: object) {
      return heights.get(this) ?? defaultHeight;
    },
  });
  FakeResizeObserver.all.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}

// --- the server's API ----------------------------------------------------------------------------

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignalLike | undefined;
}

export interface AbortSignalLike {
  aborted: boolean;
  addEventListener(type: "abort", fn: () => void): void;
}

export type Reply =
  | { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> }
  | "network-error";

type Handler = (call: Call) => Reply | Promise<Reply>;

class FakeResponse {
  constructor(
    readonly status: number,
    private readonly bodyText: string,
    private readonly hdrs: Record<string, string>,
  ) {}
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  readonly headers = {
    get: (name: string): string | null => {
      const k = Object.keys(this.hdrs).find((h) => h.toLowerCase() === name.toLowerCase());
      return k === undefined ? null : (this.hdrs[k] ?? null);
    },
  };
  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }
  async text(): Promise<string> {
    return this.bodyText;
  }
}

/** The server's API in memory: replies per "METHOD /path", and every request it got. */
export class FakeApi {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Handler>();

  on(method: string, path: string, reply: Reply | Handler): this {
    this.routes.set(`${method} ${path}`, typeof reply === "function" ? reply : () => reply);
    return this;
  }

  /** The requests to `METHOD /path` (the query string is part of the path). */
  sent(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  readonly fetch = async (
    input: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignalLike;
    } = {},
  ): Promise<FakeResponse> => {
    const method = init.method ?? "GET";
    const call: Call = {
      method,
      path: input,
      headers: { ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    this.calls.push(call);
    const handler = this.routes.get(`${method} ${input.split("?")[0]}`);
    const reply = handler
      ? await handler(call)
      : { status: 404, body: { ok: false, message: "Not found" } };
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    const raw = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new FakeResponse(reply.status ?? 200, raw, reply.headers ?? {});
  };
}

export const LANGS = [
  { code: "ar", en: "Arabic", native: "العربية" },
  { code: "en", en: "English", native: "English" },
  { code: "nl", en: "Dutch", native: "Nederlands" },
  { code: "tr", en: "Turkish", native: "Türkçe" },
  { code: "fr", en: "French", native: "Français" },
];

export function languagesReply(): Reply {
  return {
    body: {
      auto: true,
      sources: LANGS,
      targets: LANGS,
      defaults: { from: "ar", to: "nl", show: "target" },
      keyRequired: false,
    },
  };
}

export function me(role: "owner" | "admin" | "user" = "admin"): Record<string, unknown> {
  return {
    id: "u1",
    username: "imam",
    displayName: "Imam Yusuf",
    role,
    orgId: "local",
    email: null,
  };
}

// --- the microphone ------------------------------------------------------------------------------

export class FakeTrack {
  stopped = false;
  constructor(readonly deviceId: string) {}
  stop(): void {
    this.stopped = true;
  }
  getSettings(): { deviceId: string } {
    return { deviceId: this.deviceId };
  }
}

export class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export interface FakeDevice {
  kind: string;
  label: string;
  deviceId: string;
}

/** navigator.mediaDevices: labels stay hidden until getUserMedia was allowed once. */
export class FakeMedia {
  devices: FakeDevice[] = [
    { kind: "audioinput", label: "Default - USB Mixer", deviceId: "default" },
    { kind: "audioinput", label: "Built-in Microphone", deviceId: "builtin" },
    { kind: "audioinput", label: "USB Mixer", deviceId: "usb" },
    { kind: "audioinput", label: "USB Mixer", deviceId: "usb-2" },
    { kind: "audioinput", label: "Communications", deviceId: "communications" },
    { kind: "audiooutput", label: "Speakers", deviceId: "spk" },
  ];
  granted = false;
  /** Thrown by the next getUserMedia calls (null = allowed). */
  error: unknown = null;
  enumerateError: unknown = null;
  readonly streams: FakeStream[] = [];
  readonly asked: unknown[] = [];
  /** The getUserMedia calls (0 = the first) that wait for release(): a stop can race them. */
  readonly holdCalls = new Set<number>();
  private held: Array<() => void> = [];

  readonly getUserMedia = async (constraints: {
    audio: { deviceId?: { exact: string } };
  }): Promise<FakeStream> => {
    const n = this.asked.length;
    this.asked.push(constraints);
    if (this.holdCalls.has(n)) await new Promise<void>((r) => this.held.push(r));
    if (this.error !== null) throw this.error;
    this.granted = true;
    const stream = new FakeStream([new FakeTrack(constraints.audio.deviceId?.exact ?? "default")]);
    this.streams.push(stream);
    return stream;
  };

  readonly enumerateDevices = async (): Promise<FakeDevice[]> => {
    if (this.enumerateError !== null) throw this.enumerateError;
    return this.devices.map((d) => ({ ...d, label: this.granted ? d.label : "" }));
  };

  release(): void {
    for (const r of this.held.splice(0)) r();
  }
}

/** The level the fake microphone hears: a constant sample value (0 = silence). */
export const sound = { amplitude: 0 };

export class FakeAudioContext {
  static readonly made: FakeAudioContext[] = [];
  /** The next context throws while it is made (an AudioContext the browser refuses). */
  static failNext: unknown = null;
  static startState: "running" | "suspended" = "suspended";
  static resumeFails = false;
  static closeFails = false;
  state: string;
  closed = false;
  readonly destination = {};
  constructor() {
    if (FakeAudioContext.failNext !== null) {
      const err = FakeAudioContext.failNext;
      FakeAudioContext.failNext = null;
      throw err;
    }
    this.state = FakeAudioContext.startState;
    FakeAudioContext.made.push(this);
  }
  createMediaStreamSource(): { connect(): void } {
    return { connect() {} };
  }
  createAnalyser(): {
    fftSize: number;
    connect(): void;
    getFloatTimeDomainData(buf: Float32Array): void;
  } {
    return {
      fftSize: 2048,
      connect() {},
      getFloatTimeDomainData(buf: Float32Array) {
        buf.fill(sound.amplitude);
      },
    };
  }
  createGain(): { gain: { value: number }; connect(): void } {
    return { gain: { value: 1 }, connect() {} };
  }
  resume(): Promise<void> {
    if (FakeAudioContext.resumeFails) return Promise.reject(new Error("no user gesture"));
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return FakeAudioContext.closeFails ? Promise.reject(new Error("closed")) : Promise.resolve();
  }
}

function defineOn(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
}

// --- the browser around the page -----------------------------------------------------------------

export interface BrowserOptions {
  url: string;
  /** localStorage before the page starts. */
  storage?: Record<string, string>;
  /** HTTPS or localhost: the microphone and the async clipboard work. */
  secure?: boolean;
  /** navigator.mediaDevices (null: none, e.g. plain HTTP on a LAN address). */
  media?: FakeMedia | null;
  /** A phone: touch only and a mobile user agent. */
  handheld?: "touch" | "ua" | "ua-data" | false;
}

export interface Browser {
  api: FakeApi;
  frames: Frames;
  media: FakeMedia | null;
  assign: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  clipboard: { writeText: ReturnType<typeof vi.fn> };
  execCommand: ReturnType<typeof vi.fn>;
  scrollTo: ReturnType<typeof vi.fn>;
}

/** A fresh browser tab on `url` with the page's HTML; import the page afterwards. */
export function openBrowser(page: Page, opts: BrowserOptions): Browser {
  removeListeners();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  win.localStorage.clear();
  for (const [k, v] of Object.entries(opts.storage ?? {})) win.localStorage.setItem(k, v);
  win.happyDOM.setURL(opts.url);
  loadBody(page);
  trackListeners();
  installSizes();
  setDefaultSize(320);
  const frames = new Frames();
  frames.install();
  const api = new FakeApi();
  vi.stubGlobal("fetch", api.fetch);
  const media = opts.media === undefined ? new FakeMedia() : opts.media;
  defineOn(win.navigator, "mediaDevices", media ?? undefined);
  if (media === null) delete (win.navigator as unknown as Record<string, unknown>).mediaDevices;
  defineOn(win, "isSecureContext", opts.secure ?? true);
  const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };
  defineOn(win.navigator, "clipboard", clipboard);
  const execCommand = vi.fn((_cmd: string) => true);
  defineOn(doc, "execCommand", execCommand);
  const scrollTo = vi.fn();
  defineOn(win, "scrollTo", scrollTo);
  FakeAudioContext.made.length = 0;
  FakeAudioContext.failNext = null;
  FakeAudioContext.startState = "suspended";
  FakeAudioContext.resumeFails = false;
  FakeAudioContext.closeFails = false;
  sound.amplitude = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const handheld = opts.handheld ?? false;
  vi.spyOn(win, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: handheld === "touch" ? q === "(pointer: coarse)" : q === "(any-pointer: fine)",
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as ReturnType<HappyWindow["matchMedia"]>,
  );
  defineOn(
    win.navigator,
    "userAgent",
    handheld === "ua"
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130",
  );
  defineOn(win.navigator, "userAgentData", handheld === "ua-data" ? { mobile: true } : undefined);
  const assign = vi.fn();
  const replace = vi.fn();
  vi.spyOn(win.location, "assign").mockImplementation(assign);
  vi.spyOn(win.location, "replace").mockImplementation(replace);
  return {
    api,
    frames,
    media,
    assign,
    replace,
    clipboard,
    execCommand,
    scrollTo,
  };
}

/** A web module by its path from the repository root ("web/picker-mic.ts"), untyped. */
export async function importWeb<T>(path: string): Promise<T> {
  const relative = `../../../${path}`;
  return (await import(/* @vite-ignore */ relative)) as T;
}

/** Import web/<page>.ts (it starts on import) and the i18n module it uses. */
export async function startPage(page: Page): Promise<I18n> {
  const path = `../../../web/${page}.ts`;
  await import(/* @vite-ignore */ path);
  const i18nPath = "../../../web/shared/app-i18n.ts";
  return (await import(/* @vite-ignore */ i18nPath)) as I18n;
}

export interface I18n {
  setLang(l: "en" | "nl" | "ar"): void;
  lang(): "en" | "nl" | "ar";
  t(key: string, vars?: Record<string, string | number>): string;
}

/** After each test: the page's window/document listeners go, the fakes are undone. */
export function closeBrowser(): void {
  removeListeners();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
}
