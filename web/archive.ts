// Archive page `/s/:sessionId`: a read-only, scrollable view of a session's blocks with the same
// block styles and theme (preset + URL params), plus exports. Pages through
// GET /api/sessions/:id/blocks (newest page first, then older pages) and starts at the top. Remote
// access needs the access key: ?key= is passed through, or asked for on 401/403. A hosted server
// has no access keys: there a refused reader is asked to log in.
import "./archive.css";
import type { Block } from "../src/shared/protocol.js";
import { BlockView } from "./shared/blocks.js";
import {
  type ApiAuth,
  authFrom,
  type BlocksMeta,
  exportLinks,
  fetchBlocks,
  HttpError,
} from "./shared/blocks-api.js";
import { byId, el } from "./shared/dom.js";
import { uiLabels } from "./shared/i18n.js";
import { bootTheme, stepFontScale } from "./shared/theme-boot.js";
import { Toolbar } from "./shared/toolbar.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

const msg = byId("arc-msg", HTMLDivElement);
const keyForm = byId("arc-key", HTMLFormElement);
const keyInput = byId("arc-key-input", HTMLInputElement);

function sessionFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length !== 2 || parts[0] !== "s" || !parts[1]) return null;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
}

/** GET /api/auth/state says this is a hosted server (false when it cannot be asked). */
async function hostedServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/state", { headers: { Accept: "application/json" } });
    const body = (await res.json()) as { mode?: unknown } | null;
    return body?.mode === "hosted";
  } catch {
    return false;
  }
}

function showMessage(text: string, link?: { label: string; href: string }): void {
  msg.replaceChildren(text);
  if (link) msg.append(" ", el("a", { text: link.label, attrs: { href: link.href } }));
  msg.hidden = false;
}

/** All blocks of the session in seq order (pages are fetched newest first) + its metadata. */
async function loadAll(
  sessionId: string,
  auth: ApiAuth,
): Promise<{ blocks: Block[]; meta: BlocksMeta | null }> {
  const pages: Block[][] = [];
  let meta: BlocksMeta | null = null;
  let before: number | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchBlocks(sessionId, before, PAGE_SIZE, auth);
    meta ??= page.meta;
    const sorted = [...page.blocks].sort((a, b) => a.seq - b.seq);
    pages.unshift(sorted);
    const first = sorted[0];
    if (!page.hasMore || !first) break;
    before = first.seq;
  }
  const seen = new Set<string>();
  const all: Block[] = [];
  for (const b of pages.flat()) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    all.push(b);
  }
  return { blocks: all, meta };
}

function sessionDate(at: number | null, lang: string): string {
  if (at === null) return "";
  try {
    return new Date(at).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ");
  }
}

async function main(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const sessionId = sessionFromPath(window.location.pathname);
  const theme = await bootTheme(query, { opaque: true });
  if (!sessionId) {
    showMessage("This isn't an archive address (expected /s/<session id>).", {
      label: "Start page",
      href: "/",
    });
    return;
  }
  const auth = authFrom(query);
  keyForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const key = keyInput.value.trim();
    if (!key) return;
    const next = new URLSearchParams(window.location.search);
    next.set("key", key);
    window.location.search = next.toString();
  });

  showMessage("Loading…");
  let blocks: Block[];
  let meta: BlocksMeta | null;
  try {
    ({ blocks, meta } = await loadAll(sessionId, auth));
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      if (await hostedServer()) {
        const next = window.location.pathname + window.location.search;
        showMessage("Log in to open this session.", {
          label: "Log in",
          href: `/login?next=${encodeURIComponent(next)}`,
        });
        return;
      }
      msg.hidden = true;
      keyForm.hidden = false;
      keyInput.focus();
      return;
    }
    if (err instanceof HttpError && err.status === 404) {
      showMessage(`Session ${sessionId} was not found.`, { label: "Start page", href: "/" });
      return;
    }
    showMessage("Couldn't load this session.", { label: "Try again", href: window.location.href });
    return;
  }
  msg.hidden = true;

  const o = theme.options;
  const targetLang = meta?.to ?? blocks.find((b) => b.lang)?.lang ?? query.get("lang") ?? "en";
  const labels = uiLabels(targetLang);
  document.title = `${labels.archive} · ${sessionId}`;
  document.documentElement.lang = targetLang;
  const view = new BlockView(byId("captions", HTMLDivElement), {
    show: o.show,
    quranAccent: o.quranAccent,
    quranArabic: o.quranArabic,
    partial: false,
    history: true,
    maxBlocks: 100_000,
    visibleBlocks: 0,
    pos: o.pos,
    bg: o.bg === "none" || o.bg === "shadow" ? "none" : "panel",
    targetLang,
    sourceLang: meta?.from ?? query.get("from") ?? "ar",
    live: false,
  });
  view.snapshot(blocks, false);
  if (meta?.endedAt) view.ended(meta.endedAt, sessionId);
  view.scrollToTop();
  if (blocks.length === 0) showMessage("This session has no caption blocks.");

  const base = theme.vars["--cap-font-size"] ?? `${o.size}px`;
  const toolbar = new Toolbar(document.body, {
    targetLang,
    label: labels.archive,
    showSource: o.show === "both",
    quranArabic: o.quranArabic,
    sourceToggle: o.show !== "source",
    onFontStep: (dir) => {
      stepFontScale(base, dir);
      view.refit();
    },
    onShowSource: (on) => view.setShow(on ? "both" : "target"),
    onQuranArabic: (on) => view.setQuranArabic(on),
  });
  toolbar.setState(
    meta?.live ? "live" : "idle",
    sessionDate(meta?.startedAt ?? blocks[0]?.createdAt ?? null, targetLang),
    sessionId,
  );
  const links = exportLinks(sessionId, auth);
  const a = (label: string, href: string): HTMLAnchorElement =>
    el("a", { text: label, attrs: { href, download: "", title: `${labels.export} ${label}` } });
  toolbar.root.append(
    el("span", { class: "arc-exports" }, [
      a("TXT", links.txt),
      a("MD", links.md),
      a("SRT", links.srt),
    ]),
  );
}

void main();
