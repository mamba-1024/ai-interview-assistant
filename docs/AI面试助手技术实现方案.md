## AI 面试助手 Chrome 插件 — 技术实现方案

---

### 一、系统架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome Extension (WXT + React)            │
│                                                                  │
│  ┌──────────┐   ┌────────────────┐   ┌──────────────────────┐   │
│  │  Popup   │   │  Side Panel    │   │  Content Script      │   │
│  │ (快捷控制)│   │  (主UI, React) │   │  (最小注入,状态指示)  │   │
│  └────┬─────┘   └───────┬────────┘   └──────────┬───────────┘   │
│       │                 │                        │               │
│  ┌────┴─────────────────┴────────────────────────┴────────────┐  │
│  │              Service Worker (事件路由 + 编排)                │  │
│  │              - 消息分发                                     │  │
│  │              - 认证管理                                     │  │
│  │              - Keep-alive 管理                              │  │
│  └──────────────────────────┬─────────────────────────────────┘  │
│                             │                                    │
│  ┌──────────────────────────┴─────────────────────────────────┐  │
│  │         Offscreen Document (持久音频处理)                    │  │
│  │  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐   │  │
│  │  │ tabCapture │  │ getUserMedia │  │  AudioWorklet     │   │  │
│  │  │ (标签音频) │  │ (麦克风)     │  │  (48k→16k,PCM)   │   │  │
│  │  └─────┬──────┘  └──────┬───────┘  └─────────┬─────────┘   │  │
│  │        └────────┬───────┘                     │             │  │
│  │                 └──────────┬──────────────────┘             │  │
│  │                    WebSocket (Deepgram STT)                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                  │
                          HTTPS / WSS
                                  │
┌─────────────────────────────────┴───────────────────────────────┐
│                      Backend (Vercel / Cloudflare Workers)        │
│                                                                  │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ Auth API │  │ Resume API│  │ Session API│  │ AI Proxy    │  │
│  │ (OAuth)  │  │ (解析)    │  │ (面试管理) │  │ (LLM代理)  │  │
│  └────┬─────┘  └─────┬─────┘  └─────┬──────┘  └──────┬──────┘  │
│       │              │              │                 │         │
│  ┌────┴──────────────┴──────────────┴─────────────────┴──────┐  │
│  │                 PostgreSQL (Supabase/Neon)                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌────────────┐                                │
│  │ Redis(Upstash)│  │ S3/R2(简历)│                                │
│  └──────────────┘  └────────────┘                                │
└──────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
              ┌─────┴─────┐              ┌──────┴──────┐
              │ Deepgram  │              │ OpenAI /    │
              │ Nova-3    │              │ Claude      │
              │ (STT)     │              │ (LLM)       │
              └───────────┘              └─────────────┘
