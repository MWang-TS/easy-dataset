/**
 * VideoFrameExtractor.tsx
 * 视频抽帧页：普通抽帧 + AI智能抽帧（YOLOv8 推理，仅保留含目标类别的帧）
 */
import { useState, useRef, useEffect } from "react";
import { Film, FolderOpen, RefreshCw, Info, Square, Cpu } from "lucide-react";
import { browseFile, browseDirectory, api } from "@/lib/tauri-bridge";
import { ResultBox } from "@/components/ResultBox";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";

interface VideoInfo {
  fps: number;
  total_frames: number;
  width: number;
  height: number;
  duration: number;
}

function DirInput({
  label, value, onChange, onBrowse,
}: {
  label: string; value: string; onChange: (v: string) => void; onBrowse: () => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
        style={{ color: "hsl(var(--muted-foreground))" }}>{label}</label>
      <div className="flex gap-1.5">
        <input
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`请输入${label}路径`}
        />
        <button
          className="px-2.5 py-2 rounded-md flex-shrink-0 flex items-center"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
          onClick={onBrowse}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function VideoFrameExtractor() {
  // ── 共用 ──
  const [mode, setMode] = useState<"normal" | "ai">("normal");
  const [videoPath, setVideoPath] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [intervalFrames, setIntervalFrames] = useState(30);
  const [format, setFormat] = useState<"jpg" | "png">("jpg");
  const [quality, setQuality] = useState(95);
  const [prefix, setPrefix] = useState("frame");

  // ── 普通模式 ──
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  // ── AI 模式 ──
  const [modelPath, setModelPath] = useState("");
  const [targetClasses, setTargetClasses] = useState("person");
  const [confThreshold, setConfThreshold] = useState(0.25);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [aiUnavailableMsg, setAiUnavailableMsg] = useState("");
  const [aiChecking, setAiChecking] = useState(false);

  // ── 并行参数（共用） ──
  const [numWorkers, setNumWorkers] = useState(4);
  const [batchSize, setBatchSize] = useState(8);
  // AI 分段模式
  const [segmentMode, setSegmentMode] = useState(false);
  const [segmentMinutes, setSegmentMinutes] = useState(60);
  const [maxParallel, setMaxParallel] = useState(2);

  // ── 任务状态 ──
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; saved: number; total: number; splitPct?: number; taskState?: string } | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string; saved_count?: number } | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sidebarEl = useSidebarEl();

  // 切到 AI 模式时检查环境
  const checkAiEnv = async () => {
    setAiChecking(true);
    setAiAvailable(null);
    try {
      const res = await api.videoAiCheck();
      setAiAvailable(res.available);
      if (!res.available) setAiUnavailableMsg(res.message || "ultralytics 未安装");
      if (res.default_model && !modelPath) setModelPath(res.default_model);
    } catch {
      setAiAvailable(false);
      setAiUnavailableMsg("无法连接后端，请确认后端已启动后点击重试");
    } finally {
      setAiChecking(false);
    }
  };

  useEffect(() => {
    if (mode !== "ai") return;
    checkAiEnv();
  }, [mode]);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoadInfo = async () => {
    if (!videoPath) return;
    setInfoLoading(true);
    setInfoError(null);
    setVideoInfo(null);
    try {
      const res = await api.videoInfo({ video_path: videoPath }) as { success: boolean; message?: string } & VideoInfo;
      if (!res.success) { setInfoError(res.message || "读取失败"); return; }
      setVideoInfo(res);
    } catch (e) {
      setInfoError(String(e));
    } finally {
      setInfoLoading(false);
    }
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleStop = async () => {
    if (!taskIdRef.current) return;
    try {
      if (mode === "ai") {
        await api.videoAiStopExtract({ task_id: taskIdRef.current });
      } else {
        await api.videoStopExtract({ task_id: taskIdRef.current });
      }
    } catch {
      // 忽略，轮询会检测到停止状态
    }
  };

  const startPolling = (taskId: string, isAi: boolean) => {
    pollTimerRef.current = setInterval(async () => {
      try {
        const status = isAi
          ? await api.videoAiExtractStatus({ task_id: taskId })
          : await api.videoExtractStatus({ task_id: taskId });
        if (!status.success) return;

        const total = status.total_frames ?? 0;
        const saved = status.saved ?? 0;
        const processed = (status as { processed?: number; split_progress?: number }).processed ?? saved;
        const splitPct = (status as { split_progress?: number }).split_progress;
        const taskState = (status as { state?: string }).state;
        // 任何阶段都更新进度卡（splitting/loading/running）
        setProgress({ processed, saved, total, splitPct, taskState });

        if (status.state === "done" || status.state === "stopped" || status.state === "error") {
          stopPolling();
          setLoading(false);
          setProgress(null);
          const r = status.result as { success: boolean; message: string; saved_count?: number } | undefined;
          if (r) {
            setResult(r);
            if (r.success && !isAi) setVideoInfo(null);
          }
        }
      } catch {
        // 网络抖动，继续轮询
      }
    }, 800);
  };

  const handleExtract = async () => {
    if (!videoPath || !outputDir) return;
    setLoading(true);
    setResult(null);
    setProgress(null);
    taskIdRef.current = null;
    stopPolling();

    try {
      let startRes: { success: boolean; task_id?: string; message?: string };
      if (mode === "ai") {
        startRes = await api.videoAiExtractFrames({
          video_path: videoPath,
          output_dir: outputDir,
          target_classes: targetClasses,
          model_path: modelPath,
          conf_threshold: confThreshold,
          interval_frames: intervalFrames,
          format,
          quality,
          prefix: prefix || "ai_frame",
          max_parallel: maxParallel,
          batch_size: batchSize,
          segment_minutes: segmentMode ? segmentMinutes : 0,
        });
      } else {
        startRes = await api.videoExtractFrames({
          video_path: videoPath,
          output_dir: outputDir,
          interval_frames: intervalFrames,
          format,
          quality,
          prefix,
          num_workers: numWorkers,
        });
      }

      if (!startRes.success || !startRes.task_id) {
        setResult({ success: false, message: startRes.message || "启动失败" });
        setLoading(false);
        return;
      }
      const taskId = startRes.task_id;
      taskIdRef.current = taskId;
      startPolling(taskId, mode === "ai");
    } catch (e) {
      setResult({ success: false, message: String(e) });
      setLoading(false);
    }
  };

  // 预估抽帧数量（仅普通模式）
  const estimatedCount = videoInfo
    ? Math.ceil(videoInfo.total_frames / Math.max(1, intervalFrames))
    : null;

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">

      {/* 模式切换 */}
      <div className="flex gap-1.5 p-1 rounded-lg" style={{ background: "hsl(var(--muted))" }}>
        {([["normal", "普通抽帧", Film], ["ai", "AI智能抽帧", Cpu]] as const).map(([m, label, Icon]) => (
          <button
            key={m}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition-all"
            style={{
              background: mode === m ? "hsl(var(--background))" : "transparent",
              color: mode === m ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
              boxShadow: mode === m ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
            onClick={() => { setMode(m); setResult(null); }}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* 视频文件（共用） */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
          style={{ color: "hsl(var(--muted-foreground))" }}>视频文件</label>
        <div className="flex gap-1.5">
          <input
            className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            value={videoPath}
            onChange={(e) => { setVideoPath(e.target.value); setVideoInfo(null); }}
            placeholder="mp4 / avi / mov / mkv / dav …"
          />
          <button
            className="px-2.5 py-2 rounded-md flex-shrink-0 flex items-center"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
            onClick={async () => {
              const f = await browseFile([
                { name: "视频文件", extensions: ["mp4", "avi", "mov", "mkv", "wmv", "flv", "webm", "m4v", "dav"] },
              ]);
              if (f) { setVideoPath(f); setVideoInfo(null); }
            }}
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        </div>
        {mode === "normal" && (
          <button
            className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-40"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            disabled={!videoPath || infoLoading}
            onClick={handleLoadInfo}
          >
            {infoLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Info className="w-3 h-3" />}
            {infoLoading ? "读取中…" : "加载视频信息"}
          </button>
        )}
      </div>

      {/* 输出目录（共用） */}
      <DirInput label="输出目录"
        value={outputDir}
        onChange={setOutputDir}
        onBrowse={async () => { const d = await browseDirectory(); if (d) setOutputDir(d); }}
      />

      {/* 抽帧间隔（共用） */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
          style={{ color: "hsl(var(--muted-foreground))" }}>
          {mode === "ai" ? "采样间隔（帧）" : "抽帧间隔（帧）"}
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number" min={1} max={10000}
            className="w-24 px-3 py-2 rounded-md text-sm"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            value={intervalFrames}
            onChange={(e) => setIntervalFrames(Math.max(1, parseInt(e.target.value) || 1))}
          />
          <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
            每 {intervalFrames} 帧{mode === "ai" ? "送检一次" : "取一张"}
            {videoInfo && mode === "normal" ? `，约 ${(intervalFrames / videoInfo.fps).toFixed(2)}s` : ""}
          </span>
        </div>
      </div>

      {/* 并行线程数（仅普通模式） */}
      {mode === "normal" && (
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
            style={{ color: "hsl(var(--muted-foreground))" }}>
            并行线程数 {numWorkers}
          </label>
          <input
            type="range" min={1} max={16} step={1}
            value={numWorkers}
            onChange={(e) => setNumWorkers(parseInt(e.target.value))}
            className="w-full"
          />
          <p className="text-[11px] mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
            建议 2~8，加速长视频解码；过多对机械盘反而变慢
          </p>
        </div>
      )}

      {/* AI 专属配置 */}
      {mode === "ai" && (
        <>
          {/* 环境状态提示 */}
          {aiChecking && (
            <div className="px-3 py-2 rounded-md text-xs flex items-center gap-2"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
              <RefreshCw className="w-3 h-3 animate-spin flex-shrink-0" />
              正在检测环境…
            </div>
          )}
          {!aiChecking && aiAvailable === false && (
            <div className="px-3 py-2 rounded-md text-xs space-y-1.5"
              style={{ background: "hsl(var(--destructive) / 0.1)", border: "1px solid hsl(var(--destructive) / 0.3)", color: "hsl(var(--destructive))" }}>
              <p>⚠ {aiUnavailableMsg}</p>
              <button
                className="underline underline-offset-2 text-xs font-medium"
                onClick={checkAiEnv}
              >点击重试</button>
            </div>
          )}
          {!aiChecking && aiAvailable === true && (
            <div className="px-3 py-2 rounded-md text-xs"
              style={{ background: "hsl(var(--primary) / 0.08)", border: "1px solid hsl(var(--primary) / 0.3)", color: "hsl(var(--primary))" }}>
              ✓ ultralytics 可用，AI 抽帧就绪
            </div>
          )}

          {/* 模型路径 */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
              style={{ color: "hsl(var(--muted-foreground))" }}>YOLOv8 模型</label>
            <div className="flex gap-1.5">
              <input
                className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                value={modelPath}
                onChange={(e) => setModelPath(e.target.value)}
                placeholder="yolov8m.pt 路径"
              />
              <button
                className="px-2.5 py-2 rounded-md flex-shrink-0 flex items-center"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                onClick={async () => {
                  const f = await browseFile([{ name: "YOLO 模型", extensions: ["pt"] }]);
                  if (f) setModelPath(f);
                }}
              >
                <FolderOpen className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 目标类别 */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
              style={{ color: "hsl(var(--muted-foreground))" }}>目标类别</label>
            <input
              className="w-full px-3 py-2 rounded-md text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
              value={targetClasses}
              onChange={(e) => setTargetClasses(e.target.value)}
              placeholder="person, car, bicycle …"
            />
            <p className="text-[11px] mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
              多个类别用逗号分隔，类名与 COCO 标签一致
            </p>
          </div>

          {/* 置信度阈值 */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
              style={{ color: "hsl(var(--muted-foreground))" }}>置信度阈值 {confThreshold.toFixed(2)}</label>
            <input
              type="range" min={0.05} max={0.95} step={0.05}
              value={confThreshold}
              onChange={(e) => setConfThreshold(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          {/* 分段并行配置 */}
          <div className="p-3 rounded-lg space-y-3" style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold">分段并行模式</p>
                <p className="text-[11px] mt-0.5" style={{ color: "hsl(var(--muted-foreground))" }}>
                  先切段再并行，解决超长视频 seek 竞争问题
                </p>
              </div>
              <button
                className="relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0"
                style={{ background: segmentMode ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.3)" }}
                onClick={() => setSegmentMode(v => !v)}
              >
                <span
                  className="absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
                  style={{ left: segmentMode ? "calc(100% - 20px)" : "4px" }}
                />
              </button>
            </div>
            {segmentMode ? (
              <>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1"
                    style={{ color: "hsl(var(--muted-foreground))" }}>每段时长 {segmentMinutes} 分钟</label>
                  <input type="range" min={10} max={120} step={10}
                    value={segmentMinutes}
                    onChange={(e) => setSegmentMinutes(parseInt(e.target.value))}
                    className="w-full"
                  />
                  <p className="text-[11px] mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
                    24h 视频建议 60 min/段，共 24 段
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1"
                    style={{ color: "hsl(var(--muted-foreground))" }}>最大并行段数 {maxParallel}</label>
                  <input type="range" min={1} max={8} step={1}
                    value={maxParallel}
                    onChange={(e) => setMaxParallel(parseInt(e.target.value))}
                    className="w-full"
                  />
                  <p className="text-[11px] mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
                    每段独立加载模型；GPU 内存充裕时设 2~4，内存有限设 1
                  </p>
                </div>
              </>
            ) : (
              <p className="text-[11px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                关闭时使用单路 pipeline 模式（单个完整视频顺序读取 + 批量推理）
              </p>
            )}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1"
                style={{ color: "hsl(var(--muted-foreground))" }}>批量推理大小 {batchSize}</label>
              <input type="range" min={1} max={16} step={1}
                value={batchSize}
                onChange={(e) => setBatchSize(parseInt(e.target.value))}
                className="w-full"
              />
              <p className="text-[11px] mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
                每次送入 GPU 的帧数；显存充足时调大可提升吞吐
              </p>
            </div>
          </div>
        </>
      )}

      {/* 输出格式（共用） */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
          style={{ color: "hsl(var(--muted-foreground))" }}>输出格式</label>
        <div className="flex gap-2">
          {(["jpg", "png"] as const).map((f) => (
            <button key={f}
              className="flex-1 py-1.5 rounded text-sm font-medium"
              style={{
                background: format === f ? "hsl(var(--primary) / 0.12)" : "hsl(var(--muted))",
                border: `1px solid ${format === f ? "hsl(var(--primary))" : "hsl(var(--border))"}`,
                color: format === f ? "hsl(var(--primary))" : "hsl(var(--foreground))",
              }}
              onClick={() => setFormat(f)}
            >{f.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* JPEG 质量（共用） */}
      {format === "jpg" && (
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
            style={{ color: "hsl(var(--muted-foreground))" }}>JPEG 质量 {quality}</label>
          <input type="range" min={50} max={100} step={1}
            value={quality}
            onChange={(e) => setQuality(parseInt(e.target.value))}
            className="w-full"
          />
        </div>
      )}

      {/* 文件名前缀（共用） */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
          style={{ color: "hsl(var(--muted-foreground))" }}>文件名前缀</label>
        <input
          className="w-full px-3 py-2 rounded-md text-sm"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          value={prefix}
          placeholder={mode === "ai" ? "ai_frame" : "frame"}
          onChange={(e) => setPrefix(e.target.value)}
        />
      </div>

      {/* 开始/停止按钮 */}
      <div className="flex gap-2">
        <button
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-semibold disabled:opacity-50"
          style={{ background: "hsl(var(--primary))", color: "#fff" }}
          onClick={handleExtract}
          disabled={loading || !videoPath || !outputDir || (mode === "ai" && aiAvailable === false)}
        >
          {loading
            ? <RefreshCw className="w-4 h-4 animate-spin" />
            : mode === "ai" ? <Cpu className="w-4 h-4" /> : <Film className="w-4 h-4" />}
          {loading
            ? progress
              ? mode === "ai"
                ? progress.splitPct != null
                  ? `切段中… ${progress.splitPct.toFixed(0)}%`
                  : `AI检测中… 已保留 ${progress.saved} 张`
                : `抽帧中… ${progress.saved}/${progress.total}`
              : mode === "ai" ? "AI检测中…" : "抽帧中…"
            : mode === "ai" ? "开始AI抽帧" : "开始抽帧"}
        </button>
        {loading && (
          <button
            className="px-3 py-2.5 rounded-md text-sm font-semibold flex items-center gap-1.5"
            style={{ background: "hsl(var(--destructive) / 0.12)", border: "1px solid hsl(var(--destructive) / 0.4)", color: "hsl(var(--destructive))" }}
            onClick={handleStop}
          >
            <Square className="w-4 h-4" />
            停止
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}

      <div className="space-y-4">
        {/* 视频信息卡片（普通模式） */}
        {mode === "normal" && infoError && (
          <div className="px-4 py-3 rounded-md text-sm"
            style={{ background: "hsl(var(--destructive) / 0.1)", border: "1px solid hsl(var(--destructive) / 0.3)", color: "hsl(var(--destructive))" }}>
            {infoError}
          </div>
        )}

        {mode === "normal" && videoInfo && (
          <div className="rounded-md p-4 space-y-3"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Film className="w-4 h-4" style={{ color: "hsl(var(--primary))" }} />
              视频信息
            </h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {[
                ["分辨率", `${videoInfo.width} × ${videoInfo.height}`],
                ["帧率", `${videoInfo.fps} fps`],
                ["总帧数", videoInfo.total_frames.toLocaleString()],
                ["时长", `${videoInfo.duration}s`],
                ["当前间隔", `每 ${intervalFrames} 帧`],
                ["预计抽出", `${estimatedCount?.toLocaleString()} 张`],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>{k}</span>
                  <span className="font-mono font-medium">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI 进度卡片 */}
        {mode === "ai" && loading && (
          <div className="rounded-md p-4 space-y-3"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Cpu className="w-4 h-4 animate-pulse" style={{ color: "hsl(var(--primary))" }} />
              AI 检测进度
            </h3>
            {/* 切段进度（ffmpeg 上报 out_time_ms） */}
            {progress?.splitPct != null ? (
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>视频分段切割中</span>
                  <span className="font-mono font-medium">{progress.splitPct.toFixed(0)}%</span>
                </div>
                <div className="w-full rounded-full h-1.5" style={{ background: "hsl(var(--muted))" }}>
                  <div className="h-1.5 rounded-full transition-all"
                    style={{ width: `${progress.splitPct.toFixed(1)}%`, background: "hsl(var(--primary))" }} />
                </div>
                <p className="text-[11px]" style={{ color: "hsl(var(--muted-foreground))" }}>切割完成后自动开始并行推理</p>
              </div>
            ) : !progress || progress.total === 0 ? (
              /* 等待阶段：加载模型 / ffmpeg 切段未上报进度 */
              <div className="flex items-center gap-2 text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
                <RefreshCw className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                {progress?.taskState === "splitting"
                  ? "正在用 ffmpeg 快速切割视频段，请稍候…"
                  : "正在加载模型，请稍候…"}
              </div>
            ) : (
              /* 推理进度 */
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>已处理帧</span>
                  <span className="font-mono font-medium">
                    {progress.processed.toLocaleString()} / {progress.total.toLocaleString()}
                  </span>
                </div>
                <div className="w-full rounded-full h-1.5" style={{ background: "hsl(var(--muted))" }}>
                  <div className="h-1.5 rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (progress.processed / Math.max(1, progress.total)) * 100).toFixed(1)}%`,
                      background: "hsl(var(--primary))"
                    }} />
                </div>
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>已保留图片</span>
                  <span className="font-semibold" style={{ color: "hsl(var(--primary))" }}>{progress.saved} 张</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 结果 */}
        {result && <ResultBox success={result.success} message={result.message} />}
        {result?.success && result.saved_count !== undefined && (
          <div className="px-4 py-3 rounded-md text-sm"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
            <span style={{ color: "hsl(var(--muted-foreground))" }}>共输出图片：</span>
            <span className="font-semibold" style={{ color: "hsl(var(--primary))" }}>
              {result.saved_count.toLocaleString()} 张
            </span>
            <span className="ml-3 text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
              → {outputDir}
            </span>
          </div>
        )}

        {/* 空状态 */}
        {!videoInfo && !result && !infoError && !loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3"
            style={{ color: "hsl(var(--muted-foreground))" }}>
            {mode === "ai"
              ? <Cpu className="w-12 h-12 opacity-20" />
              : <Film className="w-12 h-12 opacity-20" />}
            <p className="text-sm text-center">
              {mode === "ai"
                ? "配置目标类别，点击「开始AI抽帧」\n仅保留画面中含目标的帧"
                : "在左侧选择视频文件并配置参数，点击「开始抽帧」"}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
