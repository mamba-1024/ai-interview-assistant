/**
 * Content Script — 最小注入
 *
 * 仅在面试平台页面上注入一个浮动状态指示器，
 * 不干扰页面 DOM，屏幕共享时不可见。
 */

export default defineContentScript({
  matches: [
    "https://meet.google.com/*",
    "https://zoom.us/*",
    "https://teams.microsoft.com/*",
    "https://teams.live.com/*",
  ],
  runAt: "document_idle",

  main() {
    // 创建状态指示器
    const indicator = document.createElement("div");
    indicator.id = "interview-assistant-indicator";
    indicator.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 99999;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(100, 116, 139, 0.3);
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      color: #94a3b8;
      pointer-events: none;
    `;

    const dot = document.createElement("span");
    dot.style.cssText = `
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
      animation: pulse 2s infinite;
    `;

    const text = document.createElement("span");
    text.textContent = chrome.i18n.getMessage("contentActive") || "Interview Assistant Active";

    indicator.appendChild(dot);
    indicator.appendChild(text);
    document.body.appendChild(indicator);

    // 添加动画样式
    const style = document.createElement("style");
    style.textContent = `
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `;
    document.head.appendChild(style);

    // 监听来自 Service Worker 的消息
    chrome.runtime.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "SESSION_STARTED":
          indicator.style.display = "flex";
          break;
        case "SESSION_ENDED":
          indicator.style.display = "none";
          break;
      }
    });

    console.log("[Interview Assistant] Content script loaded");
  },
});
