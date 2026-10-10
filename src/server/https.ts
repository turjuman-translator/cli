// HTTPS on the LAN: the same Fastify app on a second, TLS port, next to plain HTTP, because
// browsers allow the microphone only on https:// pages (or on the server itself). Requests go to
// the app's router; WebSocket upgrades are handed to the app's server, where @fastify/websocket
// handles them as usual. `request.protocol` is "https" on this port (encrypted socket).
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { FastifyInstance } from "fastify";

export interface HttpsListener {
  /** The port it listens on (useful with port 0). */
  readonly port: number;
  close(): Promise<void>;
}

export async function listenHttps(
  app: FastifyInstance,
  opts: { host: string; port: number; key: Buffer; cert: Buffer },
): Promise<HttpsListener> {
  const server = createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    app.routing(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    app.server.emit("upgrade", req, socket, head);
  });
  // Every connection, so that close() can end them all: closeAllConnections() knows neither
  // WebSocket connections nor connections still in their TLS handshake, and either would keep
  // close() waiting.
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
