import { describe, expect, it } from "vitest";
import { extractText, parseClassificationJson } from "./modelContent.js";

describe("extractText", () => {
  it("returns plain string", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("joins text parts from content array", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("filters non-text blocks", () => {
    expect(
      extractText([{ type: "text", text: "x" }, { type: "image", text: "no" }]),
    ).toBe("x");
  });
});

describe("parseClassificationJson", () => {
  it("parses valid JSON", () => {
    const r = parseClassificationJson(
      '{"category":"commerce","subIntent":"buy","entities":{}}',
    );
    expect(r.category).toBe("commerce");
    expect(r.subIntent).toBe("buy");
  });

  it("strips markdown code fence", () => {
    const r = parseClassificationJson(
      "```json\n{\"category\":\"coding\",\"subIntent\":\"x\",\"entities\":{}}\n```",
    );
    expect(r.category).toBe("coding");
  });

  it("coerces invalid category to general", () => {
    const r = parseClassificationJson(
      '{"category":"invalid","subIntent":"t","entities":{}}',
    );
    expect(r.category).toBe("general");
  });

  it("clears invalid secondaryCategory", () => {
    const r = parseClassificationJson(
      '{"category":"general","secondaryCategory":"nope","subIntent":"t","entities":{}}',
    );
    expect(r.secondaryCategory).toBeNull();
  });

  it("returns fallback on invalid JSON", () => {
    const r = parseClassificationJson("not json {{{");
    expect(r.category).toBe("general");
    expect(r.subIntent).toBe("unknown");
    expect(r.entities).toEqual({});
  });
});
