// FastBlocks: Soniox segment updates become growing sentence blocks. Speech only here: no Quran,
// no prayer events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FastBlocks, passThroughFollower } from "../../src/compose/fast-blocks.js";
import type { PipelineOutput } from "../../src/compose/types.js";
import {
  appendOnly,
  captureLog,
  LABELS,
  type Pipeline,
  pipeline,
  scriptedFollower,
  seg,
} from "./helpers/compose-fast-blocks.js";

const T0 = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const words = (n: number, prefix = "woord"): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("FastBlocks: one sentence, one growing block", () => {
  it("grows a block as the sentence comes in, and opens a new one for the next sentence", () => {
    const p = pipeline();
    const ar = "إن الحمد لله نحمده ونستعينه ونستغفره ونعوذ بالله من شرور أنفسنا";
    const first = ar.split(" ").slice(0, 4).join(" ");
    const more = ar.split(" ").slice(0, 7).join(" ");
    p.fb.update(seg("s:1", first, "Alle lof is voor Allah,", { startMs: 100, endMs: 900 }));
    vi.advanceTimersByTime(400);
    p.fb.update(
      seg("s:1", more, "Alle lof is voor Allah, wij prijzen Hem", { startMs: 100, endMs: 1800 }),
    );
    vi.advanceTimersByTime(400);
    p.fb.update(
      seg("s:1", ar, "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.", {
        closed: true,
        startMs: 100,
        endMs: 3000,
      }),
    );
    vi.advanceTimersByTime(300);
    p.fb.update(
      seg("s:2", "ونعوذ بالله", " Wij zoeken toevlucht bij Allah.", {
        closed: true,
        startMs: 3200,
        endMs: 4000,
      }),
    );
    const [b0, b1] = p.blocks();
    expect(p.blocks()).toHaveLength(2);
    expect(b0).toMatchObject({
      id: "s:b1",
      seq: 1,
      kind: "speech",
      text: "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.",
      ref: null,
      src: ar,
      lang: "nl",
      segmentIds: ["s:1"],
      createdAt: T0,
      startMs: 100,
      endMs: 3000,
    });
    expect(b1).toMatchObject({
      id: "s:b2",
      text: "Wij zoeken toevlucht bij Allah.",
      src: "ونعوذ بالله",
      segmentIds: ["s:2"],
      createdAt: T0 + 1100,
      startMs: 3200,
      endMs: 4000,
    });
    expect(p.history("s:b1").map((o) => o.type)).toEqual([
      "block.add",
      "block.update",
      "block.update",
    ]);
    expect(appendOnly(p.out)).toBe(true);
    // blocks.jsonl gets the whole block on every add and update.
    expect(p.persisted.map((b) => b.id)).toEqual(["s:b1", "s:b1", "s:b1", "s:b2"]);
    expect(p.persisted.at(-2)).toEqual(b0);
    p.fb.close();
  });

  it('keeps a short sentence with the next one ("Ja." is not a block)', () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "نعم", "Ja.", { closed: true }));
    vi.advanceTimersByTime(200);
    p.fb.update(
      seg("s:2", "هذا خبر طيب لكم جميعا", " Dat is goed nieuws voor jullie allemaal.", {
        closed: true,
      }),
    );
    expect(p.shown()).toEqual(["Ja. Dat is goed nieuws voor jullie allemaal."]);
    expect(p.blocks()[0]?.segmentIds).toEqual(["s:1", "s:2"]);
  });

  it("ends a block at a sentence end inside a chunk, and starts the next from the rest", () => {
    const p = pipeline();
    p.fb.update(
      seg(
        "s:1",
        "هذه هي الجملة الأولى اليوم وهنا تبدأ الثانية",
        "Dit is de eerste zin van vandaag. En hier begint de tweede",
        {
          closed: true,
        },
      ),
    );
    expect(p.shown()).toEqual(["Dit is de eerste zin van vandaag.", "En hier begint de tweede"]);
    // A short sentence inside a chunk stays with what follows it.
    p.fb.clearHistory();
    p.fb.update(
      seg("s:2", "نعم بالتأكيد ثم يستمر", "Ja zeker. En dan gaat het verder", { closed: true }),
    );
    expect(p.shown()).toEqual(["Ja zeker. En dan gaat het verder"]);
  });

  it("starts a new block before it would grow beyond 45 words", () => {
    const p = pipeline();
    for (let k = 0; k < 5; k++) {
      p.fb.update(seg(`s:${k + 1}`, "كلام طويل", ` ${words(10, `w${k}-`)}`, { closed: true }));
      vi.advanceTimersByTime(100);
    }
    const sizes = p.shown().map((t) => t.split(" ").length);
    expect(sizes).toEqual([40, 10]);
  });

  it("ends a long block (30+ words) at its next clause mark", () => {
    const p = pipeline();
    for (let k = 0; k < 6; k++) {
      vi.advanceTimersByTime(400);
      p.fb.update(
        seg(`s:${k + 1}`, "كلام طويل بلا توقف", ` deel ${k} van een lange zin die maar doorgaat,`, {
          closed: true,
        }),
      );
    }
    expect(p.shown().map((t) => t.split(" ").length)).toEqual([36, 18]);
  });

  it("does not split a long block at a clause mark while a sentence mark is held back", () => {
    const p = pipeline();
    // 32 words ending in a comma, with a period held back (the Arabic stopped mid-sentence):
    // the sentence goes on, so the clause mark does not end the block.
    p.fb.update(seg("s:1", "كلام", ` ${words(29)},`, { closed: true }));
    p.fb.update(seg("s:2", "إذا كان لك دين، على.", " en een schuld,.", { closed: true }));
    p.fb.update(seg("s:3", "آخر.", " Aan een ander.", { closed: true }));
    expect(p.shown()).toEqual([`${words(29)}, en een schuld, aan een ander.`]);
  });
});

