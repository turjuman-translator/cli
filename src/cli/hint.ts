// The commands that hints print, for where this process runs: a checkout runs the CLI through
// pnpm, the Docker image is driven with make on the host (a target of its own when there is one,
// else `make cli ARGS=…`).
import { dirname, isAbsolute, relative } from "node:path";

/** Whether this process runs in the Docker image (Dockerfile: CAPTIONS_CONTAINER=1). */
export function inContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAPTIONS_CONTAINER === "1";
}

/** Commands that have a make target of their own. */
const MAKE_TARGETS: Record<string, string> = {
  setup: "make keys",
  "setup --check": "make doctor ONLINE=1",
  start: "make up",
  open: "make admin",
  "screens list": "make screens",
  "users list": "make users",
  status: "make status",
  doctor: "make doctor",
  "doctor --online": "make doctor ONLINE=1",
};

/** How to run `turjuman <args>`: `pnpm turjuman <args>`, or in Docker the make command for it. */
export function turjumanCmd(args: string, container = inContainer()): string {
  if (!container) return `pnpm turjuman ${args}`;
  const admin = /^users add (\S+) --admin$/.exec(args);
  if (admin !== null) return `make user-add USERNAME=${admin[1]} ADMIN=1`;
  return MAKE_TARGETS[args] ?? `make cli ARGS='${args}'`;
}

/** How to download the Quran text and translations (once). */
export function quranDataCmd(container = inContainer()): string {
  return container ? "make quran-data" : "pnpm exec tsx scripts/quran-data.ts";
}

/** How to make the LAN certificate in the folder of server.https.certFile. */
export function lanCertCmd(
  certFile: string,
  container = inContainer(),
  cwd = process.cwd(),
): string {
  if (container) return "make lan-cert";
  const dir = dirname(certFile);
  const rel = relative(cwd, dir);
  const shown = rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? dir : rel;
  return `bash scripts/lan-cert.sh ${/[\s'"]/.test(shown) ? `"${shown}"` : shown}`;
}
