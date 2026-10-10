// `turjuman screens …` writes screens.yaml with a store of its own; the server's store reads the
// change (its mtime) and syncScreens() brings the open pages in line with it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ScreenRecord, ScreenStore } from "../../src/accounts/screens.js";
import { SigningSecret } from "../../src/accounts/secret.js";
import { KeyStore } from "../../src/auth/keys.js";
import { FailureRateLimiter } from "../../src/auth/rate-limit.js";
import { loadConfig } from "../../src/config.js";
import { UsageStore } from "../../src/core/usage.js";
import { loadLanguages } from "../../src/languages.js";
import { PageSockets } from "../../src/server/page-ws.js";
import { ScreenHub } from "../../src/server/screen-hub.js";
import { FakeManager, FakeSocket, fakeRequest, flush, hello } from "./helpers/server-fakes.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const actor = { id: null, name: "cli" };

describe("screens.yaml changes made outside the app reach the pages", () => {
  let dir: string;
  let usage: UsageStore;
  let pages: PageSockets;
  let manager: FakeManager;
  let cli: ScreenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "page-sync-"));
    const loaded = loadConfig({ env: { CONFIG_DIR: dir, DATA_DIR: dir }, cwd: dir });
    const file = join(dir, "screens.yaml");
    cli = new ScreenStore(file);
    usage = new UsageStore({ dir, flushIntervalMs: 0 });
    manager = new FakeManager();
    pages = new PageSockets({
      loaded,
      manager,
      keys: new KeyStore(join(dir, "keys.yaml")),
      usage,
      languages: loadLanguages(join(process.cwd(), "languages.yaml")),
      limiter: new FailureRateLimiter(),
      screens: new ScreenStore(file),
      secret: new SigningSecret(join(dir, "secret.key"), ""),
      hub: new ScreenHub(),
      requireScreen: () => false,
      log: pino({ level: "silent" }),
      screenSyncMs: 0,
    });
  });

  afterEach(() => {
    pages.close();
    usage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A caption page opened with the screen's link (OBS). */
  function open(s: ScreenRecord): FakeSocket {
    const socket = new FakeSocket();
    pages.handle(socket.ws, fakeRequest());
    socket.text(hello({ screen: { guid: s.guid } }));
    return socket;
  }

  it("screens add, the link opened (parked), screens enable: the page hears it within one check", async () => {
    pages.syncScreens();
    const screen = cli.create(
      { name: "Hall", from: "ar", to: "nl", query: "", ownerId: null },
      actor,
    );
    const obs = open(screen);
    expect(obs.last("screen")).toEqual({ type: "screen", state: "disabled", name: "Hall" });
    await sleep(5);
    cli.update(screen.id, { enabled: true }, "enabled", actor);
    pages.syncScreens();
    expect(obs.last("screen")).toEqual({ type: "screen", state: "enabled", name: "Hall" });
    obs.text(hello({ screen: { guid: screen.guid } }));
    const session = manager.page(String(obs.last("ready")?.sessionId));

    // screens disable, then enable and disable again before the next check: still off.
    await sleep(5);
    cli.update(screen.id, { enabled: false }, "disabled", actor);
    await sleep(5);
    cli.update(screen.id, { enabled: true }, "enabled", actor);
    await sleep(5);
    cli.update(screen.id, { enabled: false }, "disabled", actor);
    pages.syncScreens();
    await flush();
    expect(obs.last("screen")).toEqual({ type: "screen", state: "disabled", name: "Hall" });
    expect(session.stopReasons).toEqual(["screen disabled"]);

    // screens rm: the link stops working.
    await sleep(5);
    cli.remove(screen.id);
    pages.syncScreens();
    expect(obs.last("error")).toMatchObject({ code: "screen_invalid" });
  });
});
