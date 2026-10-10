// The builder (GET /app/new, and / on a local install): six steps that each customize the
// caption link a little further: languages → layout → theme → adjust → microphone → link.
// Screen mode (/app/new, or `?screen=new|<id>`): the last step saves the setup as
// a screen (POST/PATCH /api/screens) instead of showing the link, then returns to /app.
// The chrome speaks English, Dutch or Arabic (web/shared/app-i18n.ts).
// Soniox is the engine: the language lists come from GET /api/languages and the link never
// carries engine=/translation= (older links may: those are dropped). Theme parameters come from themeQuery (only what
// differs from the chosen preset). Choices live in localStorage, the step in the URL hash.
import "./picker.css";
import {
  alphaOf,
  BUILTIN_PRESETS,
  DEFAULT_PRESET_ID,
  findPreset,
  OPACITY_GROUPS,
  presetTheme,
  type ResolvedTheme,
  resolveTheme,
  sanitizePreset,
  type ThemeVars,
  themeQuery,
  withAlpha,
} from "../src/shared/theme.js";
import type { DisplayOptions, ThemePreset } from "../src/shared/theme-vars.js";
import {
  ApiError,
  apiJson,
  authStateOnce,
  fallbackMessage,
  fetchMe,
  loginUrl,
  type Me,
  maybeLoggedIn,
  type ScreenView,
} from "./admin-api.js";
import { icon } from "./admin-ui.js";
import {
  knownMicLabels,
  MicTester,
  type MicTestState,
  micCapable,
  micErrorText,
  requestMicLabels,
} from "./picker-mic.js";
import { isMsgKey, lang, localeOf, type MsgKey, t, tn } from "./shared/app-i18n.js";
import {
  type AppHeader,
  fillNodes,
  initPage,
  mountFooter,
  mountHeader,
} from "./shared/app-shell.js";
import { byId, el, isLocalHost, storageGet, storageSet } from "./shared/dom.js";
import { obsGuide, micNote as obsMicNote } from "./shared/obs-steps.js";
import type { Channel } from "./shared/params.js";
import {
  appPlacementLabels,
  type HPos,
  lengthPct,
  placementAdjust,
  placementPicker,
  type VPos,
} from "./shared/placement-picker.js";
import { buildStage, fitStage, renderPresetPreview } from "./shared/preset-preview.js";

type Layout = DisplayOptions["layout"];
type Show = DisplayOptions["show"];
type Pos = DisplayOptions["pos"];
type HAlign = "left" | "center" | "right";

interface Lang {
  code: string;
  en: string;
  native: string;
}

interface LangList {
  sources: Lang[];
  targets: Lang[];
  from: string | null;
  to: string | null;
}

/** Everything the wizard asks; null = "whatever the theme says". */
interface Choices {
  from: string;
  to: string;
  layout: Layout;
  preset: string;
  size: number | null;
  show: Show | null;
  quranArabic: boolean | null;
  partial: boolean | null;
  pos: Pos | null;
  justify: HAlign | null;
  width: number | null;
  height: number | null;
  /** Background opacity in % (panel + blocks); null = the theme's own. */
  opacity: number | null;
  /** Width / height were set by a placement pick, not by the user's slider. */
  autoWidth: boolean;
  autoHeight: boolean;
  lines: number | null;
  mic: string;
  ch: Channel;
  dsp: boolean;
}

const STEPS: readonly MsgKey[] = [
  "step.languages",
  "step.layout",
  "step.theme",
  "step.adjust",
  "step.microphone",
  "step.link",
];
const LAST = STEPS.length;
const STORE = "captions.picker.";
const AUTO = "auto";
const POPULAR: ReadonlyArray<readonly [string, string]> = [
  ["ar", "nl"],
  ["ar", "en"],
  ["ar", "tr"],
  ["ar", "fr"],
];
const SIZE_MIN = 24;
const SIZE_MAX = 120;
const WIDTH_MIN = 40;
const WIDTH_MAX = 100;
const HEIGHT_MIN = 20;
const HEIGHT_MAX = 100;
const OPACITY_MIN = 40;
const OPACITY_MAX = 100;
const JUSTIFY_CSS: Readonly<Record<HAlign, HPos>> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

// --- elements ----------------------------------------------------------------------------------

const form = byId("wizard", HTMLFormElement);
const panels = [...document.querySelectorAll<HTMLElement>(".step-panel")];
const stepperBtns = [...document.querySelectorAll<HTMLButtonElement>(".stepper-btn")];
const compactCount = byId("compact-count", HTMLElement);
const compactLabel = byId("compact-label", HTMLSpanElement);
const compactFill = byId("compact-fill", HTMLDivElement);
const backBtn = byId("back", HTMLButtonElement);
const nextBtn = byId("next", HTMLButtonElement);
const nextLabel = byId("next-label", HTMLSpanElement);
const nextHint = byId("next-hint", HTMLParagraphElement);
const serverStatus = byId("server-status", HTMLParagraphElement);
const serverStatusText = byId("server-status-text", HTMLSpanElement);

const errorBox = byId("error", HTMLDivElement);
const errorText = byId("error-text", HTMLSpanElement);
const insecureBox = byId("insecure", HTMLDivElement);
const insecureText = byId("insecure-text", HTMLSpanElement);
const loadError = byId("load-error", HTMLDivElement);
const loadErrorText = byId("load-error-text", HTMLSpanElement);
const retryBtn = byId("retry", HTMLButtonElement);
const jumpBtn = byId("jump-link", HTMLButtonElement);
const fromSel = byId("from", HTMLSelectElement);
const toSel = byId("to", HTMLSelectElement);
const swapBtn = byId("swap", HTMLButtonElement);
const pairsRow = byId("pairs-row", HTMLDivElement);
const pairsList = byId("pairs", HTMLDivElement);
const keyRow = byId("key-row", HTMLDivElement);
const keyInput = byId("key", HTMLInputElement);
const langLock = byId("lang-lock", HTMLParagraphElement);
const pageTitle = byId("b-title", HTMLHeadingElement);
const screenCancel = byId("screen-cancel", HTMLAnchorElement);

const thumbBlocks = byId("thumb-blocks", HTMLSpanElement);
const thumbRollup = byId("thumb-rollup", HTMLSpanElement);
const gallery = byId("gallery", HTMLDivElement);
const customize3 = byId("customize-3", HTMLAnchorElement);

const sizeInput = byId("size", HTMLInputElement);
const sizeOut = byId("size-value", HTMLOutputElement);
const showSrc = byId("show-src", HTMLInputElement);
const showSrcTitle = byId("show-src-title", HTMLLabelElement);
const rowQuran = byId("row-quran", HTMLDivElement);
const quranAr = byId("quran-ar", HTMLInputElement);
const partialInput = byId("partial", HTMLInputElement);
const rowLines = byId("row-lines", HTMLDivElement);
const placeMount = byId("place-mount", HTMLDivElement);
const widthInput = byId("width", HTMLInputElement);
const widthOut = byId("width-value", HTMLOutputElement);
const rowHeight = byId("row-height", HTMLDivElement);
const heightInput = byId("height", HTMLInputElement);
const heightOut = byId("height-value", HTMLOutputElement);
const opacityInput = byId("opacity", HTMLInputElement);
const opacityOut = byId("opacity-value", HTMLOutputElement);
const tuneReset = byId("tune-reset", HTMLButtonElement);

const micTip = byId("mic-tip", HTMLButtonElement);
const micWhere = byId("mic-where", HTMLParagraphElement);
const micPhone = byId("mic-phone", HTMLParagraphElement);
const micSel = byId("mic", HTMLSelectElement);
const listMicsBtn = byId("list-mics", HTMLButtonElement);
const micNote = byId("mic-note", HTMLParagraphElement);
const testBtn = byId("test-mic", HTMLButtonElement);
const meter = byId("meter", HTMLDivElement);
const meterFill = byId("meter-fill", HTMLDivElement);
const meterStatus = byId("meter-status", HTMLParagraphElement);
const moreAudio = byId("more-audio", HTMLDetailsElement);
const dspSel = byId("dsp", HTMLSelectElement);
const chSel = byId("ch", HTMLSelectElement);

