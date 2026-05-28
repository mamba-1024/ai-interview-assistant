import React, { useEffect, useMemo, useState } from "react";
import {
  useExtensionStore,
  type InterviewMessage,
  type JobDescription,
  type PreparedQuestion,
  type Suggestion,
} from "../../store/extensionStore";
import { useServiceWorkerConnection } from "../../hooks/useServiceWorker";
import { InterviewChat } from "../../components/InterviewChat";
import { ResumePanel } from "../../components/ResumePanel";
import { RecordingControls } from "../../components/RecordingControls";
import { SuggestionCard } from "../../components/SuggestionCard";
import SettingsPanel from "../../components/SettingsPanel";
import { prepareFullInterview } from "../../lib/interview-prep";
import { t } from "../../lib/i18n";

// ─── Types & helpers ──────────────────────────────────────────
type Tab = "chat" | "resume" | "settings";

const TAB_DEFS: { id: Tab; label: string; marker: string }[] = [
  { id: "chat", label: t("tabInterview") || "面试", marker: "01" },
  { id: "resume", label: t("tabResume") || "简历", marker: "02" },
  { id: "settings", label: t("tabSettings") || "设置", marker: "03" },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

function formatDurationLong(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  return `${m}m ${pad2(s)}s`;
}

// ─── Live elapsed clock hook ──────────────────────────────────
function useElapsed(startMs: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startMs) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, startMs]);
  return startMs ? now - startMs : 0;
}

// ─── Status pill ──────────────────────────────────────────────
const STATUS_THEME: Record<
  string,
  { dot: string; text: string; ring: string; label: string }
> = {
  idle: {
    dot: "bg-slate-500",
    text: "text-slate-300",
    ring: "ring-slate-700/60",
    label: t("statusIdle") || "STANDBY",
  },
  recording: {
    dot: "bg-rose-400 animate-pulse",
    text: "text-rose-200",
    ring: "ring-rose-500/40",
    label: t("statusRecording") || "ON AIR",
  },
  analyzing: {
    dot: "bg-amber-400 animate-pulse",
    text: "text-amber-200",
    ring: "ring-amber-500/40",
    label: t("statusAnalyzing") || "ANALYZING",
  },
  completed: {
    dot: "bg-emerald-400",
    text: "text-emerald-200",
    ring: "ring-emerald-500/40",
    label: t("statusCompleted") || "ARCHIVED",
  },
};

