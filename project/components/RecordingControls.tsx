import React from "react";
import { useExtensionStore } from "../store/extensionStore";
import { t } from "../lib/i18n";

interface Props {
  company: string;
  role: string;
}

export const RecordingControls: React.FC<Props> = ({ company, role }) => {
  const { sessionState } = useExtensionStore();
  const [isStarting, setIsStarting] = React.useState(false);

  const handleStart = async () => {
    if (!company.trim() || !role.trim()) return;
    setIsStarting(true);
    try {
      await chrome.runtime.sendMessage({
        type: "START_INTERVIEW",
        payload: { company: company.trim(), role: role.trim() },
      });
    } catch (err) {
      console.error("Failed to start interview:", err);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    await chrome.runtime.sendMessage({ type: "STOP_INTERVIEW" });
  };

  if (sessionState === "recording") {
    return (
      <button
        onClick={handleStop}
        className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
      >
        <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
        {t("btnStopInterview")}
      </button>
    );
  }

  return (
    <button
      onClick={handleStart}
      disabled={!company.trim() || !role.trim() || isStarting}
      className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
    >
      {isStarting ? t("btnStarting") : t("btnStartInterview")}
    </button>
  );
};