describe("FastBlocks: pauses", () => {
  it("closes a block at a pause only when it reads as finished", () => {
    const p = pipeline();
    p.fb.update(
      seg(
        "s:1",
        "وأنزل سبحانه وتعالى الكتاب والميزان",
        "En Hij, de Verhevene, liet het Boek en de Weegschaal neerdalen",
        {
          closed: true,
        },
      ),
    );
    vi.advanceTimersByTime(2500); // a breath mid-sentence
    p.fb.update(
      seg("s:2", "ليقوم الناس بالقسط،", " opdat de mensen rechtvaardig handelen,", {
        closed: true,
      }),
    );
    expect(p.shown()).toEqual([
      "En Hij ﷾ liet het Boek en de Weegschaal neerdalen opdat de mensen rechtvaardig handelen,",
    ]);
    vi.advanceTimersByTime(2000); // a pause after a long clause (≥ 14 words)
    p.fb.update(
      seg("s:3", "وسمى الله العدل ميزانا،", " En Allah noemde gerechtigheid een maatstaf,", {
        closed: true,
      }),
    );
    expect(p.blocks()).toHaveLength(2);
    vi.advanceTimersByTime(2200); // a pause after a short clause: still open
    p.fb.update(
      seg(
        "s:4",
        "لأنها آلة العدل والإنصاف.",
        " omdat het een instrument van rechtvaardigheid en eerlijkheid is.",
        {
          closed: true,
        },
      ),
    );
    expect(p.shown()[1]).toBe(
      "En Allah noemde gerechtigheid een maatstaf, omdat het een instrument van rechtvaardigheid en eerlijkheid is.",
    );
    vi.advanceTimersByTime(600);
    p.fb.update(seg("s:5", "فينبغي على المسلم", " De moslim zou", { closed: true }));
    expect(p.blocks()).toHaveLength(3); // after a finished sentence, a new block
    vi.advanceTimersByTime(7000); // a long silence ends even an unfinished block
    p.fb.update(
      seg("s:6", "أيها الإخوة الكرام", " Beste broeders, luister goed.", { closed: true }),
    );
    expect(p.shown()).toHaveLength(4);
    expect(p.shown()[3]).toBe("Beste broeders, luister goed.");
    expect(appendOnly(p.out)).toBe(true);
  });

  it("keeps an unfinished sentence open while the khatib is still speaking", () => {
    const p = pipeline();
    p.fb.update(
      seg("s:1", "إذا كان لك دين، على.", "Als je een schuld hebt, aan.", { closed: true }),
    );
    const live = ["آخر،", "آخر، أو", "آخر، أو على", "آخر، أو على آخرين"];
    for (let k = 0; k < 9; k++) {
      vi.advanceTimersByTime(1000);
      // Soniox's words are not final yet: speech, but no text.
      p.fb.update(seg("s:2", live[k % 4] ?? "", "", { srcFinal: 0 }));
    }
    p.fb.update(seg("s:2", "آخر، أو على آخرين.", "Een ander, of aan anderen.", { closed: true }));
    expect(p.shown()).toEqual(["Als je een schuld hebt, aan een ander, of aan anderen."]);
    expect(appendOnly(p.out)).toBe(true);
  });
});

