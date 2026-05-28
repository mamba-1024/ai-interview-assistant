import { createStore } from "zustand/vanilla";
import { useStore } from "zustand/react";
import { t } from "../lib/i18n";

// ─── Types ────────────────────────────────────────────────────
export interface InterviewMessage {
  id: string;
  role: "interviewer" | "candidate" | "assistant" | "system";
  content: string;
  timestamp: number;
  isFinal?: boolean;
}

export interface Suggestion {
  id: string;
  questionType: "behavioral" | "technical" | "situational" | "general";
  keyPoints: string[];
  resumeReference?: string;
  sampleOpening?: string;
  timestamp: number;
}

export interface WorkExperience {
  company: string;
  role: string;
  duration: string;
  highlights: string[];
}

export interface Education {
  institution: string;
  degree: string;
  field: string;
  year: string;
}

export interface ParsedResume {
  name: string;
  email?: string;
  phone?: string;
  skills: string[];
  experience: WorkExperience[];
  education: Education[];
  summary?: string;
}

export interface ResumeData {
  id: string;
  fileName: string;
  uploadedAt: number;
  parseStatus: "pending" | "parsing" | "completed" | "failed";
  parsedData?: ParsedResume;
}

export interface JobDescription {
  company: string;
  role: string;
  description: string;
  requirements?: string[];
  savedAt: number;
}

export interface PreparedQuestion {
  id: string;
  question: string;
  type: "behavioral" | "technical" | "situational" | "general";
  suggestedAnswer: string;
  starFramework?: {
    situation: string;
    task: string;
    action: string;
    result: string;
  };
}

export interface UserSettings {
  language: "en" | "zh_CN";
  apiEndpoint: string;
  theme: "light" | "dark" | "system";
  autoStartRecording: boolean;
  showNotifications: boolean;
}

export interface SessionHistory {
  id: string;
  company: string;
  role: string;
  startedAt: number;
  endedAt?: number;
  status: "completed" | "in_progress";
  questionsCount: number;
  suggestionsCount: number;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  tier: "free" | "pro" | "unlimited";
  monthlyQuota: number;
  tokensUsed: number;
  quotaReset: string;
}

// ─── App State Interface ─────────────────────────────────────
export interface AppState {
  // Session
  sessionState: "idle" | "recording" | "analyzing" | "completed";
  company: string;
  role: string;

  // Data
  messages: InterviewMessage[];
  suggestions: Suggestion[];
  interimText: string;

  // UI
  currentTab: "chat" | "resume" | "settings";

  // Resume
  resumeList: ResumeData[];
  activeResumeId: string | null;

  // JD
  currentJD: JobDescription | null;
  jdHistory: JobDescription[];

  // Interview Preparation
  preparedQuestions: PreparedQuestion[];
  prepStatus: "idle" | "generating" | "done";

  // Settings
  settings: UserSettings;

  // Session History
  sessionHistory: SessionHistory[];

  // User
  user: UserProfile | null;
  isAuthenticated: boolean;

  // ─── Actions ─────────────────────────────────────────────────
  // Session actions
  startSession: (company: string, role: string) => void;
  endSession: () => void;
  addMessage: (msg: InterviewMessage) => void;
  setInterimText: (text: string) => void;
  addSuggestion: (s: Suggestion) => void;
  setCurrentTab: (tab: "chat" | "resume" | "settings") => void;

  // Resume actions
  setResumeList: (list: ResumeData[]) => void;
  addResume: (resume: ResumeData) => void;
  removeResume: (id: string) => void;
  setActiveResume: (id: string | null) => void;

  // JD actions
  setCurrentJD: (jd: JobDescription | null) => void;
  addJDToHistory: (jd: JobDescription) => void;

  // Preparation actions
  setPreparedQuestions: (questions: PreparedQuestion[]) => void;
  setPrepStatus: (status: "idle" | "generating" | "done") => void;

  // Settings actions
  updateSettings: (partial: Partial<UserSettings>) => void;

  // Session History actions
  setSessionHistory: (history: SessionHistory[]) => void;
  addSessionToHistory: (session: SessionHistory) => void;

  // User actions
  setUser: (user: UserProfile | null) => void;
  logout: () => void;

  // Global actions
  resetAll: () => void;
}

// ─── Default Values ──────────────────────────────────────────
const defaultSettings: UserSettings = {
  language: "zh_CN",
  apiEndpoint: "",
  theme: "system",
  autoStartRecording: false,
  showNotifications: true,
};

const initialState = {
  sessionState: "idle" as const,
  company: "",
  role: "",
  messages: [],
  suggestions: [],
  interimText: "",
  currentTab: "chat" as const,
  resumeList: [],
  activeResumeId: null,
  currentJD: null,
  jdHistory: [],
  preparedQuestions: [],
  prepStatus: "idle" as const,
  settings: defaultSettings,
  sessionHistory: [],
  user: null,
  isAuthenticated: false,
};

