import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRecording,
  type RecordingEntry,
  type RecordingMeta,
  RecordingWriter,
  readRecording,
  readRecordingMeta,
} from "../../src/stt/recording.js";

const META: RecordingMeta = {
  kind: "meta",
  provider: "soniox",
  version: 1,
  startedAt: 1_790_000_000_000,
  config: { api_key: "[redacted]", model: "stt-rt-v5" },
};
const SESSION: RecordingEntry = { t: 0, kind: "session", index: 0, audioOffsetMs: 0 };
const MSG: RecordingEntry = { t: 120, kind: "msg", session: 0, data: { tokens: [] } };
const CLOSE: RecordingEntry = { t: 900, kind: "close", session: 0, code: 1000, reason: "" };
const SWITCH: RecordingEntry = { t: 950, kind: "switch", from: 0, to: 1 };

const jsonl = (...rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stt-recording-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseRecording", () => {
  it("reads the meta line and every entry kind, skipping blank lines", () => {
    const text = jsonl(META, SESSION, MSG).replace("\n", "\n\n  \n") + jsonl(CLOSE, SWITCH);
    expect(parseRecording(text)).toEqual({ meta: META, lines: [SESSION, MSG, CLOSE, SWITCH] });
  });

  it("skips a torn last line (the process died mid-write)", () => {
    const text = `${jsonl(META, SESSION)}{"t":5,"kind":"ms`;
    expect(parseRecording(text).lines).toEqual([SESSION]);
  });

  it("rejects invalid JSON anywhere else, with the line number", () => {
    expect(() => parseRecording(`${jsonl(META)}{oops\n${jsonl(SESSION)}`, "p.jsonl")).toThrow(
      "p.jsonl:2: invalid JSON",
    );
    // A torn line is only forgiven after the meta line.
    expect(() => parseRecording('{"kind":"me')).toThrow("recording:1: invalid JSON");
    // A complete file (ending in a newline) has no torn line.
    expect(() => parseRecording(`${jsonl(META)}{oops\n`)).toThrow("recording:2: invalid JSON");
  });

  it("insists on a meta line first", () => {
    expect(() => parseRecording(jsonl(SESSION))).toThrow(
      /^recording:1: first line must be meta \(kind: /,
    );
    expect(() => parseRecording(jsonl({ ...META, version: 2 }))).toThrow(/version: /);
    expect(() => parseRecording(jsonl("meta"))).toThrow(
      "recording:1: first line must be meta (Invalid input: expected object, received string)",
    );
  });

  it("names the field of an invalid entry", () => {
    expect(() =>
      parseRecording(jsonl(META, { t: 1, kind: "session", index: -1, audioOffsetMs: 0 })),
    ).toThrow(/^recording:2: index: /);
    expect(() => parseRecording(jsonl(META, { t: 1, kind: "bogus" }))).toThrow(
      /^recording:2: kind: /,
    );
    expect(() => parseRecording(jsonl(META, 42))).toThrow(
      "recording:2: Invalid input: expected object, received number",
    );
  });

  it("rejects an empty file", () => {
    expect(() => parseRecording("\n \n", "empty.jsonl")).toThrow(
      "empty.jsonl: empty recording (no meta line)",
    );
  });
});

describe("readRecording", () => {
  it("reads a provider.jsonl file and names it in errors", () => {
    const file = join(dir, "provider.jsonl");
    writeFileSync(file, jsonl(META, SESSION, MSG));
    expect(readRecording(file)).toEqual({ meta: META, lines: [SESSION, MSG] });
    expect(readRecordingMeta(file)).toEqual(META);
    writeFileSync(file, jsonl(SESSION));
    expect(() => readRecording(file)).toThrow(`${file}:1: first line must be meta`);
  });
});

describe("RecordingWriter", () => {
  it("writes the meta line, then every entry, and reads back the same recording", async () => {
    const file = join(dir, "nested", "deeper", "provider.jsonl");
    const w = new RecordingWriter(file, META);
    expect(w.path).toBe(file);
    w.write(SESSION);
    w.write(MSG);
    await w.close();
    expect(readRecording(file)).toEqual({ meta: META, lines: [SESSION, MSG] });
  });

  it("appends to an existing recording without a second meta line", async () => {
    const file = join(dir, "provider.jsonl");
    const first = new RecordingWriter(file, META);
    first.write(SESSION);
    await first.close();
    const second = new RecordingWriter(file, META, { append: true });
    second.write(CLOSE);
    await second.close();
    expect(readRecording(file)).toEqual({ meta: META, lines: [SESSION, CLOSE] });
  });

  it("scrubs the given secrets from every line", async () => {
    const file = join(dir, "provider.jsonl");
    const key = "sk-live-0123456789abcdef";
    const w = new RecordingWriter(file, { ...META, config: { api_key: key } }, { secrets: [key] });
    w.write({ t: 1, kind: "close", session: 0, reason: `bad key ${key}` });
    await w.close();
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(key);
    expect(readRecording(file).lines).toEqual([
      { t: 1, kind: "close", session: 0, reason: "bad key [redacted]" },
    ]);
  });

  it("skips a line that cannot be serialized and keeps writing", async () => {
    const file = join(dir, "provider.jsonl");
    const w = new RecordingWriter(file, META);
    w.write({ t: 1, kind: "msg", data: { big: 10n } });
    w.write(MSG);
    await w.close();
    expect(readRecording(file).lines).toEqual([MSG]);
  });

  it("closes once and ignores writes after close", async () => {
    const file = join(dir, "provider.jsonl");
    const w = new RecordingWriter(file, META);
    const closing = w.close();
    expect(w.close()).toBe(closing);
    w.write(SESSION);
    await closing;
    expect(readRecording(file).lines).toEqual([]);
  });

  it("reports the first write error once, drops later lines and still closes", async () => {
    const file = join(dir, "is-a-directory");
    mkdirSync(file);
    const onError = vi.fn();
    const w = new RecordingWriter(file, META, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });
    w.write(SESSION);
    await w.close();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("settles close() when the file fails while closing", async () => {
    const file = join(dir, "also-a-directory");
    mkdirSync(file);
    const w = new RecordingWriter(file, META);
    await expect(w.close()).resolves.toBeUndefined();
  });

  it("throws when the folder cannot be created", () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    expect(() => new RecordingWriter(join(blocker, "provider.jsonl"), META)).toThrow(
      /ENOTDIR|EEXIST/,
    );
  });
});
