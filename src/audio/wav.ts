// Streaming 16-bit PCM WAV writer for the raw recording tap: the header is written first with
// placeholder sizes and patched on close; patchWavHeader repairs files left behind by a crash.
import {
  closeSync,
  createWriteStream,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  type WriteStream,
  writeSync,
} from "node:fs";

export interface WavFormat {
  sampleRate: number;
  channels: number;
}

export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
/** Size field value meaning "unknown / until end of file" (streaming placeholder). */
const PLACEHOLDER_SIZE = 0xffff_ffff;
/** Largest data chunk a 32-bit RIFF size can describe (RIFF size = 36 + data). */
const MAX_DATA_BYTES = 0xffff_ffff - 36;

function blockAlignOf(format: WavFormat): number {
  return format.channels * BYTES_PER_SAMPLE;
}

function alignDown(n: number, block: number): number {
  return n - (n % block);
}

/** A canonical 44-byte PCM header; `dataBytes` null writes the streaming placeholder sizes. */
export function wavHeader(format: WavFormat, dataBytes: number | null): Uint8Array {
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`Invalid WAV sample rate: ${format.sampleRate}`);
  }
  if (!Number.isInteger(format.channels) || format.channels < 1) {
    throw new Error(`Invalid WAV channel count: ${format.channels}`);
  }
  const blockAlign = blockAlignOf(format);
  const out = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, dataBytes === null ? PLACEHOLDER_SIZE : 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes === null ? PLACEHOLDER_SIZE : dataBytes, true);
  return out;
}

export interface WavWriterOptions {
  /** Called once if a write fails (disk full, permissions); later writes are dropped. */
  onError?: (err: Error) => void;
  /** Data size limit in bytes (default and maximum: the 4 GiB a 32-bit RIFF size describes). */
  maxDataBytes?: number;
}

/**
 * Streams s16le PCM into a WAV file. The file is created synchronously (a bad path throws
 * here), data is appended asynchronously, and close() patches the RIFF and data sizes.
 */
export class WavWriter {
  private readonly fd: number;
  private readonly stream: WriteStream;
  private readonly blockAlign: number;
  private readonly maxDataBytes: number;
  private bytes = 0;
  private closing: Promise<number> | null = null;
  private failure: Error | null = null;

  constructor(
    readonly path: string,
    readonly format: WavFormat,
    opts: WavWriterOptions = {},
  ) {
    const header = wavHeader(format, null);
    this.blockAlign = blockAlignOf(format);
    this.maxDataBytes = Math.min(opts.maxDataBytes ?? MAX_DATA_BYTES, MAX_DATA_BYTES);
    this.fd = openSync(path, "w");
    try {
      writeSync(this.fd, header, 0, header.byteLength, 0);
    } catch (err) {
      closeSync(this.fd);
      throw err;
    }
    this.stream = createWriteStream(path, {
      fd: this.fd,
      autoClose: false,
      start: WAV_HEADER_BYTES,
    });
    this.stream.on("error", (err) => {
      if (this.failure !== null) return;
      this.failure = err;
      opts.onError?.(err);
    });
  }

  /**
   * Append PCM bytes. Returns false when the data was dropped (closing, failed, or the 4 GiB
   * WAV limit reached). Callers keep chunks aligned to whole sample frames.
   */
  write(chunk: Uint8Array): boolean {
    if (this.closing !== null || this.failure !== null) return false;
    const room = this.maxDataBytes - this.bytes;
    if (room < this.blockAlign) return false;
    const part =
      chunk.byteLength <= room ? chunk : chunk.subarray(0, alignDown(room, this.blockAlign));
    this.stream.write(part);
    this.bytes += part.byteLength;
    return part.byteLength === chunk.byteLength;
  }

  /** PCM bytes accepted so far. */
  get dataBytes(): number {
    return this.bytes;
  }

  /** Audio duration accepted so far, in ms. */
  get durationMs(): number {
    return (this.bytes / (this.format.sampleRate * this.blockAlign)) * 1000;
  }

  /** The write error, if one happened. */
  get error(): Error | null {
    return this.failure;
  }

  /** Flush, patch the header sizes and close the file; resolves with the final data size. */
  close(): Promise<number> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
    try {
      // Size from the file itself, so a failed write can never leave a header that lies.
      const onDisk = fstatSync(this.fd).size - WAV_HEADER_BYTES;
      const dataBytes = alignDown(
        Math.max(0, Math.min(onDisk, this.maxDataBytes)),
        this.blockAlign,
      );
      if (onDisk > dataBytes) ftruncateSync(this.fd, WAV_HEADER_BYTES + dataBytes);
      const header = wavHeader(this.format, dataBytes);
      writeSync(this.fd, header, 0, header.byteLength, 0);
      return dataBytes;
    } finally {
      closeSync(this.fd);
    }
  }

  /**
   * Repair the size fields of a WAV left by a crash (placeholder or stale sizes): the data
   * chunk is taken to run to the end of the file, trimmed to whole sample frames.
   * Returns the data size in bytes; throws when the file is not a PCM WAV.
   */
  static patchWavHeader(path: string): number {
    const fd = openSync(path, "r+");
    try {
      const size = fstatSync(fd).size;
      const read = (offset: number, length: number): DataView => {
        const buf = new Uint8Array(length);
        if (readSync(fd, buf, 0, length, offset) !== length) {
          throw new Error(`${path}: truncated WAV header`);
        }
        return new DataView(buf.buffer);
      };
      const tag = (view: DataView, offset: number): string =>
        String.fromCharCode(
          view.getUint8(offset),
          view.getUint8(offset + 1),
          view.getUint8(offset + 2),
          view.getUint8(offset + 3),
        );

      const riff = read(0, 12);
      if (tag(riff, 0) !== "RIFF" || tag(riff, 8) !== "WAVE") {
        throw new Error(`${path}: not a RIFF/WAVE file`);
      }
      let offset = 12;
      let blockAlign: number | null = null;
      while (offset + 8 <= size) {
        const chunk = read(offset, 8);
        const id = tag(chunk, 0);
        const chunkSize = chunk.getUint32(4, true);
        if (id === "fmt ") blockAlign = read(offset + 8, 16).getUint16(12, true);
        if (id === "data") {
          if (blockAlign === null || blockAlign === 0) throw new Error(`${path}: no fmt chunk`);
          const dataStart = offset + 8;
          const available = Math.min(size - dataStart, 0xffff_ffff - (dataStart - 8));
          const dataBytes = alignDown(Math.max(0, available), blockAlign);
          if (size > dataStart + dataBytes) ftruncateSync(fd, dataStart + dataBytes);
          const sizes = new DataView(new ArrayBuffer(4));
          sizes.setUint32(0, dataBytes, true);
          writeSync(fd, new Uint8Array(sizes.buffer), 0, 4, offset + 4);
          sizes.setUint32(0, dataStart - 8 + dataBytes, true);
          writeSync(fd, new Uint8Array(sizes.buffer), 0, 4, 4);
          return dataBytes;
        }
        if (chunkSize === PLACEHOLDER_SIZE) break;
        offset += 8 + chunkSize + (chunkSize % 2);
      }
      throw new Error(`${path}: no data chunk`);
    } finally {
      closeSync(fd);
    }
  }
}

/** Same as WavWriter.patchWavHeader. */
export function patchWavHeader(path: string): number {
  return WavWriter.patchWavHeader(path);
}
