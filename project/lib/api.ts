/**
 * 后端 API 客户端
 *
 * 功能完整的 API 客户端，支持：
 * - 请求重试（指数退避）
 * - 流式 SSE 响应
 * - 请求取消（AbortController）
 * - 错误分类处理
 */

import { getValidToken } from "./auth";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_INTERVAL = 1000;

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** API 客户端配置 */
export interface ApiConfig {
  baseUrl: string;
  timeout?: number;
  maxRetries?: number;
}

/** SSE 流式数据块 */
export interface StreamChunk {
  type: "suggestion_start" | "suggestion_chunk" | "suggestion_end" | "error";
  data: unknown;
}

/** 用户信息 */
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  plan: string;
  createdAt: string;
}

/** 用户设置更新 */
export interface UserSettingsUpdate {
  name?: string;
  language?: string;
  defaultResumeId?: string;
}

/** 简历信息 */
export interface Resume {
  id: string;
  filename: string;
  parsedContent?: string;
  skills?: string[];
  experience?: string[];
  uploadedAt: string;
}

/** 面试会话创建参数 */
export interface CreateSessionParams {
  company: string;
  role: string;
  resumeId?: string;
  language?: string;
}

/** 面试会话 */
export interface Session {
  id: string;
  company: string;
  role: string;
  resumeId?: string;
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
}

/** 会话详情 */
export interface SessionDetail extends Session {
  transcript: TranscriptEntry[];
  suggestions: SuggestionEntry[];
}

/** 转录条目 */
export interface TranscriptEntry {
  speaker: "interviewer" | "candidate";
  text: string;
  timestamp: number;
}

/** AI 建议条目 */
export interface SuggestionEntry {
  id: string;
  question: string;
  suggestion: string;
  timestamp: number;
}

/** AI 建议请求参数 */
export interface SuggestParams {
  question: string;
  context: string;
  resumeId?: string;
  language?: string;
}

/** 面试分析结果 */
export interface AnalysisResult {
  sessionId: string;
  overallScore: number;
  strengths: string[];
  improvements: string[];
  detailedFeedback: string;
}

/** OAuth 登录参数 */
export interface OAuthParams {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/** Token 响应 */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Deepgram 临时 Token */
export interface DeepgramToken {
  token: string;
  expiresAt: number;
  url: string;
}

/** 流式请求选项 */
export interface StreamRequestOptions {
  signal?: AbortSignal;
  onChunk?: (chunk: StreamChunk) => void;
}

/** 请求选项 */
export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  retries?: number;
  skipAuth?: boolean;
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────────

/** 网络连接错误 */
export class NetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

/** 401/403 认证错误 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** 429 配额超限错误 */
export class QuotaError extends Error {
  public readonly retryAfter: number | null;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "QuotaError";
    this.retryAfter = retryAfter ?? null;
  }
}

