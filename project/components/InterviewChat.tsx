import React from "react";
import type { InterviewMessage } from "../store/extensionStore";
import { t } from "../lib/i18n";

interface Props {
  messages: InterviewMessage[];
}

export const InterviewChat: React.FC<Props> = ({ messages }) => {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${
            msg.role === "system"
              ? "justify-center"
              : msg.role === "interviewer"
                ? "justify-start"
                : "justify-end"
          }`}
        >
          {msg.role === "system" ? (
            <span className="text-xs text-slate-500 bg-slate-800 px-3 py-1 rounded-full">
              {msg.content}
            </span>
          ) : (
            <div
              className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                msg.role === "interviewer"
                  ? "bg-slate-700 text-slate-100 rounded-tl-sm"
                  : "bg-blue-600/80 text-white rounded-tr-sm"
              }`}
            >
              <p className="text-[10px] opacity-60 mb-1">
                {msg.role === "interviewer" ? t("labelInterviewer") : t("labelYou")}
              </p>
              {msg.content}
            </div>
          )}
        </div>
      ))}

      {messages.length === 0 && (
        <div className="text-center text-slate-500 text-sm mt-8">
          {t("waitingInterview")}
        </div>
      )}
    </div>
  );
};
