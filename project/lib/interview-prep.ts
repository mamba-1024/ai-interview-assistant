/**
 * 面试准备模块
 *
 * 基于用户简历（ParsedResume）与岗位描述（JobDescription）生成预测面试题，
 * 并为每道题提供 STAR（Situation/Task/Action/Result）格式的答案框架。
 *
 * 功能：
 * 1. generateInterviewQuestions(resumeData, jobDescription) — 生成预测面试题
 * 2. generateSTARAnswer(question, resumeData)               — 生成 STAR 答案
 * 3. prepareFullInterview(resumeId, jobDescription)         — 一次性批量生成
 *
 * 缓存：
 * - 同一 resume + JD 组合的结果在内存中缓存，并通过 chrome.storage.local 持久化。
 * - 缓存 key = sha256-lite(resumeId + company + role) 的简化哈希。
 *
 * 容错：
 * - 后端尚未实现/调用失败时，使用本地通用题库 + STAR 模板兜底。
 */

import { apiClient } from "./api";
import { getValidToken } from "./auth";
import {
  appStore,
  type JobDescription,
  type ParsedResume,
  type PreparedQuestion,
} from "../store/extensionStore";

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** chrome.storage.local 中持久化缓存的 key */
const STORAGE_KEY = "interview_prep_cache_v1";

/** 单次缓存条目最长保留时间（7 天） */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 默认 API base URL（与 api.ts 保持一致的兜底值） */
const DEFAULT_BASE_URL = "http://localhost:3000";

/** 单次请求超时（面试题生成可能较慢） */
const REQUEST_TIMEOUT = 45_000;

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 面试题分类 */
export type QuestionType =
  | "behavioral"
  | "technical"
  | "situational"
  | "general";

/** STAR 答案框架 */
export interface StarFramework {
  situation: string;
  task: string;
  action: string;
  result: string;
}

/** 后端 questions 接口响应 */
export interface QuestionsApiResponse {
  questions: PreparedQuestion[];
}

/** 后端 STAR 接口响应 */
export interface StarApiResponse {
  starFramework: StarFramework;
}

/** 单条缓存记录 */
interface CacheEntry {
  /** 写入时间戳（毫秒） */
  savedAt: number;
  /** 缓存的预测题（含 STAR） */
  questions: PreparedQuestion[];
}

/** 完整批量生成结果 */
export interface PrepareFullInterviewResult {
  questions: PreparedQuestion[];
  cached: boolean;
  fallback: boolean;
}

// ─── 缓存层 ───────────────────────────────────────────────────────────────────

/** 内存缓存（cacheKey -> CacheEntry） */
const memoryCache = new Map<string, CacheEntry>();

/** 持久化缓存是否已加载 */
let storageLoaded = false;

/**
 * 计算稳定的缓存 key：基于 resumeId + 公司 + 岗位。
 * 使用 djb2-like 简单字符串哈希，足够区分不同组合。
 */
export function computeCacheKey(
  resumeId: string,
  jobDescription: Pick<JobDescription, "company" | "role">,
): string {
  const raw = `${resumeId}::${jobDescription.company.trim().toLowerCase()}::${jobDescription.role.trim().toLowerCase()}`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  return `prep_${(hash >>> 0).toString(36)}`;
}

/** 从 chrome.storage.local 加载缓存到内存 */
async function loadStorageCache(): Promise<void> {
  if (storageLoaded) return;
  storageLoaded = true;
  try {
    const stored = await chrome.storage?.local?.get(STORAGE_KEY);
    const raw = stored?.[STORAGE_KEY] as Record<string, CacheEntry> | undefined;
    if (raw) {
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        if (entry && now - entry.savedAt < CACHE_TTL_MS) {
          memoryCache.set(key, entry);
        }
      }
    }
  } catch {
    // chrome.storage 可能不可用（如测试环境），忽略
  }
}