```

---

### 二、推荐技术栈

| 层级 | 技术选型 | 选型理由 |
|------|---------|---------|
| 插件框架 | WXT + React 19 + TypeScript | 2025年最佳开发体验，Vite驱动，自动生成manifest |
| 状态管理 | Zustand + chrome.storage | 轻量级，支持跨上下文通信（Side Panel/Service Worker/Content Script） |
| 样式方案 | Tailwind CSS 4 | 原子化CSS，包体积小，开发速度快 |
| 音频捕获 | tabCapture + Offscreen Document + AudioWorklet | Manifest V3下最可靠的方案，延迟最低 |
| 语音转文字 | Deepgram Nova-3 (主) + Web Speech API (备) | 延迟<300ms，支持实时说话人分离，$0.46/小时 |
| 大语言模型 | GPT-4o-mini (主) + Gemini Nano (辅) | 混合策略：复杂推理走云端，轻量分类走本地（免费） |
| 后端API | Node.js + Hono on Vercel/Cloudflare Workers | 快速、边缘计算就绪、TypeScript原生 |
| 数据库 | PostgreSQL (Supabase 或 Neon) | Serverless Postgres，内置Auth，免费额度慷慨 |
| 缓存/限流 | Upstash Redis | Serverless Redis，支持限流和令牌桶 |
| 文件存储 | Cloudflare R2 或 AWS S3 | 存储简历PDF |
| 认证 | OAuth2 PKCE (chrome.identity) | 标准安全，避免chrome.identity.getAuthToken的限制 |
| 简历解析 | pdf-parse + LLM结构化输出 | 可靠的PDF文本提取 + AI结构化 |
| CI/CD | GitHub Actions + chrome-webstore-upload | 自动构建、测试、发布 |
| 监控 | Sentry + PostHog | 错误追踪 + 产品分析 |

---

### 三、Chrome Extension 核心架构

#### 3.1 Manifest V3 配置

使用 WXT 框架，通过 `wxt.config.ts` 自动管理 manifest：

```typescript
// wxt.config.ts
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AI Interview Assistant",
    version: "1.0.0",
    permissions: [
      "sidePanel",    // 侧边栏面板
      "activeTab",    // 当前标签页
      "storage",      // 存储
      "tabs",         // 标签页管理
      "identity",     // OAuth认证
      "alarms",       // 定时器（keep-alive）
      "offscreen",    // 离屏文档（音频处理）
      "tabCapture",   // 标签页音频捕获
    ],
    host_permissions: [
      "https://api.yourapp.com/*",
      "https://meet.google.com/*",
      "https://zoom.us/*",
      "https://teams.microsoft.com/*",
    ],
    side_panel: {
      default_path: "sidepanel.html",
    },
    commands: {
      "toggle-panel": {
        suggested_key: { default: "Ctrl+Shift+I" },
        description: "Toggle interview assistant",
      },
    },
  },
});
```

#### 3.2 项目结构

```
ai-interview-assistant/
├── wxt.config.ts
├── package.json
├── tsconfig.json
├── entrypoints/
│   ├── background/
│   │   └── index.ts          # Service Worker (事件路由)
│   ├── sidepanel/
│   │   ├── index.html         # 侧边栏入口
│   │   ├── main.tsx           # React 挂载
│   │   └── App.tsx            # 主界面
│   ├── popup/
│   │   ├── index.html         # 弹窗（快捷控制）
│   │   └── main.tsx
│   ├── content/
│   │   └── index.ts           # 内容脚本（最小注入）
│   └── offscreen/
│       ├── index.html         # 离屏文档
│       ├── audio-capture.ts   # 音频捕获逻辑
│       └── audio-processor.ts # AudioWorklet 处理器
├── components/
│   ├── InterviewChat.tsx      # 对话/转录界面
│   ├── ResumePanel.tsx        # 简历管理
│   ├── RecordingControls.tsx  # 录制控制
│   └── SuggestionCard.tsx     # AI建议卡片
├── store/
│   └── extensionStore.ts      # Zustand 全局状态
├── hooks/
│   ├── useServiceWorker.ts    # SW通信Hook
│   └── useRecording.ts        # 录制状态Hook
├── lib/
│   ├── api.ts                 # 后端API客户端
│   ├── auth.ts                # OAuth流程
│   ├── question-detector.ts   # 问题检测器
│   └── context-manager.ts     # 上下文管理
└── assets/
    └── icons/
```

#### 3.3 跨上下文通信架构

Chrome 插件有四个独立的 JavaScript 执行上下文，它们之间的通信是架构的核心难点：

```
┌──────────────┐  chrome.runtime   ┌──────────────────┐
│  Side Panel  │ <===============> │  Service Worker   │
│  (React UI)  │   long-lived      │  (Background)     │
│              │   Port 连接        │                   │
└──────────────┘                   └────────┬───────────┘
                                            │
        chrome.runtime.sendMessage          │ chrome.tabs.sendMessage
                                            │
┌──────────────┐  window.postMessage ┌──────┴───────────┐
│Content Script│ <=================> │   Web Page        │
│ (状态指示器)  │                     │ (Meet/Zoom/Teams) │
└──────────────┘                     └──────────────────┘
```

**消息路由中心（Service Worker）：**

```typescript
// entrypoints/background/index.ts

// 长连接管理
const connections = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  connections.set(port.name, port);
  port.onMessage.addListener((msg) => routeMessage(msg, port));
  port.onDisconnect.addListener(() => connections.delete(port.name));
});

// 单次消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  routeMessage(msg, null, sender, sendResponse);
  return true; // 保持通道等待异步响应
});

