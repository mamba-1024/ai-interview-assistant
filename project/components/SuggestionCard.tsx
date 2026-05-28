import React from "react";
import type { Suggestion } from "../store/extensionStore";
import { t } from "../lib/i18n";

interface Props {
  suggestion: Suggestion;
}

const typeLabels: Record<string, () => string> = {
  behavioral: () => t("typeBehavioral"),
  technical: () => t("typeTechnical"),
  situational: () => t("typeSituational"),
  general: () => t("typeGeneral"),
};

const typeColors: Record<string, string> = {
  behavioral: "bg-purple-500/20 text-purple-300",
  technical: "bg-cyan-500/20 text-cyan-300",
  situational: "bg-amber-500/20 text-amber-300",
  general: "bg-slate-500/20 text-slate-300",
};

export const SuggestionCard: React.FC<Props> = ({ suggestion }) => {
  const getLabel = typeLabels[suggestion.questionType];
  const label = getLabel ? getLabel() : t("labelQuestion");

  return (
    <div className="mx-4 mb-3 p-3 bg-slate-800 border border-slate-600 rounded-xl">
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${typeColors[suggestion.questionType] ?? typeColors.general}`}
        >
          {label}
        </span>
        {suggestion.resumeReference && (
          <span className="text-[10px] text-slate-500 truncate">
            {t("labelRef")}: {suggestion.resumeReference}
          </span>
        )}
      </div>

      {suggestion.sampleOpening && (
        <p className="text-sm text-slate-200 mb-2 italic">
          "{suggestion.sampleOpening}"
        </p>
      )}

      <ul className="space-y-1">
        {suggestion.keyPoints.map((point, i) => (
          <li key={i} className="text-xs text-slate-400 flex gap-2">
            <span className="text-blue-400 shrink-0">•</span>
            {point}
          </li>
        ))}
      </ul>
    </div>
  );
};
