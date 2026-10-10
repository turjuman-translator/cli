// The system Chrome for the end-to-end suites (playwright-core, no browser download). Every page
// records its console errors, uncaught errors and Content-Security-Policy violations, so a test
// can assert there were none.
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

export interface ChromeOptions {
  /** A WAV for the fake microphone (the caption page listens to it); none = no microphone. */
  fakeMicWav?: string;
}

export function launchChrome(opts: ChromeOptions = {}): Promise<Browser> {
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (opts.fakeMicWav !== undefined)
    args.push(`--use-file-for-fake-audio-capture=${opts.fakeMicWav}`);
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
  return chromium.launch({ headless: true, args, ...(channel === "" ? {} : { channel }) });
}

export interface WatchedPage {
  page: Page;
  context: BrowserContext;
  /** Console errors, uncaught page errors and CSP violations, in order. */
  problems: string[];
}

/** A new page (own context: own cookies) that records its problems. */
export async function openPage(
  browser: Browser,
  opts: { width?: number; height?: number; locale?: string; isMobile?: boolean } = {},
): Promise<WatchedPage> {
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    locale: opts.locale ?? "en-US",
    ...(opts.isMobile === true ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  // Runs in the page (a string: this file is type-checked without the DOM library).
  await page.addInitScript({
    content:
      "document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));",
  });
  return { page, context, problems };
}
