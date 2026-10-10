// Small UI kit for the app: sheets (native <dialog>: a bottom sheet on phones, a centred
// card on desktop), confirm / prompt / action sheets, the toast and inline SVG icons.
import { fmtWhen as fmtWhenIn, t } from "./shared/app-i18n.js";
import { el } from "./shared/dom.js";

const SVG = "http://www.w3.org/2000/svg";

/** Stroke icons (24×24). */
export const ICONS = {
  check: "M5 12.5l4.2 4.2L19 7",
  close: "M6 6l12 12M18 6L6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  reset: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4",
  copy: "M9 9h11v11H9zM5 15V6.5A2.5 2.5 0 0 1 7.5 4H15",
  open: "M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  palette:
    "M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-1.3-1-1.7-1-2.7 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3zM7.5 12h.01M9.5 8h.01M14.5 8h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  key: "M8 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM11.5 12H21M18.5 12v3M15.5 12v2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  logout: "M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h10",
  plus: "M12 5v14M5 12h14",
  shield: "M12 3l7.5 3v6c0 4.5-3.2 8-7.5 9-4.3-1-7.5-4.5-7.5-9V6z",
  ban: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8",
  refresh: "M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  dice: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01",
  screen:
    "M4.5 4.5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15V6a1.5 1.5 0 0 1 1.5-1.5zM8.5 20.5h7M12 16.5v4",
  users:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M17.5 14.2A6.5 6.5 0 0 1 21.5 20",
  sliders: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 22): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", ICONS[name]);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", name === "more" ? "3.2" : "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

export function button(
  label: string,
  opts: {
    kind?: "primary" | "secondary" | "soft" | "ghost" | "danger";
    icon?: IconName;
    type?: "button" | "submit";
    title?: string;
  } = {},
): HTMLButtonElement {
  const b = el("button", {
    class: `ui-btn ui-btn-${opts.kind ?? "secondary"}`,
    attrs: { type: opts.type ?? "button" },
  });
  if (opts.icon) b.append(icon(opts.icon));
  b.append(el("span", { text: label }));
  if (opts.title) b.title = opts.title;
  return b;
}

// --- toast ---------------------------------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(text: string, kind: "ok" | "error" = "ok"): void {
  let node = document.getElementById("toast");
  if (!node) {
    node = el("div", { class: "ui-toast", attrs: { id: "toast", role: "status" } });
    document.body.append(node);
  }
  const box = node;
  box.classList.toggle("is-error", kind === "error");
  box.replaceChildren(icon(kind === "error" ? "close" : "check"), el("span", { text }));
  box.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      box.hidden = true;
    },
    kind === "error" ? 5000 : 2600,
  );
}

// --- sheets --------------------------------------------------------------------------------------

export interface Sheet {
  dialog: HTMLDialogElement;
  body: HTMLDivElement;
  close(): void;
}

/** Open a modal sheet; it removes itself when closed (Esc, ✕, backdrop or close()). */
export function openSheet(title: string, content: Node[], onClose?: () => void): Sheet {
  const titleId = `sheet-title-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = el("button", {
    class: "ui-sheet-close",
    attrs: { type: "button", "aria-label": t("common.close") },
  });
  closeBtn.append(icon("close"));
  const body = el("div", { class: "ui-sheet-body" }, content);
  const dialog = el("dialog", { class: "ui-sheet", attrs: { "aria-labelledby": titleId } }, [
    el("div", { class: "ui-sheet-head" }, [
      el("h2", { class: "ui-sheet-title", text: title, attrs: { id: titleId } }),
      closeBtn,
    ]),
    body,
  ]);
  const close = (): void => {
    if (dialog.open) dialog.close();
  };
  closeBtn.addEventListener("click", close);
  // A click on the backdrop lands on the <dialog> itself.
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close };
}

/** Yes/no question; resolves true on confirm. */
export function confirmSheet(opts: {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const ok = button(opts.confirm, { kind: opts.danger ? "danger" : "primary" });
    const cancel = button(t("common.cancel"));
    const sheet = openSheet(
      opts.title,
      [
        el("p", { class: "ui-sheet-text", text: opts.message }),
        el("div", { class: "ui-sheet-actions-row" }, [cancel, ok]),
      ],
      () => resolve(answer),
    );
    ok.addEventListener("click", () => {
      answer = true;
      sheet.close();
    });
    cancel.addEventListener("click", () => sheet.close());
    ok.focus();
  });
}

/** One text field; resolves the trimmed value, or null when cancelled. */
export function promptSheet(opts: {
  title: string;
  label: string;
  value: string;
  confirm: string;
  hint?: string;
  maxLength?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const id = `prompt-${Math.random().toString(36).slice(2, 8)}`;
    const input = el("input", {
      class: "ui-input",
      attrs: { id, type: "text", maxlength: String(opts.maxLength ?? 80), autocomplete: "off" },
    });
    input.value = opts.value;
    const error = el("p", { class: "ui-field-error", attrs: { role: "alert" } });
    error.hidden = true;
    const ok = button(opts.confirm, { kind: "primary", type: "submit" });
    const cancel = button(t("common.cancel"));
    const form = el("form", { class: "ui-sheet-form", attrs: { novalidate: "" } }, [
      el("div", {}, [
        el("label", { class: "ui-label", text: opts.label, attrs: { for: id } }),
        input,
        ...(opts.hint ? [el("p", { class: "ui-hint", text: opts.hint })] : []),
        error,
      ]),
      el("div", { class: "ui-sheet-actions-row" }, [cancel, ok]),
    ]);
    const sheet = openSheet(opts.title, [form], () => resolve(answer));
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const v = input.value.trim();
      if (v === "") {
        error.textContent = t("common.empty");
        error.hidden = false;
        input.focus();
        return;
      }
      answer = v;
      sheet.close();
    });
    cancel.addEventListener("click", () => sheet.close());
    input.focus();
    input.select();
  });
}

export interface SheetAction {
  label: string;
  icon: IconName;
  danger?: boolean;
  hint?: string;
  run: () => void;
}

/** A list of big buttons (the ⋯ menu). */
export function actionSheet(title: string, actions: SheetAction[], extra: Node[] = []): Sheet {
  const list = el("div", { class: "ui-sheet-actions" });
  const sheet = openSheet(title, [list, ...extra]);
  for (const a of actions) {
    const b = el("button", {
      class: `ui-sheet-action${a.danger ? " is-danger" : ""}`,
      attrs: { type: "button" },
    });
    b.append(icon(a.icon));
    const text = el("span", { class: "ui-sheet-action-text" }, [
      el("span", { class: "ui-sheet-action-label", text: a.label }),
    ]);
    if (a.hint) text.append(el("span", { class: "ui-sheet-action-hint", text: a.hint }));
    b.append(text);
    b.addEventListener("click", () => {
      sheet.close();
      a.run();
    });
    list.append(b);
  }
  return sheet;
}

/** A readable random password (no look-alike characters). */
export function generatePassword(length = 14): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += chars.charAt(b % chars.length);
  // Groups of 4–5 are easier to read aloud or type from a phone.
  return out.replace(/(.{5})(?=.)/g, "$1-");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  const area = el("textarea", { class: "ui-sr-only" });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** "18:42" today, else "2 Oct, 18:42" (in the app language). */
export function fmtWhen(ms: number): string {
  return fmtWhenIn(ms);
}