const urlBox = byId("url", HTMLTextAreaElement);
const lastTitle = byId("last-title", HTMLHeadingElement);
const lastStepLabel = byId("last-step-label", HTMLSpanElement);
const linkMode = byId("link-mode", HTMLDivElement);
const saveMode = byId("save-mode", HTMLDivElement);
const screenName = byId("screen-name", HTMLInputElement);
const saveError = byId("save-error", HTMLParagraphElement);
const saveBtn = byId("save-screen", HTMLButtonElement);
const openBtn = byId("open", HTMLButtonElement);
const copyBtn = byId("copy", HTMLButtonElement);
const obsMount = byId("obs-mount", HTMLDivElement);
const customizeLink = byId("customize", HTMLAnchorElement);
const startOverBtn = byId("start-over", HTMLButtonElement);

const previewBox = byId("preview-box", HTMLDivElement);
const linkSoFar = byId("link-so-far", HTMLParagraphElement);
const toast = byId("toast", HTMLDivElement);
const toastText = byId("toast-text", HTMLSpanElement);

// --- state ---------------------------------------------------------------------------------------

const remote = !isLocalHost();
const canMic = micCapable();

/** A phone or tablet: touch only (no mouse or touchpad), or a mobile browser. */
function onHandheld(): boolean {
  const touchOnly =
    window.matchMedia("(pointer: coarse)").matches &&
    !window.matchMedia("(any-pointer: fine)").matches;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return (
    touchOnly ||
    nav.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}
const handheld = onHandheld();

const screenParam = new URLSearchParams(window.location.search).get("screen");
/** The builder inside the app (/app/new): always makes or edits a screen. */
const inApp = window.location.pathname === "/app" || window.location.pathname.startsWith("/app/");
/** Screen mode: `?screen=new` (or /app/new) creates a screen, `?screen=<id>` edits one (needs a
 *  login). On / of a local install, without ?screen=, the builder makes a plain caption link. */
const screenMode: { id: string | null } | null =
  screenParam === null || screenParam.trim() === ""
    ? inApp
      ? { id: null }
      : null
    : { id: screenParam === "new" ? null : screenParam };
/** Link params of an edited screen that the wizard doesn't manage (kept when saving). */
let extraParams: Array<[string, string]> = [];
/** A saved screen keeps its languages (PATCH takes only name + query). */
let langsLocked = false;

let lists: LangList | null = null;
let loadFailed = false;
let custom: ThemePreset[] = [];
let serverDefault = DEFAULT_PRESET_ID;
let step = 1;
let furthest = 1;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let micLabels: string[] = [];
let header: AppHeader | null = null;
/** The screen being edited (its name goes in the title). */
let editing: ScreenView | null = null;
/** Messages on screen that a language switch draws again. */
let micNoteText: (() => string) | null = null;
let loadProblem: (() => string) | null = null;
let saveProblem: (() => string) | null = null;
let micState: MicTestState | null = null;

function readStored(name: string): string | null {
  return storageGet(`${STORE}${name}`);
}

function intOrNull(raw: string | null, min: number, max: number): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

function boolOrNull(raw: string | null): boolean | null {
  return raw === "1" ? true : raw === "0" ? false : null;
}

function oneOf<T extends string>(raw: string | null, values: readonly T[]): T | null {
  return values.find((v) => v === raw) ?? null;
}

function loadChoices(): Choices {
  return {
    from: readStored("from") ?? "",
    to: readStored("to") ?? "",
    layout: readStored("layout") === "rollup" ? "rollup" : "blocks",
    preset: readStored("preset") ?? "",
    size: intOrNull(readStored("size"), SIZE_MIN, SIZE_MAX),
    show: oneOf(readStored("show"), ["both", "target", "source"] as const),
    quranArabic: boolOrNull(readStored("quranArabic")),
    partial: boolOrNull(readStored("partial")),
    pos: oneOf(readStored("pos"), ["bottom", "top", "middle"] as const),
    justify: oneOf(readStored("justify"), ["left", "center", "right"] as const),
    width: intOrNull(readStored("width"), WIDTH_MIN, WIDTH_MAX),
    height: intOrNull(readStored("height"), 10, 100),
    opacity: intOrNull(readStored("opacity"), OPACITY_MIN, OPACITY_MAX),
    autoWidth: readStored("autoWidth") === "1",
    autoHeight: readStored("autoHeight") === "1",
    lines: intOrNull(readStored("lines"), 1, 4),
    mic: readStored("mic") ?? "",
    ch: oneOf(readStored("ch"), ["mix", "left", "right"] as const) ?? "mix",
    dsp: readStored("dsp") === "on",
  };
}

const hadSetup = screenMode === null && readStored("from") !== null && readStored("done") === "1";
const choices: Choices = loadChoices();
/** False until storage, a deep link or the user picks a layout: then it follows the theme. */
let layoutChosen = readStored("layout") !== null;
/** A reload on a later step (#step=4) waits for the language list before going there. */
let pendingStep = 0;

function saveChoices(): void {
  // Screen mode edits a server-side screen: the browser's own wizard choices stay untouched.
  if (screenMode) return;
  const b = (v: boolean | null): string | null => (v === null ? null : v ? "1" : "0");
  const n = (v: number | null): string | null => (v === null ? null : String(v));
  const s = (v: string): string | null => (v === "" ? null : v);
  const entries: Array<[string, string | null]> = [
    ["from", s(choices.from)],
    ["to", s(choices.to)],
    ["layout", choices.layout],
    ["preset", s(choices.preset)],
    ["size", n(choices.size)],
    ["show", choices.show],
    ["quranArabic", b(choices.quranArabic)],
    ["partial", b(choices.partial)],
    ["pos", choices.pos],
    ["justify", choices.justify],
    ["width", n(choices.width)],
    ["height", n(choices.height)],
    ["opacity", n(choices.opacity)],
    ["autoWidth", choices.autoWidth ? "1" : null],
    ["autoHeight", choices.autoHeight ? "1" : null],
    ["lines", n(choices.lines)],
    ["mic", s(choices.mic)],
    ["ch", choices.ch === "mix" ? null : choices.ch],
    ["dsp", choices.dsp ? "on" : null],
  ];
  for (const [k, v] of entries) storageSet(`${STORE}${k}`, v);
}

function keyValue(): string {
  return remote && !screenMode ? keyInput.value.trim() : "";
}

// --- presets & theme -------------------------------------------------------------------------------

/** mosque-dark, a built-in: the server's default when the server names none it has. */
const BUILTIN_DEFAULT = findPreset(DEFAULT_PRESET_ID) as ThemePreset;

/** The chosen look, else the server's default (serverDefault always names a known look). */
function currentPreset(): ThemePreset {
  return findPreset(choices.preset, custom) ?? findPreset(serverDefault, custom) ?? BUILTIN_DEFAULT;
}

function naturalLayout(p: ThemePreset): Layout {
  return presetTheme(p).options.layout;
}

function themeOptions(): Partial<DisplayOptions> {
  const o: Partial<DisplayOptions> = { layout: choices.layout };
  if (choices.size !== null) o.size = choices.size;
  if (choices.show !== null) o.show = choices.show;
  if (choices.layout === "blocks" && choices.quranArabic !== null) {
    o.quranArabic = choices.quranArabic;
  }
  if (choices.partial !== null) o.partial = choices.partial;
  if (choices.pos !== null) o.pos = choices.pos;
  if (choices.layout === "rollup" && choices.lines !== null) o.lines = choices.lines;
  return o;
}

function themeOverrides(): ThemeVars {
  const vars: ThemeVars = {};
  if (choices.width !== null) vars["--cap-panel-width"] = `${choices.width}vw`;
  if (choices.justify !== null) vars["--cap-panel-justify"] = JUSTIFY_CSS[choices.justify];
  if (choices.height !== null) vars["--cap-panel-height"] = `${choices.height}vh`;
  if (choices.opacity !== null) {
    const base = presetTheme(currentPreset()).vars;
    for (const g of OPACITY_GROUPS) {
      for (const n of g.vars) {
        const a = alphaOf(base[n]);
        if (a === null || a === 0) continue;
        const c = withAlpha(base[n], choices.opacity / 100);
        if (c !== null) vars[n] = c;
      }
    }
  }
  return vars;
}

/** The theme's own background opacity in % (panel, else the newest block); null = none. */
function themeOpacity(): number | null {
  const t = presetTheme(currentPreset());
  const panel = t.options.bg === "none" ? null : alphaOf(t.vars["--cap-panel-bg"]);
  const block = alphaOf(t.vars["--cap-block-bg-new"]);
  const a = panel !== null && panel > 0 ? panel : block !== null && block > 0 ? block : null;
  return a === null ? null : Math.round(a * 100);
}

/** Minimal theme query for the caption page (preset, layout, size, …), without "?". */
function themeParams(): string {
  const base = themeQuery(currentPreset().id, themeOverrides(), themeOptions(), {
    custom,
    defaultPreset: serverDefault,
  });
  if (extraParams.length === 0) return base;
  const q = new URLSearchParams(base);
  for (const [k, v] of extraParams) if (!q.has(k)) q.append(k, v);
  return q.toString();
}

function resolved(): ResolvedTheme {
  return resolveTheme(new URLSearchParams(themeParams()), custom, serverDefault);
}

function hasTuning(): boolean {
  return (
    choices.size !== null ||
    choices.show !== null ||
    choices.quranArabic !== null ||
    choices.partial !== null ||
    choices.pos !== null ||
    choices.justify !== null ||
    choices.width !== null ||
    choices.height !== null ||
    choices.opacity !== null ||
    choices.lines !== null
  );
}

function clearTuning(): void {
  choices.size = null;
  choices.show = null;
  choices.quranArabic = null;
  choices.partial = null;
  choices.pos = null;
  choices.justify = null;
  choices.width = null;
  choices.height = null;
  choices.opacity = null;
  choices.autoWidth = false;
  choices.autoHeight = false;
  placementNote = null;
  choices.lines = null;
}

// --- links -------------------------------------------------------------------------------------------

function captionQuery(): URLSearchParams {
  const q = new URLSearchParams(themeParams());
  if (choices.mic) q.set("mic", choices.mic);
  if (choices.ch !== "mix") q.set("ch", choices.ch);
  if (choices.dsp) q.set("dsp", "on");
  const key = keyValue();
  if (key) q.set("key", key);
  return q;
}

function captionPath(): string {
  const qs = captionQuery().toString();
  const path = `/${encodeURIComponent(choices.from)}/${encodeURIComponent(choices.to)}`;
  return qs ? `${path}?${qs}` : path;
}

function captionUrl(): string {
  return `${window.location.origin}${captionPath()}`;
}

/** The look page with the same choices, so its preview starts where the wizard is. */
function customizeHref(): string {
  const q = new URLSearchParams();
  if (choices.from) q.set("from", choices.from);
  if (choices.to) q.set("to", choices.to);
  q.set("preset", currentPreset().id);
  for (const [k, v] of new URLSearchParams(themeParams())) if (k !== "preset") q.set(k, v);
  const key = keyValue();
  if (key) q.set("key", key);
  return `/app/look?${q.toString()}`;
}

// --- languages -----------------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseLangs(value: unknown): Lang[] | null {
  if (!Array.isArray(value)) return null;
  const out: Lang[] = [];
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const code = str(r.code);
    if (code === null || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, en: str(r.en) ?? code, native: str(r.native) ?? "" });
  }
  return out;
}

