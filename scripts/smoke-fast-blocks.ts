// Scenario checks for the fast block pipeline: growing sentence blocks, no rewrites, Quran
// shown once, silent prayer, held prayer-call phrases. Offline, no engines.
// Usage: pnpm exec tsx scripts/smoke-fast-blocks.ts
import pino from "pino";
import { FastBlocks, passThroughFollower } from "../src/compose/fast-blocks.js";
import type { FollowerVerse, PipelineOutput, QuranFollowerApi } from "../src/compose/types.js";
import type { DetectorAction, DetectorSegment, EventDetectorApi } from "../src/events/types.js";
import type { Block, Segment, SessionMode } from "../src/shared/protocol.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  (${detail})` : ""}`);
}

const labels = {
  athan: { ar: "الأذان", title: "Athan", subtitle: "Oproep tot het gebed" },
  iqama: { ar: "الإقامة", title: "Iqama", subtitle: "Het gebed begint" },
  salah: { ar: "الصلاة", title: "Gebed", subtitle: "" },
};

class Clock {
  t = 1_000_000;
  now = (): number => this.t;
}

function seg(id: string, src: string, tr: string, closed = false, startMs = 0, endMs = 0): Segment {
  return {
    id,
    sessionId: "s",
    track: "soniox",
    seq: Number(id.split(":").pop() ?? 0),
    kind: "speech",
    startMs,
    endMs,
    source: { lang: "ar", text: src, finalLen: src.length, final: closed },
    translations: { nl: { text: tr, finalLen: tr.length, final: closed } },
    closed,
    timing: { source: "provider", firstTokenAt: 0 },
  } as Segment;
}

interface Harness {
  fb: FastBlocks;
  out: PipelineOutput[];
  clock: Clock;
  blocks(): Block[];
}

function harness(follower: QuranFollowerApi, detector: EventDetectorApi | null): Harness {
  const clock = new Clock();
  const out: PipelineOutput[] = [];
  const fb = new FastBlocks({
    sessionId: "s",
    targetLang: "nl",
    follower,
    detector,
    labels,
    now: clock.now,
    log: pino({ level: "silent" }),
    emit: (o) => out.push(o),
  });
  return { fb, out, clock, blocks: () => fb.blocks({ limit: 500 }).blocks };
}

