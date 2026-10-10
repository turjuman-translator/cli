// Word 3-gram inverted index over all ayat and candidate retrieval: which
// regions of the Quran could explain (part of) a text window. Alignment happens in matcher.ts.
import { keyForm, type QuranCorpus } from "./corpus.js";

/** A corpus region worth aligning against the window. */
export interface Candidate {
  /** 1-based sura number. */
  sura: number;
  /** Corpus region, global word positions [start, end). */
  start: number;
  end: number;
  /** Window rows worth aligning, [wStart, wEnd). */
  wStart: number;
  wEnd: number;
  /** Distinct window positions with a 3-gram hit in this region. */
  hits: number;
}

export interface CandidateOptions {
  /** Max diagonal drift (inserted/dropped words) between hits of one region. */
  band?: number;
  /** Window words beyond the outermost hits that may still align. */
  extend?: number;
  /** Extra corpus words on both sides of a region. */
  slack?: number;
  /** Keep at most this many regions (most hits first). */
  maxCandidates?: number;
  /** Ignore 3-grams occurring more often than this (no evidence, only cost). */
  maxPositions?: number;
}

interface Hit {
  sura: number;
  d: number;
  i: number;
  p: number;
}

export class TrigramIndex {
  /** Retrieval key per corpus word. */
  readonly keys: readonly string[];
  private readonly grams = new Map<string, number[]>();
  /** First word / first two words of every 3-gram (could a quote start here?). */
  private readonly starts1 = new Set<string>();
  private readonly starts2 = new Set<string>();
  /** Sura (1-based) per global word position. */
  private readonly suraOfWord: Uint8Array;
  /** First global word position per sura (index 0 = sura 1), plus the end. */
  private readonly suraWordStart: Int32Array;

  constructor(corpus: QuranCorpus) {
    const n = corpus.words.length;
    this.keys = corpus.words.map(keyForm);
    this.suraOfWord = new Uint8Array(n);
    this.suraWordStart = new Int32Array(corpus.suraSizes.length + 1);
    // Every index below is in range: ayahStart has an entry per ayah (plus the end), wordAyah
    // one per word.
    corpus.suraFirst.forEach((firstAyah, s) => {
      this.suraWordStart[s] = corpus.ayahStart[firstAyah] as number;
    });
    this.suraWordStart[corpus.suraSizes.length] = n;
    for (let p = 0; p < n; p++) {
      this.suraOfWord[p] = corpus.sura[corpus.wordAyah[p] as number] as number;
    }
    for (let p = 0; p + 2 < n; p++) {
      const s = this.suraOfWord[p];
      if (this.suraOfWord[p + 2] !== s) continue; // 3-grams never cross a sura boundary
      const key = `${this.keys[p]} ${this.keys[p + 1]} ${this.keys[p + 2]}`;
      this.starts1.add(this.keys[p] as string);
      this.starts2.add(`${this.keys[p]} ${this.keys[p + 1]}`);
      const list = this.grams.get(key);
      if (list === undefined) this.grams.set(key, [p]);
      else list.push(p);
    }
  }

  /** Number of distinct 3-grams (diagnostics). */
  get size(): number {
    return this.grams.size;
  }

  /** True when 1 or 2 retrieval keys are the beginning of some Quran 3-gram. */
  startsGram(keys: readonly string[]): boolean {
    if (keys.length === 1) return this.starts1.has(keys[0] as string);
    if (keys.length === 2) return this.starts2.has(`${keys[0]} ${keys[1]}`);
    return false;
  }

  /** Start positions of a 3-gram of retrieval keys. */
  positions(k1: string, k2: string, k3: string): readonly number[] {
    return this.grams.get(`${k1} ${k2} ${k3}`) ?? [];
  }

  /** Global word range [start, end) of a sura (1-based). */
  suraRange(sura: number): { start: number; end: number } {
    return { start: this.suraWordStart[sura - 1] ?? 0, end: this.suraWordStart[sura] ?? 0 };
  }

  /**
   * Candidate regions for a window: 3-gram hits are grouped per sura by diagonal (corpus position
   * minus window position, allowing a few inserted/dropped words), and every group becomes one
   * corpus region. `windowKeys[i]` is the retrieval key of window word i, or null when masked.
   */
  candidates(windowKeys: readonly (string | null)[], opts: CandidateOptions = {}): Candidate[] {
    const band = opts.band ?? 4;
    const extend = opts.extend ?? 24;
    const slack = opts.slack ?? 4;
    const maxCandidates = opts.maxCandidates ?? 40;
    const maxPositions = opts.maxPositions ?? 1500;
    const m = windowKeys.length;

    const hits: Hit[] = [];
    for (let i = 0; i + 2 < m; i++) {
      const a = windowKeys[i];
      const b = windowKeys[i + 1];
      const c = windowKeys[i + 2];
      if (a == null || b == null || c == null) continue;
      const list = this.grams.get(`${a} ${b} ${c}`);
      if (list === undefined || list.length > maxPositions) continue;
      for (const p of list) hits.push({ sura: this.suraOfWord[p] as number, d: p - i, i, p });
    }
    if (hits.length === 0) return [];
    hits.sort((x, y) => x.sura - y.sura || x.d - y.d || x.i - y.i);

    const out: Candidate[] = [];
    let group: Hit[] = [];
    /** Called with a non-empty group only. */
    const flush = (): void => {
      const first = group[0] as Hit;
      let minI = Number.POSITIVE_INFINITY;
      let maxI = -1;
      let minP = Number.POSITIVE_INFINITY;
      let maxP = -1;
      const rows = new Set<number>();
      for (const h of group) {
        rows.add(h.i);
        minI = Math.min(minI, h.i);
        maxI = Math.max(maxI, h.i);
        minP = Math.min(minP, h.p);
        maxP = Math.max(maxP, h.p);
      }
      const range = this.suraRange(first.sura);
      const before = Math.min(minI, extend) + slack;
      const after = Math.min(m - (maxI + 3), extend) + slack;
      out.push({
        sura: first.sura,
        start: Math.max(range.start, minP - before),
        end: Math.min(range.end, maxP + 3 + after),
        wStart: Math.max(0, minI - before),
        wEnd: Math.min(m, maxI + 3 + after),
        hits: rows.size,
      });
      group = [];
    };
    for (const h of hits) {
      const last = group[group.length - 1];
      if (last !== undefined && (h.sura !== last.sura || h.d - last.d > band)) flush();
      group.push(h);
    }
    flush();

    out.sort((x, y) => y.hits - x.hits || x.start - y.start);
    return out.slice(0, maxCandidates);
  }
}
