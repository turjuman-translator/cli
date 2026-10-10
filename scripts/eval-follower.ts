// Quran follower evaluation.
//
//   pnpm exec tsx scripts/eval-follower.ts                          # synthetic sessions + fixtures
//   pnpm exec tsx scripts/eval-follower.ts --session <segments.jsonl> [--session …]
//   … --hold-ms 4500 --complete-wait 10                             # follower options
//
// Words are streamed the way fast-blocks feeds them: per segment, deltas of 1–6 words (the first
// without a leading space), flush() every 250 ms (the pipeline's ticker) and at every segment end.
// Speech arrives at 400 ms/word, recitation at 550 ms/word; segments are 1.2 s apart.
//  1. Sessions: synthetic replicas of two recorded sessions, 22:02 and 22:06 (paraphrase of 57:25,
//     then 57:25 recited over two segments; 5:8 over two segments; 16:90; a repeat within 2
//     minutes), or real ones with --session (source.text of every line, in order). Prints the
//     word stream with its dispositions and every verse report; flags duplicate emissions.
//  2. The 94 Quran fixtures (test/fixtures/quran) fed incrementally in random chunks: the refs
//     must equal the batch matcher's on the same text (precision vs fixture truth ≥ 0.98).
//  3. Hold statistics (time and words a word waits before it is decided; max undecided span).
//  4. A khutbah without Quran: share of words held beyond the look-ahead, mean hold.
// Exit code 1 on a duplicate emission or precision < 0.98.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FollowerVerse, QuranFollowerApi } from "../src/compose/types.js";
import { loadConfig } from "../src/config.js";
import { createQuranFollower, type FollowerOptions } from "../src/quran/follower.js";
import { loadQuranMatcher, parseRef, type QuranMatcher } from "../src/quran/matcher.js";
import { arabicWords } from "../src/text/arabic.js";

interface Seg {
  text: string;
  /** Recitation (slower delivery). */
  recite?: boolean;
}

interface WordLog {
  word: string;
  arrived: number;
  /** Stream length after the push that brought this word. */
  nAtArrival: number;
  decidedAt: number | null;
  /** Words that arrived after this one before it was decided. */
  heldWords: number;
  verse: string | null;
}

interface RunResult {
  words: WordLog[];
  reports: Array<FollowerVerse & { at: number }>;
  pushMs: number[];
  maxUndecided: number;
  segEnds: number[];
}

const TICK = 250;
const PAUSE = 1200;
let seed = 20261003;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/** Stream segments into a follower like fast-blocks does and log every decision. */
function simulate(follower: QuranFollowerApi, segs: readonly Seg[], start = 0): RunResult {
  const words: WordLog[] = [];
  const reports: RunResult["reports"] = [];
  const pushMs: number[] = [];
  const segEnds: number[] = [];
  let t = start;
  let decided = 0;
  let maxUndecided = 0;
  let nextTick = t + TICK;
  const apply = (res: { decidedTo: number; verses: FollowerVerse[] }, at: number): void => {
    for (const v of res.verses) {
      reports.push({ ...v, at });
      for (let j = v.from; j < v.to; j++) {
        const w = words[j];
        if (w !== undefined) w.verse = v.ref;
      }
    }
    for (let j = decided; j < res.decidedTo && j < words.length; j++) {
      const w = words[j];
      if (w !== undefined && w.decidedAt === null) {
        w.decidedAt = at;
        w.heldWords = words.length - w.nAtArrival;
      }
    }
    decided = Math.max(decided, res.decidedTo);
    maxUndecided = Math.max(maxUndecided, words.length - decided);
  };
  const tickUntil = (until: number): void => {
    while (nextTick <= until) {
      apply(follower.flush(nextTick), nextTick);
      nextTick += TICK;
    }
  };
  for (const seg of segs) {
    const ws = seg.text.split(/\s+/).filter((w) => w !== "");
    const perWord = seg.recite === true ? 550 : 400;
    let i = 0;
    let first = true;
    while (i < ws.length) {
      const k = Math.min(ws.length - i, 1 + Math.floor(rnd() * 6));
      const chunk = ws.slice(i, i + k).join(" ");
      i += k;
      t += k * perWord;
      tickUntil(t);
      const delta = first ? chunk : ` ${chunk}`;
      first = false;
      const added = arabicWords(delta);
      const nAfter = words.length + added.length;
      for (const w of added) {
        words.push({
          word: w,
          arrived: t,
          nAtArrival: nAfter,
          decidedAt: null,
          heldWords: 0,
          verse: null,
        });
      }
      const s = performance.now();
      const res = follower.push(delta, t);
      pushMs.push(performance.now() - s);
      if (res.added !== arabicWords(delta).length) throw new Error("added ≠ arabicWords count");
      apply(res, t);
    }
    apply(follower.flush(t), t); // segment closed
    segEnds.push(words.length);
    t += PAUSE;
    tickUntil(t);
  }
  tickUntil(t + 8000); // the pipeline keeps ticking after the last words
  apply(follower.flush(t + 60_000), t + 60_000); // drain
  return { words, reports, pushMs, maxUndecided, segEnds };
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0);
}

