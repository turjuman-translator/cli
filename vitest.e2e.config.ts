import { defineConfig } from "vitest/config";

// `pnpm test:e2e`: the end-to-end suites. They use the real `turjuman` binary (dist/), real
// servers on free ports in temp folders, and the system Chrome (playwright-core) for the website
// and the app. One build first (test/e2e/global-setup.ts; E2E_SKIP_BUILD=1 skips it). Files run
// one at a time: each starts its own servers and browsers.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    environment: "node",
    globalSetup: ["test/e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
