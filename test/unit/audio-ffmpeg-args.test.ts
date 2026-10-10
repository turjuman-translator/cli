import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAudioFilter,
  buildFfmpegArgs,
  type FfmpegArgsOptions,
  inputSpecFromConfig,
} from "../../src/audio/ffmpeg.js";
import type { Config } from "../../src/config.js";

const base: Omit<FfmpegArgsOptions, "input" | "platform"> = {
  channel: "mix",
  gainDb: 0,
  highpassHz: 0,
  rawTap: false,
};

function args(platform: NodeJS.Platform, input: FfmpegArgsOptions["input"], extra = {}): string[] {
  return buildFfmpegArgs({ ...base, platform, input, ...extra });
}

/** The value after `flag` (first occurrence). */
function valueAfter(list: string[], flag: string): string | undefined {
  return list[list.indexOf(flag) + 1];
}

function audio(input: Partial<Config["audio"]["input"]>): Config["audio"] {
  return {
    ffmpegPath: "ffmpeg",
    input: {
      kind: "none",
      device: "Line (USB Audio CODEC)",
      loop: false,
      startAtSec: 0,
      network: { port: 7000, sampleRate: 48_000, channels: 2 },
      ...input,
    },
    monitorWhenIdle: true,
    channel: "left",
    gainDb: 0,
    highpassHz: 0,
    silenceWarnDbfs: -50,
  };
}

describe("buildAudioFilter", () => {
  it("chains pan → highpass → volume, and is null for a plain mix", () => {
    expect(buildAudioFilter({ channel: "mix", gainDb: 0, highpassHz: 0 })).toBeNull();
    expect(buildAudioFilter({ channel: "left", gainDb: 0, highpassHz: 0 })).toBe("pan=mono|c0=c0");
    expect(buildAudioFilter({ channel: "right", gainDb: 6.25, highpassHz: 80 })).toBe(
      "pan=mono|c0=c1,highpass=f=80,volume=6.25dB",
    );
    expect(buildAudioFilter({ channel: "mix", gainDb: -3.1234567, highpassHz: 0 })).toBe(
      "volume=-3.123457dB",
    );
  });

  it("refuses a non-finite number", () => {
    expect(() => buildAudioFilter({ channel: "mix", gainDb: Number.NaN, highpassHz: 0 })).toThrow(
      "Invalid number for ffmpeg: NaN",
    );
  });
});

