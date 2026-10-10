import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkProviderKey,
  type FetchLike,
  keyShapeProblem,
  PROVIDER_NAMES,
} from "../../src/accounts/provider-check.js";

const KEY = "soniox-test-key-0123456789abcdef";

interface Call {
  url: string;
  headers: Record<string, string> | undefined;
  signal: AbortSignal;
}

/** A provider that answers every request with `status`, recording what it was asked. */
function answering(status: number): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, signal: init.signal });
      return { status };
    },
  };
}

describe("checking an API key with its provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("names Soniox as the only provider", () => {
    expect(PROVIDER_NAMES).toEqual({ soniox: "Soniox" });
  });

  it("refuses keys that cannot be keys without asking the provider", async () => {
    expect(keyShapeProblem("short")).toBe("This key is too short");
    expect(keyShapeProblem("x".repeat(513))).toBe("This key is too long");
    expect(keyShapeProblem("has a space in it 0123")).toBe(
      "A key has no spaces or special characters",
    );
    expect(keyShapeProblem("tab\there-0123456789")).toBe(
      "A key has no spaces or special characters",
    );
    expect(keyShapeProblem("x".repeat(16))).toBeNull();
    expect(keyShapeProblem("x".repeat(512))).toBeNull();
    const provider = answering(200);
    expect(await checkProviderKey("soniox", "short", { fetch: provider.fetch })).toEqual({
      result: "rejected",
      message: "This key is too short.",
    });
    expect(provider.calls).toEqual([]);
  });

  it("asks the free list-models endpoint, with the key in the Authorization header only", async () => {
    const provider = answering(200);
    expect(await checkProviderKey("soniox", KEY, { fetch: provider.fetch })).toEqual({
      result: "ok",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe("https://api.soniox.com/v1/models");
    expect(provider.calls[0]?.url).not.toContain(KEY);
    expect(provider.calls[0]?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(provider.calls[0]?.signal.aborted).toBe(false);
  });

  it("says the key was refused on 401 and 403, never repeating the key", async () => {
    for (const status of [401, 403]) {
      const check = await checkProviderKey("soniox", KEY, { fetch: answering(status).fetch });
      expect(check).toEqual({
        result: "rejected",
        message: `Soniox did not accept this key (HTTP ${status}).`,
      });
    }
  });

  it("stores but marks unchecked when the provider answers something else", async () => {
    for (const status of [199, 300, 404, 429, 500, 503]) {
      expect(await checkProviderKey("soniox", KEY, { fetch: answering(status).fetch })).toEqual({
        result: "unchecked",
        message: `Soniox answered HTTP ${status}; the key was not checked.`,
      });
    }
  });

  it("stores but marks unchecked when the provider cannot be reached", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.soniox.com");
    };
    expect(await checkProviderKey("soniox", KEY, { fetch: down })).toEqual({
      result: "unchecked",
      message: "Soniox could not be reached; the key was not checked.",
    });
  });

  it("gives up after the timeout (6 s by default) and leaves no timer behind", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const pending = checkProviderKey("soniox", KEY, { fetch: hanging });
    await vi.advanceTimersByTimeAsync(5999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toEqual({
      result: "unchecked",
      message: "Soniox could not be reached; the key was not checked.",
    });
    expect(vi.getTimerCount()).toBe(0);

    const quick = checkProviderKey("soniox", KEY, { fetch: hanging, timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect((await quick).result).toBe("unchecked");

    await checkProviderKey("soniox", KEY, { fetch: answering(200).fetch });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the global fetch when none is given", async () => {
    const provider = answering(204);
    vi.stubGlobal("fetch", vi.fn(provider.fetch));
    expect(await checkProviderKey("soniox", KEY)).toEqual({ result: "ok" });
    expect(provider.calls.map((c) => c.url)).toEqual(["https://api.soniox.com/v1/models"]);
  });
});
