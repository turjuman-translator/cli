// Keys (GET /app/keys): onboarding while the Soniox key is missing (short numbered steps to get
// one, and a masked field), and the management view once it exists: status, Replace, Remove (a
// two-step confirm in the page) and this month's usage. Keys go to PUT /api/org/keys/:provider and
// never come back: the browser only ever sees KeyStatus (set, last4, validatedAt, source).
import "./keys.css";
import {
  ApiError,
  apiJson,
  authStateOnce,
  errText,
  fetchMe,
  fetchOrg,
  httpDetail,
  type KeyProvider,
  type KeyPutResult,
  type KeyStatus,
  loginUrl,
  type Me,
  maybeLoggedIn,
  type OrgView,
  retryText,
} from "./admin-api.js";
import { icon, toast } from "./admin-ui.js";
import { fmtUsd, fmtWhen, type MsgKey, t, tn } from "./shared/app-i18n.js";
import {
  fillNodes,
  initPage,
  isAdminRole,
  mountFooter,
  mountHeader,
  setTitle,
} from "./shared/app-shell.js";
import { byId, el } from "./shared/dom.js";

interface ProviderSpec {
  id: KeyProvider;
  name: string;
  title: MsgKey;
  need: MsgKey;
  link: { href: string; label: string };
  steps: readonly MsgKey[];
  removeMsg: MsgKey;
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "soniox",
    name: "Soniox",
    title: "keys.sonioxTitle",
    need: "keys.required",
    link: { href: "https://console.soniox.com", label: "console.soniox.com" },
    steps: ["keys.sonioxStep1", "keys.sonioxStep2", "keys.sonioxStep3", "keys.stepPaste"],
    removeMsg: "keys.removeSoniox",
  },
];

type Mode = "view" | "edit" | "confirm";

interface Slot {
  spec: ProviderSpec;
  root: HTMLElement;
  status: KeyStatus;
  mode: Mode;
  /** The key being typed (kept across a language switch). */
  draft: string;
  busy: boolean;
  /** The last save's outcome, or an error. */
  result: { kind: "ok" | "warn" | "error"; text: () => string } | null;
}

const lead = byId("keys-lead", HTMLParagraphElement);
const errorBox = byId("keys-error", HTMLDivElement);
const errorText = byId("keys-error-text", HTMLSpanElement);
const loading = byId("keys-loading", HTMLParagraphElement);
const providersBox = byId("providers", HTMLDivElement);
const usage = byId("usage", HTMLElement);
const usageMinutes = byId("usage-minutes", HTMLParagraphElement);
const usageCost = byId("usage-cost", HTMLParagraphElement);
const nextBox = byId("next", HTMLElement);
const nextText = byId("next-text", HTMLParagraphElement);
const nextLink = byId("next-link", HTMLAnchorElement);

let me: Me | null = null;
let org: OrgView | null = null;
let screenCount: number | null = null;
let failure: (() => string) | null = null;
const slots = new Map<KeyProvider, Slot>();

function canEdit(): boolean {
  return isAdminRole(org);
}

/** "Create an account at {link}." with a real link in place of {link}. */
function withLink(text: string, link: { href: string; label: string }): Node[] {
  const a = el("a", {
    class: "ltr",
    text: link.label,
    attrs: { href: link.href, target: "_blank", rel: "noopener noreferrer" },
  });
  return fillNodes(text, { link: a });
}

function statusLine(s: KeyStatus): { kind: "ok" | "warn"; text: string } {
  if (s.validatedAt) {
    const ms = Date.parse(s.validatedAt);
    return {
      kind: "ok",
      text: t("keys.works", { when: Number.isFinite(ms) ? fmtWhen(ms) : s.validatedAt }),
    };
  }
  return { kind: "warn", text: t("keys.storedUnchecked") };
}

/** The stored key as the browser may show it: dots and the last four characters. */
function keyfield(s: KeyStatus): HTMLElement {
  const parts: HTMLElement[] = [];
  if (s.source === "env") {
    parts.push(el("span", { class: "kf-env", text: t("keys.env") }));
    if (s.last4) parts.push(el("span", { class: "kf-mask ltr", text: `••••${s.last4}` }));
  } else {
    parts.push(el("span", { class: "kf-mask ltr", text: `••••••••••••${s.last4 ?? ""}` }));
    const st = statusLine(s);
    const ok = el("span", { class: `kf-state is-${st.kind}` }, [
      icon(st.kind === "ok" ? "check" : "lock", 15),
      el("span", { text: st.text }),
    ]);
    parts.push(ok);
  }
  return el("div", { class: "keyfield" }, parts);
}