describe("FastBlocks: joining pieces", () => {
  it('joins a tiny sentence to the previous block ("Met waarheid.")', () => {
    const p = pipeline();
    p.fb.update(
      seg(
        "s:1",
        "الله سبحانه وتعالى خلق السماوات والأرض.",
        "Allah, de Verhevene, schiep de hemelen en de aarde.",
        {
          closed: true,
        },
      ),
    );
    vi.advanceTimersByTime(900);
    p.fb.update(seg("s:2", "بالحق.", "Met waarheid.", { closed: true }));
    vi.advanceTimersByTime(1200);
    p.fb.update(
      seg(
        "s:3",
        "وأنزل سبحانه وتعالى الكتاب والميزان",
        "En Hij, de Verhevene, liet het Boek en de Weegschaal neerdalen",
        {
          closed: true,
        },
      ),
    );
    expect(p.shown()).toEqual([
      "Allah ﷾ schiep de hemelen en de aarde. Met waarheid.",
      "En Hij ﷾ liet het Boek en de Weegschaal neerdalen",
    ]);
    expect(appendOnly(p.out)).toBe(true);
  });

  it("joins a short quote intro to the previous block", () => {
    const p = pipeline();
    p.fb.update(
      seg(
        "s:1",
        "مع من يخالفنا في العقيدة، يا عباد الله.",
        "Zelfs tegenover wie van ons verschilt in geloof, o dienaren van Allah.",
        {
          closed: true,
        },
      ),
    );
    vi.advanceTimersByTime(1500);
    p.fb.update(
      seg(
        "s:2",
        "انظر إلى قول الله سبحانه وتعالى:",
        "Kijk naar de woorden van Allah, de Verhevene:",
        {
          closed: true,
        },
      ),
    );
    expect(p.shown()).toEqual([
      "Zelfs tegenover wie van ons verschilt in geloof, o dienaren van Allah. Kijk naar de woorden van Allah ﷾:",
    ]);
  });

  it("does not join a tiny sentence to an old, full or not-newest block", () => {
    // Old: more than 10 s after the previous block.
    const old = pipeline();
    old.fb.update(
      seg("s:1", "كلام", "Dit is een volledige zin van acht woorden.", { closed: true }),
    );
    vi.advanceTimersByTime(13_000);
    old.fb.update(seg("s:2", "بالحق.", "Met waarheid.", { closed: true }));
    expect(old.shown()).toEqual(["Dit is een volledige zin van acht woorden.", "Met waarheid."]);
    // Full: the joined block would pass 45 words.
    const full = pipeline();
    full.fb.update(seg("s:1", "كلام", `${words(43)}.`, { closed: true }));
    full.fb.update(seg("s:2", "بالحق.", "Met de waarheid.", { closed: true }));
    expect(full.shown()).toHaveLength(2);
    // Not the newest: an event card came after it.
    const card = pipeline();
    card.fb.update(
      seg("s:1", "كلام", "Dit is een volledige zin van acht woorden.", { closed: true }),
    );
    card.fb.overrideEvent("athan");
    card.fb.overrideEvent("none");
    card.fb.update(seg("s:2", "بالحق.", "Met waarheid.", { closed: true }));
    expect(card.shown()).toEqual(["Dit is een volledige zin van acht woorden.", "Met waarheid."]);
  });

  it("opens a fresh block when the previous piece showed nothing", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "كلام", "...", { closed: true }));
    expect(p.blocks()).toEqual([]);
    vi.advanceTimersByTime(7000); // the empty block is closed after a long silence
    p.fb.update(seg("s:2", "نعم", "Ja.", { closed: true }));
    expect(p.shown()).toEqual(["Ja."]);
  });

  it("keeps words of two segments apart (Soniox starts a segment without a space)", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "قال", "Hij zei", { closed: true }));
    p.fb.update(seg("s:2", "الله", "dat Allah", { closed: true }));
    p.fb.update(seg("s:3", "أكبر", " groot is", { closed: true }));
    expect(p.shown()).toEqual(["Hij zei dat Allah groot is"]);
  });
});