// ─── Main App ─────────────────────────────────────────────────
export const App: React.FC = () => {
  const {
    sessionState,
    messages,
    suggestions,
    interimText,
    currentTab,
    setCurrentTab,
    currentJD,
    setCurrentJD,
    addJDToHistory,
    preparedQuestions,
    prepStatus,
    activeResumeId,
    resumeList,
    resetAll,
  } = useExtensionStore();

  useServiceWorkerConnection();

  // Live timer anchored to first system message (set by startSession)
  const sessionStart = messages[0]?.timestamp ?? null;
  const isRecording = sessionState === "recording";
  const elapsed = useElapsed(sessionStart, isRecording);

  // Final duration for completed view
  const completedDuration = useMemo(() => {
    if (sessionState !== "completed" || messages.length < 2) return 0;
    const first = messages[0]?.timestamp ?? 0;
    const last = messages[messages.length - 1]?.timestamp ?? 0;
    return Math.max(0, last - first);
  }, [sessionState, messages]);

  const interviewerCount = useMemo(
    () => messages.filter((m) => m.role === "interviewer").length,
    [messages],
  );

  const theme =
    STATUS_THEME[sessionState as string] ?? STATUS_THEME.idle;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* ─── HEADER — fixed ─────────────────────────────────── */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950/95 backdrop-blur-md">
        {/* top row */}
        <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[9px] tracking-[0.4em] text-blue-400/70 uppercase">
                AI · Sidekick
              </span>
            </div>
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-50 mt-0.5">
              {t("appTitle") || "AI 面试助手"}
            </h1>
          </div>

          <div
            className={`flex items-center gap-2 px-2.5 py-1 rounded-md ring-1 ${theme.ring} bg-slate-900/60`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${theme.dot}`} />
            <span
              className={`font-mono text-[10px] tracking-[0.18em] uppercase ${theme.text}`}
            >
              {theme.label}
            </span>
            {isRecording && (
              <span className="font-mono text-[11px] tabular-nums text-rose-100 pl-1.5 ml-1.5 border-l border-rose-500/30">
                {formatClock(elapsed)}
              </span>
            )}
          </div>
        </div>

        {/* meta strip during a live session */}
        {(isRecording || sessionState === "analyzing") && (
          <div className="px-4 pb-2 flex items-center gap-4 font-mono text-[10px] tracking-wider text-slate-500">
            <Metric
              label={t("metricQuestions") || "Q"}
              value={pad2(interviewerCount)}
            />
            <Metric
              label={t("metricSuggestions") || "S"}
              value={pad2(suggestions.length)}
            />
            {interimText && (
              <span className="ml-auto truncate max-w-[55%] text-blue-300/80 italic">
                <span className="text-blue-400/60 mr-1">▸</span>
                {interimText}
              </span>
            )}
          </div>
        )}

        {/* tab nav */}
        <nav className="flex px-2">
          {TAB_DEFS.map((tab) => {
            const active = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setCurrentTab(tab.id)}
                className={[
                  "relative flex-1 min-h-[44px] px-2 py-2.5 group transition-colors",
                  active ? "text-blue-200" : "text-slate-500 hover:text-slate-200",
                ].join(" ")}
              >
                <div className="flex items-center justify-center gap-2">
                  <span
                    className={`font-mono text-[9px] tracking-[0.25em] ${
                      active ? "text-blue-400" : "text-slate-600 group-hover:text-slate-400"
                    }`}
                  >
                    {tab.marker}
                  </span>
                  <span className="text-[12px] font-medium tracking-wide">
                    {tab.label}
                  </span>
                </div>
                <span
                  className={[
                    "absolute left-1/2 bottom-0 h-[2px] -translate-x-1/2 transition-all duration-300 ease-out",
                    active
                      ? "w-[60%] bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-500"
                      : "w-0 bg-transparent",
                  ].join(" ")}
                />
              </button>
            );
          })}
        </nav>
      </header>

      {/* ─── MAIN — scrollable ──────────────────────────────── */}
      <main className="flex-1 min-h-0 overflow-hidden">
        <div
          key={currentTab}
          className="h-full animate-[fadeIn_220ms_ease-out]"
        >
          {currentTab === "chat" && (
            <ChatTab
              sessionState={sessionState}
              messages={messages}
              suggestions={suggestions}
              interimText={interimText}
              currentJD={currentJD}
              setCurrentJD={(jd) => {
                setCurrentJD(jd);
                if (jd) addJDToHistory(jd);
              }}
              preparedQuestions={preparedQuestions}
              prepStatus={prepStatus}
              activeResumeId={activeResumeId}
              hasParsedResume={resumeList.some(
                (r) => r.id === activeResumeId && !!r.parsedData,
              )}
              completedDuration={completedDuration}
              interviewerCount={interviewerCount}
              onNewInterview={() => {
                resetAll();
              }}
            />
          )}

          {currentTab === "resume" && (
            <div className="h-full overflow-y-auto">
              <ResumePanel />
            </div>
          )}

          {currentTab === "settings" && (
            <div className="h-full overflow-y-auto">
              <SettingsPanel />
            </div>
          )}
        </div>
      </main>

      {/* ─── FOOTER — fixed ─────────────────────────────────── */}
      <footer className="shrink-0 border-t border-slate-800 bg-slate-950/95 backdrop-blur-md p-3">
        <RecordingControls
          company={currentJD?.company ?? ""}
          role={currentJD?.role ?? ""}
        />
        {!currentJD && (
          <p className="mt-1.5 font-mono text-[9px] tracking-[0.2em] text-slate-600 uppercase text-center">
            // {t("hintSaveJDFirst") || "save a job description to begin"}
          </p>
        )}
      </footer>

      {/* tiny inline keyframes (Tailwind doesn't include fadeIn by default) */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes typingDot {
          0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
          30%           { opacity: 1;    transform: translateY(-2px); }
        }
      `}</style>
    </div>
  );
};

// ─── Small status metric chip ─────────────────────────────────
const Metric: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <span className="flex items-center gap-1.5">
    <span className="text-slate-600 uppercase">{label}</span>
    <span className="text-slate-200 tabular-nums">{value}</span>
  </span>
);

