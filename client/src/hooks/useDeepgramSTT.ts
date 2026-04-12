"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import type { Socket } from "socket.io-client";

const BARGE_IN_THROTTLE_MS = 320;
const FINAL_TRANSCRIPT_TIMEOUT_MS = 8_000;

interface UseDeepgramSTTReturn {
  isListening: boolean;
  interimTranscript: string;
  /** Resolves true when mic + recorder are active; false if cancelled, unsupported, or error. */
  startListening: () => Promise<boolean>;
  stopListening: () => void;
  isSupported: boolean;
  isMuted: boolean;
  toggleMute: () => void;
}

function micErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      return "Microphone access was denied. Allow the microphone in your browser or system settings.";
    }
    if (err.name === "NotFoundError") {
      return "No microphone was found. Connect a microphone and try again.";
    }
  }
  if (err instanceof Error) {
    return err.message || "Could not open the microphone.";
  }
  return "Could not open the microphone.";
}

/**
 * Deepgram Nova-2 STT via server relay.
 *
 * Flow: Mic → MediaRecorder (WebM/Opus) → socket.io → server → Deepgram WS
 *       Deepgram → server → socket.io → this hook (transcript + VAD events)
 */
export function useDeepgramSTT(
  onFinalTranscript?: (text: string) => void,
  onBargeIn?: () => void,
  socketRef?: { current: Socket | null },
  onMicError?: (message: string) => void,
): UseDeepgramSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onFinalRef = useRef(onFinalTranscript);
  const onBargeInRef = useRef(onBargeIn);
  const onMicErrorRef = useRef(onMicError);
  const finalSegmentsRef = useRef<string[]>([]);
  const listenersAttachedRef = useRef(false);
  const lastBargeInAtRef = useRef(0);

  /** Non-null only while `getUserMedia` is in flight; aborted from `stopListening` or superseded start. */
  const micAcquireAbortRef = useRef<AbortController | null>(null);

  const pendingAudioSendsRef = useRef(0);
  const flushSttStopAfterDrainRef = useRef(false);
  const mountedRef = useRef(true);
  const tryEmitSttStopIfReadyRef = useRef<() => void>(() => {});

  /** True between emitting `stt_stop` and receiving the final `stt_transcript` (or timeout). */
  const awaitingFinalTranscriptRef = useRef(false);
  const finalTranscriptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detachListenersRef = useRef<() => void>(() => {});

  const isSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
    onBargeInRef.current = onBargeIn;
    onMicErrorRef.current = onMicError;
  }, [onFinalTranscript, onBargeIn, onMicError]);

  const toggleMute = useCallback(() => {
    isMutedRef.current = !isMutedRef.current;
    setIsMuted(isMutedRef.current);
    if (isMutedRef.current) {
      finalSegmentsRef.current = [];
      setInterimTranscript("");
    }
  }, []);

  const handleTranscript = useCallback(
    (payload: { text: string; is_final: boolean; speech_final: boolean }) => {
      if (isMutedRef.current) return;

      const { text, is_final, speech_final } = payload;

      if (speech_final) {
        lastBargeInAtRef.current = 0;
        if (text) finalSegmentsRef.current.push(text);
        const fullText = finalSegmentsRef.current.join(" ").trim();
        finalSegmentsRef.current = [];
        setInterimTranscript("");
        if (fullText) {
          onFinalRef.current?.(fullText);
        }
        if (awaitingFinalTranscriptRef.current) {
          detachListenersRef.current();
        }
      } else if (is_final) {
        if (text) finalSegmentsRef.current.push(text);
        setInterimTranscript("");
      } else {
        if (text) {
          const now = Date.now();
          if (now - lastBargeInAtRef.current >= BARGE_IN_THROTTLE_MS) {
            lastBargeInAtRef.current = now;
            onBargeInRef.current?.();
          }
          const buffered = finalSegmentsRef.current.join(" ");
          const display = buffered ? `${buffered} ${text}` : text;
          setInterimTranscript(display);
        }
      }
    },
    [],
  );

  const handleSpeechStarted = useCallback(() => {
    // no-op: rely on interim transcripts for barge-in to avoid
    // false triggers from background noise
  }, []);

  const handleUtteranceEnd = useCallback(() => {
    lastBargeInAtRef.current = 0;
    if (finalSegmentsRef.current.length > 0) {
      const fullText = finalSegmentsRef.current.join(" ").trim();
      finalSegmentsRef.current = [];
      setInterimTranscript("");
      if (fullText) {
        onFinalRef.current?.(fullText);
      }
    }
  }, []);

  const startListening = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;

    const socket = socketRef?.current;
    if (!socket?.connected) {
      console.error("[DeepgramSTT] No socket connection");
      onMicErrorRef.current?.("Not connected to the voice server. Start the server and wait for Ready.");
      return false;
    }

    micAcquireAbortRef.current?.abort();
    const ac = new AbortController();
    micAcquireAbortRef.current = ac;
    const { signal } = ac;

    let acquiredStream: MediaStream | null = null;

    try {
      if (awaitingFinalTranscriptRef.current) {
        detachListenersRef.current();
      }
      flushSttStopAfterDrainRef.current = false;
      pendingAudioSendsRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        signal,
      } as MediaStreamConstraints & { signal: AbortSignal });

      if (signal.aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      if (micAcquireAbortRef.current === ac) {
        micAcquireAbortRef.current = null;
      }

      acquiredStream = stream;
      streamRef.current = stream;

      if (!listenersAttachedRef.current) {
        socket.on("stt_transcript", handleTranscript);
        socket.on("stt_speech_started", handleSpeechStarted);
        socket.on("stt_utterance_end", handleUtteranceEnd);
        listenersAttachedRef.current = true;
      }

      socket.emit("stt_start", {});

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.addEventListener("stop", () => {
        tryEmitSttStopIfReadyRef.current();
      });

      recorder.ondataavailable = (event) => {
        const sock = socketRef?.current;
        if (!sock) return;

        if (event.data.size === 0) {
          tryEmitSttStopIfReadyRef.current();
          return;
        }

        pendingAudioSendsRef.current += 1;
        void event.data
          .arrayBuffer()
          .then((buffer) => {
            socketRef.current?.emit("stt_audio", buffer);
          })
          .catch(() => {
            /* ignore blob read errors */
          })
          .finally(() => {
            pendingAudioSendsRef.current -= 1;
            tryEmitSttStopIfReadyRef.current();
          });
      };

      recorder.start(250);
      setIsListening(true);
      finalSegmentsRef.current = [];
      lastBargeInAtRef.current = 0;
      console.log("[DeepgramSTT] Started listening");
      return true;
    } catch (err) {
      if (acquiredStream) {
        acquiredStream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === acquiredStream) {
          streamRef.current = null;
        }
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        return false;
      }
      console.error("[DeepgramSTT] Failed to start:", err);
      onMicErrorRef.current?.(micErrorMessage(err));
      return false;
    } finally {
      if (micAcquireAbortRef.current === ac) {
        micAcquireAbortRef.current = null;
      }
    }
  }, [isSupported, socketRef, handleTranscript, handleSpeechStarted, handleUtteranceEnd]);

  const stopListening = useCallback(() => {
    micAcquireAbortRef.current?.abort();

    flushSttStopAfterDrainRef.current = true;

    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    } else {
      tryEmitSttStopIfReadyRef.current();
    }
  }, []);

  detachListenersRef.current = () => {
    if (finalTranscriptTimeoutRef.current) {
      clearTimeout(finalTranscriptTimeoutRef.current);
      finalTranscriptTimeoutRef.current = null;
    }
    awaitingFinalTranscriptRef.current = false;

    const socket = socketRef?.current;
    if (socket && listenersAttachedRef.current) {
      socket.off("stt_transcript", handleTranscript);
      socket.off("stt_speech_started", handleSpeechStarted);
      socket.off("stt_utterance_end", handleUtteranceEnd);
      listenersAttachedRef.current = false;
    }
    console.log("[DeepgramSTT] Detached listeners");
  };

  tryEmitSttStopIfReadyRef.current = () => {
    if (!flushSttStopAfterDrainRef.current) return;
    if (pendingAudioSendsRef.current > 0) return;

    flushSttStopAfterDrainRef.current = false;
    socketRef?.current?.emit("stt_stop", {});

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;

    if (mountedRef.current) {
      setIsListening(false);
      setInterimTranscript("");
    }
    finalSegmentsRef.current = [];
    lastBargeInAtRef.current = 0;
    console.log("[DeepgramSTT] Stopped listening — awaiting final transcript from server");

    awaitingFinalTranscriptRef.current = true;
    finalTranscriptTimeoutRef.current = setTimeout(() => {
      if (awaitingFinalTranscriptRef.current) {
        console.warn("[DeepgramSTT] Timed out waiting for final transcript");
        detachListenersRef.current();
      }
    }, FINAL_TRANSCRIPT_TIMEOUT_MS);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      micAcquireAbortRef.current?.abort();
      if (finalTranscriptTimeoutRef.current) {
        clearTimeout(finalTranscriptTimeoutRef.current);
        finalTranscriptTimeoutRef.current = null;
      }
      awaitingFinalTranscriptRef.current = false;
      flushSttStopAfterDrainRef.current = true;
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "inactive") {
        rec.stop();
      } else {
        tryEmitSttStopIfReadyRef.current();
      }
    };
  }, []);

  return {
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    isSupported,
    isMuted,
    toggleMute,
  };
}
