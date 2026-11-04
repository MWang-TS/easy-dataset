/**
 * Annotation.tsx
 * 图片标注页面：文件夹级图片浏览 + Canvas 手工标注 + AI 自动预标注 + 数据集导出。
 *
 * 参考 `easy-finetune` 的标注实现，宿主层改为 Flask REST（见 services/annotation_service.py）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FolderOpen, Wand2, Undo2, Redo2, Trash2, ZoomIn, ZoomOut,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Hand, Square, Pentagon, RotateCw, Copy, Download, Tag, PenTool, History,
  RefreshCw, CheckCircle2, AlertTriangle, Save, Loader2, XCircle,
} from "lucide-react";
import { browseDirectory, browseFile, api } from "@/lib/tauri-bridge";
import { cornersOf, degToRad, radToDeg, rotRectFromCorners } from "@/lib/obb";
import { useAppStore } from "@/lib/store";
import { useAnnotationStore, type YoloBox } from "@/lib/annotation-store";
import { useSidebarEl } from "@/lib/sidebar-context";
import AnnotationCanvas, { type CanvasMode } from "@/components/annotate/AnnotationCanvas";
import { useTranslation } from "react-i18next";

const COLORS = ["#ff5c5c", "#4ade80", "#60a5fa", "#facc15", "#e879f9", "#22d3ee", "#fb923c", "#a3e635"];

// ── 最近工作记录（本地持久化，最多 30 条）──
const WORKSPACE_KEY = "eds.annotation.workspaces";
const WORKSPACE_LIMIT = 30;

type WorkspaceMode = "edit" | "new";
type NewLabelType = "detect" | "obb" | "segment";
interface AnnotationWorkspace {
  id: string;
  ts: number;
  mode: WorkspaceMode;
  dir: string;
  labelOut: string;
  imageDir: string;
  labelDir: string;
  /** 全新标注选定的类型（同一工作内不可更改） */
  labelType?: NewLabelType;
  /** 关闭时保存的类别名，重开时作为兜底恢复 */
  classes?: Record<string, string>;
}

function workspaceId(mode: WorkspaceMode, dir: string, labelOut: string, imageDir: string, labelDir: string) {
  return [mode, dir, labelOut, imageDir, labelDir].join("|");
}

function loadWorkspaces(): AnnotationWorkspace[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is AnnotationWorkspace => Boolean(item) && typeof item.dir === "string")
      .slice(0, WORKSPACE_LIMIT);
  } catch {
    return [];
  }
}

