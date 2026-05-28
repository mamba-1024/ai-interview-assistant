/**
 * Offscreen Document — 持久音频处理
 *
 * 职责:
 * - 兑换 tabCapture streamId 为 MediaStream
 * - 同时捕获麦克风
 * - AudioWorklet 重采样 (48kHz → 16kHz)
 * - 通过 WebSocket 流式传输到 Deepgram STT
 * - 指数退避重连 / 安全 token 管理 / 缓冲区管理
 */

// ─── 类型定义 ─────────────────────────────────────────────────
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

interface ReconnectConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitterFactor: number;
}

interface BufferedChunk {
  buffer: ArrayBuffer;
  timestamp: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  jitterFactor: 0.3,
};

// 缓冲区最多保留 5 秒音频；按 16kHz / int16 / 双声道 ≈ 320KB
const MAX_BUFFER_DURATION_MS = 5000;
const KEEP_ALIVE_INTERVAL_MS = 10000;

// ─── 模块状态 ─────────────────────────────────────────────────
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let deepgramWs: WebSocket | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

let deepgramToken: string | null = null;
let deepgramBaseUrl: string = "wss://api.deepgram.com/v1/listen";
let connectionState: ConnectionState = "disconnected";
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTokenRefresh = false;
let isCapturing = false;
let intentionalClose = false;

const audioBuffer: BufferedChunk[] = [];

// ─── 消息监听 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "START_CAPTURE") {
    void startCapture(msg.streamId, msg.deepgramToken, msg.deepgramUrl);
  } else if (msg.type === "STOP_CAPTURE") {
    stopCapture();
  } else if (msg.type === "NEW_TOKEN") {
    handleNewToken(msg.token);
  }
});

// 页面卸载时清理资源
self.addEventListener("beforeunload", () => {
  stopCapture();
});

// ─── 状态上报 ─────────────────────────────────────────────────
function setConnectionState(state: ConnectionState) {
  if (connectionState === state) return;
  connectionState = state;
  safeSendMessage({ type: "CONNECTION_STATE", state });
}

function safeSendMessage(message: unknown) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      /* Service Worker 可能已休眠，忽略 */
    });
  } catch {
    /* runtime 不可用 */
  }
}

function reportError(message: string, code: string) {
  console.error(`[Offscreen] ${code}: ${message}`);
  safeSendMessage({ type: "ERROR", message, code });
}

// ─── 启动音频捕获 ─────────────────────────────────────────────
async function startCapture(streamId: string, token: string, customDeepgramUrl?: string) {
  if (isCapturing) {
    console.warn("[Offscreen] Capture already running, ignoring START_CAPTURE");
    return;
  }
  if (!token) {
    reportError("Missing deepgramToken in START_CAPTURE", "NO_TOKEN");
    return;
  }

  isCapturing = true;
  intentionalClose = false;
  deepgramToken = token;
  if (customDeepgramUrl) deepgramBaseUrl = customDeepgramUrl;
  reconnectAttempts = 0;
  audioBuffer.length = 0;

  try {
    // ① 兑换标签页音频流
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      } as any,
    });

    // ② 捕获麦克风
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // ③ 创建 AudioContext + AudioWorklet
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(
      chrome.runtime.getURL("audio-processor.js"),
    );

    workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: {
        targetSampleRate: 16000,
        sourceSampleRate: audioContext.sampleRate,
      },
    });

    // ④ 构建立体声音频图（左=标签音频, 右=麦克风）
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const micSource = audioContext.createMediaStreamSource(micStream);
    const merger = audioContext.createChannelMerger(2);

    tabSource.connect(merger, 0, 0);
    micSource.connect(merger, 0, 1);
    merger.connect(workletNode);

    // 连接到静音目标（保持音频图活跃）
    const silentDest = audioContext.createMediaStreamDestination();
    workletNode.connect(silentDest);

    // ⑤ 接收 PCM 数据
    workletNode.port.onmessage = (event) => {
      if (event.data.type === "pcm-data") {
        sendToDeepgram(event.data.buffer);
      }
    };

    // ⑥ 连接 Deepgram
    connectDeepgram();

    // ⑦ 保活心跳
    keepAliveInterval = setInterval(() => {
      if (deepgramWs?.readyState === WebSocket.OPEN) {
        deepgramWs.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEP_ALIVE_INTERVAL_MS);

    console.log("[Offscreen] Audio capture started");
  } catch (error) {
    isCapturing = false;
    const msg = error instanceof Error ? error.message : String(error);
    reportError(`Failed to start capture: ${msg}`, "CAPTURE_INIT_FAILED");
    cleanupResources();
    setConnectionState("failed");
  }
}

