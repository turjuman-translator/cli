// The Tanzil Quran text and the configured translations, downloaded into DATA_DIR/quran/ verbatim,
// with Tanzil's license notices in LICENSE-tanzil.txt. The server downloads what is missing by
// itself when it starts (in the background, again later when it fails); scripts/quran-data.ts runs
// the same download by hand (--force, extra translations, --commercial).
//
// Terms of use (checked 2026-10-02):
//  * Quran text (https://tanzil.net/download/, https://tanzil.net/docs/Text_License): CC BY 3.0.
//    Verbatim copies may be copied and distributed, changing the text is not allowed, the source
//    must be credited with a link to tanzil.net, and the copyright notice kept. The files are
//    stored exactly as downloaded (normalization happens in memory, for matching only).
//  * Translations (https://tanzil.net/trans/): "for non-commercial purposes only. If used
//    otherwise, you need to obtain necessary permission from the translator or the publisher."
//    A mosque's free caption service is non-commercial; with `commercial` only the manual steps
//    are given.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import { writeFileAtomic } from "../paths.js";
import { AYAH_COUNT, parseTanzilText, type TanzilLine } from "./corpus.js";

/** Where the files come from; TURJUMAN_TANZIL_URL points elsewhere (tests, a mirror). */
export const TANZIL_URL = "https://tanzil.net";
export const TANZIL_URL_ENV = "TURJUMAN_TANZIL_URL";

export const TEXT_TERMS =
  "Permission is granted to copy and distribute verbatim copies of the Quran text provided " +
  "here, but changing the text is not allowed. The text can be used in any website or " +
  "application, provided that its source (Tanzil Project) is clearly indicated, and a link is " +
  "made to tanzil.net to enable users to keep track of changes.";
export const TRANS_TERMS =
  "The translations provided at this page are for non-commercial purposes only. If used " +
  "otherwise, you need to obtain necessary permission from the translator or the publisher. " +
  "If you are using more than three of the following translations in a website or application, " +
  "we require you to put a link back to this page to make sure that subsequent users have access " +
  "to the latest updates.";

const UA = "turjuman quran-data (+https://tanzil.net)";

/** The files of the Quran data (ResolvedPaths has them). */
export interface QuranFiles {
  quranTextFile: string;
  quranUthmaniFile: string;
  /** Caption language → translation file. */
  quranTranslations: Record<string, string>;
}

export interface QuranDownloadOptions {
  files: QuranFiles;
  /** Download the files that are present again. */
  force?: boolean;
  /** Commercial use: no translation is downloaded; their manual steps are returned instead. */
  commercial?: boolean;
  /** More Tanzil translation ids (e.g. nl.leemhuis), saved next to the Quran text. */
  extra?: readonly string[];
  /** Default: TURJUMAN_TANZIL_URL, else https://tanzil.net. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Stops the download (the server shutting down). */
  signal?: AbortSignal;
  /** Per request (default 60 s). */
  timeoutMs?: number;
  /** One line per file: present, saved, skipped or failed. */
  progress?: (line: string) => void;
  now?: () => Date;
}

export interface QuranDownloadResult {
  /** Files written. */
  saved: string[];
  /** Files that could not be downloaded, and why. */
  failed: Array<{ file: string; reason: string }>;
  /** The steps to do by hand: for the failed files, and for every translation with `commercial`. */
  manual: string[];
  /** LICENSE-tanzil.txt, when it was written. */
  licenseFile: string | null;
}

type TextKind = "simple-clean" | "uthmani";

/** "quran/nl.siregar.txt" → "nl.siregar" (a Tanzil translation id), or null. */
export function tanzilId(file: string): string | null {
  const m = /^([a-z]{2,3}\.[a-z0-9_-]+)\.txt$/i.exec(basename(file));
  return m?.[1] ?? null;
}

/** The trailing "#" comment block of a Tanzil file (its copyright notice), verbatim. */
export function noticeBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex((l) => l.startsWith("#"));
  return first === -1 ? "" : lines.slice(first).join("\n").trim();
}

/** Throws when `content` is not the complete Tanzil text of this kind, with its notice. */
export function checkQuranText(content: string, kind: TextKind): void {
  const lines = parseTanzilText(content);
  if (lines.length !== AYAH_COUNT) {
    throw new Error(`expected ${AYAH_COUNT} ayat, got ${lines.length}`);
  }
  const notice = noticeBlock(content);
  if (!/Tanzil Quran Text/.test(notice) || !/Creative Commons/.test(notice)) {
    throw new Error("Tanzil copyright notice missing");
  }
  // There are AYAH_COUNT lines here, so the first one exists.
  const hasTashkeel = /[ً-ْ]/.test((lines[0] as TanzilLine).text);
  if ((kind === "uthmani") !== hasTashkeel) throw new Error(`does not look like ${kind} text`);
}

