// A fake tanzil.net for the tests of the Quran data download: the Tanzil files with their real
// structure (6,236 numbered lines, the copyright notice, the translation's info block) and short
// texts, and a fetch that serves them. No test reaches the network.
import { vi } from "vitest";
import { AYAH_COUNT } from "../../../src/quran/corpus.js";
import { SURA_SIZES } from "../quran-test-corpus.js";

export function rows(text: (i: number) => string): string[] {
  const out: string[] = [];
  let i = 0;
  SURA_SIZES.forEach((size, s) => {
    for (let a = 1; a <= size; a++) out.push(`${s + 1}|${a}|${text(i++)}`);
  });
  return out;
}

export const notice = (name: string): string =>
  [
    "",
    "#================================================================",
    `#  Tanzil Quran Text (${name}, Version 1.1)`,
    "#  Copyright (C) 2007-2026 Tanzil Project",
    "#  License: Creative Commons Attribution 3.0",
    "#================================================================",
  ].join("\n");

export const SIMPLE = `${rows((i) => (i === 0 ? "بسم الله الرحمن الرحيم" : `كلمة ${i}`)).join("\n")}${notice("Simple Clean")}\n`;
export const UTHMANI = `${rows((i) => (i === 0 ? "بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ" : `كَلِمَة ${i}`)).join("\n")}${notice("Uthmani")}\n`;
export const translation = (id: string): string =>
  `${Array.from({ length: AYAH_COUNT }, (_, i) => `vers ${i + 1}`).join("\n")}\n\n` +
  `#  Name: Test translation\n#  ID: ${id}\n#  Last Update: 2026-01-01\n`;

export const TEXT_QUERY = "/pub/download/index.php?quranType=simple-clean&outType=txt-2&agree=true";
export const UTHMANI_QUERY =
  "/pub/download/index.php?marks=true&sajdah=true&tatweel=true&quranType=uthmani&outType=txt-2&agree=true";
export const transQuery = (id: string): string => `/trans/?transID=${id}&type=txt`;

export type Answer = string | number | Error | ((signal: AbortSignal) => Promise<Response>);

/** A tanzil.net that answers each path with a body, an HTTP status or a network error. */
export function fakeTanzil(answers: Record<string, Answer>, base = "https://tanzil.test") {
  const calls: Array<{ url: string; agent: string | null }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, agent: new Headers(init?.headers).get("user-agent") });
    const signal = init?.signal as AbortSignal;
    signal.throwIfAborted();
    const answer = answers[url.slice(base.length)] ?? 404;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(signal);
    if (typeof answer === "number") return new Response("no", { status: answer });
    return new Response(answer);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, urls: () => calls.map((c) => c.url.slice(base.length)) };
}

export const ALL: Record<string, Answer> = {
  [TEXT_QUERY]: SIMPLE,
  [UTHMANI_QUERY]: UTHMANI,
  [transQuery("nl.siregar")]: translation("nl.siregar"),
};
