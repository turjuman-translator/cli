// @vitest-environment happy-dom
// HTTP access to a session's blocks and exports (web/shared/blocks-api.ts): the query string and
// the Bearer header, errors, the session metadata, the history loader and the export links.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authFrom,
  exportLinks,
  fetchBlocks,
  HttpError,
  olderLoader,
} from "../../web/shared/blocks-api.js";
import { block, fakeFetch, jsonResponse } from "./helpers/web-shared-fakes.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("blocks api: auth from the page URL", () => {
  it("takes key= and token=, and treats empty values as absent", () => {
    expect(authFrom(new URLSearchParams("key=k1&token=t1"))).toEqual({ key: "k1", token: "t1" });
    expect(authFrom(new URLSearchParams("key=&token="))).toEqual({ key: null, token: null });
    expect(authFrom(new URLSearchParams(""))).toEqual({ key: null, token: null });
  });
});

describe("blocks api: fetching a page of blocks", () => {
  it("asks for the newest page with the limit and the access key, without a Bearer header", async () => {
    const fetch = fakeFetch(() => jsonResponse({ blocks: [block(1)], hasMore: true }));
    const page = await fetchBlocks("s 1", null, 50, { key: "abc", token: null });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/sessions/s%201/blocks?limit=50&key=abc");
    expect(init?.headers).toEqual({ Accept: "application/json" });
    expect(page.blocks.map((b) => b.id)).toEqual(["s1:b1"]);
    expect(page.hasMore).toBe(true);
    expect(page.meta).toEqual({ live: null, from: null, to: null, startedAt: null, endedAt: null });
  });

  it("asks for older blocks with before= and sends the admin token as Bearer too", async () => {
    const fetch = fakeFetch(() => jsonResponse([block(1), block(2)]));
    const page = await fetchBlocks("s1", 7, 100, { key: null, token: "tok" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/sessions/s1/blocks?limit=100&token=tok&before=7");
    expect(init?.headers).toEqual({ Accept: "application/json", Authorization: "Bearer tok" });
    // A bare array: more may exist while the page is not empty.
    expect(page.hasMore).toBe(true);
    expect(page.blocks).toHaveLength(2);
  });

  it("reads the session metadata that comes with the page, ignoring wrong types", async () => {
    fakeFetch(() =>
      jsonResponse({
        blocks: [],
        hasMore: false,
        live: false,
        from: "ar",
        to: "nl",
        startedAt: 1000,
        endedAt: 5000,
      }),
    );
    const good = await fetchBlocks("s1", null, 10, { key: null, token: null });
    expect(good.meta).toEqual({
      live: false,
      from: "ar",
      to: "nl",
      startedAt: 1000,
      endedAt: 5000,
    });

    fakeFetch(() =>
      jsonResponse({
        blocks: [],
        live: "yes",
        from: "",
        to: 3,
        startedAt: Number.NaN,
        endedAt: "later",
      }),
    );
    const bad = await fetchBlocks("s1", null, 10, { key: null, token: null });
    expect(bad.meta).toEqual({ live: null, from: null, to: null, startedAt: null, endedAt: null });
    expect(bad.hasMore).toBe(false);
  });

  it("throws HttpError with the status on an error answer", async () => {
    fakeFetch(() => jsonResponse({ error: "nope" }, 403));
    const err = await fetchBlocks("s1", null, 10, { key: null, token: null }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toBe("HTTP 403");
    expect((err as HttpError).name).toBe("HttpError");
  });

  it("throws HttpError 502 when the body is not a blocks page", async () => {
    fakeFetch(() => jsonResponse({ hello: "world" }));
    const err = await fetchBlocks("s1", null, 10, { key: null, token: null }).catch(
      (e: unknown) => e,
    );
    expect((err as HttpError).status).toBe(502);
  });
});

describe("blocks api: the history loader", () => {
  it("loads 100 blocks before a seq", async () => {
    const fetch = fakeFetch(() => jsonResponse({ blocks: [block(3)], hasMore: false }));
    const load = olderLoader({ key: "k", token: null });
    const page = await load("s1", 4);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/sessions/s1/blocks?limit=100&key=k&before=4");
    expect(page?.blocks.map((b) => b.seq)).toEqual([3]);
  });

  it("answers null when the request fails (the view then backs off)", async () => {
    fakeFetch(() => {
      throw new TypeError("network down");
    });
    expect(await olderLoader({ key: null, token: null })("s1", 4)).toBeNull();
    fakeFetch(() => jsonResponse({}, 500));
    expect(await olderLoader({ key: null, token: null })("s1", 4)).toBeNull();
  });
});

describe("blocks api: export links", () => {
  it("points at the three formats, with the page's auth", () => {
    expect(exportLinks("s/1", { key: "k", token: "t" })).toEqual({
      txt: "/api/sessions/s%2F1/export.txt?key=k&token=t",
      md: "/api/sessions/s%2F1/export.md?key=k&token=t",
      srt: "/api/sessions/s%2F1/export.srt?key=k&token=t",
    });
  });

  it("has no query string without auth", () => {
    expect(exportLinks("s1", { key: null, token: null })).toEqual({
      txt: "/api/sessions/s1/export.txt",
      md: "/api/sessions/s1/export.md",
      srt: "/api/sessions/s1/export.srt",
    });
  });
});