function renderSlot(slot: Slot): void {
  const { spec, status } = slot;
  const editable = canEdit() && status.source !== "env";
  const head = el("div", { class: "kx-side" }, [
    el("h2", { class: "kx-title", text: t(spec.title) }),
    el("p", { class: "kx-need is-required", text: t(spec.need) }),
  ]);

  const body = el("div", { class: "kx-body" });
  const showSteps = !status.set && editable;
  if (showSteps) {
    const ol = el("ol", { class: "tj-steps kx-steps" });
    for (const k of spec.steps) ol.append(el("li", {}, withLink(t(k), spec.link)));
    body.append(ol);
  }

  if (status.set && slot.mode !== "edit") {
    body.append(keyfield(status));
    if (status.source === "env") {
      body.append(el("p", { class: "kx-muted", text: t("keys.envHint") }));
    } else if (editable && slot.mode === "confirm") {
      const yes = el("button", {
        class: "ui-btn ui-btn-danger ui-btn-sm",
        text: t("keys.removeYes"),
        attrs: { type: "button" },
      });
      const no = el("button", {
        class: "ui-btn ui-btn-ghost ui-btn-sm",
        text: t("common.cancel"),
        attrs: { type: "button" },
      });
      yes.disabled = slot.busy;
      yes.addEventListener("click", () => void removeKey(slot));
      no.addEventListener("click", () => {
        slot.mode = "view";
        renderSlot(slot);
        slot.root.querySelector<HTMLButtonElement>(".kx-remove")?.focus();
      });
      const confirm = el("div", { class: "kx-confirm", attrs: { role: "alert" } }, [
        el("p", { text: t(spec.removeMsg) }),
        el("div", { class: "kx-actions" }, [yes, no]),
      ]);
      body.append(confirm);
      queueMicrotask(() => no.focus());
    } else if (editable) {
      const replace = el("button", {
        class: "ui-btn ui-btn-secondary ui-btn-sm",
        text: t("keys.replace"),
        attrs: { type: "button" },
      });
      const remove = el("button", {
        class: "ui-btn ui-btn-ghost ui-btn-sm kx-remove",
        text: t("keys.remove"),
        attrs: { type: "button" },
      });
      replace.addEventListener("click", () => {
        slot.mode = "edit";
        slot.result = null;
        renderSlot(slot);
        slot.root.querySelector<HTMLInputElement>("input")?.focus();
      });
      remove.addEventListener("click", () => {
        slot.mode = "confirm";
        renderSlot(slot);
      });
      body.append(el("div", { class: "kx-actions" }, [replace, remove]));
    }
  } else if (editable) {
    body.append(keyForm(slot));
  } else {
    body.append(el("p", { class: "kx-muted", text: t("keys.notSet") }));
  }

  if (!canEdit() && status.source !== "env") {
    body.append(el("p", { class: "kx-muted", text: t("keys.readOnly") }));
  }
  // The form shows its own result; otherwise it goes under the stored key.
  if (slot.result && status.set && slot.mode !== "edit") {
    body.append(resultLine(slot.result));
  }
  if (spec.id === "soniox" && editable) {
    // Hosted: we keep them. Local: the server is your own computer (.env, or orgs.yaml there).
    const enc: MsgKey = org?.mode === "local" ? "keys.encryptedLocal" : "keys.encrypted";
    body.append(el("p", { class: "kx-enc" }, [icon("lock", 16), el("span", { text: t(enc) })]));
  }
  slot.root.replaceChildren(head, body);
}

function resultLine(r: NonNullable<Slot["result"]>): HTMLElement {
  return el("p", { class: `kx-result is-${r.kind}`, text: r.text(), attrs: { role: "status" } });
}

