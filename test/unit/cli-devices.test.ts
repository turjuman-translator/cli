import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner, RunResult } from "../../src/audio/devices.js";
import {
  bridgeListHint,
  DEVICES_HELP,
  devicesCommand,
  formatDeviceList,
  yamlQuote,
} from "../../src/cli/devices.js";
import { runCli } from "../../src/cli/index.js";
import { capture, configured, LANGUAGES_FILE, removeTempDirs, tempDir } from "./helpers/cli-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

const AVFOUNDATION = [
  "[AVFoundation indev @ 0x7f8] AVFoundation video devices:",
  "[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera",
  "[AVFoundation indev @ 0x7f8] AVFoundation audio devices:",
  "[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone",
  "[AVFoundation indev @ 0x7f8] [1] USB Audio CODEC",
  ": Input/output error",
].join("\n");

/** A command runner that answers per program; null = not installed. */
function runner(answers: Record<string, RunResult | null>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return answers[command] ?? null;
  };
  return Object.assign(run, { calls });
}

const stderr = (text: string): RunResult => ({ code: 1, stdout: "", stderr: text });

describe("formatDeviceList", () => {
  it("prints avfoundation devices by index and by name", () => {
    expect(
      formatDeviceList({
        source: "avfoundation",
        devices: [{ id: "1", name: "USB Audio CODEC" }],
      }).split("\n"),
    ).toEqual([
      "Audio inputs (avfoundation). Set audio.input.device to the index or the exact name (the name survives re-plugging; indexes can shift):",
      "  [1]  device: '1'   or   device: 'USB Audio CODEC'",
    ]);
  });

  it("prints dshow names with their alternative names", () => {
    expect(
      formatDeviceList({
        source: "dshow",
        devices: [
          {
            id: "Line (USB Audio CODEC)",
            name: "Line (USB Audio CODEC)",
            alt: "@device_cm_{X}\\wave_{Y}",
          },
          { id: "Mic", name: "Mic" },
        ],
      }).split("\n"),
    ).toEqual([
      "Audio inputs (DirectShow). Set audio.input.device to the name, or to its alternative name:",
      "  device: 'Line (USB Audio CODEC)'",
      "      or  device: '@device_cm_{X}\\wave_{Y}'",
      "  device: 'Mic'",
    ]);
  });

  it("prints PulseAudio sources with their details, and ALSA ids with their stable names", () => {
    expect(
      formatDeviceList({
        source: "pulse",
        devices: [
          { id: "alsa_input.usb", name: "alsa_input.usb", detail: "s16le 2ch 48000Hz, RUNNING" },
          { id: "plain", name: "plain" },
        ],
      }).split("\n"),
    ).toEqual([
      "Audio sources (PulseAudio/PipeWire). Set audio.input.device to the source name:",
      "  device: 'alsa_input.usb'   # s16le 2ch 48000Hz, RUNNING",
      "  device: 'plain'",
    ]);
    expect(
      formatDeviceList({
        source: "alsa",
        devices: [
          { id: "hw:1,0", name: "USB Audio CODEC", alt: "hw:CARD=CODEC,DEV=0" },
          { id: "hw:2,0", name: "Other" },
        ],
      }).split("\n"),
    ).toEqual([
      "Capture devices (ALSA). Set audio.input.device to the hw: id (the CARD= form survives renumbering):",
      "  device: 'hw:1,0'   or   device: 'hw:CARD=CODEC,DEV=0'   # USB Audio CODEC",
      "  device: 'hw:2,0'   # Other",
    ]);
  });

  it("says when nothing was found, with the listing's last complaint", () => {
    expect(
      formatDeviceList({ source: "alsa", devices: [], warning: "pactl: not installed" }).split(
        "\n",
      ),
    ).toEqual([
      "Capture devices (ALSA). Set audio.input.device to the hw: id (the CARD= form survives renumbering):",
      "  (none found)",
      "  note: pactl: not installed",
    ]);
  });

  it("quotes for YAML so backslashes and quotes survive", () => {
    expect(yamlQuote("it's")).toBe("'it''s'");
    expect(yamlQuote("C:\\x")).toBe("'C:\\x'");
  });
});