async function routeMessage(msg, port, sender?, sendResponse?) {
  switch (msg.type) {
    case "GET_STATE":
      const state = appStore.getState();
      sendResponse?.({ user: state.user, session: state.currentSession });
      break;

    case "START_INTERVIEW":
      appStore.getState().startSession(msg.payload);
      await startAudioCapture(msg.payload.tabId);
      broadcast({ type: "SESSION_UPDATED", payload: appStore.getState().currentSession });
      break;

    case "TRANSCRIPT":
      await processTranscript(msg.payload);
      break;

    case "REQUEST_SUGGESTION":
      const suggestion = await getAISuggestion(msg.payload);
      port?.postMessage({ type: "AI_SUGGESTION", payload: suggestion });
      break;
  }
}

function broadcast(msg) {
  connections.forEach((port) => {
    try { port.postMessage(msg); } catch (e) { /* 已断开 */ }
  });
}
```

#### 3.4 Service Worker 生命周期管理

Manifest V3 的 Service Worker 有 30 秒空闲超时，面试过程中绝不能中断。解决方案：

```typescript
// 面试开始时创建 keep-alive 定时器
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 }); // 每24秒

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    const state = appStore.getState();
    if (state.currentSession?.state !== "recording") {
      chrome.alarms.clear("keepalive"); // 面试结束后停止
    }
  }
});

// Service Worker 重启后恢复状态
async function onServiceWorkerStart() {
  await initializeStore(); // 从 chrome.storage.local 恢复
  const state = appStore.getState();
  if (state.currentSession?.state === "recording") {
    chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
    // 重新建立 WebSocket 连接
  }
}
```

---

### 四、音频捕获与处理（核心技术难点）

#### 4.1 整体流程

```
Service Worker                Offscreen Document            AudioWorklet Thread
     │                              │                              │
     │── getMediaStreamId() ──>     │                              │
     │    returns streamId          │                              │
     │                              │                              │
     │── sendMessage(streamId) ──>  │                              │
     │                              │── getUserMedia(streamId) ──> │
     │                              │    returns MediaStream        │
     │                              │                              │
     │                              │── createAudioContext() ──>   │
     │                              │── addModule(processor) ──>   │
     │                              │                              │
     │                              │   每个128帧音频块:           │
     │                              │   48kHz Float32 → 16kHz Int16│
     │                              │<── port.postMessage(pcm) ──  │
     │                              │                              │
     │                              │── ws.send(pcm) ──> Deepgram  │
```

#### 4.2 Service Worker 端：获取 Stream ID

```typescript
// entrypoints/background/audio.ts

async function startAudioCapture(tabId: number) {
  // 1. 获取标签页音频流ID（Service Worker中唯一可用的tabCapture方法）
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId,
  });

  // 2. 确保离屏文档存在
  await ensureOffscreenDocument();

  // 3. 将 streamId 传递给离屏文档
  await chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    streamId,
    targetTabId: tabId,
  });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Audio capture and processing for interview transcription",
    });
  }
}
```

#### 4.3 离屏文档：音频捕获和处理

```typescript
// entrypoints/offscreen/audio-capture.ts

let audioContext: AudioContext;
let workletNode: AudioWorkletNode;
let deepgramWs: WebSocket;
let tabStream: MediaStream;
let micStream: MediaStream;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "START_CAPTURE") {
    await startCapture(msg.streamId);
  }
  if (msg.type === "STOP_CAPTURE") {
    stopCapture();
  }
});

async function startCapture(streamId: string) {
  // ① 兑换标签页音频流
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as any,
  });

  // ② 同时捕获麦克风（用于候选人语音）
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // ③ 创建 AudioContext 和 AudioWorklet
  audioContext = new AudioContext(); // 默认 48kHz
  await audioContext.audioWorklet.addModule("audio-processor.js");

  workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    processorOptions: {
      targetSampleRate: 16000,
      sourceSampleRate: audioContext.sampleRate, // 通常 48000
    },
  });

  // ④ 构建音频图
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  const micSource = audioContext.createMediaStreamSource(micStream);

  // 立体声分离：左声道=标签音频(面试官)，右声道=麦克风(候选人)
  // 这样下游可以做说话人分离
  const merger = audioContext.createChannelMerger(2);
  tabSource.connect(merger, 0, 0);  // 标签音频 → 左声道
  micSource.connect(merger, 0, 1);  // 麦克风 → 右声道

  merger.connect(workletNode);

  // 连接到静音目标（保持音频图活跃，不播放）
  const silentDest = audioContext.createMediaStreamDestination();
  workletNode.connect(silentDest);

  // ⑤ 接收 AudioWorklet 处理后的 PCM 数据
  workletNode.port.onmessage = (event) => {
    if (event.data.type === "pcm-data") {
      sendToDeepgram(event.data.buffer);
    }
  };

  // ⑥ 建立 Deepgram WebSocket 连接
  connectDeepgram();
}

