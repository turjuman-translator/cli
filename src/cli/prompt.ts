// Questions for `turjuman setup` and `turjuman screens rm`. On a terminal they have line editing,
// and secrets (API keys, passwords) are typed without being shown; from a pipe every answer is
// one line. Ctrl-C, Ctrl-D and the end of the input all answer null. Nothing is kept in a history.
// Answers are taken from the interface's "line" events rather than question(): a pending
// question() never settles when the input closes, and misses a last line without a newline.
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";

export interface Prompter {
  /** One answer line, or null when the input ended (Ctrl-D, a closed pipe) or after Ctrl-C. */
  ask(question: string): Promise<string | null>;
  /** Like ask, but on a terminal the answer is not shown while it is typed. */
  askSecret(question: string): Promise<string | null>;
  /** True once Ctrl-C was pressed. */
  readonly interrupted: boolean;
  close(): void;
}

/** Output that can be muted: readline echoes into it, and nothing reaches the terminal. */
class MuteOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  /** readline reads this to wrap long lines. */
  get columns(): number | undefined {
    return (this.target as Partial<NodeJS.WriteStream>).columns;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    done();
  }
}

/** Questions on stdin/stdout. Create it only when a question must be asked (it reads stdin). */
export class TerminalPrompter implements Prompter {
  private readonly rl: Interface;
  private readonly echo: MuteOutput;
  private readonly terminal: boolean;
  private readonly queued: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private ended = false;
  private wasInterrupted = false;

  constructor(
    input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.terminal = input.isTTY === true;
    this.echo = new MuteOutput(output);
    this.rl = createInterface({
      input,
      output: this.echo,
      terminal: this.terminal,
      // No history: the arrow keys must never bring back a key or a password.
      historySize: 0,
    });
    this.rl.on("line", (line) => this.deliver(line));
    this.rl.on("close", () => {
      this.ended = true;
      this.deliver(null);
    });
    this.rl.on("SIGINT", () => {
      this.wasInterrupted = true;
      this.rl.close();
    });
  }

  get interrupted(): boolean {
    return this.wasInterrupted;
  }

  async ask(question: string): Promise<string | null> {
    if (this.ended && this.queued.length === 0) return null;
    if (this.terminal && !this.ended) {
      this.rl.setPrompt(question);
      this.rl.prompt();
      return this.next();
    }
    // Piped answers are not echoed: show the question and end its line here.
    this.output.write(question);
    const answer = await this.next();
    this.output.write("\n");
    return answer;
  }

  async askSecret(question: string): Promise<string | null> {
    if (!this.terminal || this.ended) return this.ask(question);
    this.output.write(question);
    this.rl.setPrompt("");
    this.echo.muted = true;
    this.rl.prompt();
    try {
      return await this.next();
    } finally {
      this.echo.muted = false;
      this.output.write("\n");
    }
  }

  close(): void {
    this.rl.close();
  }

  private deliver(line: string | null): void {
    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting(line);
    } else if (line !== null) {
      this.queued.push(line);
    }
  }

  /** The next line. ask() and askSecret() answer null themselves once the input has ended with
   *  nothing queued, so a wait here always ends with a line or the close. */
  private next(): Promise<string | null> {
    const line = this.queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

/** Yes or no (Enter = `byDefault`); null when the input ended. Other answers ask again. */
export async function confirm(
  prompter: Prompter,
  question: string,
  byDefault: boolean,
): Promise<boolean | null> {
  for (;;) {
    const answer = await prompter.ask(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `);
    if (answer === null) return null;
    const a = answer.trim().toLowerCase();
    if (a === "") return byDefault;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}