/** 将内存缓存同步回 chrome.storage.local */
async function saveStorageCache(): Promise<void> {
  try {
    const dump: Record<string, CacheEntry> = {};
    for (const [key, entry] of memoryCache.entries()) {
      dump[key] = entry;
    }
    await chrome.storage?.local?.set({ [STORAGE_KEY]: dump });
  } catch {
    // 忽略持久化失败
  }
}

/** 读取缓存（同时检查 TTL） */
async function readCache(key: string): Promise<PreparedQuestion[] | null> {
  await loadStorageCache();
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt >= CACHE_TTL_MS) {
    memoryCache.delete(key);
    void saveStorageCache();
    return null;
  }
  return entry.questions;
}

/** 写入缓存 */
async function writeCache(
  key: string,
  questions: PreparedQuestion[],
): Promise<void> {
  memoryCache.set(key, { savedAt: Date.now(), questions });
  await saveStorageCache();
}

/** 清空缓存（仅用于调试或用户手动重置） */
export async function clearInterviewPrepCache(): Promise<void> {
  memoryCache.clear();
  storageLoaded = true;
  try {
    await chrome.storage?.local?.remove(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

// ─── 内部 HTTP 助手 ──────────────────────────────────────────────────────────

/**
 * 简易 POST 请求：复用 apiClient 的 baseUrl 与 token 体系，
 * 但避免依赖 apiClient 的私有方法。
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  // 读取 apiClient 中可能更新过的 baseUrl
  let baseUrl = DEFAULT_BASE_URL;
  try {
    const stored = await chrome.storage?.local?.get(["apiBaseUrl"]);
    if (stored?.apiBaseUrl) baseUrl = stored.apiBaseUrl as string;
  } catch {
    // 使用默认
  }

  const token = await getValidToken().catch(() => "");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Interview-prep API error: ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── 兜底模板 ────────────────────────────────────────────────────────────────

/** 通用 behavioral 问题模板 */
const BEHAVIORAL_TEMPLATES: string[] = [
  "请讲述一次你在团队中遇到分歧并最终化解的经历。",
  "描述一次你必须在压力下完成关键任务的情况，你是如何应对的？",
  "举一个你主动推动跨部门协作并取得成果的例子。",
];

/** 通用 technical 问题模板（按角色关键词替换） */
const TECHNICAL_TEMPLATES: string[] = [
  "请介绍一项你最熟悉的技术或工具，并说明你是如何在项目中落地的。",
  "在你过往的项目中，遇到过最棘手的技术难题是什么？最终如何解决？",
  "如果让你重做最近一个项目，你会在架构或实现上做哪些不同选择？",
];

/** 通用 situational 问题模板 */
const SITUATIONAL_TEMPLATES: string[] = [
  "假设上线前一晚发现关键功能存在严重缺陷，你会如何处理？",
  "如果产品经理临时调整需求且时间窗口很紧，你会怎样推进？",
  "团队中有成员长期未完成任务，影响整体进度，你会如何处理？",
];

/** 通用 general 问题模板 */
const GENERAL_TEMPLATES: string[] = [
  "请做一段 2 分钟的自我介绍。",
  "为什么对我们公司和这个岗位感兴趣？",
  "未来 3-5 年，你希望在职业上达到什么样的位置？",
];

/** 生成稳定的 question id */
function makeQuestionId(type: QuestionType, idx: number, seed: string): string {
  return `prep_${type}_${idx}_${seed.slice(0, 8)}`;
}

/**
 * 在没有后端时，根据简历 + JD 生成一组兜底预测题。
 * - 每个分类 2-3 道
 * - 自动结合 JD 公司/岗位与简历技能进行轻量个性化
 */
export function buildFallbackQuestions(
  resumeData: ParsedResume,
  jobDescription: JobDescription,
): PreparedQuestion[] {
  const seed = `${jobDescription.company}-${jobDescription.role}-${resumeData.name}`;
  const role = jobDescription.role || "目标岗位";
  const company = jobDescription.company || "我们公司";
  const topSkill = resumeData.skills[0] ?? "你最熟悉的技术";

  const personalize = (text: string, type: QuestionType): string => {
    if (type === "technical") {
      return text.replace("最熟悉的技术或工具", topSkill);
    }
    if (type === "general") {
      return text.replace("我们公司", company).replace("这个岗位", role);
    }
    return text;
  };

  const fromTemplates = (
    templates: string[],
    type: QuestionType,
  ): PreparedQuestion[] =>
    templates.slice(0, 3).map((tpl, idx) => {
      const question = personalize(tpl, type);
      return {
        id: makeQuestionId(type, idx, seed),
        question,
        type,
        suggestedAnswer: buildFallbackAnswer(question, resumeData, type),
        starFramework:
          type === "general"
            ? undefined
            : buildFallbackStar(question, resumeData, type),
      };
    });

  return [
    ...fromTemplates(BEHAVIORAL_TEMPLATES, "behavioral"),
    ...fromTemplates(TECHNICAL_TEMPLATES, "technical"),
    ...fromTemplates(SITUATIONAL_TEMPLATES, "situational"),
    ...fromTemplates(GENERAL_TEMPLATES, "general"),
  ];
}

/** 生成兜底建议答案文本 */
function buildFallbackAnswer(
  question: string,
  resume: ParsedResume,
  type: QuestionType,
): string {
  const lastExp = resume.experience[0];
  const skillList = resume.skills.slice(0, 3).join("、") || "相关核心技能";
  if (type === "general") {
    return `结合你的背景（${skillList}）以及在 ${lastExp?.company ?? "过往团队"} 的经历，从“个人定位 → 关键成就 → 与岗位匹配”三段展开作答。`;
  }
  return `请使用 STAR 结构作答：先交代背景与目标，再讲清楚你的具体动作，最后量化结果。可结合 ${lastExp?.company ?? "你最近一段经历"} 中与“${question.slice(0, 16)}…”最贴合的案例。`;
}

/** 生成兜底 STAR 框架 */
function buildFallbackStar(
  _question: string,
  resume: ParsedResume,
  type: QuestionType,
): StarFramework {
  const exp = resume.experience[0];
  const company = exp?.company ?? "上一段工作";
  const role = exp?.role ?? "相关岗位";
  const highlight = exp?.highlights[0] ?? "推动了关键项目落地";

  const baseSituation = `在 ${company} 担任 ${role} 期间，团队面临 ${type === "behavioral" ? "协作与沟通方面" : type === "technical" ? "技术攻坚方面" : "复杂场景下决策方面"} 的挑战。`;

  return {
    situation: baseSituation,
    task: `我的核心任务是定义清晰目标，并在资源受限的前提下推动落地。`,
    action: `我${type === "technical" ? "拆解技术方案、对齐关键路径" : "梳理利益相关方诉求、明确节奏并推进执行"}，过程中${highlight}。`,
    result: `最终交付了可衡量的结果（如效率提升、问题闭环或指标改善），并形成可复用的方法沉淀给团队。`,
  };
}

/** 生成单题 STAR 兜底（公开 wrap） */
export function buildFallbackStarFor(
  question: string,
  resume: ParsedResume,
  type: QuestionType = "behavioral",
): StarFramework {
  return buildFallbackStar(question, resume, type);
}

// ─── 主要导出函数 ─────────────────────────────────────────────────────────────

/**
 * 生成预测面试题（不含 STAR，可由 generateSTARAnswer 后续补全）。
 *
 * @param resumeData - 解析后的简历
 * @param jobDescription - 岗位描述
 * @returns PreparedQuestion 数组（包含 behavioral/technical/situational/general 四类）
 */
export async function generateInterviewQuestions(
  resumeData: ParsedResume,
  jobDescription: JobDescription,
): Promise<PreparedQuestion[]> {
  try {
    const data = await postJson<QuestionsApiResponse>(
      "/interview-prep/questions",
      { resumeData, jobDescription },
    );
    if (Array.isArray(data?.questions) && data.questions.length > 0) {
      return data.questions;
    }
    throw new Error("Empty questions payload");
  } catch (error) {
    console.warn(
      "[interview-prep] generateInterviewQuestions fallback:",
      error,
    );
    return buildFallbackQuestions(resumeData, jobDescription);
  }
}

/**
 * 为指定问题生成 STAR 答案框架。
 *
 * @param question - 面试问题
 * @param resumeData - 简历数据（用于贴合个人经历）
 * @param context - 可选岗位上下文（提供时帮助 AI 输出更个性化答案）
 * @param type - 题目类型，影响兜底模板
 */
export async function generateSTARAnswer(
  question: string,
  resumeData: ParsedResume,
  context?: JobDescription,
  type: QuestionType = "behavioral",
): Promise<StarFramework> {
  try {
    const data = await postJson<StarApiResponse>(
      "/interview-prep/star-answer",
      {
        question,
        resumeData,
        context: context ?? null,
      },
    );
    if (
      data?.starFramework &&
      typeof data.starFramework.situation === "string"
    ) {
      return data.starFramework;
    }
    throw new Error("Invalid STAR payload");
  } catch (error) {
    console.warn("[interview-prep] generateSTARAnswer fallback:", error);
    return buildFallbackStar(question, resumeData, type);
  }
}

/**
 * 一次性生成完整的面试准备包：
 * 1. 通过 generateInterviewQuestions 拿到预测题
 * 2. 对缺少 starFramework 的题目并行补全 STAR
 * 3. 写入缓存 & 同步到 store（preparedQuestions / prepStatus）
 *
 * @param resumeId - 简历 ID（用作缓存 key 的一部分）
 * @param jobDescription - 岗位描述
 * @param options.force - 跳过缓存强制重新生成
 */
export async function prepareFullInterview(
  resumeId: string,
  jobDescription: JobDescription,
  options?: { force?: boolean },
): Promise<PrepareFullInterviewResult> {
  const state = appStore.getState();
  const resume = state.resumeList.find((r) => r.id === resumeId)?.parsedData;
  if (!resume) {
    throw new Error(
      `prepareFullInterview: parsed resume not found for id=${resumeId}`,
    );
  }

  const cacheKey = computeCacheKey(resumeId, jobDescription);

  // 命中缓存
  if (!options?.force) {
    const cached = await readCache(cacheKey);
    if (cached && cached.length > 0) {
      state.setPreparedQuestions(cached);
      state.setPrepStatus("done");
      return { questions: cached, cached: true, fallback: false };
    }
  }

  state.setPrepStatus("generating");

  let fallbackUsed = false;

  try {
    let questions = await generateInterviewQuestions(resume, jobDescription);

    // 对缺失 STAR 的非 general 题目并行补全
    questions = await Promise.all(
      questions.map(async (q) => {
        if (q.starFramework || q.type === "general") return q;
        try {
          const star = await generateSTARAnswer(
            q.question,
            resume,
            jobDescription,
            q.type,
          );
          return { ...q, starFramework: star };
        } catch {
          fallbackUsed = true;
          return {
            ...q,
            starFramework: buildFallbackStar(q.question, resume, q.type),
          };
        }
      }),
    );

    await writeCache(cacheKey, questions);

    // 通过订阅函数获取最新 actions（resetAll 等可能替换了 state 引用）
    appStore.getState().setPreparedQuestions(questions);
    appStore.getState().setPrepStatus("done");

    return { questions, cached: false, fallback: fallbackUsed };
  } catch (error) {
    console.error("[interview-prep] prepareFullInterview failed:", error);
    const fallback = buildFallbackQuestions(resume, jobDescription);
    appStore.getState().setPreparedQuestions(fallback);
    appStore.getState().setPrepStatus("done");
    return { questions: fallback, cached: false, fallback: true };
  }
}

// ─── 便捷工具：apiClient 引用占位（保证 tree-shaking 不剔除 import） ─────────────
// apiClient 暴露的实例方法主要用于 baseUrl 同步与未来扩展（如 streamRequest）。
// 这里显式引用一次以避免 IDE 报告未使用的 import。
void apiClient;