describe("FastBlocks: Soniox's sentence marks", () => {
  it('continues a sentence after Soniox\'s "..." in the same block, without the dots', () => {
    const p = pipeline();
    p.fb.update(
      seg(
        "s:1",
        "وأشهد أن لا إله إلا الله وحده لا شريك له وأشهد أن محمدا",
        "En ik getuig dat er geen god is dan Allah, en dat Mohammed...",
        {
          closed: true,
        },
      ),
    );
    expect(p.shown()).toEqual(["En ik getuig dat er geen god is dan Allah, en dat Mohammed"]);
    vi.advanceTimersByTime(500);
    p.fb.update(seg("s:2", "عبده ورسوله", "Zijn dienaar en boodschapper is.", { closed: true }));
    expect(p.shown()).toEqual([
      "En ik getuig dat er geen god is dan Allah, en dat Mohammed Zijn dienaar en boodschapper is.",
    ]);
    expect(appendOnly(p.out)).toBe(true);
  });

  it("writes a Dutch continuation word in lower case, but not a name or another language", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "ولا", "En niet...", { closed: true }));
    vi.advanceTimersByTime(500);
    p.fb.update(seg("s:2", "كان ذا قربى.", "Als het om naasten gaat.", { closed: true }));
    expect(p.shown()).toEqual(["En niet als het om naasten gaat."]);

    const name = pipeline();
    name.fb.update(seg("s:1", "وأشهد أن", "En ik getuig dat...", { closed: true }));
    name.fb.update(seg("s:2", "محمدا رسول الله", "Mohammed de boodschapper is.", { closed: true }));
    expect(name.shown()).toEqual(["En ik getuig dat Mohammed de boodschapper is."]);

    const en = pipeline({ targetLang: "en" });
    en.fb.update(seg("s:1", "ولا", "And not...", { closed: true, lang: "en" }));
    en.fb.update(
      seg("s:2", "كان ذا قربى.", "If it concerns relatives.", { closed: true, lang: "en" }),
    );
    expect(en.shown()).toEqual(["And not If it concerns relatives."]);
  });

  it('adds the space a continuation needs after "... "', () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "ولا", "En niet... ", { closed: true }));
    p.fb.update(seg("s:2", "كان ذا قربى.", "als het om naasten gaat.", { closed: true }));
    expect(p.shown()).toEqual(["En niet als het om naasten gaat."]);
  });

  it("holds back a period after an Arabic word that cannot end a sentence", () => {
    const p = pipeline();
    p.fb.update(
      seg("s:1", "إذا كان لك دين، على.", "Als je een schuld hebt, aan.", { closed: true }),
    );
    expect(p.shown()).toEqual(["Als je een schuld hebt, aan"]);
    vi.advanceTimersByTime(1200);
    p.fb.update(seg("s:2", "آخر، أو على آخرين.", "Een ander, of aan anderen.", { closed: true }));
    expect(p.shown()).toEqual(["Als je een schuld hebt, aan een ander, of aan anderen."]);
    vi.advanceTimersByTime(600);
    p.fb.update(
      seg(
        "s:3",
        "هذه المسألة في الحقيقة من النوازل، وإن.",
        " Deze kwestie is een nieuw vraagstuk, en.",
        {
          closed: true,
        },
      ),
    );
    expect(p.shown()[1]).toBe("Deze kwestie is een nieuw vraagstuk, en");
    // Nothing continues the sentence: the held period is shown after all.
    vi.advanceTimersByTime(3000);
    expect(p.shown()[1]).toBe("Deze kwestie is een nieuw vraagstuk, en.");
    expect(appendOnly(p.out)).toBe(true);
  });

  it("puts a held mark back before a chunk that starts with a mark itself", () => {
    const p = pipeline();
    p.fb.update(
      seg("s:1", "إذا كان لك دين، على.", "Als je een schuld hebt, aan.", { closed: true }),
    );
    p.fb.update(seg("s:2", "؟", "?", { closed: true }));
    expect(p.shown()).toEqual(["Als je een schuld hebt, aan.?"]);
  });

  it("drops a held mark when its chunk showed nothing", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "على.", ".", { closed: true }));
    expect(p.blocks()).toEqual([]);
    p.fb.update(seg("s:2", "على.", "… ?", { closed: true }));
    expect(p.blocks()).toEqual([]);
    // The pause releases the held "?" behind nothing but dots: still nothing to show.
    vi.advanceTimersByTime(3000);
    expect(p.blocks()).toEqual([]);
    p.fb.update(seg("s:3", "كلام", "Daarna verder.", { closed: true }));
    expect(p.shown()).toEqual(["Daarna verder."]);
  });
});

