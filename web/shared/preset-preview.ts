// Live mini previews of caption presets (the picker's preset gallery, /customize) and the
// customizer's large stage. Self-contained: own `pp-*` CSS that mirrors web/shared/blocks.css
// (same variables, same fallbacks, same structure) but stays inside its stage element, so it
// can be dropped into any page without touching html/body.
//
// A stage is laid out at a real screen size (e.g. 1920×1080 CSS px) and scaled down with a
// transform. Viewport units in theme values (92vw, 100vh) are converted to stage pixels first,
// so a preview looks exactly like the screen it simulates, whatever the host window size.
import "./preset-preview.css";
import { dirFor } from "../../src/shared/lang.js";
import { applyTheme, presetTheme, type ThemeVars } from "../../src/shared/theme.js";
import type { DisplayOptions, ThemePreset, ThemeVar } from "../../src/shared/theme-vars.js";
import { el } from "./dom.js";
import { honNodes } from "./hon.js";
import { eventLabel, uiLabels } from "./i18n.js";

/** The API below is final (the picker imports it). */
export const PRESET_PREVIEW_READY = true;

export interface PresetPreviewOptions {
  /** Card size in CSS px (default 320×180). */
  width?: number;
  height?: number;
  /** Sample content; default follows the preset's layout. */
  sample?: "blocks" | "rollup";
  /** The caption (target) language: the sample is in it when there is one, else English. */
  lang?: string;
}

export type StageBackdrop = "video" | "dark" | "light" | "checker";
export type StageSample = "khutbah" | "events";

export interface StageSpec {
  /** Simulated screen size in CSS px (e.g. 1920×1080). */
  width: number;
  height: number;
  vars: ThemeVars;
  options: DisplayOptions;
  sample?: StageSample;
  backdrop?: StageBackdrop;
  /** Listening dots under the newest block (blocks layout). */
  listening?: boolean;
  /** Browser mode: the toolbar shows unless toolbar=off (OBS hides it with toolbar=auto). */
  browser?: boolean;
  /** Play the slide-in of the newest block. */
  animate?: boolean;
  /** The caption (target) language: the sample is in it when there is one, else English. */
  lang?: string;
}

interface SampleBlock {
  kind: "speech" | "quran" | "dua" | "event";
  text: string;
  ref?: string;
  /** What was said, shown under the translation (show=both): Arabic, or English under Arabic. */
  src?: string;
  /** The verse in Arabic above the translation (quranArabic); not on an Arabic screen. */
  quranText?: string;
  event?: { type: "athan" | "iqama"; active: boolean; time?: string };
}

/** The languages with sample text; any other caption language shows the English sample. */
export type SampleLang = "en" | "nl" | "ar";

export function sampleLang(lang: string | undefined): SampleLang {
  const base = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return base === "nl" || base === "ar" ? base : "en";
}

// The English and Arabic sample is the website's khutbah (site/content/khutbah.ts): 49:13 in
// Tanzil Uthmani and Saheeh International, unmodified. The Dutch sample keeps its own text.
const V49_13 = "يَـٰٓأَيُّهَا ٱلنَّاسُ إِنَّا خَلَقْنَـٰكُم مِّن ذَكَرٍ وَأُنثَىٰ وَجَعَلْنَـٰكُمْ شُعُوبًا وَقَبَآئِلَ لِتَعَارَفُوٓا۟";
const EN_AR: ReadonlyArray<{ kind: SampleBlock["kind"]; ar: string; en: string; ref?: string }> = [
  {
    kind: "speech",
    ar: "إن الحمد لله، نحمده ونستعينه ونستغفره",
    en: "Indeed, all praise is for Allah. We praise Him, seek His help and ask His forgiveness.",
  },
  {
    kind: "quran",
    ar: V49_13,
    en: "O mankind, indeed We have created you from male and female and made you peoples and tribes that you may know one another.",
    ref: "49:13",
  },
  {
    kind: "speech",
    ar: "فالتعارف بداية الأخوة",
    en: "Knowing one another is where brotherhood begins.",
  },
  {
    kind: "speech",
    ar: "قال رسول الله ﷺ: لا يؤمن أحدكم حتى يحب لأخيه ما يحب لنفسه",
    en: "The Messenger of Allah ﷺ said: “None of you truly believes until he loves for his brother what he loves for himself.”",
  },
  {
    kind: "dua",
    ar: "اللهم اجعلنا من الصابرين واغفر لنا ذنوبنا",
    en: "O Allah, make us among the patient and forgive us our sins.",
  },
];

