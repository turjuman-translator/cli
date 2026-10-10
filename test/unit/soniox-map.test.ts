import { describe, expect, it } from "vitest";
import { mapSonioxToken } from "../../src/stt/soniox-map.js";

describe("mapSonioxToken", () => {
  it("strips Arabic presentation forms Soniox sometimes writes into a translation", () => {
    // Session 2026-10-03_1902: «والصلاة والسلام على أشرف المسلمين» → "en ﴊ ﴾ ﴾ ﴾".
    expect(
      mapSonioxToken(
        { text: " en ﴊ ﴾ ﴾ ﴾", is_final: true, translation_status: "translation" },
        "nl",
      ),
    ).toEqual([{ text: " en", kind: "translation" }]);
    expect(
      mapSonioxToken(
        { text: " Mohammed, ﵇ ﴇ ﵇,", is_final: true, translation_status: "translation" },
        "nl",
      ),
    ).toEqual([{ text: " Mohammed,,", kind: "translation" }]);
  });

  it("keeps Arabic source text as it is", () => {
    const [src] = mapSonioxToken(
      { text: " صلى الله عليه وسلم", is_final: true, start_ms: 10, end_ms: 20 },
      "nl",
    );
    expect(src?.text).toBe(" صلى الله عليه وسلم");
  });
});
