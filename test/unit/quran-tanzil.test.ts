// The Quran data download (src/quran/tanzil.ts): what it fetches from Tanzil, what it checks and
// keeps, what it says when something fails, and the server's background download that tries
// again later. A fake fetch stands in for tanzil.net: no test reaches the network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AYAH_COUNT } from "../../src/quran/corpus.js";
import {
  checkQuranText,
  checkTranslation,
  downloadInBackground,
  downloadQuranData,
  missingQuranFiles,
  noticeBlock,
  type QuranFiles,
  TANZIL_URL,
  TEXT_TERMS,
  TRANS_TERMS,
  tanzilId,
} from "../../src/quran/tanzil.js";
import {
  ALL,
  fakeTanzil,
  SIMPLE,
  TEXT_QUERY,
  translation,
  transQuery,
  UTHMANI,
  UTHMANI_QUERY,
} from "./helpers/quran-tanzil.js";

let dir: string;
let files: QuranFiles;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tanzil-"));
  files = {
    quranTextFile: join(dir, "quran", "quran-simple-clean.txt"),
    quranUthmaniFile: join(dir, "quran", "quran-uthmani.txt"),
    quranTranslations: { nl: join(dir, "quran", "nl.siregar.txt") },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = () => new Date("2026-10-10T12:00:00.000Z");

describe("downloadQuranData", () => {
  it("downloads the text, the Uthmani text and the translations verbatim, with Tanzil's notices", async () => {
    const tanzil = fakeTanzil(ALL);
    const lines: string[] = [];
    const result = await downloadQuranData({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test/",
      progress: (l) => lines.push(l),
      now: NOW,
    });
    const license = join(dir, "quran", "LICENSE-tanzil.txt");
    expect(result).toEqual({
      saved: [files.quranTextFile, files.quranUthmaniFile, files.quranTranslations.nl],
      failed: [],
      manual: [],
      licenseFile: license,
    });
    expect(tanzil.urls()).toEqual([TEXT_QUERY, UTHMANI_QUERY, transQuery("nl.siregar")]);
    expect(new Set(tanzil.calls.map((c) => c.agent))).toEqual(
      new Set(["turjuman quran-data (+https://tanzil.net)"]),
    );
    expect(readFileSync(files.quranTextFile, "utf8")).toBe(SIMPLE);
    expect(readFileSync(files.quranUthmaniFile, "utf8")).toBe(UTHMANI);
    expect(readFileSync(files.quranTranslations.nl ?? "", "utf8")).toBe(translation("nl.siregar"));
    expect(lines).toEqual(result.saved.map((f) => `saved ${f}`));
    const text = readFileSync(license, "utf8");
    expect(text).toContain("Written by Turjuman on 2026-10-10T12:00:00.000Z.");
    expect(text).toContain(`Terms of Use: ${TEXT_TERMS}`);
    expect(text).toContain(`Terms of Use: ${TRANS_TERMS}`);
    expect(text).toContain(`--- quran-simple-clean.txt ---\n${noticeBlock(SIMPLE)}`);
    expect(text).toContain(`--- quran-uthmani.txt ---\n${noticeBlock(UTHMANI)}`);
    expect(text).toContain("--- nl.siregar.txt ---\n#  Name: Test translation\n#  ID: nl.siregar");
  });

  it("only checks the files in place, and downloads them again with force", async () => {
    await downloadQuranData({
      files,
      fetch: fakeTanzil(ALL).fetch,
      baseUrl: "https://tanzil.test",
    });
    const again = fakeTanzil(ALL);
    const lines: string[] = [];
    const result = await downloadQuranData({
      files,
      fetch: again.fetch,
      baseUrl: "https://tanzil.test",
      progress: (l) => lines.push(l),
    });
    expect(again.calls).toEqual([]);
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(lines).toEqual([
      `ok    ${files.quranTextFile} (present)`,
      `ok    ${files.quranUthmaniFile} (present)`,
      `ok    ${files.quranTranslations.nl} (present)`,
    ]);
    // The notices of the files in place still make the license file.
    expect(readFileSync(join(dir, "quran", "LICENSE-tanzil.txt"), "utf8")).toContain(
      "--- nl.siregar.txt ---",
    );
    const forced = fakeTanzil(ALL);
    const redo = await downloadQuranData({
      files,
      fetch: forced.fetch,
      baseUrl: "https://tanzil.test",
      force: true,
    });
    expect(forced.calls).toHaveLength(3);
    expect(redo.saved).toHaveLength(3);
  });

  it("tries every file, says what failed and how to download it by hand", async () => {
    const tanzil = fakeTanzil({
      [TEXT_QUERY]: 500,
      [UTHMANI_QUERY]: new TypeError("fetch failed"),
      [transQuery("nl.siregar")]: translation("nl.other"),
    });
    const lines: string[] = [];
    const result = await downloadQuranData({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test",
      progress: (l) => lines.push(l),
    });
    // A network or HTTP problem is tried twice; content that is wrong once.
    expect(tanzil.urls()).toEqual([
      TEXT_QUERY,
      TEXT_QUERY,
      UTHMANI_QUERY,
      UTHMANI_QUERY,
      transQuery("nl.siregar"),
    ]);
    expect(result.failed).toEqual([
      { file: files.quranTextFile, reason: `https://tanzil.test${TEXT_QUERY}: HTTP 500` },
      { file: files.quranUthmaniFile, reason: `https://tanzil.test${UTHMANI_QUERY}: fetch failed` },
      {
        file: files.quranTranslations.nl,
        reason: "translation info block for nl.siregar missing",
      },
    ]);
    expect(lines.every((l) => l.startsWith("FAIL  "))).toBe(true);
    expect(result.manual).toHaveLength(2);
    expect(result.manual[0]).toContain("Manual download of the Quran text:");
    expect(result.manual[0]).toContain(files.quranUthmaniFile);
    expect(result.manual[1]).toContain("Manual download of translation nl.siregar:");
    expect(result.licenseFile).toBeNull();
    expect(existsSync(files.quranTextFile)).toBe(false);
    expect(existsSync(join(dir, "quran", "LICENSE-tanzil.txt"))).toBe(false);
  });

  it("with commercial downloads no translation but gives its manual steps", async () => {
    const tanzil = fakeTanzil(ALL);
    const result = await downloadQuranData({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test",
      commercial: true,
    });
    expect(tanzil.urls()).toEqual([TEXT_QUERY, UTHMANI_QUERY]);
    expect(result.failed).toEqual([]);
    expect(result.manual).toEqual([expect.stringContaining("non-commercial use only")]);
    expect(readFileSync(result.licenseFile ?? "", "utf8")).toContain("(none downloaded)");
  });

  it("adds extra translations next to the text and skips a file that is no Tanzil id", async () => {
    files.quranTranslations = {
      nl: join(dir, "quran", "nl.siregar.txt"),
      en: join(dir, "my-en.txt"),
    };
    const tanzil = fakeTanzil({ ...ALL, [transQuery("nl.leemhuis")]: translation("nl.leemhuis") });
    const lines: string[] = [];
    const result = await downloadQuranData({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test",
      extra: ["nl.leemhuis"],
      progress: (l) => lines.push(l),
    });
    expect(lines).toContain(
      `skip  translation "en" (${join(dir, "my-en.txt")}): not a Tanzil id file name; place it by hand`,
    );
    expect(result.saved).toContain(join(dir, "quran", "nl.leemhuis.txt"));
    expect(result.failed).toEqual([]);
  });

  it("stops at once when it is aborted", async () => {
    const tanzil = fakeTanzil(ALL);
    const controller = new AbortController();
    controller.abort();
    const result = await downloadQuranData({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test",
      signal: controller.signal,
    });
    expect(tanzil.calls).toEqual([]);
    expect(result.failed.map((f) => f.reason)).toEqual([
      "This operation was aborted",
      "This operation was aborted",
      "This operation was aborted",
    ]);
  });

  it("uses the global fetch by default, and names a failure that is no Error", async () => {
    const offline = fakeTanzil({ [TEXT_QUERY]: () => Promise.reject("offline") });
    vi.stubGlobal("fetch", offline.fetch);
    try {
      const result = await downloadQuranData({ files, baseUrl: "https://tanzil.test" });
      expect(result.failed[0]).toEqual({
        file: files.quranTextFile,
        reason: `https://tanzil.test${TEXT_QUERY}: offline`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks TURJUMAN_TANZIL_URL when it is set, else tanzil.net", async () => {
    vi.stubEnv("TURJUMAN_TANZIL_URL", "http://127.0.0.1:9999");
    const mirror = fakeTanzil(ALL, "http://127.0.0.1:9999");
    await downloadQuranData({ files, fetch: mirror.fetch });
    expect(mirror.urls()).toEqual([TEXT_QUERY, UTHMANI_QUERY, transQuery("nl.siregar")]);
    vi.stubEnv("TURJUMAN_TANZIL_URL", "");
    const real = fakeTanzil({}, TANZIL_URL);
    await downloadQuranData({ files, fetch: real.fetch, force: true });
    expect(real.calls[0]?.url).toBe(`https://tanzil.net${TEXT_QUERY}`);
  });

  it("reports a license file it cannot write", async () => {
    mkdirSync(join(dir, "quran", "LICENSE-tanzil.txt"), { recursive: true });
    const lines: string[] = [];
    const result = await downloadQuranData({
      files,
      fetch: fakeTanzil(ALL).fetch,
      baseUrl: "https://tanzil.test",
      progress: (l) => lines.push(l),
    });
    expect(result.saved).toHaveLength(3);
    expect(result.licenseFile).toBeNull();
    expect(result.failed.map((f) => f.file)).toEqual([join(dir, "quran", "LICENSE-tanzil.txt")]);
    expect(lines.at(-1)).toMatch(/^FAIL {2}.*LICENSE-tanzil\.txt: /);
  });
});

describe("the checks of a downloaded file", () => {
  it("wants the whole Quran text of its kind with Tanzil's notice", () => {
    expect(() => checkQuranText(SIMPLE, "simple-clean")).not.toThrow();
    expect(() => checkQuranText(UTHMANI, "uthmani")).not.toThrow();
    expect(() => checkQuranText(SIMPLE, "uthmani")).toThrow("does not look like uthmani text");
    expect(() => checkQuranText(UTHMANI, "simple-clean")).toThrow(
      "does not look like simple-clean text",
    );
    expect(() => checkQuranText("1|1|بسم الله\n", "simple-clean")).toThrow(
      `expected ${AYAH_COUNT} ayat, got 1`,
    );
    expect(() => checkQuranText(SIMPLE.replace("Creative Commons", "CC"), "simple-clean")).toThrow(
      "Tanzil copyright notice missing",
    );
  });

  it("wants every line of a translation and its info block", () => {
    expect(() => checkTranslation(translation("nl.x"), "nl.x")).not.toThrow();
    expect(() => checkTranslation("vers 1\n\n#  ID: nl.x\n", "nl.x")).toThrow(
      `expected ${AYAH_COUNT} lines, got 1`,
    );
    expect(() => checkTranslation("vers 1\n", "nl.x")).toThrow(
      "translation info block for nl.x missing",
    );
  });

  it("knows a Tanzil id file name and a notice block", () => {
    expect(tanzilId("quran/nl.siregar.txt")).toBe("nl.siregar");
    expect(tanzilId("/x/en.sahih_int.txt")).toBe("en.sahih_int");
    expect(tanzilId("quran/my-dutch.txt")).toBeNull();
    expect(noticeBlock("1|1|x\n# a\n# b\n")).toBe("# a\n# b");
    expect(noticeBlock("1|1|x\n")).toBe("");
  });

  it("lists the files a download would fetch that are missing", () => {
    files.quranTranslations.en = join(dir, "own.txt");
    expect(missingQuranFiles(files)).toEqual([
      files.quranTextFile,
      files.quranUthmaniFile,
      files.quranTranslations.nl,
    ]);
    mkdirSync(join(dir, "quran"));
    writeFileSync(files.quranTextFile, SIMPLE);
    writeFileSync(files.quranUthmaniFile, UTHMANI);
    writeFileSync(files.quranTranslations.nl ?? "", translation("nl.siregar"));
    expect(missingQuranFiles(files)).toEqual([]);
  });
});

describe("downloadInBackground", () => {
  /** Lets the download run (promises, file writes) without moving the fake clock. */
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setImmediate(r));
    expect(check()).toBe(true);
  }
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  function fakeLog() {
    const info: string[] = [];
    const warn: string[] = [];
    const log = {
      info: (msg: string) => void info.push(msg),
      warn: (msg: string) => void warn.push(msg),
    } as unknown as Pick<Logger, "info" | "warn">;
    return { log, info, warn };
  }

  it("downloads what is missing, then says so and tells the caller once", async () => {
    const { log, info, warn } = fakeLog();
    const onSaved = vi.fn();
    downloadInBackground({
      files,
      fetch: fakeTanzil(ALL).fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved,
    });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(info).toEqual([
      `Quran data: downloading the Tanzil Quran text and translations into ${join(dir, "quran")}`,
      `Quran data: saved ${files.quranTextFile}`,
      `Quran data: saved ${files.quranUthmaniFile}`,
      `Quran data: saved ${files.quranTranslations.nl}`,
      "Quran data: complete (Tanzil Project, tanzil.net; terms in LICENSE-tanzil.txt)",
    ]);
    expect(warn).toEqual([]);
  });

  it("tries again after 1 minute, 5 minutes, then every 30 minutes, until it works", async () => {
    fakeClock();
    const { log, warn } = fakeLog();
    const onSaved = vi.fn();
    let online = false;
    const offline = new TypeError("fetch failed");
    const tanzil = fakeTanzil({
      [TEXT_QUERY]: async () => (online ? new Response(SIMPLE) : Promise.reject(offline)),
      [UTHMANI_QUERY]: async () => (online ? new Response(UTHMANI) : Promise.reject(offline)),
      [transQuery("nl.siregar")]: async () =>
        online ? new Response(translation("nl.siregar")) : Promise.reject(offline),
    });
    downloadInBackground({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved,
    });
    const retry = async (n: number, wait: string) => {
      await until(() => warn.length === n);
      expect(warn[n - 1]).toBe(
        `Quran data: 3 file(s) not downloaded (https://tanzil.test${TEXT_QUERY}: fetch failed); trying again in ${wait}`,
      );
    };
    await retry(1, "1 minute");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(warn).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await retry(2, "5 minutes");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await retry(3, "30 minutes");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await retry(4, "30 minutes");
    expect(onSaved).not.toHaveBeenCalled();
    online = true;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await until(() => onSaved.mock.calls.length === 1);
    expect(existsSync(files.quranTranslations.nl ?? "")).toBe(true);
    // Done: no more attempts.
    const calls = tanzil.calls.length;
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(tanzil.calls).toHaveLength(calls);
  });

  it("loads what arrived while it keeps trying for the rest", async () => {
    fakeClock();
    const { log, warn } = fakeLog();
    const onSaved = vi.fn();
    downloadInBackground({
      files,
      fetch: fakeTanzil({ [TEXT_QUERY]: SIMPLE, [UTHMANI_QUERY]: UTHMANI }).fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved,
      retryMs: [120_000],
    });
    await until(() => warn.length === 1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(warn[0]).toMatch(
      /^Quran data: 1 file\(s\) not downloaded \(.*HTTP 404\); trying again in 2 minutes$/,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await until(() => warn.length === 2);
    // Nothing new arrived the second time.
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("stops: the download in flight is aborted and no retry follows", async () => {
    fakeClock();
    const { log, info, warn } = fakeLog();
    const hanging = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const tanzil = fakeTanzil({ [TEXT_QUERY]: hanging, [UTHMANI_QUERY]: hanging });
    const first = downloadInBackground({
      files,
      fetch: tanzil.fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved: vi.fn(),
    });
    await until(() => tanzil.calls.length === 1);
    first.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(warn).toEqual([]);
    expect(info.some((line) => line.includes("complete"))).toBe(false);

    // Stopped while waiting for the next attempt.
    const failing = fakeTanzil({});
    const second = downloadInBackground({
      files,
      fetch: failing.fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved: vi.fn(),
    });
    await until(() => warn.length === 1);
    const calls = failing.calls.length;
    second.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(failing.calls).toHaveLength(calls);
  });

  it("waits a minute when it is given no retry times", async () => {
    fakeClock();
    const { log, warn } = fakeLog();
    const failing = fakeTanzil({});
    const download = downloadInBackground({
      files,
      fetch: failing.fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved: vi.fn(),
      retryMs: [],
    });
    await until(() => warn.length === 1);
    expect(warn[0]).toMatch(/trying again in 1 minute$/);
    download.stop();
  });

  it("logs files that arrived but cannot be loaded, without stopping", async () => {
    const { log, warn } = fakeLog();
    downloadInBackground({
      files,
      fetch: fakeTanzil(ALL).fetch,
      baseUrl: "https://tanzil.test",
      log,
      onSaved: () => {
        throw new Error("out of memory");
      },
    });
    await vi.waitFor(() =>
      expect(warn).toEqual([
        "Quran data: the downloaded files could not be loaded (out of memory)",
      ]),
    );
  });
});