function ayat(ref: string): string[] {
  const p = parseRef(ref);
  if (p === null) return [];
  const out: string[] = [];
  for (let a = p.from; a <= p.to; a++) out.push(`${p.sura}:${a}`);
  return out;
}

/** Duplicate emissions: the same ayah reported as new twice within 2 minutes. */
function duplicates(r: RunResult): string[] {
  const last = new Map<string, number>();
  const out: string[] = [];
  for (const v of r.reports) {
    if (!v.isNew) continue;
    const prev = last.get(v.ref);
    if (prev !== undefined && v.at - prev < 120_000) out.push(`${v.ref} emitted twice`);
    last.set(v.ref, v.at);
  }
  return out;
}

function printRun(name: string, r: RunResult): void {
  console.log(`\n== ${name}`);
  let seg = 0;
  let line: string[] = [];
  let open: string | null = null;
  const flushLine = (): void => {
    if (open !== null) line.push("]");
    open = null;
    if (line.length > 0) console.log(`  seg ${seg}: ${line.join(" ").replace(/ \]/g, "]")}`);
    line = [];
  };
  r.words.forEach((w, j) => {
    while (j >= (r.segEnds[seg] ?? Number.POSITIVE_INFINITY)) {
      flushLine();
      seg++;
    }
    if (w.verse !== open) {
      if (open !== null) line.push("]");
      if (w.verse !== null) line.push(`[${w.verse}:`);
      open = w.verse;
    }
    line.push(w.word);
  });
  flushLine();
  for (const v of r.reports) {
    console.log(
      `  verse ${v.ref.padEnd(7)} words ${v.from}–${v.to} ${v.isNew ? "NEW " : "ext "}` +
        `${v.complete ? "complete" : "partial "} approved=${v.approved === null ? "null" : "yes"}`,
    );
  }
  const dups = duplicates(r);
  if (dups.length > 0) console.log(`  ✗ DUPLICATE: ${dups.join(", ")}`);
}

function holdStats(label: string, runs: RunResult[]): void {
  const all = runs.flatMap((r) => r.words);
  const ms = all.map((w) => (w.decidedAt ?? w.arrived) - w.arrived);
  const held = all.filter((w) => (w.decidedAt ?? w.arrived) > w.arrived);
  const long = all.filter((w) => (w.decidedAt ?? w.arrived) - w.arrived > 1000);
  console.log(
    `  ${label.padEnd(22)} words ${String(all.length).padStart(5)} | held ${pctOf(held.length, all.length)}` +
      `, > 1 s ${pctOf(long.length, all.length)} | hold ms mean ${mean(ms).toFixed(0)}` +
      ` p95 ${quantile(ms, 0.95).toFixed(0)} max ${Math.max(0, ...ms).toFixed(0)}` +
      ` | hold words mean ${mean(all.map((w) => w.heldWords)).toFixed(2)} max ${Math.max(0, ...all.map((w) => w.heldWords))}` +
      ` | max undecided span ${Math.max(0, ...runs.map((r) => r.maxUndecided))}`,
  );
}