/** Throws when `content` is not the complete translation `id`, with its info block. */
export function checkTranslation(content: string, id: string): void {
  const notice = noticeBlock(content);
  if (!notice.includes(`ID: ${id}`)) throw new Error(`translation info block for ${id} missing`);
  const lines = content.split(/\r?\n/);
  const end = lines.findIndex((l) => l.startsWith("#"));
  const data = lines.slice(0, end).filter((l) => l.trim() !== "");
  if (data.length !== AYAH_COUNT) {
    throw new Error(`expected ${AYAH_COUNT} lines, got ${data.length}`);
  }
}

/** The translations to download: id → file (configured ones with a Tanzil id name, then extras). */
function wantedTranslations(
  files: QuranFiles,
  extra: readonly string[],
  progress: (line: string) => void,
): Map<string, string> {
  const wanted = new Map<string, string>();
  for (const [lang, file] of Object.entries(files.quranTranslations)) {
    const id = tanzilId(file);
    if (id === null) {
      progress(
        `skip  translation "${lang}" (${file}): not a Tanzil id file name; place it by hand`,
      );
      continue;
    }
    wanted.set(id, file);
  }
  for (const id of extra) wanted.set(id, join(dirname(files.quranTextFile), `${id}.txt`));
  return wanted;
}

/** The files a download would fetch that are not there yet. */
export function missingQuranFiles(files: QuranFiles): string[] {
  const all = [
    files.quranTextFile,
    files.quranUthmaniFile,
    ...wantedTranslations(files, [], () => {}).values(),
  ];
  return all.filter((file) => !existsSync(file));
}

function manualText(simpleFile: string, uthmaniFile: string): string {
  return [
    "Manual download of the Quran text:",
    "  1. Open https://tanzil.net/download/ and read the Terms of Use.",
    '  2. Quran text type "Simple (Clean)", output "Text (with aya numbers)", tick',
    `     "I agree with Terms of Use", Download, and save the file unchanged as ${simpleFile}`,
    '  3. Same with "Uthmani" (keep pause marks and sajdah signs ticked), saved as',
    `     ${uthmaniFile}`,
  ].join("\n");
}

