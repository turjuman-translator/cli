import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActiveSessionMarker,
  clearMarker,
  MAX_RESUMES,
  readMarker,
  shouldResume,
  writeMarker,
} from "../../src/core/resume.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "core-resume-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MARKER: ActiveSessionMarker = {
  sessionId: "abcd2345",
  startedAt: 1000,
  lastAliveAt: 5000,
  resumes: 0,
  inputKind: "device",
};

describe("resume marker file", () => {
  it("writes the marker (creating the state folder), reads it back and clears it", () => {
    const stateDir = join(tempDir(), "state", "nested");
    expect(readMarker(stateDir)).toBeNull();
    writeMarker(stateDir, MARKER);
    const file = join(stateDir, "active-session.json");
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(MARKER, null, 2)}\n`);
    expect(readMarker(stateDir)).toEqual(MARKER);
    clearMarker(stateDir);
    expect(existsSync(file)).toBe(false);
    clearMarker(stateDir);
  });

  it("reads a marker from an older version and ignores its engine fields", () => {
    const stateDir = tempDir();
    writeFileSync(
      join(stateDir, "active-session.json"),
      JSON.stringify({ ...MARKER, mode: "compare", provider: "gemini", translation: "llm" }),
    );
    expect(readMarker(stateDir)).toEqual(MARKER);
  });

  it("returns null for a marker that is not JSON or does not match the schema", () => {
    const stateDir = tempDir();
    const file = join(stateDir, "active-session.json");
    writeFileSync(file, "{ torn");
    expect(readMarker(stateDir)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...MARKER, resumes: -1 }));
    expect(readMarker(stateDir)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...MARKER, inputKind: "bluetooth" }));
    expect(readMarker(stateDir)).toBeNull();
  });

  it("returns null when the marker path cannot be read as a file", () => {
    const stateDir = tempDir();
    mkdirSync(join(stateDir, "active-session.json"));
    expect(readMarker(stateDir)).toBeNull();
  });
});

describe("shouldResume", () => {
  const opts = { now: 5000 + 60_000, windowMin: 10, dev: false };

  it("resumes a recently alive device or network session", () => {
    expect(shouldResume(MARKER, opts)).toBe(true);
    expect(shouldResume({ ...MARKER, inputKind: "network" }, opts)).toBe(true);
  });

  it("never resumes in dev mode, file or page sessions, or after too many resumes", () => {
    expect(shouldResume(MARKER, { ...opts, dev: true })).toBe(false);
    expect(shouldResume({ ...MARKER, inputKind: "file" }, opts)).toBe(false);
    expect(shouldResume({ ...MARKER, inputKind: "page" }, opts)).toBe(false);
    expect(shouldResume({ ...MARKER, resumes: MAX_RESUMES }, opts)).toBe(false);
    expect(shouldResume({ ...MARKER, resumes: MAX_RESUMES - 1 }, opts)).toBe(true);
  });

  it("does not resume a session last alive longer ago than the window", () => {
    expect(shouldResume(MARKER, { ...opts, now: 5000 + 10 * 60_000 })).toBe(false);
    expect(shouldResume(MARKER, { ...opts, now: 5000 + 10 * 60_000 - 1 })).toBe(true);
  });
});
