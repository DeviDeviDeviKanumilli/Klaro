import "./loadEnv.js";
import { createServer } from "http";
import net from "node:net";
import { Server } from "socket.io";
import { createHandler } from "./socket/handler.js";
import { createSupervisor } from "./agents/supervisor.js";
import {
  initStagehand,
  createExecutionContext,
  closeStagehand,
} from "./lib/stagehand.js";
import {
  initElasticsearch,
  createKnowledgeBase,
} from "./lib/elasticsearch.js";
import {
  tryCreateSqliteKnowledgeBaseFromEnv,
  closeSqliteKnowledgeBase,
} from "./lib/sqliteKnowledgeBase.js";
import { parseAllowedOriginsList } from "./lib/allowedOrigins.js";
import { getSocketHandshakeApiKey } from "./lib/socketHandshakeAuth.js";
import { createApp } from "./createApp.js";
import {
  getAnthropicComputerUseConfig,
} from "./lib/anthropicComputerUse.js";
import { logAnthropicStartupHints } from "./lib/anthropicEnvDiagnostics.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TEST_MODE = process.env.TEST === "true";

const SERVER_API_KEY = process.env.SERVER_API_KEY?.trim() || "";

const allowedOrigins = parseAllowedOriginsList(process.env.ALLOWED_ORIGINS);

/** Fail fast if nothing can bind to PORT (avoids launching Chrome / compiling graph twice). */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", (err: NodeJS.ErrnoException) => {
      s.close();
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the other process or set PORT to a free port.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    s.listen(port, () => {
      s.close(() => resolve());
    });
  });
}

async function start() {
  if (TEST_MODE) {
    console.log("[Server] ========================================");
    console.log("[Server]  TEST MODE ENABLED");
    console.log(
      "[Server]  Skipping Stagehand, Elasticsearch, and SQLite knowledge base init",
    );
    console.log("[Server]  Responses served from test/responses.ts");
    console.log("[Server] ========================================");
  }

  try {
    await assertPortFree(PORT);
  } catch (err) {
    console.error(
      "[Server]",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  // ── Initialize Stagehand (graceful degradation) ──────────────
  let executionContext = null;
  if (!TEST_MODE) {
    try {
      await initStagehand();
      executionContext = createExecutionContext();
      if (executionContext) {
        console.log("[Server] Stagehand initialized — browser tools available");
      } else {
        console.log("[Server] Stagehand not available — text-only mode");
      }
    } catch (err) {
      console.warn(
        "[Server] Stagehand init failed — running without browser tools:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Knowledge base: SQLite (SQLITE_KB_PATH) or Elasticsearch ─
  let knowledgeBase = null;
  if (!TEST_MODE) {
    knowledgeBase = tryCreateSqliteKnowledgeBaseFromEnv();
    if (knowledgeBase) {
      console.log("[Server] SQLite knowledge base ENABLED");
    } else {
      try {
        const esConnected = await initElasticsearch();
        if (esConnected) {
          knowledgeBase = createKnowledgeBase();
          console.log(
            "[Server] Elasticsearch initialized — knowledge base ENABLED",
          );
        } else {
          console.log(
            "[Server] Elasticsearch not available — knowledge base DISABLED",
          );
        }
      } catch (err) {
        console.warn(
          "[Server] Elasticsearch init failed — running without knowledge base:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ── Express + Socket.io ──────────────────────────────────────
  const chatGraph = createSupervisor(executionContext, knowledgeBase);
  const app = createApp({
    knowledgeBase,
    chatGraph,
    allowedOrigins,
    serverApiKey: SERVER_API_KEY,
  });

  const httpServer = createServer(app);

  const ioCorsOrigin =
    allowedOrigins.length > 0 ? allowedOrigins : true;

  const io = new Server(httpServer, {
    cors: {
      origin: ioCorsOrigin,
      methods: ["GET", "POST"],
    },
  });

  if (SERVER_API_KEY) {
    io.use((socket, next) => {
      if (getSocketHandshakeApiKey(socket.handshake) === SERVER_API_KEY) {
        next();
        return;
      }
      next(new Error("Unauthorized"));
    });
  }

  const handleConnection = createHandler(executionContext, knowledgeBase);
  io.on("connection", handleConnection);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[Server] Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`,
      );
    } else {
      console.error("[Server] HTTP server error:", err);
    }
    process.exit(1);
  });

  httpServer.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(
      `[Server] OpenAI key: ${process.env.OPENAI_API_KEY ? "SET" : "NOT SET"}`,
    );
    console.log(`[Server] Anthropic key: ${process.env.ANTHROPIC_API_KEY ? "SET" : "NOT SET (desktop agent disabled)"}`);
    logAnthropicStartupHints();
    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      const { model, betas, toolType } = getAnthropicComputerUseConfig();
      console.log(
        `[Server] Anthropic computer-use: model=${model} beta=${betas[0]} tool=${toolType}`,
      );
    }
    console.log(`[Server] Cartesia key: ${process.env.CARTESIA_API_KEY ? "yes" : "NOT SET"}`);
    console.log(`[Server] Deepgram key: ${process.env.DEEPGRAM_API_KEY ? "yes" : "NOT SET"}`);
    console.log(`[Server] Perplexity key: ${process.env.PERPLEXITY_API_KEY ? "yes" : "NOT SET (web_search disabled)"}`);
    console.log(`[Server] Test mode: ${TEST_MODE ? "ENABLED" : "DISABLED"}`);
    console.log(`[Server] Browser tools: ${executionContext ? "ENABLED" : "DISABLED"}`);
    console.log(`[Server] Knowledge base: ${knowledgeBase?.isAvailable() ? "ENABLED" : "DISABLED"}`);
    console.log(
      `[Server] CORS: ${allowedOrigins.length ? allowedOrigins.join(", ") : "open (set ALLOWED_ORIGINS to restrict)"}`,
    );
    console.log(
      `[Server] SERVER_API_KEY: ${SERVER_API_KEY ? "required for /api/chat + socket" : "not set (open)"}`,
    );
  });

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      console.log(`\n[Server] ${signal} received — shutting down`);
      closeSqliteKnowledgeBase();
      await closeStagehand();
      httpServer.close();
      process.exit(0);
    });
  }
}

start().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
