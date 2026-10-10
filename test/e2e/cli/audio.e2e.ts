// The audio commands: `devices` (the real ffmpeg of this computer), `run --dry-run` (a WAV made
// here, or the audio bridge) and `record` (from the audio bridge: a fake bridge streams a tone over
// TCP, as scripts/audio-bridge.sh would from a sound card).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { turjuman } from "../helpers/cli.js";
import {
  audioBridge,
  baseYaml,
  Cleanup,
  type CliInstall,
  cliInstall,
  spawnCli,
  waitUntil,
} from "../helpers/cli-tools.js";
import { freePort, writeWav } from "../helpers/instance.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

async function install(opts: Parameters<typeof cliInstall>[0] = {}): Promise<CliInstall> {
  const inst = await cliInstall(opts);
  cleanup.add(() => inst.remove());
  return inst;
}

/** An install whose audio input is the audio bridge on a free port. */
async function bridged(): Promise<{ inst: CliInstall; bridgePort: number }> {
  const bridgePort = await freePort();
  const inst = await install({
    yaml: (port) =>
      baseYaml(
        port,
        `audio:\n  input:\n    kind: network\n    network:\n      port: ${bridgePort}\n`,
      ),
  });
  return { inst, bridgePort };
}

/** The ffmpeg input format of this platform's sound cards. */
const HEADER: Partial<Record<NodeJS.Platform, RegExp>> = {
  darwin:
    /^Audio inputs \(avfoundation\)\. Set audio\.input\.device to the index or the exact name/m,
  linux: /^(Audio sources \(PulseAudio\/PipeWire\)|Capture devices \(ALSA\))\. /m,
  win32: /^Audio inputs \(DirectShow\)\. /m,
};

