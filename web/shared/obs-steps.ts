// "Show on a screen": the feed link with Copy and Open, and how to show it: numbered steps for
// OBS Studio (from docs/guide.md, "OBS setup") and the short alternative.
// Used by the dashboard (a sheet per screen, and the "Your screen is ready" note after saving)
// and by the builder's last step. Rebuilt by the caller on a language switch.
import { DEFAULT_PRESET_ID, resolveTheme } from "../../src/shared/theme.js";
import { copyText, icon, toast } from "../admin-ui.js";
import { t } from "./app-i18n.js";
import { fillNodes } from "./app-shell.js";
import { el } from "./dom.js";

/** Rolling captions are a strip (1920 × 400); blocks fill the picture (1920 × 1080). */
export function isRollup(query: string): boolean {
  const q = new URLSearchParams(query);
  const layout = q.get("layout");
  if (layout === "rollup" || layout === "blocks") return layout === "rollup";
  // No layout in the link: the look (preset) decides.
  return resolveTheme(q, [], DEFAULT_PRESET_ID).options.layout === "rollup";
}

/** A name from the OBS window, kept as OBS writes it (left to right on an Arabic page too). */
function uiName(text: string): HTMLElement {
  return el("span", { class: "obs-ui", text, attrs: { lang: "en", dir: "ltr" } });
}

function flag(text: string): HTMLElement {
  return el("code", { class: "ltr", text });
}

/** A command line flag never breaks at its hyphens. */
function nowrap(text: string): HTMLElement {
  return el("code", { class: "ltr obs-flag", text });
}

/** The OBS steps and the alternative (no link: the caller shows it). */
export function obsGuide(opts: { rollup: boolean }): HTMLElement {
  const os = el("dl", { class: "obs-os" }, [
    el("dt", { text: "Windows" }),
    el("dd", {}, fillNodes(t("sos.winText"), { flag: nowrap("--enable-media-stream") })),
    el("dt", { text: "macOS" }),
    el("dd", {}, [
      el("span", { class: "ltr" }, [
        flag("/Applications/OBS.app/Contents/MacOS/OBS"),
        " ",
        nowrap("--enable-media-stream"),
      ]),
    ]),
    el("dt", { text: "Linux" }),
    el("dd", {}, [
      el("span", { class: "ltr" }, [flag("obs"), " ", nowrap("--enable-media-stream")]),
    ]),
  ]);
  const size = (n: string): HTMLElement => el("span", { class: "ltr", text: n });
  const steps = el("ol", { class: "tj-steps obs-steps" }, [
    el("li", {}, [el("span", { text: t("sos.obs1") }), os]),
    el("li", { text: t("sos.obs2") }),
    el(
      "li",
      {},
      fillNodes(t("sos.obs3"), { w: size("1920"), h: size(opts.rollup ? "400" : "1080") }),
    ),
    el("li", {}, [
      el("span", { text: t("sos.obs4") }),
      el("span", { class: "obs-names" }, [
        uiName("Shutdown source when not visible"),
        uiName("Refresh browser when scene becomes active"),
      ]),
    ]),
    el("li", {}, fillNodes(t("sos.obs5"), { projector: uiName("Open Scene Projector") })),
  ]);
  return el("div", { class: "obs-guide" }, [
    el("section", { class: "obs-part" }, [
      el("h3", { class: "obs-title", text: t("sos.obsTitle") }),
      steps,
    ]),
    el("section", { class: "obs-part" }, [
      el("h3", { class: "obs-title", text: t("sos.otherTitle") }),
      el("p", { class: "obs-other", text: t("sos.other") }),
    ]),
  ]);
}

let linkSeq = 0;

/** The feed link, Copy and Open, a privacy hint and the microphone fact. */
export function linkBlock(url: string): HTMLElement {
  const id = `sos-link-${++linkSeq}`;
  const input = el("input", {
    class: "ui-input mono sos-url",
    attrs: { id, readonly: "", spellcheck: "false", dir: "ltr", "aria-describedby": `${id}-hint` },
  });
  input.value = url;
  input.addEventListener("focus", () => input.select());
  const copy = el("button", { class: "ui-btn ui-btn-primary", attrs: { type: "button" } }, [
    icon("copy"),
    el("span", { text: t("sc.copyLink") }),
  ]);
  copy.addEventListener("click", async () => {
    const ok = await copyText(url);
    toast(ok ? t("toast.linkCopied") : t("toast.copyFailed"), ok ? "ok" : "error");
  });
  // Not on a phone (CSS: narrow and a coarse pointer): the page would listen to the phone's
  // microphone, a second session next to the screen's own. Copy link stays.
  const open = el(
    "a",
    {
      class: "ui-btn ui-btn-secondary sos-open",
      attrs: { href: url, target: "_blank", rel: "noopener" },
    },
    [icon("open"), el("span", { text: t("common.open") })],
  );
  return el("div", { class: "sos-link" }, [
    el("label", { class: "ui-label", text: t("sos.link"), attrs: { for: id } }),
    input,
    el("div", { class: "sos-actions" }, [copy, open]),
    el("p", { class: "ui-hint", text: t("sos.private"), attrs: { id: `${id}-hint` } }),
  ]);
}

/** The microphone fact: the page listens on the computer that shows it. */
export function micNote(): HTMLElement {
  return el("p", { class: "sos-mic" }, [icon("mic", 18), el("span", { text: t("sos.mic") })]);
}