function keyForm(slot: Slot): HTMLFormElement {
  const id = `key-${slot.spec.id}`;
  const input = el("input", {
    class: "ui-input mono",
    attrs: {
      id,
      type: "password",
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      dir: "ltr",
      placeholder: t("keys.placeholder"),
    },
  });
  input.value = slot.draft;
  input.addEventListener("input", () => {
    slot.draft = input.value;
  });
  const save = el("button", {
    class: "ui-btn ui-btn-primary",
    text: t(slot.busy ? "keys.checking" : "keys.save"),
    attrs: { type: "submit" },
  });
  save.disabled = slot.busy;
  const row = el("div", { class: "kx-row" }, [input, save]);
  if (slot.status.set) {
    const cancel = el("button", {
      class: "ui-btn ui-btn-ghost",
      text: t("common.cancel"),
      attrs: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      slot.mode = "view";
      slot.draft = "";
      slot.result = null;
      renderSlot(slot);
    });
    row.append(cancel);
  }
  const form = el("form", { class: "kx-form", attrs: { novalidate: "" } }, [
    el("label", {
      class: "ui-sr-only",
      text: t("keys.inputLabel", { provider: slot.spec.name }),
      attrs: { for: id },
    }),
    row,
  ]);
  if (slot.result) form.append(resultLine(slot.result));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void saveKey(slot, input.value.trim());
  });
  return form;
}

/** The server's own shape rule (16–512 printable characters, no spaces), checked here first. */
function shapeProblem(key: string): MsgKey | null {
  if (key === "") return "keys.pasteFirst";
  if (key.length < 16) return "keys.tooShort";
  if (key.length > 512) return "keys.tooLong";
  if (!/^[\x21-\x7e]+$/.test(key)) return "keys.badChars";
  return null;
}

/** A warning of a stored key in our words: not checked (provider unreachable or an HTTP status),
 *  or the server's .env key wins. Unknown warnings are shown as the server wrote them. */
function warningText(provider: string, warning: string): () => string {
  if (/\.env\b/.test(warning)) {
    // Unnamed (another wording): the provider's own variable, SONIOX_API_KEY.
    const name = /\b[A-Z_]+_API_KEY\b/.exec(warning)?.[0] ?? `${provider.toUpperCase()}_API_KEY`;
    return () => t("keys.envWins", { name });
  }
  if (/could not be reached/i.test(warning)) return () => t("keys.unreachable", { provider });
  const status = httpDetail(warning);
  if (status !== null) return () => t("keys.uncheckedHttp", { provider, status });
  return () => (warning ? t("keys.notChecked", { warning }) : t("keys.storedUnchecked"));
}

/** A failed save: the provider's "no" in our words (with its HTTP status), else errText. */
function saveFailure(provider: string, err: unknown): () => string {
  if (err instanceof ApiError && err.status === 400) {
    // Only the server's words carry the provider's status (our own fallback names the 400).
    const status = err.fromServer ? httpDetail(err.message) : null;
    if (status !== null || !err.fromServer) {
      return () =>
        `${t("keys.rejected", { provider })}${status === null ? "" : ` (HTTP ${status})`}`;
    }
  }
  if (err instanceof ApiError && err.status === 429) return () => retryText(err);
  const message = errText(err);
  return () => message;
}

async function saveKey(slot: Slot, key: string): Promise<void> {
  if (slot.busy) return;
  const problem = shapeProblem(key);
  if (problem !== null) {
    slot.result = { kind: "error", text: () => t(problem) };
    renderSlot(slot);
    slot.root.querySelector<HTMLInputElement>("input")?.focus();
    return;
  }
  slot.busy = true;
  slot.result = null;
  renderSlot(slot);
  try {
    const r = await apiJson<KeyPutResult>(
      "PUT",
      `/api/org/keys/${encodeURIComponent(slot.spec.id)}`,
      { key },
    );
    slot.status = r.status;
    slot.draft = "";
    slot.mode = "view";
    if (r.checked && !r.warning) {
      slot.result = null;
      toast(t("keys.saved"));
    } else {
      slot.result = { kind: "warn", text: warningText(slot.spec.name, r.warning ?? "") };
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      window.location.assign(loginUrl("/app/keys"));
      return;
    }
    slot.result = { kind: "error", text: saveFailure(slot.spec.name, err) };
  } finally {
    slot.busy = false;
    renderSlot(slot);
    renderRest();
  }
}