function stopCapture() {
  deepgramWs?.close();
  workletNode?.disconnect();
  audioContext?.close();
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
}
```

#### 4.4 AudioWorklet 处理器（重采样 + 格式转换）

这是整个音频管线中最关键的组件，运行在独立的音频线程中：

```javascript
// entrypoints/offscreen/audio-processor.js

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sourceSampleRate = options.processorOptions.sourceSampleRate; // 48000
    this.targetSampleRate = options.processorOptions.targetSampleRate; // 16000
    this.resampleRatio = this.sourceSampleRate / this.targetSampleRate; // 3.0

    // 输出缓冲区
    this.bufferSize = 4096; // 每次发送的采样数（~256ms @16kHz）
    this.pcmBuffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
    this.resamplePhase = 0.0;
  }

  process(inputList, outputList) {
    const input = inputList[0];
    if (!input || input.length === 0) return true;

    const inputChannel = input[0]; // 使用第一个声道
    if (!inputChannel || inputChannel.length === 0) return true;

    // 线性插值重采样：48kHz → 16kHz
    for (let i = 0; i < inputChannel.length; i++) {
      while (this.resamplePhase < 1.0) {
        const srcIndex = i + this.resamplePhase;
        const floor = Math.floor(srcIndex);
        const ceil = Math.min(floor + 1, inputChannel.length - 1);
        const frac = srcIndex - floor;

        // 线性插值
        const sample = inputChannel[floor] * (1 - frac) + inputChannel[ceil] * frac;

        // Float32 (-1.0~1.0) → Int16 (-32768~32767)
        const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        this.pcmBuffer[this.bufferIndex++] = int16;

        if (this.bufferIndex >= this.bufferSize) {
          this.flushBuffer();
        }

        this.resamplePhase += 1.0 / this.resampleRatio;
      }
      this.resamplePhase -= 1.0;
    }

    return true; // 保持处理器活跃
  }

  flushBuffer() {
    const buffer = this.pcmBuffer.buffer.slice(0, this.bufferIndex * 2);
    // 零拷贝传输到主线程
    this.port.postMessage(
      { type: "pcm-data", buffer, encoding: "linear16", sampleRate: this.targetSampleRate },
      [buffer]
    );
    this.pcmBuffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
```

---

### 五、实时语音转文字（Deepgram Nova-3）

#### 5.1 STT 方案对比

| 特性 | Deepgram Nova-3 | AssemblyAI | Google Cloud STT | Web Speech API |
|------|----------------|------------|------------------|----------------|
| 实时延迟 | <300ms | ~500ms | ~400ms | 100-500ms |
| 准确率(WER) | ~4-5% | ~5-6% | ~5-7% | ~10-15% |
| 流式支持 | WebSocket | WebSocket | gRPC | 内置 |
| 实时说话人分离 | 支持 | 不支持 | 有限 | 不支持 |
| 价格 | $0.46/小时 | $0.15/小时(基础) | $1.56/小时 | 免费 |
| 最大会话时长 | 无限制 | 无限制 | 5分钟 | ~60秒 |

**结论：** Deepgram Nova-3 是最佳选择——延迟最低、准确率最高、唯一支持实时说话人分离。Web Speech API 作为免费备用方案。

#### 5.2 Deepgram WebSocket 连接

```typescript
// entrypoints/offscreen/deepgram-client.ts

class DeepgramConnection {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private maxRetries = 5;
  private audioBuffer: ArrayBuffer[] = []; // 断线重连时回放

  connect() {
    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "2",             // 立体声（面试官+候选人）
      interim_results: "true",   // 中间结果
      endpointing: "300",        // 300ms 静音 = 语句结束
      utterance_end_ms: "1000",  // 1秒静音 = 说话轮次结束
      diarize: "true",           // 说话人分离
      smart_format: "true",      // 智能格式化（数字、日期等）
      punctuate: "true",
    });

    this.ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params}`,
      ["token", DEEPGRAM_API_KEY] // 浏览器WebSocket不能设header，用子协议传key
    );

    this.ws.onopen = () => {
      this.retryCount = 0;
      // 回放断线期间缓存的音频
      while (this.audioBuffer.length > 0) {
        this.ws!.send(this.audioBuffer.shift()!);
      }
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = (event) => {
      if (event.code !== 1000) {
        this.reconnect(); // 非正常关闭，自动重连
      }
    };
  }

  private handleMessage(data: any) {
    if (data.type === "Results") {
      const alt = data.channel.alternatives[0];
      const transcript = alt.transcript;

      if (!transcript) return;

      if (data.is_final && data.speech_final) {
        // 最终结果：锁定文本，不会改变
        const speaker = alt.words?.[0]?.speaker; // 说话人编号 (0, 1, 2...)
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT",
          text: transcript,
          isFinal: true,
          speaker,
          timestamp: data.start,
        });
      } else {
        // 中间结果：显示但不锁定
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_INTERIM",
          text: transcript,
        });
      }
    }

    if (data.type === "UtteranceEnd") {
      // 一个完整的说话轮次结束 → 触发问题检测
      chrome.runtime.sendMessage({ type: "UTTERANCE_END" });
    }
  }

  sendAudio(pcmBuffer: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmBuffer);
      // 保留最近5秒的音频用于断线回放
      this.audioBuffer.push(pcmBuffer);
      if (this.audioBuffer.length > 20) this.audioBuffer.shift();
    } else {
      this.audioBuffer.push(pcmBuffer); // 断线时缓存
    }
  }

  private reconnect() {
    if (this.retryCount >= this.maxRetries) return;
    // 指数退避 + 随机抖动
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000) + Math.random() * 1000;
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }

  // 保活：每10秒发送心跳
  startKeepAlive() {
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 10000);
  }

  close() {
    this.ws?.send(JSON.stringify({ type: "CloseStream" }));
    // 服务端发送最终结果后关闭连接
  }
}
```

