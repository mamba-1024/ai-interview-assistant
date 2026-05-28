/**
 * AudioWorklet Processor — PCM 重采样 + 格式转换
 *
 * 运行在独立音频线程中:
 * - 48kHz Float32 → 16kHz Int16 PCM
 * - 线性插值重采样
 * - 缓冲后批量发送（~256ms/chunk）
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const { sourceSampleRate, targetSampleRate } = options.processorOptions;
    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.resampleRatio = sourceSampleRate / targetSampleRate;

    // 输出缓冲区
    this.bufferSize = 4096;
    this.pcmBuffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
    this.resamplePhase = 0.0;
  }

  process(inputList, outputList) {
    const input = inputList[0];
    if (!input || input.length === 0) return true;

    const inputChannel = input[0];
    if (!inputChannel || inputChannel.length === 0) return true;

    // 线性插值重采样
    for (let i = 0; i < inputChannel.length; i++) {
      while (this.resamplePhase < 1.0) {
        const srcIndex = i + this.resamplePhase;
        const floor = Math.floor(srcIndex);
        const ceil = Math.min(floor + 1, inputChannel.length - 1);
        const frac = srcIndex - floor;

        const sample =
          inputChannel[floor] * (1 - frac) + inputChannel[ceil] * frac;

        const int16 = Math.max(
          -32768,
          Math.min(32767, Math.round(sample * 32767)),
        );
        this.pcmBuffer[this.bufferIndex++] = int16;

        if (this.bufferIndex >= this.bufferSize) {
          this.flushBuffer();
        }

        this.resamplePhase += 1.0 / this.resampleRatio;
      }
      this.resamplePhase -= 1.0;
    }

    return true;
  }

  flushBuffer() {
    const buffer = this.pcmBuffer.buffer.slice(0, this.bufferIndex * 2);
    this.port.postMessage(
      {
        type: "pcm-data",
        buffer,
        encoding: "linear16",
        sampleRate: this.targetSampleRate,
      },
      [buffer],
    );
    this.pcmBuffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
