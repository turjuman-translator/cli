// HTTPS next to plain HTTP: a throwaway self-signed certificate (openssl), the app's
// routes and WebSocket upgrades over TLS, a port that is taken, and closing. Skipped where openssl
// is not installed (scripts/lan-cert.sh needs it too).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpsListener, listenHttps } from "../../src/server/https.js";

let dir = "";
let key: Buffer;
let cert: Buffer;

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port, path, ca: cert, servername: "localhost" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A raw WebSocket handshake over TLS: the first line of the answer. */
function upgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" }, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    sock.once("data", (d: Buffer) => {
      resolve(d.toString("utf8").split("\r\n")[0] ?? "");
      sock.destroy();
    });
    sock.on("error", reject);
  });
}

const hasOpenssl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasOpenssl)("listenHttps", () => {
  let app: FastifyInstance;
  let tls: HttpsListener | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "server-https-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "server.key"),
        "-out",
        join(dir, "server.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    key = readFileSync(join(dir, "server.key"));
    cert = readFileSync(join(dir, "server.crt"));
    app = Fastify();
    await app.register(websocket);
    app.get("/health", async (req) => ({ ok: true, protocol: req.protocol }));
    app.get("/ws/echo", { websocket: true }, (socket) => {
      socket.send("hello");
    });
    await app.ready();
  });

  afterAll(async () => {
    await tls?.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the app's routes over TLS, where the request's protocol is https", async () => {
    tls = await listenHttps(app, { host: "127.0.0.1", port: 0, key, cert });
    expect(tls.port).toBeGreaterThan(0);
    const res = await get(tls.port, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, protocol: "https" });
  });

  it("hands WebSocket upgrades to the app", async () => {
    if (tls === null) throw new Error("not listening");
    expect(await upgrade(tls.port, "/ws/echo")).toBe("HTTP/1.1 101 Switching Protocols");
  });

  it("rejects when the port is taken", async () => {
    if (tls === null) throw new Error("not listening");
    await expect(
      listenHttps(app, { host: "127.0.0.1", port: tls.port, key, cert }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("closes at once, with a WebSocket open and a client still in its TLS handshake", async () => {
    if (tls === null) throw new Error("not listening");
    const port = tls.port;
    // A WebSocket over TLS that stays open.
    const ws = connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" });
    await new Promise<void>((resolve) => ws.once("secureConnect", () => resolve()));
    ws.write(
      `GET /ws/echo HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise<void>((resolve) => ws.once("data", () => resolve()));
    // A client that connected but never starts its TLS handshake.
    const silent = netConnect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => silent.once("connect", () => resolve()));
    // The server cuts them off: a reset is what these clients see.
    for (const socket of [ws, silent]) socket.on("error", () => {});
    const closed = (socket: Socket): Promise<void> =>
      new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const both = Promise.all([closed(ws), closed(silent)]);
    const result = await Promise.race([
      tls.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
    ]);
    tls = null;
    expect(result).toBe("closed");
    await both;
    await expect(get(port, "/health")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
