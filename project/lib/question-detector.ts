/**
 * 面试问题检测器
 *
 * 结合多种信号判断面试官是否提完了一个问题：
 * - 静音计时器 (1.5s)
 * - UtteranceEnd 事件
 * - 正则模式匹配
 */

type QuestionCallback = (question: string) => void;

export class QuestionDetector {
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptBuffer = "";
  private onQuestionDetected: QuestionCallback;

  private readonly SILENCE_THRESHOLD = 1500;
  private readonly MIN_WORDS = 5;
  private readonly PATTERNS = [
    /\?$/,
    /^(can you|could you|tell me|how do|how would|what is|what was|what are|describe|explain|walk me through|give me an example)/i,
    /(your experience|your approach|how did you|what did you|why do you|where do you see)/i,
  ];

  constructor(callback: QuestionCallback) {
    this.onQuestionDetected = callback;
  }

  /** 收到最终转录文本时调用 */
  processSegment(text: string): void {
    this.transcriptBuffer += " " + text;

    if (this.silenceTimer) clearTimeout(this.silenceTimer);

    this.silenceTimer = setTimeout(() => {
      this.evaluate();
    }, this.SILENCE_THRESHOLD);
  }

  /** Deepgram UtteranceEnd 事件时调用 */
  onUtteranceEnd(): void {
    this.evaluate();
  }

  /** 重置缓冲区 */
  reset(): void {
    this.transcriptBuffer = "";
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
  }

  private evaluate(): void {
    const question = this.transcriptBuffer.trim();
    const wordCount = question.split(/\s+/).length;

    if (wordCount < this.MIN_WORDS) {
      this.transcriptBuffer = "";
      return;
    }

    const isQuestion = this.PATTERNS.some((p) => p.test(question));
    if (isQuestion) {
      this.onQuestionDetected(question);
    }

    this.transcriptBuffer = "";
  }
}
