// Control dock (/control): start/stop the local session, watch levels/latency and the engine,
// stop runaway page sessions, and force prayer events (Athan / Iqama / Salah / Normal) per
// session or for all sessions.
// Actions go through the HTTP API; live state comes from /ws with a `level` subscription.
import type {
  LatencyStats,
  ServerMessage,
  SessionMode,
  Status,
  TrackStatus,
} from "../src/shared/protocol.js";
import "./control.css";
import { byId, el, fmtDuration, fmtMs, storageGet, storageSet, wsUrl } from "./shared/dom.js";
import { parseMessage, ReconnectingSocket } from "./shared/ws-client.js";

const STORE = "captions.control.";
const CONFIRM_MS = 4000;
const PEAK_HOLD_MS = 1500;
const PEAK_DECAY_DB_PER_S = 24;
const METER_FLOOR_DB = -60;
const SESSIONS_POLL_MS = 2000;

const token = new URLSearchParams(window.location.search).get("token");

const stateBadge = byId("state", HTMLSpanElement);
const modeBadge = byId("mode", HTMLSpanElement);
const timerEl = byId("timer", HTMLSpanElement);
const connEl = byId("conn", HTMLSpanElement);
const fileBanner = byId("file-banner", HTMLDivElement);
const fileName = byId("file-name", HTMLSpanElement);
const sourceSel = byId("source", HTMLSelectElement);
const fileRow = byId("file-row", HTMLLabelElement);
const fileInput = byId("file", HTMLInputElement);
const startBtn = byId("start", HTMLButtonElement);
const stopBtn = byId("stop", HTMLButtonElement);
const meterCover = byId("meter-cover", HTMLDivElement);
const meterPeak = byId("meter-peak", HTMLDivElement);
const audioStateEl = byId("audio-state", HTMLSpanElement);
const levelText = byId("level-text", HTMLSpanElement);
const noSignal = byId("no-signal", HTMLParagraphElement);
const waitingBridge = byId("waiting-bridge", HTMLParagraphElement);
const tracksList = byId("tracks", HTMLUListElement);
const clearBtn = byId("clear", HTMLButtonElement);
const errorLine = byId("error-line", HTMLParagraphElement);
const toastEl = byId("toast", HTMLParagraphElement);
const sessionsList = byId("sessions", HTMLUListElement);
const sessionsNote = byId("sessions-note", HTMLParagraphElement);
const sessionsCount = byId("sessions-count", HTMLSpanElement);
const allRow = byId("all-row", HTMLDivElement);
const allEvents = byId("all-events", HTMLDivElement);

let status: Status | null = null;
/** Server clock − local clock (from hello.serverTime). */
let skewMs = 0;
let connected = false;
const busy = new Set<HTMLButtonElement>();

// --- small helpers -----------------------------------------------------------------------------

function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string, ok: boolean): void {
  toastEl.textContent = message;
  toastEl.classList.toggle("toast-error", !ok);
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.textContent = "";
  }, 6000);
}

function httpProblem(code: number): string {
  if (code === 401 || code === 403) return `HTTP ${code}: open this page with ?token=<admin token>`;
  return `HTTP ${code}`;
}

/** POST JSON to the API; shows the response's `message` (or the HTTP error) as a toast. */
async function post(
  path: string,
  body: object,
  button: HTMLButtonElement | null,
): Promise<boolean> {
  if (button) {
    busy.add(button);
    renderButtons();
  }
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    let ok = res.ok;
    let message: string | null = null;
    try {
      const data: unknown = await res.json();
      if (isObj(data)) {
        message = str(data.message) ?? str(data.error);
        if (data.ok === false) ok = false;
      }
    } catch {
      // empty or non-JSON body
    }
    toast(message ?? (ok ? "Done." : res.ok ? "That didn't work." : httpProblem(res.status)), ok);
    return ok;
  } catch {
    toast("Server unreachable.", false);
    return false;
  } finally {
    if (button) {
      busy.delete(button);
      renderButtons();
    }
  }
}

/** In-page two-step confirm, never window.confirm: that one blocks the page and can't be
 *  automated. */
function twoStep(button: HTMLButtonElement, armedLabel: string, action: () => void): void {
  const idleLabel = button.textContent ?? "";
  let armedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    armedUntil = 0;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    button.textContent = idleLabel;
    button.classList.remove("armed");
  };
  button.addEventListener("click", () => {
    if (Date.now() < armedUntil) {
      disarm();
      action();
      return;
    }
    armedUntil = Date.now() + CONFIRM_MS;
    button.textContent = armedLabel;
    button.classList.add("armed");
    timer = setTimeout(disarm, CONFIRM_MS);
  });
}