// ─── Deepgram WebSocket ──────────────────────────────────────
function connectDeepgram() {
  if (!deepgramToken) {
    reportError("No Deepgram token available", "NO_TOKEN");
    setConnectionState("failed");
    return;
  }

  setConnectionState(
    reconnectAttempts > 0 ? "reconnecting" : "connecting",
  );

  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "2",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    diarize: "true",
    smart_format: "true",
    punctuate: "true",
    token: deepgramToken,
  });

  try {
    deepgramWs = new WebSocket(
      `${deepgramBaseUrl}?${params.toString()}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reportError(`WebSocket construction failed: ${msg}`, "WS_CONSTRUCT_FAILED");
    scheduleReconnect();
    return;
  }

  deepgramWs.onopen = () => {
    console.log("[Deepgram] Connected");
    reconnectAttempts = 0;
    setConnectionState("connected");
    flushBufferedAudio();
  };

  deepgramWs.onmessage = (event) => {
    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "Results") {
      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const speaker = alt.words?.[0]?.speaker;

      if (data.is_final && data.speech_final) {
        safeSendMessage({
          type: "TRANSCRIPT",
          payload: {
            text: alt.transcript,
            isFinal: true,
            speaker,
            timestamp: data.start,
          },
        });
      } else {
        safeSendMessage({
          type: "TRANSCRIPT_INTERIM",
          payload: { text: alt.transcript },
        });
      }
    } else if (data.type === "UtteranceEnd") {
      safeSendMessage({ type: "UTTERANCE_END" });
    }
  };

  deepgramWs.onerror = (err) => {
    console.error("[Deepgram] WebSocket error:", err);
    // onerror 后通常紧跟 onclose，由 onclose 决定重连策略
  };

  deepgramWs.onclose = (event) => {
    console.log(
      `[Deepgram] Closed: code=${event.code} reason=${event.reason}`,
    );

    if (intentionalClose || !isCapturing) {
      setConnectionState("disconnected");
      return;
    }

    const category = classifyCloseEvent(event);

    if (category === "auth") {
      reportError(
        `Authentication failed (code ${event.code})`,
        "AUTH_ERROR",
      );
      requestNewToken();
      return;
    }

    if (category === "server") {
      reportError(
        `Server error (code ${event.code}): ${event.reason}`,
        "SERVER_ERROR",
      );
    } else {
      reportError(
        `Network error (code ${event.code}): ${event.reason}`,
        "NETWORK_ERROR",
      );
    }

    scheduleReconnect();
  };
}

// 分类 WebSocket 关闭事件：网络错误 / 认证错误 / 服务器错误
function classifyCloseEvent(
  event: CloseEvent,
): "network" | "auth" | "server" {
  const code = event.code;
  // 4001/4008 是 Deepgram 自定义认证相关码；1008 (policy violation) 也常见
  if (code === 4001 || code === 4008 || code === 1008 || code === 401) {
    return "auth";
  }
  // 5xx 范畴 / 1011 (server error) / 1013 (try again later)
  if (code === 1011 || code === 1013) {
    return "server";
  }
  return "network";
}

// ─── 重连逻辑 ────────────────────────────────────────────────
function scheduleReconnect(config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG) {
  if (!isCapturing || intentionalClose) return;

  if (reconnectAttempts >= config.maxRetries) {
    reportError(
      `Max reconnect attempts (${config.maxRetries}) reached`,
      "RECONNECT_FAILED",
    );
    setConnectionState("failed");
    return;
  }

  const exp = Math.min(
    config.baseDelay * Math.pow(2, reconnectAttempts),
    config.maxDelay,
  );
  const jitter = exp * config.jitterFactor * (Math.random() * 2 - 1);
  const delay = Math.max(0, Math.round(exp + jitter));

  reconnectAttempts++;
  setConnectionState("reconnecting");
  console.log(
    `[Offscreen] Reconnect attempt ${reconnectAttempts}/${config.maxRetries} in ${delay}ms`,
  );

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isCapturing && !intentionalClose) connectDeepgram();
  }, delay);
}

// ─── Token 管理 ──────────────────────────────────────────────
function requestNewToken() {
  if (pendingTokenRefresh) return;
  pendingTokenRefresh = true;
  setConnectionState("reconnecting");
  safeSendMessage({ type: "TOKEN_EXPIRED" });
}

function handleNewToken(token: string) {
  if (!token) {
    reportError("Received empty NEW_TOKEN", "NO_TOKEN");
    return;
  }
  deepgramToken = token;
  pendingTokenRefresh = false;
  reconnectAttempts = 0;
  if (isCapturing && !intentionalClose) {
    connectDeepgram();
  }
}

// ─── 音频发送 / 缓冲 ─────────────────────────────────────────
function sendToDeepgram(pcmBuffer: ArrayBuffer) {
  if (deepgramWs?.readyState === WebSocket.OPEN) {
    deepgramWs.send(pcmBuffer);
    return;
  }
  // 连接未就绪 → 缓冲
  bufferAudio(pcmBuffer);
}

function bufferAudio(buffer: ArrayBuffer) {
  const now = Date.now();
  audioBuffer.push({ buffer, timestamp: now });
  // 丢弃超过 5 秒的旧数据
  const cutoff = now - MAX_BUFFER_DURATION_MS;
  while (audioBuffer.length > 0 && audioBuffer[0].timestamp < cutoff) {
    audioBuffer.shift();
  }
}

function flushBufferedAudio() {
  if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) return;
  if (audioBuffer.length === 0) return;
  console.log(`[Offscreen] Flushing ${audioBuffer.length} buffered chunks`);
  while (audioBuffer.length > 0) {
    const chunk = audioBuffer.shift()!;
    try {
      deepgramWs.send(chunk.buffer);
    } catch (err) {
      console.error("[Offscreen] Failed to flush buffered chunk:", err);
      // 重新放回队首并退出
      audioBuffer.unshift(chunk);
      return;
    }
  }
}

// ─── 停止捕获 ─────────────────────────────────────────────────
const STOP_GRACE_PERIOD_MS = 3000; // 等待 Deepgram flush 最终结果

function stopCapture() {
  if (!isCapturing) {
    cleanupResources();
    return;
  }
  intentionalClose = true;
  isCapturing = false;

  // 停止心跳
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // 优雅关闭 WebSocket：发送 CloseStream 让 Deepgram flush 最终结果
  if (deepgramWs) {
    const ws = deepgramWs;
    let settled = false;

    const finalize = () => {
      if (settled) return;
      settled = true;
      cleanupResources();
      setConnectionState("disconnected");
      console.log("[Offscreen] Audio capture stopped");
    };

    // 监听 onclose 以等待 Deepgram 完成 flush
    const origOnClose = ws.onclose;
    ws.onclose = (event) => {
      if (typeof origOnClose === "function") {
        (origOnClose as (ev: CloseEvent) => void).call(ws, event);
      }
      finalize();
    };

    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
    } catch (err) {
      console.warn("[Offscreen] Error sending CloseStream:", err);
      finalize();
      return;
    }

    // 超时兜底：如果 Deepgram 未在 grace period 内关闭，强制清理
    setTimeout(() => {
      if (!settled) {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "Client stopping (timeout)");
          }
        } catch { /* noop */ }
        finalize();
      }
    }, STOP_GRACE_PERIOD_MS);
  } else {
    cleanupResources();
    setConnectionState("disconnected");
    console.log("[Offscreen] Audio capture stopped (no WebSocket)");
  }
}

function cleanupResources() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    workletNode?.port.close();
  } catch {
    /* noop */
  }
  workletNode?.disconnect();

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {
      /* noop */
    });
  }

  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());

  audioContext = null;
  workletNode = null;
  deepgramWs = null;
  tabStream = null;
  micStream = null;
  audioBuffer.length = 0;
  reconnectAttempts = 0;
  pendingTokenRefresh = false;
}
