import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type CommandRunner,
  type DeviceList,
  findDevice,
  listDevices,
  parseArecordDevices,
  parseAvfoundationDevices,
  parseDshowDevices,
  parsePactlSources,
  type RunResult,
  runCommand,
} from "../../src/audio/devices.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/devices/${name}`, import.meta.url), "utf8");

const ok = (stdout: string, stderr = "", code: number | null = 0): RunResult => ({
  code,
  stdout,
  stderr,
});

/** A runner answering per command; records the calls. */
function runner(answers: Record<string, RunResult | null>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return answers[command] ?? null;
  };
  return { run, calls };
}

describe("parseDshowDevices", () => {
  it("lists audio devices (also audio+video) with their alternative names", () => {
    const devices = parseDshowDevices(fixture("dshow.txt"));
    expect(devices.map((d) => d.name)).toEqual([
      "Line (USB Audio CODEC)",
      "Microphone (Realtek(R) Audio)",
      "Game Capture HD60 S+",
    ]);
    expect(devices[0]?.id).toBe("Line (USB Audio CODEC)");
    expect(devices[0]?.alt).toMatch(/^@device_cm_\{33D9A762/);
    expect(devices[2]?.alt).toMatch(/^@device_pnp_/);
  });

  it("reads the older format with section headers, keeping only the first alternative name", () => {
    const stderr = [
      "[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)",
      '[dshow @ 0x1]  "Webcam"',
      '[dshow @ 0x1]     Alternative name "@video"',
      "[dshow @ 0x1] DirectShow audio devices",
      '[dshow @ 0x1]  "Mic (USB)"',
      '[dshow @ 0x1]     Alternative name "@first"',
      '[dshow @ 0x1]     Alternative name "@second"',
      "[dshow @ 0x1] Could not enumerate audio only devices (or none found).",
      '[dshow @ 0x1]     Alternative name "@orphan"',
      '[dshow @ 0x1]  "Line In"',
      '[other @ 0x2]  "Not dshow"',
      'Plain "line"',
    ].join("\r\n");
    expect(parseDshowDevices(stderr)).toEqual([
      { id: "Mic (USB)", name: "Mic (USB)", alt: "@first" },
      { id: "Line In", name: "Line In" },
    ]);
  });

  it("ignores quoted names before any section header", () => {
    expect(parseDshowDevices('[dshow @ 0x1] "Orphan"')).toEqual([]);
  });
});

describe("parseAvfoundationDevices", () => {
  it("lists the audio section only, by index", () => {
    expect(parseAvfoundationDevices(fixture("avfoundation.txt"))).toEqual([
      { id: "0", name: "Abdullah’s iPhone Microphone" },
      { id: "1", name: "NDI Audio" },
      { id: "2", name: "MacBook Pro Microphone" },
      { id: "3", name: "Microsoft Teams Audio" },
      { id: "4", name: "MOTIV Mix Virtual" },
    ]);
  });

  it("strips uid/serial suffixes and skips other lines in the audio section", () => {
    const stderr = [
      "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
      "[AVFoundation indev @ 0x1] [0] USB Mic [uid:AppleUSB:1234] [serial:ABC]",
      "[AVFoundation indev @ 0x1] some note",
      "[AVFoundation indev @ 0x1] AVFoundation screen devices",
      "[AVFoundation indev @ 0x1] [1] Screen",
    ].join("\n");
    expect(parseAvfoundationDevices(stderr)).toEqual([{ id: "0", name: "USB Mic" }]);
  });
});

describe("parsePactlSources", () => {
  it("lists sources without monitors by default, with sample spec and state", () => {
    expect(parsePactlSources(fixture("pactl.txt"))).toEqual([
      {
        id: "alsa_input.pci-0000_00_1f.3.analog-stereo",
        name: "alsa_input.pci-0000_00_1f.3.analog-stereo",
        detail: "s32le 2ch 48000Hz, SUSPENDED",
      },
      {
        id: "alsa_input.usb-Burr-Brown_from_TI_USB_Audio_CODEC-00.analog-stereo",
        name: "alsa_input.usb-Burr-Brown_from_TI_USB_Audio_CODEC-00.analog-stereo",
        detail: "s16le 2ch 48000Hz, RUNNING",
      },
    ]);
  });

  it("includes monitors on request and tolerates short or malformed lines", () => {
    const out = parsePactlSources(
      "1\tmic.monitor\tPipeWire\n\n2\n3\t\tx\n4\tbare\n5\tspec\tPW\t\tIDLE",
      {
        includeMonitors: true,
      },
    );
    expect(out).toEqual([
      { id: "mic.monitor", name: "mic.monitor" },
      { id: "bare", name: "bare" },
      { id: "spec", name: "spec", detail: "IDLE" },
    ]);
  });
});

describe("parseArecordDevices", () => {
  it("gives hw:card,device ids with the stable CARD= alternative", () => {
    expect(parseArecordDevices(fixture("arecord.txt"))).toEqual([
      { id: "hw:0,0", name: "HDA Intel PCH: ALC3246 Analog", alt: "hw:CARD=PCH,DEV=0" },
      { id: "hw:1,0", name: "USB Audio CODEC: USB Audio", alt: "hw:CARD=CODEC,DEV=0" },
    ]);
  });

  it("uses the card name alone when the device name is empty or the same", () => {
    expect(
      parseArecordDevices(
        "card 2: X [Same], device 1: Same [Same]\ncard 3: Y [Card Y], device 0: Z []",
      ).map((d) => d.name),
    ).toEqual(["Same", "Card Y"]);
  });
});

describe("runCommand", () => {
  it("collects stdout, stderr and the exit code without a shell", async () => {
    const r = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3",
    ]);
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("resolves null when the command cannot be started", async () => {
    expect(await runCommand("turjuman-no-such-command-xyz", [])).toBeNull();
    // Invalid arguments make spawn() throw synchronously.
    expect(await runCommand("bad\0command", [])).toBeNull();
  });

  it("kills a command that outlives the timeout", async () => {
    const r = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], 300);
    expect(r?.code).toBeNull();
  });
});