const KHUTBAH: Readonly<Record<SampleLang, readonly SampleBlock[]>> = {
  nl: [
    {
      kind: "speech",
      text: "Broeders en zusters, vandaag spreken we over geduld in moeilijke tijden.",
      src: "أيها الإخوة والأخوات، نتحدث اليوم عن الصبر في الأوقات الصعبة",
    },
    {
      kind: "quran",
      text: "Allah belast niemand boven zijn vermogen.",
      ref: "2:286",
      src: "لا يكلف الله نفسا إلا وسعها",
      quranText: "لَا يُكَلِّفُ ٱللَّهُ نَفْسًا إِلَّا وُسْعَهَا",
    },
    {
      kind: "speech",
      text: "De Profeet ﷺ zei: “Wie geen barmhartigheid toont, krijgt geen barmhartigheid.”",
      src: "قال رسول الله صلى الله عليه وسلم: من لا يرحم لا يرحم",
    },
    {
      kind: "speech",
      text: "Musa ﵇ zei tegen zijn volk: “Zoek hulp bij Allah ﷻ en wees geduldig.”",
      src: "قال موسى عليه السلام لقومه استعينوا بالله واصبروا",
    },
    {
      kind: "dua",
      text: "O Allah, maak ons tot de geduldigen en vergeef ons onze zonden.",
      src: "اللهم اجعلنا من الصابرين واغفر لنا ذنوبنا",
    },
    {
      kind: "speech",
      text: "Als iemand Allah de hele dag vergeet, verhardt zijn hart beetje bij beetje.",
      src: "إن الإنسان إذا نسي ذكر الله في يومه كله فإن قلبه يقسو شيئا فشيئا",
    },
  ],
  en: EN_AR.map((b) => ({
    kind: b.kind,
    text: b.en,
    src: b.ar,
    ...(b.ref ? { ref: b.ref, quranText: b.ar } : {}),
  })),
  ar: EN_AR.map((b) => ({ kind: b.kind, text: b.ar, src: b.en, ...(b.ref ? { ref: b.ref } : {}) })),
};

const EVENTS: Readonly<Record<SampleLang, readonly SampleBlock[]>> = {
  nl: [
    { kind: "event", text: "", event: { type: "athan", active: false, time: "13:02" } },
    {
      kind: "speech",
      text: "Moge Allah ons gebed aanvaarden. Recht de rijen en sluit de openingen.",
      src: "تقبل الله منا ومنكم، استووا واعتدلوا وسدوا الفرج",
    },
    {
      kind: "quran",
      text: "Voorwaar, het gebed is voor de gelovigen een voorschrift op vaste tijden.",
      ref: "4:103",
      src: "إن الصلاة كانت على المؤمنين كتابا موقوتا",
      quranText: "إِنَّ ٱلصَّلَوٰةَ كَانَتْ عَلَى ٱلْمُؤْمِنِينَ كِتَٰبًا مَّوْقُوتًا",
    },
    { kind: "event", text: "", event: { type: "iqama", active: true } },
  ],
  en: [
    { kind: "event", text: "", event: { type: "athan", active: false, time: "13:02" } },
    {
      kind: "speech",
      text: "May Allah accept from us and from you. Straighten the rows and close the gaps.",
      src: "تقبل الله منا ومنكم، استووا واعتدلوا وسدوا الفرج",
    },
    { kind: "event", text: "", event: { type: "iqama", active: true } },
  ],
  ar: [
    { kind: "event", text: "", event: { type: "athan", active: false, time: "13:02" } },
    {
      kind: "speech",
      text: "تقبل الله منا ومنكم، استووا واعتدلوا وسدوا الفرج",
      src: "May Allah accept from us and from you. Straighten the rows and close the gaps.",
    },
    {
      kind: "quran",
      text: "إِنَّ ٱلصَّلَوٰةَ كَانَتْ عَلَى ٱلْمُؤْمِنِينَ كِتَٰبًا مَّوْقُوتًا",
      ref: "4:103",
    },
    { kind: "event", text: "", event: { type: "iqama", active: true } },
  ],
};

