// Web build (esbuild → public/). `pnpm build:web`; `--watch` rebuilds on changes in web/ and
// src/shared/ (dev). Output layout (served by src/server):
//   public/<page>.html                 picker, caption, overlay, control, archive, customize
//   public/assets/<name>-<hash>.js|css bundles (immutable)
//   public/fonts/<name>-<hash>.woff2   Noto Naskh Arabic + Noto Sans (from @fontsource, offline)
// The capture worklet is built first; its hashed URL is injected into the pages as
// __WORKLET_URL__. HTML templates (web/<page>.html) contain %SCRIPT% and %STYLE% placeholders and
// never inline scripts or styles (CSP).
// The app is installable on a phone's home screen: the icons in web/icons/ (rendered once from the
// mark in web/shared/brand.ts) and a web-app manifest are written as hashed files under
// public/assets/; app templates reference them with %MANIFEST% and %APPLE_ICON%.
import { createHash } from "node:crypto";
import { existsSync, watch as fsWatch } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(ROOT, "public");
const PAGES = [
  "picker",
  "caption",
  "overlay",
  "control",
  "archive",
  "customize",
  "login",
  "admin",
  "signup",
  "keys",
] as const;
/** Pages the build can do without: skipped with a warning while their files are missing. */
const OPTIONAL_PAGES: ReadonlySet<string> = new Set(["customize", "signup", "keys"]);
const WORKLET = "capture-worklet";

/** The home-screen icons (web/icons/), with their manifest entries. */
const ICONS = [
  { file: "icon-192.png", sizes: "192x192", purpose: "any" },
  { file: "icon-512.png", sizes: "512x512", purpose: "any" },
  { file: "icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
  { file: "apple-touch-icon.png", sizes: "180x180", purpose: null },
] as const;

/** Brand colours of the installed app (web/shared/brand.css: --tj-paper). */
const APP_BACKGROUND = "#ffffff";

export interface BuildResult {
  files: string[];
  ms: number;
}

function common(dev: boolean): esbuild.BuildOptions {
  return {
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    target: "chrome103",
    minify: !dev,
    sourcemap: dev ? "linked" : false,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    outdir: OUT,
    entryNames: "assets/[name]-[hash]",
    assetNames: "fonts/[name]-[hash]",
    publicPath: "/",
    loader: { ".woff2": "file" },
    logLevel: "silent",
  };
}

/** Public URL ("/assets/x-HASH.js") of a metafile output path. */
function publicUrl(outPath: string): string {
  const rel = path.relative(OUT, path.resolve(ROOT, outPath)).split(path.sep).join("/");
  return `/${rel}`;
}

function outputFor(meta: esbuild.Metafile, entry: string): { js: string; css: string | null } {
  for (const [out, info] of Object.entries(meta.outputs)) {
    if (info.entryPoint && path.resolve(ROOT, info.entryPoint) === entry && out.endsWith(".js")) {
      return { js: out, css: info.cssBundle ?? null };
    }
  }
  throw new Error(`no output for ${path.relative(ROOT, entry)}`);
}

function contentHash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("base64url").slice(0, 8).toUpperCase();
}

/** Write `data` as public/assets/<name>-<hash>.<ext>; returns its public URL and file path. */
async function writeHashed(
  name: string,
  ext: string,
  data: Buffer | string,
): Promise<{ url: string; file: string }> {
  const rel = `assets/${name}-${contentHash(data)}.${ext}`;
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return { url: `/${rel}`, file };
}

/** Icons and the web-app manifest (installable app: start /app, standalone, brand colours). */
async function buildManifest(): Promise<{ manifest: string; appleIcon: string; files: string[] }> {
  const files: string[] = [];
  const urls = new Map<string, string>();
  for (const icon of ICONS) {
    const data = await readFile(path.join(WEB, "icons", icon.file));
    const out = await writeHashed(icon.file.replace(/\.png$/, ""), "png", data);
    urls.set(icon.file, out.url);
    files.push(out.file);
  }
  const manifest = {
    id: "/app",
    name: "Turjuman",
    short_name: "Turjuman",
    description: "Live khutbah captions for mosque screens",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    icons: ICONS.filter((i) => i.purpose !== null).map((i) => ({
      src: urls.get(i.file),
      sizes: i.sizes,
      type: "image/png",
      purpose: i.purpose,
    })),
  };
  const out = await writeHashed("app", "webmanifest", `${JSON.stringify(manifest, null, 2)}\n`);
  files.push(out.file);
  return { manifest: out.url, appleIcon: urls.get("apple-touch-icon.png") ?? "", files };
}

/** Delete hashed files from earlier builds. */
async function removeStale(keep: Set<string>): Promise<void> {
  for (const dir of ["assets", "fonts"]) {
    const abs = path.join(OUT, dir);
    if (!existsSync(abs)) continue;
    for (const name of await readdir(abs)) {
      const file = path.join(abs, name);
      if (!keep.has(file)) await rm(file, { force: true, recursive: true });
    }
  }
}

