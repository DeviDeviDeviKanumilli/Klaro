import OpenAI from "openai";
import type { Socket } from "socket.io";
import { pcm16leToWav } from "../lib/pcmToWav.js";
import { hasHanScript, previewText, voiceTrace } from "../lib/voiceTrace.js";

/** Matroska / WebM files start with the EBML header (`0x1A 0x45 0xDF 0xA3`). */
function bufferStartsWithEbml(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  );
}

export type OpenAISTTAudioEncoding = "webm" | "pcm_s16le";

export type OpenAISTTSessionOptions = {
  /** Default `webm` (browser MediaRecorder). Use `pcm_s16le` for raw native mic PCM. */
  encoding?: OpenAISTTAudioEncoding;
  /** Required for `pcm_s16le` (e.g. 16000 or 48000). Ignored for `webm`. */
  sampleRate?: number;
  /** 1 or 2 for PCM; default 1 */
  channels?: number;
};

/**
 * Buffers WebM/Opus or raw PCM s16le from the client and runs Whisper once on stop.
 * (Periodic interim Whisper on partial WebM was removed — it often hallucinated wrong language.)
 */
export class OpenAISTT {
  private readonly apiKey: string;
  private client: OpenAI | null = null;
  private socket: Socket | null = null;
  private chunks: Buffer[] = [];
  private encoding: OpenAISTTAudioEncoding = "webm";
  private sampleRate = 16_000;
  private channels = 1;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  start(socket: Socket, options?: OpenAISTTSessionOptions): void {
    this.stop();
    this.socket = socket;
    this.chunks = [];

    const enc = options?.encoding;
    this.encoding = enc === "pcm_s16le" ? "pcm_s16le" : "webm";
    const sr = options?.sampleRate;
    this.sampleRate =
      typeof sr === "number" && Number.isFinite(sr) && sr >= 8000 && sr <= 192_000
        ? Math.floor(sr)
        : 16_000;
    const ch = options?.channels;
    this.channels =
      typeof ch === "number" && ch >= 1 && ch <= 8 ? Math.floor(ch) : 1;

    this.client = new OpenAI({ apiKey: this.apiKey });
    console.log(
      `[OpenAI STT] Session started encoding=${this.encoding} sampleRate=${this.sampleRate} channels=${this.channels}`,
    );
    socket.emit("stt_speech_started", {});

  }

  sendAudio(data: Buffer): void {
    this.chunks.push(Buffer.from(data));
  }

  private buildTranscriptionFile(
    merged: Buffer,
    encoding: OpenAISTTAudioEncoding,
    sampleRate: number,
    channels: number,
  ): File {
    if (encoding === "pcm_s16le") {
      const wav = pcm16leToWav(merged, sampleRate, channels);
      return new File([new Uint8Array(wav)], "recording.wav", {
        type: "audio/wav",
      });
    }
    return new File([new Uint8Array(merged)], "recording.webm", {
      type: "audio/webm",
    });
  }

  stop(): void {
    const encoding = this.encoding;
    const sampleRate = this.sampleRate;
    const channels = this.channels;
    const socket = this.socket;
    const client = this.client;
    const merged =
      this.chunks.length > 0 ? Buffer.concat(this.chunks) : null;

    this.socket = null;
    this.client = null;
    this.chunks = [];
    this.encoding = "webm";
    this.sampleRate = 16_000;
    this.channels = 1;

    if (!socket || !client || !merged || merged.length === 0) {
      return;
    }

    socket.emit("stt_utterance_end", {});

    void (async () => {
      try {
        if (encoding === "webm" && !bufferStartsWithEbml(merged)) {
          socket.emit("error", {
            message:
              "STT audio does not look like WebM. If you send raw PCM, emit stt_start first with {\"encoding\":\"pcm_s16le\",\"sampleRate\":<Hz>,\"channels\":1} before any stt_audio. Otherwise ensure the full WebM stream is sent before stt_stop (truncated WebM also triggers format errors).",
          });
          return;
        }

        const file = this.buildTranscriptionFile(
          merged,
          encoding,
          sampleRate,
          channels,
        );
        const result: unknown = await client.audio.transcriptions.create({
          model: "whisper-1",
          file,
          language: "en",
          temperature: 0,
          prompt: "English conversational speech.",
        });
        let text = "";
        if (typeof result === "string") {
          text = result.trim();
        } else if (result && typeof result === "object" && "text" in result) {
          const t = (result as { text?: unknown }).text;
          text = typeof t === "string" ? t.trim() : "";
        }
        if (text) {
          voiceTrace("stt_final", {
            preview: previewText(text, 240),
            len: text.length,
            hasHan: hasHanScript(text),
          });
          socket.emit("stt_transcript", {
            text,
            is_final: true,
            speech_final: true,
          });
        }
      } catch (err) {
        console.error("[OpenAI STT] Transcription failed:", err);
        socket.emit("error", {
          message:
            err instanceof Error ? err.message : "Speech-to-text failed",
        });
      }
    })();
  }
}