/** Where OBS or the browser runs (local mode): remembered while the page is open. */
type Where = "here" | "elsewhere";
let where: Where | null = null;

export interface ScreenLinks {
  /** The link of the address the app was opened on (hosted: the public HTTPS link). */
  url: string;
  /** Local mode: http://127.0.0.1:<port>/feed/… for the computer that runs Turjuman. */
  localUrl?: string | null;
  /** Local mode: an HTTPS link for other computers and TVs (null until HTTPS is set up). */
  secureUrl?: string | null;
  query: string;
}

/** The link "Copy link" on a screen copies: the one the panel shows now (hosted: the public link;
 *  local: this computer's or the HTTPS one), or null when there is none yet (open the panel). */
export function chosenLink(view: ScreenLinks, mode: "local" | "hosted"): string | null {
  if (mode === "hosted") return view.url;
  const local = view.localUrl ?? null;
  const secure = view.secureUrl ?? null;
  const w = where ?? (local !== null ? "here" : "elsewhere");
  return w === "here" ? (local ?? secure) : secure;
}

/** Local mode without an HTTPS link: what to set up (docs/guide.md, "HTTPS on the LAN"). The
 *  server offers that link only with `server.exposure: lan` and `server.https.port` set (Docker:
 *  CAPTIONS_BIND=0.0.0.0 too, else compose publishes on 127.0.0.1 only), after a restart. */
function httpsHelp(): HTMLElement {
  const { hostname, host, protocol, port } = window.location;
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  // Other devices fetch the CA over plain http, on the port this page came from.
  const ca =
    protocol === "http:" && !loopback
      ? `http://${host}/ca.crt`
      : `http://<server>:${protocol === "http:" && port !== "" ? port : "8765"}/ca.crt`;
  return el("div", { class: "sos-https", attrs: { role: "note" } }, [
    el("p", { class: "sos-https-title", text: t("sos.httpsTitle") }),
    el("p", { class: "sos-https-why", text: t("sos.httpsWhy") }),
    el("ol", { class: "tj-steps" }, [
      el(
        "li",
        {},
        fillNodes(t("sos.https1"), {
          cmd: flag("bash scripts/lan-cert.sh tls"),
          docker: flag("make lan-cert"),
        }),
      ),
      el(
        "li",
        {},
        fillNodes(t("sos.https2"), {
          exposure: flag("server.exposure: lan"),
          port: flag("server.https.port: 8443"),
          bind: flag("CAPTIONS_BIND=0.0.0.0"),
          env: flag(".env"),
        }),
      ),
      el("li", {}, fillNodes(t("sos.httpsRestart"), { restart: flag("make restart") })),
      el("li", {}, fillNodes(t("sos.https3"), { ca: flag(ca) })),
    ]),
    el(
      "p",
      { class: "sos-https-more" },
      fillNodes(t("sos.httpsMore"), { guide: flag("docs/guide.md") }),
    ),
  ]);
}

/** Local mode: "On this computer" or "On another computer or TV". */
function whereChoice(onPick: (w: Where) => void): HTMLElement {
  const name = `sos-where-${++linkSeq}`;
  const option = (value: Where, title: string, hint: string): HTMLLabelElement => {
    const input = el("input", { attrs: { type: "radio", name, value } });
    input.checked = where === value;
    input.addEventListener("change", () => {
      if (input.checked) onPick(value);
    });
    return el("label", { class: "sos-where-opt" }, [
      input,
      el("span", { class: "sos-where-text" }, [
        el("span", { class: "sos-where-title", text: title }),
        el("span", { class: "sos-where-hint", text: hint }),
      ]),
    ]);
  };
  return el("fieldset", { class: "sos-where" }, [
    el("legend", { class: "ui-label", text: t("sos.where") }),
    option("here", t("sos.here"), t("sos.hereHint")),
    option("elsewhere", t("sos.elsewhere"), t("sos.elsewhereHint")),
  ]);
}

/**
 * Everything of "Show on a screen" for one screen (a sheet body, or the note after saving).
 * Hosted mode: the public link. Local mode: the link for this computer (127.0.0.1) or the HTTPS
 * link for other devices; never a plain-http network link, where the microphone can't open.
 */
export function showOnScreen(
  view: ScreenLinks,
  mode: "local" | "hosted",
  opts: { guide?: boolean } = {},
): HTMLElement {
  const guide = opts.guide === false ? [] : [obsGuide({ rollup: isRollup(view.query) })];
  if (mode === "hosted") {
    return el("div", { class: "sos" }, [linkBlock(view.url), micNote(), ...guide]);
  }
  const local = view.localUrl ?? null;
  const secure = view.secureUrl ?? null;
  if (where === null || (where === "here" && local === null)) {
    where = local !== null ? "here" : "elsewhere";
  }
  const slot = el("div", { class: "sos-slot" });
  const fill = (): void => {
    const url = where === "here" ? local : secure;
    slot.replaceChildren(url !== null ? linkBlock(url) : httpsHelp());
  };
  // Without a link for this computer (the server doesn't listen on 127.0.0.1) there is no choice.
  const choice =
    local === null
      ? []
      : [
          whereChoice((w) => {
            where = w;
            fill();
          }),
        ];
  const root = el("div", { class: "sos" }, [...choice, slot, micNote(), ...guide]);
  fill();
  return root;
}
