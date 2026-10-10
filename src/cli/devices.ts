// `turjuman devices`: list audio inputs exactly as
// audio.input.device must name them in config.yaml.
import { parseArgs } from "node:util";
import {
  type CommandRunner,
  type DeviceList,
  type DeviceSource,
  findDevice,
  listDevices,
} from "../audio/devices.js";
import { type LoadedConfig, loadConfig } from "../config.js";
import { isParseArgsError } from "./usage.js";

export interface DevicesIo {
  out(text: string): void;
  err(text: string): void;
}

export interface DevicesDeps {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

export const DEVICES_HELP = `turjuman devices [--config <file>] [--monitors]

  Lists the audio inputs for server-side capture, each as a line to paste into config.yaml
  (audio.input.device). --monitors also lists PulseAudio monitor sources.`;

/** YAML single-quoted scalar: safe for backslashes (dshow alternative names), colons and digits. */
export function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** With network input the devices live on the host, behind the bridge. */
export function bridgeListHint(port: number): string {
  return [
    `audio.input.kind is "network": audio comes from the host's audio bridge on tcp port ${port}.`,
    "List the input devices on the HOST (not here) with the bridge script:",
    "  Windows:        powershell -ExecutionPolicy Bypass -File scripts\\audio-bridge.ps1 -List",
    "  macOS / Linux:  bash scripts/audio-bridge.sh --list",
    "  (or: make bridge-list)",
    'Then run the bridge with that device, e.g. make bridge DEVICE="Line (USB Audio CODEC)".',
  ].join("\n");
}

const HEADERS: Record<DeviceSource, string> = {
  avfoundation:
    "Audio inputs (avfoundation). Set audio.input.device to the index or the exact name (the name survives re-plugging; indexes can shift):",
  dshow:
    "Audio inputs (DirectShow). Set audio.input.device to the name, or to its alternative name:",
  pulse: "Audio sources (PulseAudio/PipeWire). Set audio.input.device to the source name:",
  alsa: "Capture devices (ALSA). Set audio.input.device to the hw: id (the CARD= form survives renumbering):",
};

/** One block per listing, each device as a ready-to-paste `device: '…'` line. */
export function formatDeviceList(list: DeviceList): string {
  const lines = [HEADERS[list.source]];
  if (list.devices.length === 0) lines.push("  (none found)");
  for (const d of list.devices) {
    switch (list.source) {
      case "avfoundation":
        lines.push(`  [${d.id}]  device: ${yamlQuote(d.id)}   or   device: ${yamlQuote(d.name)}`);
        break;
      case "dshow":
        lines.push(`  device: ${yamlQuote(d.name)}`);
        if (d.alt !== undefined) lines.push(`      or  device: ${yamlQuote(d.alt)}`);
        break;
      case "pulse":
        lines.push(
          `  device: ${yamlQuote(d.id)}${d.detail !== undefined ? `   # ${d.detail}` : ""}`,
        );
        break;
      case "alsa":
        lines.push(
          `  device: ${yamlQuote(d.id)}${d.alt !== undefined ? `   or   device: ${yamlQuote(d.alt)}` : ""}   # ${d.name}`,
        );
        break;
    }
  }
  if (list.warning !== undefined) lines.push(`  note: ${list.warning}`);
  return lines.join("\n");
}

export async function devicesCommand(
  args: string[],
  io: DevicesIo,
  loaded: LoadedConfig | null,
  deps: DevicesDeps = {},
): Promise<number> {
  let includeMonitors: boolean;
  let config = loaded;
  try {
    const { values } = parseArgs({
      args,
      options: {
        monitors: { type: "boolean", default: false },
        config: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      io.out(DEVICES_HELP);
      return 0;
    }
    includeMonitors = values.monitors;
    if (values.config !== undefined) config = loadConfig({ configFile: values.config });
  } catch (err) {
    if (isParseArgsError(err)) throw err; // exit 2 with the usage (index.ts)
    io.err(
      `turjuman devices: ${err instanceof Error ? err.message : String(err)}\n\n${DEVICES_HELP}`,
    );
    return 2;
  }

  const audio = config?.config.audio ?? null;
  if (audio === null) {
    io.err("turjuman devices: config not loaded; listing with the ffmpeg on PATH");
  } else if (audio.input.kind === "network") {
    io.out(bridgeListHint(audio.input.network.port));
    return 0;
  } else if (audio.input.kind === "none") {
    io.out("device capture disabled (audio.input.kind: none)");
  }

  let list: DeviceList;
  try {
    list = await listDevices({
      platform: deps.platform ?? process.platform,
      ffmpegPath: audio?.ffmpegPath ?? "ffmpeg",
      run: deps.run,
      includeMonitors,
    });
  } catch (err) {
    io.err(`turjuman devices: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.out(formatDeviceList(list));

  if (audio !== null && audio.input.kind === "device") {
    const configured = `audio.input.device: ${yamlQuote(audio.input.device)}`;
    const found = findDevice(list, audio.input.device);
    io.out(
      found !== undefined
        ? `configured ${configured} → found (${found.name})`
        : `configured ${configured} → NOT in this list`,
    );
  }
  return 0;
}
