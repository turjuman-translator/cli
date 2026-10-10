import type { LoadedConfig } from "../config.js";
import type {
  Health,
  LatencyStats,
  SessionInfo,
  SessionSummary,
  Status,
} from "../shared/protocol.js";
import { apiEnv, callApi, serviceUrl } from "./http.js";
import type { CliIo } from "./index.js";

function ms(stats: LatencyStats): string {
  if (stats.n === 0 || stats.p50Ms === null) return "–";
  return `p50 ${(stats.p50Ms / 1000).toFixed(1)} s / p95 ${((stats.p95Ms ?? 0) / 1000).toFixed(1)} s (n=${stats.n})`;
}

function duration(msTotal: number): string {
  const s = Math.floor(msTotal / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** The local session's input: its name, and what audio "ok" means for it. */
const INPUTS: Readonly<Record<SessionInfo["inputKind"], { name: string; ok: string }>> = {
  device: { name: "device", ok: "device connected" },
  network: { name: "audio bridge", ok: "bridge connected" },
  file: { name: "file", ok: "playing the file" },
  page: { name: "page", ok: "page connected" },
};

function inputOf(session: SessionInfo): { name: string; ok: string } {
  // `turjuman replay` plays a provider log (never an audio file) over a silent input.
  if (session.file?.endsWith(".jsonl") === true)
    return { name: "file", ok: "replay: silent input" };
  return INPUTS[session.inputKind];
}

function localLines(status: Status): string[] {
  const { session, audio } = status;
  const input = session === undefined ? null : { ...inputOf(session), session };
  const lines = [
    `Local session: ${status.state}${input === null ? "" : ` (${input.name}, ${input.session.from}→${input.session.to}, id ${input.session.id})`}`,
    `  engine: ${status.tracks.map((t) => `${t.track} ${t.provider}`).join(", ") || "–"}`,
    `  audio: ${audio.state}${audio.state === "ok" && input !== null ? ` (${input.ok})` : ""}  level: ${audio.rmsDbfs === null ? "–" : `${audio.rmsDbfs.toFixed(1)} dBFS`}${audio.noSignal ? "  NO SIGNAL" : ""}`,
    `  latency: ${ms(status.latency)}`,
  ];
  if (status.error) lines.push(`  error: ${status.error}`);
  if (audio.lastStderr) lines.push(`  ffmpeg: ${audio.lastStderr}`);
  return lines;
}

function sessionLine(s: SessionSummary): string {
  return `  ${s.id}  ${s.kind.padEnd(6)} ${`${s.from}→${s.to}`.padEnd(9)} ${s.engines.join("+").padEnd(13)} ${(s.keyLabel ?? "-").padEnd(14)} ${duration(s.durationMs).padStart(7)}  ${s.streamedMinutes.toFixed(1)} min  ${ms(s.latency)}  ${s.state}`;
}

export function formatHealth(h: Health): string {
  const lines = [
    `Service: up (v${h.version}, uptime ${duration(h.uptimeMs)}, exposure ${h.exposure})`,
    ...(h.local ? localLines(h.local) : ["Local session: none"]),
    `Active sessions: ${h.sessions.length}`,
    ...h.sessions.map(sessionLine),
  ];
  return lines.join("\n");
}

/** `turjuman status`: a human-readable summary of /health (used by `make status`). */
export async function statusCommand(io: CliIo, loaded: LoadedConfig | null): Promise<number> {
  const base = serviceUrl(loaded);
  try {
    // The operator's token, as ctl sends it: a hosted server's /health shows its sessions only
    // to the operator.
    const res = await callApi(base, "GET", "/health", undefined, apiEnv(loaded));
    if (!res.ok) {
      io.err(`Service at ${base} answered HTTP ${res.status}`);
      return 1;
    }
    io.out(formatHealth(res.body as Health));
    return 0;
  } catch (err) {
    io.err(`Service not reachable at ${base}: ${(err as Error).message}`);
    return 1;
  }
}