// ─── Store ────────────────────────────────────────────────────
export const appStore = createStore<AppState>()((set) => ({
  ...initialState,

  // ─── Session Actions ───────────────────────────────────────
  startSession: (company, role) =>
    set({
      sessionState: "recording",
      company,
      role,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "system",
          content: t("sessionStarted", company, role),
          timestamp: Date.now(),
        },
      ],
      suggestions: [],
    }),

  endSession: () =>
    set((state) => ({
      sessionState: "completed",
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: t("sessionEnded"),
          timestamp: Date.now(),
        },
      ],
    })),

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  setInterimText: (text) => set({ interimText: text }),

  addSuggestion: (s) =>
    set((state) => ({ suggestions: [...state.suggestions, s] })),

  setCurrentTab: (tab) => set({ currentTab: tab }),

  // ─── Resume Actions ────────────────────────────────────────
  setResumeList: (list) => set({ resumeList: list }),

  addResume: (resume) =>
    set((state) => ({ resumeList: [...state.resumeList, resume] })),

  removeResume: (id) =>
    set((state) => ({
      resumeList: state.resumeList.filter((r) => r.id !== id),
      activeResumeId: state.activeResumeId === id ? null : state.activeResumeId,
    })),

  setActiveResume: (id) => set({ activeResumeId: id }),

  // ─── JD Actions ────────────────────────────────────────────
  setCurrentJD: (jd) => set({ currentJD: jd }),

  addJDToHistory: (jd) =>
    set((state) => ({ jdHistory: [...state.jdHistory, jd] })),

  // ─── Preparation Actions ───────────────────────────────────
  setPreparedQuestions: (questions) => set({ preparedQuestions: questions }),

  setPrepStatus: (status) => set({ prepStatus: status }),

  // ─── Settings Actions ──────────────────────────────────────
  updateSettings: (partial) =>
    set((state) => ({ settings: { ...state.settings, ...partial } })),

  // ─── Session History Actions ───────────────────────────────
  setSessionHistory: (history) => set({ sessionHistory: history }),

  addSessionToHistory: (session) =>
    set((state) => ({
      sessionHistory: [...state.sessionHistory, session],
    })),

  // ─── User Actions ──────────────────────────────────────────
  setUser: (user) =>
    set({ user, isAuthenticated: user !== null }),

  logout: () =>
    set({ user: null, isAuthenticated: false }),

  // ─── Global Actions ────────────────────────────────────────
  resetAll: () => {
    set(initialState);
    // 同步清理 chrome.storage 中的会话数据
    try {
      chrome.storage?.local?.remove?.(LOCAL_STORAGE_KEY);
      // 保留用户认证状态，不清理 session storage
    } catch {
      // chrome.storage 可能不可用
    }
  },
}));

// ─── Persistence ──────────────────────────────────────────────
const LOCAL_STORAGE_KEY = "interview_assistant_state";
const SESSION_STORAGE_KEY = "interview_assistant_user";

/** Fields persisted to chrome.storage.local */
function getLocalPersistState(state: AppState) {
  return {
    settings: state.settings,
    resumeList: state.resumeList,
    activeResumeId: state.activeResumeId,
    sessionHistory: state.sessionHistory,
    jdHistory: state.jdHistory,
    currentJD: state.currentJD,
  };
}

/** Fields persisted to chrome.storage.session (expires with browser session) */
function getSessionPersistState(state: AppState) {
  return {
    user: state.user,
    isAuthenticated: state.isAuthenticated,
  };
}

// 防抖写入 chrome.storage（避免高频存储风暴）
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500;

function schedulePersist(state: AppState) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      chrome.storage?.local?.set({
        [LOCAL_STORAGE_KEY]: getLocalPersistState(state),
      });
      chrome.storage?.session?.set({
        [SESSION_STORAGE_KEY]: getSessionPersistState(state),
      });
    } catch {
      // chrome.storage 可能不可用
    }
  }, PERSIST_DEBOUNCE_MS);
}

// 标记：仅在 initializeStore 完成后才开始持久化
let storeInitialized = false;

// 同步 store → chrome.storage（防抖，且仅在初始化完成后）
appStore.subscribe((state) => {
  if (!storeInitialized) return; // 防止在恢复之前覆盖存储
  schedulePersist(state);
});

// 恢复 store ← chrome.storage
export async function initializeStore(): Promise<void> {
  try {
    const [localResult, sessionResult] = await Promise.all([
      chrome.storage?.local?.get(LOCAL_STORAGE_KEY),
      chrome.storage?.session?.get(SESSION_STORAGE_KEY).catch(() => null),
    ]);

    const restored: Partial<AppState> = {};

    if (localResult?.[LOCAL_STORAGE_KEY]) {
      Object.assign(restored, localResult[LOCAL_STORAGE_KEY]);
    }

    if (sessionResult?.[SESSION_STORAGE_KEY]) {
      Object.assign(restored, sessionResult[SESSION_STORAGE_KEY]);
    }

    if (Object.keys(restored).length > 0) {
      appStore.setState(restored);
    }
  } catch {
    // chrome.storage 可能不可用（如在 sidepanel 首次加载时）
  } finally {
    storeInitialized = true; // 无论成功与否，标记完成以启用持久化
  }
}

// ─── React Hook ───────────────────────────────────────────────
export function useExtensionStore(): AppState;
export function useExtensionStore<T>(selector: (state: AppState) => T): T;
export function useExtensionStore<T>(selector?: (state: AppState) => T) {
  return useStore(appStore, selector!);
}