describe("FastBlocks: what each chunk shows", () => {
  it("shows only the final part of the translation", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "قال الله", "Allah zei tegen", { trFinal: 9 }));
    expect(p.shown()).toEqual(["Allah zei"]);
    p.fb.update(seg("s:1", "قال الله", "Allah zei tegen", { trFinal: 9 }));
    expect(p.history("s:b1")).toHaveLength(1);
  });

  it("ignores segments without a translation in the target language", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "قال الله", "", { lang: null, closed: true }));
    p.fb.update(seg("s:2", "قال الله", "Allah said", { lang: "en", closed: true }));
    expect(p.blocks()).toEqual([]);
  });

  it("gives a translation that comes after its Arabic to the last word behind it", () => {
    const follower = scriptedFollower();
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قال الله تعالى", "Allah", {}));
    // More translation for the same Arabic words (no new words).
    p.fb.update(seg("s:1", "قال الله تعالى", "Allah de Verhevene zei", { closed: true }));
    expect(p.shown()).toEqual(["Allah ﷾ zei"]);
    // A first chunk of a segment without words yet is shown at once.
    p.fb.update(seg("s:2", "", "En", {}));
    expect(p.shown()).toEqual(["Allah ﷾ zei En"]);
  });

  it("gives a block opened by translation alone no Arabic line", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "قال", "Hij zei het."));
    vi.advanceTimersByTime(7000); // the block ends after a long silence
    p.fb.update(seg("s:1", "قال", "Hij zei het. En verder", { closed: true }));
    expect(p.blocks().map((b) => [b.text, b.src])).toEqual([
      ["Hij zei het.", "قال"],
      ["En verder", null],
    ]);
  });

  it("makes a block of a supplication a dua block", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "اللهم اغفر لنا", "O Allah, vergeef ons.", { closed: true }));
    vi.advanceTimersByTime(7000);
    p.fb.update(
      seg("s:2", "ربنا آتنا في الدنيا حسنة", "Onze Heer, geef ons het goede.", { closed: true }),
    );
    vi.advanceTimersByTime(7000);
    p.fb.update(seg("s:3", "أيها الناس", "O mensen, vrees Allah.", { closed: true }));
    expect(p.blocks().map((b) => b.kind)).toEqual(["dua", "dua", "speech"]);
  });

  it("follows the audio times of the speech behind each block", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "قال", "Hij", { startMs: null, endMs: null }));
    expect(p.blocks()[0]).toMatchObject({ startMs: null, endMs: null });
    // The segment's start becomes known (the first known start is kept).
    p.fb.update(
      seg("s:1", "قال الله", "Hij zei dat dit een goede zin is. En dan", {
        startMs: 500,
        endMs: 1500,
      }),
    );
    p.fb.update(
      seg("s:1", "قال الله ثم", "Hij zei dat dit een goede zin is. En dan verder", {
        startMs: 700,
        endMs: 1800,
      }),
    );
    expect(p.blocks()).toMatchObject([
      { startMs: null, endMs: 1500, text: "Hij zei dat dit een goede zin is." },
      { startMs: 500, endMs: 1800, text: "En dan verder" },
    ]);
  });
});

