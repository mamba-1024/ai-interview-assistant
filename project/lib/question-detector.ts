/**
 * 面试问题检测器
 *
 * 结合多种信号判断面试官是否提完了一个问题：
 * - 静音计时器 (1.5s)
 * - UtteranceEnd 事件
 * - 正则模式匹配（中英文双语）
 */

type QuestionCallback = (question: string) => void;

export class QuestionDetector {
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptBuffer = "";
  private onQuestionDetected: QuestionCallback;

  private readonly SILENCE_THRESHOLD = 1500;
  private readonly MIN_WORDS = 4; // 降低阈值以兼容中文（中文按字计数）
  private readonly PATTERNS = [
    // 英文问题模式
    /\?$/,
    /^(can you|could you|tell me|how do|how would|what is|what was|what are|describe|explain|walk me through|give me an example)/i,
    /(your experience|your approach|how did you|what did you|why do you|where do you see)/i,
    // 中文问题模式
    /[？?]$/,
    /^(请问|你能|你能不能|请描述|请解释|你怎么|你是如何|你为什么|请举例|谈谈)/,
    /(你怎么看|你觉得|你认为|你的经验|你的理解|你是怎么处理|你遇到过|你怎么理解)/,
    /(有什么|怎么做|怎么看|怎么处理|怎么解决|怎么理解|如何看|如何解决|如何应对|如何管理)/,
    /(举例说明|举个例子|分享一个|说一个|讲一个)/,
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

    // 中文按字符计数，英文按词计数
    const chineseChars = (question.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = question.replace(/[\u4e00-\u9fff]/g, "").split(/\s+/).filter(Boolean).length;
    const effectiveLength = chineseChars + englishWords;

    if (effectiveLength < this.MIN_WORDS) {
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
