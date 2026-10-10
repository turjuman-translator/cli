import { describe, expect, it } from "vitest";
import {
  arabicWords,
  endsMidSentence,
  foldAsrVariants,
  matchWords,
  normalizeArabic,
} from "../../src/text/arabic.js";

describe("normalizeArabic", () => {
  it("strips tashkeel, tatweel and Quranic marks and folds letter variants", () => {
    expect(normalizeArabic("بِسْمِ ٱللَّهِ")).toBe("بسم الله");
    expect(normalizeArabic("الحمـــد")).toBe("الحمد");
    expect(normalizeArabic("أإآٱ")).toBe("اااا");
    expect(normalizeArabic("على مدرسة")).toBe("علي مدرسه");
    expect(normalizeArabic("ذَٰلِكَ ٱلْكِتَٰبُ لَا رَيْبَ ۛ فِيهِ ۛ")).toBe("ذلك الكتب لا ريب فيه");
  });

  it("turns Arabic-Indic and extended Arabic-Indic digits into ASCII", () => {
    expect(normalizeArabic("سورة ٢ آية ٢٨٦")).toBe("سوره 2 ايه 286");
    expect(normalizeArabic("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeArabic("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("removes Arabic and Latin punctuation and collapses whitespace", () => {
    expect(normalizeArabic("  قال، «الله أكبر»؛ هل؟ نعم!  ")).toBe("قال الله اكبر هل نعم");
    expect(normalizeArabic("﴿الحمد لله﴾ ...")).toBe("الحمد لله");
  });
});

describe("arabicWords / matchWords / foldAsrVariants", () => {
  it("returns no words for empty or punctuation-only text", () => {
    expect(arabicWords("")).toEqual([]);
    expect(arabicWords(" ، . ")).toEqual([]);
    expect(matchWords("؟")).toEqual([]);
  });

  it("folds the accusative tanween alef and hamza seats", () => {
    expect(foldAsrVariants("محمدا")).toBe("محمد");
    expect(foldAsrVariants("سؤال")).toBe("سءال");
    expect(foldAsrVariants("شيئا")).toBe("شيء");
    // Short words keep their alef ("لا", "ما").
    expect(foldAsrVariants("لا")).toBe("لا");
    expect(matchWords("أشهد أن محمدًا رسول الله")).toEqual(["اشهد", "ان", "محمد", "رسول", "الله"]);
  });
});

describe("endsMidSentence", () => {
  it("is false for empty text and true for a trailing particle", () => {
    expect(endsMidSentence("")).toBe(false);
    expect(endsMidSentence("ذهب إلى")).toBe(true);
    expect(endsMidSentence("ذهب إلى المسجد")).toBe(false);
  });
});