// ─── Chat Tab Container ───────────────────────────────────────
interface ChatTabProps {
  sessionState: "idle" | "recording" | "analyzing" | "completed";
  messages: InterviewMessage[];
  suggestions: Suggestion[];
  interimText: string;
  currentJD: JobDescription | null;
  setCurrentJD: (jd: JobDescription | null) => void;
  preparedQuestions: PreparedQuestion[];
  prepStatus: "idle" | "generating" | "done";
  activeResumeId: string | null;
  hasParsedResume: boolean;
  completedDuration: number;
  interviewerCount: number;
  onNewInterview: () => void;
}

const ChatTab: React.FC<ChatTabProps> = ({
  sessionState,
  messages,
  suggestions,
  interimText,
  currentJD,
  setCurrentJD,
  preparedQuestions,
  prepStatus,
  activeResumeId,
  hasParsedResume,
  completedDuration,
  interviewerCount,
  onNewInterview,
}) => {
  // —— Completed: review summary
  if (sessionState === "completed") {
    return (
      <div className="h-full overflow-y-auto">
        <ReviewView
          duration={completedDuration}
          questionsCount={interviewerCount}
          suggestionsCount={suggestions.length}
          company={currentJD?.company}
          role={currentJD?.role}
          onNewInterview={onNewInterview}
        />
      </div>
    );
  }

  // —— Recording / Analyzing: live dialogue + suggestions
  if (sessionState === "recording" || sessionState === "analyzing") {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex-[3] min-h-0 flex flex-col overflow-hidden border-b border-slate-800/70">
          <InterviewChat messages={messages} />
          {interimText && (
            <div className="px-4 pb-3 -mt-1">
              <div className="font-mono text-[11px] text-blue-300/80 italic flex items-center gap-2">
                <TypingDots />
                <span className="truncate">{interimText}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex-[2] min-h-0 overflow-y-auto">
          <SuggestionStream
            suggestions={suggestions}
            isStreaming={sessionState === "analyzing"}
          />
        </div>
      </div>
    );
  }

  // —— Idle: JD setup + optional preparation
  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 py-5 space-y-6">
        <JDSection
          jd={currentJD}
          onSave={setCurrentJD}
          onClear={() => setCurrentJD(null)}
        />

        <PrepSection
          jd={currentJD}
          activeResumeId={activeResumeId}
          hasParsedResume={hasParsedResume}
          preparedQuestions={preparedQuestions}
          prepStatus={prepStatus}
        />

        {!currentJD && (
          <div className="font-mono text-[10px] tracking-wider text-slate-600 leading-relaxed border-l-2 border-slate-800 pl-3">
            <p>// {t("idleHint1") || "step 1 — describe the role"}</p>
            <p>// {t("idleHint2") || "step 2 — generate prep questions"}</p>
            <p>// {t("idleHint3") || "step 3 — start interview"}</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Typing indicator dots ────────────────────────────────────
const TypingDots: React.FC = () => (
  <span className="inline-flex items-center gap-0.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="w-1 h-1 rounded-full bg-blue-400"
        style={{
          animation: "typingDot 1.1s ease-in-out infinite",
          animationDelay: `${i * 140}ms`,
        }}
      />
    ))}
  </span>
);

// ─── JD Section ───────────────────────────────────────────────
interface JDSectionProps {
  jd: JobDescription | null;
  onSave: (jd: JobDescription) => void;
  onClear: () => void;
}

const JDSection: React.FC<JDSectionProps> = ({ jd, onSave, onClear }) => {
  const [editing, setEditing] = useState(false);
  const [company, setCompany] = useState(jd?.company ?? "");
  const [role, setRole] = useState(jd?.role ?? "");
  const [description, setDescription] = useState(jd?.description ?? "");

  // Reset draft when entering edit mode
  useEffect(() => {
    if (editing) {
      setCompany(jd?.company ?? "");
      setRole(jd?.role ?? "");
      setDescription(jd?.description ?? "");
    }
  }, [editing, jd]);

  const showForm = !jd || editing;
  const canSave = company.trim() && role.trim();

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      company: company.trim(),
      role: role.trim(),
      description: description.trim(),
      savedAt: Date.now(),
    });
    setEditing(false);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] tracking-[0.3em] text-blue-400/70 uppercase">
          §01 · Position
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-blue-500/30 to-transparent" />
      </div>

      {showForm ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t("placeholderCompany") || "公司"}
              className="min-h-[44px] px-3 py-2 bg-slate-900/60 border border-slate-700 rounded-md text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/70 focus:bg-slate-900 transition-colors"
            />
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={t("placeholderRole") || "职位"}
              className="min-h-[44px] px-3 py-2 bg-slate-900/60 border border-slate-700 rounded-md text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/70 focus:bg-slate-900 transition-colors"
            />
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              t("placeholderJobDescription") ||
              "粘贴 JD 全文，AI 将基于此生成预测题..."
            }
            rows={6}
            className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700 rounded-md text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/70 focus:bg-slate-900 transition-colors resize-none font-mono leading-relaxed"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="flex-1 min-h-[44px] px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium rounded-md transition-colors tracking-wide"
            >
              {t("btnSaveJD") || "保存职位描述"}
            </button>
            {jd && editing && (
              <button
                onClick={() => setEditing(false)}
                className="min-h-[44px] px-4 bg-transparent hover:bg-slate-800 text-slate-300 text-sm font-medium border border-slate-700 rounded-md transition-colors"
              >
                {t("btnCancel") || "取消"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <JDSummary jd={jd!} onEdit={() => setEditing(true)} onClear={onClear} />
      )}
    </section>
  );
};

