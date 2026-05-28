/**
 * Service Worker — 事件路由 & 编排中心
 *
 * 职责:
 * - 管理 Side Panel 生命周期
 * - 消息路由（Side Panel ↔ Content Script ↔ Offscreen Document）
 * - Keep-alive 管理（防止 MV3 30s 超时）
 * - 面试会话状态管理
 */

export default defineBackground(() => {
  // ─── 长连接管理 ─────────────────────────────────────────────
  const connections = new Map<string, chrome.runtime.Port>();

  chrome.runtime.onConnect.addListener((port) => {
    connections.set(port.name, port);
    port.onMessage.addListener((msg) => routeMessage(msg, port));
    port.onDisconnect.addListener(() => connections.delete(port.name));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    routeMessage(msg, null, sender, sendResponse);
    return true; // 保持通道，等待异步响应
  });

  // ─── 消息路由 ───────────────────────────────────────────────
  function routeMessage(
    msg: { type: string; payload?: any },
    port: chrome.runtime.Port | null,
    sender?: chrome.runtime.MessageSender,
    sendResponse?: (res: any) => void,
  ) {
    switch (msg.type) {
      case "GET_STATE":
        sendResponse?.({ state: "idle" });
        break;

      case "START_INTERVIEW":
        handleStartInterview(msg.payload, port);
        break;

      case "STOP_INTERVIEW":
        handleStopInterview();
        break;

      case "TRANSCRIPT":
        broadcast({ type: "TRANSCRIPT", payload: msg.payload });
        break;

      case "TRANSCRIPT_INTERIM":
        broadcast({ type: "TRANSCRIPT_INTERIM", payload: msg.payload });
        break;

      case "UTTERANCE_END":
        broadcast({ type: "UTTERANCE_END" });
        break;

      case "KEEP_ALIVE":
        break; // 仅需消息本身来唤醒 SW
    }
  }

  // ─── 面试控制 ───────────────────────────────────────────────
  async function handleStartInterview(
    payload: { company: string; role: string; tabId?: number },
    port: chrome.runtime.Port | null,
  ) {
    try {
      // 获取当前标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = payload.tabId ?? tab?.id;

      if (!tabId) {
        port?.postMessage({ type: "ERROR", payload: "No active tab found" });
        return;
      }

      // 启动音频捕获
      await startAudioCapture(tabId);

      // 启动 keep-alive 定时器
      chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });

      broadcast({
        type: "SESSION_STARTED",
        payload: { company: payload.company, role: payload.role, tabId },
      });
    } catch (error) {
      console.error("Failed to start interview:", error);
      port?.postMessage({
        type: "ERROR",
        payload: `Failed to start: ${error}`,
      });
    }
  }

  function handleStopInterview() {
    chrome.alarms.clear("keepalive");
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    broadcast({ type: "SESSION_ENDED" });
  }

  // ─── 音频捕获 ───────────────────────────────────────────────
  async function startAudioCapture(tabId: number) {
    // 获取标签页音频流 ID
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    // 确保离屏文档存在
    await ensureOffscreenDocument();

    // 传递 streamId 给离屏文档
    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId,
    });
  }

  async function ensureOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    });

    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Audio capture and processing for interview transcription",
      });
    }
  }

  // ─── Keep-alive ─────────────────────────────────────────────
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      // 消息本身即可防止 SW 休眠
    }
  });

  // ─── Side Panel ─────────────────────────────────────────────
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("Side panel error:", err));

  // ─── 广播 ──────────────────────────────────────────────────
  function broadcast(msg: any) {
    connections.forEach((port) => {
      try {
        port.postMessage(msg);
      } catch {
        // 端口已断开
      }
    });
  }

  console.log("[Interview Assistant] Service Worker initialized");
});
