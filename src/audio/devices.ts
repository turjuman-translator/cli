// Audio input device listing for `turjuman devices`: parsers for the ffmpeg
// dshow / avfoundation listings, `pactl list short sources` and `arecord -l`, plus a runner.
import { spawn } from "node:child_process";

export type DeviceSource = "dshow" | "avfoundation" | "pulse" | "alsa";

export interface AudioDevice {
  /** The value to put in audio.input.device. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** An alternative value that also works in audio.input.device (dshow alternative name, stable ALSA name). */
  alt?: string;
  /** Extra information for display (pulse sample spec and state). */
  detail?: string;
}

export interface DeviceList {
  source: DeviceSource;
  devices: AudioDevice[];
  /** Why the list may be empty or incomplete (last error line of the listing command). */
  warning?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell; resolves null when it cannot be started (e.g. not installed). */
export type CommandRunner = (command: string, args: string[]) => Promise<RunResult | null>;

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** `[dshow @ 0000…] rest` → rest; lines without a log prefix are returned trimmed. */
function stripLogPrefix(line: string): { prefix: string | null; rest: string } {
  const m = /^\[([^\]@]+?)\s*@\s*[^\]]*\]\s?(.*)$/.exec(line);
  if (m === null) return { prefix: null, rest: line };
  const [, prefix = "", rest = ""] = m;
  return { prefix: prefix.trim(), rest };
}

/**
 * ffmpeg `-list_devices true -f dshow -i dummy` stderr → audio devices with their alternative
 * names. Handles the current format (`"Name" (audio)` / `(audio, video)`; `(video)` and
 * `(none)` are skipped) and the older one with "DirectShow audio devices" section headers.
 */
export function parseDshowDevices(stderr: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let section: "audio" | "video" | null = null;
  let current: AudioDevice | null = null;
  for (const raw of lines(stderr)) {
    const { prefix, rest } = stripLogPrefix(raw);
    if (prefix !== "dshow") continue;
    const text = rest.trim();
    if (/^DirectShow audio devices/i.test(text)) {
      section = "audio";
      current = null;
      continue;
    }
    if (/^DirectShow video devices/i.test(text)) {
      section = "video";
      current = null;
      continue;
    }
    const alt = /^Alternative name\s+"(.*)"$/.exec(text);
    if (alt !== null) {
      const [, altName = ""] = alt;
      if (current !== null && current.alt === undefined) current.alt = altName;
      continue;
    }
    const typed = /^"(.*)"\s+\(([^()]*)\)$/.exec(text);
    if (typed !== null) {
      const [, name = "", kindList = ""] = typed;
      const kinds = kindList.split(",").map((k) => k.trim().toLowerCase());
      current = kinds.includes("audio") ? { id: name, name } : null;
      if (current !== null) devices.push(current);
      continue;
    }
    const legacy = /^"(.*)"$/.exec(text);
    if (legacy !== null) {
      const [, name = ""] = legacy;
      current = section === "audio" ? { id: name, name } : null;
      if (current !== null) devices.push(current);
      continue;
    }
    current = null;
  }
  return devices;
}

/**
 * ffmpeg `-f avfoundation -list_devices true -i ""` stderr → audio devices (id = index).
 * Tolerates a trailing ` [uid:…] [serial:…]` suffix. The listing command itself exits
 * non-zero ("Input/output error"); that is expected.
 */
export function parseAvfoundationDevices(stderr: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const raw of lines(stderr)) {
    const { prefix, rest } = stripLogPrefix(raw);
    if (prefix === null || !/avfoundation/i.test(prefix)) {
      if (prefix !== null) inAudio = false;
      continue;
    }
    const text = rest.trim();
    if (/^AVFoundation audio devices:?$/i.test(text)) {
      inAudio = true;
      continue;
    }
    if (/^AVFoundation .*devices:?$/i.test(text)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = /^\[(\d+)\]\s+(.*)$/.exec(text);
    if (m === null) continue;
    const [, index = "", label = ""] = m;
    const name = label.replace(/(?:\s+\[[A-Za-z_]+:[^\]]*\])+$/, "").trim();
    devices.push({ id: index, name });
  }
  return devices;
}

/** `pactl list short sources` (index, name, driver, sample spec, state; tab-separated). */
export function parsePactlSources(
  stdout: string,
  opts: { includeMonitors?: boolean } = {},
): AudioDevice[] {
  const devices: AudioDevice[] = [];
  for (const raw of lines(stdout)) {
    if (raw.trim() === "") continue;
    const cols = raw.split("\t").map((c) => c.trim());
    const name = cols[1];
    if (name === undefined || name === "") continue;
    if (name.endsWith(".monitor") && opts.includeMonitors !== true) continue;
    const detail = [cols[3], cols[4]].filter((c) => c !== undefined && c !== "").join(", ");
    devices.push(detail === "" ? { id: name, name } : { id: name, name, detail });
  }
  return devices;
}

