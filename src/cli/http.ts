import type { LoadedConfig } from "../config.js";

/** Base URL of the local Turjuman server (the CLI always talks to it on loopback). */
export function serviceUrl(
  loaded: LoadedConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.CAPTIONS_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv.replace(/\/$/, "");
  const port = loaded?.config.server.port ?? 8765;
  return `http://127.0.0.1:${port}`;
}

/**
 * process.env with TOKEN defaulting to `server.token` from the config: the CLI runs next to the
 * service (natively or inside the container), so it may use the admin token it can already read.
 */
export function apiEnv(
  loaded: LoadedConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const token = env.TOKEN ?? env.CAPTIONS_TOKEN;
  const configured = loaded?.config.server.token ?? "";
  if ((token === undefined || token === "") && configured !== "") {
    return { ...env, TOKEN: configured };
  }
  return env;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Call the service API; adds `Authorization: Bearer $TOKEN` when TOKEN is set (exposure lan/public). */
export async function callApi(
  base: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  const token = env.TOKEN ?? env.CAPTIONS_TOKEN;
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
  if (method === "POST") headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // plain-text body
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** The `message` field of an API reply, or the raw body. */
export function messageOf(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const m = (body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error;
    if (typeof m === "string") return m;
    return JSON.stringify(body);
  }
  return String(body ?? "");
}
