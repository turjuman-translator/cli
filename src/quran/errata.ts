// Known typos in the approved translations as distributed by Tanzil, fixed when the corpus loads
// (partial verses show these sentences verbatim). An entry applies only where
// its exact wrong text occurs in that ayah, so another translation file is never changed.

interface Erratum {
  lang: string;
  ref: string;
  wrong: string;
  right: string;
}

const ERRATA: readonly Erratum[] = [
  // Siregar 5:8: "jullie er niet toe brengen" (ertoe brengen = to drive someone to).
  { lang: "nl", ref: "5:8", wrong: "er niet we brengen", right: "er niet toe brengen" },
  // Siregar 6:152
  {
    lang: "nl",
    ref: "6:152",
    wrong: "op ten wijze die meet voordeel",
    right: "op een wijze die meer voordeel",
  },
  { lang: "nl", ref: "6:152", wrong: "heeft opdragen", right: "heeft opgedragen" },
];

/** The ayah's approved translation with known typos fixed. */
export function applyErrata(lang: string, ref: string, text: string): string {
  let out = text;
  for (const e of ERRATA) {
    if (e.lang === lang && e.ref === ref && out.includes(e.wrong))
      out = out.replace(e.wrong, e.right);
  }
  return out;
}
