import type { AgentCategory } from "../types/index.js";

export type SupervisorAgentNode =
  | "commerceAgent"
  | "codingAgent"
  | "generalAgent"
  | "desktopAgent"
  | "documentationAgent";

/** Route primary category to LangGraph agent node (matches supervisor routeByCategory). */
export function routeAgentNodeFromCategory(
  agentCategory: AgentCategory | string,
): SupervisorAgentNode {
  switch (agentCategory) {
    case "commerce":
      return "commerceAgent";
    case "coding":
      return "codingAgent";
    case "desktop":
      return "desktopAgent";
    case "documentation":
      return "documentationAgent";
    default:
      return "generalAgent";
  }
}
