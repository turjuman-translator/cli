// The app in local mode on this computer (exposure local): pages and their headers, the public
// and admin API, block history and exports, presets, the local session, JSON bodies, errors,
// WebSockets and logs. A fake session layer; temporary CONFIG_DIR/DATA_DIR.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SigningSecret } from "../../src/accounts/secret.js";
import { UsageStore } from "../../src/core/usage.js";
import { resolveRecording, saveDefaults } from "../../src/server/app.js";
import type { Block, SessionSummary } from "../../src/shared/protocol.js";
import { BUILTIN_PRESETS } from "../../src/shared/theme.js";
import {
  buildTestApp,
  FakeSession,
  fakeBlock,
  hello,
  openWS,
  TempRoot,
  type TestApp,
} from "./helpers/server-fakes.js";

const ARCHIVE_ID = "arch2345";
const ARCHIVE_START = new Date(2026, 9, 2, 13, 0, 0).getTime();

/** An ended session in DATA_DIR/transcripts, with an update, a hidden block and a torn line. */
function writeArchive(root: TempRoot, id = ARCHIVE_ID, orgId?: string): void {
  const dir = `transcripts/2026-10-02_1300_${id}`;
  const start = { t: ARCHIVE_START, type: "start", kind: "page", from: "ar", to: "nl", orgId };
  const stop = { t: ARCHIVE_START + 600_000, type: "stop" };
  root.write(`${dir}/session.jsonl`, `${JSON.stringify(start)}\n${JSON.stringify(stop)}\n`);
  const b = (seq: number, extra: Partial<Block> = {}): Block =>
    fakeBlock(id, seq, { createdAt: ARCHIVE_START + seq * 1000, ...extra });
  const lines: unknown[] = [
    b(0, { text: "Alle lof zij Allah.", startMs: 0, endMs: 2000 }),
    b(1, {
      kind: "quran",
      text: "Allah belast niemand.",
      ref: "2:286",
      startMs: 2500,
      endMs: 6000,
    }),
    { type: "block.add", block: b(2, { text: "Verborgen." }) },
    { type: "block.update", block: b(2, { text: "Verborgen.", hidden: true }) },
  ];
  root.write(
    `${dir}/blocks.jsonl`,
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"id":"${id}:b9","seq`,
  );
}