function mean(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

function pctOf(a: number, b: number): string {
  return `${b === 0 ? "0.0" : ((100 * a) / b).toFixed(1)}%`;
}

// --- synthetic replicas of the reported sessions -------------------------------------------------

const SESSION_A: Seg[] = [
  {
    text: "أيها المسلمون إن الله عز وجل أرسل رسله بالحق وأنزل سبحانه وتعالى الكتاب والميزان ليقوم الناس بالقسط",
  },
  {
    text: "فالعدل أساس الملك يا عباد الله قال تعالى لقد أرسلنا رسلنا بالبينات وأنزلنا معهم الكتاب والميزان ليقوم الناس بالقسط",
    recite: true,
  },
  {
    text: "وأنزلنا الحديد فيه بأس شديد ومنافع للناس وليعلم الله من ينصره ورسله بالغيب إن الله قوي عزيز",
    recite: true,
  },
  { text: "فانظروا رحمكم الله كيف قرن الله بين الكتاب والحديد وبين العلم والقوة" },
];

const SESSION_B: Seg[] = [
  {
    text: "عباد الله إن العدل واجب على كل مسلم يقول الله تعالى يا أيها الذين آمنوا كونوا قوامين لله شهداء بالقسط",
    recite: true,
  },
  {
    text: "ولا يجرمنكم شنآن قوم على ألا تعدلوا اعدلوا هو أقرب للتقوى واتقوا الله إن الله خبير بما تعملون",
    recite: true,
  },
  { text: "فالعدل يا إخوة الإيمان مطلوب حتى مع من نكره ومع من يخالفنا" },
  {
    text: "إن الله يأمر بالعدل والإحسان وإيتاء ذي القربى وينهى عن الفحشاء والمنكر والبغي يعظكم لعلكم تذكرون",
    recite: true,
  },
  { text: "وكما سمعتم يا أيها الذين آمنوا كونوا قوامين لله شهداء بالقسط", recite: true },
  { text: "أقول قولي هذا وأستغفر الله لي ولكم" },
];

/**
 * The bayaan.ai front-page khutbah as Soniox transcribed it: the recognizer lost
 * "والميزان ليقوم الناس" in 57:25 and put the last recited word in the next segment.
 */
const SESSION_C: Seg[] = [
  { text: "الله سبحانه وتعالى خلق السماوات والأرض." },
  { text: "بالحق." },
  {
    text: 'وأنزل سبحانه وتعالى الكتاب والميزان ليقوم الناس بالقسط، كما بين سبحانه وتعالى: "لقد أرسلنا رسلنا بالبينات، وأنزلنا معهم الكتاب وال.',
    recite: true,
  },
  { text: 'بالقسط". وسمى الله سبحانه وتعالى العدل ميزانًا، لأنها آلة العدل والإنصاف.' },
  { text: "فينبغي على المسلم أن يستحضر هذا المعنى، ولذلك من عظمة الإسلام أنه أمر بالعدل حتى." },
  {
    text: 'مع من يخالفنا في العقيدة، يا عباد الله. انظر إلى قول الله سبحانه وتعالى: "ولا يجرمنكم شنآن قوم على.',
    recite: true,
  },
  {
    text: 'ألا تعدلوا". اعدلوا هو أقرب للتقوى. والله سبحانه وتعالى أمرنا بالعدل حتى.',
    recite: true,
  },
];

/** Expected refs, the words that must stay plain and (optionally) words that must be in a verse. */
const EXPECT: Record<string, { refs: string[]; plain: string[]; verse?: string[] }> = {
  "session A (22:02-like)": {
    refs: ["57:25"],
    plain: ["وانزل سبحانه وتعالي الكتاب والميزان ليقوم الناس بالقسط", "فانظروا رحمكم الله"],
  },
  "session B (22:06-like)": {
    refs: ["5:8", "16:90"],
    plain: ["فالعدل يا اخوه الايمان مطلوب", "اقول قولي هذا"],
  },
  "session C (bayaan.ai front page)": {
    refs: ["57:25", "5:8"],
    plain: [
      "الله سبحانه وتعالي خلق السماوات والارض",
      "وسمي الله سبحانه وتعالي العدل",
      "يا عباد الله",
      "والله سبحانه وتعالي امرنا بالعدل",
    ],
    verse: ["بالقسط وسمي"],
  },
};

const NO_QURAN: Seg[] = [
  "الحمد لله رب العالمين والصلاة والسلام على أشرف الأنبياء والمرسلين نبينا محمد وعلى آله وصحبه أجمعين",
  "أما بعد فيا عباد الله أوصيكم ونفسي بتقوى الله فإنها وصية الله للأولين والآخرين",
  "أيها المسلمون إن الأيام تمضي سريعا والأعمار تنقضي ونحن في غفلة عن الآخرة",
  "فكم من حبيب فارقناه وكم من عزيز دفناه وما زلنا نلهو ونلعب",
  "واعلموا رحمكم الله أن بر الوالدين من أعظم القربات وأحبها إلى الله",
  "فالأم تعبت وسهرت والأب كد واجتهد من أجل أن يعيش أبناؤه في خير",
  "فلا تنسوا فضلهم عليكم وأحسنوا إليهم في حياتهم وبعد مماتهم بالدعاء والصدقة",
  "وإن من علامات قبول العمل أن يتبعه الإنسان بعمل صالح آخر",
  "فاحرصوا يا عباد الله على الصلاة في وقتها مع الجماعة في المسجد",
  "وتذكروا أن الصدقة تطفئ غضب الرب وتدفع ميتة السوء",
  "عباد الله إن الله أمر بالعدل والإحسان فاعدلوا بين أولادكم كما تحبون أن يبروكم",
  "واعلموا أن الله على كل شيء قدير وأنه سبحانه يعلم السر وأخفى",
  "قال رسول الله صلى الله عليه وسلم إنما الأعمال بالنيات وإنما لكل امرئ ما نوى",
  "اللهم اغفر لنا ولوالدينا ولجميع المسلمين واجعل هذا البلد آمنا مطمئنا",
  "اللهم أصلح أحوال المسلمين في كل مكان واجمع كلمتهم على الحق",
  "أقول قولي هذا وأستغفر الله لي ولكم فاستغفروه إنه هو الغفور الرحيم",
].map((text) => ({ text }));

// --- fixtures -------------------------------------------------------------------------------------

interface Case {
  id: string;
  segment: string;
  prevText?: string;
  ignoreStoplist?: boolean;
  expected: string[];
  acceptable?: string[];
}

function fixtureEval(
  matcher: QuranMatcher,
  base: FollowerOptions,
): { precision: number; runs: RunResult[] } {
  const dir = join(process.cwd(), "test", "fixtures", "quran");
  const cases: Case[] = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Case[]);
  let agree = 0;
  let followerOnly = 0;
  let batchOnly = 0;
  let wrong = 0;
  let total = 0;
  const runs: RunResult[] = [];
  const issues: string[] = [];
  for (const c of cases) {
    const opts = { targetLang: "nl", ignoreStoplist: c.ignoreStoplist ?? false };
    const full = c.prevText === undefined ? c.segment : `${c.prevText} ${c.segment}`;
    const batch = new Set(matcher.match({ text: full }, opts).flatMap((m) => ayat(m.ref)));
    const prevTruth =
      c.prevText === undefined
        ? []
        : matcher.match({ text: c.prevText }, opts).flatMap((m) => ayat(m.ref));
    const truth = new Set([...c.expected, ...(c.acceptable ?? [])].flatMap(ayat).concat(prevTruth));
    for (const a of batch) truth.add(a); // the batch matcher is 100 % precise on these fixtures
    const follower = createQuranFollower(matcher, { ...base, ignoreStoplist: opts.ignoreStoplist });
    const segs: Seg[] =
      c.prevText === undefined
        ? [{ text: c.segment }]
        : [{ text: c.prevText }, { text: c.segment }];
    const r = simulate(follower, segs);
    runs.push(r);
    const got = new Set(r.reports.map((v) => v.ref));
    for (const a of got) {
      total++;
      if (batch.has(a)) agree++;
      else followerOnly++;
      const ok =
        truth.has(a) || [...c.expected, ...(c.acceptable ?? [])].some((e) => ayat(e).includes(a));
      if (!ok) {
        wrong++;
        issues.push(`  ✗ ${c.id}: WRONG ${a}`);
      }
    }
    for (const a of batch) {
      if (!got.has(a)) {
        batchOnly++;
        issues.push(`  · ${c.id}: batch has ${a}, follower not`);
      }
    }
    const dups = duplicates(r);
    if (dups.length > 0) issues.push(`  ✗ ${c.id}: ${dups.join(", ")}`);
  }
  const precision = total === 0 ? 1 : (total - wrong) / total;
  const recall = agree + batchOnly === 0 ? 1 : agree / (agree + batchOnly);
  console.log(`\n== Fixtures fed incrementally (${cases.length} cases, random 1–6 word chunks)`);
  for (const i of issues) console.log(i);
  console.log(
    `  ayah refs: follower ${total}, same as batch ${agree}, follower-only ${followerOnly}, batch-only ${batchOnly}`,
  );
  console.log(
    `  precision vs truth ${(precision * 100).toFixed(1)}% (wrong ${wrong}), recall vs batch ${(recall * 100).toFixed(1)}%`,
  );
  return { precision, runs };
}