describe("buildFfmpegArgs", () => {
  it("maps the first audio stream to 16 kHz mono s16le on pipe:1", () => {
    const a = args("linux", { kind: "device", device: "default" }, { channel: "left" });
    expect(a.slice(0, 4)).toEqual(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    expect(valueAfter(a, "-map")).toBe("0:a:0");
    expect(valueAfter(a, "-af")).toBe("pan=mono|c0=c0");
    expect(a.slice(-3)).toEqual(["-flush_packets", "1", "pipe:1"]);
    expect(a).not.toContain("pipe:3");
    expect(args("linux", { kind: "device", device: "default" })).not.toContain("-af");
  });

  it("adds the raw 48 kHz stereo tap on pipe:3", () => {
    const a = args("linux", { kind: "device", device: "default" }, { rawTap: true });
    expect(a.slice(a.indexOf("pipe:1") + 1)).toEqual([
      "-map",
      "0:a:0",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-flush_packets",
      "1",
      "pipe:3",
    ]);
  });

  it("opens devices per platform (dshow, avfoundation, alsa, pulse)", () => {
    expect(valueAfter(args("win32", { kind: "device", device: "Line (USB)" }), "-i")).toBe(
      "audio=Line (USB)",
    );
    expect(valueAfter(args("win32", { kind: "device", device: "audio=Line (USB)" }), "-i")).toBe(
      "audio=Line (USB)",
    );
    expect(valueAfter(args("win32", { kind: "device", device: "x" }), "-audio_buffer_size")).toBe(
      "50",
    );
    expect(valueAfter(args("darwin", { kind: "device", device: "2" }), "-i")).toBe(":2");
    expect(valueAfter(args("darwin", { kind: "device", device: ":1" }), "-f")).toBe("avfoundation");
    expect(valueAfter(args("darwin", { kind: "device", device: ":1" }), "-i")).toBe(":1");
    expect(valueAfter(args("linux", { kind: "device", device: "hw:1,0" }), "-f")).toBe("alsa");
    expect(valueAfter(args("linux", { kind: "device", device: "plughw:1,0" }), "-f")).toBe("alsa");
    const pulse = args("linux", { kind: "device", device: "alsa_input.usb" });
    expect([valueAfter(pulse, "-f"), valueAfter(pulse, "-i")]).toEqual(["pulse", "alsa_input.usb"]);
    expect(() => args("linux", { kind: "device", device: "  " })).toThrow(
      "audio.input.device is empty",
    );
  });

  it("reads files in real time as file: + an absolute path", () => {
    const plain = args("linux", {
      kind: "file",
      path: "/srv/a/../khutbah.wav",
      loop: false,
      startAtSec: 0,
    });
    expect(plain).toContain("-re");
    expect(plain).not.toContain("-ss");
    expect(plain).not.toContain("-stream_loop");
    expect(valueAfter(plain, "-i")).toBe("file:/srv/khutbah.wav");
    const looped = args("linux", {
      kind: "file",
      path: "-odd:name.wav",
      loop: true,
      startAtSec: 12.5,
    });
    expect(valueAfter(looped, "-ss")).toBe("12.5");
    expect(valueAfter(looped, "-stream_loop")).toBe("-1");
    expect(valueAfter(looped, "-i")).toBe(`file:${resolve("-odd:name.wav")}`);
    const win = args("win32", {
      kind: "file",
      path: "C:\\audio\\.\\k.wav",
      loop: false,
      startAtSec: 0,
    });
    expect(valueAfter(win, "-i")).toBe("file:C:\\audio\\k.wav");
    expect(() => args("linux", { kind: "file", path: " ", loop: false, startAtSec: 0 })).toThrow(
      "audio input file path is empty",
    );
  });

  it("listens for the network bridge as raw s16le over TCP", () => {
    const a = args("linux", { kind: "network", port: 7001, sampleRate: 44_100, channels: 1 });
    expect([valueAfter(a, "-f"), valueAfter(a, "-ar"), valueAfter(a, "-ac")]).toEqual([
      "s16le",
      "44100",
      "1",
    ]);
    expect(valueAfter(a, "-i")).toBe("tcp://0.0.0.0:7001?listen=1");
    expect(valueAfter(a, "-fflags")).toBe("nobuffer");
  });
});

describe("inputSpecFromConfig", () => {
  it("maps every input kind", () => {
    expect(inputSpecFromConfig(audio({ kind: "none" }))).toBeNull();
    expect(inputSpecFromConfig(audio({ kind: "device", device: "hw:0,0" }))).toEqual({
      kind: "device",
      device: "hw:0,0",
    });
    expect(inputSpecFromConfig(audio({ kind: "network" }))).toEqual({
      kind: "network",
      port: 7000,
      sampleRate: 48_000,
      channels: 2,
    });
  });

  it("resolves a relative file path against baseDir (default: cwd) and requires a path", () => {
    expect(
      inputSpecFromConfig(audio({ kind: "file", path: "k.wav", loop: true, startAtSec: 3 }), {
        baseDir: "/srv/turjuman",
      }),
    ).toEqual({ kind: "file", path: "/srv/turjuman/k.wav", loop: true, startAtSec: 3 });
    expect(inputSpecFromConfig(audio({ kind: "file", path: "k.wav" }))).toMatchObject({
      path: resolve(process.cwd(), "k.wav"),
    });
    expect(() => inputSpecFromConfig(audio({ kind: "file" }))).toThrow(
      /audio\.input\.path is required/,
    );
    expect(() => inputSpecFromConfig(audio({ kind: "file", path: "  " }))).toThrow(/is required/);
  });
});