describe("app: local mode on this computer", () => {
  let root: TempRoot;
  let t: TestApp;

  const get = (
    url: string,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> => t.app.inject({ url, headers });
  const post = (
    url: string,
    payload: unknown = {},
    method: "POST" | "DELETE" | "PATCH" = "POST",
  ): Promise<LightMyRequestResponse> =>
    t.app.inject({ method, url, payload: payload as Record<string, unknown> });

  beforeEach(async () => {
    root = new TempRoot("app-local-");
    mkdirSync(root.path("recordings"));
    root.write("recordings/test.wav", "RIFF");
    t = await buildTestApp(root, "# keep this comment\n", {
      app: { listDevices: async () => [{ name: "Fake mic" }] },
    });
  });

  afterEach(async () => {
    await t.app.close();
    root.remove();
  });

  describe("pages", () => {
    it("serves the builder, the app and the tools with strict, uncached headers", async () => {
      for (const [url, page] of [
        ["/", "picker"],
        ["/app", "admin"],
        ["/app/new", "picker"],
        ["/app/look", "customize"],
        ["/app/keys", "keys"],
        ["/overlay", "overlay"],
        ["/control", "control"],
        ["/customize", "customize"],
        ["/login", "login"],
        ["/admin", "admin"],
        ["/ar/nl", "caption"],
        ["/auto/nl?engine=gemini&translation=llm", "caption"],
      ] as const) {
        const res = await get(url);
        expect([url, res.statusCode, res.body]).toEqual([
          url,
          200,
          `<!doctype html><title>${page}</title>`,
        ]);
        expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(String(res.headers["content-security-policy"])).toContain("script-src 'self'");
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
      }
      for (const url of ["/app", "/login", "/admin"]) {
        expect((await get(url)).headers["x-frame-options"]).toBe("DENY");
      }
      expect((await get("/overlay")).headers["x-frame-options"]).toBeUndefined();
      // Sign-up is hosted mode's only.
      expect((await get("/signup")).statusCode).toBe(404);
    });

    it("says which page has not been built yet", async () => {
      rmSync(join(root.publicDir, "overlay.html"));
      const res = await get("/overlay");
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("overlay.html has not been built yet (run: pnpm build:web)\n");
    });

    it("sends a bad language pair back to the builder with the reason", async () => {
      const res = await get("/nl/nl");
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        `/?error=${encodeURIComponent("Source and target language must differ")}`,
      );
      expect(res.headers["cache-control"]).toBe("no-store");
      const long = await get(`/${"x".repeat(60)}/nl`);
      expect(decodeURIComponent(String(long.headers.location))).toContain(`"${"x".repeat(40)}…"`);
    });

    it("keeps the app's own first path segments away from the caption route", async () => {
      for (const url of ["/api/xx", "/login/x", "/app/x", "/s/x/y"]) {
        const res = await get(url);
        expect([url, res.statusCode, res.body]).toEqual([url, 404, "Not found\n"]);
      }
    });

    it("refuses caption pages while they are disabled", async () => {
      await t.app.close();
      t = await buildTestApp(root, "pages:\n  enabled: false\n");
      const res = await get("/ar/nl");
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("Caption pages are disabled on this server (pages.enabled: false)\n");
    });

    it("guards against DNS rebinding: only this machine's names in the Host header", async () => {
      const evil = await get("/", { host: "evil.example" });
      expect([evil.statusCode, evil.body]).toEqual([403, "Host not allowed\n"]);
      expect((await get("/health", { host: "evil.example" })).statusCode).toBe(200);
      expect((await get("/", { host: "localhost:1234" })).statusCode).toBe(200);
      expect((await get("/", { host: "127.0.0.1:8765" })).statusCode).toBe(200);
    });

    it("serves hashed bundles and fonts for a year", async () => {
      root.write("public/assets/caption-abc123.js", "console.log(1);\n");
      root.write("public/fonts/noto.woff2", "font");
      for (const url of ["/assets/caption-abc123.js", "/fonts/noto.woff2"]) {
        const res = await get(url);
        expect([url, res.statusCode]).toEqual([url, 200]);
        expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      }
      expect((await get("/assets/missing.js")).statusCode).toBe(404);
    });

    it("serves the local CA certificate as a download", async () => {
      root.write("tls/ca.crt", "-----BEGIN CERTIFICATE-----\ntest\n");
      const res = await get("/ca.crt");
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/x-x509-ca-cert");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="turjuman-local-ca.crt"',
      );
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toContain("test");
    });

    it("answers /favicon.ico with 404 when the build has no icon (or no assets folder)", async () => {
      expect((await get("/favicon.ico")).statusCode).toBe(404);
      await t.app.close();
      rmSync(join(root.publicDir, "assets"), { recursive: true });
      t = await buildTestApp(root);
      expect((await get("/favicon.ico")).statusCode).toBe(404);
    });

    it("serves the archive page of a live or archived session only", async () => {
      writeArchive(root);
      t.manager.add(new FakeSession("live1", "page"));
      for (const url of [`/s/${ARCHIVE_ID}`, "/s/live1"]) {
        const res = await get(url);
        expect([url, res.statusCode, res.body]).toEqual([
          url,
          200,
          "<!doctype html><title>archive</title>",
        ]);
      }
      const missing = await get("/s/nope2345");
      expect([missing.statusCode, missing.body]).toEqual([404, "No such session\n"]);
      expect(String(missing.headers["content-security-policy"])).toContain("default-src 'self'");
    });

    it("answers unknown addresses in plain text", async () => {
      const res = await get("/no/such/page", { accept: "text/html" });
      expect([res.statusCode, res.body]).toEqual([404, "Not found\n"]);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    });
  });

  describe("health and the public API", () => {
    it("reports health, uncached", async () => {
      const res = await get("/health");
      expect(res.json()).toMatchObject({ ok: true, version: "fake", local: null, sessions: [] });
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("still answers when the session layer fails, and logs it", async () => {
      t.manager.healthError = new Error("broken");
      const res = await get("/health");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        version: "test",
        exposure: "local",
        local: null,
        sessions: [],
      });
      expect(res.json().uptimeMs).toBeGreaterThanOrEqual(0);
      expect(t.lines.some((l) => l.msg === "health: manager.health() failed")).toBe(true);
    });

    it("lists the languages Soniox offers, with the defaults; older engine parameters are ignored", async () => {
      const res = await get("/api/languages?engine=gemini&translation=llm");
      const body = res.json();
      expect(body.auto).toBe(true);
      expect(body.sources.length).toBeGreaterThan(10);
      expect(body.targets).toEqual(body.sources);
      expect(body.sources[0]).toEqual({
        code: expect.any(String),
        en: expect.any(String),
        native: expect.any(String),
      });
      expect(body.defaults).toEqual({ from: "ar", to: "nl", show: "both" });
      expect(body.keyRequired).toBe(false);
    });
  });

  describe("sessions API", () => {
    it("lists and stops sessions", async () => {
      const s = t.manager.add(new FakeSession("page1", "page"));
      expect((await get("/api/sessions")).json()).toEqual([s.summary()]);
      const stopped = await post("/api/sessions/page1/stop");
      expect(stopped.json()).toEqual({ ok: true, message: "Stopped session page1" });
      expect(s.stopReasons).toEqual(["stopped from the API"]);
      const missing = await post(`/api/sessions/${"n".repeat(100)}/stop`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().message).toBe(`No session ${"n".repeat(80)}…`);
    });

    it("pages back through a live session's blocks", async () => {
      t.manager.add(new FakeSession("live1", "page", { blocks: 250 }));
      const first = await get("/api/sessions/live1/blocks");
      expect(first.headers["cache-control"]).toBe("no-store");
      const body = first.json();
      expect(body).toMatchObject({
        sessionId: "live1",
        live: true,
        from: "ar",
        to: "nl",
        endedAt: null,
      });
      expect(body.blocks).toHaveLength(100);
      expect(body.blocks.at(-1).seq).toBe(249);
      expect(body.hasMore).toBe(true);
      const older = (await get("/api/sessions/live1/blocks?before=51&limit=500")).json();
      expect(older.blocks.map((b: Block) => b.seq)).toEqual([...Array(51).keys()]);
      expect(older.hasMore).toBe(false);
      // A repeated parameter: the first one counts.
      const repeated = (await get("/api/sessions/live1/blocks?before=11&before=3")).json();
      expect(repeated.blocks.at(-1).seq).toBe(10);
      const clamped = (await get("/api/sessions/live1/blocks?limit=500")).json();
      expect(clamped.blocks).toHaveLength(200);
      const bad = await get("/api/sessions/live1/blocks?before=abc&limit=0");
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toMatch(/^before: .*; limit: /);
      const missing = await get("/api/sessions/nope2345/blocks");
      expect([missing.statusCode, missing.json().message]).toEqual([404, "No session nope2345"]);
    });

    it("reads an ended session's blocks from its transcript", async () => {
      writeArchive(root);
      const body = (await get(`/api/sessions/${ARCHIVE_ID}/blocks?before=3&limit=2`)).json();
      expect(body).toMatchObject({
        live: false,
        from: "ar",
        to: "nl",
        startedAt: ARCHIVE_START,
        endedAt: ARCHIVE_START + 600_000,
        hasMore: true,
      });
      expect(body.blocks.map((b: Block) => [b.seq, b.hidden ?? false])).toEqual([
        [1, false],
        [2, true],
      ]);
    });

    it("exports a session as text, Markdown or subtitles", async () => {
      writeArchive(root);
      const txt = await get(`/api/sessions/${ARCHIVE_ID}/export.txt`);
      expect(txt.headers["content-disposition"]).toBe(
        `attachment; filename="captions_2026-10-02_${ARCHIVE_ID}.txt"`,
      );
      expect(txt.headers["cache-control"]).toBe("no-store");
      expect(txt.body.startsWith("Alle lof zij Allah.")).toBe(true);
      expect(txt.body).toContain('"Allah belast niemand." (2:286)');
      expect(txt.body).not.toContain("Verborgen");
      const md = await get(`/api/sessions/${ARCHIVE_ID}/export.md`);
      expect(md.body).toContain("- **quran**: ");
      const srt = await get(`/api/sessions/${ARCHIVE_ID}/export.srt`);
      expect(String(srt.headers["content-type"])).toMatch(/^application\/x-subrip/);
      expect(srt.body.startsWith("1\n00:00:00,000 --> 00:00:02,000\nAlle lof zij Allah.\n")).toBe(
        true,
      );
      expect((await get("/api/sessions/nope2345/export.txt")).statusCode).toBe(404);
    });

    it("exports every block of a live session, paging back through them", async () => {
      t.manager.add(new FakeSession("live1", "page", { blocks: 450 }));
      const txt = (await get("/api/sessions/live1/export.txt")).body;
      expect(txt.startsWith("Zin 0.")).toBe(true);
      expect(txt).toContain("Zin 449.");
      expect(txt.match(/Zin \d+\./g)).toHaveLength(450);
      // A session that ignores `before` cannot make the export loop forever.
      const stuck = t.manager.add(new FakeSession("stuck1", "page", { blocks: 300 }));
      stuck.blocks = () => ({ blocks: stuck.blockList.slice(100), hasMore: true });
      const once = (await get("/api/sessions/stuck1/export.txt")).body;
      expect(once.match(/Zin \d+\./g)).toHaveLength(400);
      // An empty session.
      t.manager.add(new FakeSession("empty1", "page"));
      expect((await get("/api/sessions/empty1/export.txt")).statusCode).toBe(200);
    });

    it("overrides the prayer event of one session or of all live ones", async () => {
      const page = t.manager.add(new FakeSession("page1", "page"));
      const local = t.manager.add(new FakeSession("local1", "device"));
      t.manager.localSession = local;
      const one = await post("/api/sessions/page1/event", { event: "athan" });
      expect(one.json()).toEqual({
        ok: true,
        message: "athan → 1 session(s)",
        sessions: ["page1"],
      });
      expect(page.events).toEqual(["athan"]);
      const list = t.manager.list.bind(t.manager);
      t.manager.list = (): SessionSummary[] => [...list(), { id: "ended" } as SessionSummary];
      const all = await post("/api/sessions/all/event", { event: "none" });
      expect(all.json()).toEqual({
        ok: true,
        message: "Normal → 2 session(s)",
        sessions: ["page1", "local1"],
      });
      expect(local.events).toEqual(["none"]);
      expect((await post("/api/sessions/page1/event", { event: "party" })).statusCode).toBe(400);
      expect((await post("/api/sessions/nope/event", { event: "athan" })).statusCode).toBe(404);
      t.manager.list = () => [];
      t.manager.localSession = null;
      const none = await post("/api/sessions/all/event", { event: "iqama" });
      expect([none.statusCode, none.json().message]).toEqual([409, "No live sessions"]);
    });

    it("hides an unexpected failure behind a 500 and logs it", async () => {
      t.manager.listError = new Error("database on fire");
      const res = await get("/api/sessions");
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ ok: false, message: "Internal server error" });
      expect(t.lines.some((l) => l.msg === "request failed" && l.url === "/api/sessions")).toBe(
        true,
      );
    });
  });

  describe("presets", () => {
    const look = {
      id: "my-look",
      name: "My look",
      vars: { "--cap-font-size": "44px" },
      options: { size: 44 },
    };

    it("lists the built-ins, creates, replaces and deletes custom presets", async () => {
      const empty = await get("/api/presets?screen=whatever");
      expect(empty.json()).toEqual({
        builtin: BUILTIN_PRESETS,
        custom: [],
        default: "mosque-dark",
      });
      expect(empty.headers["cache-control"]).toBe("no-store");
      const created = await post("/api/presets", { preset: look });
      expect([created.statusCode, created.json().message]).toEqual([201, "Created preset my-look"]);
      // The preset may also be the body itself.
      const replaced = await post("/api/presets", { ...look, name: "My look 2" });
      expect([replaced.statusCode, replaced.json().message]).toEqual([
        200,
        "Updated preset my-look",
      ]);
      expect(
        (await get("/api/presets")).json().custom.map((p: { name: string }) => p.name),
      ).toEqual(["My look 2"]);
      const bad = await post("/api/presets", { preset: { ...look, id: "Bad Id" } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().errors[0]).toContain("id");
      const builtin = await post("/api/presets", { preset: { ...look, id: "mosque-dark" } });
      expect(builtin.statusCode).toBe(409);
      expect((await post("/api/presets/my-look", {}, "DELETE")).json()).toEqual({
        ok: true,
        message: "Deleted preset my-look",
      });
      const again = await post("/api/presets/my-look", {}, "DELETE");
      expect([again.statusCode, again.json().errors]).toEqual([404, ["my-look: no such preset"]]);
    });

    it("logs the problems of presets.yaml once, until they change", async () => {
      root.write("presets.yaml", "presets: 5\n");
      await get("/api/presets");
      await get("/api/presets");
      const warned = () => t.lines.filter((l) => l.msg === "presets.yaml problems");
      expect(warned()).toHaveLength(1);
      root.write("presets.yaml", "presets: []\n");
      await get("/api/presets");
      expect(warned()).toHaveLength(1);
    });
  });

  describe("the local session", () => {
    it("starts a recording from DATA_DIR/recordings, or the device", async () => {
      const file = await post("/api/session/start", { file: "test.wav" });
      expect(file.json()).toEqual({ ok: true, message: "Started file" });
      expect(t.manager.localStarts[0]).toEqual({
        source: "file",
        file: join(statRealRoot(root), "recordings", "test.wav"),
        loop: false,
      });
      const again = await post("/api/session/start", { file: "test.wav", loop: true });
      expect(again.statusCode).toBe(409);
      expect(t.manager.localStarts[1]).toMatchObject({ loop: true });
      expect((await post("/api/session/stop")).json()).toEqual({ ok: true, message: "Stopped" });
      const stopAgain = await post("/api/session/stop");
      expect([stopAgain.statusCode, stopAgain.json().ok]).toEqual([409, false]);
      expect((await post("/api/session/start", { source: "device" })).statusCode).toBe(200);
      expect(t.manager.localStarts[2]).toEqual({ source: "device" });
      await post("/api/session/stop");
      // Without a file, and no file input configured: the device.
      expect((await post("/api/session/start")).statusCode).toBe(200);
      expect(t.manager.localStarts[3]).toEqual({ source: "device" });
    });

    it("refuses files outside DATA_DIR/recordings and bad requests", async () => {
      const outside = await post("/api/session/start", { file: "../config.yaml" });
      expect(outside.json()).toEqual({
        ok: false,
        message: "Files must be inside DATA_DIR/recordings",
      });
      const mixed = await post("/api/session/start", { source: "device", file: "test.wav" });
      expect(mixed.json().message).toBe('A file needs source "file"');
      const none = await post("/api/session/start", { source: "file" });
      expect(none.json().message).toBe("No file given (body.file or audio.input.path)");
      const bad = await post("/api/session/start", { loop: "yes" });
      expect([bad.statusCode, bad.json().message]).toEqual([400, expect.stringMatching(/^loop: /)]);
      expect(t.manager.localStarts).toEqual([]);
    });

    it("plays the configured file when the config says so", async () => {
      await t.app.close();
      t = await buildTestApp(
        root,
        "audio:\n  input:\n    kind: file\n    path: recordings/test.wav\n    loop: true\n",
      );
      expect((await post("/api/session/start")).statusCode).toBe(200);
      expect(t.manager.localStarts[0]).toEqual({
        source: "file",
        file: join(root.root, "recordings", "test.wav"),
        loop: true,
      });
    });

    it("clears the captions of the local session or of a named one", async () => {
      const none = await post("/api/captions/clear");
      expect([none.statusCode, none.json().message]).toEqual([409, "No session to clear"]);
      const local = t.manager.add(new FakeSession("local1", "device"));
      t.manager.localSession = local;
      expect((await post("/api/captions/clear")).json()).toEqual({ ok: true, message: "Cleared" });
      const page = t.manager.add(new FakeSession("page1", "page"));
      await post("/api/captions/clear", { session: "page1", track: "soniox" });
      expect([local.clears, page.clears]).toEqual([["all"], ["soniox"]]);
      expect((await post("/api/captions/clear", { session: "nope" })).statusCode).toBe(409);
      expect((await post("/api/captions/clear", { track: "gemini" })).statusCode).toBe(400);
    });

    it("saves a preset as the default in config.yaml, keeping its comments", async () => {
      await post("/api/presets", { preset: { id: "my-look", name: "My look" } });
      const saved = await post("/api/config/save-default", { preset: "my-look" });
      expect(saved.json()).toEqual({
        ok: true,
        message: `Saved as default in ${join(root.root, "config.yaml")}`,
      });
      const text = readFileSync(root.path("config.yaml"), "utf8");
      expect(text).toContain("# keep this comment");
      expect(text).toContain("preset: my-look");
      expect((await get("/api/presets")).json().default).toBe("my-look");
      expect((await post("/api/config/save-default", { preset: "mosque-dark" })).statusCode).toBe(
        200,
      );
      const unknown = await post("/api/config/save-default", { preset: "nope" });
      expect([unknown.statusCode, unknown.json().message]).toEqual([400, 'Unknown preset "nope"']);
      const nothing = await post("/api/config/save-default", {});
      expect(nothing.json().message).toBe("Nothing to save (preset)");
      expect((await post("/api/config/save-default", { preset: 5 })).statusCode).toBe(400);
      root.write("config.yaml", "display: [unclosed\n");
      const broken = await post("/api/config/save-default", { preset: "mosque-dark" });
      expect(broken.statusCode).toBe(400);
      expect(broken.json().message).toMatch(/^Cannot edit /);
      expect((await get("/api/presets")).json().default).toBe("mosque-dark");
    });

    it("lists audio devices, and says when it cannot", async () => {
      expect((await get("/api/devices")).json()).toEqual([{ name: "Fake mic" }]);
      await t.app.close();
      t = await buildTestApp(root);
      expect((await get("/api/devices")).statusCode).toBe(501);
      await t.app.close();
      t = await buildTestApp(root, "server:\n  token: tok-secret-1234\n", {
        app: {
          listDevices: async () => {
            throw new Error("ffmpeg said tok-secret-1234");
          },
        },
      });
      const failed = await t.app.inject({ url: "/api/devices" });
      expect(failed.statusCode).toBe(500);
      expect(failed.json().message).not.toContain("tok-secret-1234");
      await t.app.close();
      t = await buildTestApp(root, "", {
        app: {
          listDevices: async () => {
            throw "not an error";
          },
        },
      });
      expect((await get("/api/devices")).json()).toEqual({ ok: false, message: "not an error" });
    });
  });

  describe("request bodies and errors", () => {
    it("explains a body that is not an object", async () => {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/captions/clear",
        headers: { "content-type": "application/json" },
        payload: "5",
      });
      expect([res.statusCode, res.json().message]).toEqual([
        400,
        "Invalid input: expected object, received number",
      ]);
    });

    it("treats an empty JSON body as {}, and refuses invalid JSON and other types", async () => {
      const empty = await t.app.inject({
        method: "POST",
        url: "/api/captions/clear",
        headers: { "content-type": "application/json" },
        payload: " ",
      });
      expect(empty.json().message).toBe("No session to clear");
      const invalid = await t.app.inject({
        method: "POST",
        url: "/api/captions/clear",
        headers: { "content-type": "application/json; charset=utf-8" },
        payload: "{nope",
      });
      expect([invalid.statusCode, invalid.json()]).toEqual([
        400,
        { ok: false, message: "Invalid JSON body" },
      ]);
      const text = await t.app.inject({
        method: "POST",
        url: "/api/session/stop",
        headers: { "content-type": "text/plain" },
        payload: "{}",
      });
      expect([text.statusCode, text.json().message]).toEqual([
        415,
        "Content-Type must be application/json",
      ]);
      const none = await t.app.inject({ method: "POST", url: "/api/session/stop" });
      expect(none.statusCode).toBe(415);
      // Bodies are small: a 64 KiB limit, answered in JSON.
      const big = await t.app.inject({
        method: "POST",
        url: "/api/captions/clear",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ pad: "x".repeat(70_000) }),
      });
      expect(big.statusCode).toBe(413);
      expect(big.json().ok).toBe(false);
    });
  });

  describe("WebSockets", () => {
    it("serves the overlay hub on /ws and caption pages on /ws/page", async () => {
      await t.app.ready();
      const overlay = await openWS(t.app, "/ws?session=");
      expect(await overlay.next()).toMatchObject({ type: "hello", sessionId: null });
      overlay.ws.terminate();
      const followed = await openWS(t.app, "/ws?session=page9");
      expect(await followed.next()).toMatchObject({ type: "hello", sessionId: null });
      followed.ws.terminate();
      const page = await openWS(t.app, "/ws/page");
      page.ws.send(JSON.stringify(hello()));
      expect(await page.next()).toMatchObject({ type: "ready", sessionId: "page1" });
      page.ws.terminate();
    });

    it("refuses a WebSocket upgrade on any other route", async () => {
      await t.app.ready();
      await expect(openWS(t.app, "/ar/nl?key=SECRET")).rejects.toThrow(/404/);
    });
  });

  describe("logs", () => {
    it("never logs query strings or feed GUIDs, and skips health checks and static files", async () => {
      await t.app.close();
      t = await buildTestApp(root, "", { logLevel: "info" });
      await get("/ar/nl?key=SECRET-KEY-123");
      await get("/feed/1b4e28ba-2fa1-41d2-883f-0016d3cca427?debug=1");
      await get("/nope?token=SECRET-TOKEN-456");
      await t.app.inject({ method: "POST", url: "/health" });
      await get("/health");
      await get("/assets/x.js");
      const text = JSON.stringify(t.lines);
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("1b4e28ba");
      expect(
        t.lines.some(
          (l) => l.msg === "incoming request" && (l.req as { url: string }).url === "/ar/nl",
        ),
      ).toBe(true);
      expect(text).not.toContain('"/health"');
      expect(text).not.toContain("/assets/");
    });

    it("warns about a short CAPTIONS_SECRET, and about an unreadable usage file", async () => {
      await t.app.close();
      root.write(`usage/usage-${localMonth()}.json`, "{broken");
      t = await buildTestApp(root, "", {
        app: { secret: new SigningSecret(root.path("secret.key"), "short") },
      });
      expect(
        t.lines.some(
          (l) => l.msg === "CAPTIONS_SECRET is short; use at least 16 random characters",
        ),
      ).toBe(true);
      expect(t.lines.some((l) => l.msg === "usage: flush failed")).toBe(true);
    });

    it("flushes a usage store it was given on close, and leaves it open", async () => {
      await t.app.close();
      const usage = new UsageStore({ dir: root.path("given-usage"), flushIntervalMs: 0 });
      t = await buildTestApp(root, "", { app: { usage } });
      usage.add(null, "soniox", 60_000);
      await t.app.close();
      const file = root.path("given-usage", `usage-${localMonth()}.json`);
      expect(JSON.stringify(JSON.parse(readFileSync(file, "utf8")).days)).toContain(
        '{"local":{"soniox":60000}}',
      );
      // Still the caller's to use (and to close).
      usage.add(null, "soniox", 60_000);
      expect(usage.minutesToday(null)).toBe(2);
      usage.close();
      t = await buildTestApp(root); // for afterEach
    });
  });
});