async function removeKey(slot: Slot): Promise<void> {
  if (slot.busy) return;
  slot.busy = true;
  renderSlot(slot);
  try {
    const r = await apiJson<{ status?: KeyStatus } | null>(
      "DELETE",
      `/api/org/keys/${encodeURIComponent(slot.spec.id)}`,
    );
    slot.status = r?.status ?? {
      provider: slot.spec.id,
      set: false,
      last4: null,
      validatedAt: null,
      source: null,
    };
    slot.mode = "view";
    slot.result = null;
    toast(t("keys.removed"));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      window.location.assign(loginUrl("/app/keys"));
      return;
    }
    slot.mode = "view";
    const message = errText(err);
    slot.result = { kind: "error", text: () => message };
  } finally {
    slot.busy = false;
    renderSlot(slot);
    renderRest();
  }
}

/** Lead, usage and the next step: they follow the Soniox key. */
function renderRest(): void {
  const soniox = slots.get("soniox")?.status;
  const ready = soniox?.set === true;
  lead.textContent = t(ready ? "keys.lead" : "keys.leadNew");
  lead.hidden = org === null;
  if (org && ready) {
    const minutes = Math.round(org.usage.monthMinutes);
    usageMinutes.textContent = tn("n.minutes", minutes);
    usageCost.textContent =
      org.usage.estimateUsd !== null && org.usage.estimateUsd !== undefined
        ? t("keys.usageCost", { usd: fmtUsd(org.usage.estimateUsd) })
        : "";
    usageCost.hidden = usageCost.textContent === "";
    usage.hidden = false;
  } else {
    usage.hidden = true;
  }
  if (org) {
    // Soniox set and no screen yet: the builder. Otherwise the dashboard.
    const first = ready && (screenCount === null || screenCount === 0);
    const text: MsgKey | null = first ? "keys.nextFirstHint" : ready ? null : "keys.nextLater";
    nextText.textContent = text === null ? "" : t(text);
    nextText.hidden = text === null;
    nextLink.textContent = t(first ? "keys.nextFirst" : "keys.nextDashboard");
    nextLink.href = first ? "/app/new" : "/app";
    nextLink.className = `ui-btn ${ready ? "ui-btn-primary" : "ui-btn-secondary"}`;
    nextBox.hidden = false;
  } else {
    nextBox.hidden = true;
  }
}

function renderAll(): void {
  setTitle("keys.docTitle");
  for (const slot of slots.values()) renderSlot(slot);
  renderRest();
  errorText.textContent = failure?.() ?? "";
  errorBox.hidden = failure === null;
}

async function countScreens(): Promise<void> {
  try {
    const r = await apiJson<unknown>("GET", "/api/screens");
    screenCount = Array.isArray(r) ? r.length : null;
  } catch {
    screenCount = null;
  }
}

async function init(): Promise<void> {
  initPage(renderAll);
  setTitle("keys.docTitle");
  const header = mountHeader({ home: "/app", nav: true, active: "keys" });
  void authStateOnce().then((s) => mountFooter({ local: s?.mode !== "hosted" }));
  try {
    // Logged out: straight to the log-in page, without a 401 from /api/auth/me in the console.
    me = (await maybeLoggedIn()) ? await fetchMe() : null;
  } catch (err) {
    loading.hidden = true;
    const message = errText(err);
    failure = () => t("keys.loadFailed", { msg: message });
    renderAll();
    return;
  }
  if (!me) {
    window.location.replace(loginUrl("/app/keys"));
    return;
  }
  header.setAccount(me);
  try {
    [org] = await Promise.all([fetchOrg(), countScreens()]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      window.location.replace(loginUrl("/app/keys"));
      return;
    }
    loading.hidden = true;
    const message = errText(err);
    failure = () => t("keys.loadFailed", { msg: message });
    renderAll();
    return;
  }
  loading.hidden = true;
  if (org === null) {
    failure = () => t("keys.unavailable");
    renderAll();
    return;
  }
  for (const spec of PROVIDERS) {
    const root = el("section", { class: "kx", attrs: { id: `kx-${spec.id}` } });
    providersBox.append(root);
    slots.set(spec.id, {
      spec,
      root,
      status: org.keys[spec.id] ?? {
        provider: spec.id,
        set: false,
        last4: null,
        validatedAt: null,
        source: null,
      },
      mode: "view",
      draft: "",
      busy: false,
      result: null,
    });
  }
  renderAll();
  if (canEdit() && !slots.get("soniox")?.status.set) {
    document.getElementById("key-soniox")?.focus();
  }
}

void init();