describe("listDevices", () => {
  it("Windows: lists dshow devices; the listing's exit code is ignored", async () => {
    const { run, calls } = runner({ "C:/ffmpeg.exe": ok("", fixture("dshow.txt"), 1) });
    const list = await listDevices({ platform: "win32", ffmpegPath: "C:/ffmpeg.exe", run });
    expect(calls[0]?.args).toEqual([
      "-hide_banner",
      "-list_devices",
      "true",
      "-f",
      "dshow",
      "-i",
      "dummy",
    ]);
    expect(list.source).toBe("dshow");
    expect(list.devices).toHaveLength(3);
    expect(list.warning).toBeUndefined();
  });

  it("macOS: lists avfoundation devices; an empty list carries the last stderr line", async () => {
    const { run, calls } = runner({ ffmpeg: ok("", "[AVFoundation indev @ 0x1] nothing\nboom\n") });
    const list = await listDevices({ platform: "darwin", ffmpegPath: "ffmpeg", run });
    expect(calls[0]?.args).toContain("avfoundation");
    expect(list).toEqual({ source: "avfoundation", devices: [], warning: "boom" });
    const quiet = runner({ ffmpeg: ok("", "") });
    expect(await listDevices({ platform: "darwin", ffmpegPath: "ffmpeg", run: quiet.run })).toEqual(
      { source: "avfoundation", devices: [] },
    );
  });

  it("throws when ffmpeg is missing (default runner)", async () => {
    await expect(
      listDevices({ platform: "darwin", ffmpegPath: "/nonexistent/turjuman-ffmpeg" }),
    ).rejects.toThrow("ffmpeg (/nonexistent/turjuman-ffmpeg) not found");
  });

  it("Linux: prefers pactl (PulseAudio/PipeWire)", async () => {
    const { run, calls } = runner({ pactl: ok(fixture("pactl.txt")) });
    const list = await listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run });
    expect(calls).toEqual([{ command: "pactl", args: ["list", "short", "sources"] }]);
    expect(list.source).toBe("pulse");
    expect(list.devices).toHaveLength(2);
    const all = await listDevices({
      platform: "linux",
      ffmpegPath: "ffmpeg",
      run,
      includeMonitors: true,
    });
    expect(all.devices).toHaveLength(4);
  });

  it("Linux: falls back to arecord, explaining why pactl failed", async () => {
    const a = runner({
      pactl: ok("", "Connection failure: Connection refused\n", 1),
      arecord: ok(fixture("arecord.txt")),
    });
    expect(
      await listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run: a.run }),
    ).toMatchObject({
      source: "alsa",
      warning: "pactl: Connection failure: Connection refused",
    });
    const b = runner({ arecord: ok("", "arecord: no soundcards found...\n", 1) });
    expect(await listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run: b.run })).toEqual({
      source: "alsa",
      devices: [],
      warning: "pactl: not installed; arecord: arecord: no soundcards found...",
    });
    const c = runner({ pactl: ok("", "", 1) });
    expect(await listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run: c.run })).toEqual({
      source: "alsa",
      devices: [],
      warning: "arecord: not installed",
    });
    const d = runner({ pactl: ok("", "", 1), arecord: ok(fixture("arecord.txt")) });
    const quiet = await listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run: d.run });
    expect(quiet.devices).toHaveLength(2);
    expect(quiet.warning).toBeUndefined();
    const e = runner({ pactl: ok("", "", 1), arecord: ok("", "", 1) });
    expect(await listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run: e.run })).toEqual({
      source: "alsa",
      devices: [],
    });
  });

  it("Linux: throws when neither pactl nor arecord is installed", async () => {
    const { run } = runner({});
    await expect(listDevices({ platform: "linux", ffmpegPath: "ffmpeg", run })).rejects.toThrow(
      /neither pactl .* nor arecord/,
    );
  });
});

describe("findDevice", () => {
  const avf: DeviceList = {
    source: "avfoundation",
    devices: [{ id: "2", name: "MacBook Pro Microphone" }],
  };
  const dshow: DeviceList = {
    source: "dshow",
    devices: [{ id: "Line (USB)", name: "Line (USB)", alt: "@device_cm_x" }],
  };
  const alsa: DeviceList = {
    source: "alsa",
    devices: [{ id: "hw:1,0", name: "USB Audio", alt: "hw:CARD=CODEC,DEV=0" }],
  };

  it("matches by id, name or alternative, the way audio.input.device is written", () => {
    expect(findDevice(avf, ":2")?.id).toBe("2");
    expect(findDevice(avf, "MacBook Pro Microphone")?.id).toBe("2");
    expect(findDevice(avf, ":9")).toBeUndefined();
    expect(findDevice(dshow, "audio=Line (USB)")?.id).toBe("Line (USB)");
    expect(findDevice(dshow, "@device_cm_x")?.id).toBe("Line (USB)");
    expect(findDevice(alsa, "hw:CARD=CODEC,DEV=0")?.id).toBe("hw:1,0");
    expect(findDevice(alsa, "audio=hw:1,0")).toBeUndefined();
  });
});