describe("resolveRecording", () => {
  let root: TempRoot;
  beforeEach(() => {
    root = new TempRoot("recordings-", []);
  });
  afterEach(() => {
    root.remove();
  });

  it("finds files strictly inside DATA_DIR/recordings", () => {
    const dir = root.path("recordings");
    expect(resolveRecording(dir, root.root, "a.wav")).toEqual({
      ok: false,
      message: "There is no recordings folder in DATA_DIR",
    });
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.wav"), "x");
    writeFileSync(root.path("outside.wav"), "x");
    symlinkSync(root.path("outside.wav"), join(dir, "link.wav"));
    const real = statRealRoot(root);
    expect(resolveRecording(dir, root.root, "a.wav")).toEqual({
      ok: true,
      path: join(real, "recordings", "a.wav"),
    });
    expect(resolveRecording(dir, root.root, "recordings/a.wav")).toMatchObject({ ok: true });
    expect(resolveRecording(dir, root.root, join(dir, "a.wav"))).toMatchObject({ ok: true });
    expect(resolveRecording(dir, root.root, root.path("outside.wav"))).toEqual({
      ok: false,
      message: "Files must be inside DATA_DIR/recordings",
    });
    expect(resolveRecording(dir, root.root, "link.wav")).toMatchObject({ ok: false });
    expect(resolveRecording(dir, root.root, "sub")).toEqual({
      ok: false,
      message: "Not a file: sub",
    });
    expect(resolveRecording(dir, root.root, "a\0.wav")).toEqual({
      ok: false,
      message: "Invalid file name",
    });
    const long = `${"m".repeat(130)}.wav`;
    expect(resolveRecording(dir, root.root, long)).toEqual({
      ok: false,
      message: `Recording not found: ${"m".repeat(120)}…`,
    });
  });
});

