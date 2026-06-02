/**
 * Loopback HTTP test-server factory for @geo/fetch integration tests.
 *
 * Usage:
 *   const srv = await createTestServer((req, res) => { res.end("ok"); });
 *   // srv.url  → "http://127.0.0.1:<port>"
 *   // srv.port → ephemeral port number
 *   await srv.close();
 */

import * as http from "node:http";

export interface TestServer {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Creates a loopback HTTP server bound to 127.0.0.1 on an ephemeral port.
 * Resolves once the server is listening and ready to accept connections.
 */
export function createTestServer(
  handler: http.RequestListener,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);

    server.once("error", reject);

    // Bind to 127.0.0.1:0 — OS picks an available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address type"));
        return;
      }

      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;

      const close = (): Promise<void> =>
        new Promise((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        });

      resolve({ server, url, port, close });
    });
  });
}
