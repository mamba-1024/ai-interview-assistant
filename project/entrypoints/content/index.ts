/**
 * Content Script — 最小注入
 *
 * 仅在面试平台页面上注入一个浮动状态指示器，
 * 使用 Shadow DOM 隔离样式，不干扰页面 DOM。
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
    // 创建宿主容器
    const host = document.createElement("div");
    host.id = "interview-assistant-host";
    host.style.cssText = "all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647; pointer-events: none;";
    document.body.appendChild(host);

    // 使用 Shadow DOM 隔离样式
    const shadow = host.attachShadow({ mode: "closed" });

    // Shadow DOM 内部样式
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        display: block;
      }
      .indicator {
        display: none;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        margin: 12px;
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(100, 116, 139, 0.3);
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 12px;
        color: #94a3b8;
        pointer-events: none;
      }
      .indicator.active {
        display: flex;
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #ef4444;
        animation: ia-pulse 2s infinite;
      }
      @keyframes ia-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `;
    shadow.appendChild(style);

    const indicator = document.createElement("div");
    indicator.className = "indicator";

    const dot = document.createElement("span");
    dot.className = "dot";

    const text = document.createElement("span");
    text.textContent = chrome.i18n.getMessage("contentActive") || "Interview Assistant Active";

    indicator.appendChild(dot);
    indicator.appendChild(text);
    shadow.appendChild(indicator);

    // 监听来自 Service Worker 的消息
    chrome.runtime.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "SESSION_STARTED":
          indicator.classList.add("active");
          break;
        case "SESSION_ENDED":
          indicator.classList.remove("active");
          break;
      }
    });

    console.log("[Interview Assistant] Content script loaded");
  },
});
