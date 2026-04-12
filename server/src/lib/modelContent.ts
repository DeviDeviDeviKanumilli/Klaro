import type { ClassificationResult } from "../types/index.js";

const VALID_CATEGORIES = [
  "commerce",
  "coding",
  "general",
  "desktop",
  "documentation",
] as const;

/** Normalize LangChain / OpenAI message content to plain text. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text as string)
      .join("");
  }
  return String(content);
}

/**
 * Parse classifier model output: strip markdown fences, JSON.parse, coerce invalid categories.
 */
export function parseClassificationJson(raw: string): ClassificationResult {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  let classification: ClassificationResult;
  try {
    classification = JSON.parse(text) as ClassificationResult;
    if (!VALID_CATEGORIES.includes(classification.category as (typeof VALID_CATEGORIES)[number])) {
      classification.category = "general";
    }
  } catch {
    return {
      category: "general",
      subIntent: "unknown",
      entities: {},
    };
  }

  if (
    classification.secondaryCategory &&
    !VALID_CATEGORIES.includes(
      classification.secondaryCategory as (typeof VALID_CATEGORIES)[number],
    )
  ) {
    classification.secondaryCategory = null;
  }

  return classification;
}
