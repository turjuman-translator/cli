import { describe, expect, it } from "vitest";
import { SonioxPauseDetector } from "../../src/stt/soniox-pause.js";

type Tok = {
  text: string;
  start_ms?: number;
  end_ms?: number;
  is_final?: boolean;
  translation_status?: string;
};
const word = (text: string, end: number, final = false): Tok => ({
  text,
  start_ms: end - 300,
  end_ms: end,
  is_final: final,
  translation_status: "original",
});
const msg = (tokens: Tok[], proc: number) => ({ tokens, totalAudioProcMs: proc });

describe("SonioxPauseDetector", () => {
  it("fires once per pause: unfinalized words and ≥ 500 ms of audio since the last word", () => {
    const d = new SonioxPauseDetector(500);
    expect(d.onResponse(msg([word(" الله", 900)], 1000))).toBe(false);
    expect(d.onResponse(msg([word(" الله", 900), word(" أكبر", 1300)], 1400))).toBe(false);
    expect(d.onResponse(msg([word(" الله", 900), word(" أكبر", 1300)], 1700))).toBe(false);
    expect(d.onResponse(msg([word(" الله", 900), word(" أكبر", 1300)], 1850))).toBe(true);
    expect(d.onResponse(msg([word(" الله", 900), word(" أكبر", 1300)], 2000))).toBe(false);
    // the next words: a new pause fires again
    expect(d.onResponse(msg([word(" قال", 2400)], 2500))).toBe(false);
    expect(d.onResponse(msg([word(" قال", 2400)], 2950))).toBe(true);
  });

  it("never fires when nothing is waiting to be finalized", () => {
    const d = new SonioxPauseDetector(500);
    expect(
      d.onResponse(msg([word(" الله", 900, true), { text: "<end>", is_final: true }], 1000)),
    ).toBe(false);
    expect(d.onResponse(msg([], 2500))).toBe(false);
    expect(d.onResponse(msg([], 4000))).toBe(false);
  });

  it("ignores translation tokens and special tokens when timing words", () => {
    const d = new SonioxPauseDetector(500);
    expect(
      d.onResponse(
        msg(
          [
            word(" الله", 900),
            { text: " Allah", is_final: true, translation_status: "translation" },
          ],
          1000,
        ),
      ),
    ).toBe(false);
    expect(d.onResponse(msg([word(" الله", 900)], 1450))).toBe(true);
  });
});
