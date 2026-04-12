import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { getSocketHandshakeApiKey } from "./socketHandshakeAuth.js";

describe("getSocketHandshakeApiKey", () => {
  it("returns undefined when no token or header", () => {
    expect(getSocketHandshakeApiKey({ headers: {} })).toBeUndefined();
    expect(
      getSocketHandshakeApiKey({ auth: {}, headers: {} }),
    ).toBeUndefined();
  });

  it("reads string auth.token", () => {
    expect(
      getSocketHandshakeApiKey({
        auth: { token: "socket-secret" },
        headers: {},
      }),
    ).toBe("socket-secret");
  });

  it("ignores empty auth.token string", () => {
    expect(
      getSocketHandshakeApiKey({
        auth: { token: "" },
        headers: { "x-server-api-key": "from-header" },
      }),
    ).toBe("from-header");
  });

  it("reads x-server-api-key string header", () => {
    const headers: IncomingHttpHeaders = {
      "x-server-api-key": "header-key",
    };
    expect(getSocketHandshakeApiKey({ headers })).toBe("header-key");
  });

  it("reads first element when header is string array", () => {
    const headers: IncomingHttpHeaders = {
      "x-server-api-key": ["first", "second"],
    };
    expect(getSocketHandshakeApiKey({ headers })).toBe("first");
  });

  it("prefers auth.token over header", () => {
    expect(
      getSocketHandshakeApiKey({
        auth: { token: "from-auth" },
        headers: { "x-server-api-key": "from-header" },
      }),
    ).toBe("from-auth");
  });
});