describe.concurrent("turjuman devices", () => {
  it("devices lists the audio inputs as audio.input.device must name them, and finds the configured one", async ({
    expect,
  }) => {
    const inst = await install();
    const r = await turjuman(inst, ["devices"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.startsWith("device capture disabled (audio.input.kind: none)\n")).toBe(true);
    const header = HEADER[process.platform];
    if (header !== undefined) expect(r.stdout).toMatch(header);
    const devices = r.stdout.split("\n").filter((l) => /^ {2}(\[\d+\] {2})?device: '/.test(l));
    if (devices.length === 0) expect(r.stdout).toContain("  (none found)");

    const missing = await install({
      yaml: (port) =>
        baseYaml(port, "audio:\n  input:\n    kind: device\n    device: 'No Such Input 123'\n"),
    });
    const notFound = await turjuman(missing, ["devices"]);
    expect(notFound.code).toBe(0);
    expect(notFound.stdout).toContain(
      "configured audio.input.device: 'No Such Input 123' → NOT in this list\n",
    );

    // The first input of this computer, by the name config.yaml would give it.
    const name = /device: '((?:[^']|'')+)'$/.exec(devices[0] ?? "")?.[1]?.replaceAll("''", "'");
    if (name !== undefined) {
      const found = await install({
        yaml: (port) =>
          baseYaml(
            port,
            `audio:\n  input:\n    kind: device\n    device: '${name.replaceAll("'", "''")}'\n`,
          ),
      });
      const r2 = await turjuman(found, ["devices"]);
      expect(r2.stdout).toMatch(/→ found \(.+\)\n$/);
    }
  });

  it("devices --config with the audio bridge says to list the inputs on the host; --monitors lists too", async ({
    expect,
  }) => {
    const inst = await install();
    const net = inst.file(
      "bridge.yaml",
      baseYaml(inst.port, "audio:\n  input:\n    kind: network\n    network:\n      port: 7123\n"),
    );
    expect(await turjuman(inst, ["devices", "--config", net])).toMatchObject({
      code: 0,
      stderr: "",
      stdout:
        'audio.input.kind is "network": audio comes from the host\'s audio bridge on tcp port 7123.\n' +
        "List the input devices on the HOST (not here) with the bridge script:\n" +
        "  Windows:        powershell -ExecutionPolicy Bypass -File scripts\\audio-bridge.ps1 -List\n" +
        "  macOS / Linux:  bash scripts/audio-bridge.sh --list\n" +
        "  (or: make bridge-list)\n" +
        'Then run the bridge with that device, e.g. make bridge DEVICE="Line (USB Audio CODEC)".\n',
    });
    const monitors = await turjuman(inst, ["devices", "--monitors"]);
    expect(monitors.code).toBe(0);
    const header = HEADER[process.platform];
    if (header !== undefined) expect(monitors.stdout).toMatch(header);
  });

  it("devices fails without ffmpeg (exit 1) and with a missing --config file (exit 2)", async ({
    expect,
  }) => {
    const inst = await install({
      yaml: (port) => baseYaml(port, "audio:\n  ffmpegPath: /nonexistent/ffmpeg\n"),
    });
    expect(await turjuman(inst, ["devices"])).toMatchObject({
      code: 1,
      stderr:
        "turjuman devices: ffmpeg (/nonexistent/ffmpeg) not found: install it or set audio.ffmpegPath\n",
    });
    const missing = await turjuman(inst, ["devices", "--config", "missing.yaml"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(
      /^turjuman devices: Config file not found: .+missing\.yaml\n\nturjuman devices /,
    );
  });
});

describe.concurrent("turjuman run --dry-run", () => {
  it("run --dry-run --file plays a WAV, prints its levels and checks its frames against its duration", async ({
    expect,
  }) => {
    const inst = await install();
    const wav = writeWav(join(inst.dir, "two-seconds.wav"), { seconds: 2, tone: true });
    const r = await turjuman(inst, ["run", "--dry-run", "--file", "two-seconds.wav"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe(
      `dry run (audio and levels only, no provider): file ${realpathSync(wav)}; Ctrl-C to stop\naudio: ok\naudio: ended\n`,
    );
    const levels = r.stdout.split("\n").filter((l) => l.startsWith("rms "));
    expect(levels.length).toBeGreaterThan(0);
    for (const line of levels) {
      expect(line).toMatch(/^rms -1\d\.\d dBFS {2}peak -1\d\.\d dBFS {2}frames \d+$/);
    }
    // 2 s = 20 frames of 100 ms.
    expect(r.stdout).toContain("frames=20 expected≈20.0 (Δ=0.00%)\n");
    // No server: nothing listens on the port.
    expect(r.stdout).not.toContain("Turjuman server running");
  });

  it("run --dry-run listens for the audio bridge, prints the levels and stops on Ctrl-C", async ({
    expect,
  }) => {
    const { inst, bridgePort } = await bridged();
    const run = spawnCli(inst, ["run", "--dry-run"]);
    cleanup.add(() => run.stop("SIGKILL"));
    const bridge = audioBridge(bridgePort);
    cleanup.add(() => bridge.stop());
    await run.waitFor(/^rms .* frames \d+$/m);
    expect(await run.stop("SIGINT")).toEqual({ code: 0, signal: null });
    expect(run.stderr()).toContain(
      `dry run (audio and levels only, no provider): network: listening on tcp port ${bridgePort} for the audio bridge (48000 Hz, 2 ch); Ctrl-C to stop\n`,
    );
    expect(run.stderr()).toContain("audio: ok\n");
    expect(run.stderr()).toMatch(/stopped after \d+ frames\n$/);
  });

  it("run --dry-run refuses to run without an input or with a missing file", async ({ expect }) => {
    const inst = await install();
    expect(await turjuman(inst, ["run", "--dry-run"])).toMatchObject({
      code: 2,
      stdout: "",
      stderr:
        'turjuman run --dry-run: audio.input.kind is "none" (no server-side capture); pass --file <wav> or set audio.input.kind\n',
    });
    const missing = await turjuman(inst, ["run", "--dry-run", "--file", "nope.wav"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^turjuman run --dry-run: file not found: .+\/nope\.wav\n$/);
  });

  it("run --dry-run ends with exit code 1 when ffmpeg cannot read the file", async ({ expect }) => {
    const inst = await install();
    inst.file("broken.wav", "this is not a WAV file at all, just some text\n".repeat(20));
    // It ends by itself (no Ctrl-C), at once: a file that ffmpeg cannot read is not retried.
    const r = await turjuman(inst, ["run", "--dry-run", "--file", "broken.wav"], {
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^dry run \(audio and levels only, no provider\): file .+\/broken\.wav; Ctrl-C to stop\n/,
    );
    expect(r.stderr).toMatch(
      /\nturjuman run --dry-run: ffmpeg could not read the file \(.*Invalid data found when processing input\)\n$/,
    );
    expect(r.stderr).not.toContain("audio: restarting");
  });
});

describe.concurrent("turjuman record", () => {
  /** The format fields of a WAV header. */
  function wavHeader(file: string): {
    riff: string;
    wave: string;
    channels: number;
    rate: number;
    bytes: number;
  } {
    const b = readFileSync(file);
    return {
      riff: b.subarray(0, 4).toString(),
      wave: b.subarray(8, 12).toString(),
      channels: b.readUInt16LE(22),
      rate: b.readUInt32LE(24),
      bytes: b.readUInt32LE(40),
    };
  }

  it("record --out --seconds records the audio bridge to a 48 kHz stereo WAV file", async ({
    expect,
  }) => {
    const { inst, bridgePort } = await bridged();
    const rec = spawnCli(inst, ["record", "--out", "recordings/test.wav", "--seconds", "3"]);
    cleanup.add(() => rec.stop("SIGKILL"));
    const bridge = audioBridge(bridgePort);
    cleanup.add(() => bridge.stop());
    expect(await rec.exited).toEqual({ code: 0, signal: null });
    const out = realpathSync(join(inst.dir, "recordings", "test.wav"));
    expect(rec.stdout()).toContain(`recording network input to ${out} for 3 s\n`);
    expect(rec.stdout()).toMatch(
      new RegExp(`saved ${out.replaceAll(".", "\\.")} \\([1-3]\\.\\d s captured\\)\\n$`),
    );
    const header = wavHeader(out);
    expect(header).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 2, rate: 48_000 });
    // At least a second of audio (4 bytes per frame), however late the bridge connected.
    expect(header.bytes).toBeGreaterThan(48_000 * 4);
  });

  it("record stops on Ctrl-C with a valid WAV file", async ({ expect }) => {
    const { inst, bridgePort } = await bridged();
    const rec = spawnCli(inst, ["record", "--out", "ctrl-c.wav"]);
    cleanup.add(() => rec.stop("SIGKILL"));
    const bridge = audioBridge(bridgePort);
    cleanup.add(() => bridge.stop());
    await rec.waitFor("Ctrl-C to stop");
    // Half a second of audio in the file, then stop like a person would.
    const file = join(inst.dir, "ctrl-c.wav");
    await waitUntil(
      "audio in the file",
      () => existsSync(file) && statSync(file).size > 48_000 * 2,
    );
    expect(await rec.stop("SIGINT")).toEqual({ code: 0, signal: null });
    const out = realpathSync(file);
    expect(rec.stdout()).toMatch(/saved .+ctrl-c\.wav \(\d+\.\d s captured\)\n$/);
    const header = wavHeader(out);
    expect(header).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 2, rate: 48_000 });
    expect(header.bytes).toBeGreaterThan(0);
    expect(readFileSync(out).length).toBe(44 + header.bytes);
  });

  it("record refuses a missing --out and an input it cannot record", async ({ expect }) => {
    const none = await install();
    expect(await turjuman(none, ["record"])).toMatchObject({
      code: 2,
      stderr: "usage: turjuman record --out <file.wav> [--seconds n]\n",
    });
    expect(await turjuman(none, ["record", "--out", "x.wav"])).toMatchObject({
      code: 2,
      stderr: "turjuman record needs audio.input.kind device or network in config.yaml\n",
    });
    const file = await install({
      yaml: (port) => baseYaml(port, "audio:\n  input:\n    kind: file\n    path: a.wav\n"),
    });
    expect(await turjuman(file, ["record", "--out", "x.wav"])).toMatchObject({
      code: 2,
      stderr: "turjuman record needs audio.input.kind device or network in config.yaml\n",
    });
  });

  it.skip("record --out from a sound card (audio.input.kind: device) needs a real input device and the microphone permission of this computer", () => {
    // The bridge tests above cover record's options; only the capture from a device is left out.
  });
});
