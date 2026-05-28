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

  // Actions
  startSession: (company: string, role: string) => void;
  endSession: () => void;
  addMessage: (msg: InterviewMessage) => void;
  setInterimText: (text: string) => void;
  addSuggestion: (s: Suggestion) => void;
  setCurrentTab: (tab: "chat" | "resume" | "settings") => void;
}

// ─── Store ────────────────────────────────────────────────────
export const appStore = createStore<AppState>()((set) => ({
  sessionState: "idle",
  company: "",
  role: "",
  messages: [],
  suggestions: [],
  interimText: "",
  currentTab: "chat",

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
}));

// ─── Persistence ──────────────────────────────────────────────
const STORAGE_KEY = "interview_assistant_state";

// 同步 store → chrome.storage
appStore.subscribe((state) => {
  const serializable = {
    sessionState: state.sessionState,
    company: state.company,
    role: state.role,
    messages: state.messages,
    suggestions: state.suggestions,
  };
  chrome.storage?.local?.set({ [STORAGE_KEY]: serializable });
});

// 恢复 store ← chrome.storage
export async function initializeStore(): Promise<void> {
  try {
    const result = await chrome.storage?.local?.get(STORAGE_KEY);
    if (result?.[STORAGE_KEY]) {
      appStore.setState(result[STORAGE_KEY]);
    }
  } catch {
    // chrome.storage 可能不可用（如在 sidepanel 首次加载时）
  }
}

// ─── React Hook ───────────────────────────────────────────────
export function useExtensionStore(): AppState;
export function useExtensionStore<T>(selector: (state: AppState) => T): T;
export function useExtensionStore<T>(selector?: (state: AppState) => T) {
  return useStore(appStore, selector!);
}