function persistWorkspaces(list: AnnotationWorkspace[]) {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, JSON.stringify(list));
  } catch {
    /* 忽略 */
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  // 说明文字用原生 title 提示，避免 hover 时布局上下抽动
  return (
    <div title={hint || undefined}>
      <label
        className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5"
        style={{ color: "hsl(var(--muted-foreground))" }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function PathRow({
  value, onChange, onBrowse, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  placeholder?: string;
}) {
  return (
    <div className="flex gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 px-3 py-2 rounded-md text-xs"
        style={{
          background: "hsl(var(--muted))",
          border: "1px solid hsl(var(--border))",
          color: "hsl(var(--foreground))",
        }}
      />
      <button
        className="px-2.5 py-2 rounded-md flex-shrink-0"
        style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
        onClick={onBrowse}
      >
        <FolderOpen className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default function Annotation() {
  const { t } = useTranslation();
  const sidebarEl = useSidebarEl();
  const currentDatasetDir = useAppStore((s) => s.currentDatasetDir);
  const setDatasetContext = useAppStore((s) => s.setDatasetContext);

  const dir = useAnnotationStore((s) => s.dir);
  const images = useAnnotationStore((s) => s.images);
  const currentIndex = useAnnotationStore((s) => s.currentIndex);
  const dataUrl = useAnnotationStore((s) => s.dataUrl);
  const imageWidth = useAnnotationStore((s) => s.imageWidth);
  const imageHeight = useAnnotationStore((s) => s.imageHeight);
  const boxes = useAnnotationStore((s) => s.boxes);
  const selectedId = useAnnotationStore((s) => s.selectedId);
  const classes = useAnnotationStore((s) => s.classes);
  const loading = useAnnotationStore((s) => s.loading);
  const saving = useAnnotationStore((s) => s.saving);
  const error = useAnnotationStore((s) => s.error);
  const lastSavedAt = useAnnotationStore((s) => s.lastSavedAt);
  const classFileMsg = useAnnotationStore((s) => s.classFileMsg);
  const autoClassFile = useAnnotationStore((s) => s.autoClassFile);
  const autoLabeling = useAnnotationStore((s) => s.autoLabeling);
  const autoLabelProgress = useAnnotationStore((s) => s.autoLabelProgress);
  const autoCopyPrev = useAnnotationStore((s) => s.autoCopyPrev);
  const setAutoCopyPrev = useAnnotationStore((s) => s.setAutoCopyPrev);
  const historyLen = useAnnotationStore((s) => s.history.length);
  const futureLen = useAnnotationStore((s) => s.future.length);

  const openFolder = useAnnotationStore((s) => s.openFolder);
  const loadImage = useAnnotationStore((s) => s.loadImage);
  const addBox = useAnnotationStore((s) => s.addBox);
  const updateBox = useAnnotationStore((s) => s.updateBox);
  const deleteBox = useAnnotationStore((s) => s.deleteBox);
  const duplicateBox = useAnnotationStore((s) => s.duplicateBox);
  const copyBox = useAnnotationStore((s) => s.copyBox);
  const pasteBox = useAnnotationStore((s) => s.pasteBox);
  const setBoxClass = useAnnotationStore((s) => s.setBoxClass);
  const selectBox = useAnnotationStore((s) => s.selectBox);
  const undo = useAnnotationStore((s) => s.undo);
  const redo = useAnnotationStore((s) => s.redo);
  const setClasses = useAnnotationStore((s) => s.setClasses);
  const setClassFileMsg = useAnnotationStore((s) => s.setClassFileMsg);
  const startAutoLabel = useAnnotationStore((s) => s.startAutoLabel);
  const stopAutoLabel = useAnnotationStore((s) => s.stopAutoLabel);
  const clearError = useAnnotationStore((s) => s.clearError);
  const labelMode = useAnnotationStore((s) => s.mode);
  const setLabelMode = useAnnotationStore((s) => s.setMode);
  const labelType = useAnnotationStore((s) => s.labelType);
  const resetAnnotation = useAnnotationStore((s) => s.reset);
  const flushSave = useAnnotationStore((s) => s.flushSave);

  // ── 左侧配置栏本地状态 ──
  const [inputDir, setInputDir] = useState(currentDatasetDir);
  const [inputLabelOut, setInputLabelOut] = useState("");
  const [inputImageDir, setInputImageDir] = useState("");
  const [inputLabelDir, setInputLabelDir] = useState("");
  const [classFile, setClassFile] = useState("");
  const [classNamesText, setClassNamesText] = useState("");
  /** 全新标注：目标类型（检测 / 旋转框 / 实例分割） */
  const [newLabelType, setNewLabelType] = useState<NewLabelType>("detect");
  /** 用户本次是否手动改过类型（改过就以用户选择为准，不被旧工作记录覆盖） */
  const [newTypeTouched, setNewTypeTouched] = useState(false);
  const [workspaces, setWorkspaces] = useState<AnnotationWorkspace[]>(loadWorkspaces);

  /** 最近工作按当前模式过滤：全新标注只显示自己的（未导出）工作 */
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((w) => w.mode === labelMode),
    [workspaces, labelMode]
  );
  const [modelPath, setModelPath] = useState("");
  const [conf, setConf] = useState(0.25);
  const [overwrite, setOverwrite] = useState(false);
  /** 防误触：开启后才能点「开始自动标注」，启动一次后自动关闭 */
  const [autoLabelArmed, setAutoLabelArmed] = useState(false);
  /** 折叠面板：默认收起；AI 开关打开时自动展开 */
  const [autoLabelOpen, setAutoLabelOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (autoLabelArmed) setAutoLabelOpen(true);
  }, [autoLabelArmed]);
  const [envInfo, setEnvInfo] = useState<{ available: boolean; message?: string; default_model?: string } | null>(null);
  const [envChecking, setEnvChecking] = useState(false);

  // ── 导出配置 ──
  const [exportMode, setExportMode] = useState<"raw" | "detect" | "segment">("detect");
  const [exportFormat, setExportFormat] = useState<"yolo" | "coco" | "voc" | "labelme">("yolo");
  const [includeImages, setIncludeImages] = useState(true);
  const [trainRatio, setTrainRatio] = useState(0.8);
  const [targetDir, setTargetDir] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<
    { success: boolean; message: string; output_dir?: string; image_count?: number; label_count?: number } | null
  >(null);

  // ── 画布交互状态 ──
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("pan");
  // 平移/编辑切换时记住上一个绘图工具
  const [lastEditMode, setLastEditMode] = useState<"hbb" | "polygon" | "obb">("hbb");
  const [scale, setScale] = useState(1);
  const [labelsFaded, setLabelsFaded] = useState(false);

  // 平移模式：右侧面板只读，且不自动生成标注
  const panLocked = canvasMode === "pan";
  useEffect(() => {
    useAnnotationStore.getState().setPanMode(canvasMode === "pan");
  }, [canvasMode]);

  // 记住最近的绘图工具（含快捷键 H/P/R 切换），供「编辑」档回到正确工具
  useEffect(() => {
    if (canvasMode === "hbb" || canvasMode === "polygon" || canvasMode === "obb") setLastEditMode(canvasMode);
  }, [canvasMode]);
  const [jumpText, setJumpText] = useState("1");
  const [newBoxClass, setNewBoxClass] = useState(0);
  const [newClassName, setNewClassName] = useState("");

  const currentImage = currentIndex >= 0 ? images[currentIndex] : undefined;
  const currentBox = useMemo(
    () => boxes.find((b) => b.id === selectedId) ?? null,
    [boxes, selectedId]
  );

  /** 选中的旋转框参数（只对 4 角点标注有效） */
  const currentObb = useMemo(() => {
    if (!currentBox?.polygon || currentBox.polygon.length !== 4 || imageWidth <= 0 || imageHeight <= 0) return null;
    return rotRectFromCorners(
      currentBox.polygon.map(([x, y]) => [x * imageWidth, y * imageHeight] as [number, number])
    );
  }, [currentBox, imageWidth, imageHeight]);

  /** 按角度（度）旋转选中的旋转框 */
  const setCurrentObbAngle = (deg: number) => {
    if (!currentObb || !currentBox || panLocked) return;
    const polygon: [number, number][] = cornersOf({ ...currentObb, angle: degToRad(deg) }).map(([x, y]) => [
      Math.max(0, Math.min(1, x / imageWidth)),
      Math.max(0, Math.min(1, y / imageHeight)),
    ]);
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    updateBox(currentBox.id, {
      polygon,
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    }, true);
  };

  // 首次进入时检查自动标注环境
  useEffect(() => {
    let alive = true;
    setEnvChecking(true);
    api.annotationAutoLabelCheck()
      .then((res) => { if (alive) setEnvInfo(res); })
      .catch(() => { if (alive) setEnvInfo({ available: false, message: "无法连接后端" }); })
      .finally(() => { if (alive) setEnvChecking(false); });
    return () => { alive = false; };
  }, []);

  // 离开页面时把未落盘的改动刷出去
  useEffect(() => {
    return () => { void useAnnotationStore.getState().flushSave(); };
  }, []);

  // 类别列表变化时，保证新框类别合法
  useEffect(() => {
    const ids = Object.keys(classes).map(Number);
    if (ids.length > 0 && !ids.includes(newBoxClass)) setNewBoxClass(ids[0]);
  }, [classes, newBoxClass]);

  // 打开文件夹后自动探测到的类别文件，回填到输入框便于确认
  useEffect(() => {
    if (autoClassFile) setClassFile(autoClassFile);
  }, [autoClassFile]);

  // 切到「全新标注」时，把已有类别回填到逗号分隔输入框
  useEffect(() => {
    if (labelMode === "new") setClassNamesText(Object.values(classes).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelMode]);

  /** 从数据集路径里找 data.yaml / dataset.yaml / classes.txt 并回填 */
  const detectClassFileFor = useCallback(async (target: string) => {
    const dirPath = target.trim();
    if (!dirPath || labelMode !== "edit") return;
    try {
      const res = await api.annotationDetectClasses({ dir_path: dirPath });
      if (res.success && res.classes && Object.keys(res.classes).length > 0) {
        setClassFile(res.class_file || "");
        setClasses(res.classes);
        setClassFileMsg(null);
      }
    } catch {
      /* 目录不存在或后端不可用时静默忽略 */
    }
  }, [labelMode, setClasses, setClassFileMsg]);

  // 数据集路径变化（手输/选择）后自动探测类别定义文件
  useEffect(() => {
    if (labelMode !== "edit") return;
    const dirPath = inputDir.trim();
    if (!dirPath) return;
    const timer = setTimeout(() => { void detectClassFileFor(dirPath); }, 500);
    return () => clearTimeout(timer);
  }, [inputDir, labelMode, detectClassFileFor]);

  /** 类别名落盘目录：优先与现有类别文件同级（下次打开才能被自动识别到） */
  const classSaveDir = useCallback(() => {
    const s = useAnnotationStore.getState();
    const dirOf = (p: string) => {
      const trimmed = p.replace(/[\\/]+$/, "");
      const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      return cut > 0 ? trimmed.slice(0, cut) : "";
    };
    if (s.autoClassFile) {
      const d = dirOf(s.autoClassFile);
      if (d) return d;
    }
    if (s.dir) return s.dir;
    const base = s.labelOutputDir || s.manualLabelDir;
    return base ? dirOf(base) : "";
  }, []);

  // 类别改名自动落盘（防抖 1.2s）：即使没点“关闭当前工作”也能保存
  const lastSavedClassesRef = useRef("");
  useEffect(() => {
    lastSavedClassesRef.current = "";
  }, [dir]);
  useEffect(() => {
    if (!dir) return;
    if (Object.keys(classes).length === 0) return;
    const serialized = JSON.stringify(classes);
    if (serialized === lastSavedClassesRef.current) return;
    const timer = setTimeout(() => {
      const root = classSaveDir();
      if (!root) return;
      lastSavedClassesRef.current = serialized;
      void api.annotationWriteClasses({ target_dir: root, class_names: classes }).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [classes, dir, classSaveDir]);

  const handleOpenFolder = async () => {
    if (!inputDir.trim()) return;
    setDatasetContext({ imageDir: inputDir });
    // 同一工作已选过类型：以记录为准，不允许换类型
    const id = workspaceId(
      labelMode as WorkspaceMode,
      inputDir.trim(),
      inputLabelOut.trim(),
      inputImageDir.trim(),
      inputLabelDir.trim()
    );
    const stored = loadWorkspaces().find((w) => w.id === id)?.labelType;
    const effectiveType = newTypeTouched ? newLabelType : stored ?? newLabelType;
    if (effectiveType !== newLabelType) setNewLabelType(effectiveType);
    const snapshot = {
      mode: labelMode as WorkspaceMode,
      dir: inputDir.trim(),
      labelOut: inputLabelOut.trim(),
      imageDir: inputImageDir.trim(),
      labelDir: inputLabelDir.trim(),
      labelType: effectiveType,
    };
    await openFolder(snapshot.dir, snapshot.labelOut, snapshot.imageDir, snapshot.labelDir);
    rememberWorkspace(snapshot);
    restoreClassesFromWorkspace(id);
  };

  /** 写入最近工作记录（去重后置顶，最多 30 条；保留已有的类别快照） */
  const rememberWorkspace = (data: Omit<AnnotationWorkspace, "id" | "ts">) => {
    const id = workspaceId(data.mode, data.dir, data.labelOut, data.imageDir, data.labelDir);
    setWorkspaces((prev) => {
      const previous = prev.find((w) => w.id === id);
      const merged: AnnotationWorkspace = { ...previous, ...data, id, ts: Date.now() };
      const next = [merged, ...prev.filter((w) => w.id !== id)].slice(0, WORKSPACE_LIMIT);
      persistWorkspaces(next);
      return next;
    });
  };

  /** 把当前类别名写进对应的最近工作记录（关闭时调用） */
  const saveWorkspaceClasses = (snapshot: Record<string, string>) => {
    if (Object.keys(snapshot).length === 0) return;
    const s = useAnnotationStore.getState();
    const id = workspaceId(s.mode, s.dir, s.labelOutputDir, s.manualImageDir, s.manualLabelDir);
    setWorkspaces((prev) => {
      if (!prev.some((w) => w.id === id)) return prev;
      const next = prev.map((w) => (w.id === id ? { ...w, classes: snapshot, ts: Date.now() } : w));
      persistWorkspaces(next);
      return next;
    });
  };

  /** 目录识别不到类别时，用最近工作记录里的快照兜底 */
  const restoreClassesFromWorkspace = (id: string, snapshot?: Record<string, string>) => {
    if (Object.keys(useAnnotationStore.getState().classes).length > 0) return;
    const source = snapshot ?? loadWorkspaces().find((w) => w.id === id)?.classes;
    if (source && Object.keys(source).length > 0) {
      setClasses(source);
      setClassNamesText(Object.values(source).join(", "));
    }
  };

  const removeWorkspace = (id: string) => {
    setWorkspaces((prev) => {
      const next = prev.filter((w) => w.id !== id);
      persistWorkspaces(next);
      return next;
    });
  };

  /** 一键回到历史工作目录 */
  const restoreWorkspace = async (w: AnnotationWorkspace) => {
    setLabelMode(w.mode);
    setInputDir(w.dir);
    setInputLabelOut(w.labelOut);
    setInputImageDir(w.imageDir);
    setInputLabelDir(w.labelDir);
    if (w.labelType) setNewLabelType(w.labelType);
    setNewTypeTouched(false);
    setDatasetContext({ imageDir: w.dir });
    await openFolder(w.dir, w.labelOut, w.imageDir, w.labelDir);
    rememberWorkspace({ mode: w.mode, dir: w.dir, labelOut: w.labelOut, imageDir: w.imageDir, labelDir: w.labelDir, labelType: w.labelType });
    restoreClassesFromWorkspace(w.id, w.classes);
  };

  /** 关闭当前工作：落盘待保存内容后清空路径与已加载数据（保留最近工作记录） */
  const handleCloseWorkspace = async () => {
    if (!dir) return;
    const state = useAnnotationStore.getState();
    try {
      await flushSave();
    } catch {
      /* 保存失败也允许关闭 */
    }
    // 类别改名落盘：写到数据集（或现有类别文件）所在目录的 classes.txt
    try {
      const classRoot = classSaveDir();
      if (classRoot && Object.keys(state.classes).length > 0) {
        await api.annotationWriteClasses({ target_dir: classRoot, class_names: state.classes });
      }
    } catch {
      /* 写类别文件失败不阻断关闭 */
    }
    // 类别快照写入最近工作记录（目录不可写时仍能恢复）
    saveWorkspaceClasses(state.classes);
    resetAnnotation();
    setInputDir("");
    setInputLabelOut("");
    setInputImageDir("");
    setInputLabelDir("");
    setClassFile("");
    setClassNamesText("");
    setNewClassName("");
    setNewTypeTouched(false);
    setExportResult(null);
    setDatasetContext({ imageDir: "", labelDir: "" });
  };

  const handleParseClasses = async () => {
    if (!classFile.trim()) return;
    try {
      const res = await api.annotationParseClasses({ class_file: classFile.trim() });
      if (res.success && res.classes) {
        setClasses(res.classes);
        setClassFileMsg(null);
      } else {
        setClassFileMsg(res.message || "解析失败");
      }
    } catch (e) {
      setClassFileMsg(String(e));
    }
  };

  const handleExport = async () => {
    if (!dir || !targetDir.trim()) return;
    // 旋转框必须保留多边形（YOLO OBB 的 8 坐标），不能导出成矩形
    const effectiveExportMode = restrictType === "obb" && exportMode === "detect" ? "segment" : exportMode;
    setExporting(true);
    setExportResult(null);
    try {
      await useAnnotationStore.getState().flushSave();
      const res = await api.annotationExport({
        source_dir: dir,
        target_parent: targetDir.trim(),
        export_mode: effectiveExportMode,
        include_images: includeImages,
        class_names: classes,
        train_ratio: trainRatio,
        seed: 42,
        label_output_dir: useAnnotationStore.getState().labelOutputDir,
        image_dir: useAnnotationStore.getState().manualImageDir,
        label_dir: useAnnotationStore.getState().manualLabelDir,
        export_format: exportFormat,
      });
      setExportResult({
        success: res.success,
        message: res.message || (res.success ? "导出完成" : "导出失败"),
        output_dir: res.output_dir,
        image_count: res.image_count,
        label_count: res.label_count,
      });
      // 全新标注导出完成 = 该工作结束，从「未导出」列表移除
      if (res.success) {
        const s = useAnnotationStore.getState();
        removeWorkspace(["new", s.dir, s.labelOutputDir, s.manualImageDir, s.manualLabelDir].join("|"));
      }
    } catch (e) {
      setExportResult({ success: false, message: String(e) });
    } finally {
      setExporting(false);
    }
  };

  const addClass = () => {
    const nextId = Object.keys(classes).length === 0
      ? 0
      : Math.max(...Object.keys(classes).map((k) => Number(k))) + 1;
    // 名称可选：不填写则默认 class 0 / class 1 …
    const name = newClassName.trim() || `class ${nextId}`;
    setClasses({ ...classes, [String(nextId)]: name });
    setNewBoxClass(nextId);
    setNewClassName("");
  };

  /** 按数据集标注类型锁定画框模式：检测→矩形；旋转框→矩形+角度；分割→多边形；混合/无标注→都可 */
  const restrictType = labelMode === "new" ? newLabelType : labelType;
  const hbbDisabled = restrictType === "segment" || restrictType === "obb";
  const polygonDisabled = restrictType === "detect" || restrictType === "obb";
  const obbDisabled = restrictType !== "obb";
  /** 全新标注：工作已打开后类型不可更改 */
  const newTypeLocked = labelMode === "new" && Boolean(dir);

  // 类型与当前模式不匹配时，切到可用模式
  useEffect(() => {
    if (restrictType === "detect" && canvasMode !== "hbb" && canvasMode !== "pan") setCanvasMode("hbb");
    if (restrictType === "segment" && canvasMode === "hbb") setCanvasMode("polygon");
    if (restrictType === "obb" && (canvasMode === "hbb" || canvasMode === "polygon")) setCanvasMode("obb");
  }, [restrictType, canvasMode]);

  // 记住的编辑工具必须符合当前类型，否则从平移切回编辑时会出现「只能画矩形框」
  useEffect(() => {
    if (restrictType === "detect") setLastEditMode("hbb");
    else if (restrictType === "segment") setLastEditMode("polygon");
    else if (restrictType === "obb") setLastEditMode("obb");
  }, [restrictType]);

  // 旋转框不支持“转矩形”导出，默认改为 segment（保留 8 坐标）
  useEffect(() => {
    if (restrictType === "obb" && exportMode === "detect") setExportMode("segment");
  }, [restrictType, exportMode]);

  const progressPct = autoLabelProgress && autoLabelProgress.total > 0
    ? Math.round((autoLabelProgress.processed / autoLabelProgress.total) * 100)
    : 0;

  /** 全新标注：逗号分隔的类别名 → {0: a, 1: b} */
  const handleClassNamesChange = (text: string) => {
    setClassNamesText(text);
    const names = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    setClasses(Object.fromEntries(names.map((name, index) => [String(index), name])));
  };

  /** 全新标注且未定义类别时，首个框自动生成 class 0 */
  const handleAddBox = (box: YoloBox) => {
    if (Object.keys(classes).length === 0) {
      setClasses({ [String(box.class_id)]: `class ${box.class_id}` });
    }
    // 新框类别跟随最近一次使用的类别（切图后依然沿用）
    setNewBoxClass(box.class_id);
    addBox(box);
  };

  /** 右侧面板列出的类别 id：已定义类别 + 当前图上出现的类别，空时给一个 class 0 */
  const classIds = useMemo(() => {
    const ids = new Set<number>(Object.keys(classes).map(Number));
    boxes.forEach((b) => ids.add(b.class_id));
    if (ids.size === 0) ids.add(0);
    return Array.from(ids).sort((a, b) => a - b);
  }, [classes, boxes]);
  const classNameOf = (id: number) => classes[String(id)] ?? `class ${id}`;
  /** 画布/下拉统一用这份映射，保证未定义的 id 也显示为 class N（而不是「类别 N」） */
  const effectiveClasses = useMemo(
    () => Object.fromEntries(classIds.map((id) => [String(id), classNameOf(id)])),
    [classIds, classes]
  );

  // 当前图片序号同步到跳转输入框
  useEffect(() => {
    setJumpText(images.length > 0 ? String(currentIndex + 1) : "0");
  }, [currentIndex, images.length]);

  /** 输入序号跳转（1-based，越界自动限幅） */
  const jumpToIndex = (raw: string) => {
    if (images.length === 0) return;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setJumpText(String(currentIndex + 1));
      return;
    }
    const target = Math.max(0, Math.min(images.length - 1, parsed - 1));
    if (target !== currentIndex) void loadImage(target);
    setJumpText(String(target + 1));
  };

  const canOpen = Boolean(inputDir.trim())
    && (labelMode !== "new" || Boolean(inputLabelOut.trim()));

  /** 自动标注开关未开启时锁定卡片内全部控件（运行中允许操作，以便停止） */
  const controlsLocked = !autoLabelArmed && !autoLabeling;

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">
      {/* 数据集 / 类别定义 / 标注输出 */}
      <div
        className="rounded-xl p-4 space-y-3"
        style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
      >
        {/* 模式切换 */}
        <div className="grid grid-cols-2 gap-2">
          {([
            ["edit", t("annotation.modeEdit")],
            ["new", t("annotation.modeNew")],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className="py-2 rounded-md text-xs transition-all"
              style={{
                background: labelMode === value ? "hsl(var(--primary))" : "hsl(var(--muted))",
                color: labelMode === value ? "#fff" : "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border))",
                fontWeight: labelMode === value ? 600 : 500,
              }}
              onClick={async () => {
                if (value === labelMode) return;
                // 切换工作模式前先关闭当前工作（保存并清空），避免两种模式的路径/类型混用
                if (dir) await handleCloseWorkspace();
                setLabelMode(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <Field
          label={labelMode === "new" ? t("annotation.folderNew") : t("annotation.folder")}
          hint={labelMode === "new" ? t("annotation.newFolderHint") : t("annotation.folderHint")}
        >
          <PathRow
            value={inputDir}
            onChange={setInputDir}
            placeholder={t("annotation.folderPlaceholder")}
            onBrowse={async () => {
              const d = await browseDirectory();
              if (d) { setInputDir(d); void detectClassFileFor(d); }
            }}
          />
        </Field>

        {labelMode === "edit" ? (
          <>
            <Field label={t("annotation.imageDirManual")} hint={t("annotation.dirManualHint")}>
              <PathRow
                value={inputImageDir}
                onChange={setInputImageDir}
                placeholder={t("annotation.imageDirManualPlaceholder")}
                onBrowse={async () => { const d = await browseDirectory(); if (d) setInputImageDir(d); }}
              />
            </Field>
            <Field label={t("annotation.labelDirManual")} hint={t("annotation.dirManualHint")}>
              <PathRow
                value={inputLabelDir}
                onChange={setInputLabelDir}
                placeholder={t("annotation.labelDirManualPlaceholder")}
                onBrowse={async () => { const d = await browseDirectory(); if (d) setInputLabelDir(d); }}
              />
            </Field>

            <Field label={t("annotation.classFile")} hint={t("annotation.classFileHint")}>
              <PathRow
                value={classFile}
                onChange={setClassFile}
                placeholder="classes.txt / data.yaml"
                onBrowse={async () => {
                  const f = await browseFile([{ name: "Classes", extensions: ["txt", "yaml", "yml"] }]);
                  if (f) {
                    setClassFile(f);
                    try {
                      const res = await api.annotationParseClasses({ class_file: f });
                      if (res.success && res.classes) { setClasses(res.classes); setClassFileMsg(null); }
                      else setClassFileMsg(res.message || "解析失败");
                    } catch (e) { setClassFileMsg(String(e)); }
                  }
                }}
              />
            </Field>
            <div className="flex items-start justify-between gap-2">
              {classFileMsg ? (
                <div className="text-[10px] leading-4 break-all flex-1" style={{ color: "hsl(var(--destructive))" }}>
                  {classFileMsg}
                </div>
              ) : (
                <div className="flex-1" />
              )}
              <button
                className="text-[10px] px-2 py-0.5 rounded flex-shrink-0 disabled:opacity-40"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                onClick={handleParseClasses}
                disabled={!classFile.trim()}
              >
                {t("annotation.parseClasses")}
              </button>
            </div>

            <Field label={t("annotation.outputDir")}>
              <PathRow
                value={inputLabelOut}
                onChange={setInputLabelOut}
                placeholder={t("annotation.outputDirPlaceholder")}
                onBrowse={async () => { const d = await browseDirectory(); if (d) setInputLabelOut(d); }}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={t("annotation.outputDirRequired")} hint={t("annotation.outputDirRequiredHint")}>
              <PathRow
                value={inputLabelOut}
                onChange={setInputLabelOut}
                placeholder={t("annotation.outputDirRequiredPlaceholder")}
                onBrowse={async () => { const d = await browseDirectory(); if (d) setInputLabelOut(d); }}
              />
            </Field>

            <Field label={t("annotation.labelType")} hint={t("annotation.labelTypeNewHint")}>
              <div className="grid grid-cols-3 gap-1">
                {([
                  ["detect", t("annotation.typeDetect")],
                  ["obb", t("annotation.typeObb")],
                  ["segment", t("annotation.typeSegment")],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className="py-1.5 rounded-md text-[11px] leading-tight disabled:opacity-40"
                    style={{
                      background: newLabelType === value ? "hsl(var(--primary))" : "hsl(var(--muted))",
                      color: newLabelType === value ? "#fff" : "hsl(var(--muted-foreground))",
                      border: "1px solid hsl(var(--border))",
                      cursor: newTypeLocked ? "not-allowed" : "pointer",
                    }}
                    disabled={newTypeLocked}
                    title={newTypeLocked ? t("annotation.labelTypeLocked") : undefined}
                    onClick={() => {
                      setNewLabelType(value);
                      setNewTypeTouched(true);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {newTypeLocked && (
                <div className="text-[10px] leading-4 mt-1" style={{ color: "hsl(var(--warning))" }}>
                  {t("annotation.labelTypeLocked")}
                </div>
              )}
            </Field>
            {newLabelType === "obb" && (
              <div className="text-[10px] leading-4" style={{ color: "hsl(var(--muted-foreground))" }}>
                {t("annotation.obbHint")}
              </div>
            )}

            <Field label={t("annotation.classNamesField")} hint={t("annotation.classNamesHint")}>
              <input
                value={classNamesText}
                onChange={(e) => handleClassNamesChange(e.target.value)}
                placeholder={t("annotation.classNamesPlaceholder")}
                className="w-full px-3 py-2 rounded-md text-xs"
                style={{
                  background: "hsl(var(--muted))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                }}
              />
            </Field>
          </>
        )}

        <div className="flex gap-2">
          <button
            className="flex-1 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
            style={{ background: "hsl(var(--primary))", color: "#fff" }}
            onClick={handleOpenFolder}
            disabled={loading || !canOpen}
          >
            {loading ? t("common.loading") : t("annotation.openFolder")}
          </button>
          <button
            className="px-3 py-2 rounded-md"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
            onClick={handleOpenFolder}
            title={t("annotation.reload")}
          >
            <RefreshCw className={loading ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
          </button>
        </div>

        {/* 最近工作（按当前模式过滤，最多 30 条，点击直接打开） */}
        <div className="pt-1">
          <div className="flex items-center gap-1.5 mb-1.5">
            <History className="w-3 h-3" style={{ color: "hsl(var(--muted-foreground))" }} />
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "hsl(var(--muted-foreground))" }}>
              {labelMode === "new" ? t("annotation.recentWorkspacesNew") : t("annotation.recentWorkspaces")}
            </span>
          </div>
          {visibleWorkspaces.length === 0 ? (
            <div className="text-[10px] px-1 py-2 rounded-md" style={{ color: "hsl(var(--muted-foreground))" }}>
              {labelMode === "new" ? t("annotation.recentEmptyNew") : t("annotation.recentEmpty")}
            </div>
          ) : (
            <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: 150 }}>
              {visibleWorkspaces.map((w) => (
                <div
                  key={w.id}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  onClick={() => void restoreWorkspace(w)}
                  title={`${w.dir}\n${w.labelOut || w.labelDir}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] truncate">{w.dir.split(/[\\/]/).filter(Boolean).pop() || w.dir}</div>
                    <div className="text-[10px] truncate" style={{ color: "hsl(var(--muted-foreground))", direction: "rtl", textAlign: "left" }}>
                      {w.labelOut || w.labelDir || w.dir}
                    </div>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    style={{ color: "hsl(var(--destructive))" }}
                    onClick={(e) => { e.stopPropagation(); removeWorkspace(w.id); }}
                    title={t("common.delete")}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {dir && (
          <div className="space-y-0.5">
            <div className="text-[10px] leading-4 break-all" style={{ color: "hsl(var(--muted-foreground))" }}>
              {images.length} {t("annotation.images")} · {images.filter((i) => i.box_count > 0).length}{" "}
              {t("annotation.labeledShort")}
            </div>
            <div className="text-[10px] leading-4" style={{ color: "hsl(var(--muted-foreground))" }}>
              {t("annotation.labelType")}：
              <span style={{ color: "hsl(var(--foreground))" }}>
                {labelMode === "new"
                  ? (newLabelType === "detect" && t("annotation.typeDetect"))
                    || (newLabelType === "obb" && t("annotation.typeObb"))
                    || t("annotation.typeSegment")
                  : (labelType === "detect" && t("annotation.typeDetect"))
                    || (labelType === "obb" && t("annotation.typeObb"))
                    || (labelType === "segment" && t("annotation.typeSegment"))
                    || (labelType === "mixed" && t("annotation.typeMixed"))
                    || t("annotation.typeNone")}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* AI 自动预标注 */}
      <div
        className="rounded-xl p-4 space-y-3"
        style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Wand2 className="w-3.5 h-3.5" style={{ color: "hsl(var(--primary))" }} />
            <span className="text-xs font-semibold">{t("annotation.autoLabel")}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setAutoLabelOpen((v) => !v)}
            className="w-6 h-6 flex items-center justify-center rounded"
            style={{ color: "hsl(var(--muted-foreground))" }}
            title={autoLabelOpen ? t("annotation.collapsePanel") : t("annotation.expandPanel")}
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform${autoLabelOpen ? " rotate-90" : ""}`} />
          </button>
          <button
            role="switch"
            aria-checked={autoLabelArmed}
            onClick={() => setAutoLabelArmed((v) => !v)}
            className="flex-shrink-0 rounded-full transition-colors"
            style={{
              width: 36,
              height: 20,
              padding: 2,
              background: autoLabelArmed ? "hsl(var(--primary))" : "hsl(var(--border))",
              border: "1px solid hsl(var(--border))",
            }}
            title={t("annotation.autoLabelEnable")}
          >
            <span
              className="block rounded-full transition-transform"
              style={{
                width: 14,
                height: 14,
                background: "#fff",
                transform: autoLabelArmed ? "translateX(16px)" : "translateX(0)",
              }}
            />
          </button>
          </div>
        </div>

        {autoLabelOpen && (
        <div
          className="space-y-3"
          style={{ pointerEvents: controlsLocked ? "none" : "auto", opacity: controlsLocked ? 0.45 : 1 }}
        >
        <Field label={t("annotation.modelPath")} hint={envInfo?.default_model || t("annotation.modelDefault")}>
          <div className="flex gap-1.5">
            <input
              value={modelPath}
              onChange={(e) => setModelPath(e.target.value)}
              placeholder="models/yolov8m.pt 或 best.pt / model.onnx"
              disabled={controlsLocked}
              className="flex-1 min-w-0 px-3 py-2 rounded-md text-xs"
              style={{
                background: "hsl(var(--muted))",
                border: "1px solid hsl(var(--border))",
                color: "hsl(var(--foreground))",
              }}
            />
            <button
              className="px-2.5 py-2 rounded-md flex-shrink-0"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
              disabled={controlsLocked}
              onClick={async () => {
                const f = await browseFile([{ name: "Model", extensions: ["pt", "onnx", "engine", "torchscript", "tflite"] }]);
                if (f) setModelPath(f);
              }}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </div>
        </Field>

        <div>
          <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: "hsl(var(--muted-foreground))" }}>
            <span className="uppercase tracking-[0.1em]">{t("annotation.conf")}</span>
            <span>{conf.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0.05}
            max={0.9}
            step={0.05}
            value={conf}
            disabled={controlsLocked}
            onChange={(e) => setConf(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>

        <label
          className="flex items-center gap-2 text-xs"
          style={{ cursor: controlsLocked ? "not-allowed" : "pointer" }}
        >
          <input
            type="checkbox"
            checked={overwrite}
            disabled={controlsLocked}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="accent-blue-500"
          />
          <span>{t("annotation.overwrite")}</span>
        </label>

        <div
          className="flex items-start gap-1.5 text-[10px] leading-4 rounded px-2 py-1.5"
          style={{
            background: envInfo?.available ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.10)",
            color: envInfo?.available ? "hsl(var(--success))" : "hsl(var(--warning))",
          }}
        >
          {envChecking ? <Loader2 className="w-3 h-3 animate-spin flex-shrink-0 mt-0.5" />
            : envInfo?.available ? <CheckCircle2 className="w-3 h-3 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />}
          <span className="break-all">
            {envChecking
              ? t("common.loading")
              : envInfo?.available
                ? `${t("annotation.envReady")}${envInfo.message ? ` · ${envInfo.message}` : ""}`
                : envInfo?.message || t("annotation.envMissing")}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            className="flex-1 py-2 rounded-md text-xs font-semibold disabled:opacity-50"
            style={{ background: "hsl(var(--primary))", color: "#fff" }}
            onClick={() => {
              setAutoLabelArmed(false);
              void startAutoLabel({
                modelPath: modelPath.trim() || (envInfo?.default_model ?? ""),
                conf,
                overwrite,
              });
            }}
            disabled={!dir || autoLabeling || !autoLabelArmed || envInfo?.available === false}
          >
            {autoLabeling ? t("annotation.autoLabelRunning") : t("annotation.startAutoLabel")}
          </button>
          <button
            className="px-3 py-2 rounded-md text-xs disabled:opacity-40"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
            onClick={() => void stopAutoLabel()}
            disabled={!autoLabeling}
          >
            {t("annotation.stopAutoLabel")}
          </button>
        </div>

        {autoLabelProgress && (
          <div className="space-y-1.5">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "hsl(var(--muted))" }}>
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progressPct}%`, background: "hsl(var(--primary))" }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px]" style={{ color: "hsl(var(--muted-foreground))" }}>
              <span className="truncate max-w-[150px]" title={autoLabelProgress.current}>
                {autoLabelProgress.current || autoLabelProgress.state}
              </span>
              <span>
                {autoLabelProgress.processed}/{autoLabelProgress.total}
                {" · "}
                {autoLabelProgress.labeled}
              </span>
            </div>
            {autoLabelProgress.errors.length > 0 && (
              <div className="text-[10px]" style={{ color: "hsl(var(--destructive))" }}>
                {autoLabelProgress.errors[autoLabelProgress.errors.length - 1]}
              </div>
            )}
          </div>
        )}
        </div>
        )}
      </div>

      {/* 导出 */}
      <div
        className="rounded-xl p-4 space-y-3"
        style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
      >
        <div className="flex items-center gap-2">
          <Download className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />
          <span className="text-xs font-semibold">{t("annotation.exportTitle")}</span>
          <button
            onClick={() => setExportOpen((v) => !v)}
            className="ml-auto w-6 h-6 flex items-center justify-center rounded flex-shrink-0"
            style={{ color: "hsl(var(--muted-foreground))" }}
            title={exportOpen ? t("annotation.collapsePanel") : t("annotation.expandPanel")}
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform${exportOpen ? " rotate-90" : ""}`} />
          </button>
        </div>

        {exportOpen && (
        <div className="space-y-3">
        {/* 导出格式 */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>
            {t("annotation.exportFormat")}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {([["yolo", "YOLO"], ["coco", "COCO"], ["voc", "VOC"], ["labelme", "LabelMe"]] as const).map(([value, label]) => (
              <button
                key={value}
                className="py-1.5 rounded-md text-[11px]"
                style={{
                  background: exportFormat === value ? "hsl(var(--primary))" : "hsl(var(--muted))",
                  color: exportFormat === value ? "#fff" : "hsl(var(--muted-foreground))",
                  border: "1px solid hsl(var(--border))",
                }}
                onClick={() => setExportFormat(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1">
          {([
            ["raw", t("annotation.modeRaw")],
            ["detect", t("annotation.modeDetect")],
            ["segment", t("annotation.modeSegment")],
          ] as const).map(([value, label]) => {
            const obbBlocked = restrictType === "obb" && value === "detect";
            return (
            <button
              key={value}
              className="py-1.5 rounded-md text-[11px] disabled:opacity-40"
              style={{
                background: exportMode === value ? "hsl(var(--primary))" : "hsl(var(--muted))",
                color: exportMode === value ? "#fff" : "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border))",
                cursor: obbBlocked ? "not-allowed" : "pointer",
              }}
              disabled={obbBlocked}
              title={obbBlocked ? t("annotation.obbExportNote") : undefined}
              onClick={() => setExportMode(value)}
            >
              {label}
            </button>
            );
          })}
        </div>
        {restrictType === "obb" && (
          <div className="text-[10px] leading-4" style={{ color: "hsl(var(--muted-foreground))" }}>
            {t("annotation.obbExportNote")}
          </div>
        )}

        {exportMode !== "raw" && exportFormat === "yolo" && (
          <div>
            <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: "hsl(var(--muted-foreground))" }}>
              <span className="uppercase tracking-[0.1em]">{t("annotation.trainRatio")}</span>
              <span>{Math.round(trainRatio * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={0.95}
              step={0.05}
              value={trainRatio}
              onChange={(e) => setTrainRatio(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer text-xs">
          <input type="checkbox" checked={includeImages} onChange={(e) => setIncludeImages(e.target.checked)} className="accent-blue-500" />
          <span>{t("annotation.includeImages")}</span>
        </label>

        <Field label={t("annotation.targetDir")}>
          <PathRow
            value={targetDir}
            onChange={setTargetDir}
            placeholder={t("annotation.targetDirPlaceholder")}
            onBrowse={async () => { const d = await browseDirectory(); if (d) setTargetDir(d); }}
          />
        </Field>

        <button
          className="w-full py-2 rounded-md text-xs font-semibold disabled:opacity-50"
          style={{ background: "hsl(var(--primary))", color: "#fff" }}
          onClick={handleExport}
          disabled={!dir || !targetDir.trim() || exporting}
        >
          {exporting ? t("annotation.exporting") : t("annotation.export")}
        </button>

        {exportResult && (
          <div
            className="rounded px-2 py-1.5 text-[10px] leading-4 break-all"
            style={{
              background: exportResult.success ? "rgba(34,197,94,0.10)" : "rgba(197,15,31,0.12)",
              color: exportResult.success ? "hsl(var(--success))" : "hsl(var(--destructive))",
            }}
          >
            <div>{exportResult.message}</div>
            {exportResult.output_dir && <div>{exportResult.output_dir}</div>}
            {exportResult.success && (
              <div>{`${t("annotation.images")}: ${exportResult.image_count ?? 0} · ${t("annotation.boxes")}: ${exportResult.label_count ?? 0}`}</div>
            )}
          </div>
        )}
        </div>
        )}
      </div>
    </div>
  );

  // ── 主区域 ──
  const modeButton = (
    value: CanvasMode,
    Icon: React.FC<{ className?: string }>,
    label: string,
    keyHint: string,
    disabled = false,
  ) => {
    // 预览（平移）模式下绘图工具一律不可用
    const locked = disabled || panLocked;
    return (
      <button
        onClick={() => { if (!locked) setCanvasMode(value); }}
        title={locked ? t("annotation.modeDisabled") : `${label}（${keyHint}）`}
        className="flex items-center gap-1 px-2 h-7 rounded-md text-xs whitespace-nowrap"
        style={{
          background: canvasMode === value ? "hsl(var(--primary))" : "hsl(var(--muted))",
          color: canvasMode === value ? "#fff" : "hsl(var(--muted-foreground))",
          border: "1px solid hsl(var(--border))",
          opacity: locked ? 0.35 : 1,
          cursor: locked ? "not-allowed" : "pointer",
        }}
      >
        <Icon className="w-3.5 h-3.5" />
        {label}
        <span
          className="text-[9px] leading-none px-1 py-0.5 rounded font-semibold"
          style={{ background: canvasMode === value ? "rgba(255,255,255,0.22)" : "hsl(var(--border))" }}
        >
          {keyHint}
        </span>
      </button>
    );
  };

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      <div className="h-full flex flex-col gap-2 min-h-0">
        {/* 工具栏 */}
        <div
          className="flex-shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg"
          style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
          title={currentImage?.path || undefined}
        >
          {/* 完整路径：宽度不够时从左侧截断（保留文件名），悬停看完整路径 */}
          <div
            className="text-xs min-w-0 flex-1"
            title={currentImage?.path || undefined}
            style={{
              direction: "rtl",
              textAlign: "left",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            <span style={{ direction: "ltr", unicodeBidi: "plaintext" }}>
              {currentImage?.path || t("annotation.empty")}
            </span>
          </div>
          {imageWidth > 0 && (
            <span className="text-xs flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>
              {imageWidth}×{imageHeight}
            </span>
          )}

          <div className="flex items-center gap-1">
            {/* 平移 / 编辑 左右切换开关（两段文字常显，滑块指示当前态） */}
            <div
              className="relative grid grid-cols-2 items-center h-7 rounded-md text-xs overflow-hidden"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
            >
              <span
                aria-hidden
                className="absolute top-0 bottom-0 rounded"
                style={{
                  left: 2,
                  width: "calc(50% - 4px)",
                  background: "hsl(var(--primary))",
                  transform: canvasMode === "pan" ? "translateX(0)" : "translateX(calc(100% + 4px))",
                  transition: "transform 0.18s ease",
                }}
              />
              {([
                { id: "pan", label: t("annotation.modePan"), Icon: Hand },
                { id: "edit", label: t("annotation.modeEditTool"), Icon: PenTool },
              ] as const).map(({ id, label, Icon }) => {
                const active = id === "pan" ? canvasMode === "pan" : canvasMode !== "pan";
                return (
                  <button
                    key={id}
                    onClick={() => {
                      if (id === "pan") {
                        setCanvasMode("pan");
                      } else {
                        setCanvasMode(lastEditMode);
                      }
                    }}
                    title={id === "pan" ? t("annotation.panReadonly") : label}
                    className="relative z-10 flex items-center justify-center gap-1 h-full px-2.5"
                    style={{ color: active ? "#fff" : "hsl(var(--muted-foreground))" }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>
            {/* 关闭当前工作 */}
            <button
              onClick={() => void handleCloseWorkspace()}
              disabled={!dir}
              className="flex items-center gap-1 px-2 h-7 rounded-md text-xs whitespace-nowrap disabled:opacity-40"
              style={{
                background: "hsl(var(--muted))",
                border: "1px solid hsl(var(--border))",
                color: "hsl(var(--muted-foreground))",
              }}
              title={t("annotation.closeWorkspaceHint")}
            >
              <XCircle className="w-3.5 h-3.5" />
              {t("annotation.closeWorkspace")}
            </button>
          </div>
        </div>

        {error && (
          <div
            className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 rounded-md text-xs"
            style={{ background: "hsl(var(--destructive) / 0.12)", color: "hsl(var(--destructive))" }}
          >
            <span className="truncate">{error}</span>
            <button onClick={clearError} className="text-[10px] underline flex-shrink-0">
              {t("common.close")}
            </button>
          </div>
        )}

        {/* 画布 + 右侧面板 */}
        <div className="flex-1 min-h-0 flex gap-2">
          <div
            className="flex-1 min-w-0 rounded-lg overflow-hidden flex relative"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
          >
            <AnnotationCanvas
              dataUrl={dataUrl}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              boxes={boxes}
              selectedId={selectedId}
              classes={effectiveClasses}
              newBoxClass={newBoxClass}
              mode={canvasMode}
              scale={scale}
              labelsFaded={labelsFaded}
              onSelect={selectBox}
              onAdd={handleAddBox}
              onUpdate={(id, patch, record) => { if (!panLocked) updateBox(id, patch, record); }}
              onDelete={(id) => { if (!panLocked) deleteBox(id); }}
              onCopy={(id) => { if (!panLocked) copyBox(id); }}
              onPaste={() => { if (!panLocked) pasteBox(); }}
              onScaleChange={setScale}
              onPrev={() => void loadImage(currentIndex - 1)}
              onNext={() => void loadImage(currentIndex + 1)}
              onUndo={() => { if (!panLocked) undo(); }}
              onRedo={() => { if (!panLocked) redo(); }}
              onModeChange={(m) => {
                if (m === "polygon" && polygonDisabled) return;
                if (m === "hbb" && hbbDisabled) return;
                if (m === "obb" && obbDisabled) return;
                setCanvasMode(m);
              }}
            />

            {/* 切图控件：右下角悬浮 */}
            <div
              className="flex items-center gap-1 rounded-full"
              style={{
                position: "absolute",
                right: 12,
                bottom: 12,
                zIndex: 10,
                padding: 4,
                gap: 2,
                background: "rgba(0, 0, 0, 0.72)",
                border: "1px solid hsl(var(--border))",
              }}
            >
              {/* 缩放 / 适应 / 标签半透明 */}
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => setScale((s) => Math.max(0.1, Math.round((s - 0.1) * 10) / 10))}
                title={t("annotation.zoomOut")}
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-[11px] w-10 text-center" style={{ color: "#e5e7eb", fontVariantNumeric: "tabular-nums" }}>
                {Math.round(scale * 100)}%
              </span>
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => setScale((s) => Math.min(4, Math.round((s + 0.1) * 10) / 10))}
                title={t("annotation.zoomIn")}
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                className="px-2 h-8 rounded-full text-[11px]"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => setScale(1)}
                title={t("annotation.fit")}
              >
                {t("annotation.fit")}
              </button>
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{
                  color: labelsFaded ? "#fff" : "#e5e7eb",
                  background: labelsFaded ? "hsl(var(--primary))" : "transparent",
                }}
                onClick={() => setLabelsFaded((v) => !v)}
                title={t("annotation.labelFade")}
              >
                <Tag className="w-4 h-4" />
              </button>
              <span className="w-px h-4 flex-shrink-0" style={{ background: "rgba(255,255,255,0.25)" }} />
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => void loadImage(0)}
                disabled={currentIndex <= 0}
                title={t("annotation.first")}
              >
                <ChevronsLeft className="w-4 h-4" />
              </button>
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => void loadImage(currentIndex - 1)}
                disabled={currentIndex <= 0}
                title={`${t("annotation.prev")} (A)`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <input
                value={jumpText}
                onChange={(e) => setJumpText(e.target.value.replace(/[^\d]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.currentTarget.blur(); jumpToIndex(jumpText); }
                  if (e.key === "Escape") { setJumpText(String(currentIndex + 1)); e.currentTarget.blur(); }
                }}
                onBlur={() => jumpToIndex(jumpText)}
                onFocus={(e) => e.currentTarget.select()}
                inputMode="numeric"
                title={t("annotation.jumpTo")}
                className="h-8 rounded-full text-center text-xs outline-none"
                style={{
                  width: 56,
                  color: "#fff",
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid hsl(var(--border))",
                  fontVariantNumeric: "tabular-nums",
                }}
              />
              <span
                className="text-[11px] px-1"
                style={{ color: "#e5e7eb", fontVariantNumeric: "tabular-nums" }}
              >
                / {images.length > 0 ? images.length : 0}
              </span>

              <button
                className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => void loadImage(currentIndex + 1)}
                disabled={currentIndex >= images.length - 1}
                title={`${t("annotation.next")} (D)`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30"
                style={{ color: "#fff", background: "transparent" }}
                onClick={() => void loadImage(images.length - 1)}
                disabled={currentIndex >= images.length - 1}
                title={t("annotation.last")}
              >
                <ChevronsRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 右侧面板 */}
          <div
            className="w-[248px] flex-shrink-0 rounded-lg flex flex-col min-h-0 overflow-hidden"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
          >
            {/* 预览模式下整个面板置灰且不可交互 */}
            <div
              className="flex-1 min-h-0 flex flex-col transition-opacity"
              style={{ opacity: panLocked ? 0.45 : 1, pointerEvents: panLocked ? "none" : "auto" }}
            >
            {/* 绘制模式 + 撤销/重做/删除 */}
            <div className="p-2 flex-shrink-0 flex items-center gap-1" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
              {modeButton("hbb", Square, t("annotation.modeHbb"), "H", hbbDisabled)}
              {modeButton("obb", RotateCw, t("annotation.modeObb"), "R", obbDisabled)}
              {modeButton("polygon", Pentagon, t("annotation.modePolygon"), "P", polygonDisabled)}
              <div className="flex-1" />
              <button
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                onClick={undo}
                disabled={historyLen === 0 || panLocked}
                title={`${t("annotation.undo")} (Ctrl+Z)`}
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                onClick={redo}
                disabled={futureLen === 0 || panLocked}
                title={`${t("annotation.redo")} (Ctrl+Shift+Z)`}
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
              <button
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                onClick={() => selectedId && duplicateBox(selectedId)}
                disabled={!selectedId || panLocked}
                title={`${t("annotation.duplicate")} (Ctrl+C / Ctrl+V)`}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30"
                style={{ background: "rgba(197,15,31,0.12)", border: "1px solid rgba(197,15,31,0.3)", color: "hsl(var(--destructive))" }}
                onClick={() => selectedId && deleteBox(selectedId)}
                disabled={!selectedId || panLocked}
                title={`${t("annotation.deleteSelected")} (Delete)`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 全局类别定义：所有图共用 */}
            <div
              className="p-2 flex-shrink-0 space-y-1.5"
              style={{ borderBottom: "1px solid hsl(var(--border))", maxHeight: 190, overflowY: "auto" }}
            >
              <div
                className="text-[10px] font-semibold uppercase tracking-[0.12em] px-1"
                title={t("annotation.globalClassesHint")}
                style={{ color: "hsl(var(--muted-foreground))", cursor: "help" }}
              >
                {t("annotation.globalClasses")}
              </div>
              {classIds.map((id) => (
                <div key={id} className="flex items-center gap-1.5">
                  <span className="w-5 text-[10px] text-right flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>{id}</span>
                  <input
                    value={classNameOf(id)}
                    onChange={(e) => setClasses({ ...classes, [String(id)]: e.target.value })}
                    placeholder={`class ${id}`}
                    title={t("annotation.renameClassHint")}
                    disabled={panLocked}
                    className="flex-1 min-w-0 px-1.5 py-0.5 rounded text-[11px]"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))", opacity: panLocked ? 0.5 : 1 }}
                  />
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <input
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addClass(); }}
                  placeholder={t("annotation.className")}
                  disabled={panLocked}
                  className="flex-1 min-w-0 px-1.5 py-0.5 rounded text-[11px]"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))", opacity: panLocked ? 0.5 : 1 }}
                />
                <button
                  className="px-2 py-0.5 rounded text-[11px] flex-shrink-0 disabled:opacity-40"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  onClick={addClass}
                  disabled={panLocked}
                >
                  {t("common.add")}
                </button>
              </div>
            </div>

            {/* 当前画面的标注框 */}
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {t("annotation.boxes")} ({boxes.length})
                </span>
                {currentBox && (
                  <span className="text-[10px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                    {(currentBox.w * 100).toFixed(1)}%×{(currentBox.h * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              {currentObb && (
                <div className="flex items-center gap-1.5 px-1 pb-1.5">
                  <span className="text-[10px] flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>
                    {t("annotation.obbAngle")}
                  </span>
                  <input
                    type="number"
                    step={1}
                    value={Math.round(radToDeg(currentObb.angle))}
                    onChange={(e) => setCurrentObbAngle(Number(e.target.value) || 0)}
                    disabled={panLocked}
                    className="w-16 px-1.5 py-0.5 rounded text-[11px]"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))", opacity: panLocked ? 0.5 : 1 }}
                  />
                  <span className="text-[10px]" style={{ color: "hsl(var(--muted-foreground))" }}>°</span>
                </div>
              )}
              {boxes.length === 0 && (
                <div className="px-1 py-6 text-center text-[11px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {t("annotation.noBoxes")}
                </div>
              )}
              {boxes.map((box, index) => {
                const color = COLORS[Math.abs(box.class_id) % COLORS.length];
                const active = box.id === selectedId;
                return (
                  <div
                    key={box.id}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer"
                    style={{
                      background: active ? "hsl(var(--primary) / 0.14)" : "hsl(var(--muted))",
                      border: `1px solid ${active ? "hsl(var(--primary) / 0.45)" : "hsl(var(--border))"}`,
                    }}
                    onClick={() => selectBox(box.id)}
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                    <span className="text-[10px] flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>
                      #{index + 1}
                    </span>
                    <select
                      value={String(box.class_id)}
                      onChange={(e) => setBoxClass(box.id, Number(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                      disabled={panLocked}
                      className="flex-1 min-w-0 px-1 py-0.5 rounded text-[11px]"
                      style={{ background: "transparent", color: "hsl(var(--foreground))", border: "none" }}
                    >
                      {classIds.map((id) => (
                        <option key={id} value={String(id)}>{classNameOf(id)}</option>
                      ))}
                    </select>
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 disabled:opacity-30"
                      style={{ color: "hsl(var(--destructive))" }}
                      onClick={(e) => { e.stopPropagation(); deleteBox(box.id); }}
                      disabled={panLocked}
                      title={t("common.delete")}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 新框类别：默认上一个用过的类别 */}
            <div className="p-3 space-y-2 flex-shrink-0" style={{ borderTop: "1px solid hsl(var(--border))" }}>
              <div
                className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                title={t("annotation.newBoxClassHint")}
                style={{ color: "hsl(var(--muted-foreground))", cursor: "help" }}
              >
                {t("annotation.newBoxClass")}
              </div>
              <select
                value={newBoxClass}
                onChange={(e) => setNewBoxClass(Number(e.target.value))}
                disabled={panLocked}
                className="w-full px-2 py-1.5 rounded-md text-xs"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))", opacity: panLocked ? 0.5 : 1 }}
              >
                {classIds.map((id) => (
                  <option key={id} value={id}>{`${id} · ${classNameOf(id)}`}</option>
                ))}
              </select>
              <div className="text-[10px] leading-4" style={{ color: "hsl(var(--muted-foreground))" }}>
                {t("annotation.newBoxClassDefaultHint")}
              </div>

              {/* 自动沿用上一张标注（仅当当前图无标签文件） */}
              <label
                className="flex items-center gap-2 cursor-pointer text-[11px] pt-1"
                title={t("annotation.copyPrevHint")}
              >
                <input
                  type="checkbox"
                  checked={autoCopyPrev}
                  onChange={(e) => setAutoCopyPrev(e.target.checked)}
                  disabled={panLocked}
                  className="accent-blue-500"
                />
                <span style={{ opacity: panLocked ? 0.5 : 1 }}>{t("annotation.copyPrev")}</span>
              </label>
            </div>

            {/* 自动保存状态（实时指示） */}
            <div
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-[10px]"
              style={{ borderTop: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              <span>{saving ? t("annotation.saving") : lastSavedAt ? t("annotation.saved") : t("annotation.autoSave")}</span>
              {!saving && lastSavedAt > 0 && (
                <span className="ml-auto" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {new Date(lastSavedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )}
            </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