describe("FastBlocks: the listening dots", () => {
  it("shows them while speech is heard without new text, and hides them with text", () => {
    const p = pipeline();
    const listening = () =>
      p.out.flatMap((o) => (o.type === "listening" ? [o.active] : [])).join(",");
    // Speech before any text at all: dots at the next tick.
    p.fb.speech("start", Date.now());
    vi.advanceTimersByTime(250);
    expect(p.fb.listeningState()).toEqual({ active: true });
    p.fb.update(seg("s:1", "قال الله", "Allah zei"));
    expect(p.fb.listeningState()).toEqual({ active: false });
    // The khatib goes on, Soniox's words are not final yet: dots once 2 s pass without text.
    for (let k = 0; k < 4; k++) {
      p.fb.update(seg("s:1", "قال الله تعالى", "Allah zei", { srcFinal: 8 }));
      vi.advanceTimersByTime(500);
      if (k === 2) expect(p.fb.listeningState()).toEqual({ active: false });
    }
    expect(p.fb.listeningState()).toEqual({ active: true });
    // Silence: no dots.
    vi.advanceTimersByTime(1500);
    expect(p.fb.listeningState()).toEqual({ active: false });
    expect(listening()).toBe("true,false,true,false");
    // The page says the speech ended: the follower is flushed at once.
    const follower = scriptedFollower();
    const q = pipeline({ follower });
    q.fb.speech("end", Date.now());
    expect(follower.flushes).toEqual([Date.now()]);
  });
});

