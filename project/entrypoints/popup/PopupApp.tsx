import React, { useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import {
  initializeStore,
  useExtensionStore,
  type Suggestion,
} from "../../store/extensionStore";

// ─── Types ────────────────────────────────────────────────────
type SessionStatus = "idle" | "recording" | "analyzing" | "completed";

interface BackgroundState {
  status: SessionStatus;
  sessionId: string | null;
  company: string;
  role: string;
  startedAt: number | null;
  suggestions: Suggestion[];
}

// ─── Helpers ──────────────────────────────────────────────────
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function summarizeSuggestion(s: Suggestion): string {
  const raw =
    (s.sampleOpening && s.sampleOpening.trim()) ||
    (s.keyPoints && s.keyPoints[0]) ||
    "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}

// ─── Component ────────────────────────────────────────────────
export const PopupApp: React.FC = () => {
  const [bgState, setBgState] = useState<BackgroundState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [storeReady, setStoreReady] = useState(false);

  const currentJD = useExtensionStore((s) => s.currentJD);
  const jdHistory = useExtensionStore((s) => s.jdHistory);
  const user = useExtensionStore((s) => s.user);
  const isAuthenticated = useExtensionStore((s) => s.isAuthenticated);

  // Latest JD: prefer currentJD, otherwise the most recent in history
  const latestJD = useMemo(() => {
    if (currentJD) return currentJD;
    if (jdHistory.length > 0) {
      return [...jdHistory].sort((a, b) => b.savedAt - a.savedAt)[0];
    }
    return null;
  }, [currentJD, jdHistory]);

  // Hydrate store + fetch initial background state, listen for updates
  useEffect(() => {
    void initializeStore().finally(() => setStoreReady(true));

    try {
      chrome.runtime.sendMessage(
        { type: "GET_STATE" },
        (res: { state?: BackgroundState } | undefined) => {
          if (chrome.runtime.lastError) return;
          if (res?.state) setBgState(res.state);
        },
      );
    } catch {
      // background may be unavailable
    }

    const listener = (msg: { type?: string; state?: BackgroundState }) => {
      if (msg?.type === "STATE_UPDATE" && msg.state) {
        setBgState(msg.state);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Recording timer
  useEffect(() => {
    if (bgState?.status !== "recording" || !bgState.startedAt) {
      setElapsed(0);
      return;
    }
    const startedAt = bgState.startedAt;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [bgState?.status, bgState?.startedAt]);

  const status: SessionStatus = bgState?.status ?? "idle";
  const recentSuggestion =
    bgState?.suggestions && bgState.suggestions.length > 0
      ? bgState.suggestions[bgState.suggestions.length - 1]
      : null;

  // ─── Actions ────────────────────────────────────────────────
  const openSidePanel = async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.windowId) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        window.close();
      }
    } catch (err) {
      console.error("Failed to open side panel:", err);
    }
  };

  const handleStart = async () => {
    if (!latestJD) {
      void openSidePanel();
      return;
    }
    setIsStarting(true);
    try {
      await chrome.runtime.sendMessage({
        type: "START_INTERVIEW",
        payload: {
          company: latestJD.company,
          role: latestJD.role,
        },
      });
    } catch (err) {
      console.error("Failed to start interview:", err);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      await chrome.runtime.sendMessage({ type: "STOP_INTERVIEW" });
    } catch (err) {
      console.error("Failed to stop interview:", err);
    }
  };

  const handleLogin = () => {
    chrome.tabs.create({ url: "https://api.yourapp.com/login" });
  };

  // ─── Sub-renderers ──────────────────────────────────────────
  const renderStatusBadge = () => {
    switch (status) {
      case "recording":
        return (
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span className="text-sm font-medium text-red-300">
              {t("popupStatusRecording")}
            </span>
            <span className="ml-auto font-mono tabular-nums text-xs text-slate-300 bg-slate-900/60 px-1.5 py-0.5 rounded">
              {formatElapsed(elapsed)}
            </span>
          </div>
        );
      case "analyzing":
        return (
          <div className="flex items-center gap-2">
            <svg
              className="h-3.5 w-3.5 animate-spin text-amber-400 shrink-0"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm font-medium text-amber-300">
              {t("popupStatusAnalyzing")}
            </span>
          </div>
        );
      case "completed":
        return (
          <div className="flex items-center gap-2">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-500/20 text-blue-300 text-[10px] shrink-0">
              ✓
            </span>
            <span className="text-sm font-medium text-blue-300">
              {t("popupStatusCompleted")}
            </span>
          </div>
        );
      default:
        return (
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)] shrink-0" />
            <span className="text-sm font-medium text-slate-300">
              {t("popupStatusIdle")}
            </span>
          </div>
        );
    }
  };

  // ─── Render ─────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <h1 className="text-sm font-semibold text-white tracking-tight">
          {t("popupTitle")}
        </h1>
        <span className="text-[10px] text-slate-500 font-mono">v0.1.0</span>
      </div>

      {/* Status Card */}
      <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 px-3 py-2.5">
        {renderStatusBadge()}
        {(status === "recording" ||
          status === "analyzing" ||
          status === "completed") &&
          bgState?.company && (
            <div className="mt-1.5 text-[11px] text-slate-400 truncate">
              {bgState.company}
              {bgState.role ? ` · ${bgState.role}` : ""}
            </div>
          )}
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={openSidePanel}
          className="py-2 text-sm font-medium rounded-lg bg-slate-700/80 hover:bg-slate-600 text-white transition-colors"
        >
          {t("popupOpenPanel")}
        </button>

        {status === "recording" ? (
          <button
            onClick={handleStop}
            className="py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors flex items-center justify-center gap-1.5"
          >
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            {t("btnStopInterview")}
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={
              isStarting || status === "analyzing" || !storeReady
            }
            className="py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white transition-colors"
          >
            {isStarting ? t("btnStarting") : t("btnStartInterview")}
          </button>
        )}
      </div>

      {/* JD Hint */}
      {!latestJD && status === "idle" && storeReady && (
        <div className="-mt-1 rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5">
          <p className="text-[11px] text-amber-300/90 leading-snug">
            {t("popupNoJD")}
          </p>
        </div>
      )}
      {latestJD && status === "idle" && (
        <div className="-mt-1 text-[11px] text-slate-500 truncate">
          <span className="text-slate-600">→ </span>
          {latestJD.company} · {latestJD.role}
        </div>
      )}

      {/* Recent Suggestion */}
      {recentSuggestion && summarizeSuggestion(recentSuggestion) && (
        <button
          onClick={openSidePanel}
          className="text-left rounded-lg bg-gradient-to-br from-blue-900/30 to-purple-900/20 border border-blue-700/30 hover:border-blue-500/50 px-3 py-2.5 transition-colors group"
        >
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-blue-400 font-semibold">
              {t("popupRecentSuggestion")}
            </span>
            <span className="ml-auto text-[10px] text-slate-500 group-hover:text-blue-300 transition-colors">
              {t("popupViewDetail")}
            </span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            {summarizeSuggestion(recentSuggestion)}
          </p>
        </button>
      )}

      {/* Footer: Auth */}
      <div className="flex items-center justify-between border-t border-slate-800 pt-2.5">
        {isAuthenticated && user ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
              {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
            </div>
            <span className="text-xs text-slate-300 truncate">
              {user.name || user.email}
            </span>
            <span className="ml-auto text-[9px] uppercase tracking-wider font-semibold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
              {user.tier}
            </span>
          </div>
        ) : (
          <button
            onClick={handleLogin}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            {t("popupLogin")}
          </button>
        )}
      </div>

      {/* Shortcut Hint */}
      <div className="text-center -mt-1">
        <span className="text-[10px] text-slate-600">
          <kbd className="px-1 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-[10px] text-slate-400">
            Ctrl+Shift+I
          </kbd>{" "}
          {t("popupShortcutHint")}
        </span>
      </div>
    </div>
  );
};
