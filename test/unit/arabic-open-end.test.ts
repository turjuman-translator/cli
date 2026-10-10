import { describe, expect, it } from "vitest";
import { endsMidSentence } from "../../src/text/arabic.js";

describe("endsMidSentence", () => {
  it("is true when the last word cannot end an Arabic sentence", () => {
    for (const t of [
      "إذا كان لك دين، على.",
      "سواء كان بالنقد، أو بالأجل، هل.",
      "من النوازل، وإن.",
      "فإنه.",
      "التي",
    ]) {
      expect(endsMidSentence(t), t).toBe(true);
    }
  });

  it("is false after a complete sentence", () => {
    for (const t of [
      "زكاة الدين المؤجل.",
      "وإن كان فقهاؤنا قد ذكروها من قبل.",
      "أما بعد.",
      "حتى يقبضه.",
      "",
    ]) {
      expect(endsMidSentence(t), t).toBe(false);
    }
  });
});
