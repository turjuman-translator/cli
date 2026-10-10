// Checks an API key with its provider by calling the free, unbilled list-models
// endpoint. Used by the server (PUT /api/org/keys/:provider) and by `turjuman setup`. The key
// never appears in a message: errors name the provider and the HTTP status only.
import type { KeyProvider } from "../shared/protocol.js";

export type KeyCheck =
  /** The provider accepted the key. */
  | { result: "ok" }
  /** The provider refused it (401/403). */
  | { result: "rejected"; message: string }
  /** The provider could not be asked (network, timeout, 5xx): store it, but say it is unchecked. */
  | { result: "unchecked"; message: string };

export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number }>;

export const PROVIDER_NAMES: Record<KeyProvider, string> = { soniox: "Soniox" };

const ENDPOINT: Record<
  KeyProvider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  soniox: (key) => ({
    url: "https://api.soniox.com/v1/models",
    headers: { Authorization: `Bearer ${key}` },
  }),
};

/** A plausible key: printable ASCII without spaces, 16–512 characters. */
export function keyShapeProblem(key: string): string | null {
  if (key.length < 16) return "This key is too short";
  if (key.length > 512) return "This key is too long";
  if (!/^[\x21-\x7e]+$/.test(key)) return "A key has no spaces or special characters";
  return null;
}

export async function checkProviderKey(
  provider: KeyProvider,
  key: string,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<KeyCheck> {
  const name = PROVIDER_NAMES[provider];
  const shape = keyShapeProblem(key);
  if (shape !== null) return { result: "rejected", message: `${shape}.` };
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const { url, headers } = ENDPOINT[provider](key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal });
    if (res.status >= 200 && res.status < 300) return { result: "ok" };
    if (res.status === 401 || res.status === 403) {
      return {
        result: "rejected",
        message: `${name} did not accept this key (HTTP ${res.status}).`,
      };
    }
    return {
      result: "unchecked",
      message: `${name} answered HTTP ${res.status}; the key was not checked.`,
    };
  } catch {
    return {
      result: "unchecked",
      message: `${name} could not be reached; the key was not checked.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
