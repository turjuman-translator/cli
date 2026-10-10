import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirm, TerminalPrompter } from "../../src/cli/prompt.js";

/** A prompter on a pipe (not a terminal), and what it showed. */
function piped() {
  const input = new PassThrough();
  let shown = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      shown += String(chunk);
      done();
    },
  });
  const prompter = new TerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  return { input, prompter, shown: () => shown };
}

describe("TerminalPrompter on a pipe", () => {
  it("answers one line per question, the last one without a newline too, then null", async () => {
    const { input, prompter, shown } = piped();
    input.end("first\nsecond\nlast-without-newline");
    expect(await prompter.ask("Q1? ")).toBe("first");
    expect(await prompter.askSecret("Q2? ")).toBe("second");
    expect(await prompter.ask("Q3? ")).toBe("last-without-newline");
    expect(await prompter.ask("Q4? ")).toBeNull();
    expect(prompter.interrupted).toBe(false);
    prompter.close();
    expect(shown()).toContain("Q1? ");
  });

  it("answers null when the input ends while a question waits", async () => {
    const { input, prompter } = piped();
    const pending = prompter.ask("Q? ");
    input.end();
    expect(await pending).toBeNull();
    prompter.close();
  });

  it("confirm: Enter takes the default, other answers ask again, the end answers null", async () => {
    const { input, prompter } = piped();
    input.end("\nmaybe\nY\n");
    expect(await confirm(prompter, "Sure?", false)).toBe(false);
    expect(await confirm(prompter, "Sure?", false)).toBe(true);
    expect(await confirm(prompter, "Sure?", true)).toBeNull();
    prompter.close();
  });
});