// --- prayer events (manual override) ----------------------------------------------------------

type EventChoice = "athan" | "iqama" | "salah" | "none";

const EVENT_BUTTONS: ReadonlyArray<readonly [EventChoice, string]> = [
  ["athan", "Athan"],
  ["iqama", "Iqama"],
  ["salah", "Salah"],
  ["none", "Normal"],
];

const SESSION_MODES: readonly string[] = ["speech", "held", "athan", "iqama", "salah"];

const MODE_LABEL: Record<SessionMode, string> = {
  speech: "normal",
  held: "held",
  athan: "athan",
  iqama: "iqama",
  salah: "salah",
};

function asMode(v: unknown): SessionMode | null {
  return typeof v === "string" && SESSION_MODES.includes(v) ? (v as SessionMode) : null;
}

/** The prayer-event mode carried by a status/session object, whatever the field is called. */
function modeOf(obj: Record<string, unknown>): SessionMode | null {
  for (const k of ["eventMode", "sessionMode", "prayerMode", "mode"]) {
    const m = asMode(obj[k]);
    if (m) return m;
  }
  return null;
}

function layoutOf(obj: Record<string, unknown>): string | null {
  const v = obj.layout;
  return v === "blocks" || v === "rollup" ? v : null;
}

/** Fill a mode badge (hidden when the server doesn't report a mode). */
function renderModeBadge(
  badge: HTMLSpanElement,
  mode: SessionMode | null,
  layout: string | null,
): void {
  show(badge, mode !== null);
  if (mode === null) return;
  badge.textContent = MODE_LABEL[mode];
  badge.dataset.mode = mode;
  badge.title = `Caption mode: ${MODE_LABEL[mode]}${layout ? ` · layout: ${layout}` : ""}`;
}

interface EventGroup {
  buttons: Map<EventChoice, HTMLButtonElement>;
}

function makeEventGroup(container: HTMLElement, target: () => string, scope: string): EventGroup {
  const group: EventGroup = { buttons: new Map() };
  for (const [ev, text] of EVENT_BUTTONS) {
    const b = el("button", {
      class: "btn btn-ev",
      text,
      attrs: {
        type: "button",
        "data-event": ev,
        "aria-pressed": "false",
        title:
          ev === "none" ? `Back to normal captions (${scope})` : `Show the ${text} card (${scope})`,
      },
    });
    b.addEventListener("click", () => void sendEvent(group, target(), ev));
    group.buttons.set(ev, b);
  }
  container.replaceChildren(...group.buttons.values());
  return group;
}

/** POST /api/sessions/:id/event {event}; `id` may be "all". The group is disabled meanwhile
 *  (a disabled button gets no clicks, so one request at a time). */
async function sendEvent(group: EventGroup, target: string, ev: EventChoice): Promise<void> {
  for (const b of group.buttons.values()) b.disabled = true;
  try {
    await post(`/api/sessions/${encodeURIComponent(target)}/event`, { event: ev }, null);
  } finally {
    for (const b of group.buttons.values()) b.disabled = false;
    void pollSessions(false);
  }
}

