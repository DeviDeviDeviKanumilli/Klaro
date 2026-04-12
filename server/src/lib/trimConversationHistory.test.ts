import { describe, expect, it } from "vitest";
import { MAX_CONVERSATION_TURNS } from "./limits.js";
import { trimConversationHistory } from "./trimConversationHistory.js";
import type { ConversationTurn } from "../types/index.js";

describe("trimConversationHistory", () => {
  it("does nothing when under cap", () => {
    const h: ConversationTurn[] = [
      { role: "user", text: "a", timestamp: 1 },
      { role: "assistant", text: "b", timestamp: 2 },
    ];
    trimConversationHistory(h);
    expect(h.length).toBe(2);
  });

  it("drops oldest entries when over MAX_CONVERSATION_TURNS", () => {
    const h: ConversationTurn[] = [];
    for (let i = 0; i < MAX_CONVERSATION_TURNS + 5; i++) {
      h.push({ role: "user", text: `m${i}`, timestamp: i });
    }
    trimConversationHistory(h);
    expect(h.length).toBe(MAX_CONVERSATION_TURNS);
    expect(h[0].text).toBe("m5");
  });
});
