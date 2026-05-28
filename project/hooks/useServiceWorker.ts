import { useEffect, useRef } from "react";
import { appStore } from "../store/extensionStore";

/**
 * Hook: 建立 Side Panel 与 Service Worker 的长连接
 * 接收实时转录、AI建议等消息并更新 store
 */
export function useServiceWorkerConnection() {
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    // 建立长连接
    portRef.current = chrome.runtime.connect({ name: "sidepanel" });

    portRef.current.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "SESSION_STARTED":
          appStore.getState().startSession(
            msg.payload.company,
            msg.payload.role,
          );
          break;

        case "SESSION_ENDED":
          appStore.getState().endSession();
          break;

        case "TRANSCRIPT":
          appStore.getState().addMessage({
            id: crypto.randomUUID(),
            role: msg.payload.speaker === 0 ? "interviewer" : "candidate",
            content: msg.payload.text,
            timestamp: Date.now(),
            isFinal: true,
          });
          appStore.getState().setInterimText("");
          break;

        case "TRANSCRIPT_INTERIM":
          appStore.getState().setInterimText(msg.payload.text);
          break;

        case "AI_SUGGESTION":
          appStore.getState().addSuggestion({
            id: crypto.randomUUID(),
            ...msg.payload,
            timestamp: Date.now(),
          });
          break;

        case "ERROR":
          console.error("[SW Error]", msg.payload);
          break;
      }
    });

    return () => {
      portRef.current?.disconnect();
    };
  }, []);

  const sendToServiceWorker = (type: string, payload?: any) => {
    portRef.current?.postMessage({ type, payload });
  };

  return { sendToServiceWorker };
}
