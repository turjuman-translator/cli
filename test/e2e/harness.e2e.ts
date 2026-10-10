// The end-to-end harness itself: the built binary runs, a local and a hosted server start in temp
// installs, and Chrome opens their pages without console errors.
import { afterAll, describe, expect, it } from "vitest";
import { launchChrome, openPage } from "./helpers/browser.js";
import { turjuman } from "./helpers/cli.js";
import { freePort, type Instance, makeInstance, randomToken } from "./helpers/instance.js";
import { type Server, startServer } from "./helpers/server.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function server(yaml: (port: number) => string): Promise<{ inst: Instance; srv: Server }> {
  const port = await freePort();
  const inst = makeInstance({ yaml: yaml(port) });
  cleanup.push(() => inst.remove());
  const srv = await startServer(inst, port);
  cleanup.push(() => srv.stop());
  return { inst, srv };
}

describe("e2e harness", () => {
  it("runs the built binary", async () => {
    const inst = makeInstance();
    cleanup.push(() => inst.remove());
    const r = await turjuman(inst, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("starts a local and a hosted server and opens their pages in Chrome", async () => {
    const local = await server((port) => `server:\n  port: ${port}\nquran:\n  enabled: false\n`);
    const hosted = await server(
      (port) =>
        `mode: hosted\nserver:\n  port: ${port}\n  token: ${randomToken()}\nhosted:\n  signup: open\nquran:\n  enabled: false\n`,
    );
    const browser = await launchChrome();
    cleanup.push(() => browser.close());
    for (const url of [`${local.srv.url}/app`, `${hosted.srv.url}/`]) {
      const { page, problems } = await openPage(browser);
      const res = await page.goto(url, { waitUntil: "networkidle" });
      expect(res?.status(), url).toBe(200);
      expect(problems, url).toEqual([]);
    }
  });
});