/** Every update of a block only appends to its text (the shown prefix never changes). */
function appendOnly(out: PipelineOutput[]): boolean {
  const last = new Map<string, string>();
  for (const o of out) {
    if (o.type !== "block.add" && o.type !== "block.update") continue;
    const prev = last.get(o.block.id);
    if (prev !== undefined && o.block.kind !== "event" && !o.block.text.startsWith(prev)) {
      if (!(o.block.kind === "quran" && o.block.text.startsWith(prev.replace(/"$/, "")))) {
        console.log(`   rewrite: ${JSON.stringify(prev)} → ${JSON.stringify(o.block.text)}`);
        return false;
      }
    }
    last.set(o.block.id, o.block.text);
  }
  return true;
}

// 1. One sentence grows in chunks; the next sentence opens a new block; no rewrites.
{
  const h = harness(passThroughFollower(), null);
  const ar = "إن الحمد لله نحمده ونستعينه ونستغفره ونعوذ بالله من شرور أنفسنا";
  h.fb.update(seg("s:1", ar.split(" ").slice(0, 4).join(" "), "Alle lof is voor Allah,"));
  h.clock.t += 400;
  h.fb.update(
    seg("s:1", ar.split(" ").slice(0, 7).join(" "), "Alle lof is voor Allah, wij prijzen Hem"),
  );
  h.clock.t += 400;
  h.fb.update(seg("s:1", ar, "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.", true));
  h.clock.t += 300;
  h.fb.update(seg("s:2", "ونعوذ بالله", " Wij zoeken toevlucht bij Allah.", true));
  const b = h.blocks();
  check(
    "growing sentence → one block, then a new block for the next sentence",
    b.length === 2,
    `${b.length} blocks`,
  );
  check(
    "first block text complete",
    b[0]?.text === "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.",
    b[0]?.text ?? "",
  );
  check(
    "first block grew via updates (1 add + 2 updates)",
    h.out.filter(
      (o) => (o.type === "block.add" || o.type === "block.update") && o.block.id === b[0]?.id,
    ).length === 3,
  );
  check("append-only (no rewrite of shown text)", appendOnly(h.out));
  h.fb.close();
}

// 2. A short sentence ("Ja.") joins the next one; a long run splits at 45 words; a pause splits.
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(seg("s:1", "نعم", "Ja.", true));
  h.clock.t += 200;
  h.fb.update(
    seg("s:2", "هذا خبر طيب لكم جميعا", " Dat is goed nieuws voor jullie allemaal.", true),
  );
  let b = h.blocks();
  check(
    "short sentence joins the next block",
    b.length === 1 && b[0]?.text === "Ja. Dat is goed nieuws voor jullie allemaal.",
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 2000; // pause
  h.fb.update(seg("s:3", "ثم قال", " Toen zei hij", false));
  b = h.blocks();
  check("a pause ≥ 1.5 s starts a new block", b.length === 2, `${b.length} blocks`);
  const long = Array.from({ length: 60 }, (_, i) => `woord${i}`).join(" ");
  h.fb.update(seg("s:3", "ثم قال كلاما طويلا", ` Toen zei hij ${long}`, true));
  b = h.blocks();
  const maxWords = Math.max(...b.map((x) => x.text.split(/\s+/).length));
  check(
    "a block grows by chunks; a single long chunk is not cut mid-chunk",
    maxWords >= 45,
    `max ${maxWords} words in ${b.length} blocks`,
  );
  h.fb.close();
}

// 3. Quran: an approved ayah is shown once; the live chunks of its words are dropped.
{
  let count = 0;
  let pending: FollowerVerse | null = null;
  const follower: QuranFollowerApi = {
    ready: true,
    push(text) {
      const added = text
        .trim()
        .split(/\s+/)
        .filter((w) => w !== "").length;
      const from = count;
      count += added;
      // Words 4.. of the stream are 3:102 (after a 4-word intro).
      if (pending === null && count >= 9) {
        pending = {
          ref: "3:102",
          from: 4,
          to: Math.max(9, count),
          complete: true,
          approved: "O jullie die geloven, vreest Allah.",
          uthmani: "يَٰٓأَيُّهَا",
          isNew: true,
        };
        return { added, decidedTo: count, verses: [pending] };
      }
      if (pending !== null && from >= 4) {
        return { added, decidedTo: count, verses: [{ ...pending, to: count, isNew: false }] };
      }
      // Words 4..8 are undecided (a possible quote) until confirmed.
      return { added, decidedTo: Math.min(count, 4), verses: [] };
    },
    flush() {
      return { decidedTo: count, verses: [] };
    },
    reset() {
      count = 0;
    },
  };
  const h = harness(follower, null);
  h.fb.update(seg("s:1", "قال الله تعالى في", "Allah de Verhevene zei", false));
  h.fb.update(
    seg("s:1", "قال الله تعالى في يا أيها الذين", "Allah de Verhevene zei: O jullie die", false),
  );
  const shownBefore = h
    .blocks()
    .map((x) => x.text)
    .join(" | ");
  check(
    "intro shown (its spoken honorific as a ligature), verse words held until confirmed",
    shownBefore === "Allah ﷾ zei",
    shownBefore,
  );
  h.fb.update(
    seg(
      "s:1",
      "قال الله تعالى في يا أيها الذين آمنوا اتقوا الله",
      "Allah de Verhevene zei: O jullie die geloven, vrees Allah",
      false,
    ),
  );
  h.fb.update(
    seg(
      "s:1",
      "قال الله تعالى في يا أيها الذين آمنوا اتقوا الله حق تقاته",
      "Allah de Verhevene zei: O jullie die geloven, vrees Allah zoals Hij gevreesd moet worden.",
      true,
    ),
  );
  const b = h.blocks();
  const q = b.filter((x) => x.kind === "quran");
  check(
    "approved ayah shown once with its ref",
    q.length === 1 && q[0]?.ref === "3:102" && (q[0]?.text ?? "").includes("O jullie die geloven"),
    b.map((x) => `${x.kind}:${x.text}`).join(" | "),
  );
  check(
    "no live translation of the verse words (no duplicate)",
    !b.some((x) => x.kind === "speech" && /jullie die geloven|gevreesd/.test(x.text)),
  );
  h.fb.close();
}

// 4. Salah: nothing is shown during the prayer; formula phrases are held, then suppressed.
{
  let salah = false;
  let mode: SessionMode = "speech";
  const detector: EventDetectorApi = {
    get mode() {
      return mode;
    },
    get salah() {
      return salah;
    },
    onSegment(s: DetectorSegment): DetectorAction[] {
      if (/حي على/.test(s.text)) {
        mode = "athan";
        return [
          {
            type: "event-start",
            event: "athan",
            discarded: [s],
            hideFormulaBlocksSinceMs: 0,
            provisional: true,
          },
          { type: "mode", mode: "athan" },
        ];
      }
      if (/^الله أكبر/.test(s.text)) return [{ type: "hold", segment: s }];
      // Like the real detector: during the prayer every segment is suppressed.
      if (salah) return [{ type: "suppress", segment: s }];
      return [{ type: "pass", segment: s }];
    },
    tick: () => [],
    override(event, _now): DetectorAction[] {
      if (event === "salah") {
        salah = true;
        mode = "salah";
        return [
          { type: "event-start", event: "salah", discarded: [], hideFormulaBlocksSinceMs: 0 },
          { type: "mode", mode: "salah" },
        ];
      }
      salah = false;
      mode = "speech";
      return [
        { type: "event-end", event: "salah" },
        { type: "mode", mode: "speech" },
      ];
    },
    isFormulaOnly: (t) => /^(الله أكبر|حي على)/.test(t.trim()),
    markers: () => [],
  };
  const h = harness(passThroughFollower(), detector);
  h.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste", false));
  check("formula-only speech is held (nothing shown)", h.blocks().length === 0);
  h.fb.update(
    seg("s:1", "الله أكبر الله أكبر", "Allah is de grootste, Allah is de grootste", true),
  );
  h.fb.update(seg("s:2", "حي على الصلاة", "Kom naar het gebed", true));
  const afterAthan = h.blocks();
  check(
    "Athan card shown; no translated call phrase",
    afterAthan.length === 1 && afterAthan[0]?.kind === "event",
    afterAthan.map((x) => `${x.kind}:${x.text}`).join(" | "),
  );
  h.fb.overrideEvent("salah");
  h.fb.update(
    seg("s:3", "الحمد لله رب العالمين", "Alle lof zij Allah, de Heer der werelden.", false),
  );
  h.fb.update(
    seg(
      "s:3",
      "الحمد لله رب العالمين الرحمن الرحيم",
      "Alle lof zij Allah, de Heer der werelden. De Erbarmer.",
      true,
    ),
  );
  const inSalah = h.blocks().filter((x) => x.kind !== "event");
  check(
    "nothing translated during the prayer",
    inSalah.length === 0,
    inSalah.map((x) => x.text).join(" | "),
  );
  h.fb.overrideEvent("none");
  h.fb.update(seg("s:4", "أيها الناس", "O mensen,", true));
  check(
    "speech shown again after the prayer",
    h.blocks().some((x) => x.kind === "speech" && x.text.startsWith("O mensen")),
    h
      .blocks()
      .map((x) => `${x.kind}:${x.text}:${x.hidden ?? false}`)
      .join(" | "),
  );
  h.fb.close();
}

// 5. Soniox's "..." at a segment end: the sentence continues in the same block, no ellipsis shown.
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(
    seg(
      "s:1",
      "وأشهد أن لا إله إلا الله وحده لا شريك له وأشهد أن محمدا",
      "En ik getuig dat er geen god is dan Allah, en dat Mohammed...",
      true,
    ),
  );
  h.clock.t += 500;
  h.fb.update(seg("s:2", "عبده ورسوله", "Zijn dienaar en boodschapper is.", true));
  const b = h.blocks();
  check(
    "ellipsis continuation stays in one block",
    b.length === 1 &&
      b[0]?.text ===
        "En ik getuig dat er geen god is dan Allah, en dat Mohammed Zijn dienaar en boodschapper is.",
    b.map((x) => x.text).join(" | "),
  );
  check("append-only with ellipsis", appendOnly(h.out));
  h.fb.close();
}

// 6. An approved ayah recognised during the prayer is never shown.
{
  let count = 0;
  let salah = false;
  const follower: QuranFollowerApi = {
    ready: true,
    push(text) {
      const added = text
        .trim()
        .split(/\s+/)
        .filter((w) => w !== "").length;
      count += added;
      const verses: FollowerVerse[] =
        count >= 4
          ? [
              {
                ref: "1:2",
                from: 0,
                to: count,
                complete: true,
                approved: "Alle lof zij Allah, de Heer der Werelden.",
                uthmani: null,
                isNew: true,
              },
            ]
          : [];
      return { added, decidedTo: count, verses };
    },
    flush: () => ({ decidedTo: count, verses: [] }),
    reset() {
      count = 0;
    },
  };
  const detector: EventDetectorApi = {
    get mode(): SessionMode {
      return salah ? "salah" : "speech";
    },
    get salah() {
      return salah;
    },
    onSegment: (sg: DetectorSegment): DetectorAction[] =>
      salah ? [{ type: "suppress", segment: sg }] : [{ type: "pass", segment: sg }],
    tick: () => [],
    override: (): DetectorAction[] => {
      salah = true;
      return [
        { type: "event-start", event: "salah", discarded: [], hideFormulaBlocksSinceMs: 0 },
        { type: "mode", mode: "salah" },
      ];
    },
    isFormulaOnly: () => false,
    markers: () => [],
  };
  const h = harness(follower, detector);
  h.fb.overrideEvent("salah");
  h.fb.update(
    seg("s:1", "الحمد لله رب العالمين", "Alle lof zij Allah, de Heer der werelden.", false),
  );
  h.fb.update(
    seg("s:1", "الحمد لله رب العالمين", "Alle lof zij Allah, de Heer der werelden.", true),
  );
  h.clock.t += 1000;
  const shown = h.blocks().filter((x) => x.kind !== "event");
  check(
    "no Quran block during the prayer",
    shown.length === 0,
    shown.map((x) => `${x.kind}:${x.text}`).join(" | "),
  );
  h.fb.close();
}

// 7. A tiny sentence (< 4 words) after a closed block joins it instead of taking a block of
//    its own ("Met waarheid." in the bayaan.ai front-page khutbah).
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(
    seg(
      "s:1",
      "الله سبحانه وتعالى خلق السماوات والأرض.",
      "Allah, de Verhevene, schiep de hemelen en de aarde.",
      true,
      400,
      3600,
    ),
  );
  h.clock.t += 900;
  h.fb.update(seg("s:2", "بالحق.", "Met waarheid.", true, 4100, 4200));
  h.clock.t += 1200;
  h.fb.update(
    seg(
      "s:3",
      "وأنزل سبحانه وتعالى الكتاب والميزان",
      "En Hij, de Verhevene, liet het Boek en de Weegschaal neerdalen",
      false,
      5200,
      8000,
    ),
  );
  const b = h.blocks();
  check(
    "a tiny sentence joins the previous block (no 'Met waarheid.' block)",
    b.length === 2 && b[0]?.text === "Allah ﷾ schiep de hemelen en de aarde. Met waarheid.",
    b.map((x) => x.text).join(" | "),
  );
  check(
    "the next sentence opens its own block",
    (b[1]?.text ?? "").startsWith("En Hij ﷾ liet het Boek"),
    b[1]?.text ?? "",
  );
  check("append-only with joined tails", appendOnly(h.out));
  h.fb.close();
}

// 8. A pause closes a block only when it reads as finished: a sentence end, or a clause end
//    once the block is long (≥ 14 words); any block after a long pause.
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(
    seg(
      "s:1",
      "وأنزل سبحانه وتعالى الكتاب والميزان",
      "En Hij, de Verhevene, liet het Boek en de Weegschaal neerdalen",
      true,
    ),
  );
  h.clock.t += 2500; // the khatib breathes mid-sentence
  h.fb.update(seg("s:2", "ليقوم الناس بالقسط،", " opdat de mensen rechtvaardig handelen,", true));
  let b = h.blocks();
  check(
    "a pause mid-clause keeps the block open",
    b.length === 1 &&
      b[0]?.text ===
        "En Hij ﷾ liet het Boek en de Weegschaal neerdalen opdat de mensen rechtvaardig handelen,",
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 2000;
  h.fb.update(
    seg("s:3", "وسمى الله العدل ميزانا،", " En Allah noemde gerechtigheid een maatstaf,", true),
  );
  b = h.blocks();
  check(
    "a pause after a long clause (comma, ≥ 14 words) starts a new block",
    b.length === 2,
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 2200;
  h.fb.update(
    seg(
      "s:4",
      "لأنها آلة العدل والإنصاف.",
      " omdat het een instrument van rechtvaardigheid en eerlijkheid is.",
      true,
    ),
  );
  b = h.blocks();
  check(
    "a pause after a short clause (comma, < 14 words) keeps the block open",
    b.length === 2 &&
      b[1]?.text ===
        "En Allah noemde gerechtigheid een maatstaf, omdat het een instrument van rechtvaardigheid en eerlijkheid is.",
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 600;
  h.fb.update(seg("s:5", "فينبغي على المسلم", " De moslim zou", true));
  h.clock.t += 7000; // a long silence after an unfinished phrase
  h.fb.update(seg("s:6", "أيها الإخوة الكرام", " Beste broeders, luister goed.", true));
  b = h.blocks();
  check(
    "a long pause (≥ 6 s) starts a new block even mid-sentence",
    b.length === 4 && b[3]?.text === "Beste broeders, luister goed.",
    b.map((x) => x.text).join(" | "),
  );
  h.fb.close();
}

// 9. A partial recitation is shown with the approved translation of the
//    recited waqf segments (and their Uthmani text); the block grows with the next segment.
{
  let count = 0;
  let reported = 0;
  const span1 =
    "Voorzeker, Wij hebben Onze Boodschappers met de duidelijke bewijzen gezonden en Wij hebben met hen het Boek en de wetgeving neergezonden, opdat de mens in het midden zou staan (rechtvaardig zou handelen).";
  const span2 = `${span1} En Wij hebben het ijzer neergezonden.`;
  const follower: QuranFollowerApi = {
    ready: true,
    push(text) {
      const added = text
        .trim()
        .split(/\s+/)
        .filter((w) => w !== "").length;
      count += added;
      // Words 3.. of the stream are 57:25 (after "كما بين سبحانه").
      if (reported === 0 && count >= 9) {
        reported = 1;
        const v: FollowerVerse = {
          ref: "57:25",
          from: 3,
          to: count,
          complete: false,
          approved: span1,
          uthmani: "لَقَدْ أَرْسَلْنَا … بِٱلْقِسْطِ",
          partial: true,
          isNew: true,
        };
        return { added, decidedTo: count, verses: [v] };
      }
      if (reported === 1 && count >= 13) {
        reported = 2;
        const v: FollowerVerse = {
          ref: "57:25",
          from: 3,
          to: count,
          complete: false,
          approved: span2,
          uthmani: "لَقَدْ أَرْسَلْنَا … بِٱلْقِسْطِ ۖ وَأَنزَلْنَا ٱلْحَدِيدَ",
          partial: true,
          isNew: false,
        };
        return { added, decidedTo: count, verses: [v] };
      }
      return { added, decidedTo: Math.min(count, reported === 0 ? 3 : count), verses: [] };
    },
    flush() {
      return { decidedTo: reported === 0 ? Math.min(count, 3) : count, verses: [] };
    },
    reset() {
      count = 0;
    },
  };
  const h = harness(follower, null);
  h.fb.update(seg("s:1", "كما بين سبحانه", "Zoals Hij heeft uitgelegd:", true));
  h.fb.update(
    seg(
      "s:2",
      "لقد أرسلنا رسلنا بالبينات وأنزلنا معهم",
      '"Wij hebben onze gezanten met duidelijke bewijzen gezonden, en samen met hen',
      false,
    ),
  );
  let q = h.blocks().filter((x) => x.kind === "quran");
  check(
    "partial ayah → approved span with its ref and Arabic",
    q.length === 1 &&
      q[0]?.ref === "57:25" &&
      q[0]?.text === span1 &&
      (q[0]?.quranText ?? "").startsWith("لَقَدْ"),
    q.map((x) => `${x.ref}:${x.text}`).join(" | "),
  );
  h.fb.update(
    seg(
      "s:2",
      "لقد أرسلنا رسلنا بالبينات وأنزلنا معهم الكتاب والميزان وأنزلنا الحديد",
      '"Wij hebben onze gezanten met duidelijke bewijzen gezonden, en samen met hen het Boek en de Weegschaal. En Wij zonden het ijzer',
      true,
    ),
  );
  const b = h.blocks();
  q = b.filter((x) => x.kind === "quran");
  check(
    "the same block grows with the next recited segment",
    q.length === 1 && q[0]?.text === span2 && (q[0]?.quranText ?? "").includes("ٱلْحَدِيدَ"),
    q.map((x) => `${x.ref}:${x.text}`).join(" | "),
  );
  check(
    "no live translation of the recited words",
    !b.some((x) => x.kind !== "quran" && /gezanten|ijzer/.test(x.text)),
    b.map((x) => `${x.kind}:${x.text}`).join(" | "),
  );
  check("a growing verse block only appends (no quotes to move)", appendOnly(h.out));
  h.fb.close();
}

// 10. A short quote intro ("En Hij ﷾ zei:") joins the previous block; a segment
//     that continues after Soniox's "..." starts in lower case ("En niet als het …").
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(
    seg(
      "s:1",
      "مع من يخالفنا في العقيدة، يا عباد الله.",
      "Zelfs tegenover wie van ons verschilt in geloof, o dienaren van Allah.",
      true,
    ),
  );
  h.clock.t += 1500;
  h.fb.update(
    seg(
      "s:2",
      "انظر إلى قول الله سبحانه وتعالى:",
      "Kijk naar de woorden van Allah, de Verhevene:",
      true,
    ),
  );
  let b = h.blocks();
  check(
    "a short quote intro joins the previous block",
    b.length === 1 &&
      b[0]?.text ===
        "Zelfs tegenover wie van ons verschilt in geloof, o dienaren van Allah. Kijk naar de woorden van Allah ﷾:",
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 3000;
  h.fb.update(seg("s:3", "ولا", "En niet...", true));
  h.clock.t += 500;
  h.fb.update(seg("s:4", "كان ذا قربى.", "Als het om naasten gaat.", true));
  b = h.blocks();
  check(
    "a continuation after '...' is lower case",
    b[b.length - 1]?.text === "En niet als het om naasten gaat.",
    b.map((x) => x.text).join(" | "),
  );
  check("append-only with intro joins", appendOnly(h.out));
  h.fb.close();
}

// 11. Soniox cut the sentence on a word that cannot end an Arabic sentence
//     («على», «هل», «وإن»): its period is held back and the next chunk continues the sentence.
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(seg("s:1", "إذا كان لك دين، على.", "Als je een schuld hebt, aan.", true));
  let b = h.blocks();
  check(
    "the false period after «على» is not shown",
    b.length === 1 && b[0]?.text === "Als je een schuld hebt, aan",
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 1200;
  h.fb.update(seg("s:2", "آخر، أو على آخرين.", "Een ander, of aan anderen.", true));
  b = h.blocks();
  check(
    "the next chunk continues the same sentence in lower case",
    b.length === 1 && b[0]?.text === "Als je een schuld hebt, aan een ander, of aan anderen.",
    b.map((x) => x.text).join(" | "),
  );
  h.clock.t += 600;
  h.fb.update(
    seg(
      "s:3",
      "هذه المسألة في الحقيقة من النوازل، وإن.",
      " Deze kwestie is een nieuw vraagstuk, en.",
      true,
    ),
  );
  h.clock.t += 4000; // the khatib stops: the held period is shown after all
  h.fb.update(seg("s:4", "", "", true));
  (h.fb as unknown as { tick(): void }).tick();
  b = h.blocks();
  check(
    "a held period is shown when nothing continues the sentence",
    b[b.length - 1]?.text === "Deze kwestie is een nieuw vraagstuk, en.",
    b.map((x) => x.text).join(" | "),
  );
  check("append-only with held periods", appendOnly(h.out));
  h.fb.close();
}

// 12. While the khatib is still speaking (Soniox's words not yet final, here for 9 s), an
//     unfinished sentence stays open: no held mark shown, no new block.
{
  const h = harness(passThroughFollower(), null);
  const live = (id: string, src: string): Segment =>
    ({
      ...seg(id, src, "", false),
      source: { lang: "ar", text: src, finalLen: 0, final: false },
      translations: { nl: { text: "", finalLen: 0, final: false } },
    }) as Segment;
  h.fb.update(seg("s:1", "إذا كان لك دين، على.", "Als je een schuld hebt, aan.", true));
  for (let k = 0; k < 9; k++) {
    h.clock.t += 1000;
    h.fb.update(
      live(
        "s:2",
        "آخر، أو على آخرين"
          .split(" ")
          .slice(0, 1 + (k % 4))
          .join(" "),
      ),
    );
    (h.fb as unknown as { tick(): void }).tick();
  }
  h.fb.update(seg("s:2", "آخر، أو على آخرين.", "Een ander, of aan anderen.", true));
  const b = h.blocks();
  check(
    "an unfinished sentence stays open while the khatib is still speaking",
    b.length === 1 && b[0]?.text === "Als je een schuld hebt, aan een ander, of aan anderen.",
    b.map((x) => x.text).join(" | "),
  );
  check("append-only while waiting", appendOnly(h.out));
  h.fb.close();
}

// 13. With whole sentences a block could fill the screen, so from 30 words on it ends at the
//     next clause or sentence mark (the reference captioning's longest block is ≈ 30 words).
{
  const h = harness(passThroughFollower(), null);
  const clause = (k: number) => ` deel ${k} van een lange zin die maar doorgaat,`;
  for (let k = 0; k < 6; k++) {
    h.clock.t += 400;
    h.fb.update(seg(`s:${k + 1}`, "كلام طويل بلا توقف", clause(k), true));
  }
  const b = h.blocks();
  const sizes = b.map((x) => x.text.split(/\s+/).length);
  check(
    "a long block ends at a clause mark once it has ≥ 30 words",
    b.length === 2 && Math.max(...sizes) <= 40,
    sizes.join(" + "),
  );
  h.fb.close();
}

// 14. Reset: the shown blocks are forgotten; the next words start a fresh
//     block (never appended to a block the screens no longer have).
{
  const h = harness(passThroughFollower(), null);
  h.fb.update(seg("s:1", "إن الحمد لله نحمده", "Alle lof is voor Allah, wij prijzen Hem", false));
  const before = h.blocks();
  h.fb.clearHistory();
  const cleared = h.blocks();
  h.clock.t += 300;
  h.fb.update(
    seg(
      "s:1",
      "إن الحمد لله نحمده ونستعينه",
      "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.",
      true,
    ),
  );
  h.clock.t += 300;
  h.fb.update(seg("s:2", "أيها الناس اتقوا الله", " O mensen, vrees Allah.", true));
  const after = h.blocks();
  check(
    "reset: no blocks left, and new words open a new block",
    before.length === 1 &&
      cleared.length === 0 &&
      after.length >= 1 &&
      after.every((b) => b.seq > (before[0]?.seq ?? 0)),
    after.map((b) => `#${b.seq} ${b.text}`).join(" | "),
  );
  h.fb.close();
}

// 15. A prayer event started by hand (portal / control dock) is the session's mode too, also
//     without an event detector: a manual Salah is silent, "none" ends it.
{
  const h = harness(passThroughFollower(), null);
  h.fb.overrideEvent("salah");
  const modeOn = h.fb.mode;
  h.fb.update(seg("s:1", "الله أكبر", "Allah is de grootste.", true));
  const shownInPrayer = h.blocks().filter((b) => b.kind !== "event");
  h.fb.overrideEvent("none");
  const card = h.blocks().find((b) => b.kind === "event");
  check(
    "manual Salah without a detector: mode salah, nothing shown, 'none' ends it",
    modeOn === "salah" &&
      shownInPrayer.length === 0 &&
      h.fb.mode === "speech" &&
      card?.event?.type === "salah" &&
      card.event.active === false,
    `${modeOn} → ${h.fb.mode}; shown ${shownInPrayer.length}`,
  );
  h.fb.close();
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
