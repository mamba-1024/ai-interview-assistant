/**
 * Offscreen Document — 持久音频处理
 *
 * 职责:
 * - 兑换 tabCapture streamId 为 MediaStream
 * - 同时捕获麦克风
 * - AudioWorklet 重采样 (48kHz → 16kHz)
 * - 通过 WebSocket 流式传输到 Deepgram STT
 */

let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let deepgramWs: WebSocket | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

// ─── 消息监听 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "START_CAPTURE") {
    await startCapture(msg.streamId);
  }
  if (msg.type === "STOP_CAPTURE") {
    stopCapture();
  }
});

// ─── 启动音频捕获 ─────────────────────────────────────────────
async function startCapture(streamId: string) {
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
    }, 10000);

    console.log("[Offscreen] Audio capture started");
  } catch (error) {
    console.error("[Offscreen] Failed to start capture:", error);
    chrome.runtime.sendMessage({ type: "ERROR", payload: String(error) });
  }
}

// ─── Deepgram WebSocket ──────────────────────────────────────
function connectDeepgram() {
  // NOTE: API Key 应通过后端代理获取，这里仅作原型演示
  const apiKey = "YOUR_DEEPGRAM_API_KEY";

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
  });

  deepgramWs = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    ["token", apiKey],
  );

  deepgramWs.onopen = () => {
    console.log("[Deepgram] Connected");
  };

  deepgramWs.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "Results") {
      const alt = data.channel.alternatives[0];
      if (!alt?.transcript) return;

      const speaker = alt.words?.[0]?.speaker;

      if (data.is_final && data.speech_final) {
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT",
          payload: {
            text: alt.transcript,
            isFinal: true,
            speaker,
            timestamp: data.start,
          },
        });
      } else {
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_INTERIM",
          payload: { text: alt.transcript },
        });
      }
    }

    if (data.type === "UtteranceEnd") {
      chrome.runtime.sendMessage({ type: "UTTERANCE_END" });
    }
  };

  deepgramWs.onerror = (err) => {
    console.error("[Deepgram] WebSocket error:", err);
  };

  deepgramWs.onclose = (event) => {
    console.log("[Deepgram] Closed:", event.code);
    // TODO: 实现指数退避重连
  };
}

function sendToDeepgram(pcmBuffer: ArrayBuffer) {
  if (deepgramWs?.readyState === WebSocket.OPEN) {
    deepgramWs.send(pcmBuffer);
  }
}

// ─── 停止捕获 ─────────────────────────────────────────────────
function stopCapture() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (deepgramWs?.readyState === WebSocket.OPEN) {
    deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
    deepgramWs.close();
  }
  workletNode?.disconnect();
  audioContext?.close();
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());

  audioContext = null;
  workletNode = null;
  deepgramWs = null;
  tabStream = null;
  micStream = null;

  console.log("[Offscreen] Audio capture stopped");
}