describe("saveDefaults", () => {
  let root: TempRoot;
  beforeEach(() => {
    root = new TempRoot("save-defaults-", []);
  });
  afterEach(() => {
    root.remove();
  });

  it("creates config.yaml from the example when there is none", () => {
    const loaded = root.load();
    rmSync(root.path("config.yaml"));
    loaded.paths.configFile = null;
    const result = saveDefaults(loaded, { preset: "mosque-light", requireScreen: true });
    expect(result.ok).toBe(true);
    const text = readFileSync(root.path("config.yaml"), "utf8");
    expect(text).toContain("preset: mosque-light");
    expect(text).toContain("requireScreen: true");
    expect(statSync(root.path("config.yaml")).mode & 0o777).toBe(0o600);
  });

  it("keeps the file's mode, and refuses a change that would make the config invalid", () => {
    const loaded = root.load("pages:\n  requireScreen: false\n");
    const file = root.path("config.yaml");
    chmodSync(file, 0o640);
    expect(saveDefaults(loaded, { requireScreen: true })).toMatchObject({ ok: true });
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readFileSync(file, "utf8")).toContain("requireScreen: true");
    const invalid = saveDefaults(loaded, { preset: "" });
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toMatch(/^The saved config would be invalid: display\.preset/);
  });
});

/** The temp root with symlinks resolved (macOS: /var → /private/var). */
function statRealRoot(root: TempRoot): string {
  return realpathSync(root.root);
}

function localMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
