import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    version: "0.1.0",
    default_locale: "en",
    permissions: [
      "sidePanel",
      "activeTab",
      "storage",
      "tabs",
      "alarms",
      "offscreen",
      "tabCapture",
    ],
    host_permissions: [
      "https://meet.google.com/*",
      "https://zoom.us/*",
      "https://teams.microsoft.com/*",
      "https://teams.live.com/*",
    ],
    side_panel: {
      default_path: "sidepanel.html",
    },
    commands: {
      "toggle-panel": {
        suggested_key: { default: "Ctrl+Shift+I" },
        description: "__MSG_cmdTogglePanel__",
      },
    },
  },
});
