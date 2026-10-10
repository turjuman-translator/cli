import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // `pnpm test:coverage`: every source file of the server, the CLI, the app and the website
    // counts (with `include` set, files no test imports yet count as uncovered). Browser code runs
    // in happy-dom (`// @vitest-environment happy-dom` at the top of its test file). Every line,
    // statement and function is covered; the run fails when that drops (branches: the fallbacks
    // TypeScript asks for that can never run are the ~2 % left).
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "web/**/*.ts", "site/**/*.ts"],
      exclude: ["**/*.d.ts", "**/tsconfig*.json"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 98 },
    },
  },
});