function parseLangList(value: unknown): LangList | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const sources = parseLangs(r.sources);
  const targets = parseLangs(r.targets);
  if (!sources || !targets || targets.length === 0) return null;
  const d =
    typeof r.defaults === "object" && r.defaults !== null
      ? (r.defaults as Record<string, unknown>)
      : {};
  const byName = (a: Lang, b: Lang): number => a.en.localeCompare(b.en);
  return {
    // "Auto-detect" first, added even when the server's list lacks it.
    sources: [
      { code: AUTO, en: "Auto-detect", native: "" },
      ...sources.filter((l) => l.code !== AUTO).sort(byName),
    ],
    targets: targets.filter((l) => l.code !== AUTO).sort(byName),
    from: str(d.from) ?? str(r.defaultFrom),
    to: str(d.to) ?? str(r.defaultTo),
  };
}

let displayNames: { lang: string; names: Intl.DisplayNames | null } | null = null;

/** A language's name in the app's own language ("Arabisch" on a Dutch page), else English. */
function uiName(code: string, english: string): string {
  const l = lang();
  if (displayNames?.lang !== l) {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([localeOf(l), "en"], { type: "language" });
    } catch {
      names = null;
    }
    displayNames = { lang: l, names };
  }
  let name: string | undefined;
  try {
    name = displayNames.names?.of(code);
  } catch {
    name = undefined;
  }
  return name && name !== code ? name.charAt(0).toUpperCase() + name.slice(1) : english;
}

function langLabel(l: Lang): string {
  if (l.code === AUTO) return t("b.auto");
  const name = uiName(l.code, l.en);
  return l.native && l.native !== name ? `${l.native} · ${name}` : name;
}

/** The name of a language code ("Arabic" / "Arabisch" / "العربية"); never asked for "auto". */
function langName(code: string): string {
  const all = lists ? [...lists.sources, ...lists.targets] : [];
  return uiName(code, all.find((l) => l.code === code)?.en ?? code.toUpperCase());
}

/** Sorted by the name the reader sees; "Auto-detect" stays first. */
function byShownName(langs: Lang[]): Lang[] {
  const loc = localeOf(lang());
  const named = langs
    .filter((l) => l.code !== AUTO)
    .sort((a, b) => uiName(a.code, a.en).localeCompare(uiName(b.code, b.en), loc));
  return [...langs.filter((l) => l.code === AUTO), ...named];
}

function fillLangSelect(sel: HTMLSelectElement, langs: Lang[], value: string): void {
  sel.replaceChildren(
    ...byShownName(langs).map((l) =>
      el("option", { text: langLabel(l), attrs: { value: l.code } }),
    ),
  );
  sel.value = value;
  sel.disabled = false;
}

function pick(codes: Set<string>, ...want: Array<string | null>): string {
  return want.find((c): c is string => c !== null && c !== "" && codes.has(c)) ?? "";
}

