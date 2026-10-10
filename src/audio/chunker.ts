/** 100 ms of 16 kHz mono s16le audio. */
export const FRAME_BYTES = 3200;

/** Cuts an arbitrary byte stream into exact fixed-size frames, carrying the remainder over. */
export class FrameChunker {
  private readonly buf: Uint8Array;
  private fill = 0;

  constructor(private readonly frameBytes: number = FRAME_BYTES) {
    this.buf = new Uint8Array(frameBytes);
  }

  /** Append bytes; returns every frame completed by them (each a fresh copy). */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(this.frameBytes - this.fill, chunk.byteLength - offset);
      this.buf.set(chunk.subarray(offset, offset + take), this.fill);
      this.fill += take;
      offset += take;
      if (this.fill === this.frameBytes) {
        frames.push(this.buf.slice());
        this.fill = 0;
      }
    }
    return frames;
  }

  /** Bytes waiting for the next frame. */
  get pending(): number {
    return this.fill;
  }

  reset(): void {
    this.fill = 0;
  }
}