/** Highlight the button matching the session's current mode. */
function markEvent(group: EventGroup, mode: SessionMode | null): void {
  const active: EventChoice | null =
    mode === "athan" || mode === "iqama" || mode === "salah"
      ? mode
      : mode === "speech"
        ? "none"
        : null;
  for (const [ev, b] of group.buttons) {
    const on = ev === active;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

// --- session controls ----------------------------------------------------------------------

const ACTIVE_STATES = new Set(["starting", "live", "reconnecting", "stopping"]);

function renderButtons(): void {
  const state = status?.state ?? null;
  startBtn.disabled = busy.has(startBtn) || (state !== null && ACTIVE_STATES.has(state));
  stopBtn.disabled = busy.has(stopBtn) || state === "idle";
  clearBtn.disabled = busy.has(clearBtn);
}

function syncSourceRow(): void {
  show(fileRow, sourceSel.value === "file");
}

function startSession(): void {
  const source = sourceSel.value === "file" ? "file" : "device";
  const file = fileInput.value.trim();
  if (source === "file" && file === "") {
    toast("Enter the path of the file to replay.", false);
    fileInput.focus();
    return;
  }
  storageSet(`${STORE}source`, source);
  storageSet(`${STORE}file`, file || null);
  void post("/api/session/start", source === "file" ? { source, file } : { source }, startBtn);
}

// --- status rendering ----------------------------------------------------------------------

function latencyLine(t: TrackStatus): string {
  const pick = (label: string, l: LatencyStats | undefined | null): string | null =>
    l && l.n > 0 ? `${label} p50 ${fmtMs(l.p50Ms)} · p95 ${fmtMs(l.p95Ms)} (n=${l.n})` : null;
  return (
    pick("VAD→tr", t.vadLatency?.translation) ??
    pick("tr", t.latency?.translation) ??
    pick("src", t.latency?.source) ??
    "latency –"
  );
}

function renderTracks(s: Status | null): void {
  const tracks = s && Array.isArray(s.tracks) ? s.tracks : [];
  tracksList.replaceChildren(
    ...tracks.map((t) => {
      const head = el("div", { class: "track-head" }, [
        el("span", { class: "dot", attrs: { "data-state": t.provider } }),
        el("strong", { text: t.track }),
        el("span", { class: "muted", text: t.active ? " active" : " standby" }),
        el("span", { class: "muted", text: ` · ${t.provider}` }),
      ]);
      const extra: string[] = [latencyLine(t)];
      if (typeof t.costUsd === "number") extra.push(`$${t.costUsd.toFixed(3)}`);
      if (typeof t.segments === "number") extra.push(`${t.segments} seg`);
      const children: Node[] = [head, el("div", { class: "small muted", text: extra.join(" · ") })];
      if (t.lastError) children.push(el("div", { class: "small error-text", text: t.lastError }));
      return el("li", { class: "track" }, children);
    }),
  );
}

function renderStatus(): void {
  const s = status;
  const state = s?.state ?? "unknown";
  stateBadge.textContent = state;
  stateBadge.dataset.state = state;
  const raw = s ? (s as unknown as Record<string, unknown>) : null;
  renderModeBadge(modeBadge, raw ? modeOf(raw) : null, raw ? layoutOf(raw) : null);

  const fileSession =
    s !== null &&
    s.session !== undefined &&
    (s.session.source === "file" || s.session.kind === "file") &&
    state !== "idle";
  show(fileBanner, fileSession);
  if (fileSession) {
    const f = s?.session?.file ?? "";
    fileName.textContent = f ? (f.split(/[\\/]/).pop() ?? f) : "";
    fileName.title = f;
  }

  const audio = s?.audio;
  if (audio) {
    const ago = audio.lastFrameAgoMs;
    const agoText = ago !== null && ago > 1500 ? ` · last frame ${fmtMs(ago)} ago` : "";
    audioStateEl.textContent = `input: ${audio.state}${agoText}`;
    show(noSignal, audio.noSignal === true);
    show(waitingBridge, audio.state === "waiting-for-bridge");
  } else {
    audioStateEl.textContent = "input: –";
    show(noSignal, false);
    show(waitingBridge, false);
  }

  let err = s?.error ?? null;
  if (!err && audio?.lastStderr && ["error", "restarting", "stalled"].includes(audio.state)) {
    const line = audio.lastStderr.trim();
    err = `ffmpeg: ${line.length > 180 ? `${line.slice(0, 180)}…` : line}`;
  }
  errorLine.textContent = err ?? "";
  show(errorLine, err !== null && err !== "");

  renderTracks(s);
  renderButtons();
  renderTimer();
}

function renderTimer(): void {
  const s = status;
  const started = s?.session?.startedAt;
  if (!s || typeof started !== "number" || !ACTIVE_STATES.has(s.state)) {
    timerEl.textContent = "–";
    return;
  }
  timerEl.textContent = fmtDuration(Date.now() + skewMs - started);
}

function renderConn(state: "connecting" | "open" | "closed"): void {
  connected = state === "open";
  connEl.dataset.conn = state;
  connEl.textContent =
    state === "open" ? "connected" : state === "connecting" ? "connecting…" : "disconnected";
  show(connEl, state !== "open");
  document.body.classList.toggle("offline", state === "closed");
}

// --- level meter ---------------------------------------------------------------------------

let rmsDb = -100;
let peakDb = -100;
// No level yet: never "fresh" (performance.now() is small right after the page loads).
let lastLevelAt = Number.NEGATIVE_INFINITY;
let holdDb = -100;
let holdAt = 0;
let lastFrameAt = 0;
let shownCover = "";
let shownPeak = "";
let shownText = "";

function onLevel(rms: number, peak: number): void {
  const now = performance.now();
  rmsDb = rms;
  peakDb = peak;
  lastLevelAt = now;
  if (peak >= holdDb) {
    holdDb = peak;
    holdAt = now;
  }
}

function pct(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) * 100;
}

function meterFrame(now: number): void {
  const dt = lastFrameAt === 0 ? 0 : (now - lastFrameAt) / 1000;
  lastFrameAt = now;
  const fresh = now - lastLevelAt < 1500;
  const rms = fresh ? rmsDb : (status?.audio.rmsDbfs ?? -100);
  const peak = fresh ? peakDb : -100;
  if (now - holdAt > PEAK_HOLD_MS) holdDb = Math.max(peak, holdDb - PEAK_DECAY_DB_PER_S * dt);

  const cover = `${(100 - pct(rms)).toFixed(1)}%`;
  if (cover !== shownCover) {
    meterCover.style.setProperty("width", cover);
    shownCover = cover;
  }
  const peakPos = `${pct(holdDb).toFixed(1)}%`;
  if (peakPos !== shownPeak) {
    meterPeak.style.setProperty("left", peakPos);
    meterPeak.classList.toggle("hidden-peak", holdDb <= METER_FLOOR_DB);
    meterPeak.classList.toggle("clip", holdDb > -1);
    shownPeak = peakPos;
  }
  const text = fresh
    ? `RMS ${Math.round(rms)} dB · peak ${Math.round(peak)} dB`
    : connected
      ? "no level data"
      : "";
  if (text !== shownText) {
    levelText.textContent = text;
    shownText = text;
  }
  requestAnimationFrame(meterFrame);
}

// --- sessions list -------------------------------------------------------------------------

interface SessionRow {
  id: string;
  kind: string;
  from: string;
  to: string;
  engines: string[];
  keyLabel: string | null;
  durationMs: number | null;
  streamedMinutes: number | null;
  latency: LatencyStats | null;
  state: string;
  /** Not part of the SessionSummary type: read defensively. */
  mode: SessionMode | null;
  layout: string | null;
}

interface RowView {
  li: HTMLLIElement;
  kind: HTMLSpanElement;
  title: HTMLSpanElement;
  mode: HTMLSpanElement;
  meta: HTMLDivElement;
  stop: HTMLButtonElement;
  events: EventGroup;
}

const rows = new Map<string, RowView>();

function parseSessions(data: unknown): SessionRow[] | null {
  const arr = Array.isArray(data)
    ? (data as unknown[])
    : isObj(data) && Array.isArray(data.sessions)
      ? (data.sessions as unknown[])
      : null;
  if (!arr) return null;
  const out: SessionRow[] = [];
  for (const item of arr) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    const lat = isObj(item.latency) ? item.latency : null;
    out.push({
      id,
      kind: str(item.kind) ?? "?",
      from: str(item.from) ?? "?",
      to: str(item.to) ?? "?",
      engines: Array.isArray(item.engines)
        ? (item.engines as unknown[]).filter((e): e is string => typeof e === "string")
        : [],
      keyLabel: str(item.keyLabel),
      durationMs: num(item.durationMs),
      streamedMinutes: num(item.streamedMinutes),
      latency: lat ? { p50Ms: num(lat.p50Ms), p95Ms: num(lat.p95Ms), n: num(lat.n) ?? 0 } : null,
      state: str(item.state) ?? "?",
      mode: modeOf(item),
      layout: layoutOf(item),
    });
  }
  return out;
}