const JDSummary: React.FC<{
  jd: JobDescription;
  onEdit: () => void;
  onClear: () => void;
}> = ({ jd, onEdit, onClear }) => (
  <div className="relative rounded-md border border-blue-500/30 bg-gradient-to-br from-blue-950/30 to-slate-900/60 p-4">
    <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-blue-400 via-cyan-300 to-blue-500" />
    <div className="flex items-start justify-between gap-3 mb-2">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-slate-50 truncate">
          {jd.role}
        </p>
        <p className="font-mono text-[11px] tracking-wider text-blue-300/80 mt-0.5">
          @ {jd.company}
        </p>
      </div>
      <div className="flex gap-1 shrink-0">
        <button
          onClick={onEdit}
          className="font-mono text-[10px] tracking-widest uppercase px-2.5 py-1.5 rounded text-slate-300 hover:text-blue-300 hover:bg-blue-500/10 transition-colors"
        >
          {t("btnEdit") || "Edit"}
        </button>
        <button
          onClick={onClear}
          className="font-mono text-[10px] tracking-widest uppercase px-2.5 py-1.5 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition-colors"
        >
          {t("btnClear") || "Clear"}
        </button>
      </div>
    </div>
    {jd.description && (
      <p className="text-xs text-slate-400 leading-relaxed line-clamp-3 border-l border-blue-500/30 pl-3 mt-3">
        {jd.description}
      </p>
    )}
  </div>
);

// ─── Prep Section ─────────────────────────────────────────────
interface PrepSectionProps {
  jd: JobDescription | null;
  activeResumeId: string | null;
  hasParsedResume: boolean;
  preparedQuestions: PreparedQuestion[];
  prepStatus: "idle" | "generating" | "done";
}

