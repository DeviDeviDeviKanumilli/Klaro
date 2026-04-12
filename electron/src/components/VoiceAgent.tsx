import { useState, useCallback, useEffect, useRef } from "react";
import { useSocket } from "@/hooks/useSocket";
import { useDeepgramSTT } from "@/hooks/useDeepgramSTT";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import type { TranscriptEntry } from "@/lib/types";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const APP_TITLE =
  (import.meta.env.VITE_APP_TITLE as string | undefined)?.trim() ||
  "Klaro";

type EmbeddedServerIssue = "starting" | "crashed" | "port_busy";

export function VoiceAgent() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [embeddedServerIssue, setEmbeddedServerIssue] =
    useState<EmbeddedServerIssue | null>(null);

  const streamingTextRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCountRef = useRef(0);

  const {
    isConnected,
    sendMessage,
    stopAudio,
    serverState,
    onAssistantText,
    onAudioChunk,
    onAudioDone,
    onError,
    onConsoleLog,
    onAgentAction,
    socketRef,
  } = useSocket();

  const { playChunk, stopPlayback, initAudio, isPlaying } = useAudioPlayer();

  // Stable refs for functions used in barge-in callback
  const stopAudioRef = useRef(stopAudio);
  const stopPlaybackRef = useRef(stopPlayback);
  const sendMessageRef = useRef(sendMessage);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    stopAudioRef.current = stopAudio;
    stopPlaybackRef.current = stopPlayback;
    sendMessageRef.current = sendMessage;
    isPlayingRef.current = isPlaying;
  }, [stopAudio, stopPlayback, sendMessage, isPlaying]);

  // Instant barge-in: any speech detected → kill audio immediately
  const handleBargeIn = useCallback(() => {
    // Only act if audio is actually playing
    if (!isPlayingRef.current()) return;

    // Stop local audio playback instantly
    stopPlaybackRef.current();

    // Tell server to abort pipeline (stops LLM + TTS)
    stopAudioRef.current();

    // Finalize any in-progress streaming assistant text
    const pendingText = streamingTextRef.current;
    if (pendingText) {
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: pendingText,
        timestamp: Date.now(),
      }]);
      setStreamingText("");
      streamingTextRef.current = "";
    }
  }, []);

  // On final transcript — send the complete user message
  const handleFinalTranscript = useCallback((text: string) => {
    if (!text.trim()) return;
    messageCountRef.current++;
    console.log("[VoiceAgent] Final transcript (#" + messageCountRef.current + "):", text.trim());

    setHasInteracted(true);

    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      role: "user",
      text: text.trim(),
      timestamp: Date.now(),
    };
    setEntries((prev) => [...prev, entry]);

    sendMessageRef.current(text.trim());
  }, []);

  const {
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    isSupported,
    isMuted,
    toggleMute,
  } = useDeepgramSTT(
    handleFinalTranscript,
    handleBargeIn,
    socketRef,
    (message) => setError(message),
  );

  /** True after Space keydown intended to start capture; keyup ends gesture and always calls stopListening (with hook abort if still acquiring). */
  const spacePttGestureRef = useRef(false);
  const isListeningRef = useRef(isListening);
  const isConnectedRef = useRef(isConnected);
  const isSupportedRef = useRef(isSupported);
  const startListeningRef = useRef(startListening);
  const stopListeningRef = useRef(stopListening);
  const initAudioRef = useRef(initAudio);
  const handleBargeInRef = useRef(handleBargeIn);

  useEffect(() => {
    isListeningRef.current = isListening;
    isConnectedRef.current = isConnected;
    isSupportedRef.current = isSupported;
    startListeningRef.current = startListening;
    stopListeningRef.current = stopListening;
    initAudioRef.current = initAudio;
    handleBargeInRef.current = handleBargeIn;
  }, [
    isListening,
    isConnected,
    isSupported,
    startListening,
    stopListening,
    initAudio,
    handleBargeIn,
  ]);

  // Space push-to-talk: only while this BrowserWindow is focused (not a global OS shortcut).
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.repeat) return;
      if (!isConnectedRef.current || !isSupportedRef.current) return;

      if (isPlayingRef.current()) {
        handleBargeInRef.current();
      }

      if (!isListeningRef.current) {
        spacePttGestureRef.current = true;
        initAudioRef.current();
        void startListeningRef.current();
      }

      e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      if (spacePttGestureRef.current) {
        spacePttGestureRef.current = false;
        stopListeningRef.current();
      }
      if (isConnectedRef.current && isSupportedRef.current) {
        e.preventDefault();
      }
    };

    const onBlur = () => {
      if (spacePttGestureRef.current) {
        spacePttGestureRef.current = false;
        stopListeningRef.current();
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Wire up socket event handlers
  useEffect(() => {
    onAssistantText((text, done) => {
      console.log("[VoiceAgent] assistant_text:", { text: text.slice(0, 80), done });
      if (done) {
        const finalText = streamingTextRef.current;
        if (finalText) {
          const entry: TranscriptEntry = {
            id: crypto.randomUUID(),
            role: "assistant",
            text: finalText,
            timestamp: Date.now(),
          };
          setEntries((prev) => [...prev, entry]);
          setStreamingText("");
          streamingTextRef.current = "";
        }
      } else {
        streamingTextRef.current += text;
        setStreamingText(streamingTextRef.current);
      }
    });

    onAudioChunk((data) => {
      console.log("[VoiceAgent] audio_chunk received, length:", data.length);
      playChunk(data);
    });

    onAudioDone(() => {
      console.log("[VoiceAgent] audio_done");
    });

    onError((message) => {
      console.error("[VoiceAgent] error:", message);
      setError(message);
      setTimeout(() => setError(null), 5000);
    });

    onConsoleLog((message) => {
      console.log("[VoiceAgent] console_log:", message);
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "console",
        text: message,
        timestamp: Date.now(),
      }]);
    });

    onAgentAction((message) => {
      console.log("[VoiceAgent] agent_action:", message);
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "action",
        text: message,
        timestamp: Date.now(),
      }]);
    });
  }, [onAssistantText, onAudioChunk, onAudioDone, onError, onConsoleLog, onAgentAction, playChunk]);

  // Mark as interacted as soon as user starts speaking (skip first greeting message)
  useEffect(() => {
    if (interimTranscript && !hasInteracted && messageCountRef.current >= 1) {
      setHasInteracted(true);
    }
  }, [interimTranscript, hasInteracted]);

  // Auto-scroll chat log to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, streamingText]);

  // Initialize audio context when connected (STT starts closed — user clicks mic to begin)
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (isConnected && !prevConnectedRef.current) {
      console.log("[VoiceAgent] Connected — initializing audio (STT off until mic click)");
      initAudio();
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected, initAudio]);

  useEffect(() => {
    const subscribe = window.electron?.onServerStatus;
    if (!subscribe) return;
    subscribe((status) => {
      if (status === "ready") {
        setEmbeddedServerIssue(null);
        return;
      }
      setEmbeddedServerIssue(status);
    });
  }, []);

  const handleMicClick = useCallback(() => {
    initAudio();
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening, initAudio]);

  return (
    <div style={{ 
      width: '100%', 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      position: 'relative',
      background: '#0f1117',
      overflow: 'hidden',
    }}>
      {/* Title - top left */}
      <div style={{ 
        position: 'absolute',
        top: '16px',
        left: '16px',
        zIndex: 20,
        pointerEvents: 'none'
      }}>
        <span style={{ 
          color: 'rgba(255, 255, 255, 0.8)', 
          fontSize: '15px', 
          fontWeight: '600',
          letterSpacing: '-0.4px',
          fontFamily: '"SF Pro Rounded", "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        }}>
        {APP_TITLE}
        </span>
      </div>

      {/* Status indicator - top right */}
      <div style={{ 
        position: 'absolute',
        top: '14px',
        right: '16px',
        zIndex: 20,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <span
          style={{
            fontSize: '12px',
            fontWeight: '500',
            color: isListening
              ? '#10b981'
              : isConnected
                ? 'rgba(255,255,255,0.5)'
                : '#ef4444',
            fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          {isListening ? 'Listening' : isConnected ? 'Connected' : 'Disconnected'}
        </span>
        <div
          role="status"
          aria-label={
            isListening
              ? "Listening"
              : isConnected
                ? "Connected"
                : "Disconnected"
          }
          style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            background: isListening ? '#10b981' : (isConnected ? '#6b7280' : '#ef4444'),
            boxShadow: isListening ? '0 0 12px rgba(16, 185, 129, 0.8)' : 'none',
          }}
        />
      </div>

      {!isConnected && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: '44px',
            left: '16px',
            right: '16px',
            zIndex: 25,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            lineHeight: 1.4,
            color: '#fecaca',
            background: '#7f1d1d',
            border: '1px solid #991b1b',
            wordBreak: 'break-word',
          }}
        >
          Not connected to voice server. Make sure the server is running, then relaunch the app.
        </div>
      )}

      {embeddedServerIssue && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: !isConnected ? '88px' : '44px',
            left: '16px',
            right: '16px',
            zIndex: 25,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            lineHeight: 1.4,
            wordBreak: 'break-word',
            color: embeddedServerIssue === 'starting' ? '#bfdbfe' : '#fecaca',
            background: embeddedServerIssue === 'starting' ? '#1e3a5f' : '#7f1d1d',
            border: embeddedServerIssue === 'starting'
              ? '1px solid #2563eb'
              : '1px solid #991b1b',
          }}
        >
          {embeddedServerIssue === 'starting' && (
            <>Starting voice server — please wait…</>
          )}
          {embeddedServerIssue === 'crashed' && (
            <>
              Voice server failed to start. If the server is already running
              separately, close one of them and try again.
            </>
          )}
          {embeddedServerIssue === 'port_busy' && (
            <>
              Another process is using the server port. Close it or wait for it
              to finish, then relaunch.
            </>
          )}
        </div>
      )}

      {/* Draggable area - top bar */}
      <div 
        className="drag-region"
        style={{ 
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '50px',
          zIndex: 10,
          cursor: 'move',
          pointerEvents: 'auto'
        }}
      />

      {/* Content area */}
      <div 
        ref={scrollRef}
        style={{ 
          position: 'absolute',
          top: '45px',
          left: 0,
          right: 0,
          bottom: '90px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: ((interimTranscript && hasInteracted) || (entries.length === 0 && !streamingText && !hasInteracted)) ? 'center' : 'flex-end',
          alignItems: ((interimTranscript && hasInteracted) || (entries.length === 0 && !streamingText && !hasInteracted)) ? 'center' : 'stretch',
          padding: '8px 24px 8px 24px',
          overflowY: 'auto',
          overflowX: 'hidden',
          zIndex: 5,
        }} 
        className="custom-scrollbar"
      >

        {/* Live speech — centered takeover (hidden for first greeting exchange) */}
        {interimTranscript && hasInteracted ? (
          <div style={{ 
            textAlign: 'center',
            color: 'white',
            fontSize: '20px',
            fontWeight: '300',
            opacity: 0.85,
            maxWidth: '580px',
            lineHeight: '1.4',
            alignSelf: 'center',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}>
            {interimTranscript}
          </div>
        ) : entries.length === 0 && !streamingText && !hasInteracted ? (
          /* Greeting when no conversation yet */
          <div style={{ 
            textAlign: 'center',
            color: 'white',
            fontSize: '28px',
            fontWeight: '300',
            opacity: 0.9,
            alignSelf: 'center',
            fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}>
            Ready when you are.
          </div>
        ) : (
          /* Chat log */
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '6px',
            width: '100%',
          }}>
            {entries.map((entry) => (
              <div
                key={entry.id}
                style={{
                  display: 'flex',
                  justifyContent: entry.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                {entry.role === 'action' ? (
                  <div style={{
                    padding: '1px 0',
                    fontSize: '10px',
                    color: 'rgba(255,255,255,0.3)',
                    fontStyle: 'italic',
                    lineHeight: '1.3',
                    maxWidth: '95%',
                    fontWeight: '400',
                    fontFamily: '"SF Mono", "Menlo", "Monaco", monospace',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                  }}>
                    {entry.text}
                  </div>
                ) : entry.role === 'console' ? (
                  <div style={{
                    padding: '2px 0',
                    fontSize: '11px',
                    color: 'rgba(255,255,255,0.45)',
                    fontStyle: 'italic',
                    lineHeight: '1.4',
                    maxWidth: '90%',
                    fontWeight: '400',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                  }}>
                    {entry.text}
                  </div>
                ) : (
                  <div style={{
                    padding: '8px 14px',
                    borderRadius: '12px',
                    fontSize: '13px',
                    color: entry.role === 'user' ? '#e0e7ff' : 'rgba(255,255,255,0.95)',
                    background: entry.role === 'user' 
                      ? 'rgba(59, 130, 246, 0.2)' 
                      : 'rgba(255, 255, 255, 0.10)',
                    lineHeight: '1.5',
                    maxWidth: '80%',
                    minWidth: 0,
                    fontWeight: '400',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                  }}>
                    {entry.text}
                  </div>
                )}
              </div>
            ))}

            {hasInteracted &&
              entries.length === 0 &&
              !streamingText &&
              serverState === 'thinking' && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-start',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 14px',
                      borderRadius: '12px',
                      fontSize: '13px',
                      color: 'rgba(255,255,255,0.6)',
                      background: 'rgba(255, 255, 255, 0.06)',
                      lineHeight: '1.5',
                      fontStyle: 'italic',
                    }}
                  >
                    Thinking…
                  </div>
                </div>
              )}

            {/* Streaming assistant response — appears as latest bubble */}
            {streamingText && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  padding: '8px 14px',
                  borderRadius: '12px',
                  fontSize: '13px',
                  color: 'rgba(255,255,255,0.95)',
                  background: 'rgba(255, 255, 255, 0.10)',
                  lineHeight: '1.5',
                  maxWidth: '80%',
                  minWidth: 0,
                  fontWeight: '400',
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                }}>
                  {streamingText}
                  <span style={{ 
                    display: 'inline-block', 
                    width: '2px', 
                    height: '14px', 
                    background: 'white',
                    marginLeft: '4px',
                    verticalAlign: 'middle',
                    animation: 'blink 1s infinite'
                  }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom controls - mic + mute + hint */}
      <div
        className="no-drag"
        style={{
          position: 'absolute',
          bottom: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
          pointerEvents: 'auto',
          zIndex: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {isListening && (
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={isMuted}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
              className="no-drag"
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: isMuted ? 'rgba(234, 179, 8, 0.4)' : 'rgba(255, 255, 255, 0.15)',
                border: isMuted ? '2px solid rgba(234, 179, 8, 0.6)' : '2px solid rgba(255, 255, 255, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: isMuted ? '0 0 16px rgba(234, 179, 8, 0.4)' : '0 2px 8px rgba(0,0,0,0.3)',
                padding: 0,
                margin: 0,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {isMuted ? (
                  <>
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.12 1.5-.35 2.18" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </>
                ) : (
                  <>
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </>
                )}
              </svg>
            </button>
          )}

          <button
            type="button"
            onClick={handleMicClick}
            disabled={!isConnected || !isSupported}
            aria-pressed={isListening}
            aria-label={isListening ? "Stop listening" : "Start listening"}
            className="no-drag"
            style={{
              cursor: !isConnected || !isSupported ? 'not-allowed' : 'pointer',
              opacity: !isConnected || !isSupported ? 0.5 : 1,
              padding: 0,
              margin: 0,
              border: 'none',
              background: 'transparent',
              borderRadius: '50%',
            }}
          >
            <div style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              background: isListening ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255, 255, 255, 0.15)',
              border: '2px solid rgba(255, 255, 255, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.3s ease',
              boxShadow: isListening ? '0 0 24px rgba(239, 68, 68, 0.6)' : '0 4px 12px rgba(0,0,0,0.4)'
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {isListening ? (
                  <rect x="9" y="9" width="6" height="6" />
                ) : (
                  <>
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </>
                )}
              </svg>
            </div>
          </button>
        </div>

        <span
          style={{
            fontSize: "11px",
            color: "rgba(255, 255, 255, 0.45)",
            fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          Hold Space to talk · release to send
        </span>
      </div>

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: 'absolute',
            bottom: '80px',
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: 'min(90%, 620px)',
            padding: '10px 16px',
            background: '#991b1b',
            border: '1px solid #b91c1c',
            borderRadius: '10px',
            color: '#fecaca',
            fontSize: '13px',
            fontWeight: '500',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            textAlign: 'center',
            zIndex: 20
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
