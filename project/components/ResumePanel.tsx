import React, { useState } from "react";
import { t } from "../lib/i18n";

export const ResumePanel: React.FC = () => {
  const [fileName, setFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setIsUploading(true);

    try {
      // TODO: upload to backend
      console.log("Uploading resume:", file.name);
    } catch (err) {
      console.error("Upload failed:", err);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-medium text-slate-300">{t("resumeTitle")}</h2>
      <p className="text-xs text-slate-500">
        {t("resumeDescription")}
      </p>

      <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-600 rounded-xl cursor-pointer hover:border-blue-500 transition-colors">
        <div className="text-center">
          <p className="text-sm text-slate-400">
            {isUploading ? t("resumeParsing") : fileName ?? t("resumeUpload")}
          </p>
          {fileName && (
            <p className="text-xs text-green-400 mt-1">{t("resumeReady")}</p>
          )}
        </div>
        <input
          type="file"
          accept=".pdf"
          onChange={handleFileSelect}
          className="hidden"
        />
      </label>

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-slate-400">{t("jobDescriptionTitle")}</h3>
        <textarea
          placeholder={t("placeholderJobDescription")}
          rows={6}
          className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>
    </div>
  );
};
