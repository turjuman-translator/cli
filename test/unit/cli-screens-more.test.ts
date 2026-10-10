import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERY, ScreenStore } from "../../src/accounts/screens.js";
import { lookQuery, screensCommand } from "../../src/cli/screens-cmd.js";
import { capture, configured, removeTempDirs } from "./helpers/cli-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

const CLI = { id: null, name: "cli" };

describe("turjuman screens", () => {
  it("warns about a screens.yaml it cannot read, and still answers", async () => {
    const { loaded } = configured();
    writeFileSync(loaded.paths.screensFile, "screens: 12\n");
    const c = capture();
    expect(await screensCommand(["list"], c.io, () => loaded, { lan: null })).toBe(0);
    expect(c.err[0]).toMatch(/^Warning: Invalid .*screens\.yaml/);
    expect(c.text()).toMatch(/No screens yet/);
  });

  it("makes look queries far below the stored limit, even with the longest custom preset id", () => {
    const { loaded } = configured("display:\n  preset: mosque-light\n");
    const id = "x".repeat(48);
    writeFileSync(
      loaded.paths.presetsFile,
      `presets:\n  - id: ${id}\n    name: Long\n    options: { layout: blocks }\n`,
    );
    const query = lookQuery(loaded, { preset: id, layout: "rollup", size: "300" });
    expect(query).toBe(`preset=${id}&layout=rollup&size=300`);
    expect(query.length).toBeLessThan(MAX_QUERY / 10);
  });

  it("shows each screen's organisation when screens belong to several", async () => {
    const { loaded } = configured();
    const store = new ScreenStore(loaded.paths.screensFile);
    store.create({ name: "Hall", from: "ar", to: "nl", query: "", ownerId: null }, CLI);
    const theirs = store.create(
      { name: "Masjid", from: "ar", to: "en", query: "", ownerId: null, orgId: "org-2" },
      CLI,
    );
    const c = capture();
    expect(await screensCommand(["list"], c.io, () => loaded, { lan: null })).toBe(0);
    const lines = c.text().split("\n");
    expect(lines[0]?.split(/ {2,}/)).toEqual([
      "ID",
      "NAME",
      "ORG",
      "LANGUAGES",
      "STATE",
      "SCREEN LINK",
    ]);
    expect(
      lines
        .find((l) => l.startsWith(theirs.id))
        ?.split(/ {2,}/)
        .slice(1, 4),
    ).toEqual(["Masjid", "org-2", "ar → en"]);
  });

  it("needs --from as well as --to", async () => {
    const { loaded } = configured();
    const c = capture();
    const code = await screensCommand(["add", "--name", "Hall", "--to", "nl"], c.io, () => loaded, {
      lan: null,
    });
    expect(code).toBe(2);
    expect(c.errText()).toMatch(/give the languages: --from <code> --to <code>/);
  });

  it("rm asks on the terminal by default", async () => {
    const { loaded } = configured();
    const store = new ScreenStore(loaded.paths.screensFile);
    const screen = store.create(
      { name: "Hall", from: "ar", to: "nl", query: "", ownerId: null },
      CLI,
    );
    const stdin = new PassThrough();
    stdin.end("y\n");
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    let asked = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      asked += String(chunk);
      return true;
    });
    const c = capture();
    const code = await screensCommand(["rm", screen.id], c.io, () => loaded, { lan: null });
    vi.mocked(process.stdout.write).mockRestore();
    expect(code).toBe(0);
    expect(asked).toContain(
      `Delete screen ${screen.id} "Hall" (ar → nl)? Its link stops working. [y/N] `,
    );
    expect(store.list()).toEqual([]);
  });
});
