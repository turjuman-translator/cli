// Smoke test for HTTPS on the LAN: scripts/lan-cert.sh makes a local CA and a
// certificate in a temp dir; listenHttps serves a Fastify app (with @fastify/websocket) on a second,
// TLS port. Checks: the chain verifies against the CA, routes answer with protocol https, a
// WebSocket upgrade works over TLS, and the plain HTTP port keeps working.
// Run: pnpm exec tsx scripts/smoke-https.ts   (needs openssl)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { listenHttps } from "../src/server/https.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  (${detail})` : ""}`);
}

function get(port: number, path: string, ca: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port, path, ca, servername: "localhost" },
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

/** A raw WebSocket handshake over TLS: the first response line. */
function upgrade(port: number, path: string, ca: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => {
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

const dir = mkdtempSync(join(tmpdir(), "turjuman-tls-"));
try {
  execFileSync("bash", ["scripts/lan-cert.sh", dir], { stdio: "pipe" });
  const ca = readFileSync(join(dir, "ca.crt"));
  const key = readFileSync(join(dir, "server.key"));
  const cert = readFileSync(join(dir, "server.crt"));
  const text = execFileSync("openssl", [
    "x509",
    "-in",
    join(dir, "server.crt"),
    "-noout",
    "-text",
  ]).toString("utf8");
  check(
    "lan-cert.sh: a server certificate for localhost + 127.0.0.1, signed by the local CA",
    /DNS:localhost/.test(text) &&
      /IP Address:127\.0\.0\.1/.test(text) &&
      /TLS Web Server/.test(text),
  );
  const keyMode = (statSync(join(dir, "server.key")).mode & 0o777).toString(8);
  const caKeyMode = (statSync(join(dir, "ca.key")).mode & 0o777).toString(8);
  check("private keys are mode 600", keyMode === "600" && caKeyMode === "600", keyMode);

  const app = Fastify();
  await app.register(websocket);
  app.get("/health", async (req) => ({ ok: true, protocol: req.protocol }));
  app.register(async (scope) => {
    scope.get("/ws/echo", { websocket: true }, (socket) => {
      socket.send("hello");
    });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const httpPort = (app.server.address() as { port: number }).port;
  const tls = await listenHttps(app, { host: "127.0.0.1", port: 0, key, cert });

  const r = await get(tls.port, "/health", ca);
  check(
    "HTTPS: the chain verifies against the CA; the route sees protocol https",
    r.status === 200 && JSON.parse(r.body).protocol === "https",
    r.body,
  );
  const line = await upgrade(tls.port, "/ws/echo", ca);
  check("HTTPS: a WebSocket upgrade over TLS → 101", line.startsWith("HTTP/1.1 101"), line);
  const plain = await fetch(`http://127.0.0.1:${httpPort}/health`).then((x) => x.json());
  check(
    "the plain HTTP port keeps working (protocol http)",
    (plain as { protocol?: string }).protocol === "http",
  );
  await tls.close();
  await app.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
