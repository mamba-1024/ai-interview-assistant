/**
 * Service Worker — 事件路由 & 编排中心
 *
 * 职责:
 * - 管理 Side Panel 生命周期
 * - 消息路由（Side Panel ↔ Content Script ↔ Offscreen Document）
 * - Keep-alive 管理（防止 MV3 30s 超时）
 * - 面试会话状态管理（真实状态机）
 * - 问题检测 & AI 建议流式生成
 */

import { apiClient } from "../../lib/api";
import { QuestionDetector } from "../../lib/question-detector";
import type {
  InterviewMessage,
  Suggestion,
} from "../../store/extensionStore";

// ─── 类型定义 ─────────────────────────────────────────────────
interface SessionState {
  status: "idle" | "recording" | "analyzing" | "completed";
  sessionId: string | null;
  company: string;
  role: string;
  messages: InterviewMessage[];
  suggestions: Suggestion[];
  startedAt: number | null;
  resumeId: string | null;
  tabId: number | null;
}

interface IncomingPayloads {
  GET_STATE: undefined;
  START_INTERVIEW: { company: string; role: string; resumeId?: string; tabId?: number };
  STOP_INTERVIEW: undefined;
  REQUEST_SUGGESTION: { context?: string; question?: string };
  KEEP_ALIVE: undefined;
  TRANSCRIPT: { text: string; isFinal: boolean; speaker?: string };
  TRANSCRIPT_INTERIM: { text: string };
  UTTERANCE_END: undefined;
}

const INITIAL_STATE: SessionState = {
  status: "idle",
  sessionId: null,
  company: "",
  role: "",
  messages: [],
  suggestions: [],
  startedAt: null,
  resumeId: null,
  tabId: null,
};

