import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../lib/i18n";
import { apiClient, ApiError, AuthError, NetworkError } from "../lib/api";
import {
  ParsedResume,
  ResumeData,
  useExtensionStore,
  WorkExperience,
} from "../store/extensionStore";

// ─── Constants ────────────────────────────────────────────────
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ACCEPTED_MIME = "application/pdf";

type UploadStatus = "idle" | "uploading" | "success" | "error";

interface UploadState {
  status: UploadStatus;
  progress: number;
  fileName: string | null;
  error: string | null;
  pendingFile: File | null;
}

const initialUpload: UploadState = {
  status: "idle",
  progress: 0,
  fileName: null,
  error: null,
  pendingFile: null,
};

// ─── Helpers ──────────────────────────────────────────────────
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} · ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusTone(s: ResumeData["parseStatus"]): {
  label: string;
  bar: string;
  text: string;
  dot: string;
} {
  switch (s) {
    case "completed":
      return {
        label: t("resumeStatusCompleted") || "PARSED",
        bar: "bg-emerald-400/80",
        text: "text-emerald-300",
        dot: "bg-emerald-400",
      };
    case "parsing":
      return {
        label: t("resumeStatusParsing") || "PARSING",
        bar: "bg-amber-400/80",
        text: "text-amber-300",
        dot: "bg-amber-400 animate-pulse",
      };
    case "failed":
      return {
        label: t("resumeStatusFailed") || "FAILED",
        bar: "bg-rose-400/80",
        text: "text-rose-300",
        dot: "bg-rose-400",
      };
    default:
      return {
        label: t("resumeStatusPending") || "PENDING",
        bar: "bg-slate-400/60",
        text: "text-slate-300",
        dot: "bg-slate-400",
      };
  }
}

function resumeFromApi(api: {
  id: string;
  filename: string;
  parsedContent?: string;
  skills?: string[];
  experience?: string[];
  uploadedAt: string;
}): ResumeData {
  const parsed: ParsedResume | undefined =
    api.skills?.length || api.experience?.length || api.parsedContent
      ? {
          name: "",
          skills: api.skills ?? [],
          experience: (api.experience ?? []).map((line) => ({
            company: "",
            role: line,
            duration: "",
            highlights: [],
          })),
          education: [],
          summary: api.parsedContent,
        }
      : undefined;

  return {
    id: api.id,
    fileName: api.filename,
    uploadedAt: new Date(api.uploadedAt).getTime() || Date.now(),
    parseStatus: parsed ? "completed" : "parsing",
    parsedData: parsed,
  };
}

