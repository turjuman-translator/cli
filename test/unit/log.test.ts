import { describe, expect, it } from "vitest";
import { scrubSecrets } from "../../src/log.js";

describe("scrubSecrets", () => {
  it("removes literal secret values wherever they appear", () => {
    const out = scrubSecrets("connect failed for snx_proj_ABC123secret (401)", [
      "snx_proj_ABC123secret",
    ]);
    expect(out).toBe("connect failed for [redacted] (401)");
  });

  it("redacts key=, token= and api_key= query parameters", () => {
    const out = scrubSecrets(
      "GET /ar/nl?key=abcDEF123&lines=2 wss://x/y?api_key=zzz&token=t0k",
      [],
    );
    expect(out).toBe(
      "GET /ar/nl?key=[redacted]&lines=2 wss://x/y?api_key=[redacted]&token=[redacted]",
    );
  });

  it("redacts api_key fields in JSON text", () => {
    expect(scrubSecrets('{"api_key":"snx-1","model":"stt-rt-v5"}', [])).toBe(
      '{"api_key":"[redacted]","model":"stt-rt-v5"}',
    );
  });

  it("ignores empty or very short secret values (avoids shredding normal text)", () => {
    expect(scrubSecrets("a b c", ["", "a"])).toBe("a b c");
  });
});
