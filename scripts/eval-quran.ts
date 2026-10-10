// Quran matcher evaluation: runs the khutbah-style fixtures in
// test/fixtures/quran/*.json and prints precision / recall / F1, every failure, and latency.
//
//   pnpm exec tsx scripts/eval-quran.ts            # needs the Tanzil data (make quran-data)
//   pnpm exec tsx scripts/eval-quran.ts --verbose  # also print every match
//   pnpm exec tsx scripts/eval-quran.ts --stress   # + seeded synthetic stress test (see below)
//
// Fixture case: { id, segment, prevText?, ignoreStoplist?, expected: ["2:286"] | [],
//                 acceptable?: [...], partial?: boolean, note? }
//  * expected:   refs the matcher must find (true positives when found exactly);
//  * acceptable: correct refs that are not required (e.g. quotes below the matcher's length
//                thresholds);
//  * any other ref is a WRONG reference (false positive); precision must stay ≥ 0.98.
// Exit code 1 when precision < 0.98.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadCorpus, type QuranCorpus } from "../src/quran/corpus.js";
import {
  loadQuranMatcher,
  parseRef,
  type QuranMatcher,
  sourceExcerpt,
} from "../src/quran/matcher.js";
import { arabicWords } from "../src/text/arabic.js";

interface Case {
  id: string;
  segment: string;
  prevText?: string;
  ignoreStoplist?: boolean;
  expected: string[];
  acceptable?: string[];
  partial?: boolean;
  note?: string;
}

const verbose = process.argv.includes("--verbose");
const stress = process.argv.includes("--stress");
const fixturesDir = join(process.cwd(), "test", "fixtures", "quran");
const PRECISION_TARGET = 0.98;
const RECALL_TARGET = 0.85;

/** Ayat of a ref as "s:a" strings (for lenient comparison). */
function ayat(ref: string): string[] {
  const p = parseRef(ref);
  if (p === null) return [];
  const out: string[] = [];
  for (let a = p.from; a <= p.to; a++) out.push(`${p.sura}:${a}`);
  return out;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/**
 * Synthetic stress test: random spans of 1–3 consecutive ayat from the whole corpus, with ASR-like
 * corruption (dropped / substituted / inserted words, و added or dropped), wrapped in khutbah
 * phrases; quotes split between prevText and text; and shuffled Quran words (must never match).
 * Any ref naming an ayah the sample did not quote is WRONG. Seeded, so runs are reproducible.
 */
function stressTest(matcher: QuranMatcher, corpus: QuranCorpus): number {
  let seed = 20261002;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
  const vocab = corpus.simple.flatMap((t) => t.split(" "));
  const intro = ["قال الله تعالى", "يقول الله عز وجل", "وقال سبحانه", "عباد الله", ""];
  const outro = ["فاتقوا الله عباد الله", "صدق الله العظيم", "واعلموا أن الدنيا دار ممر", ""];
  const opts = { targetLang: "nl", ignoreStoplist: false };
  const refAyat = (ref: string): string[] => ayat(ref);
  const sample = (): { words: string[]; truth: string[] } => {
    const a0 = Math.floor(rnd() * corpus.simple.length);
    const n = rnd() < 0.7 ? 1 : rnd() < 0.7 ? 2 : 3;
    const idxs = [a0];
    for (let k = 1; k < n; k++) {
      if (a0 + k < corpus.simple.length && corpus.sura[a0 + k] === corpus.sura[a0])
        idxs.push(a0 + k);
    }
    const all = idxs.flatMap((i) =>
      (corpus.simple[i] ?? "")
        .split(" ")
        .map((w) => ({ w, ref: `${corpus.sura[i]}:${corpus.aya[i]}` })),
    );
    const len = Math.min(all.length, 5 + Math.floor(rnd() * 25));
    const st = Math.floor(rnd() * (all.length - len + 1));
    const span = all.slice(st, st + len);
    return { words: span.map((x) => x.w), truth: span.map((x) => x.ref) };
  };
  let wrongTotal = 0;
  const report = (label: string, preds: number, wrong: number, extra: string): void => {
    wrongTotal += wrong;
    const precision = preds === 0 ? 1 : (preds - wrong) / preds;
    console.log(
      `  ${label.padEnd(34)} refs ${String(preds).padStart(5)}, wrong ${wrong}, precision ${pct(precision)}${extra}`,
    );
  };

  for (const noise of [0, 0.1, 0.25]) {
    let preds = 0;
    let wrong = 0;
    let clean8 = 0;
    let clean8Hit = 0;
    for (let n = 0; n < 2000; n++) {
      const { words, truth } = sample();
      const truthSet = new Set(truth);
      const out: string[] = [];
      let corrupted = 0;
      for (const w of words) {
        const r = rnd();
        if (r < noise * 0.35) corrupted++;
        else if (r < noise * 0.7) {
          out.push(pick(vocab));
          corrupted++;
        } else if (r < noise * 0.85) {
          out.push(w.startsWith("و") ? w.slice(1) : `و${w}`);
          corrupted++;
        } else if (r < noise) {
          out.push(w, pick(["يعني", "اه", "الله"]));
          corrupted++;
        } else out.push(w);
      }
      const text = `${pick(intro)} ${out.join(" ")} ${pick(outro)}`.trim();
      let hit = false;
      for (const m of matcher.match({ text }, opts)) {
        preds++;
        if (refAyat(m.ref).every((a) => truthSet.has(a))) hit = true;
        else wrong++;
      }
      if (corrupted === 0 && words.length >= 8) {
        clean8++;
        if (hit) clean8Hit++;
      }
    }
    const extra = clean8 > 0 ? `, recall on clean ≥8-word quotes ${pct(clean8Hit / clean8)}` : "";
    report(`random quotes, noise ${noise}`, preds, wrong, extra);
  }

  let preds = 0;
  let wrong = 0;
  let hits = 0;
  for (let n = 0; n < 1500; n++) {
    const { words, truth } = sample();
    if (words.length < 6) continue;
    const cut = 1 + Math.floor(rnd() * (words.length - 1));
    const truthSet = new Set(truth.slice(cut));
    const prevText = `قال تعالى ${words.slice(0, cut).join(" ")}`;
    const text = `${words.slice(cut).join(" ")} ${pick(outro)}`.trim();
    let hit = false;
    for (const m of matcher.match({ text, prevText }, opts)) {
      preds++;
      if (refAyat(m.ref).every((a) => truthSet.has(a))) hit = true;
      else wrong++;
    }
    if (hit) hits++;
  }
  report("quotes split over prevText/text", preds, wrong, `, ${hits} found`);

  preds = 0;
  for (let n = 0; n < 1500; n++) {
    const a0 = Math.floor(rnd() * (corpus.simple.length - 3));
    const words = [0, 1, 2].flatMap((k) => (corpus.simple[a0 + k] ?? "").split(" "));
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [words[i], words[j]] = [words[j] as string, words[i] as string];
    }
    preds += matcher.match({ text: words.slice(0, 40).join(" ") }, opts).length;
  }
  report("shuffled Quran words (negatives)", preds, preds, "");
  return wrongTotal;
}

