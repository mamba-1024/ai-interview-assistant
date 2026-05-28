import { useCallback, useEffect, useRef, useState } from "react";
import {
  appStore,
  type InterviewMessage,
  type SessionHistory,
  type Suggestion,
} from "../store/extensionStore";

// ─── Types ─────────────────────────────────────────────────────
type SessionStatus = "idle" | "recording" | "analyzing" | "completed";

interface SessionStateSnapshot {
  status: SessionStatus;
  sessionId: string | null;
  company: string;
  role: string;
  messages: InterviewMessage[];
  suggestions: Suggestion[];
  startedAt: number | null;
  resumeId: string | null;
}

/** Messages broadcasted by the Service Worker */
export type ServiceWorkerMessage =
  | { type: "STATE_UPDATE"; state: SessionStateSnapshot }
  | { type: "TRANSCRIPT"; message: InterviewMessage }
  | { type: "TRANSCRIPT_INTERIM"; text: string }
  | { type: "SUGGESTION_START"; questionId: string }
  | { type: "SUGGESTION_CHUNK"; chunk: string }
  | { type: "SUGGESTION_END"; suggestion: Suggestion }
  | { type: "SUGGESTION_ERROR"; error: string }
  | { type: "QUESTION_DETECTED"; question: string }
  | { type: "SESSION_HISTORY_ADD"; entry: SessionHistory; session?: SessionHistory }
  | { type: "ERROR"; message: string; code?: string }
  | { type: "ANALYSIS_RESULT"; result: unknown };

export interface UseServiceWorkerOptions {
  /** Optional callback fired when the SW reports a detected question */
  onQuestionDetected?: (question: string) => void;
  /** Optional callback fired on every ERROR message */
  onError?: (message: string, code?: string) => void;
}

export interface UseServiceWorkerReturn {
  isConnected: boolean;
  isSuggestionLoading: boolean;
  currentSuggestionText: string;
  lastError: string | null;
  sendMessage: (message: { type: string; payload?: unknown; [k: string]: unknown }) => void;
  /** Backward-compatible helper used by older call sites */
  sendToServiceWorker: (type: string, payload?: unknown) => void;
  startInterview: (company: string, role: string, resumeId?: string) => void;
  stopInterview: () => void;
  requestSuggestion: (context?: string) => void;
}

// ─── Constants ─────────────────────────────────────────────────
const PORT_NAME = "sidepanel";
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL_MS = 2000;

// ─── Hook ──────────────────────────────────────────────────────
/**
 * Establishes the Side Panel ↔ Service Worker long-lived connection,
 * routes every SW message into the zustand store, exposes streaming
 * suggestion state, and transparently reconnects on disconnect.
 */
