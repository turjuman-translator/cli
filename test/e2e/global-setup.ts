// Builds the server, the app and the website once before the end-to-end suites (they run the
// real dist/main.js and serve public/). E2E_SKIP_BUILD=1 reuses an existing build.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./helpers/paths.js";

export default function setup(): void {
  if (process.env.E2E_SKIP_BUILD === "1" && existsSync(join(REPO, "dist", "main.js"))) return;
  execFileSync("pnpm", ["build"], { cwd: REPO, stdio: "inherit" });
}
