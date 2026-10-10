// This server's addresses for the CLI: where the browser on this machine opens
// the app (`turjuman open`), which origin screen links get (`turjuman screens`), and the address
// lines `turjuman start` prints.
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isLoopbackHost, type LoadedConfig } from "../config.js";

/** The app's pages. */
export const APP_PAGES = { app: "/app", builder: "/app/new", look: "/app/look" } as const;
export type AppPage = keyof typeof APP_PAGES;

type Interfaces = ReturnType<typeof networkInterfaces>;

/** This machine's first private IPv4 address (10/8, 172.16/12, 192.168/16), or null. */
export function lanAddress(interfaces: Interfaces = networkInterfaces()): string | null {
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (
        a.family === "IPv4" &&
        !a.internal &&
        /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)
      ) {
        return a.address;
      }
    }
  }
  return null;
}

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** A host for a URL: IPv6 literals in brackets. */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export interface Addresses {
  /** This machine: http://<server.host>:<server.port>, 127.0.0.1 for 0.0.0.0 / ::. */
  local: string;
  /** Other devices on the network (exposure "lan"), or null. */
  lan: string | null;
  /** HTTPS for other devices (exposure lan, server.https.port, the certificate in place), or null. */
  https: string | null;
  /** hosted.publicUrl without a trailing slash, or null. */
  public: string | null;
}

export interface AddressOptions {
  /** This machine's LAN address (default: looked up). */
  lan?: string | null;
  /** File check for the HTTPS certificate (tests). */
  exists?: (file: string) => boolean;
}

export function serverAddresses(loaded: LoadedConfig, opts: AddressOptions = {}): Addresses {
  const { server, hosted } = loaded.config;
  // In Docker, compose may publish the ports under other numbers on this computer.
  const port = loaded.context.publishedPort ?? server.port;
  const publishedHttps = loaded.context.publishedHttpsPort ?? server.https.port;
  const wildcard = isWildcard(server.host);
  const here = wildcard ? "127.0.0.1" : server.host;
  let lanHost: string | null = null;
  if (server.exposure === "lan") {
    // In the container the address found would be the container's own, not this computer's.
    const found = (): string | null => (loaded.context.inContainer ? null : lanAddress());
    if (wildcard) lanHost = opts.lan === undefined ? found() : opts.lan;
    else if (!isLoopbackHost(server.host)) lanHost = server.host;
  }
  const exists = opts.exists ?? existsSync;
  const httpsReady =
    server.https.port !== null &&
    exists(loaded.paths.tlsCertFile) &&
    exists(loaded.paths.tlsKeyFile);
  return {
    local: `http://${urlHost(here)}:${port}`,
    lan: lanHost === null ? null : `http://${urlHost(lanHost)}:${port}`,
    // With exposure local the HTTPS port answers on this computer only: no link for other devices.
    https: httpsReady && lanHost !== null ? `https://${urlHost(lanHost)}:${publishedHttps}` : null,
    public: hosted.publicUrl === null ? null : hosted.publicUrl.replace(/\/+$/, ""),
  };
}

/**
 * The origin of screen links: hosted.publicUrl when set; else the HTTPS address when there is one
 * (other devices need HTTPS for the microphone); else this computer's own address, where the
 * microphone works without HTTPS. A plain http:// LAN address is never used: a caption page
 * there cannot open the microphone, not even on this computer.
 */
export function feedOrigin(a: Addresses): string {
  return a.public ?? a.https ?? a.local;
}

/** Where a browser on this machine opens the app: hosted.publicUrl when set, else locally. */
export function browserOrigin(a: Addresses): string {
  return a.public ?? a.local;
}
