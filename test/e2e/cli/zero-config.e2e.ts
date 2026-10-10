// A first start with nothing prepared: `turjuman start` in an empty CONFIG_DIR and DATA_DIR. The
// server makes config.yaml for this deployment, generates the admin token when it needs one and
// downloads the Quran data (from a fake tanzil.net on this computer) while it already serves; the
// CLI then finds the token by itself. The hostname is never configured: one server answers two
// hostnames behind a proxy, each with its own canonical, sitemap and robots.txt. Every process is
// in the network jail: nothing leaves this computer.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { DEPLOYMENT, newConfigYaml, TOKEN_FILE } from "../../../src/config.js";
import {
  SIMPLE,
  TEXT_QUERY,
  translation,
  transQuery,
  UTHMANI,
  UTHMANI_QUERY,
} from "../../unit/helpers/quran-tanzil.js";
import { turjuman } from "../helpers/cli.js";
import { Cleanup, type CliInstall, cliInstall, waitUntil } from "../helpers/cli-tools.js";
import { type Server, startServer } from "../helpers/server.js";

const cleanup = new Cleanup();
afterAll(() => cleanup.run());

/** A tanzil.net on this computer: the files the download asks for, and what it asked. */
let tanzil: { url: string; asked: string[] };
beforeAll(async () => {
  const files: Record<string, string> = {
    [TEXT_QUERY]: SIMPLE,
    [UTHMANI_QUERY]: UTHMANI,
    [transQuery("nl.siregar")]: translation("nl.siregar"),
  };
  const asked: string[] = [];
  const server: HttpServer = createServer((req, res) => {
    asked.push(req.url ?? "");
    const body = files[req.url ?? ""];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/plain; charset=utf-8" });
    res.end(body ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  tanzil = { url: `http://127.0.0.1:${port}`, asked };
  cleanup.add(() => new Promise((r) => server.close(r)));
});

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

describe("a first start with nothing prepared", () => {
  let inst: CliInstall;
  let srv: Server;

  beforeAll(async () => {
    inst = await cliInstall({ yaml: null });
    cleanup.add(() => inst.remove());
    // Only the port is chosen (a free one, never 8765); nothing is written into the install.
    Object.assign(inst.env, { SERVER_PORT: String(inst.port), TURJUMAN_TANZIL_URL: tanzil.url });
    srv = await startServer(inst, inst.port, { command: "start" });
    cleanup.add(() => srv.stop());
  });

  it("makes config.yaml for this deployment, and the admin token when it needs one", async ({
    expect,
  }) => {
    const config = join(inst.dir, "config.yaml");
    expect(readFileSync(config, "utf8")).toBe(newConfigYaml(DEPLOYMENT));
    expect(srv.logs()).toContain(`Created ${config} (mode ${DEPLOYMENT}, exposure `);
    const tokenFile = join(inst.dir, TOKEN_FILE);
    if (DEPLOYMENT === "hosted") {
      const token = readFileSync(tokenFile, "utf8").trim();
      expect(token).toMatch(TOKEN);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      await waitUntil("the token line in the log", () =>
        srv.logs().includes(`Admin token: kept in ${tokenFile}`),
      );
      // Where it is, never what it is.
      expect(srv.logs()).not.toContain(token);
    } else {
      expect(existsSync(tokenFile)).toBe(false);
    }
  });

  it("downloads the Quran data in the background and follows the Quran once it is there", async ({
    expect,
  }) => {
    await waitUntil(
      () => `the Quran download in the server's output:\n${srv.logs()}`,
      () => srv.logs().includes("Quran matcher ready"),
      30_000,
    );
    const quran = join(inst.dataDir, "quran");
    expect(readFileSync(join(quran, "quran-simple-clean.txt"), "utf8")).toBe(SIMPLE);
    expect(readFileSync(join(quran, "quran-uthmani.txt"), "utf8")).toBe(UTHMANI);
    expect(readFileSync(join(quran, "nl.siregar.txt"), "utf8")).toBe(translation("nl.siregar"));
    expect(readFileSync(join(quran, "LICENSE-tanzil.txt"), "utf8")).toContain("Tanzil Project");
    expect(tanzil.asked).toEqual([TEXT_QUERY, UTHMANI_QUERY, transQuery("nl.siregar")]);
    // Nothing else left this computer.
    expect(inst.netAttempts()).toEqual([]);
  });

  it("lets the CLI talk to the server with the token it finds by itself", async ({ expect }) => {
    const sessions = await turjuman(inst, ["ctl", "sessions"]);
    expect(sessions.code, sessions.stderr).toBe(0);
    const status = await turjuman(inst, ["status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain(`exposure ${DEPLOYMENT === "hosted" ? "public" : "local"})`);
  });

  it.runIf(DEPLOYMENT === "hosted")(
    "answers two hostnames, each with its own canonical, sitemap and robots.txt",
    async ({ expect }) => {
      for (const [host, proto] of [
        ["example.org", "https"],
        ["captions.other.test", "http"],
      ] as const) {
        const origin = `${proto}://${host}`;
        const get = async (path: string): Promise<string> => {
          const res = await fetch(`${srv.url}${path}`, {
            headers: {
              accept: "text/html",
              "x-forwarded-host": host,
              "x-forwarded-proto": proto,
            },
          });
          expect(res.status, path).toBe(200);
          return res.text();
        };
        expect(await get("/")).toContain(`<link rel="canonical" href="${origin}/">`);
        expect(await get("/nl")).toContain(`<link rel="canonical" href="${origin}/nl">`);
        const sitemap = await get("/sitemap.xml");
        const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
        expect(locs.length).toBeGreaterThan(10);
        expect(locs.filter((l) => !l.startsWith(`${origin}/`))).toEqual([]);
        expect(await get("/robots.txt")).toContain(`Sitemap: ${origin}/sitemap.xml\n`);
      }
    },
  );

  it("starts again with the same config, the same token and no new download", async ({
    expect,
  }) => {
    const tokenFile = join(inst.dir, TOKEN_FILE);
    const before = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : null;
    const asked = tanzil.asked.length;
    await srv.stop();
    const again = await startServer(inst, inst.port, { command: "start" });
    cleanup.add(() => again.stop());
    await waitUntil("the Quran matcher after the restart", () =>
      again.logs().includes("Quran matcher ready"),
    );
    expect(again.logs()).not.toContain("Created ");
    expect(existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : null).toBe(before);
    expect(tanzil.asked).toHaveLength(asked);
    await again.stop();
  });
});
