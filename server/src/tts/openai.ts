import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import type { TTSProvider, ChunkCallback, DoneCallback } from "./types.js";

export interface OpenAITTSConfig {
  apiKey: string;
  /** OpenAI TTS voice id (e.g. nova, alloy). */
  voice?: string;
}

/**
 * OpenAI Audio Speech API → PCM s16le @ 24kHz (matches client useAudioPlayer).
 */
export class OpenAITTS implements TTSProvider {
  private readonly client: OpenAI;
  private voice: string;
  private onChunk: ChunkCallback | null = null;
  private onDone: DoneCallback | null = null;
  private readonly activeContexts = new Set<string>();
  private readonly abortByContext = new Map<string, AbortController>();

  constructor(config: OpenAITTSConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.voice = config.voice ?? "nova";
  }

  async connect(): Promise<void> {
    // No persistent connection (HTTP per chunk).
  }

  setCallbacks(onChunk: ChunkCallback, onDone: DoneCallback): void {
    this.onChunk = onChunk;
    this.onDone = onDone;
  }

  createContext(): string {
    const id = uuidv4();
    this.activeContexts.add(id);
    this.abortByContext.set(id, new AbortController());
    return id;
  }

  private finishContext(contextId: string): void {
    if (!this.activeContexts.has(contextId)) return;
    this.activeContexts.delete(contextId);
    this.abortByContext.delete(contextId);
    this.onDone?.(contextId);
  }

  async sendChunk(
    contextId: string,
    text: string,
    continueTurn: boolean,
  ): Promise<void> {
    if (!this.activeContexts.has(contextId)) return;

    const trimmed = text.trim();
    if (!trimmed) {
      if (!continueTurn) {
        this.finishContext(contextId);
      }
      return;
    }

    const ac = this.abortByContext.get(contextId);
    try {
      const response = await this.client.audio.speech.create(
        {
          model: "gpt-4o-mini-tts",
          voice: this.voice as
            | "alloy"
            | "ash"
            | "ballad"
            | "coral"
            | "echo"
            | "fable"
            | "onyx"
            | "nova"
            | "sage"
            | "shimmer",
          input: trimmed,
          response_format: "pcm",
          speed: 1,
          instructions:
            "Speak in clear, natural American English. Use English pronunciation even if the text contains foreign words unless those words are clearly meant to be spoken in another language.",
        },
        { signal: ac?.signal },
      );

      if (!this.activeContexts.has(contextId)) return;

      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > 0) {
        this.onChunk?.(contextId, buf.toString("base64"));
      }

      if (!continueTurn) {
        this.finishContext(contextId);
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || ac?.signal.aborted)
      ) {
        return;
      }
      // Fall back for accounts without gpt-4o-mini-tts
      try {
        const response = await this.client.audio.speech.create(
          {
            model: "tts-1",
            voice: this.voice as
              | "alloy"
              | "echo"
              | "fable"
              | "onyx"
              | "nova"
              | "shimmer",
            input: trimmed,
            response_format: "pcm",
            speed: 1,
          },
          { signal: ac?.signal },
        );
        if (!this.activeContexts.has(contextId)) return;
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > 0) {
          this.onChunk?.(contextId, buf.toString("base64"));
        }
        if (!continueTurn) {
          this.finishContext(contextId);
        }
      } catch (e) {
        console.error("[OpenAI TTS] speech.create failed:", e);
        if (!continueTurn) {
          this.finishContext(contextId);
        }
      }
    }
  }

  async finalizeContext(contextId: string): Promise<void> {
    await this.sendChunk(contextId, "", false);
  }

  cancelContext(contextId: string): void {
    this.abortByContext.get(contextId)?.abort();
    this.activeContexts.delete(contextId);
    this.abortByContext.delete(contextId);
  }

  cancelAll(): void {
    for (const id of [...this.activeContexts]) {
      this.cancelContext(id);
    }
  }

  disconnect(): void {
    this.cancelAll();
  }
}
