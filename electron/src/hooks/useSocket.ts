import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { AgentState } from "@/lib/types";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const SERVER_API_KEY =
  (import.meta.env.VITE_SERVER_API_KEY as string | undefined)?.trim() || "";

function socketErrorMessage(payload: unknown): string {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (payload && typeof payload === "object" && "message" in payload) {
    const m = (payload as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return "Something went wrong.";
}

// Singleton socket that survives Vite HMR and React re-mounts.
// Without this, every HMR update tears down the socket and the server
// pipeline sends responses to a dead connection.
let _persistentSocket: Socket | null = null;

function getOrCreateSocket(): Socket {
  if (_persistentSocket && _persistentSocket.connected) return _persistentSocket;
  if (_persistentSocket) {
    _persistentSocket.removeAllListeners();
    _persistentSocket.disconnect();
  }
  _persistentSocket = io(SERVER_URL, {
    transports: ["websocket", "polling"],
    auth: SERVER_API_KEY ? { token: SERVER_API_KEY } : undefined,
  });
  return _persistentSocket;
}

// Keep HMR from destroying the socket
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // intentionally do NOT disconnect — keep the socket alive
  });
}

interface UseSocketReturn {
  isConnected: boolean;
  sendMessage: (text: string) => void;
  stopAudio: () => void;
  serverState: AgentState;
  serverGenerating: boolean;
  onAssistantText: (cb: (text: string, done: boolean) => void) => void;
  onAudioChunk: (cb: (data: string) => void) => void;
  onAudioDone: (cb: () => void) => void;
  onError: (cb: (message: string) => void) => void;
  onConsoleLog: (cb: (message: string) => void) => void;
  onAgentAction: (cb: (message: string) => void) => void;
  socketRef: { current: Socket | null };
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [serverState, setServerState] = useState<AgentState>("idle");
  const [serverGenerating, setServerGenerating] = useState(false);

  const assistantTextCb = useRef<((text: string, done: boolean) => void) | null>(null);
  const audioChunkCb = useRef<((data: string) => void) | null>(null);
  const audioDoneCb = useRef<(() => void) | null>(null);
  const errorCb = useRef<((message: string) => void) | null>(null);
  const consoleLogCb = useRef<((message: string) => void) | null>(null);
  const agentActionCb = useRef<((message: string) => void) | null>(null);

  useEffect(() => {
    const socket = getOrCreateSocket();
    socketRef.current = socket;

    // Sync current state (socket may already be connected from a previous mount)
    if (socket.connected) {
      setIsConnected(true);
    }

    const onConnect = () => {
      console.log("[Socket] Connected to server:", SERVER_URL);
      setIsConnected(true);
    };
    const onDisconnect = () => {
      console.log("[Socket] Disconnected from server");
      setIsConnected(false);
    };
    const onConnectError = (err: Error) => {
      errorCb.current?.(err?.message || "Connection failed");
    };
    const onStatus = (payload: { state: AgentState; generating?: boolean }) => {
      setServerState(payload.state);
      if (payload.generating === false) {
        setServerGenerating(false);
      } else if (payload.state === "thinking" || payload.state === "speaking") {
        setServerGenerating(true);
      }
    };
    const onAssistantTextEvt = (payload: { text: string; done: boolean }) => {
      assistantTextCb.current?.(payload.text, payload.done);
    };
    const onAudioChunkEvt = (payload: { data: string }) => {
      audioChunkCb.current?.(payload.data);
    };
    const onAudioDoneEvt = () => {
      audioDoneCb.current?.();
    };
    const onErrorEvt = (payload: unknown) => {
      errorCb.current?.(socketErrorMessage(payload));
    };
    const onConsoleLogEvt = (payload: { message: string }) => {
      consoleLogCb.current?.(payload.message);
    };
    const onAgentActionEvt = (payload: { message: string }) => {
      agentActionCb.current?.(payload.message);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("status", onStatus);
    socket.on("assistant_text", onAssistantTextEvt);
    socket.on("audio_chunk", onAudioChunkEvt);
    socket.on("audio_done", onAudioDoneEvt);
    socket.on("error", onErrorEvt);
    socket.on("console_log", onConsoleLogEvt);
    socket.on("agent_action", onAgentActionEvt);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("status", onStatus);
      socket.off("assistant_text", onAssistantTextEvt);
      socket.off("audio_chunk", onAudioChunkEvt);
      socket.off("audio_done", onAudioDoneEvt);
      socket.off("error", onErrorEvt);
      socket.off("console_log", onConsoleLogEvt);
      socket.off("agent_action", onAgentActionEvt);
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    socketRef.current?.emit("user_message", { text });
  }, []);

  const stopAudio = useCallback(() => {
    socketRef.current?.emit("stop_audio", {});
  }, []);

  const onAssistantText = useCallback(
    (cb: (text: string, done: boolean) => void) => {
      assistantTextCb.current = cb;
    },
    []
  );

  const onAudioChunk = useCallback((cb: (data: string) => void) => {
    audioChunkCb.current = cb;
  }, []);

  const onAudioDone = useCallback((cb: () => void) => {
    audioDoneCb.current = cb;
  }, []);

  const onError = useCallback((cb: (message: string) => void) => {
    errorCb.current = cb;
  }, []);

  const onConsoleLog = useCallback((cb: (message: string) => void) => {
    consoleLogCb.current = cb;
  }, []);

  const onAgentAction = useCallback((cb: (message: string) => void) => {
    agentActionCb.current = cb;
  }, []);

  return {
    isConnected,
    sendMessage,
    stopAudio,
    serverState,
    serverGenerating,
    onAssistantText,
    onAudioChunk,
    onAudioDone,
    onError,
    onConsoleLog,
    onAgentAction,
    socketRef,
  };
}
