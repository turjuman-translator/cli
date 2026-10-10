import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchWavHeader, WAV_HEADER_BYTES, WavWriter, wavHeader } from "../../src/audio/wav.js";

const STEREO = { sampleRate: 48_000, channels: 2 };

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** RIFF/WAVE file bytes from chunks (id, body); `riffSize` and chunk sizes as given. */
function riff(chunks: Array<{ id: string; size?: number; body: Uint8Array }>, form = "WAVE") {
  const parts: number[] = [];
  const push32 = (n: number) => parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  const pushTag = (t: string) => {
    for (const c of t) parts.push(c.charCodeAt(0));
  };
  pushTag("RIFF");
  push32(0);
  pushTag(form);
  for (const c of chunks) {
    pushTag(c.id);
    push32(c.size ?? c.body.byteLength);
    parts.push(...c.body);
  }
  return Uint8Array.from(parts);
}

/** A 16-byte PCM fmt body. */
function fmt(channels: number, blockAlign = channels * 2): Uint8Array {
  const out = new Uint8Array(16);
  const v = view(out);
  v.setUint16(0, 1, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, 48_000, true);
  v.setUint32(8, 48_000 * blockAlign, true);
  v.setUint16(12, blockAlign, true);
  v.setUint16(14, 16, true);
  return out;
}

describe("wavHeader", () => {
  it("writes a canonical 44-byte PCM header, with placeholder sizes while streaming", () => {
    const h = wavHeader(STEREO, 1000);
    expect(h.byteLength).toBe(WAV_HEADER_BYTES);
    expect([ascii(h, 0), ascii(h, 8), ascii(h, 12), ascii(h, 36)]).toEqual([
      "RIFF",
      "WAVE",
      "fmt ",
      "data",
    ]);
    const v = view(h);
    expect(v.getUint32(4, true)).toBe(1036);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48_000);
    expect(v.getUint32(28, true)).toBe(192_000);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(1000);
    const streaming = view(wavHeader({ sampleRate: 16_000, channels: 1 }, null));
    expect(streaming.getUint32(4, true)).toBe(0xffff_ffff);
    expect(streaming.getUint32(40, true)).toBe(0xffff_ffff);
  });

  it("rejects an invalid sample rate or channel count", () => {
    expect(() => wavHeader({ sampleRate: 0, channels: 1 }, null)).toThrow(/sample rate: 0/);
    expect(() => wavHeader({ sampleRate: 44_100.5, channels: 1 }, null)).toThrow(/sample rate/);
    expect(() => wavHeader({ sampleRate: 16_000, channels: 0 }, null)).toThrow(/channel count/);
    expect(() => wavHeader({ sampleRate: 16_000, channels: 1.5 }, null)).toThrow(/channel/);
  });
});

describe("WavWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-wav-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("streams PCM and patches the sizes on close (close is idempotent)", async () => {
    const path = join(dir, "rec.wav");
    const w = new WavWriter(path, STEREO);
    expect(w.path).toBe(path);
    expect(w.format).toEqual(STEREO);
    expect(statSync(path).size).toBe(WAV_HEADER_BYTES);
    expect(w.write(new Uint8Array(1920).fill(7))).toBe(true);
    expect(w.write(new Uint8Array(1920).fill(9))).toBe(true);
    expect(w.dataBytes).toBe(3840);
    expect(w.durationMs).toBe(20);
    expect(w.error).toBeNull();
    const closing = w.close();
    expect(w.close()).toBe(closing);
    expect(w.write(new Uint8Array(4))).toBe(false); // closing: dropped
    expect(await closing).toBe(3840);
    const bytes = new Uint8Array(readFileSync(path));
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + 3840);
    expect(view(bytes).getUint32(4, true)).toBe(36 + 3840);
    expect(view(bytes).getUint32(40, true)).toBe(3840);
    expect(bytes[WAV_HEADER_BYTES]).toBe(7);
    expect(bytes[bytes.byteLength - 1]).toBe(9);
  });

  it("trims a partial sample frame at close so the header never lies", async () => {
    const path = join(dir, "odd.wav");
    const w = new WavWriter(path, STEREO);
    w.write(new Uint8Array(10)); // 2 whole frames + 2 bytes
    expect(await w.close()).toBe(8);
    expect(statSync(path).size).toBe(WAV_HEADER_BYTES + 8);
  });

  it("stops at the data size limit, keeping whole sample frames", async () => {
    const path = join(dir, "limit.wav");
    const w = new WavWriter(path, STEREO, { maxDataBytes: 10 });
    expect(w.write(new Uint8Array(12))).toBe(false); // only 8 bytes fit (2 frames)
    expect(w.dataBytes).toBe(8);
    expect(w.write(new Uint8Array(4))).toBe(false); // 2 bytes of room: less than a frame
    expect(w.dataBytes).toBe(8);
    expect(await w.close()).toBe(8);
    const capped = new WavWriter(join(dir, "capped.wav"), STEREO, { maxDataBytes: 2 ** 40 });
    expect(capped.write(new Uint8Array(4))).toBe(true);
    expect(await capped.close()).toBe(4);
  });

  it("throws at construction for a path that cannot be created", () => {
    expect(() => new WavWriter(join(dir, "missing", "x.wav"), STEREO)).toThrow(/ENOENT/);
  });
});

