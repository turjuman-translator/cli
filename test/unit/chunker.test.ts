import { describe, expect, it } from "vitest";
import { FRAME_BYTES, FrameChunker } from "../../src/audio/chunker.js";

/** Small deterministic PRNG (LCG) so random splits are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("FrameChunker", () => {
  it("frames are 3,200 bytes = 100 ms of 16 kHz mono s16le", () => {
    expect(FRAME_BYTES).toBe(3200);
  });

  for (const seed of [1, 7, 42, 1234]) {
    it(`re-assembles randomly split input exactly (seed ${seed})`, () => {
      const total = 100_003;
      const input = new Uint8Array(total).map((_, i) => i % 251);
      const rand = lcg(seed);
      const chunker = new FrameChunker();
      const frames: Uint8Array[] = [];
      let offset = 0;
      while (offset < total) {
        const size = Math.min(total - offset, 1 + Math.floor(rand() * 10_000));
        frames.push(...chunker.push(input.subarray(offset, offset + size)));
        offset += size;
      }
      expect(frames.every((f) => f.byteLength === FRAME_BYTES)).toBe(true);
      expect(frames).toHaveLength(Math.floor(total / FRAME_BYTES));
      expect(chunker.pending).toBe(total % FRAME_BYTES);
      const joined = new Uint8Array(frames.length * FRAME_BYTES);
      frames.forEach((f, i) => {
        joined.set(f, i * FRAME_BYTES);
      });
      expect(joined).toEqual(input.subarray(0, joined.byteLength));
    });
  }

  it("emitted frames do not alias the caller's buffer", () => {
    const chunker = new FrameChunker();
    const buf = new Uint8Array(FRAME_BYTES).fill(1);
    const [frame] = chunker.push(buf);
    buf.fill(2);
    expect(frame?.[0]).toBe(1);
  });

  it("reset() drops the carried remainder", () => {
    const chunker = new FrameChunker();
    chunker.push(new Uint8Array(1000));
    chunker.reset();
    expect(chunker.pending).toBe(0);
    expect(chunker.push(new Uint8Array(FRAME_BYTES - 1000))).toHaveLength(0);
  });
});