function makeRow(id: string): RowView {
  const kind = el("span", { class: "kind" });
  const title = el("span", { class: "row-title" });
  const meta = el("div", { class: "small muted" });
  const mode = el("span", { class: "mode-badge" });
  mode.hidden = true;
  const evWrap = el("div", {
    class: "ev-buttons",
    attrs: { role: "group", "aria-label": "Prayer event for this session" },
  });
  const events = makeEventGroup(evWrap, () => id, "this session");
  const stop = el("button", {
    class: "btn btn-small btn-stop",
    text: "Stop",
    attrs: { type: "button" },
  });
  twoStep(stop, "Confirm", () => {
    void post(`/api/sessions/${encodeURIComponent(id)}/stop`, {}, stop).then(() => {
      void pollSessions(false);
    });
  });
  const li = el("li", { class: "session" }, [
    el("div", { class: "row-head" }, [kind, title, mode, stop]),
    meta,
    evWrap,
  ]);
  return { li, kind, title, mode, meta, stop, events };
}

function renderSessions(list: SessionRow[]): void {
  const seen = new Set<string>();
  for (const s of list) {
    seen.add(s.id);
    let row = rows.get(s.id);
    if (!row) {
      row = makeRow(s.id);
      rows.set(s.id, row);
    }
    row.kind.textContent = s.kind;
    row.kind.dataset.kind = s.kind;
    row.title.textContent = `${s.from} → ${s.to}${s.engines.length ? ` · ${s.engines.join("+")}` : ""}`;
    row.title.title = s.id;
    const meta: string[] = [];
    if (s.keyLabel) meta.push(s.keyLabel);
    if (s.durationMs !== null) meta.push(fmtDuration(s.durationMs));
    if (s.streamedMinutes !== null) meta.push(`${s.streamedMinutes.toFixed(1)} min`);
    if (s.latency && s.latency.n > 0) {
      meta.push(`p50 ${fmtMs(s.latency.p50Ms)} · p95 ${fmtMs(s.latency.p95Ms)}`);
    }
    if (s.layout) meta.push(s.layout);
    meta.push(s.state);
    row.meta.textContent = meta.join(" · ");
    renderModeBadge(row.mode, s.mode, s.layout);
    markEvent(row.events, s.mode);
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.li.remove();
      rows.delete(id);
    }
  }
  // Keep DOM order equal to the server's order without re-creating rows (clicks stay intact).
  list.forEach((s, i) => {
    const row = rows.get(s.id);
    if (row && sessionsList.children[i] !== row.li) {
      sessionsList.insertBefore(row.li, sessionsList.children[i] ?? null);
    }
  });
  sessionsCount.textContent = list.length > 0 ? `(${list.length})` : "";
  show(allRow, list.length > 0);
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