// ─── Component ────────────────────────────────────────────────
export const ResumePanel: React.FC = () => {
  const {
    resumeList,
    activeResumeId,
    addResume,
    removeResume,
    setActiveResume,
    setResumeList,
  } = useExtensionStore();

  const [upload, setUpload] = useState<UploadState>(initialUpload);
  const [isDragging, setIsDragging] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const progressTimer = useRef<number | null>(null);

  // ─── Initial fetch (best-effort) ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiClient.getResumes();
        if (cancelled) return;
        const merged = list.map(resumeFromApi);
        // Merge: keep local-only entries (id starts with "local_")
        const localOnly = resumeList.filter((r) => r.id.startsWith("local_"));
        setResumeList([...merged, ...localOnly]);
      } catch (err) {
        if (!cancelled) {
          setListError(
            err instanceof AuthError
              ? t("resumeListAuthError") || "登录后才能同步云端简历"
              : t("resumeListOffline") || "云端不可用，已切换到本地模式",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup progress timer on unmount
  useEffect(() => {
    return () => {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      abortRef.current?.abort();
    };
  }, []);

  // ─── Validation ─────────────────────────────────────────────
  const validate = useCallback((file: File): string | null => {
    if (
      file.type !== ACCEPTED_MIME &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      return t("resumeErrorPdfOnly") || "仅支持 PDF 格式";
    }
    if (file.size > MAX_FILE_SIZE) {
      return (
        t("resumeErrorTooLarge") ||
        `文件不能超过 ${bytesLabel(MAX_FILE_SIZE)}`
      );
    }
    return null;
  }, []);

  // ─── Upload flow ────────────────────────────────────────────
  const startProgressSimulation = () => {
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = window.setInterval(() => {
      setUpload((prev) => {
        if (prev.status !== "uploading") return prev;
        const next = Math.min(prev.progress + Math.random() * 9 + 3, 92);
        return { ...prev, progress: next };
      });
    }, 280);
  };

  const stopProgressSimulation = () => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  };

  const performUpload = useCallback(
    async (file: File) => {
      const err = validate(file);
      if (err) {
        setUpload({
          ...initialUpload,
          status: "error",
          fileName: file.name,
          error: err,
          pendingFile: file,
        });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      setUpload({
        status: "uploading",
        progress: 4,
        fileName: file.name,
        error: null,
        pendingFile: file,
      });
      startProgressSimulation();

      try {
        const result = await apiClient.uploadResume(file, {
          signal: controller.signal,
        });
        stopProgressSimulation();
        setUpload((prev) => ({ ...prev, progress: 100 }));

        const newResume = resumeFromApi(result);
        addResume(newResume);
        if (!activeResumeId) setActiveResume(newResume.id);

        setUpload({
          status: "success",
          progress: 100,
          fileName: file.name,
          error: null,
          pendingFile: null,
        });

        // Background: poll once for parsed details
        if (newResume.parseStatus !== "completed") {
          void hydrateResume(newResume.id);
        }

        window.setTimeout(() => {
          setUpload((prev) =>
            prev.status === "success" ? initialUpload : prev,
          );
        }, 2400);
      } catch (e) {
        stopProgressSimulation();
        if (e instanceof DOMException && e.name === "AbortError") {
          setUpload(initialUpload);
          return;
        }

        const msg =
          e instanceof AuthError
            ? t("resumeErrorAuth") || "未登录，无法上传到云端"
            : e instanceof NetworkError
              ? t("resumeErrorNetwork") || "网络异常，无法连接到服务器"
              : e instanceof ApiError
                ? `${t("resumeErrorApi") || "服务返回异常"}（${e.status}）`
                : t("resumeErrorUnknown") || "上传失败";

        setUpload({
          status: "error",
          progress: 0,
          fileName: file.name,
          error: msg,
          pendingFile: file,
        });
      } finally {
        abortRef.current = null;
      }
    },
    [activeResumeId, addResume, setActiveResume, validate],
  );

  const hydrateResume = useCallback(
    async (id: string) => {
      try {
        const detail = await apiClient.getResume(id);
        const updated = resumeFromApi(detail);
        // Replace by id: remove then re-add preserves logical position for our short list
        removeResume(id);
        addResume(updated);
        if (activeResumeId === id) setActiveResume(updated.id);
      } catch {
        // silently ignore — the entry stays in `parsing` status
      }
    },
    [activeResumeId, addResume, removeResume, setActiveResume],
  );

  const cancelUpload = () => {
    abortRef.current?.abort();
    stopProgressSimulation();
    setUpload(initialUpload);
  };

  const saveLocally = () => {
    if (!upload.pendingFile) return;
    const f = upload.pendingFile;
    const local: ResumeData = {
      id: `local_${crypto.randomUUID()}`,
      fileName: f.name,
      uploadedAt: Date.now(),
      parseStatus: "failed", // can't parse without backend
    };
    addResume(local);
    if (!activeResumeId) setActiveResume(local.id);
    setUpload(initialUpload);
  };

  const retryUpload = () => {
    if (upload.pendingFile) void performUpload(upload.pendingFile);
  };

  // ─── DnD ────────────────────────────────────────────────────
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void performUpload(file);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting same file
    if (file) void performUpload(file);
  };

  const sortedList = useMemo(
    () => [...resumeList].sort((a, b) => b.uploadedAt - a.uploadedAt),
    [resumeList],
  );

  // ─── Render ─────────────────────────────────────────────────
  return (
    <div className="px-4 py-5 space-y-6">
      {/* Header */}
      <header className="space-y-1.5">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[10px] tracking-[0.3em] text-blue-400/70 uppercase">
            §01 · Dossier
          </span>
          <span className="h-px flex-1 bg-gradient-to-r from-blue-500/30 to-transparent" />
        </div>
        <h2 className="text-base font-semibold text-slate-100 tracking-tight">
          {t("resumeTitle") || "简历档案"}
        </h2>
        <p className="text-xs text-slate-500 leading-relaxed">
          {t("resumeDescription") ||
            "上传 PDF 简历，AI 将其结构化以服务于面试准备。"}
        </p>
      </header>

      {/* Upload Zone */}
      <UploadZone
        upload={upload}
        isDragging={isDragging}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPick={() => fileInputRef.current?.click()}
        onCancel={cancelUpload}
        onRetry={retryUpload}
        onSaveLocal={saveLocally}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={onPick}
        className="hidden"
      />

      {/* List status */}
      {listError && (
        <div className="font-mono text-[10px] tracking-wide text-amber-300/80 border-l-2 border-amber-400/60 pl-2">
          {listError}
        </div>
      )}

      {/* Resume list */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[10px] tracking-[0.3em] text-slate-400/80 uppercase">
            §02 · Archive ({sortedList.length.toString().padStart(2, "0")})
          </span>
          <span className="h-px flex-1 bg-slate-700/50" />
        </div>

        {sortedList.length === 0 ? (
          <p className="font-mono text-[11px] text-slate-500/80 italic py-2">
            // 还没有简历记录
          </p>
        ) : (
          <ul className="space-y-2.5">
            {sortedList.map((r, idx) => (
              <ResumeCard
                key={r.id}
                resume={r}
                index={idx + 1}
                active={r.id === activeResumeId}
                expanded={expandedId === r.id}
                onToggle={() =>
                  setExpandedId(expandedId === r.id ? null : r.id)
                }
                onActivate={() => setActiveResume(r.id)}
                onRemove={() => {
                  removeResume(r.id);
                  if (expandedId === r.id) setExpandedId(null);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {/* JD textarea preserved */}
      <JDInputSection />
    </div>
  );
};

// ─── Upload Zone ──────────────────────────────────────────────
interface UploadZoneProps {
  upload: UploadState;
  isDragging: boolean;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onPick: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onSaveLocal: () => void;
}

const UploadZone: React.FC<UploadZoneProps> = ({
  upload,
  isDragging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onPick,
  onCancel,
  onRetry,
  onSaveLocal,
}) => {
  if (upload.status === "uploading") {
    return (
      <div className="relative overflow-hidden rounded-md border border-blue-500/40 bg-blue-950/20 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
            <span className="font-mono text-[11px] text-blue-200 truncate">
              {upload.fileName}
            </span>
          </div>
          <button
            onClick={onCancel}
            className="font-mono text-[10px] tracking-widest text-slate-400 hover:text-rose-300 uppercase transition-colors"
          >
            {t("btnCancel") || "Cancel"}
          </button>
        </div>
        <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-[width] duration-300 ease-out"
            style={{ width: `${upload.progress}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-500 tracking-wider">
          <span>{t("resumeUploading") || "TRANSMITTING"}</span>
          <span>{Math.round(upload.progress).toString().padStart(2, "0")}%</span>
        </div>
      </div>
    );
  }

  if (upload.status === "success") {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-950/20 p-4 flex items-center gap-3">
        <div className="w-7 h-7 rounded-full border border-emerald-400/60 flex items-center justify-center text-emerald-300 text-sm">
          ✓
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-emerald-200 truncate">
            {upload.fileName}
          </p>
          <p className="font-mono text-[10px] text-emerald-400/70 tracking-wider mt-0.5">
            {t("resumeUploadSuccess") || "ARCHIVED · PARSING"}
          </p>
        </div>
      </div>
    );
  }

  if (upload.status === "error") {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-950/20 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-7 h-7 rounded-full border border-rose-400/60 flex items-center justify-center text-rose-300 text-sm shrink-0">
            !
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-rose-200 truncate">
              {upload.fileName}
            </p>
            <p className="text-xs text-rose-300/80 mt-0.5">{upload.error}</p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={onRetry}
            className="font-mono text-[10px] tracking-widest uppercase px-3 py-1.5 rounded border border-rose-400/40 text-rose-200 hover:bg-rose-500/10 transition-colors"
          >
            {t("btnRetry") || "Retry"}
          </button>
          <button
            onClick={onSaveLocal}
            className="font-mono text-[10px] tracking-widest uppercase px-3 py-1.5 rounded border border-slate-500/40 text-slate-300 hover:bg-slate-700/40 transition-colors"
          >
            {t("btnSaveLocal") || "Save Locally"}
          </button>
          <button
            onClick={onPick}
            className="font-mono text-[10px] tracking-widest uppercase px-3 py-1.5 rounded text-slate-400 hover:text-slate-200 transition-colors"
          >
            {t("btnChangeFile") || "Change file"}
          </button>
        </div>
      </div>
    );
  }

  // idle
  return (
    <button
      type="button"
      onClick={onPick}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        "relative w-full block rounded-md border-2 border-dashed transition-all duration-200 text-left overflow-hidden",
        "px-5 py-7",
        isDragging
          ? "border-blue-400 bg-blue-500/10 scale-[1.01]"
          : "border-slate-700 hover:border-blue-500/60 bg-slate-900/40",
      ].join(" ")}
    >
      {/* corner ticks */}
      <span className="absolute top-1.5 left-1.5 w-2 h-2 border-l border-t border-blue-400/40" />
      <span className="absolute top-1.5 right-1.5 w-2 h-2 border-r border-t border-blue-400/40" />
      <span className="absolute bottom-1.5 left-1.5 w-2 h-2 border-l border-b border-blue-400/40" />
      <span className="absolute bottom-1.5 right-1.5 w-2 h-2 border-r border-b border-blue-400/40" />

      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded border border-slate-600 flex items-center justify-center text-blue-300 shrink-0 bg-slate-900">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.4}
            stroke="currentColor"
            className="w-5 h-5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15M9 12l3 3m0 0l3-3m-3 3V2.25"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-100">
            {isDragging
              ? t("resumeDropHere") || "Release to upload"
              : t("resumeUpload") || "拖拽 PDF 至此 · 或点击选择"}
          </p>
          <p className="font-mono text-[10px] tracking-wider text-slate-500 mt-1 uppercase">
            PDF · ≤ 5 MB · {t("resumeOnePerSession") || "single file"}
          </p>
        </div>
      </div>
    </button>
  );
};

// ─── Resume Card ──────────────────────────────────────────────
interface CardProps {
  resume: ResumeData;
  index: number;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onRemove: () => void;
}

const ResumeCard: React.FC<CardProps> = ({
  resume,
  index,
  active,
  expanded,
  onToggle,
  onActivate,
  onRemove,
}) => {
  const tone = statusTone(resume.parseStatus);
  const isLocal = resume.id.startsWith("local_");

  return (
    <li
      className={[
        "group relative rounded-md border transition-all overflow-hidden",
        active
          ? "border-blue-500/70 bg-gradient-to-br from-blue-950/40 to-slate-900/60 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]"
          : "border-slate-700/70 bg-slate-900/40 hover:border-slate-500/80",
      ].join(" ")}
    >
      {/* active accent bar */}
      {active && (
        <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-blue-400 via-cyan-300 to-blue-500" />
      )}

      <div className="p-3 pl-4 flex items-start gap-3">
        {/* index */}
        <div className="font-mono text-[10px] text-slate-500 pt-0.5 tracking-wider shrink-0">
          {index.toString().padStart(2, "0")}
        </div>

        {/* main */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-slate-100 font-medium truncate">
              {resume.fileName}
            </p>
            {active && (
              <span className="font-mono text-[9px] tracking-[0.2em] uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200 border border-blue-400/30 shrink-0">
                {t("resumeActive") || "Active"}
              </span>
            )}
            {isLocal && (
              <span className="font-mono text-[9px] tracking-[0.2em] uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-400/30 shrink-0">
                Local
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-slate-500">
            <span>{formatTimestamp(resume.uploadedAt)}</span>
            <span className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
              <span className={`tracking-wider ${tone.text}`}>
                {tone.label}
              </span>
            </span>
          </div>
        </div>

        {/* actions */}
        <div className="flex items-center gap-1 shrink-0">
          {!active && (
            <button
              onClick={onActivate}
              title={t("resumeSetActive") || "Set as active"}
              className="font-mono text-[10px] tracking-widest uppercase px-2 py-1 rounded text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors"
            >
              {t("btnUse") || "Use"}
            </button>
          )}
          {resume.parsedData && (
            <button
              onClick={onToggle}
              title={expanded ? "Collapse" : "Expand"}
              className="w-7 h-7 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-700/40 flex items-center justify-center transition-colors"
            >
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
          <button
            onClick={onRemove}
            title={t("btnDelete") || "Delete"}
            className="w-7 h-7 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 flex items-center justify-center transition-colors"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-3.5 h-3.5"
            >
              <path
                fillRule="evenodd"
                d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* expanded body */}
      {expanded && resume.parsedData && (
        <ParsedDetails parsed={resume.parsedData} />
      )}
    </li>
  );
};

// ─── Parsed Details ───────────────────────────────────────────
const ParsedDetails: React.FC<{ parsed: ParsedResume }> = ({ parsed }) => {
  return (
    <div className="border-t border-slate-700/60 px-4 py-3.5 space-y-4 bg-slate-950/40">
      {parsed.summary && (
        <p className="text-xs text-slate-300 leading-relaxed italic border-l border-blue-500/40 pl-3">
          {parsed.summary}
        </p>
      )}

      {parsed.skills.length > 0 && (
        <div>
          <h4 className="font-mono text-[10px] tracking-[0.25em] text-slate-500 uppercase mb-2">
            ◆ Skills
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {parsed.skills.map((s) => (
              <span
                key={s}
                className="font-mono text-[10px] tracking-wide px-2 py-0.5 rounded-sm bg-blue-500/10 text-blue-200 border border-blue-400/20"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {parsed.experience.length > 0 && (
        <div>
          <h4 className="font-mono text-[10px] tracking-[0.25em] text-slate-500 uppercase mb-2">
            ◆ Experience
          </h4>
          <ul className="space-y-2.5">
            {parsed.experience.map((exp, i) => (
              <ExperienceItem key={i} exp={exp} />
            ))}
          </ul>
        </div>
      )}

      {parsed.education.length > 0 && (
        <div>
          <h4 className="font-mono text-[10px] tracking-[0.25em] text-slate-500 uppercase mb-2">
            ◆ Education
          </h4>
          <ul className="space-y-1.5">
            {parsed.education.map((edu, i) => (
              <li key={i} className="text-xs text-slate-300">
                <span className="text-slate-100">{edu.institution}</span>
                {edu.degree && (
                  <span className="text-slate-500"> · {edu.degree}</span>
                )}
                {edu.field && (
                  <span className="text-slate-500"> · {edu.field}</span>
                )}
                {edu.year && (
                  <span className="font-mono text-[10px] text-slate-500 ml-2">
                    {edu.year}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const ExperienceItem: React.FC<{ exp: WorkExperience }> = ({ exp }) => (
  <li className="text-xs">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-100 font-medium truncate">
        {exp.role || "—"}
        {exp.company && (
          <span className="text-slate-500 font-normal">
            {" "}
            @ {exp.company}
          </span>
        )}
      </span>
      {exp.duration && (
        <span className="font-mono text-[10px] text-slate-500 shrink-0">
          {exp.duration}
        </span>
      )}
    </div>
    {exp.highlights.length > 0 && (
      <ul className="mt-1 space-y-0.5">
        {exp.highlights.map((h, i) => (
          <li
            key={i}
            className="text-[11px] text-slate-400 pl-3 relative leading-relaxed"
          >
            <span className="absolute left-0 top-2 w-1 h-px bg-blue-400/60" />
            {h}
          </li>
        ))}
      </ul>
    )}
  </li>
);

// ─── JD Input Section (controlled) ───────────────────────────
const JDInputSection: React.FC = () => {
  const { currentJD, setCurrentJD, addJDToHistory } = useExtensionStore();
  const [text, setText] = useState(currentJD?.description ?? "");

  // 当 store 中的 JD 变更时同步文本
  useEffect(() => {
    setText(currentJD?.description ?? "");
  }, [currentJD]);

  const handleSave = () => {
    if (!text.trim()) return;
    const jd = {
      company: currentJD?.company ?? "",
      role: currentJD?.role ?? "",
      description: text.trim(),
      savedAt: Date.now(),
    };
    setCurrentJD(jd);
    addJDToHistory(jd);
  };

  return (
    <section className="space-y-2 pt-2">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] tracking-[0.3em] text-slate-400/80 uppercase">
          §03 · {t("jobDescriptionTitle") || "Job Description"}
        </span>
        <span className="h-px flex-1 bg-slate-700/50" />
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("placeholderJobDescription") || ""}
        rows={5}
        className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700/80 rounded-md text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/70 focus:bg-slate-900 resize-none transition-colors font-mono"
      />
      {text.trim() && text !== (currentJD?.description ?? "") && (
        <button
          onClick={handleSave}
          className="font-mono text-[10px] tracking-widest uppercase px-3 py-1.5 rounded border border-blue-500/40 text-blue-200 hover:bg-blue-500/10 transition-colors"
        >
          {t("btnSaveJD") || "Save JD"}
        </button>
      )}
    </section>
  );
};

export default ResumePanel;
