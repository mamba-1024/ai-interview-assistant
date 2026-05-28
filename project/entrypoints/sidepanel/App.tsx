import React, { useState } from "react";
import { useExtensionStore } from "../../store/extensionStore";
import { useServiceWorkerConnection } from "../../hooks/useServiceWorker";
import { InterviewChat } from "../../components/InterviewChat";
import { ResumePanel } from "../../components/ResumePanel";
import { RecordingControls } from "../../components/RecordingControls";
import { SuggestionCard } from "../../components/SuggestionCard";
import { t } from "../../lib/i18n";

type Tab = "chat" | "resume" | "settings";

const tabLabels: Record<Tab, string> = {
  chat: t("tabInterview"),
  resume: t("tabResume"),
  settings: t("tabSettings"),
};

export const App: React.FC = () => {
  const { sessionState, messages, suggestions, currentTab, setCurrentTab } =
    useExtensionStore();
  useServiceWorkerConnection();

  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <h1 className="text-lg font-semibold text-white">
          {t("appTitle")}
        </h1>
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            sessionState === "recording"
              ? "bg-red-500/20 text-red-400"
              : "bg-slate-600/20 text-slate-400"
          }`}
        >
          {sessionState === "recording" ? t("statusRecording") : t("statusIdle")}
        </span>
      </header>

      {/* Tab Navigation */}
      <nav className="flex border-b border-slate-700">
        {(["chat", "resume", "settings"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setCurrentTab(tab)}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              currentTab === tab
                ? "text-blue-400 border-b-2 border-blue-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="flex-1 overflow-hidden">
        {currentTab === "chat" && (
          <div className="flex flex-col h-full">
            {sessionState === "idle" ? (
              <div className="p-4 space-y-4">
                <p className="text-sm text-slate-400">
                  {t("enterDetails")}
                </p>
                <input
                  type="text"
                  placeholder={t("placeholderCompany")}
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
                <input
                  type="text"
                  placeholder={t("placeholderRole")}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            ) : (
              <>
                <InterviewChat messages={messages} />
                {suggestions.length > 0 && (
                  <SuggestionCard suggestion={suggestions[suggestions.length - 1]} />
                )}
              </>
            )}
          </div>
        )}

        {currentTab === "resume" && <ResumePanel />}

        {currentTab === "settings" && (
          <div className="p-4 space-y-4">
            <h2 className="text-sm font-medium text-slate-300">{t("settingsTitle")}</h2>
            <div className="space-y-3">
              <label className="flex items-center justify-between">
                <span className="text-sm text-slate-400">{t("settingAutoDetect")}</span>
                <input type="checkbox" defaultChecked className="accent-blue-500" />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-sm text-slate-400">{t("settingInterimTranscript")}</span>
                <input type="checkbox" className="accent-blue-500" />
              </label>
            </div>
          </div>
        )}
      </main>

      {/* Footer Controls */}
      <footer className="border-t border-slate-700 p-3">
        <RecordingControls company={company} role={role} />
      </footer>
    </div>
  );
};
