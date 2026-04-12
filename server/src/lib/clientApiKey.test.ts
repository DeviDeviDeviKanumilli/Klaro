import { describe, expect, it } from "vitest";
import { getClientProvidedServerKey } from "./clientApiKey.js";

function headerMap(
  entries: Record<string, string | undefined>,
): (name: string) => string | undefined {
  const lower = Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return (name: string) => lower[name.toLowerCase()];
}

describe("getClientProvidedServerKey", () => {
  it("returns undefined when no key headers", () => {
    expect(getClientProvidedServerKey(headerMap({}))).toBeUndefined();
  });

  it("prefers x-server-api-key over Authorization", () => {
    expect(
      getClientProvidedServerKey(
        headerMap({
          "x-server-api-key": "from-header",
          authorization: "Bearer from-bearer",
        }),
      ),
    ).toBe("from-header");
  });

  it("reads Bearer token from authorization", () => {
    expect(
      getClientProvidedServerKey(
        headerMap({ authorization: "Bearer  secret-token  " }),
      ),
    ).toBe("secret-token");
  });

  it("ignores non-Bearer authorization", () => {
    expect(
      getClientProvidedServerKey(
        headerMap({ authorization: "Basic abc" }),
      ),
    ).toBeUndefined();
  });
});
