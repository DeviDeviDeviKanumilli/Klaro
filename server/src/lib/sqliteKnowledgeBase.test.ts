import { describe, expect, it } from "vitest";
import { ftsMatchQuery } from "./sqliteKnowledgeBase.js";

describe("ftsMatchQuery", () => {
  it("returns null for empty or punctuation-only input", () => {
    expect(ftsMatchQuery("")).toBeNull();
    expect(ftsMatchQuery("   ")).toBeNull();
    expect(ftsMatchQuery("!!!")).toBeNull();
  });

  it("quotes tokens and joins with OR", () => {
    expect(ftsMatchQuery("hello world")).toBe('"hello" OR "world"');
  });

  it("strips non-alphanumeric and lowercases", () => {
    expect(ftsMatchQuery("Foo-Bar! Baz")).toBe('"foo" OR "bar" OR "baz"');
  });

  it("drops punctuation so inner quotes do not become tokens", () => {
    expect(ftsMatchQuery('say "hi"')).toBe('"say" OR "hi"');
  });
});
