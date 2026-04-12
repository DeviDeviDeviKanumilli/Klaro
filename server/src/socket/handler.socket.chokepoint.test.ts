import { createServer, type Server as HttpServer } from "http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";
import { createHandler } from "./handler.js";
import { MAX_USER_MESSAGE_CHARS } from "../lib/limits.js";

describe("Socket handler chokepoints", () => {
  let httpServer: HttpServer;
  let io: Server;
  let port: number;

  beforeEach(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer = createServer();
        io = new Server(httpServer, { cors: { origin: true } });
        io.on("connection", createHandler(null, null));
        httpServer.listen(0, () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
            resolve();
          } else {
            reject(new Error("no port"));
          }
        });
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        // io.close() already closes the attached http.Server — do not call httpServer.close() again.
        void io.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  it("emits error when user_message text exceeds max length", async () => {
    const client: ClientSocket = ioc(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", reject);
    });

    const tooLong = "x".repeat(MAX_USER_MESSAGE_CHARS + 1);
    const errPayload = await new Promise<{ message?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for server error payload")), 5000);
      const onAny = (event: string, ...args: unknown[]) => {
        if (event !== "error") return;
        const payload = args[0];
        if (
          payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof (payload as { message: string }).message === "string" &&
          /too long/i.test((payload as { message: string }).message)
        ) {
          clearTimeout(t);
          client.offAny(onAny);
          resolve(payload as { message: string });
        }
      };
      client.onAny(onAny);
      client.emit("user_message", { text: tooLong });
    });
    expect(errPayload.message).toMatch(/too long/i);

    client.close();
  });
});
