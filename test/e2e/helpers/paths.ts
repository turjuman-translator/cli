// Where the end-to-end suites find the repository and the built binary.
import { fileURLToPath } from "node:url";

/** The repository (this file is test/e2e/helpers/paths.ts). */
export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** The built CLI and server. */
export const MAIN = fileURLToPath(new URL("../../../dist/main.js", import.meta.url));