async function loadLanguages(): Promise<void> {
  loadFailed = false;
  errorlessLoading();
  let parsed: LangList | null = null;
  // A reply that isn't a language list, unless one of the cases below says more.
  let problem = (): string => t("b.langUnexpected");
  try {
    const res = await fetch("/api/languages", {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      parsed = parseLangList(await res.json());
    } else {
      const status = res.status;
      problem = () => t("b.langHttp", { status });
    }
  } catch {
    problem = () => t("b.unreachable");
  }
  if (!parsed) {
    loadFailed = true;
    loadProblem = problem;
    loadErrorText.textContent = problem();
    loadError.hidden = false;
    setServerStatus("error", "b.serverDown");
    render();
    return;
  }
  lists = parsed;
  loadProblem = null;
  setServerStatus("ok", "b.ready");
  const sources = new Set(parsed.sources.map((l) => l.code));
  const targets = new Set(parsed.targets.map((l) => l.code));
  choices.from = pick(sources, choices.from, parsed.from, "ar", AUTO);
  choices.to = pick(targets, choices.to, parsed.to, "nl", "en", parsed.targets[0]?.code ?? null);
  fillLangSelect(fromSel, parsed.sources, choices.from);
  fillLangSelect(toSel, parsed.targets, choices.to);
  renderPairs(parsed);
  update();
  // A reload on a later step (#step=4) waits for the lists; go back if step 1 is now invalid.
  if (step > 1 && stepProblem(1) !== null) goTo(1, "replace");
  else if (pendingStep > step && step === 1) goTo(pendingStep, "replace", false);
  pendingStep = 0;
}

function errorlessLoading(): void {
  loadError.hidden = true;
  loadProblem = null;
  setServerStatus("pending", "b.connecting");
}

function setServerStatus(kind: "ok" | "error" | "pending", key: MsgKey): void {
  serverStatus.classList.toggle("is-ok", kind === "ok");
  serverStatus.classList.toggle("is-error", kind === "error");
  serverStatus.classList.toggle("is-pending", kind === "pending");
  serverStatusText.dataset.i18n = key;
  serverStatusText.textContent = t(key);
}

function renderPairs(l: LangList): void {
  const src = new Set(l.sources.map((x) => x.code));
  const tgt = new Set(l.targets.map((x) => x.code));
  const pairs = POPULAR.filter(([f, to]) => src.has(f) && tgt.has(to));
  pairsList.replaceChildren(
    ...pairs.map(([f, to]) =>
      el("button", {
        class: "pair-chip",
        text: `${langName(f)} ${t("common.arrow")} ${langName(to)}`,
        attrs: { type: "button", "data-from": f, "data-to": to, "aria-pressed": "false" },
      }),
    ),
  );
  pairsRow.hidden = pairs.length === 0 || langsLocked;
}

// --- presets (GET /api/presets → {builtin, custom, default}; old servers 404) ---------------------

async function loadPresets(): Promise<void> {
  try {
    const res = await fetch("/api/presets", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return;
    const r = body as Record<string, unknown>;
    const list = Array.isArray(r.custom) ? (r.custom as unknown[]) : [];
    custom = list
      .map((p) => sanitizePreset(p))
      .filter((p): p is ThemePreset => p !== null && findPreset(p.id) === undefined);
    const def = str(r.default);
    if (def !== null && findPreset(def, custom) !== undefined) serverDefault = def;
  } catch {
    // keep the bundled presets and the built-in default
  } finally {
    // A remembered custom preset may be gone: fall back to the server's default ("").
    if (choices.preset !== "" && findPreset(choices.preset, custom) === undefined) {
      choices.preset = "";
    }
    if (!layoutChosen) choices.layout = naturalLayout(currentPreset());
    buildGallery();
    update();
  }
}

// --- previews ------------------------------------------------------------------------------------

type Painter = (w: number, h: number) => HTMLElement;
const painters = new Map<Element, Painter>();
const painted = new WeakMap<Element, number>();
const resizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) paint(e.target, false);
});

function paint(box: Element, force: boolean): void {
  const painter = painters.get(box);
  const w = Math.floor(box.clientWidth);
  // Unmounted, hidden (another step: painted when it appears) or already drawn at this width.
  if (painter === undefined || w < 40 || (!force && painted.get(box) === w)) return;
  painted.set(box, w);
  box.replaceChildren(painter(w, Math.round((w * 9) / 16)));
}

function mount(box: HTMLElement, painter: Painter): void {
  painters.set(box, painter);
  resizeObserver.observe(box);
  paint(box, true);
}

function unmount(box: Element): void {
  painters.delete(box);
  resizeObserver.unobserve(box);
}

function stagePreview(w: number, h: number): HTMLElement {
  const theme = resolved();
  const stageW = 1920;
  const stageH = Math.round((stageW * h) / w);
  const card = el("div", { class: "pp-card" });
  card.style.setProperty("width", `${w}px`);
  card.style.setProperty("height", `${h}px`);
  const stage = buildStage({
    width: stageW,
    height: stageH,
    vars: theme.vars,
    options: theme.options,
    sample: "khutbah",
    backdrop: "video",
    listening: true,
    browser: false,
    lang: choices.to,
  });
  fitStage(stage, stageW, stageH, w, h);
  card.append(stage);
  return card;
}

let previewFrame = 0;
function repaintPreview(): void {
  if (previewFrame) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    paint(previewBox, true);
  });
}

function svgIcon(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "3");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

const CHECK = "M5 12.5l4.2 4.2L19 7";

let galleryLayout: Layout | null = null;
/** The caption language the previews were drawn in. */
let previewLang = "";

/** A built-in theme's name in the app language; custom themes keep their own name. */
function presetName(p: ThemePreset): string {
  const key = `preset.${p.id}`;
  return findPreset(p.id) !== undefined && isMsgKey(key) ? t(key) : p.name;
}

function buildGallery(): void {
  for (const box of gallery.querySelectorAll(".theme-thumb")) unmount(box);
  const layout = choices.layout;
  galleryLayout = layout;
  const all = [...BUILTIN_PRESETS, ...custom];
  const ordered = [
    ...all.filter((p) => naturalLayout(p) === layout),
    ...all.filter((p) => naturalLayout(p) !== layout),
  ];
  const selected = currentPreset().id;
  gallery.replaceChildren(
    ...ordered.map((p, i) => {
      const id = `theme-${i}`;
      const input = el("input", {
        class: "ui-sr-only",
        attrs: {
          type: "radio",
          name: "preset",
          value: p.id,
          "aria-labelledby": `${id}-name`,
          "aria-describedby": `${id}-desc`,
        },
      });
      input.checked = p.id === selected;
      const badges: HTMLElement[] = [];
      if (p.id === serverDefault)
        badges.push(el("span", { class: "ui-badge", text: t("b.default") }));
      if (findPreset(p.id) === undefined) {
        badges.push(el("span", { class: "ui-badge ui-badge-neutral", text: t("b.yourTheme") }));
      }
      if (naturalLayout(p) !== layout) {
        badges.push(
          el("span", {
            class: "ui-badge ui-badge-neutral",
            text: t(naturalLayout(p) === "rollup" ? "b.forRolling" : "b.forBlocks"),
          }),
        );
      }
      const thumb = el("span", { class: "theme-thumb" });
      const card = el("label", { class: "theme-card" }, [
        input,
        el("span", { class: "theme-inner" }, [
          thumb,
          el("span", { class: "theme-body" }, [
            el("span", { class: "theme-name", text: presetName(p), attrs: { id: `${id}-name` } }),
            badges.length > 0 ? el("span", { class: "theme-badges" }, badges) : "",
            el("span", {
              class: "theme-desc",
              text: p.description || t("b.customDesc"),
              // Built-in descriptions are English (src/shared/theme.ts).
              attrs: { id: `${id}-desc`, ...(p.description ? { lang: "en" } : {}) },
            }),
          ]),
          el("span", { class: "theme-check" }, [svgIcon(CHECK)]),
        ]),
      ]);
      mount(thumb, (w, h) =>
        renderPresetPreview(p, { width: w, height: h, sample: layout, lang: choices.to }),
      );
      return card;
    }),
  );
}

function syncGallerySelection(): void {
  const id = currentPreset().id;
  for (const input of gallery.querySelectorAll<HTMLInputElement>("input[name=preset]")) {
    input.checked = input.value === id;
  }
}

let thumbsPreset = "";
function paintLayoutThumbs(force: boolean): void {
  const id = currentPreset().id;
  if (!force && id === thumbsPreset) return;
  thumbsPreset = id;
  paint(thumbBlocks, true);
  paint(thumbRollup, true);
}

// --- fine-tune -------------------------------------------------------------------------------------

