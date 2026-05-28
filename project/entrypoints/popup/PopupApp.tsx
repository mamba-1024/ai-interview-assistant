import React from "react";
import { t } from "../../lib/i18n";

export const PopupApp: React.FC = () => {
  const openSidePanel = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  };

  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold text-white">
        {t("popupTitle")}
      </h1>
      <p className="text-xs text-slate-400">
        {t("popupDescription")}
      </p>
      <button
        onClick={openSidePanel}
        className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {t("popupOpenPanel")}
      </button>
      <a
        href="https://api.yourapp.com/dashboard"
        target="_blank"
        rel="noopener"
        className="block text-center text-xs text-blue-400 hover:text-blue-300"
      >
        {t("popupViewDashboard")}
      </a>
    </div>
  );
};
