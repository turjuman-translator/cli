import type { LoadedConfig } from "../config.js";
import type { SessionSummary } from "../shared/protocol.js";
import { type ApiResult, apiEnv, callApi, messageOf, serviceUrl } from "./http.js";
import type { CliIo } from "./index.js";

export const CTL_HELP = `turjuman ctl <action> [args]
  start [--file <path>]      start the local session (file = rehearsal replay)
  stop                       stop the local session (writes transcripts + SRTs)
  clear                      clear captions on all screens
  kill <sessionId>           stop one session (any kind)
  sessions                   list active sessions
Env: TOKEN=<admin token> (default: server.token from the config); CAPTIONS_URL to override the URL.`;

function report(io: CliIo, res: ApiResult): number {
  const text = messageOf(res.body);
  if (res.ok) io.out(text === "" || text === "null" ? "ok" : text);
  else io.err(`HTTP ${res.status}: ${text}`);
  return res.ok ? 0 : 1;
}

/** `turjuman ctl …`: thin client for the HTTP API, used by the Makefile inside the container. */
export async function ctlCommand(
  args: string[],
  io: CliIo,
  loaded: LoadedConfig | null,
): Promise<number> {
  const [action, ...rest] = args;
  const base = serviceUrl(loaded);
  const env = apiEnv(loaded);
  const api = (method: "GET" | "POST", path: string, body?: unknown) =>
    callApi(base, method, path, body, env);
  try {
    switch (action) {
      case "start": {
        const i = rest.indexOf("--file");
        const file = i >= 0 ? rest[i + 1] : undefined;
        return report(
          io,
          await api(
            "POST",
            "/api/session/start",
            file ? { source: "file", file } : { source: "device" },
          ),
        );
      }
      case "stop": {
        const res = await api("POST", "/api/session/stop");
        if (res.status === 409) {
          io.out(`Nothing to stop: ${messageOf(res.body)}`);
          return 0;
        }
        return report(io, res);
      }
      case "clear":
        return report(io, await api("POST", "/api/captions/clear", {}));
      case "kill": {
        const id = rest[0];
        if (id === undefined || id === "") break;
        return report(io, await api("POST", `/api/sessions/${encodeURIComponent(id)}/stop`));
      }
      case "sessions": {
        const res = await api("GET", "/api/sessions");
        if (!res.ok) return report(io, res);
        const list = (Array.isArray(res.body) ? res.body : []) as SessionSummary[];
        if (list.length === 0) io.out("No active sessions.");
        for (const s of list) {
          io.out(
            `${s.id}  ${s.kind}  ${s.from}→${s.to}  ${s.engines.join("+")}  ${s.keyLabel ?? "-"}  ${Math.round(s.durationMs / 1000)} s  ${s.streamedMinutes.toFixed(1)} min  ${s.state}`,
          );
        }
        return 0;
      }
      default:
        if (action === undefined) break;
        io.err(`ctl: unknown action ${action}\n\n${CTL_HELP}`);
        return 2;
    }
  } catch (err) {
    io.err(`Service not reachable at ${base}: ${(err as Error).message}`);
    return 1;
  }
  io.err(CTL_HELP);
  return 2;
}
