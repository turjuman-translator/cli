// End-to-end smoke for the browser caption page: headless Chrome with a fake microphone fed from a
// WAV file streams to the running server and must render captions.
// Usage: pnpm test:e2e:caption, with the server already running (`pnpm captions run`, or
//        `run --fake-provider`).
// Env: E2E_BASE_URL (default http://127.0.0.1:8765), E2E_WAV (default recordings/tts-ar.wav),
//      E2E_PATH (default /ar/nl), PLAYWRIGHT_CHANNEL (default "chrome"; unset in Docker = bundled),
//      E2E_TIMEOUT_MS (default 90000), E2E_OUT (screenshot dir, default <tmp>/turjuman-e2e),
//      E2E_MIN_BLOCKS (blocks layout: pass threshold, default 1),
//      E2E_DURATION_MS (keep listening at least this long, e.g. the WAV length; default 0),
//      E2E_SHOTS_EVERY_MS (extra screenshots at this interval; default 0 = final only),
//      E2E_VIEWPORT (default 1920x1080).
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

interface CaptionStats {
  state: string;
  sessionId: string | null;
  layout?: string;
  mode?: string;
  segments: number;
  finals: number;
  blocks?: number;
  latency: { p50Ms: number | null; p95Ms: number | null; n: number };
}

interface BlockLine {
  seq: number;
  kind: string;
  text: string;
  ref: string | null;
  src: string | null;
  hidden?: boolean;
  event?: { type: string; active: boolean };
}

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8765";
const wav = resolve(process.env.E2E_WAV ?? "recordings/tts-ar.wav");
const path = process.env.E2E_PATH ?? "/ar/nl";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 90_000);
const outDir = resolve(process.env.E2E_OUT ?? join(tmpdir(), "turjuman-e2e"));
const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.env.E2E_BASE_URL ? undefined : "chrome");
const minBlocks = Number(process.env.E2E_MIN_BLOCKS ?? 1);
const durationMs = Number(process.env.E2E_DURATION_MS ?? 0);
const shotsEveryMs = Number(process.env.E2E_SHOTS_EVERY_MS ?? 0);
const [vw, vh] = (process.env.E2E_VIEWPORT ?? "1920x1080").split("x").map(Number);

function passed(stats: CaptionStats | null): boolean {
  if (stats === null) return false;
  return stats.layout === "blocks" ? (stats.blocks ?? 0) >= minBlocks : stats.finals >= 1;
}

async function fetchBlocks(sessionId: string): Promise<BlockLine[]> {
  try {
    const res = await fetch(
      `${base}/api/sessions/${encodeURIComponent(sessionId)}/blocks?limit=200`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { blocks?: BlockLine[] };
    return body.blocks ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    ...(channel ? { channel } : {}),
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: vw ?? 1920, height: vh ?? 1080 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const url = `${base}${path}${path.includes("?") ? "&" : "?"}debug=1`;
    console.log(`open ${url} (fake mic: ${wav})`);
    await page.goto(url);
    const started = Date.now();
    let stats: CaptionStats | null = null;
    let nextShot = shotsEveryMs > 0 ? started + shotsEveryMs : Number.POSITIVE_INFINITY;
    let shot = 0;
    while (Date.now() - started < Math.max(timeoutMs, durationMs)) {
      stats = await page.evaluate(
        () => (globalThis as unknown as { __captionStats?: CaptionStats }).__captionStats ?? null,
      );
      if (Date.now() >= nextShot) {
        shot += 1;
        await page.screenshot({
          path: join(outDir, `caption-page-${String(shot).padStart(3, "0")}.png`),
        });
        nextShot += shotsEveryMs;
      }
      if (passed(stats) && Date.now() - started >= durationMs) break;
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: join(outDir, "caption-page.png") });
    console.log("stats:", JSON.stringify(stats));
    const text = await page.evaluate(
      () =>
        (globalThis as unknown as { document: { body: { innerText: string } } }).document.body
          .innerText,
    );
    console.log("rendered text:", text.slice(0, 600).replace(/\s+/g, " "));
    if (stats?.sessionId) {
      const blocks = await fetchBlocks(stats.sessionId);
      if (blocks.length > 0) {
        const lines = blocks.map((b) => {
          const tag = b.kind === "event" ? `event:${b.event?.type ?? "?"}` : b.kind;
          const ref = b.ref !== null ? ` (${b.ref})` : "";
          return `#${b.seq} ${tag}${b.hidden ? " [hidden]" : ""}${ref}: ${b.text}`;
        });
        writeFileSync(join(outDir, "blocks.txt"), `${lines.join("\n")}\n`);
        console.log(`blocks (${blocks.length}) → ${join(outDir, "blocks.txt")}`);
        for (const l of lines) console.log(`  ${l}`);
      }
    }
    if (errors.length > 0) console.log("page errors:", errors.slice(0, 5));
    const ok = passed(stats);
    console.log(ok ? "E2E PASS" : "E2E FAIL");
    return ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
