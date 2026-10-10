// `turjuman open [app|builder|look]`: opens this server's app in the browser of this computer
// (`open` on macOS, `xdg-open` on Linux, `cmd /c start ""` on Windows, always as an argument
// list, never a shell string) and prints the address as well.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import type { LoadedConfig } from "../config.js";
import type { CliIo } from "./index.js";
import { APP_PAGES, type AppPage, browserOrigin, serverAddresses } from "./urls.js";
import { isParseArgsError, parseErrorText } from "./usage.js";

export interface OpenDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

const HELP = `turjuman open [app|builder|look]

  Opens a page of the app in the browser on this computer, and prints its address:
    app       the dashboard: your screens, their switches and screen links (the default)
    builder   make a new screen: languages, layout, look
    look      fine-tune how the captions look`;

const LABEL: Readonly<Record<AppPage, string>> = {
  app: "the app",
  builder: "the builder",
  look: "the look editor",
};

function isAppPage(page: string): page is AppPage {
  return Object.hasOwn(APP_PAGES, page);
}

/** The program and its arguments that open `url` in the default browser. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): { command: string; args: string[]; verbatim: boolean } {
  if (platform === "darwin") return { command: "open", args: [url], verbatim: false };
  if (platform === "win32") {
    // Passed to cmd as written: "" is start's window title, and ^ keeps cmd from reading
    // & | < > ( ) in the address as its own operators.
    return {
      command: "cmd",
      args: ["/c", "start", '""', url.replace(/[\^&|<>()]/g, "^$&")],
      verbatim: true,
    };
  }
  return { command: "xdg-open", args: [url], verbatim: false };
}

/** Start the browser; resolves with the problem when the program could not be started. */
function launch(
  doSpawn: NonNullable<OpenDeps["spawn"]>,
  command: string,
  args: string[],
  verbatim: boolean,
): Promise<Error | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = doSpawn(command, args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      resolve(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.once("error", (err) => resolve(err));
    child.once("spawn", () => {
      child.unref();
      resolve(null);
    });
  });
}

/** `turjuman open [app|builder|look]`. */
export async function openCommand(
  args: string[],
  io: CliIo,
  load: () => LoadedConfig,
  deps: OpenDeps = {},
): Promise<number> {
  let positionals: string[];
  let help: boolean;
  try {
    ({
      positionals,
      values: { help },
    } = parseArgs({
      args,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h", default: false } },
    }));
  } catch (err) {
    io.err(
      `open: ${isParseArgsError(err) ? parseErrorText(err) : err instanceof Error ? err.message : String(err)}\n\n${HELP}`,
    );
    return 2;
  }
  if (help || args[0] === "help") {
    io.out(HELP);
    return 0;
  }
  const page = positionals[0] ?? "app";
  if (positionals.length > 1 || !isAppPage(page)) {
    io.err(`open: choose app, builder or look\n\n${HELP}`);
    return 2;
  }
  const loaded = load();
  const url = new URL(`${browserOrigin(serverAddresses(loaded))}${APP_PAGES[page]}`).href;
  io.out(`Opening ${LABEL[page]}: ${url}`);
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    io.err("No desktop session here (DISPLAY is not set): open the address in a browser yourself.");
    return 0;
  }
  const { command, args: argv, verbatim } = browserCommand(url, platform);
  const problem = await launch(deps.spawn ?? spawn, command, argv, verbatim);
  if (problem !== null) {
    io.err(
      `Could not start a browser (${command}: ${problem.message}); open the address yourself.`,
    );
    return 1;
  }
  return 0;
}