describe("turjuman devices", () => {
  it("lists the inputs and checks the configured device against them", async () => {
    const { loaded } = configured(
      "audio:\n  input:\n    kind: device\n    device: USB Audio CODEC\n",
    );
    const run = runner({ ffmpeg: stderr(AVFOUNDATION) });
    const c = capture();
    expect(await devicesCommand([], c.io, loaded, { platform: "darwin", run })).toBe(0);
    expect(run.calls[0]?.slice(0, 3)).toEqual(["ffmpeg", "-hide_banner", "-f"]);
    expect(c.out[0]?.split("\n").slice(1)).toEqual([
      "  [0]  device: '0'   or   device: 'MacBook Pro Microphone'",
      "  [1]  device: '1'   or   device: 'USB Audio CODEC'",
    ]);
    expect(c.out[1]).toBe(
      "configured audio.input.device: 'USB Audio CODEC' → found (USB Audio CODEC)",
    );
    expect(c.err).toEqual([]);
  });

  it("says when the configured device is not listed", async () => {
    const { loaded } = configured(
      "audio:\n  ffmpegPath: /opt/ffmpeg/bin/ffmpeg\n  input:\n    kind: device\n    device: Gone mic\n",
    );
    const run = runner({ "/opt/ffmpeg/bin/ffmpeg": stderr(AVFOUNDATION) });
    const c = capture();
    expect(await devicesCommand([], c.io, loaded, { platform: "darwin", run })).toBe(0);
    expect(c.out[1]).toBe("configured audio.input.device: 'Gone mic' → NOT in this list");
  });

  it("notes that capture is off (kind none) and still lists, with monitors on request", async () => {
    const { loaded } = configured();
    const pactl: RunResult = {
      code: 0,
      stdout:
        "1\talsa_input.usb\tmodule\ts16le 2ch 48000Hz\tIDLE\n2\talsa_output.x.monitor\tmodule\ts16le 2ch 48000Hz\tIDLE\n",
      stderr: "",
    };
    const c = capture();
    expect(
      await devicesCommand([], c.io, loaded, { platform: "linux", run: runner({ pactl }) }),
    ).toBe(0);
    expect(c.out[0]).toBe("device capture disabled (audio.input.kind: none)");
    expect(c.out[1]).not.toContain("monitor");
    expect(c.out).toHaveLength(2);
    c.clear();
    expect(
      await devicesCommand(["--monitors"], c.io, loaded, {
        platform: "linux",
        run: runner({ pactl }),
      }),
    ).toBe(0);
    expect(c.out[1]).toContain("device: 'alsa_output.x.monitor'");
  });

  it("points to the host's bridge script for network input instead of listing", async () => {
    const { loaded } = configured(
      "audio:\n  input:\n    kind: network\n    network:\n      port: 7100\n",
    );
    const run = runner({});
    const c = capture();
    expect(await devicesCommand([], c.io, loaded, { platform: "linux", run })).toBe(0);
    expect(c.out).toEqual([bridgeListHint(7100)]);
    expect(c.out[0]).toContain("tcp port 7100");
    expect(c.out[0]).toContain("bash scripts/audio-bridge.sh --list");
    expect(run.calls).toEqual([]);
  });

  it("lists with the ffmpeg on PATH when there is no config", async () => {
    const run = runner({
      arecord: {
        code: 0,
        stdout: "card 1: CODEC [USB Audio CODEC], device 0: USB Audio [USB Audio]\n",
        stderr: "",
      },
    });
    const c = capture();
    expect(await devicesCommand([], c.io, null, { platform: "linux", run })).toBe(0);
    expect(c.err).toEqual(["turjuman devices: config not loaded; listing with the ffmpeg on PATH"]);
    expect(c.out[0]).toContain("device: 'hw:1,0'   or   device: 'hw:CARD=CODEC,DEV=0'");
    expect(c.out[0]).toContain("note: pactl: not installed");
  });

  it("fails with exit code 1 when nothing can list devices", async () => {
    const { loaded } = configured();
    const c = capture();
    expect(await devicesCommand([], c.io, loaded, { platform: "darwin", run: runner({}) })).toBe(1);
    expect(c.err).toEqual([
      "turjuman devices: ffmpeg (ffmpeg) not found: install it or set audio.ffmpegPath",
    ]);
  });

  it("prints its help and refuses a config file that does not exist", async () => {
    const c = capture();
    expect(await devicesCommand(["-h"], c.io, null)).toBe(0);
    expect(c.out).toEqual([DEVICES_HELP]);
    const missing = join(tempDir(), "nope.yaml");
    expect(await devicesCommand(["--config", missing], c.io, null)).toBe(2);
    expect(c.err).toEqual([
      `turjuman devices: Config file not found: ${missing}\n\n${DEVICES_HELP}`,
    ]);
  });

  it("reads another config file with --config", async () => {
    const dir = tempDir();
    const file = join(dir, "other.yaml");
    writeFileSync(
      file,
      `languagesFile: ${LANGUAGES_FILE}\naudio:\n  input:\n    kind: network\n    network:\n      port: 7300\n`,
    );
    vi.stubEnv("CONFIG_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await devicesCommand(["--config", file], c.io, null)).toBe(0);
    expect(c.out).toEqual([bridgeListHint(7300)]);
  });

  it("runCli loads the config itself, and refuses an unknown option with the usage", async () => {
    const { dir } = configured("audio:\n  input:\n    kind: network\n");
    vi.stubEnv("CONFIG_DIR", dir);
    vi.stubEnv("DATA_DIR", dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const c = capture();
    expect(await runCli(["devices"], c.io)).toBe(0);
    expect(c.out).toEqual([bridgeListHint(7000)]);
    c.clear();
    expect(await runCli(["devices", "--all"], c.io)).toBe(2);
    expect(c.errText()).toBe(`turjuman devices: Unknown option '--all'.\n\n${DEVICES_HELP}`);
    c.clear();
    expect(await runCli(["devices", "list"], c.io)).toBe(2);
    expect(c.errText()).toMatch(/^turjuman devices: Unexpected argument 'list'/);
  });
});
