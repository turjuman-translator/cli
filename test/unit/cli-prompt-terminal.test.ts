import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirm, TerminalPrompter } from "../../src/cli/prompt.js";

/** A prompter on a terminal (a TTY input with line editing), and what reached the screen. */
function terminal(columns: number | undefined = 80) {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let shown = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        shown += String(chunk);
        done();
      },
    }),
    { columns },
  );
  const prompter = new TerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  return {
    input,
    prompter,
    shown: () => shown,
    clear: () => {
      shown = "";
    },
    type: (text: string) => input.write(text),
  };
}

describe("TerminalPrompter on a terminal", () => {
  it("shows the question and echoes the answer while it is typed", async () => {
    const t = terminal();
    const answer = t.prompter.ask("Username: ");
    t.type("imam\r");
    expect(await answer).toBe("imam");
    expect(t.shown()).toContain("Username: ");
    expect(t.shown()).toContain("imam");
    t.prompter.close();
  });

  it("never shows a secret while it is typed, and ends its line", async () => {
    const t = terminal(undefined);
    const answer = t.prompter.askSecret("API key: ");
    t.type("s3cr3t-key-value\r");
    expect(await answer).toBe("s3cr3t-key-value");
    expect(t.shown()).toContain("API key: ");
    expect(t.shown()).not.toContain("s3cr3t");
    expect(t.shown().endsWith("\n")).toBe(true);
    // Echo is back on for the next question.
    t.clear();
    const next = t.prompter.ask("Name: ");
    t.type("shown\r");
    expect(await next).toBe("shown");
    expect(t.shown()).toContain("shown");
    t.prompter.close();
  });

  it("answers null after Ctrl-C and remembers it was interrupted", async () => {
    const t = terminal();
    const answer = t.prompter.askSecret("Password: ");
    t.type("\x03");
    expect(await answer).toBeNull();
    expect(t.prompter.interrupted).toBe(true);
    expect(await t.prompter.ask("Another? ")).toBeNull();
    expect(await t.prompter.askSecret("And a secret? ")).toBeNull();
    expect(await confirm(t.prompter, "Sure?", true)).toBeNull();
  });

  it("keeps lines typed ahead for the next questions, also after the input ends", async () => {
    const t = terminal();
    t.type("first\rsecond\r");
    t.input.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await t.prompter.ask("One? ")).toBe("first");
    expect(await t.prompter.askSecret("Two? ")).toBe("second");
    expect(await t.prompter.ask("Three? ")).toBeNull();
    expect(t.prompter.interrupted).toBe(false);
  });
});
