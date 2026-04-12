import { describe, expect, it } from "vitest";
import { normalizeAnthropicApiKey } from "./anthropicComputerUse.js";

describe("normalizeAnthropicApiKey", () => {
  it("returns null for undefined and empty string", () => {
    expect(normalizeAnthropicApiKey(undefined)).toBeNull();
    expect(normalizeAnthropicApiKey("")).toBeNull();
    expect(normalizeAnthropicApiKey("   ")).toBeNull();
  });

  it("treats whitespace-only as missing (avoids empty X-Api-Key)", () => {
    expect(normalizeAnthropicApiKey("\n\t ")).toBeNull();
  });

  it("strips BOM and trims", () => {
    const k = "\uFEFFsk-ant-api03-test";
    expect(normalizeAnthropicApiKey(k)).toBe("sk-ant-api03-test");
  });

  it("preserves a valid key", () => {
    expect(normalizeAnthropicApiKey("sk-ant-api03-abc")).toBe("sk-ant-api03-abc");
  });
});
