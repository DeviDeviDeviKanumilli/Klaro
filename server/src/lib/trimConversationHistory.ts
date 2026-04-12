import type { ConversationTurn } from "../types/index.js";
import { MAX_CONVERSATION_TURNS } from "./limits.js";

/** Drop oldest turns when over the configured cap (in-place). */
export function trimConversationHistory(history: ConversationTurn[]): void {
  while (history.length > MAX_CONVERSATION_TURNS) {
    history.shift();
  }
}
