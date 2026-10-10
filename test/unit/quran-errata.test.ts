import { describe, expect, it } from "vitest";
import { applyErrata } from "../../src/quran/errata.js";

describe("applyErrata", () => {
  it("fixes the known Siregar typo in 5:8", () => {
    expect(
      applyErrata(
        "nl",
        "5:8",
        "En laat de haat van een volk jullie er niet we brengen niet rechtvaardig te wezen.",
      ),
    ).toBe("En laat de haat van een volk jullie er niet toe brengen niet rechtvaardig te wezen.");
  });

  it("leaves other translations and other ayat untouched", () => {
    const leemhuis = "En laat de afkeer van bepaalde mensen jullie er niet toe brengen.";
    expect(applyErrata("nl", "5:8", leemhuis)).toBe(leemhuis);
    expect(applyErrata("nl", "5:9", "er niet we brengen")).toBe("er niet we brengen");
    expect(applyErrata("en", "5:8", "er niet we brengen")).toBe("er niet we brengen");
  });
});