export default defineBackground(() => {
  // ─── 会话状态 ───────────────────────────────────────────────
  let sessionState: SessionState = { ...INITIAL_STATE };

  // ─── 长连接管理 ─────────────────────────────────────────────
  const connections = new Map<string, chrome.runtime.Port>();

  // ─── 问题检测器 ────────────────────────────────────────────
  let questionDetector: QuestionDetector | null = null;
  let pendingQuestion: string | null = null;
  let suggestionAbort: AbortController | null = null;

  // ─── 工具函数 ───────────────────────────────────────────────
  function genId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  function updateState(patch: Partial<SessionState>): void {
    sessionState = { ...sessionState, ...patch };
    broadcastState();
  }

  function broadcastState(): void {
    broadcast({ type: "STATE_UPDATE", state: sessionState });
  }

  function broadcast(msg: any): void {
    connections.forEach((port) => {
      try {
        port.postMessage(msg);
      } catch {
        // 端口已断开，将在 onDisconnect 中清理
      }
    });
    // 同时通过 runtime.sendMessage 广播给非长连接的客户端（容错）
    try {
      chrome.runtime.sendMessage(msg).catch?.(() => {});
    } catch {
      // 没有接收方时忽略
    }
  }

  function broadcastError(message: string, code?: string): void {
    console.error("[Interview Assistant]", message, code ?? "");
    broadcast({ type: "ERROR", message, code });
  }

  // ─── 长连接监听 ─────────────────────────────────────────────
  chrome.runtime.onConnect.addListener((port) => {
    connections.set(port.name, port);
    // 新连接立即同步当前状态
    try {
      port.postMessage({ type: "STATE_UPDATE", state: sessionState });
    } catch {
      /* ignore */
    }
    port.onMessage.addListener((msg) => routeMessage(msg, port));
    port.onDisconnect.addListener(() => connections.delete(port.name));
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 仅对需要异步响应的消息类型返回 true
    if (msg?.type === "GET_STATE") {
      sendResponse({ state: sessionState });
      return false; // 同步响应，不需要返回 true
    }
    routeMessage(msg, null, sendResponse);
    // 对于异步处理的消息，返回 true 以保持 sendResponse 通道
    return ["START_INTERVIEW", "STOP_INTERVIEW", "REQUEST_SUGGESTION"].includes(msg?.type);
  });

  // ─── 消息路由 ───────────────────────────────────────────────
  function routeMessage(
    msg: { type: string; payload?: any; [key: string]: any },
    port: chrome.runtime.Port | null,
    sendResponse?: (res: any) => void,
  ): void {
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "GET_STATE":
        sendResponse?.({ state: sessionState });
        break;

      case "START_INTERVIEW":
        void handleStartInterview(msg.payload ?? msg, port);
        break;

      case "STOP_INTERVIEW":
        void handleStopInterview();
        break;

      case "REQUEST_SUGGESTION":
        void handleSuggestionRequest(msg.payload ?? msg);
        break;

      case "TRANSCRIPT":
        handleTranscript(msg.payload ?? msg);
        break;

      case "TRANSCRIPT_INTERIM":
        handleInterim(msg.payload ?? msg);
        break;

      case "UTTERANCE_END":
        handleUtteranceEnd();
        break;

      case "KEEP_ALIVE":
        // 仅需消息本身唤醒 SW
        break;

      case "TOKEN_EXPIRED":
        void handleTokenExpired();
        break;

      case "CONNECTION_STATE":
        // offscreen 上报连接状态，广播给 UI
        broadcast({ type: "CONNECTION_STATE", state: msg.state ?? msg.payload?.state });
        break;

      default:
        // 未知消息类型，忽略
        break;
    }
  }

  // ─── 转录处理 ───────────────────────────────────────────────
  function handleTranscript(payload: IncomingPayloads["TRANSCRIPT"]): void {
    const text = (payload?.text ?? "").trim();
    if (!text) return;

    const speaker = payload.speaker === "candidate" ? "candidate" : "interviewer";
    const isFinal = payload.isFinal !== false;

    if (isFinal) {
      const message: InterviewMessage = {
        id: genId(),
        role: speaker,
        content: text,
        timestamp: Date.now(),
        isFinal: true,
      };
      sessionState = {
        ...sessionState,
        messages: [...sessionState.messages, message],
      };
      broadcast({ type: "TRANSCRIPT", message });
      broadcastState();

      // 仅基于面试官话语检测问题
      if (speaker === "interviewer") {
        questionDetector?.processSegment(text);
      }
    }
  }

  function handleInterim(payload: IncomingPayloads["TRANSCRIPT_INTERIM"]): void {
    const text = (payload?.text ?? "").trim();
    if (!text) return;
    broadcast({ type: "TRANSCRIPT_INTERIM", text });
  }

  function handleUtteranceEnd(): void {
    questionDetector?.onUtteranceEnd();
  }

  function onQuestionDetected(question: string): void {
    pendingQuestion = question;
    broadcast({ type: "QUESTION_DETECTED", question });
    // 自动触发建议生成
    void handleSuggestionRequest({ question });
  }

  // ─── 面试生命周期 ───────────────────────────────────────────
  async function handleStartInterview(
    payload: IncomingPayloads["START_INTERVIEW"],
    port: chrome.runtime.Port | null,
  ): Promise<void> {
    if (sessionState.status === "recording") {
      broadcastError("Session already in progress", "ALREADY_RECORDING");
      return;
    }

    const company = payload?.company ?? "";
    const role = payload?.role ?? "";
    const resumeId = payload?.resumeId ?? null;

    try {
      // 获取目标标签页
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tabId = payload.tabId ?? activeTab?.id;

      if (!tabId) {
        broadcastError("No active tab found", "NO_TAB");
        port?.postMessage({ type: "ERROR", message: "No active tab found" });
        return;
      }

      // 重置会话状态为 recording
      updateState({
        status: "recording",
        sessionId: null,
        company,
        role,
        resumeId,
        startedAt: Date.now(),
        tabId,
        messages: [
          {
            id: genId(),
            role: "system",
            content: `Session started: ${company} · ${role}`,
            timestamp: Date.now(),
          },
        ],
        suggestions: [],
      });

      // 通知 content script 面试已开始
      notifyContentScript("SESSION_STARTED", tabId);

      // 初始化问题检测器
      questionDetector = new QuestionDetector(onQuestionDetected);

      // 1. 创建后端 session（失败时优雅降级）
      let sessionId: string | null = null;
      try {
        const session = await apiClient.createSession({
          company,
          role,
          resumeId: resumeId ?? undefined,
        });
        sessionId = session.id;
        updateState({ sessionId });
      } catch (err) {
        broadcastError(
          `Failed to create session (continuing without backend): ${stringifyError(err)}`,
          "SESSION_CREATE_FAILED",
        );
      }

      // 2. 获取 Deepgram token（失败时降级使用本地/Web Speech）
      let deepgramToken: string | null = null;
      let deepgramUrl: string | null = null;
      try {
        const tokenInfo = await apiClient.getDeepgramToken();
        deepgramToken = tokenInfo.token;
        deepgramUrl = tokenInfo.url;
      } catch (err) {
        broadcastError(
          `Failed to fetch Deepgram token (will fallback): ${stringifyError(err)}`,
          "DEEPGRAM_TOKEN_FAILED",
        );
      }

      // 3. 启动音频捕获 & offscreen
      try {
        await startAudioCapture(tabId, deepgramToken, deepgramUrl);
      } catch (err) {
        broadcastError(
          `Failed to start audio capture: ${stringifyError(err)}`,
          "AUDIO_CAPTURE_FAILED",
        );
        // 即便音频捕获失败，仍保留 recording 状态供用户重试或手动输入
      }

      // 4. 启动 keep-alive
      chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
    } catch (error) {
      broadcastError(
        `Failed to start interview: ${stringifyError(error)}`,
        "START_FAILED",
      );
      // 回滚状态
      updateState({ status: "idle" });
    }
  }

  async function handleStopInterview(): Promise<void> {
    if (sessionState.status === "idle") return;

    // 标记为分析中
    updateState({ status: "analyzing" });

    // 取消进行中的 suggestion
    suggestionAbort?.abort();
    suggestionAbort = null;

    // 重置问题检测器
    questionDetector?.reset();
    questionDetector = null;
    pendingQuestion = null;

    // 关闭 keep-alive
    chrome.alarms.clear("keepalive");

    // 通知 offscreen 停止捕获
    try {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    } catch {
      // offscreen 可能已关闭
    }

    // 关闭 offscreen document（可选，如保留可移除）
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      });
      if (contexts.length > 0) {
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    } catch {
      // ignore
    }

    // 调用后端分析
    if (sessionState.sessionId) {
      try {
        const result = await apiClient.analyzeSession(sessionState.sessionId);
        broadcast({ type: "ANALYSIS_RESULT", result });
      } catch (err) {
        broadcastError(
          `Failed to analyze session: ${stringifyError(err)}`,
          "ANALYZE_FAILED",
        );
      }
    }

    // 保存到历史（通过广播给 side panel 让其落盘）
    const historyEntry = {
      id: sessionState.sessionId ?? genId(),
      company: sessionState.company,
      role: sessionState.role,
      startedAt: sessionState.startedAt ?? Date.now(),
      endedAt: Date.now(),
      status: "completed" as const,
      questionsCount: sessionState.messages.filter(
        (m) => m.role === "interviewer",
      ).length,
      suggestionsCount: sessionState.suggestions.length,
    };
    broadcast({ type: "SESSION_HISTORY_ADD", entry: historyEntry });

    // 标记完成
    updateState({ status: "completed" });

    // 通知 content script 面试已结束
    notifyContentScript("SESSION_ENDED", sessionState.tabId ?? undefined);
  }

  // ─── 音频捕获 ───────────────────────────────────────────────
  async function startAudioCapture(
    tabId: number,
    deepgramToken: string | null,
    deepgramUrl: string | null,
  ): Promise<void> {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    await ensureOffscreenDocument();

    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId,
      deepgramToken,
      deepgramUrl,
    });
  }

  async function ensureOffscreenDocument(): Promise<void> {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    });

    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification:
          "Audio capture and processing for interview transcription",
      });
    }
  }

  // ─── AI 建议生成 ────────────────────────────────────────────
  async function handleSuggestionRequest(
    payload: IncomingPayloads["REQUEST_SUGGESTION"] & { question?: string },
  ): Promise<void> {
    const question =
      payload?.question?.trim() ||
      pendingQuestion ||
      latestInterviewerText() ||
      "";

    if (!question) {
      broadcast({
        type: "SUGGESTION_ERROR",
        error: "No question detected to generate suggestion for",
      });
      return;
    }

    const questionId = genId();
    broadcast({ type: "SUGGESTION_START", questionId });

    // 取消之前的建议请求
    suggestionAbort?.abort();
    suggestionAbort = new AbortController();
    const signal = suggestionAbort.signal;

    const context = (payload?.context ?? buildContext()).slice(0, 4000);
    const sessionId = sessionState.sessionId;

    if (!sessionId) {
      broadcast({
        type: "SUGGESTION_ERROR",
        error: "No active session — backend session not created",
      });
      return;
    }

    let aggregated = "";
    let finalSuggestion: Suggestion | null = null;

    try {
      const stream = apiClient.getAISuggestion(
        sessionId,
        {
          question,
          context,
          resumeId: sessionState.resumeId ?? undefined,
        },
        { signal },
      );

      for await (const chunk of stream) {
        if (signal.aborted) break;

        switch (chunk.type) {
          case "suggestion_start":
            // 已在外层广播过 SUGGESTION_START
            break;
          case "suggestion_chunk": {
            const piece = typeof chunk.data === "string"
              ? chunk.data
              : extractText(chunk.data);
            if (piece) {
              aggregated += piece;
              broadcast({ type: "SUGGESTION_CHUNK", chunk: piece });
            }
            break;
          }
          case "suggestion_end": {
            finalSuggestion = parseSuggestion(chunk.data, aggregated);
            break;
          }
          case "error": {
            const errMsg =
              typeof chunk.data === "string"
                ? chunk.data
                : stringifyError(chunk.data);
            broadcast({ type: "SUGGESTION_ERROR", error: errMsg });
            return;
          }
        }
      }

      if (!finalSuggestion) {
        finalSuggestion = parseSuggestion(null, aggregated);
      }

      // 保存到状态
      sessionState = {
        ...sessionState,
        suggestions: [...sessionState.suggestions, finalSuggestion],
      };
      broadcastState();
      broadcast({ type: "SUGGESTION_END", suggestion: finalSuggestion });

      pendingQuestion = null;
    } catch (err) {
      if ((err as any)?.name === "AbortError") return;
      broadcast({
        type: "SUGGESTION_ERROR",
        error: stringifyError(err),
      });
    } finally {
      if (suggestionAbort?.signal === signal) {
        suggestionAbort = null;
      }
    }
  }

  // ─── Token 刷新 ─────────────────────────────────────────────
  async function handleTokenExpired(): Promise<void> {
    try {
      const tokenInfo = await apiClient.getDeepgramToken();
      // 将新 token 转发给 offscreen document
      await chrome.runtime.sendMessage({
        type: "NEW_TOKEN",
        token: tokenInfo.token,
      });
    } catch (err) {
      broadcastError(
        `Failed to refresh Deepgram token: ${stringifyError(err)}`,
        "TOKEN_REFRESH_FAILED",
      );
    }
  }

  // ─── Content Script 通知 ────────────────────────────────────
  async function notifyContentScript(type: "SESSION_STARTED" | "SESSION_ENDED", tabId?: number): Promise<void> {
    const message = { type };
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
      } catch {
        // content script 可能未加载
      }
      return;
    }
    // 没有指定 tabId 时，向所有匹配的面试平台标签页广播
    try {
      const tabs = await chrome.tabs.query({
        url: [
          "https://meet.google.com/*",
          "https://zoom.us/*",
          "https://teams.microsoft.com/*",
          "https://teams.live.com/*",
        ],
      });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      }
    } catch {
      // tabs.query 可能失败
    }
  }

  // ─── 上下文与解析辅助 ──────────────────────────────────────
  function latestInterviewerText(): string {
    for (let i = sessionState.messages.length - 1; i >= 0; i--) {
      const m = sessionState.messages[i];
      if (m.role === "interviewer") return m.content;
    }
    return "";
  }

  function buildContext(): string {
    // 取最近 8 条对话作为上下文
    const recent = sessionState.messages.slice(-8);
    const parts = recent.map(
      (m) => `[${m.role}] ${m.content}`,
    );
    parts.unshift(
      `Company: ${sessionState.company} | Role: ${sessionState.role}`,
    );
    return parts.join("\n");
  }

  function extractText(data: unknown): string {
    if (data == null) return "";
    if (typeof data === "string") return data;
    if (typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.content === "string") return obj.content;
      if (typeof obj.delta === "string") return obj.delta;
    }
    return "";
  }

  function parseSuggestion(data: unknown, aggregated: string): Suggestion {
    const base: Suggestion = {
      id: genId(),
      questionType: "general",
      keyPoints: [],
      timestamp: Date.now(),
    };

    if (data && typeof data === "object") {
      const obj = data as Record<string, any>;
      return {
        ...base,
        questionType: obj.questionType ?? base.questionType,
        keyPoints: Array.isArray(obj.keyPoints)
          ? obj.keyPoints
          : aggregated
            ? splitToPoints(aggregated)
            : [],
        resumeReference: obj.resumeReference,
        sampleOpening: obj.sampleOpening ?? aggregated.slice(0, 200),
      };
    }

    return {
      ...base,
      keyPoints: aggregated ? splitToPoints(aggregated) : [],
      sampleOpening: aggregated.slice(0, 200),
    };
  }

  function splitToPoints(text: string): string[] {
    return text
      .split(/\n+|(?:^|\s)[-•*]\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 6);
  }

  function stringifyError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
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

  console.log("[Interview Assistant] Service Worker initialized");
});