function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`);
}

function panelWidth(theme: ResolvedTheme): number {
  return Math.round(lengthPct(theme.vars["--cap-panel-width"], "w"));
}

function justifyOf(theme: ResolvedTheme): HPos {
  const j = theme.vars["--cap-panel-justify"];
  return j === "flex-start" || j === "flex-end" ? j : "center";
}

function hAlign(j: HPos): HAlign {
  return j === "flex-start" ? "left" : j === "flex-end" ? "right" : "center";
}

/** The size change of the last pick (e.g. "Width set to 65 % …"), shown under the screen. */
let placementNote: string | null = null;

/** The placement picker in the app language (shared with the look editor). */
const placementLabels = appPlacementLabels;

/** Shared with the look page: a mini 16:9 screen with a 3×3 grid (web/shared/placement-picker). */
const placement = placementPicker((pos: VPos, justify: HPos) => {
  const theme = resolved();
  const adjust = placementAdjust(
    pos,
    justify,
    {
      widthPct: lengthPct(theme.vars["--cap-panel-width"], "w"),
      heightPct: lengthPct(theme.vars["--cap-panel-height"], "h"),
      rollup: theme.options.layout === "rollup",
      autoWidth: choices.autoWidth,
      autoHeight: choices.autoHeight,
    },
    placementLabels(),
  );
  choices.pos = pos;
  choices.justify = hAlign(justify);
  // Automatic sizes are provisional: the opposite pick restores the theme's own size.
  if (adjust.width !== null) {
    choices.width = Math.round(lengthPct(adjust.width, "w"));
    choices.autoWidth = true;
  } else if (adjust.resetWidth) {
    choices.width = null;
    choices.autoWidth = false;
  }
  if (adjust.height !== null) {
    choices.height = Math.round(lengthPct(adjust.height, "h"));
    choices.autoHeight = true;
  } else if (adjust.resetHeight) {
    choices.height = null;
    choices.autoHeight = false;
  }
  placementNote = adjust.note;
  update();
}, placementLabels);
placeMount.append(placement.root);

function syncPlacement(theme: ResolvedTheme): void {
  placement.set({
    pos: theme.options.pos,
    justify: justifyOf(theme),
    widthPct: lengthPct(theme.vars["--cap-panel-width"], "w"),
    heightPct: lengthPct(theme.vars["--cap-panel-height"], "h"),
    rollup: theme.options.layout === "rollup",
  });
  placement.note(placementNote);
}

function syncTune(theme: ResolvedTheme): void {
  const o = theme.options;
  const size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, o.size));
  if (document.activeElement !== sizeInput) sizeInput.value = String(size);
  sizeOut.textContent = `${o.size} px`;
  setRangeFill(sizeInput);
  showSrc.checked = o.show !== "target";
  showSrcTitle.textContent =
    choices.from === AUTO ? t("b.originalText") : t("b.srcText", { lang: langName(choices.from) });
  rowQuran.hidden = choices.layout !== "blocks";
  quranAr.checked = o.quranArabic;
  partialInput.checked = o.partial;
  syncPlacement(theme);
  rowLines.hidden = choices.layout !== "rollup";
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=lines]")) {
    r.checked = Number(r.value) === o.lines;
  }
  const width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, panelWidth(theme)));
  if (document.activeElement !== widthInput) widthInput.value = String(width);
  widthOut.textContent = `${widthInput.value} %`;
  setRangeFill(widthInput);
  // Roll-up captions take the height of their lines: no height slider there.
  rowHeight.hidden = choices.layout === "rollup";
  const height = Math.round(lengthPct(theme.vars["--cap-panel-height"], "h"));
  if (document.activeElement !== heightInput) {
    heightInput.value = String(Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, height)));
  }
  heightOut.textContent = `${height} %`;
  setRangeFill(heightInput);
  const own = themeOpacity();
  const opacity = choices.opacity ?? own;
  opacityInput.disabled = opacity === null;
  if (document.activeElement !== opacityInput) {
    opacityInput.value = String(Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, opacity ?? 100)));
  }
  opacityOut.textContent = opacity === null ? "–" : `${opacity} %`;
  opacityInput.title = opacity === null ? t("b.noBackground") : "";
  setRangeFill(opacityInput);
  tuneReset.disabled = !hasTuning();
}

// --- microphone ------------------------------------------------------------------------------------

function fillMics(labels: string[]): void {
  micLabels = labels;
  const options = [
    el("option", { text: t("b.defaultMic"), attrs: { value: "", "data-i18n": "b.defaultMic" } }),
  ];
  for (const l of labels) options.push(el("option", { text: l, attrs: { value: l } }));
  if (choices.mic && !labels.includes(choices.mic)) {
    options.push(el("option", { text: choices.mic, attrs: { value: choices.mic } }));
  }
  micSel.replaceChildren(...options);
  micSel.value = choices.mic;
}

/** Screen mode: the screen listens on the computer that shows it, so a name chosen here must exist
 *  there; on a phone or tablet this list is the phone's own (keep the default). */
function renderMicWhere(): void {
  const screen = screenMode !== null;
  micTip.hidden = screen;
  micWhere.hidden = !screen;
  micPhone.hidden = !(screen && handheld);
  if (!screen) return;
  micWhere.replaceChildren(icon("mic", 18), el("span", { text: t("b.micScreen") }));
  if (handheld) micPhone.textContent = t("b.micPhone");
}

function showMicNote(text: () => string): void {
  micNoteText = text;
  micNote.textContent = text();
  micNote.hidden = false;
}

/** Only with a microphone API: without one the Find button stays disabled (init). */
async function listMics(): Promise<void> {
  listMicsBtn.disabled = true;
  showMicNote(() => t("mic.asking"));
  try {
    const labels = await requestMicLabels();
    fillMics(labels);
    const n = labels.length;
    showMicNote(() => (n > 0 ? tn("n.found", n) : t("mic.noneNamed")));
  } catch (err) {
    const key = micErrorText(err);
    showMicNote(() => t(key));
  } finally {
    listMicsBtn.disabled = false;
  }
}

const tester = new MicTester({
  onLevel(level) {
    meterFill.style.setProperty("transform", `scaleX(${level.toFixed(3)})`);
  },
  onState(state) {
    renderMeter(state);
  },
  onLabels(labels) {
    if (labels.join("\n") !== micLabels.join("\n")) fillMics(labels);
  },
});

function setLabelKey(node: HTMLElement, key: MsgKey): void {
  node.dataset.i18n = key;
  node.textContent = t(key);
}

function renderMeter(state: MicTestState | null): void {
  micState = state;
  meter.classList.remove("is-good", "is-warn", "is-error");
  if (state === null) {
    meter.hidden = true;
    meterFill.style.setProperty("transform", "scaleX(0)");
    setLabelKey(testBtn, "b.test");
    return;
  }
  meter.hidden = false;
  setLabelKey(testBtn, state.kind === "error" ? "common.retry" : "b.stop");
  switch (state.kind) {
    case "starting":
      meterStatus.textContent = t("mic.starting");
      break;
    case "listening":
      meterStatus.textContent = t("mic.listening");
      break;
    case "heard":
      meter.classList.add("is-good");
      meterStatus.textContent = t("mic.heard");
      break;
    case "quiet":
      meter.classList.add("is-warn");
      meterStatus.textContent = t("mic.quiet");
      break;
    case "error":
      meter.classList.add("is-error");
      meterStatus.textContent = t(state.message);
      meterFill.style.setProperty("transform", "scaleX(0)");
      break;
  }
}

function startTest(): void {
  void tester.start({ mic: choices.mic, dsp: choices.dsp, ch: choices.ch });
}

function stopTest(): void {
  tester.stop();
  renderMeter(null);
}

// --- copy + toast ----------------------------------------------------------------------------------

function showToast(text: string): void {
  toastText.textContent = text;
  toast.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

async function copyLink(): Promise<void> {
  const text = captionUrl();
  urlBox.value = text;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    urlBox.focus();
    urlBox.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
  }
  showToast(ok ? t("common.copied") : t("b.copyFailed"));
}

// --- steps -------------------------------------------------------------------------------------------

/** Why step `n` can't be left forward yet, or null. */
function stepProblem(n: number): string | null {
  if (n !== 1) return null;
  if (!lists) return t(loadFailed ? "b.pLoadFailed" : "b.pLoading");
  if (!lists.sources.some((l) => l.code === choices.from)) return t("b.pFrom");
  if (!lists.targets.some((l) => l.code === choices.to)) return t("b.pTo");
  if (choices.from !== AUTO && choices.from === choices.to) return t("b.pSame");
  if (remote && !screenMode && keyValue() === "") return t("b.pKey");
  return null;
}

/** Like stepProblem, but lets a reload on a later step wait for the language list. */
function blocks(n: number): boolean {
  if (n === 1 && !lists && !loadFailed) {
    return choices.from === "" || choices.to === "" || (remote && !screenMode && keyValue() === "");
  }
  return stepProblem(n) !== null;
}

function hashStep(): number {
  const m = /step=(\d)/.exec(window.location.hash);
  const n = m?.[1] !== undefined ? Number(m[1]) : 1;
  return Math.min(LAST, Math.max(1, n));
}

function goTo(target: number, history: "push" | "replace" | "none" = "push", focus = true): void {
  let n = Math.min(LAST, Math.max(1, Math.round(target)));
  for (let i = 1; i < n; i++) {
    if (blocks(i)) {
      n = i;
      break;
    }
  }
  const changed = n !== step;
  step = n;
  furthest = Math.max(furthest, n);
  if (n === LAST) storageSet(`${STORE}done`, "1");
  if (n !== 5) stopTest();
  const hash = `#step=${n}`;
  if (history !== "none" && window.location.hash !== hash) {
    if (history === "push") window.history.pushState(null, "", hash);
    else window.history.replaceState(null, "", hash);
  }
  render();
  if (changed && focus) {
    const title = panels[n - 1]?.querySelector<HTMLElement>(".step-title");
    title?.focus({ preventScroll: true });
    const top = document.querySelector(".stepper")?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollTo({ top: Math.max(0, window.scrollY + top - 12) });
  }
}