#### 5.3 说话人角色识别

Deepgram 的流式说话人分离返回整数编号（0, 1），需要映射为"面试官"和"候选人"：

```typescript
function assignSpeakerRoles(segments: TranscriptSegment[]) {
  const stats: Record<number, { words: number; firstSeen: number }> = {};

  segments.forEach((seg) => {
    if (!stats[seg.speaker]) {
      stats[seg.speaker] = { words: 0, firstSeen: seg.timestamp };
    }
    stats[seg.speaker].words += seg.text.split(" ").length;
  });

  // 启发式：先说话的通常是面试官
  const sorted = Object.entries(stats).sort((a, b) => a[1].firstSeen - b[1].firstSeen);
  const interviewerSpeaker = sorted[0][0];

  return segments.map((seg) => ({
    ...seg,
    role: seg.speaker === interviewerSpeaker ? "interviewer" : "candidate",
  }));
}
```

---

### 六、LLM 智能面试辅助

#### 6.1 问题检测器

结合多种信号判断面试官是否提完了问题：

```typescript
class QuestionDetector {
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptBuffer = "";
  private readonly SILENCE_THRESHOLD = 1500; // 1.5秒静音 = 问题结束
  private readonly QUESTION_PATTERNS = [
    /\?$/,
    /^(can you|tell me|how do|what is|describe|explain|walk me through)/i,
    /(your experience|your approach|how would|how did|what was)/i,
  ];

  onQuestionDetected: (question: string) => void;

  // 收到最终转录文本时调用
  processSegment(text: string) {
    this.transcriptBuffer += " " + text;

    // 重置静音计时器
    if (this.silenceTimer) clearTimeout(this.silenceTimer);

    this.silenceTimer = setTimeout(() => {
      this.evaluate();
    }, this.SILENCE_THRESHOLD);
  }

  // Deepgram UtteranceEnd 事件时调用
  onUtteranceEnd() {
    this.evaluate();
  }

  private evaluate() {
    const question = this.transcriptBuffer.trim();
    if (question.split(" ").length < 5) {
      this.transcriptBuffer = "";
      return; // 太短，可能是语气词
    }

    const isQuestion = this.QUESTION_PATTERNS.some((p) => p.test(question));
    if (isQuestion) {
      this.onQuestionDetected(question);
    }
    this.transcriptBuffer = "";
  }
}
```