/** 其他 API 错误 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── API 客户端 ───────────────────────────────────────────────────────────────

class ApiClient {
  private config: Required<ApiConfig>;
  private activeControllers: Set<AbortController> = new Set();

  constructor(config?: Partial<ApiConfig>) {
    this.config = {
      baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL,
      timeout: config?.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }

  // ─── 配置管理 ───────────────────────────────────────────────────────────────

  /**
   * 从 chrome.storage 加载配置（baseUrl 等）
   * 如果 storage 中没有配置，使用默认值
   */
  async loadConfig(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(["apiBaseUrl"]);
      if (stored?.apiBaseUrl) {
        this.config.baseUrl = stored.apiBaseUrl as string;
      }
    } catch {
      // 如果 chrome.storage 不可用（如测试环境），使用默认值
    }
  }

  /**
   * 更新客户端配置
   */
  updateConfig(config: Partial<ApiConfig>): void {
    if (config.baseUrl !== undefined) this.config.baseUrl = config.baseUrl;
    if (config.timeout !== undefined) this.config.timeout = config.timeout;
    if (config.maxRetries !== undefined)
      this.config.maxRetries = config.maxRetries;
  }

  // ─── 认证 ───────────────────────────────────────────────────────────────────

  /**
   * 获取认证请求头
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getValidToken();
    return {
      Authorization: `Bearer ${token ?? ""}`,
      "Content-Type": "application/json",
    };
  }

  // ─── 核心请求方法 ───────────────────────────────────────────────────────────

  /**
   * 带重试和错误分类的通用请求方法
   * @param method - HTTP 方法
   * @param path - API 路径（相对于 baseUrl）
   * @param body - 请求体
   * @param options - 请求选项
   * @returns 解析后的响应数据
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const maxRetries = options?.retries ?? this.config.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      this.activeControllers.add(controller);

      // 如果外部传入了 signal，监听其 abort 事件
      if (options?.signal) {
        if (options.signal.aborted) {
          this.activeControllers.delete(controller);
          throw new DOMException("Request aborted", "AbortError");
        }
        options.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }

      // 超时处理
      const timeout = options?.timeout ?? this.config.timeout;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const headers = options?.skipAuth
          ? { "Content-Type": "application/json" }
          : await this.getAuthHeaders();

        const url = `${this.config.baseUrl}/api/v1${path}`;
        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (body !== undefined && body !== null) {
          if (body instanceof FormData) {
            // FormData 自动设置 Content-Type（含 boundary）
            const h = { ...headers };
            delete h["Content-Type"];
            fetchOptions.headers = h;
            fetchOptions.body = body;
          } else {
            fetchOptions.body = JSON.stringify(body);
          }
        }

        const response = await fetch(url, fetchOptions);

        clearTimeout(timeoutId);
        this.activeControllers.delete(controller);

        // 处理各种错误状态码
        if (!response.ok) {
          await this.handleErrorResponse(response, attempt, maxRetries);
          // 如果 handleErrorResponse 没有抛出错误，说明可以重试
          continue;
        }

        // 成功响应
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          return (await response.json()) as T;
        }
        return response as unknown as T;
      } catch (error) {
        clearTimeout(timeoutId);
        this.activeControllers.delete(controller);

        // AbortError 不重试
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }

        // 认证错误、配额错误不重试
        if (error instanceof AuthError || error instanceof QuotaError) {
          throw error;
        }

        // 网络错误可重试
        if (
          error instanceof TypeError ||
          (error instanceof Error && error.message.includes("fetch"))
        ) {
          lastError = new NetworkError(
            `Network error: ${error.message}`,
            error,
          );
        } else if (error instanceof Error) {
          lastError = error;
        } else {
          lastError = new NetworkError("Unknown network error", error);
        }

        // 如果还有重试次数，等待后重试
        if (attempt < maxRetries) {
          await this.delay(attempt);
        }
      }
    }

    throw lastError ?? new NetworkError("Request failed after retries");
  }

  /**
   * 处理错误响应状态码
   */
  private async handleErrorResponse(
    response: Response,
    attempt: number,
    maxRetries: number,
  ): Promise<void> {
    const status = response.status;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }

    switch (status) {
      case 401:
      case 403: {
        // 尝试刷新 token（仅在第一次 401 时）
        if (attempt === 0 && status === 401) {
          try {
            await getValidToken();
            return; // 返回后会重试请求
          } catch {
            // 刷新失败，抛出认证错误
          }
        }
        throw new AuthError(
          `Authentication failed: ${status}`,
          status,
        );
      }
      case 429: {
        const retryAfter = parseInt(
          response.headers.get("retry-after") ?? "",
          10,
        );
        throw new QuotaError(
          "Rate limit exceeded",
          isNaN(retryAfter) ? undefined : retryAfter * 1000,
        );
      }
      default: {
        // 5xx 错误可重试
        if (status >= 500 && attempt < maxRetries) {
          await this.delay(attempt);
          return; // 返回后会重试
        }
        throw new ApiError(
          `API error: ${status}`,
          status,
          body,
        );
      }
    }
  }

  /**
   * 指数退避延迟
   * @param attempt - 当前重试次数（从 0 开始）
   */
  private delay(attempt: number): Promise<void> {
    const ms =
      RETRY_BASE_INTERVAL * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── 流式请求 ──────────────────────────────────────────────────────────────

  /**
   * 流式 SSE 请求，返回 AsyncGenerator
   * @param path - API 路径
   * @param body - 请求体
   * @param options - 流式请求选项（含可选回调）
   * @yields StreamChunk 数据块
   */
  async *streamRequest(
    path: string,
    body: unknown,
    options?: StreamRequestOptions,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const controller = new AbortController();
    this.activeControllers.add(controller);

    // 监听外部 abort signal
    if (options?.signal) {
      if (options.signal.aborted) {
        this.activeControllers.delete(controller);
        throw new DOMException("Request aborted", "AbortError");
      }
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }

    try {
      const headers = await this.getAuthHeaders();
      headers["Accept"] = "text/event-stream";

      const url = `${this.config.baseUrl}/api/v1${path}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          throw new AuthError(`Authentication failed: ${status}`, status);
        }
        if (status === 429) {
          throw new QuotaError("Rate limit exceeded");
        }
        throw new ApiError(`Stream request failed: ${status}`, status);
      }

      if (!response.body) {
        throw new NetworkError("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // 保留最后一行（可能不完整）
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // 注释或空行

          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              const chunk: StreamChunk = {
                type: "suggestion_end",
                data: null,
              };
              options?.onChunk?.(chunk);
              yield chunk;
              return;
            }

            try {
              const parsed = JSON.parse(dataStr) as StreamChunk;
              options?.onChunk?.(parsed);
              yield parsed;
            } catch {
              // 非 JSON 数据，作为纯文本 chunk 返回
              const chunk: StreamChunk = {
                type: "suggestion_chunk",
                data: dataStr,
              };
              options?.onChunk?.(chunk);
              yield chunk;
            }
          }
        }
      }

      // 处理 buffer 中剩余的内容
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6);
          if (dataStr !== "[DONE]") {
            try {
              const parsed = JSON.parse(dataStr) as StreamChunk;
              options?.onChunk?.(parsed);
              yield parsed;
            } catch {
              const chunk: StreamChunk = {
                type: "suggestion_chunk",
                data: dataStr,
              };
              options?.onChunk?.(chunk);
              yield chunk;
            }
          }
        }
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  // ─── 请求取消 ──────────────────────────────────────────────────────────────

  /**
   * 取消所有进行中的请求
   */
  cancelAll(): void {
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  /**
   * 创建一个可取消的请求令牌
   * @returns AbortController 实例，调用 .abort() 取消请求
   */
  createCancelToken(): AbortController {
    return new AbortController();
  }

  // ─── Auth 端点 ─────────────────────────────────────────────────────────────

  /**
   * Chrome OAuth 登录，将 OAuth code 发送到后端换取 JWT
   * @param params - OAuth 参数（code, redirectUri, codeVerifier）
   * @returns Token 响应
   */
  async oauthLogin(params: OAuthParams): Promise<TokenResponse> {
    return this.request<TokenResponse>("POST", "/auth/oauth", params, {
      skipAuth: true,
    });
  }

  /**
   * 刷新 JWT Token
   * @param refreshToken - 刷新令牌
   * @returns 新的 Token 响应
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    return this.request<TokenResponse>(
      "POST",
      "/auth/refresh",
      { refresh_token: refreshToken },
      { skipAuth: true, retries: 1 },
    );
  }

  // ─── User 端点 ─────────────────────────────────────────────────────────────

  /**
   * 获取当前用户信息
   * @param options - 请求选项
   * @returns 用户资料
   */
  async getMe(options?: RequestOptions): Promise<UserProfile> {
    return this.request<UserProfile>("GET", "/users/me", undefined, options);
  }

  /**
   * 更新用户设置
   * @param data - 要更新的设置字段
   * @param options - 请求选项
   * @returns 更新后的用户资料
   */
  async updateMe(
    data: UserSettingsUpdate,
    options?: RequestOptions,
  ): Promise<UserProfile> {
    return this.request<UserProfile>("PATCH", "/users/me", data, options);
  }

  // ─── Resume 端点 ───────────────────────────────────────────────────────────

  /**
   * 上传简历文件
   * @param file - 简历文件（PDF/DOCX）
   * @param options - 请求选项
   * @returns 上传后的简历信息
   */
  async uploadResume(file: File, options?: RequestOptions): Promise<Resume> {
    const formData = new FormData();
    formData.append("resume", file);
    return this.request<Resume>("POST", "/resumes", formData, options);
  }

  /**
   * 获取简历列表
   * @param options - 请求选项
   * @returns 简历列表
   */
  async getResumes(options?: RequestOptions): Promise<Resume[]> {
    return this.request<Resume[]>("GET", "/resumes", undefined, options);
  }

  /**
   * 获取解析后的简历详情
   * @param id - 简历 ID
   * @param options - 请求选项
   * @returns 简历详情
   */
  async getResume(id: string, options?: RequestOptions): Promise<Resume> {
    return this.request<Resume>("GET", `/resumes/${id}`, undefined, options);
  }

  // ─── Session 端点 ──────────────────────────────────────────────────────────

  /**
   * 创建面试会话
   * @param data - 会话创建参数
   * @param options - 请求选项
   * @returns 创建的会话
   */
  async createSession(
    data: CreateSessionParams,
    options?: RequestOptions,
  ): Promise<Session> {
    return this.request<Session>("POST", "/sessions", data, options);
  }

  /**
   * 获取历史会话列表
   * @param options - 请求选项
   * @returns 会话列表
   */
  async getSessions(options?: RequestOptions): Promise<Session[]> {
    return this.request<Session[]>("GET", "/sessions", undefined, options);
  }

  /**
   * 获取会话详情
   * @param id - 会话 ID
   * @param options - 请求选项
   * @returns 会话详情
   */
  async getSession(
    id: string,
    options?: RequestOptions,
  ): Promise<SessionDetail> {
    return this.request<SessionDetail>(
      "GET",
      `/sessions/${id}`,
      undefined,
      options,
    );
  }

  /**
   * 获取 AI 建议（流式 SSE 响应）
   * @param sessionId - 会话 ID
   * @param params - 建议请求参数
   * @param streamOptions - 流式选项（signal, onChunk 回调）
   * @returns AsyncGenerator，逐步产出 StreamChunk
   */
  getAISuggestion(
    sessionId: string,
    params: SuggestParams,
    streamOptions?: StreamRequestOptions,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    return this.streamRequest(
      `/sessions/${sessionId}/suggest`,
      params,
      streamOptions,
    );
  }

  /**
   * 面试分析
   * @param sessionId - 会话 ID
   * @param options - 请求选项
   * @returns 分析结果
   */
  async analyzeSession(
    sessionId: string,
    options?: RequestOptions,
  ): Promise<AnalysisResult> {
    return this.request<AnalysisResult>(
      "POST",
      `/sessions/${sessionId}/analyze`,
      undefined,
      options,
    );
  }

  // ─── Deepgram 端点 ─────────────────────────────────────────────────────────

  /**
   * 获取 Deepgram 临时 WebSocket 认证 token
   * @param options - 请求选项
   * @returns Deepgram 临时 token 信息
   */
  async getDeepgramToken(options?: RequestOptions): Promise<DeepgramToken> {
    return this.request<DeepgramToken>(
      "GET",
      "/deepgram/token",
      undefined,
      options,
    );
  }
}

// ─── 单例导出 ─────────────────────────────────────────────────────────────────

/** 全局 API 客户端实例 */
export const apiClient = new ApiClient();

// 自动加载 storage 中的配置
void apiClient.loadConfig();

export default apiClient;