const PrepSection: React.FC<PrepSectionProps> = ({
  jd,
  activeResumeId,
  hasParsedResume,
  preparedQuestions,
  prepStatus,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const ready = !!jd && !!activeResumeId && hasParsedResume;
  const generating = prepStatus === "generating";

  const handleGenerate = async () => {
    if (!ready || !activeResumeId || !jd) return;
    setErrorMsg(null);
    try {
      await prepareFullInterview(activeResumeId, jd);
    } catch (e) {
      setErrorMsg(
        e instanceof Error ? e.message : (t("prepError") || "生成失败"),
      );
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] tracking-[0.3em] text-cyan-400/70 uppercase">
          §02 · Prep
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-cyan-500/30 to-transparent" />
      </div>

      {!ready ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 font-mono text-[11px] text-slate-500 leading-relaxed">
          {!jd && <p>// {t("prepNeedJD") || "需要先保存职位描述"}</p>}
          {!activeResumeId && (
            <p>// {t("prepNeedResume") || "需要先上传并选定一份简历"}</p>
          )}
          {activeResumeId && !hasParsedResume && (
            <p>// {t("prepNeedParsed") || "等待简历解析完成"}</p>
          )}
        </div>
      ) : (
        <>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className={[
              "w-full min-h-[44px] px-4 rounded-md text-sm font-medium tracking-wide transition-all relative overflow-hidden",
              generating
                ? "bg-cyan-950/50 border border-cyan-500/40 text-cyan-200 cursor-wait"
                : "bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white",
            ].join(" ")}
          >
            {generating ? (
              <span className="flex items-center justify-center gap-2">
                <TypingDots />
                {t("prepGenerating") || "正在生成预测题..."}
              </span>
            ) : preparedQuestions.length > 0 ? (
              t("prepRegenerate") || "重新生成面试准备"
            ) : (
              t("prepGenerate") || "生成面试准备"
            )}
          </button>

          {errorMsg && (
            <p className="font-mono text-[11px] text-rose-300/80 border-l-2 border-rose-400/60 pl-2">
              {errorMsg}
            </p>
          )}

          {generating && preparedQuestions.length === 0 && (
            <PrepSkeleton />
          )}

          {preparedQuestions.length > 0 && (
            <ul className="space-y-2 pt-1">
              {preparedQuestions.map((q, idx) => (
                <PreparedQuestionCard
                  key={q.id}
                  question={q}
                  index={idx + 1}
                  expanded={expandedId === q.id}
                  onToggle={() =>
                    setExpandedId(expandedId === q.id ? null : q.id)
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};

const PrepSkeleton: React.FC = () => (
  <ul className="space-y-2 pt-1">
    {[0, 1, 2].map((i) => (
      <li
        key={i}
        className="rounded-md border border-slate-800 bg-slate-900/40 p-3 animate-pulse"
        style={{ animationDelay: `${i * 120}ms` }}
      >
        <div className="h-2.5 w-1/3 bg-slate-800 rounded mb-2" />
        <div className="h-3 w-5/6 bg-slate-800 rounded" />
      </li>
    ))}
  </ul>
);

// ─── Prepared Question Card ───────────────────────────────────
const QUESTION_TYPE_TONE: Record<string, { label: string; chip: string }> = {
  behavioral: {
    label: t("typeBehavioral") || "Behavioral",
    chip: "bg-purple-500/15 text-purple-200 border-purple-400/30",
  },
  technical: {
    label: t("typeTechnical") || "Technical",
    chip: "bg-cyan-500/15 text-cyan-200 border-cyan-400/30",
  },
  situational: {
    label: t("typeSituational") || "Situational",
    chip: "bg-amber-500/15 text-amber-200 border-amber-400/30",
  },
  general: {
    label: t("typeGeneral") || "General",
    chip: "bg-slate-500/15 text-slate-200 border-slate-400/30",
  },
};

const PreparedQuestionCard: React.FC<{
  question: PreparedQuestion;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ question, index, expanded, onToggle }) => {
  const tone =
    QUESTION_TYPE_TONE[question.type] ?? QUESTION_TYPE_TONE.general;

  return (
    <li className="rounded-md border border-slate-700/70 bg-slate-900/40 hover:border-slate-600 transition-colors overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <span className="font-mono text-[10px] text-slate-500 pt-0.5 tracking-wider shrink-0">
          {pad2(index)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className={`font-mono text-[9px] tracking-[0.18em] uppercase px-1.5 py-0.5 rounded border ${tone.chip}`}
            >
              {tone.label}
            </span>
          </div>
          <p className="text-sm text-slate-100 leading-snug">
            {question.question}
          </p>
        </div>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`w-3.5 h-3.5 text-slate-500 mt-1 shrink-0 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3 bg-slate-950/40 space-y-3">
          {question.suggestedAnswer && (
            <p className="text-xs text-slate-300 leading-relaxed border-l border-cyan-500/40 pl-3">
              {question.suggestedAnswer}
            </p>
          )}
          {question.starFramework && (
            <div className="grid grid-cols-1 gap-2">
              {(["situation", "task", "action", "result"] as const).map(
                (k) => (
                  <StarRow
                    key={k}
                    letter={k[0].toUpperCase()}
                    label={k}
                    text={question.starFramework![k]}
                  />
                ),
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
};

const StarRow: React.FC<{ letter: string; label: string; text: string }> = ({
  letter,
  label,
  text,
}) => (
  <div className="flex gap-2.5 items-start">
    <div className="w-6 h-6 rounded border border-cyan-500/40 bg-cyan-950/30 flex items-center justify-center font-mono text-[10px] text-cyan-200 shrink-0 mt-0.5">
      {letter}
    </div>
    <div className="min-w-0 flex-1">
      <p className="font-mono text-[9px] tracking-[0.25em] uppercase text-cyan-400/60 mb-0.5">
        {label}
      </p>
      <p className="text-[11.5px] text-slate-300 leading-relaxed">{text}</p>
    </div>
  </div>
);

// ─── Suggestion Stream (live) ─────────────────────────────────
const SuggestionStream: React.FC<{
  suggestions: Suggestion[];
  isStreaming: boolean;
}> = ({ suggestions, isStreaming }) => {
  const ordered = useMemo(
    () => [...suggestions].sort((a, b) => b.timestamp - a.timestamp),
    [suggestions],
  );

  return (
    <div className="px-4 py-3 space-y-2.5">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] tracking-[0.3em] text-amber-400/70 uppercase">
          ▸ Live Suggestions
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-amber-500/20 to-transparent" />
        <span className="font-mono text-[10px] text-slate-500 tabular-nums">
          {pad2(ordered.length)}
        </span>
      </div>

      {isStreaming && (
        <div className="rounded-md border border-amber-500/30 bg-amber-950/10 p-3">
          <div className="flex items-center gap-2 mb-2">
            <TypingDots />
            <span className="font-mono text-[10px] tracking-wider text-amber-200/80 uppercase">
              {t("suggestionGenerating") || "drafting suggestion"}
            </span>
          </div>
          <div className="space-y-1.5">
            <div className="h-2 w-3/4 bg-amber-500/10 rounded animate-pulse" />
            <div className="h-2 w-5/6 bg-amber-500/10 rounded animate-pulse [animation-delay:120ms]" />
            <div className="h-2 w-2/3 bg-amber-500/10 rounded animate-pulse [animation-delay:240ms]" />
          </div>
        </div>
      )}

      {ordered.length === 0 && !isStreaming ? (
        <p className="font-mono text-[11px] text-slate-600 italic px-1">
          // {t("suggestionsEmpty") || "等待面试官提问..."}
        </p>
      ) : (
        <div className="-mx-4">
          {ordered.map((s) => (
            <div
              key={s.id}
              className="animate-[fadeIn_220ms_ease-out]"
            >
              <SuggestionCard suggestion={s} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Review View (completed) ──────────────────────────────────
const ReviewView: React.FC<{
  duration: number;
  questionsCount: number;
  suggestionsCount: number;
  company?: string;
  role?: string;
  onNewInterview: () => void;
}> = ({ duration, questionsCount, suggestionsCount, company, role, onNewInterview }) => (
  <div className="px-4 py-6 space-y-6">
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] tracking-[0.3em] text-emerald-400/70 uppercase">
          §00 · Debrief
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-emerald-500/30 to-transparent" />
      </div>
      <h2 className="text-base font-semibold text-slate-50 tracking-tight">
        {t("reviewTitle") || "面试结束 · 复盘摘要"}
      </h2>
      {(company || role) && (
        <p className="font-mono text-[11px] text-slate-500 tracking-wider">
          {role}
          {company ? ` @ ${company}` : ""}
        </p>
      )}
    </div>

    <div className="grid grid-cols-3 gap-2">
      <ReviewStat
        label={t("reviewDuration") || "DURATION"}
        value={formatDurationLong(duration)}
        accent="text-emerald-200"
      />
      <ReviewStat
        label={t("reviewQuestions") || "QUESTIONS"}
        value={pad2(questionsCount)}
        accent="text-blue-200"
      />
      <ReviewStat
        label={t("reviewSuggestions") || "TIPS"}
        value={pad2(suggestionsCount)}
        accent="text-amber-200"
      />
    </div>

    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-4 space-y-3">
      <p className="font-mono text-[10px] tracking-[0.2em] text-slate-500 uppercase">
        ◆ {t("reviewActions") || "下一步"}
      </p>
      <button
        onClick={() => {
          /* placeholder */
        }}
        className="w-full min-h-[44px] px-4 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium border border-slate-700 hover:border-slate-600 rounded-md transition-colors flex items-center justify-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 5l7 7-7 7" />
        </svg>
        {t("btnViewDetails") || "查看详情（即将推出）"}
      </button>
      <button
        onClick={onNewInterview}
        className="w-full min-h-[44px] px-4 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white text-sm font-medium rounded-md transition-colors"
      >
        {t("btnNewInterview") || "开启新面试"}
      </button>
    </div>
  </div>
);

const ReviewStat: React.FC<{
  label: string;
  value: string;
  accent: string;
}> = ({ label, value, accent }) => (
  <div className="rounded-md border border-slate-800 bg-slate-900/50 p-3 relative overflow-hidden">
    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-slate-700" />
    <p className="font-mono text-[9px] tracking-[0.25em] text-slate-500 uppercase mb-1.5">
      {label}
    </p>
    <p className={`font-semibold tabular-nums ${accent}`}>{value}</p>
  </div>
);

export default App;
