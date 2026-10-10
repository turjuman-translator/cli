// Disk failures while recording (disk full, I/O errors), injected through a thin node:fs wrapper:
// each fault fires once when armed; otherwise the real fs is used.
import type { WriteStream } from "node:fs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FfmpegAudioSource } from "../../src/audio/ffmpeg.js";
import { WavWriter } from "../../src/audio/wav.js";
import { fakeLog, fakeSpawn } from "./audio-fake-ffmpeg.js";

const faults = vi.hoisted(() => ({
  /** The next writeSync() throws. */
  writeSync: false,
  /** The next fstatSync() throws. */
  fstat: false,
  /** Streams created from now on fail every write. */
  streamWrites: false,
  streams: [] as WriteStream[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const ioError = (what: string) =>
    Object.assign(new Error(`${what}: no space left on device`), { code: "ENOSPC" });
  return {
    ...real,
    writeSync: (...args: unknown[]) => {
      if (faults.writeSync) {
        faults.writeSync = false;
        throw ioError("ENOSPC, write");
      }
      return (real.writeSync as (...a: unknown[]) => number)(...args);
    },
    fstatSync: (...args: unknown[]) => {
      if (faults.fstat) {
        faults.fstat = false;
        throw ioError("EIO, fstat");
      }
      return (real.fstatSync as (...a: unknown[]) => unknown)(...args);
    },
    createWriteStream: (path: string, options: Record<string, unknown>) => {
      const failing = {
        open: real.open,
        close: real.close,
        write: (
          _fd: number,
          _buf: Uint8Array,
          _off: number,
          _len: number,
          _pos: number | null,
          cb: (err: Error | null) => void,
        ) => cb(ioError("ENOSPC, write")),
      };
      const stream = real.createWriteStream(
        path,
        faults.streamWrites ? { ...options, fs: failing } : options,
      );
      faults.streams.push(stream);
      return stream;
    },
  };
});

const STEREO = { sampleRate: 48_000, channels: 2 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audio-fs-errors-"));
  faults.writeSync = false;
  faults.fstat = false;
  faults.streamWrites = false;
  faults.streams = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("WavWriter on a failing disk", () => {
  it("throws (and closes the file) when the header cannot be written", () => {
    const path = join(dir, "full.wav");
    faults.writeSync = true;
    expect(() => new WavWriter(path, STEREO)).toThrow(/ENOSPC/);
    expect(statSync(path).size).toBe(0);
  });

  it("reports the first write error once, then drops data; close still finalizes", async () => {
    faults.streamWrites = true;
    const errors: string[] = [];
    const w = new WavWriter(join(dir, "fail.wav"), STEREO, {
      onError: (err) => errors.push(err.message),
    });
    expect(w.write(new Uint8Array(8))).toBe(true); // accepted; the write fails asynchronously
    await flush();
    expect(errors).toEqual(["ENOSPC, write: no space left on device"]);
    expect(w.error?.message).toBe("ENOSPC, write: no space left on device");
    faults.streams[0]?.emit("error", new Error("again"));
    expect(errors).toHaveLength(1);
    expect(w.write(new Uint8Array(8))).toBe(false);
    expect(await w.close()).toBe(0); // the header describes what reached the disk
  });

  it("works without an error callback", async () => {
    faults.streamWrites = true;
    const w = new WavWriter(join(dir, "quiet.wav"), STEREO);
    w.write(new Uint8Array(4));
    await flush();
    expect(w.error).not.toBeNull();
    await w.close();
  });
});

describe("FfmpegAudioSource recording on a failing disk", () => {
  function source() {
    const fake = fakeSpawn();
    const log = fakeLog();
    const src = new FfmpegAudioSource({
      ffmpegPath: "ffmpeg",
      spec: { kind: "device", device: "hw:0,0" },
      channel: "mix",
      gainDb: 0,
      highpassHz: 0,
      silenceWarnDbfs: -50,
      platform: "linux",
      spawn: fake.spawn,
      log: log.logger,
    });
    return { src, fake, log };
  }

  it("stops the recording when a write fails, and keeps capturing", async () => {
    const t = source();
    t.src.start({ onFrame: () => {} });
    faults.streamWrites = true;
    await t.src.setRecording(join(dir, "rec.wav"));
    t.fake.last().raw([1, 2, 3, 4]);
    await flush();
    await flush();
    expect(t.log.messages("error")).toContain("recording write failed; recording stopped");
    expect(t.src.recording).toBeNull();
    expect(t.src.state).toBe("idle");
    const stopping = t.src.stop();
    t.fake.last().exit(0);
    await stopping;
  });

  it("ignores a late write error from a recording that was already replaced", async () => {
    const t = source();
    t.src.start({ onFrame: () => {} });
    faults.streamWrites = true;
    await t.src.setRecording(join(dir, "first.wav"));
    t.fake.last().raw([1, 2, 3, 4]);
    faults.streamWrites = false;
    const second = join(dir, "second.wav");
    await t.src.setRecording(second); // the first one's error arrives while it is being closed
    await flush();
    expect(t.log.messages("error")).toContain("recording write failed; recording stopped");
    expect(t.src.recording?.path).toBe(second);
    const stopping = t.src.stop();
    t.fake.last().exit(0);
    await stopping;
  });

  it("logs a recording that cannot be finalized", async () => {
    const t = source();
    await t.src.setRecording(join(dir, "final.wav"));
    faults.fstat = true;
    await t.src.setRecording(null);
    expect(t.log.messages("error")).toContain("could not finalize the recording");
  });
});
