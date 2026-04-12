import { ChatOpenAI } from "@langchain/openai";
import { ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createBrowserTools, createKnowledgeTools, createSearchTools } from "./tools.js";
import type {
  ConversationTurn,
  UserProfile,
  PageSnapshot,
  ExecutionContext,
  InterimSpeechCallback,
  ActionLogCallback,
  KnowledgeBase,
} from "../types/index.js";

const MAX_TOOL_STEPS = 10;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text as string)
      .join("");
  }
  return String(content);
}

function buildSystemPrompt(
  profile: UserProfile | null,
  page: PageSnapshot | null,
  memoryContext?: string,
): string {
  let prompt = `You are a shopping assistant for a blind user who interacts entirely by voice.
You control a real browser. Use your tools to navigate, search, and buy products.

LANGUAGE: Always respond in clear English unless the user explicitly uses another language.

CRITICAL — NO HALLUCINATION:
- ONLY describe products, prices, and information that came from your LAST successful tool call.
- If a tool returned an error or empty data, say "I couldn't read the page, let me try again" — NEVER invent product names, prices, or details.
- If you are unsure whether data is real, say so. Do NOT guess.

SEARCH WORKFLOW (follow this exact sequence):
1. navigate_to_url → go to the site (e.g. https://www.amazon.com)
2. type_and_submit → type the search query in the search box (this auto-presses Enter)
3. observe_page → see what products appeared in the results
4. click_element → click a specific product to view it
5. click_element → "Click the Add to Cart button" to add it

TOOL USAGE:
- Use type_and_submit for ALL search bars and form inputs — it types AND presses Enter in one step.
- Use click_element for clicking buttons, links, and products. Be specific: "Click the Add to Cart button", "Click the first product in the search results".
- Use observe_page to see what's on the page before clicking.
- Use extract_data ONLY for small extractions on a single product page (e.g. "get the price and name"). NEVER on search results pages.
- NEVER use extract_data on Amazon search results — the page is too large and will fail.

ACTION COMPLETION:
- When the user says "add to cart", you MUST click the actual Add to Cart button. Do NOT just describe the product.
- When the user says "click on it", click the product. Do NOT describe it instead.
- When the user says "search for X", type it and submit. Do NOT just navigate without searching.
- Follow through on EVERY action. If the user asks you to do something, DO it — don't stop at describing.

VOICE RULES:
- Keep responses under 3 sentences unless asked for details.
- Speak naturally — no markdown, no URLs, no bullet points.
- Numbers as words when spoken: "forty-nine ninety-nine" not "$49.99".
- If a tool fails, try a different approach. Don't give up.`;

  if (profile) {
    prompt += `\n\nUser: ${profile.name}. Budget: $${profile.preferences.budget} ${profile.preferences.currency}. Preferred stores: ${profile.preferences.preferredStores}.`;
  }
  if (page) {
    prompt += `\nCurrently viewing: ${page.title} (${page.url})`;
  }
  if (memoryContext) {
    prompt += `\n\nRELEVANT MEMORY FROM PREVIOUS INTERACTIONS:\n${memoryContext}`;
  }

  return prompt;
}

function getCommerceInterimPhrase(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "navigate_to_url": {
      const url = String(args.url ?? "");
      if (url.includes("amazon")) return "Opening Amazon.";
      if (url.includes("bestbuy")) return "Opening Best Buy.";
      return "Opening the page.";
    }
    case "click_element": {
      const instr = String(args.instruction ?? "").toLowerCase();
      if (instr.includes("cart")) return "Adding to cart.";
      if (instr.includes("search") || instr.includes("type")) return "Searching now.";
      if (instr.includes("filter")) return "Applying the filter.";
      return "Working on that.";
    }
    case "extract_data":
      return "Looking through the results.";
    case "observe_page":
      return "Scanning the page.";
    case "web_search":
      return "Searching the web.";
    default:
      return "Working on that.";
  }
}

/**
 * Creates a commerce agent node function that uses browser tools via ReAct loop.
 * If no executionContext, falls back to text-only generation.
 */