describe("FastBlocks: snapshots, reset, drain and close", () => {
  function three(p: Pipeline): void {
    for (const [k, t] of [
      "Een zin van zes woorden hier.",
      "Twee zin van zes woorden hier.",
      "Drie zin van zes woorden hier.",
    ].entries()) {
      p.fb.update(seg(`s:${k + 1}`, "كلام", t, { closed: true }));
    }
  }

  it("pages through the blocks, newest last, as copies", () => {
    const p = pipeline();
    three(p);
    expect(p.fb.blocks()).toMatchObject({
      blocks: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      hasMore: false,
    });
    expect(p.fb.blocks({ limit: 2 })).toMatchObject({
      blocks: [{ seq: 2 }, { seq: 3 }],
      hasMore: true,
    });
    expect(p.fb.blocks({ limit: 0 })).toMatchObject({ blocks: [{ seq: 3 }], hasMore: true });
    expect(p.fb.blocks({ limit: 9999, before: 3 })).toMatchObject({
      blocks: [{ seq: 1 }, { seq: 2 }],
      hasMore: false,
    });
    expect(p.fb.blocks({ before: 2, limit: 1 })).toMatchObject({
      blocks: [{ seq: 1 }],
      hasMore: false,
    });
    const copy = p.fb.blocks().blocks[0];
    if (copy !== undefined) copy.text = "changed";
    expect(p.fb.blocks().blocks[0]?.text).toBe("Een zin van zes woorden hier.");
  });

  it("forgets the shown blocks on reset; new words open a new block, seq goes on", () => {
    const p = pipeline();
    p.fb.update(seg("s:1", "إن الحمد لله نحمده", "Alle lof is voor Allah, wij prijzen Hem"));
    expect(p.blocks()).toHaveLength(1);
    p.fb.clearHistory();
    expect(p.fb.blocks()).toEqual({ blocks: [], hasMore: false });
    vi.advanceTimersByTime(300);
    p.fb.update(
      seg(
        "s:1",
        "إن الحمد لله نحمده ونستعينه",
        "Alle lof is voor Allah, wij prijzen Hem en zoeken Zijn hulp.",
        {
          closed: true,
        },
      ),
    );
    expect(p.blocks()).toMatchObject([{ seq: 2, text: "en zoeken Zijn hulp." }]);
    expect(p.persisted.map((b) => b.seq)).toEqual([1, 2]);
  });

  it("drops chunks still waiting at a reset", () => {
    const follower = scriptedFollower({
      push: () => ({ decidedTo: 0 }),
      flush: () => ({ decidedTo: 0 }),
    });
    const p = pipeline({ follower });
    p.fb.update(seg("s:1", "قال الله", "Allah zei", { closed: true }));
    expect(p.blocks()).toEqual([]);
    p.fb.clearHistory();
    vi.advanceTimersByTime(20_000);
    expect(p.blocks()).toEqual([]);
  });

  it("drains at stop: undecided words are shown and the open block is finished", () => {
    let decided = 0;
    const follower = scriptedFollower({
      push: () => ({ decidedTo: decided }),
      flush: (count, at) => ({ decidedTo: at >= Date.now() + 60_000 ? count : decided }),
    });
    const p = pipeline({ follower });
    p.fb.speech("start", Date.now());
    p.fb.update(seg("s:1", "إذا كان لك دين، على.", "Als je een schuld hebt, aan."));
    expect(p.blocks()).toEqual([]);
    decided = 0;
    void p.fb.drain(1000);
    expect(p.shown()).toEqual(["Als je een schuld hebt, aan."]);
    expect(p.fb.listeningState()).toEqual({ active: false });
    p.fb.close();
    p.fb.close();
    void p.fb.drain(1000);
    p.fb.update(seg("s:2", "كلام", "Meer tekst hier.", { closed: true }));
    p.fb.speech("start", Date.now());
    p.fb.speech("end", Date.now());
    p.fb.overrideEvent("salah");
    vi.advanceTimersByTime(5000);
    expect(p.shown()).toEqual(["Als je een schuld hebt, aan."]);
    expect(p.fb.mode).toBe("speech");
  });

  it("keeps captioning when blocks.jsonl cannot be written", () => {
    const p = pipeline({ persistThrows: true });
    p.fb.update(seg("s:1", "قال", "Hij zei het.", { closed: true }));
    expect(p.shown()).toEqual(["Hij zei het."]);
    expect(p.log.messages("warn")).toEqual(["blocks.jsonl write failed"]);
    const none = pipeline({ persist: undefined });
    none.fb.update(seg("s:1", "قال", "Hij zei het.", { closed: true }));
    expect(none.shown()).toEqual(["Hij zei het."]);
  });

  it("runs on the wall clock by default", () => {
    const out: PipelineOutput[] = [];
    const fb = new FastBlocks({
      sessionId: "w",
      targetLang: "nl",
      follower: passThroughFollower(),
      detector: null,
      labels: LABELS,
      log: captureLog().logger,
      emit: (o) => out.push(o),
    });
    fb.update(seg("w:1", "قال", "Hij zei het.", { closed: true }));
    expect(fb.blocks().blocks[0]?.createdAt).toBe(T0);
    expect(fb.mode).toBe("speech");
    fb.close();
  });

  it("keeps a bounded memory of segments in a long session", () => {
    const p = pipeline();
    // An open segment at the head keeps everything after it; so does one with a waiting chunk.
    p.fb.update(seg("s:0", "قال", "", { srcFinal: 0 }));
    for (let k = 1; k <= 320; k++) {
      p.fb.update(seg(`s:${k}`, "كلام", `Zin ${k} van vijf woorden.`, { closed: true }));
    }
    const segs = (p.fb as unknown as { segs: Map<string, unknown> }).segs;
    expect(segs.size).toBe(321);
    p.fb.update(seg("s:0", "قال", "Hij zei", { closed: true }));
    p.fb.update(seg("s:321", "كلام", "Laatste zin van vijf woorden.", { closed: true }));
    expect(segs.size).toBe(300);
    expect(p.shown().at(-1)).toContain("Laatste zin");
  });

  it("keeps the bookkeeping of a segment whose chunk is still waiting", () => {
    let decide = false;
    const follower = scriptedFollower({
      push: (count) => ({ decidedTo: decide ? count : 0 }),
      flush: (count) => ({ decidedTo: decide ? count : 0 }),
    });
    const p = pipeline({ follower });
    for (let k = 1; k <= 305; k++) {
      p.fb.update(seg(`s:${k}`, "كلام", `Zin ${k} van vijf woorden.`, { closed: true }));
    }
    const segs = (p.fb as unknown as { segs: Map<string, unknown> }).segs;
    expect(segs.size).toBe(305);
    expect(p.blocks()).toEqual([]);
    decide = true;
    vi.advanceTimersByTime(250);
    expect(p.shown().join(" ")).toContain("Zin 305 van vijf woorden.");
    p.fb.update(seg("s:306", "كلام", "Nog een zin.", { closed: true }));
    expect(segs.size).toBe(300);
  });
});

describe("passThroughFollower", () => {
  it("counts words and decides them at once", () => {
    const f = passThroughFollower();
    expect(f.ready).toBe(false);
    expect(f.push("بسم الله الرحمن الرحيم", 0)).toEqual({ added: 4, decidedTo: 4, verses: [] });
    expect(f.flush(10)).toEqual({ decidedTo: 4, verses: [] });
    f.reset();
    expect(f.push("قل هو الله أحد", 20)).toEqual({ added: 4, decidedTo: 4, verses: [] });
  });
});