#### 6.2 上下文管理器（Token 预算控制）

```typescript
class ContextManager {
  private resume: string;          // ~500 tokens（压缩后）
  private jobDescription: string;  // ~300 tokens（关键要求）
  private qaHistory: QAPair[] = [];
  private readonly maxHistoryTokens = 1500;

  constructor(resume: string, jd: string) {
    this.resume = this.compressResume(resume);    // 预处理：提取关键事实
    this.jobDescription = this.extractKeyReqs(jd); // 提取5-8个核心要求
  }

  // 简历压缩：面试前用一次LLM调用完成
  private compressResume(raw: string): string {
    // 提取：公司名、年限、技能、关键成就
    // 去除：格式词、冗长描述
    // 目标：~500 tokens
    return raw; // 简化示例
  }

  buildPrompt(currentQuestion: string): string {
    const history = this.qaHistory
      .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
      .join("\n\n");

    return [
      `CANDIDATE RESUME:\n${this.resume}`,
      `JOB REQUIREMENTS:\n${this.jobDescription}`,
      `CONVERSATION HISTORY:\n${history}`,
      `CURRENT QUESTION:\n${currentQuestion}`,
    ].join("\n\n---\n\n");
  }

  addQA(question: string, answer: string) {
    const tokens = Math.ceil((question + answer).length / 4);
    this.qaHistory.push({ question, answer, tokens });

    // 滚动窗口：超出预算时移除最旧的
    while (this.totalTokens() > this.maxHistoryTokens) {
      this.qaHistory.shift();
    }
  }

  private totalTokens(): number {
    return this.qaHistory.reduce((sum, qa) => sum + qa.tokens, 0);
  }
}
```

#### 6.3 LLM Prompt 设计

```typescript
const SYSTEM_PROMPT = `You are an expert interview coach. You help candidates answer interview questions effectively.

RULES:
1. Reference the candidate's SPECIFIC resume experiences (company names, projects, technologies)
2. Use STAR method (Situation, Task, Action, Result) for behavioral questions
3. For technical questions, provide key talking points, not full explanations
4. Keep suggestions under 150 words — the candidate needs to read this quickly
5. Be specific, not generic — every answer should be personalized to this candidate

OUTPUT FORMAT (JSON):
{
  "question_type": "behavioral" | "technical" | "situational" | "general",
  "key_points": ["point 1", "point 2", "point 3"],
  "resume_reference": "Which specific experience to mention",
  "sample_opening": "A strong opening sentence for the answer"
}`;
```

#### 6.4 混合 LLM 策略（云端 + 本地）

```typescript
class HybridLLM {
  private localSession: any = null;

  async initialize() {
    // 检测 Chrome 内置 AI (Gemini Nano)
    try {
      const caps = await (window as any).ai?.languageModel?.capabilities();
      if (caps?.available === "readily") {
        this.localSession = await (window as any).ai.languageModel.create({
          initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
        });
      }
    } catch (e) {
      console.log("Chrome AI 不可用，使用纯云端方案");
    }
  }

  async generate(question: string, context: string): Promise<string> {
    // 快速路径：本地 AI 判断是否是面试问题
    if (this.localSession) {
      const quickCheck = await this.localSession.prompt(
        `Is this an interview question? Answer YES or NO: "${question}"`
      );
      if (!quickCheck.trim().startsWith("YES")) return "";
    }

    // 复杂生成：走云端 GPT-4o-mini（流式响应）
    return await this.cloudGenerate(question, context);
  }

  private async cloudGenerate(question: string, context: string): Promise<string> {
    const token = await getValidToken();
    const response = await fetch("https://api.yourapp.com/v1/sessions/suggest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question, context }),
    });

    // 流式读取
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      // 实时更新 UI
      chrome.runtime.sendMessage({ type: "STREAM_CHUNK", chunk, fullText });
    }
    return fullText;
  }
}
```

