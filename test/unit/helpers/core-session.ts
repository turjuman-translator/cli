// A CaptionSession wired to the core fakes, with every message it sends kept for the test.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "../../../src/config.js";
import type { AudioInputApi, AudioInputSpec } from "../../../src/core/contracts.js";
import {
  CaptionSession,
  type CaptionSessionOptions,
  type PageOptions,
} from "../../../src/core/session.js";
import type { ServerMessage, SessionKind, Status } from "../../../src/shared/protocol.js";
import {
  type ControlledOptions,
  captureLog,
  controlledFactory,
  ManualInput,
  testConfig,
} from "./core-fakes.js";

export interface SessionSetup {
  kind?: SessionKind;
  config?: Record<string, unknown>;
  providers?: ControlledOptions[];
  page?: Partial<PageOptions>;
  spec?: AudioInputSpec;
  /** Build the input yourself (default: a ManualInput for `spec`). */
  input?: (spec: AudioInputSpec) => AudioInputApi;
  options?: Partial<CaptionSessionOptions>;
  loaded?: LoadedConfig;
}

export function makeSession(dataDir: string, s: SessionSetup = {}) {
  const kind = s.kind ?? "page";
  const loaded = s.loaded ?? testConfig(dataDir, s.config ?? {});
  const f = controlledFactory(...(s.providers ?? []));
  const cap = captureLog();
  const messages: ServerMessage[] = [];
  const stopped: CaptionSession[] = [];
  const inputs: ManualInput[] = [];
  const spec: AudioInputSpec = s.spec ?? { kind: "device", device: "Line In" };
  const session = new CaptionSession({
    kind,
    loaded,
    engineFactory: f.factory,
    log: cap.log,
    now: () => Date.now(),
    from: "ar",
    to: "nl",
    glossary: null,
    saveTranscripts: true,
    onStopped: (x) => stopped.push(x),
    ...(kind === "page"
      ? {
          page: {
            keyId: "key-1",
            keyLabel: "Main hall",
            client: { obs: false, ua: "test" },
            ...s.page,
          },
        }
      : {
          local: {
            spec,
            inputFactory:
              s.input ??
              ((sp) => {
                const input = new ManualInput(sp);
                inputs.push(input);
                return input;
              }),
          },
        }),
    ...s.options,
  });
  session.subscribe((m) => messages.push(m));
  return {
    session,
    loaded,
    f,
    cap,
    messages,
    stopped,
    inputs,
    statuses: (): Status[] => messages.flatMap((m) => (m.type === "status" ? [m.status] : [])),
    of: <T extends ServerMessage["type"]>(type: T) =>
      messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type),
    /** The session's transcript folder (null before it exists). */
    dir: (): string | null => {
      const root = loaded.paths.transcriptsDir;
      if (!existsSync(root)) return null;
      const name = readdirSync(root).find((n) => n.endsWith(`_${session.id}`));
      return name === undefined ? null : join(root, name);
    },
    /** session.jsonl markers (type + data). */
    markers: (): Array<Record<string, unknown>> => {
      const root = loaded.paths.transcriptsDir;
      const name = existsSync(root)
        ? readdirSync(root).find((n) => n.endsWith(`_${session.id}`))
        : undefined;
      if (name === undefined) return [];
      const file = join(root, name, "session.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}
