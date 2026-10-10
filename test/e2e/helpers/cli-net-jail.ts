// A network jail for the processes the CLI end-to-end tests start (loaded with `--import` through
// NODE_OPTIONS, see jailEnv in cli-tools.ts): an outgoing TCP connection may only go to this
// computer. A connection to any other host is refused before its name is even looked up, or, when
// E2E_NET_REDIRECT names the host ("api.soniox.com:443=127.0.0.1:5000,…"), sent to a local fake
// instead (TLS still checks the certificate against the real name). Every attempt is appended to
// E2E_NET_LOG as a JSON line, so a test can show that nothing reached Soniox.
// This file runs in the child process: Node strips its types (no build step).
import { appendFileSync } from "node:fs";
import net from "node:net";

interface Target {
  host?: string;
  port?: number | string;
  path?: string;
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

const LOG = process.env.E2E_NET_LOG ?? "";
const REDIRECTS = new Map<string, { host: string; port: number }>();
for (const entry of (process.env.E2E_NET_REDIRECT ?? "").split(",")) {
  const [from, to] = entry.split("=");
  const [toHost, toPort] = (to ?? "").split(":");
  if (from !== undefined && from !== "" && toHost !== undefined && toPort !== undefined) {
    REDIRECTS.set(from.toLowerCase(), { host: toHost, port: Number(toPort) });
  }
}

function local(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

function record(entry: Record<string, unknown>): void {
  if (LOG !== "") appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

/** The options object of a connect() call: net.connect passes [options, callback] as one array. */
function targetOf(args: unknown[]): { target: Target; replace: (t: Target) => unknown[] } {
  const first = args[0];
  if (Array.isArray(first)) {
    const normalized = first as unknown[];
    return {
      target: (normalized[0] ?? {}) as Target,
      replace: (t) => {
        normalized[0] = t;
        return args;
      },
    };
  }
  if (typeof first === "object" && first !== null) {
    return { target: first as Target, replace: (t) => [t, ...args.slice(1)] };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    const rest = typeof args[1] === "string" ? args.slice(2) : args.slice(1);
    return { target: { host, port: first }, replace: (t) => [t, ...rest] };
  }
  return { target: { path: String(first) }, replace: () => args };
}

const original = net.Socket.prototype.connect as unknown as Connect;
const jailed: Connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  const { target, replace } = targetOf(args);
  if (target.path !== undefined) return original.apply(this, args);
  const host = target.host ?? "localhost";
  const port = Number(target.port ?? 0);
  if (local(host)) return original.apply(this, args);
  const to = REDIRECTS.get(`${host.toLowerCase()}:${port}`);
  if (to !== undefined) {
    record({ host, port, action: "redirected", to: `${to.host}:${to.port}` });
    return original.apply(this, replace({ ...target, host: to.host, port: to.port }));
  }
  record({ host, port, action: "blocked" });
  const err = Object.assign(
    new Error(`connect ECONNREFUSED ${host}:${port} (blocked by the e2e network jail)`),
    { code: "ECONNREFUSED" },
  );
  process.nextTick(() => this.destroy(err));
  return this;
};
net.Socket.prototype.connect = jailed as unknown as typeof net.Socket.prototype.connect;