#### 6.5 常见问题缓存

```typescript
class QuestionCache {
  private cache = new Map<string, { response: string; timestamp: number }>();
  private readonly TTL = 30 * 60 * 1000; // 30分钟有效期

  lookup(question: string): string | null {
    const key = this.normalize(question);

    // 精确匹配
    const exact = this.cache.get(key);
    if (exact && Date.now() - exact.timestamp < this.TTL) return exact.response;

    // 模糊匹配（Jaccard相似度 > 0.85）
    for (const [cachedKey, entry] of this.cache) {
      if (this.jaccardSimilarity(key, cachedKey) > 0.85) {
        if (Date.now() - entry.timestamp < this.TTL) return entry.response;
      }
    }
    return null;
  }

  store(question: string, response: string) {
    this.cache.set(this.normalize(question), { response, timestamp: Date.now() });
  }

  // 面试前预热：预生成常见问题的回答
  async prewarm(resume: string, jd: string) {
    const commonQuestions = [
      "Tell me about yourself",
      "What are your strengths and weaknesses",
      "Why do you want to work here",
      "Tell me about a challenging project",
      "Where do you see yourself in five years",
    ];
    for (const q of commonQuestions) {
      const response = await llm.generate(q, contextManager.buildPrompt(q));
      this.store(q, response);
    }
  }

  private normalize(text: string): string {
    return text.toLowerCase().replace(/^(um|uh|so|well)\s+/gi, "").replace(/\s+/g, " ").trim();
  }

  private jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(" "));
    const setB = new Set(b.split(" "));
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
  }
}
```

---

### 七、后端架构

#### 7.1 API 设计

```
认证:
  POST /api/v1/auth/oauth          # Chrome OAuth 登录
  POST /api/v1/auth/refresh        # 刷新 JWT

用户:
  GET  /api/v1/users/me            # 获取用户信息
  PATCH /api/v1/users/me           # 更新设置

简历:
  POST /api/v1/resumes             # 上传简历 (multipart/form-data)
  GET  /api/v1/resumes             # 列出简历
  GET  /api/v1/resumes/:id         # 获取解析后的简历数据

面试会话:
  POST /api/v1/sessions            # 创建面试会话
  GET  /api/v1/sessions            # 历史面试列表（分页）
  GET  /api/v1/sessions/:id        # 面试详情

实时面试:
  POST /api/v1/sessions/:id/suggest  # AI建议（流式响应）
  POST /api/v1/sessions/:id/analyze  # 面试结束后分析
```

#### 7.2 数据库 Schema (PostgreSQL)

```sql
-- 用户表
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  name          VARCHAR(255),
  tier          VARCHAR(20) DEFAULT 'free',    -- free / pro / unlimited
  monthly_quota INTEGER DEFAULT 10,
  tokens_used   INTEGER DEFAULT 0,
  quota_reset   TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 简历表
CREATE TABLE resumes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  original_filename VARCHAR(255),
  file_url        TEXT NOT NULL,                -- S3/R2 URL
  parsed_data     JSONB,                        -- 结构化简历数据
  parse_status    VARCHAR(20) DEFAULT 'pending',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 面试会话表
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  resume_id     UUID REFERENCES resumes(id) ON DELETE SET NULL,
  company       VARCHAR(255),
  role          VARCHAR(255),
  state         VARCHAR(20) DEFAULT 'idle',     -- idle/recording/completed
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  tokens_used   INTEGER DEFAULT 0,
  cost_usd      NUMERIC(10,6) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 面试消息表（转录 + AI回复）
CREATE TABLE session_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role        VARCHAR(20) NOT NULL,             -- interviewer/candidate/assistant
  content     TEXT NOT NULL,
  metadata    JSONB,                            -- 置信度、时间戳等
  sequence    INTEGER NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

#### 7.3 简历解析（PDF → 结构化数据）

```typescript
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { z } from "zod";

const ResumeSchema = z.object({
  personalInfo: z.object({ name: z.string(), email: z.string(), location: z.string().optional() }),
  experience: z.array(z.object({
    company: z.string(), role: z.string(),
    startDate: z.string(), endDate: z.string().optional(),
    description: z.string(), skills: z.array(z.string()),
  })),
  education: z.array(z.object({ institution: z.string(), degree: z.string() })),
  skills: z.array(z.string()),
});

