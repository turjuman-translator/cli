// Log-in page (GET /login). On the very first visit of a local install (no accounts yet,
// GET /api/auth/state → setupRequired) it becomes "Create the admin account". Hosted mode logs in by
// e-mail (the username field takes either) and links to sign-up. Success goes to ?next= (same-site
// paths only) or /app, or to /app/keys while a hosted mosque has no Soniox key yet.
import "./login.css";
import {
  ApiError,
  type AppMode,
  apiJson,
  fetchAuthState,
  fetchMe,
  fetchOrg,
  type Me,
  retryText,
  safeNext,
} from "./admin-api.js";
import { type MsgKey, t } from "./shared/app-i18n.js";
import {
  fillNodes,
  initPage,
  isAdminRole,
  mountHeader,
  setTitle,
  siteHome,
} from "./shared/app-shell.js";
import { byId, el } from "./shared/dom.js";

const loading = byId("loading", HTMLParagraphElement);
const loginForm = byId("login-form", HTMLFormElement);
const loginError = byId("login-error", HTMLDivElement);
const loginErrorText = byId("login-error-text", HTMLSpanElement);
const usernameLabel = byId("username-label", HTMLLabelElement);
const username = byId("username", HTMLInputElement);
const password = byId("password", HTMLInputElement);
const loginSubmit = byId("login-submit", HTMLButtonElement);
const signupRow = byId("signup-row", HTMLParagraphElement);
const forgot = byId("forgot", HTMLParagraphElement);

const setupForm = byId("setup-form", HTMLFormElement);
const setupError = byId("setup-error", HTMLDivElement);
const setupErrorText = byId("setup-error-text", HTMLSpanElement);
const setupName = byId("setup-name", HTMLInputElement);
const setupUsername = byId("setup-username", HTMLInputElement);
const setupPassword = byId("setup-password", HTMLInputElement);
const setupPassword2 = byId("setup-password2", HTMLInputElement);
const setupSubmit = byId("setup-submit", HTMLButtonElement);

const rawNext = new URLSearchParams(window.location.search).get("next");
const next = safeNext(rawNext);
const USERNAME = /^[a-zA-Z0-9._-]{2,40}$/;

let mode: AppMode = "local";
let shown: "login" | "setup" | null = null;
/** The error messages on screen, as keys or as text from the server (re-rendered on a switch). */
const errors: Record<"login" | "setup", (() => string) | null> = { login: null, setup: null };

function showError(which: "login" | "setup", message: (() => string) | null): void {
  errors[which] = message;
  const [box, text] =
    which === "login" ? [loginError, loginErrorText] : [setupError, setupErrorText];
  text.textContent = message?.() ?? "";
  box.hidden = message === null;
}

/** A failure as text: our own words for the predictable cases (a wrong password, too many
 *  attempts, a disabled account or mosque, no connection), else the server's message as it is. */
function friendly(err: unknown, wrong: MsgKey): () => string {
  if (!(err instanceof ApiError)) return () => t("err.generic");
  if (err.status === 0) return () => t("err.network");
  if (err.status === 401) return () => t(wrong);
  if (err.status === 429) return () => retryText(err);
  if (err.status === 403 && err.fromServer && /disabled/i.test(err.message)) {
    const org = /organi[sz]ation/i.test(err.message);
    return () => t(org ? "login.orgDisabled" : "login.disabled");
  }
  const message = err.message;
  return () => message;
}

function busy(btn: HTMLButtonElement, label: MsgKey | null, idle: MsgKey): void {
  btn.disabled = label !== null;
  btn.dataset.i18n = label ?? idle;
  btn.textContent = t(label ?? idle);
}

function labels(): void {
  const hosted = mode === "hosted";
  usernameLabel.dataset.i18n = hosted ? "login.emailOrUsername" : "login.username";
  usernameLabel.textContent = t(hosted ? "login.emailOrUsername" : "login.username");
  // Hosted: a mosque's admin resets its accounts; the server's operator resets an owner. Local:
  // another admin, or the only admin on the server itself.
  if (hosted) {
    forgot.textContent = t("login.forgotHosted");
  } else {
    const name = t("login.nameArg");
    forgot.replaceChildren(
      ...fillNodes(t("login.forgot"), {
        cmd: el("code", { class: "ltr", text: `turjuman users passwd ${name}` }),
        docker: el("code", { class: "ltr", text: `make user-passwd USERNAME=${name}` }),
      }),
    );
  }
  username.autocomplete = "username";
  if (shown) setTitle(shown === "setup" ? "setup.docTitle" : "login.docTitle");
  for (const which of ["login", "setup"] as const) {
    const m = errors[which];
    if (m) showError(which, m);
  }
}