function stepName(i: number): string {
  if (screenMode && i === LAST - 1) return t("step.save");
  const key = STEPS[i];
  return key === undefined ? "" : t(key);
}

function renderStepper(): void {
  stepperBtns.forEach((btn, i) => {
    const n = i + 1;
    let reachable = n <= furthest;
    for (let j = 1; j < n && reachable; j++) if (blocks(j)) reachable = false;
    const state =
      n === step ? "current" : n < step || (reachable && n <= furthest) ? "done" : "todo";
    btn.classList.toggle("is-current", state === "current");
    btn.classList.toggle("is-done", state === "done");
    btn.classList.toggle("is-todo", state === "todo");
    btn.disabled = n !== step && !reachable;
    btn.parentElement?.classList.toggle("is-done", n < step);
    if (n === step) btn.setAttribute("aria-current", "step");
    else btn.removeAttribute("aria-current");
    const name = stepName(i);
    const label =
      state === "done"
        ? t("b.stepDone", { label: name })
        : state === "current"
          ? t("b.stepCurrent", { label: name })
          : name;
    btn.setAttribute("aria-label", t("b.stepAria", { n, label }));
  });
  compactCount.textContent = `${step}/${LAST}`;
  compactLabel.textContent = stepName(step - 1);
  compactFill.style.setProperty("width", `${(step / LAST) * 100}%`);
}

function renderNav(): void {
  backBtn.hidden = step === 1;
  nextBtn.hidden = step === LAST;
  nextLabel.textContent = t("common.next");
  const problem = step < LAST ? stepProblem(step) : null;
  nextBtn.disabled = problem !== null;
  nextHint.textContent = problem ?? "";
}

/** Everything that depends on the choices (cheap; previews repaint in the next frame). */
function update(): void {
  saveChoices();
  const theme = resolved();
  // Step 1
  fromSel.value = choices.from;
  toSel.value = choices.to;
  swapBtn.disabled = !lists || choices.from === AUTO || langsLocked;
  if (langsLocked) {
    fromSel.disabled = true;
    toSel.disabled = true;
  }
  for (const chip of pairsList.querySelectorAll<HTMLButtonElement>(".pair-chip")) {
    const on = chip.dataset.from === choices.from && chip.dataset.to === choices.to;
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  }
  // Step 2 (the previews speak the caption language: drawn again when it changes)
  const langChanged = choices.to !== previewLang;
  previewLang = choices.to;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=layout]")) {
    r.checked = r.value === choices.layout;
  }
  paintLayoutThumbs(langChanged);
  // Step 3
  if (galleryLayout !== choices.layout || langChanged) buildGallery();
  else syncGallerySelection();
  // Step 4
  syncTune(theme);
  // Step 5
  if (micSel.value !== choices.mic) micSel.value = choices.mic;
  dspSel.value = choices.dsp ? "on" : "off";
  chSel.value = choices.ch;
  // Links, preview
  const path = choices.from && choices.to ? captionPath() : "";
  const shown = path.replace(/([?&]key=)[^&]*/, "$1••••");
  linkSoFar.textContent = path ? `${window.location.host}${shown}` : "–";
  linkSoFar.title = linkSoFar.textContent;
  urlBox.value = path ? captionUrl() : "";
  const href = customizeHref();
  customizeLink.href = href;
  customize3.href = href;
  renderObs();
  repaintPreview();
  renderStepper();
  renderNav();
}

function render(): void {
  panels.forEach((panel, i) => {
    panel.hidden = i + 1 !== step;
  });
  document.body.dataset.step = String(step);
  update();
  fitUrlBox();
}

let obsFor = "";

/** The OBS steps under the link (the source size follows the layout). */
function renderObs(force = false): void {
  const key = `${choices.layout}:${lang()}`;
  if (!force && key === obsFor) return;
  obsFor = key;
  obsMount.replaceChildren(obsMicNote(), obsGuide({ rollup: choices.layout === "rollup" }));
}

/** Grow the final link box to its content (it wraps long links). */
function fitUrlBox(): void {
  if (step !== LAST) return;
  urlBox.style.setProperty("height", "auto");
  urlBox.style.setProperty("height", `${urlBox.scrollHeight + 4}px`);
}

// --- init ----------------------------------------------------------------------------------------

