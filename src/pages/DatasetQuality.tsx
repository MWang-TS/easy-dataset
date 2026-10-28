/**
 * DatasetQuality.tsx
 * 数据集质量检测页面：加载数据集，展示统计摘要、类别分布、问题文件列表。
 */
import { useState } from "react";
import {
  FolderOpen, BarChart2, AlertTriangle, RefreshCw, ChevronDown, ChevronUp,
  CircleHelp, Download, Clock, X, History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore, type AnalysisRecord } from "@/lib/store";
import { browseDirectory, browseFile, browseSaveFile, writeTextFile, api } from "@/lib/tauri-bridge";
import type { DatasetAnalysis } from "@/lib/store";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

function Panel({
  title,
  tooltip,
  children,
  action,
}: {
  title: string;
  tooltip?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section
      className="rounded-md p-4 lg:p-5"
      style={{
        background: "hsl(var(--card))",
        border: "1px solid hsl(var(--border))",
        boxShadow: "var(--shadow-soft)",
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em]"
            style={{ color: "hsl(var(--muted-foreground))" }}>
            {title}
          </div>
          {tooltip && (
            <span title={tooltip} style={{ color: "hsl(var(--muted-foreground))" }}>
              <CircleHelp className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warning";
}) {
  const toneStyles = {
    default: {
      valueColor: "hsl(var(--foreground))",
      glow: "rgba(56, 189, 248, 0.10)",
    },
    success: {
      valueColor: "hsl(var(--success))",
      glow: "rgba(34, 197, 94, 0.12)",
    },
    warning: {
      valueColor: "hsl(var(--warning))",
      glow: "rgba(245, 158, 11, 0.14)",
    },
  } as const;

  const currentTone = toneStyles[tone];

  return (
    <div
      className="rounded-md p-4"
      style={{
        background: `linear-gradient(180deg, ${currentTone.glow}, rgba(255, 255, 255, 0.01))`,
        border: "1px solid hsl(var(--border))",
      }}
    >
      <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</div>
      <div className="text-[26px] font-semibold leading-none mt-3" style={{ color: currentTone.valueColor }}>{value}</div>
    </div>
  );
}

function PathInput({ label, value, onChange, onBrowse }: {
  label: string; value: string; onChange: (v: string) => void; onBrowse: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</label>
      <div className="flex gap-1.5">
        <input
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{
            background: "hsl(var(--muted))",
            border: "1px solid hsl(var(--border))",
            color: "hsl(var(--foreground))",
          }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`${label}...`}
        />
        <button
          className="flex-shrink-0 px-2.5 py-2 rounded-md"
          style={{
            background: "hsl(var(--muted))",
            border: "1px solid hsl(var(--border))",
            color: "hsl(var(--muted-foreground))",
          }}
          onClick={onBrowse}
          title={t('common.browse')}
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function FileList({ title, paths }: { title: string; paths: string[] }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="text-xs mb-2" style={{ color: "hsl(var(--muted-foreground))" }}>
        {title}（{paths.length} {t('common.items')}）
      </div>
      <div
        className="rounded-md p-3 max-h-32 overflow-y-auto"
        style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid hsl(var(--border) / 0.75)" }}
      >
        {paths.map((p) => (
          <div key={p} className="text-xs py-1 font-mono truncate" style={{ color: "hsl(var(--muted-foreground))" }}>{p}</div>
        ))}
      </div>
    </div>
  );
}

interface HistBucket {
  range: string;
  count: number;
  ratio: number;
}

interface HistResult {
  area_histogram: HistBucket[];
  aspect_histogram: HistBucket[];
  total_boxes: number;
}

function BarHistogram({ data, colorBase }: { data: HistBucket[]; colorBase: number }) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="space-y-2">
      {data.map((bucket, i) => {
        const pct = (bucket.count / maxCount) * 100;
        return (
          <div key={bucket.range} className="flex items-center gap-3">
            <span className="w-20 text-xs flex-shrink-0 text-right" style={{ color: "hsl(var(--muted-foreground))" }}>
              {bucket.range}
            </span>
            <div className="flex-1 h-5 rounded overflow-hidden" style={{ background: "hsl(var(--muted))" }}>
              <div
                className="h-full rounded transition-all"
                style={{
                  width: `${pct}%`,
                  background: `hsl(${(colorBase + i * 30) % 360} 65% 55%)`,
                  minWidth: bucket.count > 0 ? 4 : 0,
                }}
              />
            </div>
            <span className="w-24 text-xs text-right" style={{ color: "hsl(var(--muted-foreground))" }}>
              {bucket.count} ({(bucket.ratio * 100).toFixed(1)}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function DatasetQuality() {
  const { t } = useTranslation();
  const {
    currentDatasetDir, currentLabelDir, currentYamlPath, setDatasetContext,
    analysisHistory, addAnalysisRecord, removeAnalysisRecord,
  } = useAppStore();

  const [imageDir, setImageDir] = useState(currentDatasetDir);
  const [labelDir, setLabelDir] = useState(currentLabelDir);
  const [yamlPath, setYamlPath] = useState(currentYamlPath);
  const [loadMode, setLoadMode] = useState<"manual" | "yaml">("manual");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DatasetAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOrphans, setShowOrphans] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [histResult, setHistResult] = useState<HistResult | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [showAreaHist, setShowAreaHist] = useState(true);
  const [showAspectHist, setShowAspectHist] = useState(true);
  const sidebarEl = useSidebarEl();

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    setHistResult(null);
    try {
      const res = await api.analyzeDataset({
        image_dir: loadMode === "manual" ? imageDir : "",
        label_dir: loadMode === "manual" ? labelDir : "",
        yaml_path: loadMode === "yaml" ? yamlPath : "",
      }) as { success: boolean; message?: string } & DatasetAnalysis;

      if (!res.success) { setError(res.message || t('quality.analyzing')); return; }
      setResult(res);
      setDatasetContext({ imageDir: res.image_dir, labelDir: res.label_dir, classNames: res.class_names });

      // 保存到历史记录
      const source = loadMode === "yaml" ? yamlPath : imageDir;
      const label = source.split(/[\\/]/).pop() || source;
      const record: AnalysisRecord = {
        id: String(Date.now()),
        timestamp: Date.now(),
        label,
        source,
        mode: loadMode,
        result: res,
      };
      addAnalysisRecord(record);

      // 分析完成后自动生成标注框分布图表
      setHistLoading(true);
      api.bboxHistogram({ label_dir: res.label_dir })
        .then((hr) => { const h = hr as { success: boolean } & HistResult; if (h.success) setHistResult(h); })
        .catch(() => {})
        .finally(() => setHistLoading(false));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!result) return;
    setExporting(true);
    try {
      const datasetName = result.image_dir.split(/[\\/]/).slice(-2, -1)[0] || "dataset";
      const date = new Date().toISOString().slice(0, 10);
      const defaultName = `${datasetName}_analysis_${date}.json`;
      const savePath = await browseSaveFile(
        [{ name: "JSON", extensions: ["json"] }],
        defaultName
      );
      if (!savePath) return;
      await writeTextFile(savePath, JSON.stringify(result, null, 2));
    } catch (e) {
      console.error("导出失败", e);
    } finally {
      setExporting(false);
    }
  };

  const handleLoadHistory = (record: AnalysisRecord) => {
    setResult(record.result);
    setError(null);
    if (record.mode === "yaml") {
      setLoadMode("yaml");
      setYamlPath(record.source);
    } else {
      setLoadMode("manual");
      setImageDir(record.source);
    }
    setDatasetContext({
      imageDir: record.result.image_dir,
      labelDir: record.result.label_dir,
      classNames: record.result.class_names,
    });
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - ts;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 1) return t('quality.yesterday') + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  };

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">
      <Panel title={t('quality.loadMode')} tooltip={t('quality.loadModeTooltip')}>
          <div className="grid grid-cols-2 gap-2">
            {(["manual", "yaml"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setLoadMode(m)}
                className="py-3 rounded-md text-sm transition-all"
                style={{
                  background: loadMode === m ? "hsl(var(--primary))" : "hsl(var(--muted))",
                  color: loadMode === m ? "white" : "hsl(var(--muted-foreground))",
                  border: "1px solid hsl(var(--border))",
                  fontWeight: loadMode === m ? 600 : 500,
                }}
              >
                {m === "manual" ? t('quality.modeManual') : t('quality.modeYaml')}
              </button>
            ))}
          </div>
        </Panel>

        <Panel title={t('quality.dataPaths')} tooltip={t('quality.dataPathsTooltip')}>
          {loadMode === "manual" ? (
            <div className="space-y-4">
              <PathInput label={t('common.imageDir')} value={imageDir} onChange={setImageDir}
                onBrowse={async () => { const d = await browseDirectory(); if (d) setImageDir(d); }} />
              <PathInput label={t('common.labelDir')} value={labelDir} onChange={setLabelDir}
                onBrowse={async () => { const d = await browseDirectory(); if (d) setLabelDir(d); }} />
            </div>
          ) : (
            <PathInput label="data.yaml" value={yamlPath} onChange={setYamlPath}
              onBrowse={async () => {
                const f = await browseFile([{ name: "YAML", extensions: ["yaml", "yml"] }]);
                if (f) setYamlPath(f);
              }} />
          )}
        </Panel>

        <Panel title={t('quality.runAnalysis')} tooltip={t('quality.runAnalysisTooltip')}>
          <button
            className="w-full flex items-center justify-center gap-2 py-3 rounded-md text-sm font-semibold disabled:opacity-50"
            style={{
              background: "hsl(var(--primary))",
              color: "white",
            }}
            onClick={handleAnalyze}
            disabled={loading}
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <BarChart2 className="w-4 h-4" />}
            {loading ? t('quality.analyzing') : t('quality.analyze')}
          </button>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
            <div className="rounded-md px-3 py-2" style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}>
              {t('quality.loadModeLabel')}
              <div className="mt-1 text-sm" style={{ color: "hsl(var(--foreground))" }}>{loadMode === "manual" ? t('quality.modeManual') : t('quality.modeYaml')}</div>
            </div>
            <div className="rounded-md px-3 py-2" style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}>
              {t('quality.resultStatus')}
              <div className="mt-1 text-sm" style={{ color: error ? "hsl(var(--destructive))" : "hsl(var(--foreground))" }}>
                {error ? t('quality.resultFailed') : result ? t('quality.resultReady') : t('quality.resultPending')}
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-md px-3 py-3 text-xs mt-4" style={{ background: "hsl(var(--destructive) / 0.12)", color: "hsl(var(--destructive))", border: "1px solid hsl(var(--destructive) / 0.3)" }}>
              {error}
            </div>
          )}
        </Panel>

        {/* 历史记录 */}
        {analysisHistory.length > 0 && (
          <div>
            <div className="flex items-center gap-2 px-1 mb-2">
              <History className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: "hsl(var(--muted-foreground))" }}>
                {t('quality.history')}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {analysisHistory.map((rec) => (
                <div
                  key={rec.id}
                  className="group flex items-center gap-2 rounded-md px-3 py-2.5 cursor-pointer transition-colors"
                  style={{
                    background: result === rec.result ? "hsl(var(--primary) / 0.12)" : "hsl(var(--muted))",
                    border: `1px solid ${result === rec.result ? "hsl(var(--primary) / 0.4)" : "hsl(var(--border))"}`,
                  }}
                  onClick={() => handleLoadHistory(rec)}
                >
                  <BarChart2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: "hsl(var(--primary))" }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate" style={{ color: "hsl(var(--foreground))" }}>{rec.label}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Clock className="w-2.5 h-2.5" style={{ color: "hsl(var(--muted-foreground))" }} />
                      <span className="text-[10px]" style={{ color: "hsl(var(--muted-foreground))" }}>{formatTime(rec.timestamp)}</span>
                      <span className="text-[10px]" style={{ color: "hsl(var(--muted-foreground))" }}>· {rec.result.summary.total_images} 张</span>
                    </div>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded"
                    style={{ color: "hsl(var(--muted-foreground))" }}
                    onClick={(e) => { e.stopPropagation(); removeAnalysisRecord(rec.id); }}
                    title={t('quality.deleteRecord')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      <div className="space-y-5">
        {!result && !loading && (
          <Panel title={t('quality.waitTitle')} tooltip={t('quality.waitTooltip')}>
            <div
              className="rounded-md min-h-[320px] flex flex-col items-center justify-center text-center px-6"
              style={{
                background: "hsl(var(--muted))",
                border: "1px dashed hsl(var(--border))",
                color: "hsl(var(--muted-foreground))",
              }}
            >
              <div className="w-14 h-14 rounded-md flex items-center justify-center"
                style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
                <BarChart2 className="w-7 h-7" />
              </div>
              <div className="mt-4 text-base font-semibold" style={{ color: "hsl(var(--foreground))" }}>{t('quality.waitHint')}</div>
            </div>
          </Panel>
        )}

        {loading && (
          <Panel title={t('quality.analyzingTitle')} tooltip={t('quality.analyzingTooltip')}>
            <div className="rounded-md min-h-[220px] flex flex-col items-center justify-center"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}>
              <RefreshCw className="w-8 h-8 animate-spin" style={{ color: "hsl(var(--primary))" }} />
              <div className="mt-4 text-base font-medium">{t('quality.analyzingHint')}</div>
            </div>
          </Panel>
        )}

        {result && (
          <>
            <Panel
              title={t('quality.resultTitle')}
              tooltip={t('quality.resultTooltip')}
              action={
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50 transition-colors"
                  style={{
                    background: "hsl(var(--muted))",
                    border: "1px solid hsl(var(--border))",
                    color: "hsl(var(--muted-foreground))",
                  }}
                  title={t('quality.exportTooltip')}
                >
                  {exporting
                    ? <RefreshCw className="w-3 h-3 animate-spin" />
                    : <Download className="w-3 h-3" />}
                  {exporting ? t('quality.exporting') : t('quality.exportReport')}
                </button>
              }
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <StatCard label={t('quality.totalImages')} value={result.summary.total_images} />
                <StatCard label={t('quality.totalLabels')} value={result.summary.total_labels} />
                <StatCard label={t('quality.totalBoxes')} value={result.summary.total_boxes} />
                <StatCard label={t('quality.numClasses')} value={result.summary.num_classes} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-3">
                <StatCard label={t('quality.matchedPairs')} value={result.summary.matched_pairs} tone="success" />
                <StatCard label={t('quality.orphanImages')} value={result.summary.orphan_images} tone={result.summary.orphan_images > 0 ? "warning" : "default"} />
                <StatCard label={t('quality.orphanLabels')} value={result.summary.orphan_labels} tone={result.summary.orphan_labels > 0 ? "warning" : "default"} />
                <StatCard label={t('quality.emptyLabels')} value={result.summary.empty_labels} tone={result.summary.empty_labels > 0 ? "warning" : "default"} />
              </div>
            </Panel>

            {result.class_distribution.length > 0 && (
              <Panel title={t('quality.classDistribution')} tooltip={t('quality.classDistributionTooltip')}>
                <div className="space-y-2">
                  {result.class_distribution.map((cls) => {
                    const pct = result.summary.total_boxes > 0
                      ? (cls.count / result.summary.total_boxes) * 100 : 0;
                    return (
                      <div
                        key={cls.id}
                        className="grid grid-cols-[36px_minmax(88px,144px)_minmax(0,1fr)_84px] items-center gap-3 rounded-md px-3 py-3"
                        style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                      >
                        <span className="text-xs text-right flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>{cls.id}</span>
                        <span className="text-sm truncate flex-shrink-0">{cls.name}</span>
                        <div className="h-4 rounded-full overflow-hidden" style={{ background: "hsl(var(--muted))" }}>
                          <div className="h-full rounded-full" style={{
                            width: `${pct}%`,
                            background: `hsl(${(cls.id * 47 + 200) % 360} 70% 55%)`,
                            minWidth: pct > 0 ? 4 : 0,
                          }} />
                        </div>
                        <span className="text-xs text-right flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>
                          {cls.count} ({pct.toFixed(1)}%)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Panel title={t('quality.imageSizeTitle')} tooltip={t('quality.imageSizeTooltip')}>
                <div className="rounded-md overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
                  {[
                    ["平均宽度", `${result.image_size_stats.avg_width} px`],
                    ["平均高度", `${result.image_size_stats.avg_height} px`],
                    ["宽度范围", `${result.image_size_stats.min_width} ~ ${result.image_size_stats.max_width} px`],
                    ["高度范围", `${result.image_size_stats.min_height} ~ ${result.image_size_stats.max_height} px`],
                  ].map(([k, v], i) => (
                    <div key={String(k)} className={cn("flex justify-between px-4 py-3 text-sm", i > 0 && "border-t")}
                      style={{ borderColor: "hsl(var(--border))", background: i % 2 === 0 ? "rgba(255, 255, 255, 0.02)" : "transparent" }}>
                      <span style={{ color: "hsl(var(--muted-foreground))" }}>{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title={t('quality.bboxStatsTitle')} tooltip={t('quality.bboxStatsTooltip')}>
                <div className="rounded-md overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
                  {[
                    ["平均面积占比", (result.bbox_stats.avg_area * 100).toFixed(2) + "%"],
                    ["平均宽高比", result.bbox_stats.avg_aspect.toFixed(2)],
                    ["小目标 (<0.5%面积)", result.bbox_stats.small_objects],
                    ["大目标 (>10%面积)", result.bbox_stats.large_objects],
                  ].map(([k, v], i) => (
                    <div key={String(k)} className={cn("flex justify-between px-4 py-3 text-sm", i > 0 && "border-t")}
                      style={{ borderColor: "hsl(var(--border))", background: i % 2 === 0 ? "rgba(255, 255, 255, 0.02)" : "transparent" }}>
                      <span style={{ color: "hsl(var(--muted-foreground))" }}>{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            {/* 标注框分布图表 — 分析完成后自动生成 */}
            {(histLoading || histResult) && (
              <Panel title={t('quality.bboxDistribution')} tooltip={t('quality.bboxDistributionTooltip')}>
                {histLoading ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    {t('quality.histLoading')}
                  </div>
                ) : histResult ? (
                  <div className="space-y-4">
                    <div className="text-sm">{t('quality.totalBoxesLabel', { count: histResult.total_boxes.toLocaleString() })}</div>
                    {histResult.area_histogram.length > 0 && (
                      <div className="rounded-md overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
                        <button className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold" style={{ background: "hsl(var(--muted))" }} onClick={() => setShowAreaHist(!showAreaHist)}>
                          <span>{t('quality.areaHistTitle')}</span>
                          {showAreaHist ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {showAreaHist && <div className="p-4" style={{ background: "hsl(var(--card))" }}><BarHistogram data={histResult.area_histogram} colorBase={210} /></div>}
                      </div>
                    )}
                    {histResult.aspect_histogram.length > 0 && (
                      <div className="rounded-md overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
                        <button className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold" style={{ background: "hsl(var(--muted))" }} onClick={() => setShowAspectHist(!showAspectHist)}>
                          <span>{t('quality.aspectHistTitle')}</span>
                          {showAspectHist ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {showAspectHist && <div className="p-4" style={{ background: "hsl(var(--card))" }}><BarHistogram data={histResult.aspect_histogram} colorBase={140} /></div>}
                      </div>
                    )}
                  </div>
                ) : null}
              </Panel>
            )}

            {(result.orphan_image_paths.length > 0 || result.orphan_label_paths.length > 0 || result.empty_label_paths.length > 0) && (
              <Panel title={t('quality.issueFiles')} tooltip={t('quality.issueFilesTooltip')}>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                  <StatCard label={t('quality.orphanImages')} value={result.orphan_image_paths.length} tone={result.orphan_image_paths.length > 0 ? "warning" : "default"} />
                  <StatCard label={t('quality.orphanLabels')} value={result.orphan_label_paths.length} tone={result.orphan_label_paths.length > 0 ? "warning" : "default"} />
                  <StatCard label={t('quality.emptyLabels')} value={result.empty_label_paths.length} tone={result.empty_label_paths.length > 0 ? "warning" : "default"} />
                </div>

                <div className="rounded-md overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
                  <button
                    className="w-full flex items-center justify-between px-4 py-3 text-sm"
                    style={{ background: "hsl(var(--muted))" }}
                    onClick={() => setShowOrphans(!showOrphans)}
                  >
                    <span className="flex items-center gap-1.5" style={{ color: "hsl(var(--warning))" }}>
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {t('quality.issueFilesFound')}
                    </span>
                    {showOrphans ? <ChevronUp className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />
                      : <ChevronDown className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />}
                  </button>
                  {showOrphans && (
                    <div className="p-4 space-y-4">
                      {result.orphan_image_paths.length > 0 && <FileList title={t('quality.orphanImageFiles')} paths={result.orphan_image_paths} />}
                      {result.orphan_label_paths.length > 0 && <FileList title={t('quality.orphanLabelFiles')} paths={result.orphan_label_paths} />}
                      {result.empty_label_paths.length > 0 && <FileList title={t('quality.emptyLabelFiles')} paths={result.empty_label_paths} />}
                    </div>
                  )}
                </div>
              </Panel>
            )}
          </>
        )}
      </div>
    </>
  );
}

