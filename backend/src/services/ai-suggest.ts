import OpenAI from "openai";
import { config } from "../config.js";

let openai: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openai) {
    const opts: OpenAI.ClientOptions = { apiKey: config.openai.apiKey };
    if (config.openai.baseURL) opts.baseURL = config.openai.baseURL;
    openai = new OpenAI(opts);
  }
  return openai;
}

interface SuggestionInput {
  question: string;
  context?: string;
  resumeContext?: string;
  company: string;
  role: string;
  language: string;
}

interface StreamChunk {
  type: "suggestion_start" | "suggestion_chunk" | "suggestion_end" | "error";
  data: unknown;
}

const SYSTEM_PROMPT = `You are an expert interview coach. When given an interview question, provide a concise, actionable answer suggestion.

Your response should include:
1. A brief strategy for answering (2-3 sentences)
2. Key points to cover (bullet list)
3. A sample opening sentence

Keep suggestions practical and specific to the role and company when possible.
Respond in the same language as the question unless instructed otherwise.`;

export async function* streamSuggestion(input: SuggestionInput): AsyncGenerator<StreamChunk, void, undefined> {
  const client = getClient();

  if (!config.openai.apiKey || config.openai.apiKey.includes("your-openai-api-key")) {
    // Fallback: generate a mock suggestion when no API key is configured
    yield* mockSuggestion(input);
    return;
  }

  const langHint = input.language === "zh_CN" ? "请用中文回答。" : "Respond in English.";

  const userMessage = [
    `Company: ${input.company}`,
    `Role: ${input.role}`,
    ``,
    `Interview question: ${input.question}`,
    input.context ? `\nRecent conversation context:\n${input.context}` : "",
    input.resumeContext ? `\n${input.resumeContext}` : "",
    ``,
    langHint,
  ].filter(Boolean).join("\n");

  yield { type: "suggestion_start", data: null };

  try {
    const stream = await client.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      stream: true,
      max_tokens: 800,
      temperature: 0.7,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield { type: "suggestion_chunk", data: content };
      }
    }

    yield { type: "suggestion_end", data: null };
  } catch (err: any) {
    console.error("[AI Suggest] OpenAI error:", err.message);
    yield { type: "error", data: `AI service error: ${err.message}` };
  }
}

// ─── Mock suggestion for dev without API key ─────────────────
async function* mockSuggestion(input: SuggestionInput): AsyncGenerator<StreamChunk, void, undefined> {
  const isZh = input.language === "zh_CN";

  yield { type: "suggestion_start", data: null };

  const chunks = isZh
    ? [
        `## 回答策略\n\n`,
        `这是一道关于「${input.question.slice(0, 50)}」的面试题。`,
        `建议从以下几个角度组织回答：\n\n`,
        `**关键要点：**\n`,
        `- 用 STAR 框架组织回答（情境-任务-行动-结果）\n`,
        `- 结合你在 ${input.company} 应聘 ${input.role} 的背景\n`,
        `- 突出可量化的成果和具体经验\n`,
        `- 展示对行业和岗位的理解\n\n`,
        `**参考开头：**\n`,
        `"这是一个很好的问题。在我的过往经历中，我曾...\n`,
        `让我从具体的例子来说明..."`,
      ]
    : [
        `## Strategy\n\n`,
        `This question about "${input.question.slice(0, 50)}" requires a structured approach.`,
        ` Here's how to frame your answer:\n\n`,
        `**Key Points:**\n`,
        `- Use the STAR framework (Situation, Task, Action, Result)\n`,
        `- Tailor your answer to the ${input.role} role at ${input.company}\n`,
        `- Include quantifiable achievements\n`,
        `- Show enthusiasm and cultural fit\n\n`,
        `**Sample Opening:**\n`,
        `"That's a great question. In my previous role, I had the opportunity to...\n`,
        `Let me share a specific example that demonstrates..."`,
      ];

  // Simulate streaming with small delays
  for (const chunk of chunks) {
    yield { type: "suggestion_chunk", data: chunk };
    await new Promise(r => setTimeout(r, 30));
  }

  yield { type: "suggestion_end", data: null };
}