function applyDeepLink(): void {
  const q = new URLSearchParams(window.location.search);
  const error = q.get("error");
  if (error) {
    errorText.textContent = error;
    errorBox.hidden = false;
  }
  const from = str(q.get("from"));
  const to = str(q.get("to"));
  if (from) choices.from = from.toLowerCase();
  if (to) choices.to = to.toLowerCase();
  const preset = str(q.get("preset"));
  if (preset) {
    choices.preset = preset.toLowerCase();
    const p = findPreset(choices.preset);
    if (p) {
      choices.layout = naturalLayout(p);
      layoutChosen = true;
    }
  }
  const layout = q.get("layout");
  if (layout === "blocks" || layout === "rollup") {
    choices.layout = layout;
    layoutChosen = true;
  }
  if (window.location.search !== "") {
    // Clean the address bar so a reload doesn't re-apply the deep link over later choices
    // (screen mode keeps its ?screen=).
    const keep = screenParam !== null ? `?screen=${encodeURIComponent(screenParam)}` : "";
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${keep}${window.location.hash}`,
    );
  }
}

function bindEvents(): void {
  fromSel.addEventListener("change", () => {
    choices.from = fromSel.value;
    errorBox.hidden = true;
    update();
  });
  toSel.addEventListener("change", () => {
    choices.to = toSel.value;
    errorBox.hidden = true;
    update();
  });
  // Disabled without lists and for "auto" (never a caption language: canTo is false).
  swapBtn.addEventListener("click", () => {
    const canFrom = lists?.sources.some((l) => l.code === choices.to) === true;
    const canTo = lists?.targets.some((l) => l.code === choices.from) === true;
    if (!canFrom || !canTo) {
      nextHint.textContent = t("b.cantSwap");
      return;
    }
    [choices.from, choices.to] = [choices.to, choices.from];
    update();
  });
  pairsList.addEventListener("click", (ev) => {
    const chip = ev.target instanceof Element ? ev.target.closest(".pair-chip") : null;
    if (!(chip instanceof HTMLButtonElement)) return;
    choices.from = chip.dataset.from ?? choices.from;
    choices.to = chip.dataset.to ?? choices.to;
    errorBox.hidden = true;
    update();
  });
  keyInput.addEventListener("input", () => {
    storageSet(`${STORE}key`, keyInput.value.trim() || null);
    update();
  });
  retryBtn.addEventListener("click", () => void loadLanguages());
  jumpBtn.addEventListener("click", () => goTo(LAST));

  form.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.name === "layout" && (t.value === "blocks" || t.value === "rollup")) {
      choices.layout = t.value;
      layoutChosen = true;
      update();
    } else if (t.name === "preset") {
      choices.preset = t.value;
      update();
    } else if (t.name === "lines") {
      choices.lines = intOrNull(t.value, 1, 4);
      update();
    }
  });
  sizeInput.addEventListener("input", () => {
    choices.size = intOrNull(sizeInput.value, SIZE_MIN, SIZE_MAX);
    update();
  });
  widthInput.addEventListener("input", () => {
    choices.width = intOrNull(widthInput.value, WIDTH_MIN, WIDTH_MAX);
    choices.autoWidth = false;
    placementNote = null;
    update();
  });
  heightInput.addEventListener("input", () => {
    choices.height = intOrNull(heightInput.value, HEIGHT_MIN, HEIGHT_MAX);
    choices.autoHeight = false;
    placementNote = null;
    update();
  });
  opacityInput.addEventListener("input", () => {
    const v = intOrNull(opacityInput.value, OPACITY_MIN, OPACITY_MAX);
    // Back at the theme's own value: nothing to add to the link.
    choices.opacity = v === themeOpacity() ? null : v;
    update();
  });
  showSrc.addEventListener("change", () => {
    choices.show = showSrc.checked ? "both" : "target";
    update();
  });
  quranAr.addEventListener("change", () => {
    choices.quranArabic = quranAr.checked;
    update();
  });
  partialInput.addEventListener("change", () => {
    choices.partial = partialInput.checked;
    update();
  });
  // The 3×3 grid: arrow keys move in two dimensions and pick (selection follows focus).
  placement.root.addEventListener("keydown", (ev) => {
    const cells = [...placement.root.querySelectorAll<HTMLButtonElement>(".plc-cell")];
    const active = document.activeElement;
    const i = active instanceof HTMLButtonElement ? cells.indexOf(active) : -1;
    if (i < 0) return;
    let row = Math.floor(i / 3);
    let col = i % 3;
    if (ev.key === "ArrowUp") row = Math.max(0, row - 1);
    else if (ev.key === "ArrowDown") row = Math.min(2, row + 1);
    else if (ev.key === "ArrowLeft") col = Math.max(0, col - 1);
    else if (ev.key === "ArrowRight") col = Math.min(2, col + 1);
    else return;
    ev.preventDefault();
    const next = cells[row * 3 + col];
    if (next && next !== cells[i]) {
      next.focus();
      next.click();
    }
  });
  tuneReset.addEventListener("click", () => {
    clearTuning();
    update();
  });

  micSel.addEventListener("change", () => {
    choices.mic = micSel.value;
    update();
    if (tester.active) startTest();
  });
  listMicsBtn.addEventListener("click", () => void listMics());
  testBtn.addEventListener("click", () => {
    if (tester.active || !meter.hidden) {
      if (meter.classList.contains("is-error")) startTest();
      else stopTest();
    } else {
      startTest();
    }
  });
  dspSel.addEventListener("change", () => {
    choices.dsp = dspSel.value === "on";
    update();
    if (tester.active) startTest();
  });
  chSel.addEventListener("change", () => {
    choices.ch = oneOf(chSel.value, ["mix", "left", "right"] as const) ?? "mix";
    update();
    if (tester.active) startTest();
  });
  moreAudio.addEventListener("toggle", () => {
    storageSet(`${STORE}advanced`, moreAudio.open ? "1" : null);
  });

  openBtn.addEventListener("click", () => {
    if (stepProblem(1) !== null) {
      goTo(1);
      return;
    }
    window.location.assign(captionPath());
  });
  copyBtn.addEventListener("click", () => void copyLink());
  startOverBtn.addEventListener("click", () => {
    const fresh = {
      from: lists?.from ?? "ar",
      to: lists?.to ?? "nl",
      layout: naturalLayout(findPreset(serverDefault, custom) ?? BUILTIN_DEFAULT),
      preset: "",
      mic: "",
      ch: "mix" as const,
      dsp: false,
    };
    Object.assign(choices, fresh);
    layoutChosen = false;
    clearTuning();
    storageSet(`${STORE}done`, null);
    furthest = 1;
    if (lists) {
      const sources = new Set(lists.sources.map((l) => l.code));
      const targets = new Set(lists.targets.map((l) => l.code));
      choices.from = pick(sources, choices.from, "ar", AUTO);
      // As on the first load: the list's first language when it has neither Dutch nor English.
      choices.to = pick(targets, choices.to, "nl", "en", lists.targets[0]?.code ?? null);
    }
    goTo(1);
  });

  for (const btn of stepperBtns) {
    btn.addEventListener("click", () => goTo(Number(btn.dataset.goto)));
  }
  backBtn.addEventListener("click", () => goTo(step - 1));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (step < LAST && stepProblem(step) === null) goTo(step + 1);
  });
  // Enter = Next from any field (selects, switches, sliders, radio cards); buttons, links,
  // textareas and <summary> keep their own Enter behaviour.
  form.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing || ev.defaultPrevented) return;
    const t = ev.target;
    const field = t instanceof HTMLSelectElement || t instanceof HTMLInputElement;
    if (!field) return;
    ev.preventDefault();
    if (step < LAST && stepProblem(step) === null) goTo(step + 1);
  });
  window.addEventListener("resize", fitUrlBox);
  window.addEventListener("popstate", () => goTo(hashStep(), "none"));
  window.addEventListener("hashchange", () => {
    if (hashStep() !== step) goTo(hashStep(), "none");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && tester.active) stopTest();
  });
}

// --- screen mode -------------------------------------------------------------------------------

function numParam(raw: string | null, min: number, max: number): number | null {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

function boolParam(raw: string | null): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return null;
}

/** Params the wizard reads into its own controls; everything else is kept as it is. */
const MANAGED = new Set([
  "preset",
  "layout",
  "size",
  "show",
  "quranarabic",
  "partial",
  "pos",
  "justify",
  "width",
  "height",
  "panelopacity",
  "blockopacity",
  "lines",
  "mic",
  "ch",
  "dsp",
  "screen",
  "sig",
  "key",
  "token",
  "engine",
  "translation",
]);

/** Load an existing screen's languages and link params into the wizard. */
function prefillFromScreen(v: ScreenView): void {
  const q = new URLSearchParams(v.query);
  choices.from = v.from;
  choices.to = v.to;
  choices.preset = (q.get("preset") ?? "").toLowerCase();
  const layout = q.get("layout");
  choices.layout =
    layout === "blocks" || layout === "rollup" ? layout : naturalLayout(currentPreset());
  layoutChosen = true;
  choices.size = numParam(q.get("size"), SIZE_MIN, SIZE_MAX);
  choices.show = oneOf(q.get("show"), ["both", "target", "source"] as const);
  choices.quranArabic = boolParam(q.get("quranArabic"));
  choices.partial = boolParam(q.get("partial"));
  choices.pos = oneOf(q.get("pos"), ["bottom", "top", "middle"] as const);
  choices.justify = oneOf(q.get("justify"), ["left", "center", "right"] as const);
  choices.width = numParam(q.get("width"), WIDTH_MIN, WIDTH_MAX);
  choices.height = numParam(q.get("height"), HEIGHT_MIN, HEIGHT_MAX);
  choices.opacity = numParam(
    q.get("panelOpacity") ?? q.get("blockOpacity"),
    OPACITY_MIN,
    OPACITY_MAX,
  );
  choices.autoWidth = false;
  choices.autoHeight = false;
  choices.lines = numParam(q.get("lines"), 1, 4);
  choices.mic = q.get("mic") ?? "";
  choices.ch = oneOf(q.get("ch"), ["mix", "left", "right"] as const) ?? "mix";
  choices.dsp = boolParam(q.get("dsp")) === true;
  extraParams = [...q].filter(([k]) => !MANAGED.has(k.toLowerCase()));
  fillMics(micLabels);
  if (lists) {
    fillLangSelect(fromSel, lists.sources, choices.from);
    fillLangSelect(toSel, lists.targets, choices.to);
  }
}

/** The screen's display query: theme params + microphone settings (never a key). */
function screenQuery(): string {
  const q = captionQuery();
  q.delete("key");
  return q.toString();
}

function showSaveError(message: (() => string) | null): void {
  saveProblem = message;
  saveError.textContent = message?.() ?? "";
  saveError.hidden = message === null;
}

/** The server's own message, or ours (in the language on screen, also after a switch). */
function failText(err: unknown, fallback: MsgKey): () => string {
  if (err instanceof ApiError) {
    const { message, status } = err;
    if (err.fromServer) return () => message;
    return () => (status === 0 ? t("err.network") : fallbackMessage(status));
  }
  return () => t(fallback);
}

async function saveScreen(mode: { id: string | null }): Promise<void> {
  const name = screenName.value.trim();
  if (name === "") {
    showSaveError(() => t("b.enterName"));
    screenName.focus();
    return;
  }
  if (stepProblem(1) !== null) {
    goTo(1);
    return;
  }
  showSaveError(null);
  saveBtn.disabled = true;
  try {
    const query = screenQuery();
    const v = mode.id
      ? await apiJson<ScreenView | null>("PATCH", `/api/screens/${encodeURIComponent(mode.id)}`, {
          name,
          query,
        })
      : await apiJson<ScreenView | null>("POST", "/api/screens", {
          name,
          from: choices.from,
          to: choices.to,
          query,
        });
    const id = v?.id ?? mode.id ?? "";
    window.location.assign(`/app${id ? `?saved=${encodeURIComponent(id)}` : ""}`);
  } catch (err) {
    saveBtn.disabled = false;
    if (err instanceof ApiError && err.status === 401) {
      window.location.assign(loginUrl());
      return;
    }
    showSaveError(failText(err, "b.saveFailed"));
  }
}

/** Page title, step 6 and the save button: link mode, a new screen, or an edit. */
function renderMode(): void {
  let title: string;
  if (!screenMode) {
    title = t("b.docTitleLink");
    lastStepLabel.textContent = t("step.link");
    lastTitle.textContent = t("step.link");
  } else {
    title = editing
      ? t("b.editNamed", { name: editing.name })
      : screenMode.id
        ? t("b.editScreen")
        : t("b.newScreen");
    lastStepLabel.textContent = t("step.save");
    lastTitle.textContent = t(screenMode.id ? "b.saveChanges" : "b.saveScreen");
    saveBtn.textContent = t(screenMode.id ? "b.saveChanges" : "b.saveAsScreen");
  }
  pageTitle.textContent = title;
  document.title = `${title} · ${lang() === "ar" ? "ترجمان" : "Turjuman"}`;
}

async function initScreenMode(mode: { id: string | null }): Promise<void> {
  screenCancel.hidden = false;
  linkMode.hidden = true;
  saveMode.hidden = false;
  renderMode();
  saveBtn.addEventListener("click", () => void saveScreen(mode));
  screenName.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      void saveScreen(mode);
    }
  });
  renderStepper();
  let me: Me | null;
  try {
    me = (await maybeLoggedIn()) ? await fetchMe() : null;
  } catch (err) {
    showSaveError(failText(err, "b.unreachable"));
    return;
  }
  if (!me) {
    window.location.replace(loginUrl());
    return;
  }
  header?.setAccount(me);
  if (!mode.id) return;
  try {
    const r = await apiJson<unknown>("GET", "/api/screens");
    const list = (Array.isArray(r) ? r : []) as ScreenView[];
    const v = list.find((x) => x.id === mode.id);
    if (!v) {
      pageTitle.textContent = t("b.gone");
      saveBtn.disabled = true;
      return;
    }
    editing = v;
    prefillFromScreen(v);
    renderMode();
    screenName.value = v.name;
    langsLocked = true;
    pairsRow.hidden = true;
    langLock.hidden = false;
    buildGallery();
    update();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      window.location.replace(loginUrl());
      return;
    }
    showSaveError(failText(err, "b.loadScreenFailed"));
  }
}

/** "Use https:// or http://127.0.0.1:8765/ on the server." with a real link. */
function renderInsecure(): void {
  const port = window.location.port || "8765";
  const href = `http://127.0.0.1:${port}/`;
  const a = el("a", { class: "ltr", text: href, attrs: { href } });
  insecureText.replaceChildren(...fillNodes(t("b.insecure"), { link: a }));
}

/** A language switch: everything the script wrote is written again. */
function relabel(): void {
  renderMode();
  renderInsecure();
  renderMicWhere();
  if (lists) {
    fillLangSelect(fromSel, lists.sources, choices.from);
    fillLangSelect(toSel, lists.targets, choices.to);
    if (langsLocked) {
      fromSel.disabled = true;
      toSel.disabled = true;
    }
    renderPairs(lists);
  }
  if (loadProblem) loadErrorText.textContent = loadProblem();
  if (micNoteText) showMicNote(micNoteText);
  if (saveProblem) showSaveError(saveProblem);
  renderMeter(micState);
  fillMics(micLabels);
  placement.relabel();
  buildGallery();
  renderObs(true);
  update();
}

function init(): void {
  initPage(relabel);
  header = mountHeader({
    home: screenMode ? "/app" : "/",
    nav: true,
    tabs: false,
    active: screenMode ? "screens" : null,
  });
  void authStateOnce().then((st) => mountFooter({ local: st?.mode !== "hosted" }));
  if (!screenMode) {
    // The link builder needs no login; show the account when there is one.
    void maybeLoggedIn()
      .then((on) => (on ? fetchMe() : null))
      .then((me) => header?.setAccount(me))
      .catch(() => undefined);
  }
  applyDeepLink();
  renderMode();
  renderInsecure();
  renderMicWhere();

  if (!canMic) {
    insecureBox.hidden = !remote;
    listMicsBtn.disabled = true;
    testBtn.disabled = true;
    showMicNote(() => t("mic.needsHttps"));
  }
  keyRow.hidden = !remote || screenMode !== null;
  // A screen has its own feed link (on the dashboard); the plain caption link isn't for it.
  linkSoFar.hidden = screenMode !== null;
  if (remote) keyInput.value = storageGet(`${STORE}key`) ?? "";
  if (readStored("advanced") === "1") moreAudio.open = true;
  fillMics([]);

  // "Use last setup" only on a calm start (not when the caption page sent us back with an error).
  jumpBtn.hidden = !(hadSetup && errorBox.hidden);

  mount(previewBox, stagePreview);
  mount(thumbBlocks, (w, h) =>
    renderPresetPreview(currentPreset(), {
      width: w,
      height: h,
      sample: "blocks",
      lang: choices.to,
    }),
  );
  mount(thumbRollup, (w, h) =>
    renderPresetPreview(currentPreset(), {
      width: w,
      height: h,
      sample: "rollup",
      lang: choices.to,
    }),
  );
  if (!layoutChosen) choices.layout = naturalLayout(currentPreset());
  buildGallery();
  bindEvents();

  const wanted = hashStep();
  furthest = wanted;
  step = 0;
  goTo(wanted, "replace", false);
  if (step < wanted) pendingStep = wanted;

  void knownMicLabels().then((labels) => {
    if (labels.length > 0) fillMics(labels);
  });
  void loadLanguages();
  void loadPresets();
  if (screenMode) void initScreenMode(screenMode);
}

init();