function main(): number {
  const { config, paths } = loadConfig();
  const problems: string[] = [];
  const t0 = performance.now();
  const matcher = loadQuranMatcher(
    paths,
    { ...config.quran, enabled: true },
    {
      onProblem: (p) => problems.push(p),
    },
  );
  const loadMs = performance.now() - t0;
  for (const p of problems) console.log(`warning: ${p}`);
  if (!matcher.ready) {
    console.error("Quran data missing: run pnpm exec tsx scripts/quran-data.ts (make quran-data)");
    return 1;
  }
  console.log(`corpus + index loaded in ${loadMs.toFixed(0)} ms`);
  const suspect = loadCorpus({
    textFile: paths.quranTextFile,
    translations: paths.quranTranslations,
  }).suspect;
  for (const [lang, n] of Object.entries(suspect)) {
    console.log(`translation ${lang}: ${n} ayat rejected as corrupt (approved = null)`);
  }

  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cases: Array<Case & { file: string }> = [];
  for (const f of files) {
    const list = JSON.parse(readFileSync(join(fixturesDir, f), "utf8")) as Case[];
    for (const c of list) cases.push({ ...c, file: f });
  }

  // Warm-up (JIT) before timing.
  for (const c of cases.slice(0, 5)) {
    matcher.match({ text: c.segment }, { targetLang: "nl", ignoreStoplist: false });
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let acceptableHits = 0;
  let lenientFp = 0;
  let partialChecks = 0;
  let partialWrong = 0;
  const times: number[] = [];
  const failures: string[] = [];
  const perFile = new Map<string, { cases: number; failed: number }>();

  for (const c of cases) {
    const window =
      c.prevText === undefined ? { text: c.segment } : { text: c.segment, prevText: c.prevText };
    const start = performance.now();
    const matches = matcher.match(window, {
      targetLang: "nl",
      ignoreStoplist: c.ignoreStoplist ?? false,
    });
    times.push(performance.now() - start);

    const got = matches.map((m) => m.ref);
    const expected = new Set(c.expected);
    const acceptable = new Set(c.acceptable ?? []);
    const okAyat = new Set([...c.expected, ...(c.acceptable ?? [])].flatMap(ayat));
    const issues: string[] = [];
    for (const ref of got) {
      if (expected.has(ref)) {
        tp++;
        expected.delete(ref);
      } else if (acceptable.has(ref)) {
        acceptableHits++;
      } else {
        fp++;
        const sub = ayat(ref).length > 0 && ayat(ref).every((a) => okAyat.has(a));
        if (!sub) lenientFp++;
        issues.push(`WRONG ref ${ref}${sub ? " (inside the expected ayat, wrong range)" : ""}`);
      }
    }
    for (const ref of expected) {
      fn++;
      issues.push(`missed ${ref}`);
    }
    if (c.partial !== undefined) {
      const first = matches.find((m) => m.ref === c.expected[0]);
      if (first !== undefined) {
        partialChecks++;
        if (first.partial !== c.partial) {
          partialWrong++;
          issues.push(`partial=${first.partial}, expected ${c.partial}`);
        }
      }
    }
    for (const m of matches) {
      const n = arabicWords(c.segment).length;
      if (m.span.start < 0 || m.span.end > n || m.span.end <= m.span.start) {
        issues.push(`bad span ${JSON.stringify(m.span)} for ${n} words`);
      }
    }

    const stat = perFile.get(c.file) ?? { cases: 0, failed: 0 };
    stat.cases++;
    if (issues.length > 0) stat.failed++;
    perFile.set(c.file, stat);

    const detail = matches
      .map(
        (m) =>
          `${m.ref}${m.partial ? " partial" : ""} score=${m.score} "${sourceExcerpt(c.segment, m.span)}"` +
          ` approved=${m.approved === null ? "null" : "yes"}`,
      )
      .join("\n      ");
    if (issues.length > 0) {
      failures.push(
        `  ✗ ${c.file} ${c.id}: ${issues.join("; ")}\n      expected=${JSON.stringify(c.expected)}` +
          `${c.acceptable ? ` acceptable=${JSON.stringify(c.acceptable)}` : ""}` +
          `${detail ? `\n      ${detail}` : ""}`,
      );
    } else if (verbose) {
      console.log(`  ✓ ${c.id}${detail ? `\n      ${detail}` : ""}`);
    }
  }

  // Latency on a long window (≈ 150 words of khutbah speech with two quotes).
  const longText = cases
    .filter((c) => c.file === "near-misses.json" || c.file === "formulas.json")
    .map((c) => c.segment)
    .join(" ");
  const longWindow = {
    prevText: longText.split(" ").slice(0, 70).join(" "),
    text: `${longText.split(" ").slice(70, 130).join(" ")} ${cases.find((c) => c.id === "full-4-1")?.segment ?? ""}`,
  };
  const longTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    matcher.match(longWindow, { targetLang: "nl", ignoreStoplist: false });
    longTimes.push(performance.now() - s);
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const lenientPrecision = tp + lenientFp === 0 ? 1 : tp / (tp + lenientFp);
  times.sort((a, b) => a - b);
  longTimes.sort((a, b) => a - b);

  console.log(`\n${cases.length} cases in ${files.length} files`);
  for (const [f, s] of perFile)
    console.log(`  ${f.padEnd(18)} ${s.cases - s.failed}/${s.cases} ok`);
  if (failures.length > 0) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) console.log(f);
  }
  console.log("\nRefs:");
  console.log(
    `  true positives ${tp}, wrong refs ${fp}, missed ${fn}, acceptable extra ${acceptableHits}`,
  );
  console.log(
    `  precision ${pct(precision)} (target ≥ ${pct(PRECISION_TARGET)})  ` +
      `[lenient, wrong-range-only not counted: ${pct(lenientPrecision)}]`,
  );
  console.log(`  recall    ${pct(recall)} (target ≥ ${pct(RECALL_TARGET)})`);
  console.log(`  F1        ${pct(f1)}`);
  console.log(`  partial flag ${partialChecks - partialWrong}/${partialChecks} as expected`);
  console.log("\nLatency per match() call:");
  console.log(
    `  fixtures: mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)} ms, ` +
      `p50 ${quantile(times, 0.5).toFixed(2)} ms, p95 ${quantile(times, 0.95).toFixed(2)} ms, ` +
      `max ${(times[times.length - 1] ?? 0).toFixed(2)} ms`,
  );
  console.log(
    `  long window (${arabicWords(longWindow.prevText).length}+${arabicWords(longWindow.text).length} words): ` +
      `p50 ${quantile(longTimes, 0.5).toFixed(2)} ms, max ${(longTimes[longTimes.length - 1] ?? 0).toFixed(2)} ms`,
  );
  let stressWrong = 0;
  if (stress) {
    const { corpus } = loadCorpus({ textFile: paths.quranTextFile });
    if (corpus !== null) {
      console.log("\nStress test (synthetic, seeded):");
      stressWrong = stressTest(matcher, corpus);
    }
  }
  return precision >= PRECISION_TARGET && stressWrong === 0 ? 0 : 1;
}

process.exit(main());