/** Roll-up: the original on top, the translation below (two windows of a long sentence). */
const ROLLUP_AR =
  "إن الإنسان إذا نسي ذكر الله في يومه كله فإن قلبه يقسو شيئا فشيئا حتى لا يعرف معروفا ولا ينكر منكرا";
const ROLLUP_EN =
  "Brothers and sisters, the Prophet ﷺ taught us patience. When someone forgets Allah all day long, his heart hardens little by little.";
const ROLLUP: Readonly<Record<SampleLang, { src: string; text: string }>> = {
  nl: {
    src: ROLLUP_AR,
    text: "Broeders en zusters, de Profeet ﷺ leerde ons geduld. Als iemand Allah de hele dag vergeet, verhardt zijn hart beetje bij beetje.",
  },
  en: { src: ROLLUP_AR, text: ROLLUP_EN },
  ar: { src: ROLLUP_EN, text: ROLLUP_AR },
};

/** Live words while listening: what is being said (Arabic; English under an Arabic screen). */
const PARTIAL: Readonly<Record<"ar" | "en", string>> = {
  ar: "واعلموا عباد الله أن من أعظم أسباب",
  en: "Know, servants of Allah, that among the greatest causes",
};

const QUOTED = /^["“„«‘']/;

/** Text with honorific ligatures (ﷺ ﷻ ﵇ …) wrapped exactly like the live renderer (.cap-hon). */
export function withHonorifics(text: string): Node[] {
  return honNodes(text);
}

function formatRef(ref: string): string {
  return ref.replace(/(\d)\s*-\s*(\d)/g, "$1–$2");
}

/** Theme values with viewport units converted to pixels of a `w`×`h` stage. */
export function stageVars(vars: ThemeVars, w: number, h: number): ThemeVars {
  const out: ThemeVars = {};
  const unit = (n: number, u: string): number => {
    if (u === "vw") return (n * w) / 100;
    if (u === "vh") return (n * h) / 100;
    if (u === "vmin") return (n * Math.min(w, h)) / 100;
    return (n * Math.max(w, h)) / 100;
  };
  for (const [k, v] of Object.entries(vars) as Array<[ThemeVar, string | undefined]>) {
    if (v === undefined) continue;
    out[k] = v.replace(
      /(-?(?:\d+(?:\.\d+)?|\.\d+))(vw|vh|vmin|vmax)\b/g,
      (_m, n: string, u: string) => `${Math.round(unit(Number(n), u) * 10) / 10}px`,
    );
  }
  return out;
}

function backdrop(kind: StageBackdrop): HTMLElement {
  const bd = el("div", { class: `pp-backdrop pp-bd-${kind}` });
  if (kind === "video") {
    bd.append(
      el("div", { class: "pp-bd-wall" }),
      el("div", { class: "pp-bd-arch" }, [el("div", { class: "pp-bd-arch-in" })]),
      el("div", { class: "pp-bd-lamp" }),
      el("div", { class: "pp-bd-floor" }),
      el("div", { class: "pp-bd-vignette" }),
    );
  }
  return bd;
}

/** The original under a block: Arabic, or English under Arabic captions. */
function srcAttrs(l: SampleLang): Record<string, string> {
  return l === "ar" ? { dir: "ltr", lang: "en" } : { dir: "rtl", lang: "ar" };
}

function blockNode(b: SampleBlock, o: DisplayOptions, l: SampleLang, target: string): HTMLElement {
  const node = el("article", {
    class: `pp-blk pp-blk-${b.kind}`,
    attrs: { lang: l, dir: dirFor(l) },
  });
  if (b.kind === "event" && b.event) {
    const ev = { ...eventLabel(b.event.type, target), ...b.event };
    if (ev.active) {
      node.classList.add("is-active");
      const card = el("div", { class: "pp-ev-card" }, [
        el("div", { class: "pp-ev-wave" }, [el("i"), el("i"), el("i"), el("i"), el("i")]),
        el("div", { class: "pp-ev-ar", text: ev.ar, attrs: { dir: "rtl", lang: "ar" } }),
        el("div", { class: "pp-ev-title", text: ev.title }),
      ]);
      if (ev.subtitle) card.append(el("div", { class: "pp-ev-sub", text: ev.subtitle }));
      node.append(card);
    } else {
      node.classList.add("is-ended");
      node.append(
        el("div", { class: "pp-ev-compact" }, [
          el("span", { class: "pp-ev-compact-ar", text: ev.ar, attrs: { dir: "rtl", lang: "ar" } }),
          el("span", { text: `${ev.title} · ${ev.time ?? ""}` }),
        ]),
      );
    }
    return node;
  }
  const accent = b.kind === "quran" ? o.quranAccent : b.kind === "dua";
  node.classList.toggle("has-accent", accent);
  if (b.kind === "quran" && b.quranText && o.quranArabic) {
    node.append(
      el("p", { class: "pp-quran-ar", text: b.quranText, attrs: { dir: "rtl", lang: "ar" } }),
    );
  }
  const text = el("p", { class: "pp-text" });
  const body = b.kind === "quran" && !QUOTED.test(b.text) ? `“${b.text}”` : b.text;
  text.append(...withHonorifics(body));
  if (b.ref) text.append(" ", el("span", { class: "pp-ref", text: `(${formatRef(b.ref)})` }));
  node.append(text);
  if (b.src) node.append(el("p", { class: "pp-src", text: b.src, attrs: srcAttrs(l) }));
  return node;
}

function blocksView(spec: StageSpec): HTMLElement {
  const o = spec.options;
  const root = el("div", {
    class: `pp-root pos-${o.pos} bg-${o.bg === "none" || o.bg === "shadow" ? "none" : "panel"} show-${o.show}`,
  });
  const list = el("div", { class: "pp-list" });
  const l = sampleLang(spec.lang);
  let items = (spec.sample === "events" ? EVENTS : KHUTBAH)[l];
  if (o.visibleBlocks > 0) items = items.slice(-o.visibleBlocks);
  items.forEach((b, i) => {
    const node = blockNode(b, o, l, spec.lang || l);
    if (i === items.length - 1) {
      node.classList.add("is-new");
      if (spec.animate) node.classList.add("pp-enter");
    }
    list.append(node);
  });
  const scroll = el("div", { class: "pp-scroll" }, [list]);
  const panel = el("div", { class: "pp-panel" }, [scroll]);
  const listen = el("div", { class: "pp-listen" }, [
    el("span", { class: "pp-dots" }, [el("i"), el("i"), el("i")]),
  ]);
  if (spec.listening ?? true) listen.classList.add("is-on");
  if (o.partial) {
    listen.classList.add("with-partial");
    // What is being said: Arabic, or English while the captions are Arabic.
    const said = l === "ar" ? "en" : "ar";
    listen.append(
      el("span", { class: `pp-partial-box${said === "en" ? " is-ltr" : ""}` }, [
        el("span", {
          class: "pp-partial",
          text: PARTIAL[said],
          attrs: { dir: dirFor(said), lang: said },
        }),
      ]),
    );
  }
  panel.append(listen);
  root.append(panel);
  return root;
}

function rollupView(spec: StageSpec): HTMLElement {
  const o = spec.options;
  const root = el("div", { class: `pp-roll bg-${o.bg}` });
  const lines = Math.max(1, Math.min(6, o.lines));
  const l = sampleLang(spec.lang);
  const sample = ROLLUP[l];
  const block = (text: string, src: boolean): HTMLElement => {
    const attrs = src ? srcAttrs(l) : { lang: l, dir: dirFor(l) };
    const p = el("p", { class: "pp-roll-text" });
    p.append(...withHonorifics(text));
    const win = el("div", { class: "pp-roll-window" }, [p]);
    win.style.setProperty("--pp-lines", String(lines));
    return el("div", { class: `pp-roll-block ${src ? "is-src" : "is-tgt"}`, attrs }, [win]);
  };
  if (o.show !== "target") root.append(block(sample.src, true));
  if (o.show !== "source") root.append(block(sample.text, false));
  return el("div", { class: `pp-roll-area pos-${o.pos}` }, [root]);
}

/** The caption page's toolbar, labelled in the caption language as the real one is. */
function toolbar(target: string): HTMLElement {
  return el("div", { class: "pp-tb" }, [
    el("span", { class: "pp-tb-live" }, [
      el("i", { class: "pp-tb-dot" }),
      el("span", { text: uiLabels(target).live }),
    ]),
    el("span", { class: "pp-tb-chip", text: target.toUpperCase() }),
    el("span", { class: "pp-tb-sep" }),
    el("span", { class: "pp-tb-btn", text: "A−" }),
    el("span", { class: "pp-tb-btn", text: "A+" }),
  ]);
}

/**
 * A stage at its real size (spec.width × spec.height CSS px), not scaled: the caller scales it
 * (see fitStage). Theme variables are applied on the stage element itself.
 */
export function buildStage(spec: StageSpec): HTMLElement {
  const o = spec.options;
  const stage = el("div", { class: `pp-stage layout-${o.layout}` });
  stage.classList.toggle("quran-ar", o.quranArabic);
  stage.style.setProperty("width", `${spec.width}px`);
  stage.style.setProperty("height", `${spec.height}px`);
  applyTheme(stage, stageVars(spec.vars, spec.width, spec.height));
  stage.append(backdrop(spec.backdrop ?? "video"), el("div", { class: "pp-page" }));
  stage.append(o.layout === "rollup" ? rollupView(spec) : blocksView(spec));
  const showToolbar = o.toolbar === "on" || (o.toolbar === "auto" && spec.browser === true);
  if (showToolbar && o.layout === "blocks") stage.append(toolbar(spec.lang || "en"));
  return stage;
}

/** Scale a stage into a box of `boxW`×`boxH` (contain); returns the scale factor. */
export function fitStage(
  stage: HTMLElement,
  stageW: number,
  stageH: number,
  boxW: number,
  boxH: number,
): number {
  const k = Math.max(0.01, Math.min(boxW / stageW, boxH / stageH));
  stage.style.setProperty("transform", `scale(${k})`);
  return k;
}

/** A self-contained, scaled live mini preview of a preset (sample blocks or a roll-up, in the
 *  caption language when there is a sample in it). */
export function renderPresetPreview(
  preset: ThemePreset,
  opts: PresetPreviewOptions = {},
): HTMLElement {
  const w = Math.max(80, Math.round(opts.width ?? 320));
  const h = Math.max(45, Math.round(opts.height ?? 180));
  const stageW = 1920;
  const stageH = Math.round((stageW * h) / w);
  const theme = presetTheme(preset);
  const options: DisplayOptions = { ...theme.options };
  if (opts.sample === "rollup" || opts.sample === "blocks") options.layout = opts.sample;
  if (options.layout === "rollup" && options.bg === "panel") options.bg = "band";
  const card = el("div", {
    class: "pp-card",
    attrs: { role: "img", "aria-label": `${preset.name}: preview` },
  });
  card.style.setProperty("width", `${w}px`);
  card.style.setProperty("height", `${h}px`);
  const stage = buildStage({
    width: stageW,
    height: stageH,
    vars: theme.vars,
    options,
    sample: "khutbah",
    backdrop: "video",
    listening: true,
    browser: false,
    ...(opts.lang ? { lang: opts.lang } : {}),
  });
  fitStage(stage, stageW, stageH, w, h);
  card.append(stage);
  return card;
}
