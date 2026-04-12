import { describe, expect, it } from "vitest";
import { parseAllowedOriginsList } from "./allowedOrigins.js";

describe("parseAllowedOriginsList", () => {
  it("returns empty for undefined, empty, and whitespace-only", () => {
    expect(parseAllowedOriginsList(undefined)).toEqual([]);
    expect(parseAllowedOriginsList("")).toEqual([]);
    expect(parseAllowedOriginsList("   ")).toEqual([]);
  });

  it("parses a single origin", () => {
    expect(parseAllowedOriginsList("https://app.example")).toEqual([
      "https://app.example",
    ]);
  });

  it("trims entries and drops empty segments", () => {
    expect(
      parseAllowedOriginsList(" https://a.test , ,https://b.test  "),
    ).toEqual(["https://a.test", "https://b.test"]);
  });

  it("preserves duplicate origins as listed", () => {
    expect(parseAllowedOriginsList("https://x,https://x")).toEqual([
      "https://x",
      "https://x",
    ]);
  });
});