function manualTranslation(id: string, file: string): string {
  return [
    `Manual download of translation ${id}:`,
    "  1. Open https://tanzil.net/trans/ and read the Terms of Use (non-commercial use only;",
    "     otherwise ask the translator or publisher for permission).",
    `  2. File format "Text", click the download icon of ${id}, and save it unchanged as`,
    `     ${file}`,
  ].join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Download the Quran text (simple-clean and Uthmani) and the translations into their files, each
 * checked before it is saved; files that are present are only checked (unless `force`). Every
 * file is tried, also after one failed. Writes LICENSE-tanzil.txt with the notices of every file
 * in place. Never throws for a file that fails: it is listed in `failed`.
 */
export async function downloadQuranData(opts: QuranDownloadOptions): Promise<QuranDownloadResult> {
  const { files } = opts;
  const base = (opts.baseUrl ?? (process.env[TANZIL_URL_ENV] || TANZIL_URL)).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const progress = opts.progress ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const result: QuranDownloadResult = { saved: [], failed: [], manual: [], licenseFile: null };

  const download = async (url: string): Promise<string> => {
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
      try {
        const res = await doFetch(url, { headers: { "user-agent": UA }, signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        last = err;
        if (opts.signal?.aborted === true) break;
      }
    }
    throw new Error(`${url}: ${errorText(last)}`);
  };

  /** One file: the one in place (checked), else downloaded, checked and saved. Its notice. */
  const fetchFile = async (
    file: string,
    url: string,
    check: (content: string) => void,
  ): Promise<string | null> => {
    try {
      // Stopped (the server shuts down): the files left are not even asked for.
      opts.signal?.throwIfAborted();
      mkdirSync(dirname(file), { recursive: true });
      if (opts.force !== true && existsSync(file)) {
        const existing = readFileSync(file, "utf8");
        check(existing);
        progress(`ok    ${file} (present)`);
        return `--- ${basename(file)} ---\n${noticeBlock(existing)}`;
      }
      const content = await download(url);
      check(content);
      writeFileAtomic(file, content);
      result.saved.push(file);
      progress(`saved ${file}`);
      return `--- ${basename(file)} ---\n${noticeBlock(content)}`;
    } catch (err) {
      result.failed.push({ file, reason: errorText(err) });
      progress(`FAIL  ${file}: ${errorText(err)}`);
      return null;
    }
  };

  const texts: Array<{ kind: TextKind; file: string; query: string }> = [
    {
      kind: "simple-clean",
      file: files.quranTextFile,
      query: "quranType=simple-clean&outType=txt-2",
    },
    {
      kind: "uthmani",
      file: files.quranUthmaniFile,
      query: "marks=true&sajdah=true&tatweel=true&quranType=uthmani&outType=txt-2",
    },
  ];
  const notices: string[] = [];
  for (const t of texts) {
    const notice = await fetchFile(
      t.file,
      `${base}/pub/download/index.php?${t.query}&agree=true`,
      (content) => checkQuranText(content, t.kind),
    );
    if (notice !== null) notices.push(notice);
  }
  if (result.failed.length > 0) {
    result.manual.push(manualText(files.quranTextFile, files.quranUthmaniFile));
  }

  const transNotices: string[] = [];
  for (const [id, file] of wantedTranslations(files, opts.extra ?? [], progress)) {
    if (opts.commercial === true) {
      result.manual.push(manualTranslation(id, file));
      continue;
    }
    const failedBefore = result.failed.length;
    const notice = await fetchFile(
      file,
      `${base}/trans/?transID=${encodeURIComponent(id)}&type=txt`,
      (content) => checkTranslation(content, id),
    );
    if (notice !== null) transNotices.push(notice);
    if (result.failed.length > failedBefore) result.manual.push(manualTranslation(id, file));
  }

  if (notices.length > 0 || transNotices.length > 0) {
    const licenseFile = join(dirname(files.quranTextFile), "LICENSE-tanzil.txt");
    const license = [
      "Tanzil Project: license notices for the files in this directory",
      `Written by Turjuman on ${(opts.now?.() ?? new Date()).toISOString()}.`,
      "",
      "QURAN TEXT. Source: Tanzil Project, https://tanzil.net (updates: https://tanzil.net/updates/)",
      "Downloaded from https://tanzil.net/download/ and stored verbatim (not modified).",
      `Terms of Use: ${TEXT_TERMS}`,
      "",
      ...notices.map((n) => `${n}\n`),
      "TRANSLATIONS. Source: https://tanzil.net/trans/ (stored verbatim)",
      `Terms of Use: ${TRANS_TERMS}`,
      "",
      ...(transNotices.length > 0 ? transNotices.map((n) => `${n}\n`) : ["(none downloaded)\n"]),
    ].join("\n");
    try {
      writeFileAtomic(licenseFile, license);
      result.licenseFile = licenseFile;
    } catch (err) {
      result.failed.push({ file: licenseFile, reason: errorText(err) });
      progress(`FAIL  ${licenseFile}: ${errorText(err)}`);
    }
  }
  return result;
}

/** After a failed background download: again after 1 min, 5 min, then every 30 min. */
export const RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];

export interface BackgroundDownloadOptions
  extends Omit<QuranDownloadOptions, "signal" | "progress" | "force" | "commercial" | "extra"> {
  log: Pick<Logger, "info" | "warn">;
  /** After every attempt that saved a file: the caller loads the files that are in place. */
  onSaved: () => void;
  retryMs?: readonly number[];
}

export interface BackgroundDownload {
  /** Stop: the request in flight is aborted and no retry follows. */
  stop(): void;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/**
 * Download the missing Quran data without holding anything up: the first attempt starts now, a
 * failed one (no internet, Tanzil down) is tried again later, until every file is in place.
 * Progress goes to the log. Never throws, and its timers never keep the process alive.
 */
export function downloadInBackground(opts: BackgroundDownloadOptions): BackgroundDownload {
  const { log, onSaved, retryMs = RETRY_MS, ...download } = opts;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;
  const attempt = async (): Promise<void> => {
    timer = null;
    log.info(
      `Quran data: downloading the Tanzil Quran text and translations into ${dirname(download.files.quranTextFile)}`,
    );
    const result = await downloadQuranData({
      ...download,
      signal: controller.signal,
      progress: (line) => log.info(`Quran data: ${line}`),
    });
    if (controller.signal.aborted) return;
    if (result.saved.length > 0) {
      try {
        onSaved();
      } catch (err) {
        log.warn(`Quran data: the downloaded files could not be loaded (${errorText(err)})`);
      }
    }
    const first = result.failed[0];
    if (first === undefined) {
      log.info("Quran data: complete (Tanzil Project, tanzil.net; terms in LICENSE-tanzil.txt)");
      return;
    }
    const wait = retryMs[Math.min(failures, retryMs.length - 1)] ?? 60_000;
    failures++;
    log.warn(
      `Quran data: ${result.failed.length} file(s) not downloaded (${first.reason}); trying again in ${minutes(wait)}`,
    );
    timer = setTimeout(() => void attempt(), wait);
    timer.unref();
  };
  void attempt();
  return {
    stop: () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    },
  };
}
