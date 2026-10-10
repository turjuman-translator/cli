import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A look's letter-spacing (high-contrast: 0.5px) must never pull Arabic letters apart.
describe("caption CSS keeps Arabic-script letters joined", () => {
  for (const [file, selector] of [
    ["blocks.css", ".blk-root :lang(ar)"],
    ["rollup.css", ".cap-text:lang(ar)"],
  ] as const) {
    it(`${file}: ${selector} has no letter-spacing`, () => {
      const css = readFileSync(join(process.cwd(), "web", "shared", file), "utf8");
      const at = css.indexOf(selector);
      expect(at).toBeGreaterThan(-1);
      const block = css.slice(at, css.indexOf("}", at));
      expect(block).toMatch(/letter-spacing:\s*0;/);
    });
  }
});