function sessionsFromArgs(): Array<{ name: string; segs: Seg[] }> {
  const out: Array<{ name: string; segs: Seg[] }> = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--session") continue;
    const file = argv[++i];
    if (file === undefined) continue;
    const segs: Seg[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const o = JSON.parse(line) as { source?: { text?: string } };
        const text = o.source?.text ?? "";
        if (text.trim() !== "") segs.push({ text });
      } catch {
        // not a segment line
      }
    }
    out.push({ name: file, segs });
  }
  return out;
}

function main(): number {
  const { config, paths } = loadConfig();
  const matcher = loadQuranMatcher(paths, { ...config.quran, enabled: true });
  if (!matcher.ready) {
    console.error(
      "Quran data missing: run pnpm exec tsx scripts/quran-data.ts, or set DATA_DIR to a directory with quran/",
    );
    return 1;
  }
  const base: FollowerOptions = { targetLang: "nl" };
  const argv = process.argv.slice(2);
  const holdMs = argv.indexOf("--hold-ms");
  if (holdMs >= 0) base.maxHoldMs = Number(argv[holdMs + 1]);
  const wait = argv.indexOf("--complete-wait");
  if (wait >= 0) base.completeWaitWords = Number(argv[wait + 1]);
  let failed = false;
  const sessionRuns: RunResult[] = [];

  const real = sessionsFromArgs();
  const sessions =
    real.length > 0
      ? real
      : [
          { name: "session A (22:02-like)", segs: SESSION_A },
          { name: "session B (22:06-like)", segs: SESSION_B },
          { name: "session C (bayaan.ai front page)", segs: SESSION_C },
        ];
  for (const s of sessions) {
    const r = simulate(createQuranFollower(matcher, base), s.segs);
    sessionRuns.push(r);
    printRun(s.name, r);
    if (duplicates(r).length > 0) failed = true;
    const exp = EXPECT[s.name];
    if (exp !== undefined) {
      const refs = [...new Set(r.reports.filter((v) => v.isNew).map((v) => v.ref))];
      const missing = exp.refs.filter((x) => !refs.includes(x));
      const extra = refs.filter((x) => !exp.refs.includes(x));
      const stream = r.words.map((w) => w.word);
      const plainBad = exp.plain.filter((p) => {
        const ws = p.split(" ");
        for (let i = 0; i + ws.length <= stream.length; i++) {
          if (ws.every((w, k) => stream[i + k] === w)) {
            return ws.some((_, k) => r.words[i + k]?.verse !== null);
          }
        }
        return true; // phrase not found = check failed
      });
      // "a b": the first word must be in a verse, the second (context) must exist after it.
      const verseBad = (exp.verse ?? []).filter((p) => {
        const ws = p.split(" ");
        for (let i = 0; i + ws.length <= stream.length; i++) {
          if (ws.every((w, k) => stream[i + k] === w)) return r.words[i]?.verse === null;
        }
        return true;
      });
      const ok =
        missing.length === 0 &&
        extra.length === 0 &&
        plainBad.length === 0 &&
        verseBad.length === 0;
      if (!ok) failed = true;
      console.log(
        `  ${ok ? "✓" : "✗"} expected ${exp.refs.join(", ")}; new refs ${refs.join(", ") || "none"}` +
          `${plainBad.length > 0 ? `; NOT plain: ${plainBad.join(" | ")}` : "; khatib's own words plain"}` +
          `${verseBad.length > 0 ? `; NOT in a verse: ${verseBad.join(" | ")}` : ""}`,
      );
    }
  }

  const fx = fixtureEval(matcher, base);
  if (fx.precision < 0.98) failed = true;

  const noQuran = simulate(createQuranFollower(matcher, base), NO_QURAN);
  console.log(`\n== Khutbah without Quran: ${noQuran.reports.length} verse reports (must be 0)`);
  for (const v of noQuran.reports) console.log(`  ✗ ${v.ref} words ${v.from}–${v.to}`);
  if (noQuran.reports.length > 0) failed = true;
  const longHolds = noQuran.words
    .map((w, j) => ({ w, j }))
    .filter(({ w }) => (w.decidedAt ?? w.arrived) - w.arrived > 1000);
  console.log(
    `  held > 1 s: ${longHolds.map(({ w, j }) => `${j}:${w.word}(${(w.decidedAt ?? 0) - w.arrived}ms)`).join(" ") || "none"}`,
  );

  console.log("\n== Hold statistics (word arrival → decided)");
  holdStats("sessions", sessionRuns);
  holdStats("fixtures", fx.runs);
  holdStats("khutbah without Quran", [noQuran]);

  const pushMs = [...sessionRuns, ...fx.runs, noQuran].flatMap((r) => r.pushMs);
  console.log(
    `\n== push() latency: mean ${mean(pushMs).toFixed(2)} ms, p95 ${quantile(pushMs, 0.95).toFixed(2)} ms,` +
      ` max ${Math.max(...pushMs).toFixed(2)} ms (${pushMs.length} calls, matcher window 64 words)`,
  );
  console.log(failed ? "\nFAILED" : "\nOK");
  return failed ? 1 : 0;
}

process.exit(main());
