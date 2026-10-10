// Edge cases of the website's helpers (src/server/site.ts) that the routes do not reach.
import { describe, expect, it } from "vitest";
import { parseRoutes, siteOrigin } from "../../src/server/site.js";

describe("site helpers", () => {
  it("reads no routes from a routes.json without a routes object", () => {
    for (const json of ["{}", "null", '{"routes":5}', '{"routes":null}']) {
      expect([json, parseRoutes(json).size]).toEqual([json, 0]);
    }
  });

  it("takes an http public URL as is, and ignores one of another scheme", () => {
    expect(siteOrigin("http://turjuman.test/x", "https", "h.test")).toBe("http://turjuman.test");
    expect(siteOrigin("ftp://turjuman.test", "http", "a.test:8080")).toBe("http://a.test:8080");
    expect(siteOrigin(null, "ws", "a.test")).toBe("");
  });
});