describe("patchWavHeader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-wav-patch-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string, bytes: Uint8Array): string => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };

  it("repairs the placeholder sizes of a crashed recording, trimming a partial frame", () => {
    const header = wavHeader(STEREO, null);
    const data = new Uint8Array(4 * 100 + 3).fill(1);
    const path = file("crash.wav", Uint8Array.from([...header, ...data]));
    expect(patchWavHeader(path)).toBe(400);
    const bytes = new Uint8Array(readFileSync(path));
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + 400);
    expect(view(bytes).getUint32(4, true)).toBe(436);
    expect(view(bytes).getUint32(40, true)).toBe(400);
    expect(WavWriter.patchWavHeader(path)).toBe(400); // already exact: unchanged
    expect(statSync(path).size).toBe(WAV_HEADER_BYTES + 400);
  });

  it("skips other chunks (padded to even sizes) before the data chunk", () => {
    const list = new Uint8Array(3).fill(0x41); // odd size: one pad byte follows
    const bytes = riff([
      { id: "fmt ", body: fmt(1) },
      { id: "LIST", body: Uint8Array.from([...list, 0]), size: 3 },
      { id: "data", size: 0, body: new Uint8Array(6).fill(2) },
    ]);
    const path = file("list.wav", bytes);
    expect(patchWavHeader(path)).toBe(6);
    const out = view(new Uint8Array(readFileSync(path)));
    expect(out.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(out.getUint32(12 + 8 + 16 + 8 + 4 + 4, true)).toBe(6);
  });

  it("rejects files that are not PCM WAVs", () => {
    expect(() => patchWavHeader(file("short.wav", new Uint8Array(8)))).toThrow(/truncated/);
    expect(() => patchWavHeader(file("riff.wav", riff([], "AVI ")))).toThrow(/not a RIFF/);
    const notRiff = riff([]);
    notRiff[0] = 0x58;
    expect(() => patchWavHeader(file("x.wav", notRiff))).toThrow(/not a RIFF\/WAVE/);
    expect(() =>
      patchWavHeader(file("nofmt.wav", riff([{ id: "data", body: new Uint8Array(4) }]))),
    ).toThrow(/no fmt chunk/);
    expect(() =>
      patchWavHeader(
        file(
          "zero.wav",
          riff([
            { id: "fmt ", body: fmt(1, 0) },
            { id: "data", body: new Uint8Array(4) },
          ]),
        ),
      ),
    ).toThrow(/no fmt chunk/);
    expect(() =>
      patchWavHeader(file("cutfmt.wav", riff([{ id: "fmt ", body: new Uint8Array(4) }]))),
    ).toThrow(/truncated/);
    expect(() => patchWavHeader(file("nodata.wav", riff([{ id: "fmt ", body: fmt(2) }])))).toThrow(
      /no data chunk/,
    );
    expect(() =>
      patchWavHeader(
        file(
          "stream.wav",
          riff([
            { id: "fmt ", body: fmt(2) },
            { id: "junk", size: 0xffff_ffff, body: new Uint8Array(8) },
          ]),
        ),
      ),
    ).toThrow(/no data chunk/);
  });
});
