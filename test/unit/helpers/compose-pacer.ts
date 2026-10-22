// Test doubles for src/compose/pacer.ts: an inner pipeline whose output the test writes by hand
// (members that grow and close, verses, cards, mode, listening), and a harness that records what
// the pacer publishes and persists. Use with vi.useFakeTimers(): the pacer's clock is Date.now.
import { Pacer, type PacerHooks } from "../../../src/compose/pacer.js";
import type { BlockPipeline, PipelineOutput } from "../../../src/compose/types.js";
import type { Block, PrayerEvent, Segment, SessionMode } from "../../../src/shared/protocol.js";
import { captureLog } from "./compose-fast-blocks.js";

/** An inner pipeline that says what the test tells it to. */
export class ScriptedInner implements BlockPipeline {
  mode: SessionMode = "speech";
  readonly calls: string[] = [];
  /** Run inside the next update()/speech()/overrideEvent()/drain() call. */
  onCall: (() => void) | null = null;
  closedCount = 0;
  private seq = 0;
  private readonly live = new Map<string, Block>();

  constructor(readonly hooks: PacerHooks) {}

  update(seg: Segment): void {
    this.calls.push(`update ${seg.id}`);
    this.run();
  }

  speech(state: "start" | "end", at: number): void {
    this.calls.push(`speech ${state} ${at}`);
    this.run();
  }

  overrideEvent(event: PrayerEvent | "none"): void {
    this.calls.push(`override ${event}`);
    this.run();
  }

  listeningState(): { active: boolean } {
    return { active: false };
  }

  blocks(): { blocks: Block[]; hasMore: boolean } {
    return { blocks: [], hasMore: false };
  }

  clearHistory(): void {
    this.calls.push("clear");
  }

  async drain(maxWaitMs: number): Promise<void> {
    this.calls.push(`drain ${maxWaitMs}`);
    this.run();
  }

  close(): void {
    this.calls.push("close");
    this.closedCount++;
  }

  private run(): void {
    const fn = this.onCall;
    this.onCall = null;
    fn?.();
  }

  // --- what the test makes it say --------------------------------------------------------------

  /** A new block (a member, or a verse or card). */
  add(text: string, over: Partial<Block> = {}): Block {
    const seq = ++this.seq;
    const b: Block = {
      id: `i:b${seq}`,
      seq,
      kind: "speech",
      text,
      ref: null,
      src: null,
      lang: "nl",
      segmentIds: [`seg${seq}`],
      createdAt: Date.now(),
      startMs: null,
      endMs: null,
      ...over,
    };
    this.live.set(b.id, b);
    this.hooks.emit({ type: "block.add", block: structuredClone(b) });
    return b;
  }

  /** A change of a block already added. */
  change(b: Block, over: Partial<Block>): Block {
    const next = { ...(this.live.get(b.id) ?? b), ...over };
    this.live.set(b.id, next);
    this.hooks.emit({ type: "block.update", block: structuredClone(next) });
    return next;
  }

  /** The block is complete (fast blocks closed it). */
  finish(b: Block): void {
    this.hooks.closed(structuredClone(this.live.get(b.id) ?? b));
  }

  /** A member said in full: added, then closed. */
  say(text: string, over: Partial<Block> = {}): Block {
    const b = this.add(text, over);
    this.finish(b);
    return b;
  }

  emit(out: PipelineOutput): void {
    this.hooks.emit(out);
  }
}

export interface PacerHarness {
  pacer: Pacer;
  inner: ScriptedInner;
  out: PipelineOutput[];
  persisted: Block[];
  log: ReturnType<typeof captureLog>;
  /** Published blocks (block.add), in order. */
  adds(): Block[];
  updates(): Block[];
  /** block.add times, one per step (blocks added together share one). */
  steps(): number[];
  listening(): boolean[];
}

export function pacerHarness(opts: { persistThrows?: boolean } = {}): PacerHarness {
  const out: PipelineOutput[] = [];
  const persisted: Block[] = [];
  const log = captureLog();
  let inner: ScriptedInner | null = null;
  const pacer = new Pacer({
    sessionId: "p",
    now: () => Date.now(),
    log: log.logger,
    persist: (line) => {
      if (opts.persistThrows === true) throw new Error("disk full");
      persisted.push(JSON.parse(line) as Block);
    },
    emit: (o) => out.push(o),
    inner: (hooks) => {
      inner = new ScriptedInner(hooks);
      return inner;
    },
  });
  const adds = (): Block[] => out.flatMap((o) => (o.type === "block.add" ? [o.block] : []));
  return {
    pacer,
    inner: inner as unknown as ScriptedInner,
    out,
    persisted,
    log,
    adds,
    updates: () => out.flatMap((o) => (o.type === "block.update" ? [o.block] : [])),
    steps: () => [...new Set(adds().map((b) => b.createdAt))],
    listening: () => out.flatMap((o) => (o.type === "listening" ? [o.active] : [])),
  };
}

/** n words: "w0 w1 …" (prefix them to tell members apart). */
export function words(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}