function show(form: "login" | "setup"): void {
  shown = form;
  loading.hidden = true;
  loginForm.hidden = form !== "login";
  setupForm.hidden = form !== "setup";
  labels();
  (form === "login" ? username : setupName).focus();
}

/** Where to go after logging in: ?next=, else the dashboard, or the keys while a hosted
 *  mosque has no Soniox key (owners and admins only: they are the ones who can add it). */
async function destination(me: Me | null): Promise<string> {
  if (rawNext !== null && next !== "/app") return next;
  if (mode === "hosted" && isAdminRole(me)) {
    const org = await fetchOrg().catch(() => null);
    if (org && !org.keys.soniox.set) return "/app/keys";
  }
  return next;
}

async function login(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const u = username.value.trim();
  if (u === "" || password.value === "") {
    showError("login", () => t(mode === "hosted" ? "login.missingHosted" : "login.missing"));
    (u === "" ? username : password).focus();
    return;
  }
  showError("login", null);
  busy(loginSubmit, "login.busy", "login.submit");
  try {
    const r = await apiJson<{ me?: Me } | null>("POST", "/api/auth/login", {
      username: u,
      password: password.value,
    });
    window.location.assign(await destination(r?.me ?? null));
  } catch (err) {
    busy(loginSubmit, null, "login.submit");
    showError("login", friendly(err, mode === "hosted" ? "login.wrongHosted" : "login.wrong"));
    password.select();
    password.focus();
  }
}

async function setup(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const u = setupUsername.value.trim();
  let problem: MsgKey | null = null;
  let field: HTMLInputElement | null = null;
  if (!USERNAME.test(u)) {
    problem = "setup.badUsername";
    field = setupUsername;
  } else if (setupPassword.value.length < 8) {
    problem = "setup.shortPassword";
    field = setupPassword;
  } else if (setupPassword.value !== setupPassword2.value) {
    problem = "setup.mismatch";
    field = setupPassword2;
  }
  if (problem !== null) {
    const key = problem;
    showError("setup", () => t(key));
    field?.focus();
    return;
  }
  showError("setup", null);
  busy(setupSubmit, "setup.busy", "setup.submit");
  try {
    const displayName = setupName.value.trim();
    const r = await apiJson<{ me?: Me } | null>("POST", "/api/auth/setup", {
      username: u,
      password: setupPassword.value,
      ...(displayName ? { displayName } : {}),
    });
    window.location.assign(await destination(r?.me ?? null));
  } catch (err) {
    busy(setupSubmit, null, "setup.submit");
    if (err instanceof ApiError && err.status === 409) {
      // Someone created the first account meanwhile: log in instead.
      show("login");
      showError("login", () => t("setup.exists"));
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      const url = `http://127.0.0.1:${window.location.port || "8765"}/login`;
      showError("setup", () => t("setup.remote", { url }));
      return;
    }
    showError("setup", friendly(err, "setup.failed"));
  }
}

function bindPasswordToggles(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".pw-toggle")) {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.for ?? "");
      if (!(input instanceof HTMLInputElement)) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      btn.setAttribute("aria-pressed", visible ? "true" : "false");
      btn.dataset.i18nAria = visible ? "common.hidePassword" : "common.showPassword";
      btn.setAttribute("aria-label", t(visible ? "common.hidePassword" : "common.showPassword"));
    });
  }
}

async function init(): Promise<void> {
  initPage(labels);
  // The wordmark goes to the website in this page's language (hosted), else to / as before.
  const header = mountHeader({ home: () => siteHome(mode), nav: false });
  bindPasswordToggles();
  loginForm.addEventListener("submit", (ev) => void login(ev));
  setupForm.addEventListener("submit", (ev) => void setup(ev));
  let setupRequired = false;
  let loggedIn = true;
  try {
    const state = await fetchAuthState();
    setupRequired = state.setupRequired;
    loggedIn = state.loggedIn;
    mode = state.mode;
    header.relabel();
    signupRow.hidden = !(state.mode === "hosted" && state.signup);
  } catch (err) {
    show("login");
    showError("login", friendly(err, "login.again"));
    return;
  }
  if (setupRequired && mode === "local") {
    show("setup");
    return;
  }
  // Already logged in (e.g. the back button): go straight on. A logged-out request doesn't ask
  // (no 401 in the console).
  const me = loggedIn ? await fetchMe().catch(() => null) : null;
  if (me) {
    window.location.replace(await destination(me));
    return;
  }
  show("login");
}

void init();
