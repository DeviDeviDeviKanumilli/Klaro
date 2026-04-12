import { describe, expect, it } from "vitest";
import { formatVoiceResponse } from "./formatVoiceResponse.js";

describe("formatVoiceResponse", () => {
  it("strips bold markdown", () => {
    expect(formatVoiceResponse("Hello **world**")).toBe("Hello world.");
  });

  it("removes URLs", () => {
    expect(formatVoiceResponse("See https://example.com/path done")).toBe(
      "See done.",
    );
  });

  it("removes bullet list markers", () => {
    expect(formatVoiceResponse("- a\n- b")).toBe("a. b.");
  });

  it("collapses whitespace", () => {
    expect(formatVoiceResponse("a\n\nb")).toBe("a. b.");
  });
});
