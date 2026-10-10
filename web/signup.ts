// Sign-up (GET /signup, hosted mode): mosque name, your name, e-mail and a password of at least
// 10 characters. `website` is a honeypot: hidden from people and from assistive technology, and
// always sent empty by a person. 201 logs in by cookie → /app/keys.
import "./signup.css";
import type { SignupBody } from "../src/shared/protocol.js";
import { ApiError, type AppMode, apiJson, fetchAuthState, fetchMe, waitText } from "./admin-api.js";
import { type MsgKey, t } from "./shared/app-i18n.js";
import { initPage, mountHeader, setTitle, siteHome } from "./shared/app-shell.js";
import { byId } from "./shared/dom.js";

const MIN_PASSWORD = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const form = byId("signup-form", HTMLFormElement);
const closed = byId("signup-closed", HTMLElement);
const closedHint = byId("closed-hint", HTMLParagraphElement);
const errorBox = byId("signup-error", HTMLDivElement);
const errorText = byId("signup-error-text", HTMLSpanElement);
const orgName = byId("org-name", HTMLInputElement);
const yourName = byId("your-name", HTMLInputElement);
const email = byId("email", HTMLInputElement);
const password = byId("new-password", HTMLInputElement);
const rule = byId("password-rule", HTMLParagraphElement);
const website = byId("website", HTMLInputElement);
const submit = byId("signup-submit", HTMLButtonElement);

/** The message on screen (a function, so a language switch re-renders it). */
let error: (() => string) | null = null;

function showError(message: (() => string) | null): void {
  error = message;
  errorText.textContent = message?.() ?? "";
  errorBox.hidden = message === null;
}

function syncRule(): void {
  rule.classList.toggle("is-met", password.value.length >= MIN_PASSWORD);
}

function busy(on: boolean): void {
  submit.disabled = on;
  const key: MsgKey = on ? "signup.busy" : "signup.submit";
  submit.dataset.i18n = key;
  submit.textContent = t(key);
}

function problem(): [MsgKey, HTMLInputElement] | null {
  if (orgName.value.trim() === "") return ["signup.errOrg", orgName];
  if (yourName.value.trim() === "") return ["signup.errName", yourName];
  if (!EMAIL.test(email.value.trim())) return ["signup.errEmail", email];
  if (password.value.length < MIN_PASSWORD) return ["signup.errPassword", password];
  return null;
}

/** Our own words for the predictable answers; the server's message for anything else. */
function failure(err: unknown): () => string {
  if (!(err instanceof ApiError)) return () => t("err.generic");
  if (err.status === 0) return () => t("err.network");
  if (err.status === 409) return () => t("signup.errExists");
  if (err.status === 429) {
    const after = err.retryAfter;
    return after !== null
      ? () => t("signup.errTooManyIn", { time: waitText(after) })
      : () => t("signup.errTooMany");
  }
  if (err.status === 404) return () => t("signup.unavailable");
  if (err.status === 403) return () => t("signup.closed");
  const message = err.message;
  return () => message;
}

async function send(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const p = problem();
  if (p !== null) {
    const [key, field] = p;
    showError(() => t(key));
    field.focus();
    return;
  }
  showError(null);
  busy(true);
  const body: SignupBody = {
    orgName: orgName.value.trim(),
    name: yourName.value.trim(),
    email: email.value.trim(),
    password: password.value,
    website: website.value,
  };
  try {
    await apiJson<unknown>("POST", "/api/auth/signup", body);
    window.location.assign("/app/keys");
  } catch (err) {
    busy(false);
    showError(failure(err));
    if (err instanceof ApiError && err.status === 409) email.focus();
  }
}

function bindPasswordToggle(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".pw-toggle")) {
    btn.addEventListener("click", () => {
      const visible = password.type === "password";
      password.type = visible ? "text" : "password";
      btn.setAttribute("aria-pressed", visible ? "true" : "false");
      btn.dataset.i18nAria = visible ? "common.hidePassword" : "common.showPassword";
      btn.setAttribute("aria-label", t(visible ? "common.hidePassword" : "common.showPassword"));
    });
  }
}

function showClosed(): void {
  form.hidden = true;
  closed.hidden = false;
  closedHint.hidden = false;
  closedHint.dataset.i18n = "signup.closedHint";
  closedHint.textContent = t("signup.closedHint");
}

async function init(): Promise<void> {
  initPage(() => {
    setTitle("signup.docTitle");
    if (error) showError(error);
  });
  setTitle("signup.docTitle");
  // The wordmark goes to the website in this page's language (hosted; a local install's / else).
  let mode: AppMode | null = null;
  const header = mountHeader({ home: () => siteHome(mode), nav: false });
  bindPasswordToggle();
  password.addEventListener("input", syncRule);
  syncRule();
  form.addEventListener("submit", (ev) => void send(ev));
  const state = await fetchAuthState().catch(() => null);
  mode = state?.mode ?? null;
  header.relabel();
  if (state !== null && state.mode === "hosted" && !state.signup) {
    showClosed();
    return;
  }
  // Logged in already (the back button after signing up): straight on. A logged-out request
  // doesn't ask (no 401 in the console).
  const me = state?.loggedIn !== false ? await fetchMe().catch(() => null) : null;
  if (me) {
    window.location.replace("/app");
    return;
  }
  orgName.focus();
}

void init();
