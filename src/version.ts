import { readFileSync } from "node:fs";

/** The app version from package.json (works from src/ under tsx and from dist/). */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
