// HTTP access to a session's blocks and exports:
//   GET /api/sessions/:id/blocks?before=<seq>&limit=<n>   → {blocks, hasMore}
//   GET /api/sessions/:id/export.{txt,md,srt}
// Remote pages pass their access key (`key=`) or the admin token (`token=`, also as Bearer).
import { type BlocksPage, type ExportLinks, parseBlocksPage } from "./blocks.js";

export interface ApiAuth {
  key: string | null;
  token: string | null;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** Session metadata that comes with a blocks page (server: {sessionId, live, from, to, …}). */
export interface BlocksMeta {
  live: boolean | null;
  from: string | null;
  to: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export type BlocksPageWithMeta = BlocksPage & { meta: BlocksMeta };

function parseMeta(data: unknown): BlocksMeta {
  const d = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    live: typeof d.live === "boolean" ? d.live : null,
    from: str(d.from),
    to: str(d.to),
    startedAt: num(d.startedAt),
    endedAt: num(d.endedAt),
  };
}

export function authFrom(q: URLSearchParams): ApiAuth {
  return { key: q.get("key") || null, token: q.get("token") || null };
}

function authQuery(auth: ApiAuth, q = new URLSearchParams()): URLSearchParams {
  if (auth.key) q.set("key", auth.key);
  if (auth.token) q.set("token", auth.token);
  return q;
}

/** One page of blocks (newest first page when `before` is null). Throws HttpError on 4xx/5xx. */
export async function fetchBlocks(
  sessionId: string,
  before: number | null,
  limit: number,
  auth: ApiAuth,
): Promise<BlocksPageWithMeta> {
  const q = authQuery(auth, new URLSearchParams({ limit: String(limit) }));
  if (before !== null) q.set("before", String(before));
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/blocks?${q}`, {
    headers: {
      Accept: "application/json",
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
  });
  if (!res.ok) throw new HttpError(res.status);
  const data: unknown = await res.json();
  const page = parseBlocksPage(data);
  if (!page) throw new HttpError(502);
  return { ...page, meta: parseMeta(data) };
}

/** Blocks loader for BlockView history (null on failure → the view backs off). */
export function olderLoader(auth: ApiAuth) {
  return async (sessionId: string, beforeSeq: number): Promise<BlocksPage | null> => {
    try {
      return await fetchBlocks(sessionId, beforeSeq, 100, auth);
    } catch {
      return null;
    }
  };
}

export function exportLinks(sessionId: string, auth: ApiAuth): ExportLinks {
  const qs = authQuery(auth).toString();
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/export`;
  const suffix = qs ? `?${qs}` : "";
  return { txt: `${base}.txt${suffix}`, md: `${base}.md${suffix}`, srt: `${base}.srt${suffix}` };
}
