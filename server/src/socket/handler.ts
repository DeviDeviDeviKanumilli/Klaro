import type { Socket } from "socket.io";
import { OpenAITTS } from "../tts/openai.js";
import { VoicePipeline } from "../pipeline/voicePipeline.js";
import {
  OpenAISTT,
  type OpenAISTTSessionOptions,
} from "../stt/openai.js";
import { createSupervisor, runSupervisor } from "../agents/supervisor.js";
import { getNextSequence } from "../test/responses.js";
import type {
  ConversationTurn,
  UserProfile,
  ExecutionContext,
  InterimSpeechCallback,
  KnowledgeBase,
} from "../types/index.js";
import {
  MAX_USER_MESSAGE_CHARS,
  MAX_STT_SESSION_BYTES,
  MAX_RESTORE_SESSION_ID_LEN,
} from "../lib/limits.js";
import { trimConversationHistory } from "../lib/trimConversationHistory.js";
import { hasHanScript, previewText, voiceTrace } from "../lib/voiceTrace.js";

const TEST_MODE = process.env.TEST === "true";

/**
 * Create a socket connection handler with access to the execution context.
 * Call once after Stagehand is initialized (or with null for text-only mode).
 */
export function createHandler(
  executionContext: ExecutionContext | null,
  kb: KnowledgeBase | null = null,
) {
  // Compile the supervisor graph once — reused across all connections
  const supervisorGraph = createSupervisor(executionContext, kb);

  return function handleConnection(socket: Socket) {
    console.log(`[Socket] Client connected: ${socket.id}`);

    const tts = new OpenAITTS({
      apiKey: process.env.OPENAI_API_KEY || "",
      voice: "nova",
    });

    const pipeline = new VoicePipeline(null, tts, socket);
    const conversationHistory: ConversationTurn[] = [];

    // Load user profile from KB (async, fallback handled inside KB)
    let userProfile: UserProfile | null = null;
    if (kb) {
      kb.getProfile(socket.id).then((p) => {
        userProfile = p;
        if (p) console.log(`[Socket] Loaded profile for ${socket.id}: ${p.name}`);
      }).catch(() => {});
    }

    // Tracks the current supervisor run so we can cancel it on barge-in
    let supervisorAbort: AbortController | null = null;
    let testSequenceAbort: AbortController | null = null;

    // OpenAI STT — created lazily when client starts listening (key read in beginSttSession)
    let stt: OpenAISTT | null = null;

    // Connect TTS WebSocket eagerly
    pipeline.connect().catch((err) => {
      console.error("[Socket] Failed to connect TTS:", err.message);
    });

    socket.on("user_message", async (payload: { text: string }) => {
      const raw = payload?.text;
      if (typeof raw !== "string") return;
      const text = raw.trim();
      if (!text) return;
      if (text.length > MAX_USER_MESSAGE_CHARS) {
        socket.emit("error", {
          message: `Message too long (max ${MAX_USER_MESSAGE_CHARS} characters).`,
        });
        return;
      }
      console.log(`[Socket] ${socket.id} says: "${text}"`);
      voiceTrace("user_message", {
        preview: previewText(text, 200),
        len: text.length,
        hasHan: hasHanScript(text),
      });

      conversationHistory.push({
        role: "user",
        text,
        timestamp: Date.now(),
      });
      trimConversationHistory(conversationHistory);

      // ── Test mode: skip supervisor, play canned sequence ──
      if (TEST_MODE) {
        pipeline.abort();
        testSequenceAbort?.abort();
        
        const abort = new AbortController();
        testSequenceAbort = abort;
        
        const sequence = getNextSequence();
        console.log(`[Socket] [TEST] Playing sequence with ${sequence.steps.length} steps`);

        try {
          socket.emit("status", { state: "thinking" });

          const defaultDelay = sequence.delay ?? 600;

          for (const step of sequence.steps) {
            if (abort.signal.aborted) break;
            
            // Pre-delay before this step (e.g. simulate processing)
            if (step.preDelay) {
              await new Promise((r) => setTimeout(r, step.preDelay));
              if (abort.signal.aborted) break;
            }

            if (step.type === "console") {
              socket.emit("console_log", { message: step.text });
              await new Promise((r) => setTimeout(r, step.delay ?? defaultDelay));
            } else {
              console.log(`[Socket] [TEST] Speaking: "${step.text.slice(0, 80)}..."`);
              conversationHistory.push({
                role: "assistant",
                text: step.text,
                timestamp: Date.now(),
              });
              trimConversationHistory(conversationHistory);
              await pipeline.processSupervisorResponse(step.text);
              if (abort.signal.aborted) break;
              // Delay after assistant before next step (e.g. console log)
              await new Promise((r) => setTimeout(r, step.delay ?? defaultDelay));
            }
          }
        } catch (err: unknown) {
          if (abort.signal.aborted) return;
          console.error("[Socket] [TEST] TTS error:", err);
          socket.emit("error", {
            message: err instanceof Error ? err.message : "Test TTS error",
          });
          socket.emit("status", { state: "idle" });
        } finally {
          if (testSequenceAbort === abort) testSequenceAbort = null;
        }
        return;
      }

      // ── Normal mode: full supervisor pipeline ─────────────────────

      // Fire-and-forget: index user turn to ES
      if (kb) {
        kb.indexConversation({
          sessionId: socket.id,
          role: "user",
          text,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      // Cancel any in-flight supervisor run + TTS
      supervisorAbort?.abort();
      pipeline.abort();

      const abort = new AbortController();
      supervisorAbort = abort;

      try {
        socket.emit("status", { state: "thinking" });

        const interimSpeech: InterimSpeechCallback = (phrase) => {
          if (!abort.signal.aborted) pipeline.speakInterim(phrase);
        };

        const actionLog = (message: string) => {
          if (!abort.signal.aborted) {
            socket.emit("agent_action", { message });
          }
        };

        const result = await runSupervisor(supervisorGraph, {
          userInput: text,
          conversationHistory,
          userProfile,
          pageSnapshot: null,
        }, interimSpeech, abort.signal, socket.id, actionLog);

        // If aborted while running, silently drop the result
        if (abort.signal.aborted) {
          console.log(`[Socket] Supervisor result dropped (aborted): "${text.slice(0, 40)}"`);
          return;
        }

        console.log(
          `[Socket] Supervisor response (${result.agentCategory}): "${result.responseText.slice(0, 80)}..."`,
        );
        voiceTrace("supervisor_response", {
          category: result.agentCategory,
          preview: previewText(result.responseText, 240),
          len: result.responseText.length,
          hasHan: hasHanScript(result.responseText),
        });

        conversationHistory.push({
          role: "assistant",
          text: result.responseText,
          timestamp: Date.now(),
        });
        trimConversationHistory(conversationHistory);

        // Fire-and-forget: index assistant turn to ES
        if (kb) {
          kb.indexConversation({
            sessionId: socket.id,
            role: "assistant",
            text: result.responseText,
            agentCategory: result.agentCategory,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }

        await pipeline.processSupervisorResponse(result.responseText);
      } catch (err: unknown) {
        if (abort.signal.aborted) return; // Expected — barge-in cancelled this run
        console.error("[Socket] Supervisor error:", err);
        socket.emit("error", {
          message: err instanceof Error ? err.message : "Supervisor error",
        });
        socket.emit("status", { state: "idle" });
      } finally {
        if (supervisorAbort === abort) supervisorAbort = null;
      }
    });

    socket.on("stop_audio", () => {
      console.log(`[Socket] ${socket.id} requested stop`);
      testSequenceAbort?.abort();
      testSequenceAbort = null;
      supervisorAbort?.abort();
      supervisorAbort = null;
      pipeline.abort();
      socket.emit("status", { state: "idle" });
    });

    // ── STT (OpenAI Realtime) events ───────────────────────────

    let sttSessionBytes = 0;
    let audioChunkCount = 0;

    function parseSttStartPayload(raw: unknown): OpenAISTTSessionOptions | undefined {
      if (raw == null || typeof raw !== "object") return undefined;
      const o = raw as Record<string, unknown>;
      const out: OpenAISTTSessionOptions = {};
      if (o.encoding === "pcm_s16le" || o.encoding === "webm") {
        out.encoding = o.encoding;
      }
      if (typeof o.sampleRate === "number" && Number.isFinite(o.sampleRate)) {
        out.sampleRate = o.sampleRate;
      }
      if (typeof o.channels === "number" && Number.isFinite(o.channels)) {
        out.channels = o.channels;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    /**
     * Starts or restarts an OpenAI STT session. Returns null if STT is unavailable.
     * For `pcm_s16le`, pass options from `stt_start` (auto-start on first audio is WebM-only).
     */
    function beginSttSession(opts?: OpenAISTTSessionOptions): OpenAISTT | null {
      const apiKey = (process.env.OPENAI_API_KEY || "").trim();
      if (!apiKey) {
        console.error("[Socket] OPENAI_API_KEY not set — STT unavailable");
        socket.emit("error", { message: "Speech-to-text not configured" });
        return null;
      }
      console.log(`[Socket] ${socket.id} starting STT`);
      stt?.stop();
      stt = null;
      sttSessionBytes = 0;
      audioChunkCount = 0;
      const next = new OpenAISTT(apiKey);
      next.start(socket, opts);
      stt = next;
      return next;
    }

    socket.on("stt_start", (payload?: unknown) => {
      beginSttSession(parseSttStartPayload(payload));
    });

    socket.on("stt_audio", (data: Buffer) => {
      // Prefer explicit stt_start; auto-start if audio arrives first (native clients).
      const active = stt ?? beginSttSession();
      if (!active) return;

      const buf = Buffer.from(data);
      sttSessionBytes += buf.byteLength;
      if (sttSessionBytes > MAX_STT_SESSION_BYTES) {
        socket.emit("error", {
          message: "Audio session exceeded size limit; stop and start again.",
        });
        active.stop();
        stt = null;
        sttSessionBytes = 0;
        audioChunkCount = 0;
        return;
      }
      audioChunkCount++;
      if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
        console.log(`[Socket] ${socket.id} stt_audio #${audioChunkCount}, bytes: ${data.byteLength}`);
      }
      active.sendAudio(buf);
    });

    socket.on("stt_stop", () => {
      console.log(`[Socket] ${socket.id} stopping STT`);
      stt?.stop();
      stt = null;
      sttSessionBytes = 0;
      audioChunkCount = 0;
    });

    // ── Session Restore ────────────────────────────────────────

    socket.on("restore_session", async (payload: { previousSessionId: string }) => {
      const prevId = payload.previousSessionId?.trim();
      if (!prevId || !kb) return;
      if (prevId.length > MAX_RESTORE_SESSION_ID_LEN) {
        socket.emit("error", {
          message: `Session id too long (max ${MAX_RESTORE_SESSION_ID_LEN}).`,
        });
        return;
      }

      try {
        const entries = await kb.restoreConversation(prevId);
        if (entries.length > 0) {
          for (const entry of entries) {
            conversationHistory.push({
              role: entry.role,
              text: entry.text,
              timestamp: new Date(entry.timestamp).getTime(),
            });
          }
          console.log(`[Socket] Restored ${entries.length} conversation entries from session ${prevId}`);
          socket.emit("session_restored", { count: entries.length });
        }
      } catch (err) {
        console.warn("[Socket] Session restore failed:", err instanceof Error ? err.message : err);
      }
    });

    // ── Disconnect ─────────────────────────────────────────────

    socket.on("disconnect", () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
      stt?.stop();
      stt = null;
      sttSessionBytes = 0;
      pipeline.disconnect();
    });
  };
}