export function useServiceWorkerConnection(
  options: UseServiceWorkerOptions = {},
): UseServiceWorkerReturn {
  const { onQuestionDetected, onError } = options;

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);
  const callbacksRef = useRef({ onQuestionDetected, onError });

  const [isConnected, setIsConnected] = useState(false);
  const [isSuggestionLoading, setIsSuggestionLoading] = useState(false);
  const [currentSuggestionText, setCurrentSuggestionText] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);

  // Keep latest callbacks accessible without re-running the connection effect.
  useEffect(() => {
    callbacksRef.current = { onQuestionDetected, onError };
  }, [onQuestionDetected, onError]);

  // ─── Message dispatcher ──────────────────────────────────────
  const handleMessage = useCallback((rawMsg: unknown) => {
    if (!rawMsg || typeof (rawMsg as { type?: unknown }).type !== "string") return;
    const raw = rawMsg as ServiceWorkerMessage;
    const store = appStore.getState();

    switch (raw.type) {
      // ── Bulk session sync ──────────────────────────────────
      case "STATE_UPDATE": {
        const next = raw.state;
        if (!next) break;
        appStore.setState({
          sessionState: next.status,
          company: next.company ?? "",
          role: next.role ?? "",
          messages: Array.isArray(next.messages) ? next.messages : [],
          suggestions: Array.isArray(next.suggestions) ? next.suggestions : [],
        });
        break;
      }

      // ── Transcript ─────────────────────────────────────────
      case "TRANSCRIPT": {
        if (raw.message) {
          store.addMessage(raw.message);
          store.setInterimText("");
        }
        break;
      }

      case "TRANSCRIPT_INTERIM": {
        store.setInterimText(raw.text ?? "");
        break;
      }

      // ── Streaming suggestion ───────────────────────────────
      case "SUGGESTION_START": {
        setIsSuggestionLoading(true);
        setCurrentSuggestionText("");
        setLastError(null);
        break;
      }

      case "SUGGESTION_CHUNK": {
        const piece = raw.chunk ?? "";
        if (piece) {
          setCurrentSuggestionText((prev) => prev + piece);
        }
        break;
      }

      case "SUGGESTION_END": {
        if (raw.suggestion) {
          store.addSuggestion(raw.suggestion);
        }
        setIsSuggestionLoading(false);
        setCurrentSuggestionText("");
        break;
      }

      case "SUGGESTION_ERROR": {
        const errMsg = raw.error ?? "Unknown suggestion error";
        setIsSuggestionLoading(false);
        setCurrentSuggestionText("");
        setLastError(errMsg);
        callbacksRef.current.onError?.(errMsg);
        break;
      }

      // ── Question detection ─────────────────────────────────
      case "QUESTION_DETECTED": {
        if (raw.question) {
          callbacksRef.current.onQuestionDetected?.(raw.question);
        }
        break;
      }

      // ── Session history ────────────────────────────────────
      case "SESSION_HISTORY_ADD": {
        // SW currently uses `entry`; tolerate `session` alias for forward-compat
        const entry = raw.entry ?? raw.session;
        if (entry) {
          store.addSessionToHistory(entry);
        }
        break;
      }

      // ── Generic error ──────────────────────────────────────
      case "ERROR": {
        const errMsg = raw.message ?? "Unknown service worker error";
        setLastError(errMsg);
        callbacksRef.current.onError?.(errMsg, raw.code);
        console.error("[SW Error]", errMsg, raw.code ?? "");
        break;
      }

      default:
        // unknown / passthrough — ignore silently
        break;
    }
  }, []);

  // ─── Connection lifecycle ────────────────────────────────────
  const connect = useCallback(() => {
    if (isUnmountedRef.current) return;
    if (typeof chrome === "undefined" || !chrome.runtime?.connect) {
      setLastError("chrome.runtime is unavailable");
      setIsConnected(false);
      return;
    }

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      setIsConnected(false);
      setLastError(err instanceof Error ? err.message : String(err));
      scheduleReconnect();
      return;
    }

    portRef.current = port;
    setIsConnected(true);

    port.onMessage.addListener(handleMessage);

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime?.lastError?.message;
      portRef.current = null;
      setIsConnected(false);
      if (lastErr) {
        console.warn("[SW] port disconnected:", lastErr);
      }
      scheduleReconnect();
    });

    // On every (re)connect, request a fresh state snapshot.
    try {
      port.postMessage({ type: "GET_STATE" });
    } catch {
      // port may already be torn down; reconnect logic will retry
    }

    // Successful connection resets the retry counter.
    reconnectAttemptsRef.current = 0;
  }, [handleMessage]);

  const scheduleReconnect = useCallback(() => {
    if (isUnmountedRef.current) return;
    if (reconnectTimerRef.current !== null) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      const msg = `Service Worker connection lost after ${MAX_RECONNECT_ATTEMPTS} retries`;
      setLastError(msg);
      callbacksRef.current.onError?.(msg, "RECONNECT_EXHAUSTED");
      return;
    }

    reconnectAttemptsRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, RECONNECT_INTERVAL_MS);
  }, [connect]);

  useEffect(() => {
    isUnmountedRef.current = false;
    connect();

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try {
        portRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      portRef.current = null;
      setIsConnected(false);
    };
  }, [connect]);

  // ─── Outbound helpers ────────────────────────────────────────
  const sendMessage = useCallback(
    (message: { type: string; payload?: unknown; [k: string]: unknown }) => {
      const port = portRef.current;
      if (!port) {
        // Buffer-less fallback: try one-shot runtime.sendMessage
        try {
          chrome.runtime?.sendMessage?.(message);
        } catch (err) {
          console.warn("[SW] sendMessage failed: no active port", err);
        }
        return;
      }
      try {
        port.postMessage(message);
      } catch (err) {
        console.warn("[SW] postMessage failed:", err);
        setIsConnected(false);
        scheduleReconnect();
      }
    },
    [scheduleReconnect],
  );

  const sendToServiceWorker = useCallback(
    (type: string, payload?: unknown) => {
      sendMessage({ type, payload });
    },
    [sendMessage],
  );

  const startInterview = useCallback(
    (company: string, role: string, resumeId?: string) => {
      sendMessage({
        type: "START_INTERVIEW",
        payload: { company, role, resumeId },
      });
    },
    [sendMessage],
  );

  const stopInterview = useCallback(() => {
    sendMessage({ type: "STOP_INTERVIEW" });
  }, [sendMessage]);

  const requestSuggestion = useCallback(
    (context?: string) => {
      sendMessage({
        type: "REQUEST_SUGGESTION",
        payload: { context },
      });
    },
    [sendMessage],
  );

  return {
    isConnected,
    isSuggestionLoading,
    currentSuggestionText,
    lastError,
    sendMessage,
    sendToServiceWorker,
    startInterview,
    stopInterview,
    requestSuggestion,
  };
}
