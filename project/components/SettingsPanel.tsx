import React, { useState } from "react";
import { useExtensionStore } from "../store/extensionStore";

const APP_VERSION = "v0.1.0";
const PRIVACY_URL = "https://ai-interview-assistant.app/privacy";
const TERMS_URL = "https://ai-interview-assistant.app/terms";

// ─── Helpers ─────────────────────────────────────────────────
function isValidUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function tierBadgeClasses(tier: "free" | "pro" | "unlimited"): string {
  switch (tier) {
    case "pro":
      return "bg-blue-500/15 text-blue-300 border-blue-500/30";
    case "unlimited":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    default:
      return "bg-slate-700/60 text-slate-300 border-slate-600";
  }
}

// ─── Section Wrapper ─────────────────────────────────────────
const Section: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <section className="space-y-3">
    <header>
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      {description && (
        <p className="text-xs text-slate-500 mt-0.5">{description}</p>
      )}
    </header>
    {children}
  </section>
);

// ─── Main Component ──────────────────────────────────────────
export default function SettingsPanel(): React.JSX.Element {
  const {
    settings,
    updateSettings,
    user,
    isAuthenticated,
    logout,
    resetAll,
    sessionHistory,
  } = useExtensionStore();

  // ─── Local State ──────────────────────────────────────────
  const [endpointDraft, setEndpointDraft] = useState(settings.apiEndpoint);
  const [endpointSaved, setEndpointSaved] = useState(false);
  const [endpointError, setEndpointError] = useState<string | null>(null);

  const [confirmClear, setConfirmClear] = useState(false);

  // ─── Handlers ─────────────────────────────────────────────
  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateSettings({ language: e.target.value as "en" | "zh_CN" });
  };

  const handleSaveEndpoint = () => {
    const value = endpointDraft.trim();
    if (value && !isValidUrl(value)) {
      setEndpointError("请输入有效的 http(s) URL");
      setEndpointSaved(false);
      return;
    }
    setEndpointError(null);
    updateSettings({ apiEndpoint: value });
    setEndpointSaved(true);
    setTimeout(() => setEndpointSaved(false), 2000);
  };

  const handleLogin = async () => {
    try {
      await chrome.runtime.sendMessage({ type: "LOGIN" });
    } catch (err) {
      console.error("Login failed:", err);
    }
  };

  const handleLogout = () => {
    logout();
  };

  const handleExport = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
      sessionHistory,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `interview-history-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClearData = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    try {
      chrome.storage?.local?.clear();
      chrome.storage?.session?.clear();
    } catch {
      // ignore
    }
    resetAll();
    setConfirmClear(false);
  };

  // ─── Quota Calculation ────────────────────────────────────
  const quotaPercent = user
    ? Math.min(100, Math.round((user.tokensUsed / user.monthlyQuota) * 100))
    : 0;
  const quotaBarColor =
    quotaPercent >= 90
      ? "bg-red-500"
      : quotaPercent >= 70
        ? "bg-amber-500"
        : "bg-blue-500";

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="p-4 space-y-6">
      {/* ─── Language ───────────────────────────────────────── */}
      <Section title="语言 / Language">
        <div className="relative">
          <select
            value={settings.language}
            onChange={handleLanguageChange}
            className="w-full appearance-none px-3 py-2 pr-9 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
          >
            <option value="zh_CN">中文 (简体)</option>
            <option value="en">English</option>
          </select>
          <svg
            className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </Section>

      <div className="border-t border-slate-800" />

      {/* ─── API Endpoint ───────────────────────────────────── */}
      <Section
        title="后端 API 地址"
        description="留空使用默认服务，或填写自定义后端地址"
      >
        <div className="flex gap-2">
          <input
            type="url"
            value={endpointDraft}
            onChange={(e) => {
              setEndpointDraft(e.target.value);
              setEndpointSaved(false);
              setEndpointError(null);
            }}
            placeholder="https://api.example.com"
            className="flex-1 px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={handleSaveEndpoint}
            disabled={endpointDraft === settings.apiEndpoint}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            保存
          </button>
        </div>
        {endpointError && (
          <p className="text-xs text-red-400">{endpointError}</p>
        )}
        {endpointSaved && (
          <p className="text-xs text-green-400">已保存</p>
        )}
      </Section>

      <div className="border-t border-slate-800" />

      {/* ─── Account ────────────────────────────────────────── */}
      <Section title="账户">
        {isAuthenticated && user ? (
          <div className="rounded-xl bg-slate-800/60 border border-slate-700 p-4 space-y-4">
            {/* Profile */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">
                  {user.name}
                </p>
                <p className="text-xs text-slate-400 truncate">{user.email}</p>
              </div>
              <span
                className={`shrink-0 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md border ${tierBadgeClasses(
                  user.tier,
                )}`}
              >
                {user.tier}
              </span>
            </div>

            {/* Quota */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>本月用量</span>
                <span className="tabular-nums">
                  <span className="text-slate-200">
                    {formatNumber(user.tokensUsed)}
                  </span>
                  <span className="text-slate-500">
                    {" "}
                    / {formatNumber(user.monthlyQuota)}
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-700/70 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${quotaBarColor}`}
                  style={{ width: `${quotaPercent}%` }}
                />
              </div>
              <p className="text-[11px] text-slate-500">
                配额于 {user.quotaReset} 重置
              </p>
            </div>

            <button
              onClick={handleLogout}
              className="w-full py-2 bg-transparent hover:bg-red-600/10 text-red-400 hover:text-red-300 text-sm font-medium border border-red-500/30 hover:border-red-500/60 rounded-lg transition-colors"
            >
              注销
            </button>
          </div>
        ) : (
          <div className="rounded-xl bg-slate-800/60 border border-slate-700 p-4 space-y-3">
            <p className="text-xs text-slate-400 leading-relaxed">
              登录以同步面试历史并解锁更高 AI 配额。
            </p>
            <button
              onClick={handleLogin}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              登录 / 注册
            </button>
          </div>
        )}
      </Section>

      <div className="border-t border-slate-800" />

      {/* ─── Data Management ────────────────────────────────── */}
      <Section
        title="数据管理"
        description={`本地共 ${sessionHistory.length} 条面试记录`}
      >
        <button
          onClick={handleExport}
          disabled={sessionHistory.length === 0}
          className="w-full py-2 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 disabled:text-slate-600 text-slate-200 text-sm font-medium border border-slate-600 hover:border-slate-500 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
          导出数据 (JSON)
        </button>

        <button
          onClick={handleClearData}
          className={`w-full py-2 text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 ${
            confirmClear
              ? "bg-red-600 hover:bg-red-700 text-white"
              : "bg-transparent hover:bg-red-600/10 text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60"
          }`}
        >
          {confirmClear ? (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.7 4a2 2 0 00-3.4 0L3.16 16.25A2 2 0 005 19z" />
              </svg>
              点击再次确认 — 此操作不可撤销
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
              </svg>
              清除所有本地数据
            </>
          )}
        </button>
      </Section>

      <div className="border-t border-slate-800" />

      {/* ─── About ──────────────────────────────────────────── */}
      <Section title="关于">
        <div className="rounded-lg bg-slate-800/40 border border-slate-700/60 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">AI 面试助手</span>
            <span className="text-xs font-mono text-slate-300">
              {APP_VERSION}
            </span>
          </div>
          <div className="flex items-center gap-3 pt-1 text-xs">
            <a
              href={PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 hover:underline transition-colors"
            >
              隐私政策
            </a>
            <span className="text-slate-700">·</span>
            <a
              href={TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 hover:underline transition-colors"
            >
              服务条款
            </a>
          </div>
        </div>
      </Section>
    </div>
  );
}