export function createCommerceAgent(
  executionContext: ExecutionContext | null,
  kb: KnowledgeBase | null = null,
) {
  const agentModel = new ChatOpenAI({
    model: "gpt-4.1-mini",
    temperature: 0.3,
    maxTokens: 1024,
  });

  return async function commerceAgent(state: {
    userInput: string;
    conversationHistory: ConversationTurn[];
    userProfile: UserProfile | null;
    pageSnapshot: PageSnapshot | null;
    memoryContext?: string;
  }, interimSpeech?: InterimSpeechCallback, abortSignal?: AbortSignal, sessionId?: string, memoryContext?: string, actionLog?: ActionLogCallback): Promise<{ responseText: string }> {
    const systemPrompt = buildSystemPrompt(state.userProfile, state.pageSnapshot, memoryContext || state.memoryContext);

    const history: BaseMessage[] = state.conversationHistory
      .slice(-6)
      .map((t: ConversationTurn) => ({
        role: t.role as "user" | "assistant",
        content: t.text,
      })) as unknown as BaseMessage[];

    // No browser available — fallback to text-only
    if (!executionContext) {
      const response = await agentModel.invoke([
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: state.userInput },
      ]);
      return { responseText: extractText(response.content) };
    }

    // Full ReAct loop with browser tools + knowledge tools + web search
    const browserTools = createBrowserTools(executionContext);
    const knowledgeTools = createKnowledgeTools(kb, sessionId);
    const searchTools = createSearchTools();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: DynamicStructuredTool<any>[] = [...searchTools, ...browserTools, ...knowledgeTools];
    const modelWithTools = agentModel.bindTools(tools);

    const messages: BaseMessage[] = [
      { role: "system", content: systemPrompt } as unknown as BaseMessage,
      ...history,
      { role: "user", content: state.userInput } as unknown as BaseMessage,
    ];

    for (let i = 0; i < MAX_TOOL_STEPS; i++) {
      if (abortSignal?.aborted) {
        console.log("[commerce] aborted before iteration", i);
        return { responseText: "" };
      }

      const response = await modelWithTools.invoke(messages);
      messages.push(response);

      // No tool calls — agent is done reasoning
      if (!response.tool_calls?.length) {
        return { responseText: extractText(response.content) };
      }

      // Execute each tool call
      for (const toolCall of response.tool_calls) {
        if (abortSignal?.aborted) {
          console.log("[commerce] aborted before tool call:", toolCall.name);
          return { responseText: "" };
        }

        const toolFn = tools.find((t) => t.name === toolCall.name);
        if (!toolFn) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
              tool_call_id: toolCall.id ?? "",
            }),
          );
          continue;
        }

        // Emit interim speech before tool execution (fire-and-forget)
        if (interimSpeech) {
          const phrase = getCommerceInterimPhrase(toolCall.name, toolCall.args as Record<string, unknown>);
          interimSpeech(phrase);
        }

        if (actionLog) {
          const argsPreview = JSON.stringify(toolCall.args).slice(0, 120);
          actionLog(`Commerce agent calls ${toolCall.name} tool {${argsPreview}}`);
        }

        try {
          const result = await toolFn.invoke(toolCall.args);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          messages.push(
            new ToolMessage({
              content: resultStr,
              tool_call_id: toolCall.id ?? "",
            }),
          );

          // Auto-index to knowledge base (fire-and-forget)
          if (kb && sessionId) {
            const ts = new Date().toISOString();
            if (toolCall.name === "navigate_to_url") {
              try {
                const parsed = JSON.parse(resultStr);
                if (parsed.success) {
                  kb.indexPageVisit({
                    url: parsed.finalUrl || (toolCall.args as Record<string, unknown>).url as string,
                    title: parsed.pageTitle || "",
                    content: parsed.pageTitle || "",
                    sessionId,
                    userQuery: state.userInput,
                    agentCategory: "commerce",
                    timestamp: ts,
                  }).catch(() => {});
                }
              } catch { /* parse failed */ }
            } else if (toolCall.name === "extract_data") {
              try {
                const parsed = JSON.parse(resultStr);
                if (parsed.success && parsed.data) {
                  kb.indexPageVisit({
                    url: "",
                    title: "",
                    content: JSON.stringify(parsed.data).slice(0, 5000),
                    sessionId,
                    userQuery: state.userInput,
                    agentCategory: "commerce",
                    timestamp: ts,
                  }).catch(() => {});
                  // Try to extract individual products
                  const data = parsed.data;
                  const items = Array.isArray(data) ? data : (data.products || data.items || data.results || []);
                  if (Array.isArray(items)) {
                    for (const item of items.slice(0, 10)) {
                      if (item.name || item.title) {
                        kb.indexProductViewed({
                          url: item.url || "",
                          title: item.title || item.name || "",
                          name: item.name || item.title || "",
                          price: String(item.price ?? ""),
                          rating: String(item.rating ?? ""),
                          store: item.store || "",
                          sessionId,
                          timestamp: ts,
                        }).catch(() => {});
                      }
                    }
                  }
                }
              } catch { /* parse failed */ }
            }
          }
        } catch (err) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
              tool_call_id: toolCall.id ?? "",
            }),
          );
        }

        console.log(
          `[commerce] tool: ${toolCall.name}(${JSON.stringify(toolCall.args).slice(0, 80)})`,
        );
      }
    }

    return {
      responseText:
        "I had trouble completing that shopping task. Could you try again or be more specific?",
    };
  };
}
