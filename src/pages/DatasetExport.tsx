/**
 * DatasetExport.tsx
 * 数据导出页：COCO JSON 导出 + 标注框统计图表（面积分布 / 宽高比分布）
 */
import { useState } from "react";
import { Download, FolderOpen, FileJson, RefreshCw } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { browseDirectory, browseSaveFile, api } from "@/lib/tauri-bridge";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

function PathInput({
  label, value, onChange, onBrowse,
}: {
  label: string; value: string; onChange: (v: string) => void; onBrowse: () => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</label>
      <div className="flex gap-1.5">
        <input
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={label}
        />
        <button
          className="px-2.5 py-2 rounded-md flex-shrink-0 flex items-center"
          style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))" }}
          onClick={onBrowse}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function DatasetExport() {
  const { t } = useTranslation();
  const { currentDatasetDir, currentLabelDir, currentClassNames } = useAppStore();

  // ── COCO 导出 ──
  const [cocoImageDir, setCocoImageDir] = useState(currentDatasetDir);
  const [cocoLabelDir, setCocoLabelDir] = useState(currentLabelDir);
  const [cocoOutput, setCocoOutput] = useState("");
  const [cocoClassNames, setCocoClassNames] = useState(currentClassNames.join(", "));
  const [cocoLoading, setCocoLoading] = useState(false);
  const [cocoResult, setCocoResult] = useState<{ success: boolean; message: string; total_images?: number; total_annotations?: number } | null>(null);

  const sidebarEl = useSidebarEl();

  const handleExportCoco = async () => {
    if (!cocoOutput) {
      setCocoResult({ success: false, message: t('convert.noOutputPath') });
      return;
    }
    setCocoLoading(true);
    setCocoResult(null);
    try {
      const names = cocoClassNames.trim()
        ? cocoClassNames.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const res = await api.exportCoco({
        image_dir: cocoImageDir,
        label_dir: cocoLabelDir,
        output_path: cocoOutput,
        class_names: names,
      }) as typeof cocoResult;
      setCocoResult(res);
    } catch (e) {
      setCocoResult({ success: false, message: String(e) });
    } finally {
      setCocoLoading(false);
    }
  };

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">

      {/* ── COCO JSON 导出 ── */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        <h2 className="font-semibold text-sm flex items-center gap-2">
          <FileJson className="w-4 h-4" />
          {t('convert.exportCoco')}
        </h2>
        <div className="space-y-5">
          <PathInput label={t('common.imageDir')} value={cocoImageDir} onChange={setCocoImageDir}
            onBrowse={async () => { const d = await browseDirectory(); if (d) setCocoImageDir(d); }} />
          <PathInput label={t('common.labelDir')} value={cocoLabelDir} onChange={setCocoLabelDir}
            onBrowse={async () => { const d = await browseDirectory(); if (d) setCocoLabelDir(d); }} />
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>{t('convert.outputFile')}</label>
            <input
              className="flex-1 px-3 py-2.5 rounded-md text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
              value={cocoOutput}
              onChange={(e) => setCocoOutput(e.target.value)}
              placeholder="e.g. D:\dataset\annotations.json"
            />
            <button
              className="flex items-center gap-1 px-3 py-2.5 rounded-md text-sm flex-shrink-0"
              style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))" }}
              onClick={async () => {
                const f = await browseSaveFile([{ name: "JSON", extensions: ["json"] }]);
                if (f) setCocoOutput(f);
              }}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              {t('common.saveAs')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>{t('convert.classNames')}</label>
            <input
              className="flex-1 px-3 py-2.5 rounded-md text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
              value={cocoClassNames}
              onChange={(e) => setCocoClassNames(e.target.value)}
              placeholder={t('convert.cocoClassNamesPlaceholder')}
            />
          </div>
        </div>
        <button
          className="flex items-center gap-2 px-5 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
          style={{ background: "hsl(var(--primary))", color: "#fff" }}
          onClick={handleExportCoco}
          disabled={cocoLoading || !cocoImageDir || !cocoLabelDir}
        >
          {cocoLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {cocoLoading ? t('convert.exporting') : t('convert.export')}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      <div className="space-y-6">
        {cocoResult && (
          <div
            className="px-4 py-3 rounded-md text-sm"
            style={{
              background: cocoResult.success ? "hsl(var(--success) / 0.1)" : "hsl(var(--destructive) / 0.1)",
              border: `1px solid ${cocoResult.success ? "hsl(var(--success) / 0.3)" : "hsl(var(--destructive) / 0.3)"}`,
              color: cocoResult.success ? "hsl(var(--success))" : "hsl(var(--destructive))",
            }}
          >
            {cocoResult.message}
            {cocoResult.success && cocoResult.total_images !== undefined && (
              <span className="ml-2 opacity-70">
                ({cocoResult.total_images} {t('convert.items')} {t('convert.cocoImagesLabel')}, {cocoResult.total_annotations} {t('convert.cocoAnnotationsLabel')})
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
