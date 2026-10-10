import { describe, expect, it } from "vitest";
import {
  ARABIC_SCRIPT_LANGS,
  baseLang,
  dirFor,
  isArabicScript,
  isNoSpaceScript,
  NO_SPACE_LANGS,
  RTL_LANGS,
} from "../../src/shared/lang.js";

describe("baseLang", () => {
  it("keeps only the primary subtag, lower-cased, whatever the separator", () => {
    expect(baseLang("ar-EG")).toBe("ar");
    expect(baseLang("zh_Hant")).toBe("zh");
    expect(baseLang("  NL  ")).toBe("nl");
    expect(baseLang("ckb-IQ-x-private")).toBe("ckb");
  });

  it("gives an empty code for empty input", () => {
    expect(baseLang("")).toBe("");
    expect(baseLang("-EG")).toBe("");
  });
});

describe("dirFor", () => {
  it("is rtl for every language in the static RTL list, with or without a region", () => {
    for (const lang of RTL_LANGS) {
      expect(dirFor(lang)).toBe("rtl");
      expect(dirFor(`${lang.toUpperCase()}-XX`)).toBe("rtl");
    }
  });

  it("is ltr for everything else, including unknown and empty codes", () => {
    for (const lang of ["en", "nl", "tr", "id", "zh-Hans", "xx", ""])
      expect(dirFor(lang)).toBe("ltr");
  });
});

describe("isArabicScript", () => {
  it("is true for languages written in Arabic script", () => {
    for (const lang of ARABIC_SCRIPT_LANGS) expect(isArabicScript(lang)).toBe(true);
    expect(isArabicScript("fa-IR")).toBe(true);
    expect(isArabicScript("UR_pk")).toBe(true);
  });

  it("is false for right-to-left languages in other scripts and for Latin ones", () => {
    expect(isArabicScript("he")).toBe(false);
    expect(isArabicScript("yi")).toBe(false);
    expect(isArabicScript("dv")).toBe(false);
    expect(isArabicScript("en")).toBe(false);
  });
});

describe("isNoSpaceScript", () => {
  it("is true for languages written without spaces between words", () => {
    for (const lang of NO_SPACE_LANGS) expect(isNoSpaceScript(lang)).toBe(true);
    expect(isNoSpaceScript("zh-CN")).toBe(true);
    expect(isNoSpaceScript("ja_JP")).toBe(true);
  });

  it("is false for languages that put spaces between words", () => {
    for (const lang of ["ko", "en", "ar", "vi"]) expect(isNoSpaceScript(lang)).toBe(false);
  });
});
