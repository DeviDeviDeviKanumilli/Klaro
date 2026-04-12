import type { Socket } from "socket.io";
import { describe, expect, it } from "vitest";
import { VoicePipeline } from "./voicePipeline.js";
import type { TTSProvider } from "../tts/types.js";

type EmitRecord = { event: string; payload: unknown };

function makeRecordingSocket(): Socket & { records: EmitRecord[] } {
  const records: EmitRecord[] = [];
  const socket = {
    records,
    emit(event: string, payload?: unknown) {
      records.push({ event, payload });
      return true;
    },
  };
  return socket as unknown as Socket & { records: EmitRecord[] };
}

class FakeTTS implements TTSProvider {
  chunks: string[] = [];
  finalized: string[] = [];
  private onChunk!: (id: string, b64: string) => void;
  private onDone!: (id: string) => void;

  async connect(): Promise<void> {}
  setCallbacks(onChunk: (id: string, b64: string) => void, onDone: (id: string) => void): void {
    this.onChunk = onChunk;
    this.onDone = onDone;
  }
  createContext(): string {
    return "ctx-1";
  }
  async sendChunk(contextId: string, text: string, _continueTurn: boolean): Promise<void> {
    this.chunks.push(text);
    this.onChunk(contextId, "fake-audio");
  }
  async finalizeContext(contextId: string): Promise<void> {
    this.finalized.push(contextId);
    this.onDone(contextId);
  }
  cancelContext(): void {}
  cancelAll(): void {}
  disconnect(): void {}
}

describe("VoicePipeline processSupervisorResponse", () => {
  it("emits status, assistant_text, drives TTS chunks, then idle", async () => {
    const socket = makeRecordingSocket();
    const tts = new FakeTTS();
    const pipeline = new VoicePipeline(null, tts, socket);

    await pipeline.processSupervisorResponse("Hello world. Second sentence.");

    const events = socket.records.map((r) => r.event);
    expect(events).toContain("status");
    expect(events.filter((e) => e === "assistant_text").length).toBeGreaterThanOrEqual(1);
    expect(tts.chunks.length).toBeGreaterThanOrEqual(1);
    expect(tts.finalized).toContain("ctx-1");
    expect(events).toContain("audio_done");
    const lastStatuses = socket.records
      .filter((r) => r.event === "status")
      .map((r) => (r.payload as { state?: string })?.state);
    expect(lastStatuses[lastStatuses.length - 1]).toBe("idle");
  });
});