/** `arecord -l` → `hw:<card>,<device>` ids (alt: the stable `hw:CARD=<id>,DEV=<n>` form). */
export function parseArecordDevices(stdout: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const re = /^card\s+(\d+):\s*(\S+)\s+\[(.*?)\],\s*device\s+(\d+):\s*(.*?)\s+\[(.*?)\]\s*$/;
  for (const raw of lines(stdout)) {
    const m = re.exec(raw.trim());
    if (m === null) continue;
    const [, card = "", cardId = "", cardName = "", dev = "", , devName = ""] = m;
    devices.push({
      id: `hw:${card},${dev}`,
      name: devName === "" || devName === cardName ? cardName : `${cardName}: ${devName}`,
      alt: `hw:CARD=${cardId},DEV=${dev}`,
    });
  }
  return devices;
}

/** Default runner: spawn without a shell, collect output, give up after `timeoutMs`. */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<RunResult | null> {
  return new Promise((resolveRun) => {
    let settled = false;
    const done = (result: RunResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolveRun(null);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function lastLine(text: string): string | undefined {
  const all = lines(text)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return all[all.length - 1];
}

export interface ListDevicesOptions {
  platform: NodeJS.Platform;
  ffmpegPath: string;
  run?: CommandRunner;
  /** Linux: include `*.monitor` (playback loopback) sources. */
  includeMonitors?: boolean;
}

/**
 * List audio inputs the way ffmpeg will open them: dshow on Windows, avfoundation on macOS,
 * PulseAudio/PipeWire (`pactl`, falling back to `arecord -l`) elsewhere.
 * Throws when no listing tool can be run at all (e.g. ffmpeg not found).
 */
export async function listDevices(opts: ListDevicesOptions): Promise<DeviceList> {
  const run = opts.run ?? ((cmd, args) => runCommand(cmd, args));
  const missing = (what: string): Error =>
    new Error(`${what} not found: install it or set audio.ffmpegPath`);

  if (opts.platform === "win32" || opts.platform === "darwin") {
    const dshow = opts.platform === "win32";
    const args = dshow
      ? ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]
      : ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""];
    const result = await run(opts.ffmpegPath, args);
    if (result === null) throw missing(`ffmpeg (${opts.ffmpegPath})`);
    // Both listings "fail" by design (no input is opened), so the exit code is ignored.
    const devices = dshow
      ? parseDshowDevices(result.stderr)
      : parseAvfoundationDevices(result.stderr);
    const out: DeviceList = { source: dshow ? "dshow" : "avfoundation", devices };
    const warning = lastLine(result.stderr);
    if (devices.length === 0 && warning !== undefined) out.warning = warning;
    return out;
  }

  const pactl = await run("pactl", ["list", "short", "sources"]);
  if (pactl !== null && pactl.code === 0) {
    const devices = parsePactlSources(pactl.stdout, { includeMonitors: opts.includeMonitors });
    return { source: "pulse", devices };
  }
  const arecord = await run("arecord", ["-l"]);
  if (arecord === null && pactl === null) {
    throw new Error("neither pactl (PulseAudio/PipeWire) nor arecord (ALSA) is installed");
  }
  const devices = arecord === null ? [] : parseArecordDevices(arecord.stdout);
  const out: DeviceList = { source: "alsa", devices };
  const reasons: string[] = [];
  const pactlWhy = pactl === null ? "not installed" : lastLine(pactl.stderr);
  if (pactlWhy !== undefined) reasons.push(`pactl: ${pactlWhy}`);
  const arecordWhy = arecord === null ? "not installed" : lastLine(arecord.stderr);
  if (devices.length === 0 && arecordWhy !== undefined) reasons.push(`arecord: ${arecordWhy}`);
  if (reasons.length > 0) out.warning = reasons.join("; ");
  return out;
}

/** Whether `configured` (audio.input.device) names one of the listed devices. */
export function findDevice(list: DeviceList, configured: string): AudioDevice | undefined {
  const want = list.source === "avfoundation" ? configured.replace(/^:/, "") : configured;
  const wantDshow = list.source === "dshow" ? want.replace(/^audio=/, "") : want;
  return list.devices.find(
    (d) =>
      d.id === wantDshow || d.name === wantDshow || (d.alt !== undefined && d.alt === wantDshow),
  );
}
