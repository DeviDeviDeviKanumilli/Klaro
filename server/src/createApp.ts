import express from "express";
import cors from "cors";
import type { KnowledgeBase } from "./types/index.js";
import { runSupervisor, createSupervisor } from "./agents/supervisor.js";
import { MAX_USER_MESSAGE_CHARS } from "./lib/limits.js";
import { getClientProvidedServerKey } from "./lib/clientApiKey.js";

export type CompiledSupervisorGraph = ReturnType<typeof createSupervisor>;

export type CreateAppConfig = {
  knowledgeBase: KnowledgeBase | null;
  chatGraph: CompiledSupervisorGraph;
  /** When empty, all origins allowed (same as index default). */
  allowedOrigins: string[];
  /** When non-empty, `/api/chat` requires matching `x-server-api-key` or Bearer token. */
  serverApiKey: string;
};

/**
 * Express app with `/health` and `/api/chat` (same behavior as server bootstrap).
 */
export function createApp(config: CreateAppConfig): express.Application {
  const { knowledgeBase: _kb, chatGraph, allowedOrigins, serverApiKey } = config;
  void _kb;

  function requireServerApiKey(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    if (!serverApiKey) {
      next();
      return;
    }
    if (
      getClientProvidedServerKey((name) => req.header(name)) === serverApiKey
    ) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  }

  const app = express();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (allowedOrigins.length === 0) {
          callback(null, true);
          return;
        }
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Not allowed by CORS"));
      },
    }),
  );
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/chat", requireServerApiKey, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== "string") {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (message.length > MAX_USER_MESSAGE_CHARS) {
        res.status(400).json({
          error: `message too long (max ${MAX_USER_MESSAGE_CHARS} characters)`,
        });
        return;
      }
      const result = await runSupervisor(chatGraph, {
        userInput: message,
        conversationHistory: [],
        userProfile: null,
        pageSnapshot: null,
      });
      res.json({
        response: result.responseText,
        agentCategory: result.agentCategory,
      });
    } catch (err) {
      console.error("[Server] /api/chat error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