async function pollSessions(reschedule = true): Promise<void> {
  if (reschedule && pollTimer !== null) clearTimeout(pollTimer);
  let note: string | null = null;
  try {
    const res = await fetch("/api/sessions", {
      headers: { Accept: "application/json", ...authHeaders() },
    });
    if (!res.ok) {
      note = `Couldn't load sessions (${httpProblem(res.status)}).`;
    } else {
      const list = parseSessions(await res.json());
      if (!list) note = "Unexpected sessions response.";
      else {
        renderSessions(list);
        note = list.length === 0 ? "No active sessions." : null;
      }
    }
  } catch {
    note = "Server unreachable.";
  }
  sessionsNote.textContent = note ?? "";
  show(sessionsNote, note !== null);
  if (reschedule) pollTimer = setTimeout(() => void pollSessions(), SESSIONS_POLL_MS);
}

// --- live socket -----------------------------------------------------------------------------

function onMessage(data: string | ArrayBuffer): void {
  if (typeof data !== "string") return;
  const msg = parseMessage<ServerMessage>(data);
  if (!msg) return;
  switch (msg.type) {
    case "hello":
      if (typeof msg.serverTime === "number") skewMs = msg.serverTime - Date.now();
      break;
    case "snapshot":
      if (isObj(msg.status)) {
        status = msg.status;
        renderStatus();
      }
      break;
    case "status":
      if (isObj(msg.status)) {
        status = msg.status;
        renderStatus();
      }
      break;
    case "level":
      if (typeof msg.rmsDbfs === "number" && typeof msg.peakDbfs === "number") {
        onLevel(msg.rmsDbfs, msg.peakDbfs);
      }
      break;
    default:
      break;
  }
}

// --- init --------------------------------------------------------------------------------------

function init(): void {
  const savedSource = storageGet(`${STORE}source`);
  if (savedSource === "file" || savedSource === "device") sourceSel.value = savedSource;
  fileInput.value = storageGet(`${STORE}file`) ?? "";
  syncSourceRow();

  if (token) {
    for (const a of document.querySelectorAll<HTMLAnchorElement>("a.preview")) {
      const href = a.dataset.href ?? a.getAttribute("href") ?? "";
      a.href = `${href}${href.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    }
  }

  sourceSel.addEventListener("change", () => {
    syncSourceRow();
    storageSet(`${STORE}source`, sourceSel.value);
  });
  fileInput.addEventListener("change", () =>
    storageSet(`${STORE}file`, fileInput.value.trim() || null),
  );
  makeEventGroup(allEvents, () => "all", "all sessions");
  show(allRow, false);
  startBtn.addEventListener("click", startSession);
  twoStep(stopBtn, "Confirm stop", () => {
    void post("/api/session/stop", {}, stopBtn);
  });
  clearBtn.addEventListener("click", () => {
    void post("/api/captions/clear", {}, clearBtn);
  });

  renderStatus();
  renderConn("connecting");
  setInterval(renderTimer, 1000);
  requestAnimationFrame(meterFrame);

  const socket = new ReconnectingSocket({
    url: () => wsUrl(token ? `/ws?token=${encodeURIComponent(token)}` : "/ws"),
    onOpen: (ws) => {
      ws.send(JSON.stringify({ type: "subscribe", topics: ["level"] }));
    },
    onMessage,
    onState: (state) => renderConn(state),
  });
  socket.start();
  void pollSessions();
}

init();