export async function buildWeb(opts: { dev?: boolean } = {}): Promise<BuildResult> {
  const t0 = performance.now();
  const dev = opts.dev ?? false;
  await mkdir(OUT, { recursive: true });

  // 1. The worklet, on its own (audioWorklet.addModule loads it as a module).
  const workletEntry = path.join(WEB, `${WORKLET}.ts`);
  const worklet = await esbuild.build({
    ...common(dev),
    entryPoints: { [WORKLET]: workletEntry },
  });
  const workletOut = outputFor(worklet.metafile ?? { inputs: {}, outputs: {} }, workletEntry);
  const workletUrl = publicUrl(workletOut.js);

  // 2. The pages (each imports its own CSS; fonts are emitted via CSS url()). Required pages
  //    build together; optional pages (still being written elsewhere) build on their own, so a
  //    broken optional page is skipped with a warning instead of failing the caption pages.
  const define = { __WORKLET_URL__: JSON.stringify(workletUrl) };
  const required: Record<string, string> = {};
  const optional: string[] = [];
  for (const page of PAGES) {
    const entry = path.join(WEB, `${page}.ts`);
    const template = path.join(WEB, `${page}.html`);
    const present = existsSync(entry) && existsSync(template);
    if (OPTIONAL_PAGES.has(page)) {
      if (present) optional.push(page);
      else console.warn(`build:web: skipping ${page}: web/${page}.ts or .html not found`);
    } else if (!present) {
      throw new Error(`missing web/${page}.ts or web/${page}.html`);
    } else {
      required[page] = entry;
    }
  }
  const metas: esbuild.Metafile[] = [worklet.metafile ?? { inputs: {}, outputs: {} }];
  const built: Array<{ page: string; meta: esbuild.Metafile }> = [];
  const pages = await esbuild.build({ ...common(dev), entryPoints: required, define });
  const pagesMeta = pages.metafile ?? { inputs: {}, outputs: {} };
  metas.push(pagesMeta);
  for (const page of Object.keys(required)) built.push({ page, meta: pagesMeta });
  for (const page of optional) {
    try {
      const r = await esbuild.build({
        ...common(dev),
        entryPoints: { [page]: path.join(WEB, `${page}.ts`) },
        define,
      });
      const meta = r.metafile ?? { inputs: {}, outputs: {} };
      metas.push(meta);
      built.push({ page, meta });
    } catch (err) {
      console.warn(`build:web: skipping ${page} (build failed):\n${formatError(err)}`);
      await rm(path.join(OUT, `${page}.html`), { force: true });
    }
  }

  // 3. The installable app: icons and the manifest.
  const app = await buildManifest();

  // 4. HTML templates → public/<page>.html with the hashed paths.
  const keep = new Set<string>(app.files);
  for (const meta of metas) {
    for (const out of Object.keys(meta.outputs)) keep.add(path.resolve(ROOT, out));
  }
  const written: string[] = [];
  for (const { page, meta } of built) {
    const { js, css } = outputFor(meta, path.join(WEB, `${page}.ts`));
    const template = await readFile(path.join(WEB, `${page}.html`), "utf8");
    if (!template.includes("%SCRIPT%")) throw new Error(`web/${page}.html lacks %SCRIPT%`);
    let html = template
      .replaceAll("%SCRIPT%", publicUrl(js))
      .replaceAll("%MANIFEST%", app.manifest)
      .replaceAll("%APPLE_ICON%", app.appleIcon);
    if (css) html = html.replaceAll("%STYLE%", publicUrl(css));
    else html = html.replace(/^.*%STYLE%.*\n?/m, "");
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\sstyle\s*=/i.test(html)) {
      throw new Error(`web/${page}.html has an inline script or style attribute (CSP)`);
    }
    const file = path.join(OUT, `${page}.html`);
    await writeFile(file, html);
    written.push(file);
  }
  await removeStale(keep);

  return {
    files: [...written, ...[...keep].sort()].map((f) => path.relative(ROOT, f)),
    ms: Math.round(performance.now() - t0),
  };
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "errors" in err && Array.isArray(err.errors)) {
    const msgs = esbuild.formatMessagesSync(err.errors as esbuild.Message[], {
      kind: "error",
      color: process.stdout.isTTY,
    });
    return msgs.join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

/** Rebuild everything (≈100 ms) on any change below web/ or src/shared/. */
export async function watchWeb(): Promise<void> {
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const r = await buildWeb({ dev: true });
      console.log(`build:web: rebuilt in ${r.ms} ms`);
    } catch (err) {
      console.error(`build:web: failed:\n${formatError(err)}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void run(), 80);
  };
  for (const dir of [WEB, path.join(ROOT, "src", "shared")]) {
    fsWatch(dir, { recursive: true }, schedule);
  }
  await run();
  console.log("build:web: watching web/ and src/shared/");
}

async function main(): Promise<void> {
  if (process.argv.includes("--watch")) {
    await watchWeb();
    return;
  }
  try {
    const r = await buildWeb();
    for (const f of r.files) console.log(`  ${f}`);
    console.log(`build:web: ${r.files.length} files in ${r.ms} ms`);
  } catch (err) {
    console.error(`build:web: failed:\n${formatError(err)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
