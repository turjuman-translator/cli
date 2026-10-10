import { describe, expect, it } from "vitest";
import { printer } from "../../src/cli/run.js";
import type { Segment, ServerMessage } from "../../src/shared/protocol.js";
import { capture } from "./helpers/cli-env.js";

/** A segment message of the local session: source text, Dutch text, closed and final by default. */
function segment(
  seq: number,
  source: string,
  nl: string,
  over: { closed?: boolean; final?: boolean } = {},
): ServerMessage {
  const text = (t: string) => ({ text: t, finalLen: t.length, final: over.final ?? true });
  const seg: Segment = {
    id: `s1:soniox:${seq}`,
    sessionId: "s1",
    track: "soniox",
    seq,
    kind: "speech",
    startMs: 0,
    endMs: 1000,
    source: { lang: "ar", ...text(source) },
    translations: { nl: text(nl) },
    closed: over.closed ?? true,
    timing: { source: "provider", firstTokenAt: 0 },
  };
  return { type: "segment", track: "soniox", segment: seg };
}

describe("--print", () => {
  it("prints each finished caption once: the source, and under it each translation", () => {
    const c = capture();
    const print = printer(c.io);
    print({ type: "clear", track: "soniox" });
    print(segment(1, " بسم الله ", "In de naam van Allah", { closed: false }));
    print(segment(1, " بسم الله ", "In de naam van", { final: false }));
    expect(c.out).toEqual([]);
    print(segment(1, " بسم الله ", " In de naam van Allah "));
    print(segment(1, " بسم الله ", " In de naam van Allah "));
    expect(c.out).toEqual(["[soniox #1] بسم الله", "        nl: In de naam van Allah"]);
  });

  it("leaves out an empty side, and a caption with no text at all", () => {
    const c = capture();
    const print = printer(c.io);
    print(segment(2, "أما بعد.", "  "));
    print(segment(3, "", "Maar daarna."));
    print(segment(4, " ", ""));
    expect(c.out).toEqual(["[soniox #2] أما بعد.", "[soniox #3]", "        nl: Maar daarna."]);
  });
});
