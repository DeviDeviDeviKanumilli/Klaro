import type { IncomingHttpHeaders } from "node:http";

/**
 * Read shared-secret API key from Socket.io handshake (matches client auth.token
 * or x-server-api-key header).
 */
export function getSocketHandshakeApiKey(handshake: {
  auth?: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}): string | undefined {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === "string" && fromAuth) return fromAuth;
  const h = handshake.headers["x-server-api-key"];
  if (typeof h === "string") return h;
  if (Array.isArray(h) && typeof h[0] === "string") return h[0];
  return undefined;
}