export async function parseResume(fileBuffer: Buffer) {
  // 第一步：PDF文本提取
  const loader = new PDFLoader(new Blob([fileBuffer]));
  const docs = await loader.load();
  const rawText = docs.map((d) => d.pageContent).join("\n\n");

  // 第二步：LLM结构化提取
  const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
  const structuredModel = model.withStructuredOutput(ResumeSchema);
  return structuredModel.invoke([
    { role: "system", content: "Extract structured data from this resume." },
    { role: "user", content: rawText },
  ]);
}
```

#### 7.4 成本控制与限流

```typescript
// 每用户月度配额
const monthlyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(10, "30 d"), // 免费版：10场/月
  prefix: "monthly",
});

// 每次面试Token预算
const sessionTokenLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.tokenBucket(50000, "1 h", 50000), // 50K tokens/小时
  prefix: "session_tokens",
});

// 每次AI调用后记录成本
async function trackAICost(userId: string, usage: { promptTokens: number; completionTokens: number; model: string }) {
  const costPer1K = MODEL_PRICING[usage.model];
  const cost = (usage.promptTokens / 1000) * costPer1K.input +
               (usage.completionTokens / 1000) * costPer1K.output;

  await db.usageLogs.create({ userId, tokens: usage.promptTokens + usage.completionTokens, costUsd: cost });
}
```

---

### 八、安全与隐私

#### 8.1 API Key 管理

**核心原则：** 永远不在插件代码中存储第三方 API Key（OpenAI、Deepgram等）。插件代码可被下载和审查。

正确架构：
```
Chrome 插件 → 你的后端 API（持有所有 Key）→ OpenAI / Deepgram
```

#### 8.2 数据加密

传输层全部使用 TLS 1.3（HTTPS/WSS）。静态数据使用 AES-256-GCM 加密：

```typescript
const ALGORITHM = "aes-256-gcm";

function encrypt(text: string) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}
```

#### 8.3 Manifest V3 CSP 限制

Manifest V3 有严格的内容安全策略：所有 JavaScript 必须本地打包，不能从 CDN 加载；禁止 `eval()`；远程 API 调用只允许 `host_permissions` 中声明的域名。

#### 8.4 隐私合规要点

录制前必须显示明确的同意 UI；不存储原始音频，只保留转录文本；用户可导出全部数据（GDPR 第20条）和删除账户（第17条）；面试数据默认90天后自动清除。

---

### 九、构建与发布

#### 9.1 开发环境

```bash
# 初始化 WXT 项目
npx wxt@latest init ai-interview-assistant --template react
cd ai-interview-assistant
npm install zustand tailwindcss
```

#### 9.2 CI/CD (GitHub Actions)

```yaml
name: Build & Publish
on:
  push:
    tags: ["v*"]

jobs:
  build-and-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "npm" }
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: npm run zip
      - uses: mnao305/chrome-extension-upload@v5.0.0
        with:
          file-path: .output/*.zip
          extension-id: ${{ secrets.CHROME_EXTENSION_ID }}
          client-id: ${{ secrets.GOOGLE_CLIENT_ID }}
          client-secret: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          refresh-token: ${{ secrets.GOOGLE_REFRESH_TOKEN }}
          publish: true
```

---

### 十、每场面试成本估算

| 组件 | 单价 | 用量(1小时面试) | 成本 |
|------|------|-----------------|------|
| Deepgram Nova-3 | $0.46/小时 | 1小时 | $0.46 |
| GPT-4o-mini | $0.15/1M输入 | ~50K tokens | ~$0.01 |
| GPT-4o-mini | $0.60/1M输出 | ~10K tokens | ~$0.01 |
| Gemini Nano | 免费 | 问题分类等 | $0.00 |
| 后端 API | Vercel免费额度 | ~100次调用 | ~$0.00 |
| **总计** | | | **~$0.48/小时** |

按 $19/月（Pro 计划），用户月均 4 场面试计算：API 成本约 $1.92，毛利率约 90%。即使按 $29/月（Unlimited），用户月均 8 场面试，成本约 $3.84，毛利率仍达 87%。
