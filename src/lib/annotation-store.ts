/**
 * annotation-store.ts
 * 图片标注窗口的状态与 IO 编排。
 *
 * 与后端契约（`services/annotation_service.py`）保持一致：
 *   - 标注文件路径推导规则
 *   - YOLO 5 列矩形 / 多边形 seg 行
 *   - 每次编辑后自动落盘（防抖 250ms + 串行队列）
 */
import { create } from "zustand";
import { api } from "@/lib/tauri-bridge";

export interface YoloBox {
  class_id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  polygon?: [number, number][] | null;
}

export interface AnnotationBox extends YoloBox {
  /** 仅前端：临时 id，用于选中/编辑，不落盘 */
  id: string;
}

export interface AnnotationImage {
  path: string;
  name: string;
  label_path: string;
  has_label: boolean;
  empty_label: boolean;
  box_count: number;
}

/** 数据集标注类型：目标检测 / 旋转框 / 分割 / 混合 / 无标注 */
export type LabelType = "detect" | "obb" | "segment" | "mixed" | "none";

export interface AutoLabelProgress {
  state: string;
  total: number;
  processed: number;
  labeled: number;
  skipped: number;
  current: string;
  message?: string;
  errors: string[];
}

let boxSeq = 0;
function generateId(): string {
  boxSeq += 1;
  return `box-${Date.now()}-${boxSeq}`;
}

export function toAnnotationBox(box: YoloBox): AnnotationBox {
  return { ...box, id: generateId() };
}

/** 仅保留协议字段，前端临时 id 不落盘 */
export function toProtocolBox(box: AnnotationBox): YoloBox {
  const out: YoloBox = {
    class_id: box.class_id,
    cx: box.cx,
    cy: box.cy,
    w: box.w,
    h: box.h,
  };
  if (box.polygon && box.polygon.length >= 3) {
    out.polygon = box.polygon;
  }
  return out;
}

/**
 * 图片 → 标注文件路径（与后端 `label_path_for` 一致）。
 * 注意：先按 posix 规范化再拼接，Windows 下后端两种分隔符都接受。
 */
export function labelPathFor(imagePath: string, labelOutputDir = ""): string {
  const normalized = imagePath.replace(/\\/g, "/");
  const stem = normalized.split("/").pop()!.replace(/\.(jpg|jpeg|png|bmp|webp)$/i, ".txt");
  if (labelOutputDir.trim()) {
    return `${labelOutputDir.replace(/[\\/]$/, "")}/${stem}`;
  }
  // 把最后一个 images 目录段换成 labels（兼容 images/train/a.jpg → labels/train/a.txt）
  const parts = normalized.split("/");
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i].toLowerCase() === "images") {
      parts[i] = "labels";
      parts[parts.length - 1] = stem;
      return parts.join("/");
    }
  }
  parts[parts.length - 1] = stem;
  return parts.join("/");
}

// ── 保存队列：防抖 + 串行，保证磁盘内容是最后一次编辑 ──

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: { labelPath: string; boxes: YoloBox[] } | null = null;
let isFlushing = false;
/** 上一张已加载图片及其标注（用于“自动沿用上一张标注”） */
let prevLoaded: { index: number; boxes: YoloBox[] } | null = null;
/** 标注剪贴板（Ctrl+C / Ctrl+V）：跨图片共享，只存协议字段 */
let boxClipboard: { box: YoloBox; offset: number } | null = null;

interface AnnotationState {
  /** edit：标注与图片同源，原地修改；new：文件夹只有图片，另设输出目录 */
  mode: "edit" | "new";
  /** 手动指定（可选）：目录命名不规整时覆盖自动推断 */
  manualImageDir: string;
  manualLabelDir: string;
  dir: string;
  labelOutputDir: string;
  imageRoot: string;
  layout: string;
  images: AnnotationImage[];
  currentIndex: number;
  /** 当前数据集的标注类型（由后端抽样统计） */
  labelType: LabelType;

  dataUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  currentLabelPath: string;
  boxes: AnnotationBox[];
  selectedId: string | null;
  /** 切到相邻下一张时，若该图还没有标签文件，自动复制上一张的标注 */
  autoCopyPrev: boolean;
  /** 画布处于平移模式时：面板只读，且不自动生成标注 */
  panMode: boolean;

  classes: Record<string, string>;
  classFileMsg: string | null;
  /** 自动探测到的类别定义文件（未手动指定时展示） */
  autoClassFile: string | null;

  loading: boolean;
  saving: boolean;
  lastSavedAt: number;
  error: string | null;

  history: AnnotationBox[][];
  future: AnnotationBox[][];

  autoLabeling: boolean;
  autoLabelTaskId: string | null;
  autoLabelProgress: AutoLabelProgress | null;

  openFolder: (dir: string, labelOutputDir?: string, imageDir?: string, labelDir?: string) => Promise<void>;
  setMode: (mode: "edit" | "new") => void;
  reloadList: () => Promise<void>;
  loadImage: (index: number) => Promise<void>;
  nextImage: () => Promise<void>;
  prevImage: () => Promise<void>;

  addBox: (box: YoloBox) => void;
  updateBox: (id: string, patch: Partial<YoloBox>, recordHistory?: boolean) => void;
  deleteBox: (id: string) => void;
  duplicateBox: (id: string) => void;
  copyBox: (id: string) => void;
  pasteBox: () => void;
  /** 剪贴板是否有内容（供 UI 控制粘贴按钮可用状态） */
  hasClipboard: () => boolean;
  setBoxClass: (id: string, classId: number) => void;
  selectBox: (id: string | null) => void;
  setAutoCopyPrev: (value: boolean) => void;
  setPanMode: (value: boolean) => void;

  undo: () => void;
  redo: () => void;

  queueSave: () => void;
  flushSave: () => Promise<void>;
  clearError: () => void;

  setClasses: (classes: Record<string, string>) => void;
  setClassName: (id: number, name: string) => void;
  setClassFileMsg: (msg: string | null) => void;
  setAutoClassFile: (path: string | null) => void;

  startAutoLabel: (params: {
    modelPath: string;
    conf?: number;
    overwrite?: boolean;
    outputDir?: string;
  }) => Promise<void>;
  stopAutoLabel: () => Promise<void>;
  dismissAutoLabel: () => void;
  reset: () => void;
}

const HISTORY_LIMIT = 50;

function clone(boxes: AnnotationBox[]): AnnotationBox[] {
  return boxes.map((b) => ({
    ...b,
    polygon: b.polygon ? b.polygon.map((p) => [p[0], p[1]] as [number, number]) : b.polygon,
  }));
}

export const useAnnotationStore = create<AnnotationState>((set, get) => {
  // 加载竞态保护：只有最后一次请求的结果可以被应用
  let loadToken = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (isFlushing) return;
    isFlushing = true;
    try {
      while (pendingSave) {
        const job = pendingSave;
        pendingSave = null;
        set({ saving: true });
        try {
          const res = await api.annotationWriteLabel({ label_path: job.labelPath, boxes: job.boxes });
          if (res.success) {
            set({ lastSavedAt: Date.now(), error: null });
          } else {
            set({ error: `保存失败: ${res.message || "未知错误"}` });
          }
        } catch (e) {
          set({ error: `保存失败: ${String(e)}` });
        }
      }
    } finally {
      isFlushing = false;
      set({ saving: false });
    }
  };

  const scheduleSave = () => {
    const state = get();
    if (!state.currentLabelPath) return;
    pendingSave = {
      labelPath: state.currentLabelPath,
      boxes: state.boxes.map(toProtocolBox),
    };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, 250);
  };

  const pushHistory = () => {
    const { boxes, history } = get();
    const next = [...history, clone(boxes)].slice(-HISTORY_LIMIT);
    set({ history: next, future: [] });
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const pollAutoLabel = async (taskId: string) => {
    const tick = async () => {
      try {
        const res = await api.annotationAutoLabelStatus({ task_id: taskId });
        if (!res.success) {
          set({ autoLabeling: false, autoLabelTaskId: null });
          return;
        }
        set({
          autoLabelProgress: {
            state: res.state || "running",
            total: res.total || 0,
            processed: res.processed || 0,
            labeled: res.labeled || 0,
            skipped: res.skipped || 0,
            current: res.current || "",
            message: res.message,
            errors: res.errors || [],
          },
        });
        if (["done", "error", "stopped"].includes(res.state || "")) {
          set({ autoLabeling: false, autoLabelTaskId: null });
          stopPolling();
          // 标完当前图的 txt 可能已变化，刷新列表并重载当前图
          await get().reloadList();
          await get().loadImage(Math.max(0, get().currentIndex));
          return;
        }
        pollTimer = setTimeout(() => void tick(), 600);
      } catch (e) {
        set({ autoLabeling: false, autoLabelTaskId: null, error: `自动标注失败: ${String(e)}` });
        stopPolling();
      }
    };
    pollTimer = setTimeout(() => void tick(), 400);
  };

  return {
    mode: "edit",
    manualImageDir: "",
    manualLabelDir: "",
    dir: "",
    labelOutputDir: "",
    imageRoot: "",
    layout: "flat",
    images: [],
    currentIndex: -1,
    labelType: "none",

    dataUrl: null,
    imageWidth: 0,
    imageHeight: 0,
    currentLabelPath: "",
    boxes: [],
    selectedId: null,
    autoCopyPrev: true,
    panMode: false,

    classes: {},
    classFileMsg: null,
    autoClassFile: null,

    loading: false,
    saving: false,
    lastSavedAt: 0,
    error: null,

    history: [],
    future: [],

    autoLabeling: false,
    autoLabelTaskId: null,
    autoLabelProgress: null,

    openFolder: async (dir, labelOutputDir = "", imageDir = "", labelDir = "") => {
      await get().flushSave();
      prevLoaded = null;
      const mode = get().mode;
      set({
        dir,
        labelOutputDir,
        manualImageDir: imageDir,
        manualLabelDir: labelDir,
        loading: true,
        error: null,
        dataUrl: null,
        boxes: [],
        selectedId: null,
        currentIndex: -1,
        labelType: "none",
        history: [],
        future: [],
      });
      try {
        const res = await api.annotationListImages({
          dir_path: dir,
          label_output_dir: labelOutputDir,
          image_dir: imageDir,
          label_dir: labelDir,
        });
        if (!res.success) {
          set({ loading: false, images: [], error: res.message || "加载目录失败" });
          return;
        }
        const images = (res.images || []) as AnnotationImage[];
        set({
          images,
          imageRoot: res.image_root || "",
          layout: res.layout || "flat",
          labelType: res.label_type || "none",
          loading: false,
        });
        if (images.length === 0) {
          set({ error: "该目录下没有找到图片文件" });
          return;
        }
        // 类别为空时自动解析：优先 classes.txt / data.yaml，其次已有标注 id（两种模式都适用）
        if (Object.keys(get().classes).length === 0) {
          try {
            const detected = await api.annotationDetectClasses({ dir_path: dir });
            if (detected.success && detected.classes && Object.keys(detected.classes).length > 0) {
              set({ classes: detected.classes, autoClassFile: detected.class_file || null, classFileMsg: null });
            } else {
              set({ autoClassFile: null });
              if (Object.keys(get().classes).length === 0) {
                const scan = await api.annotationScanClassIds({
              dir_path: dir,
              label_output_dir: labelOutputDir,
              image_dir: imageDir,
              label_dir: labelDir,
            });
                if (scan.success && scan.class_ids && scan.class_ids.length > 0) {
                  set({ classes: Object.fromEntries(scan.class_ids.map((id) => [String(id), `class ${id}`])) });
                }
              }
            }
          } catch {
            /* 探测失败忽略，不影响打开文件夹 */
          }
        }
        await get().loadImage(0);
      } catch (e) {
        set({ loading: false, error: String(e) });
      }
    },

    setMode: (mode) => set({ mode }),

    reloadList: async () => {
      const { dir, labelOutputDir, manualImageDir, manualLabelDir } = get();
      if (!dir && !manualImageDir) return;
      try {
        const res = await api.annotationListImages({
          dir_path: dir,
          label_output_dir: labelOutputDir,
          image_dir: manualImageDir,
          label_dir: manualLabelDir,
        });
        if (res.success) {
          set({
            images: (res.images || []) as AnnotationImage[],
            labelType: res.label_type || "none",
          });
        }
      } catch {
        /* 刷新失败忽略 */
      }
    },

    loadImage: async (index) => {
      const state = get();
      if (index < 0 || index >= state.images.length) return;
      // 切图前必须把上一张的改动落盘，避免防抖队列写到新图上
      await state.flushSave();
      // 记录上一张的标注快照（含未保存的编辑），供自动沿用
      if (state.currentIndex >= 0) {
        prevLoaded = { index: state.currentIndex, boxes: state.boxes.map(toProtocolBox) };
      }

      const image = state.images[index];
      const token = ++loadToken;
      set({
        loading: true,
        error: null,
        currentIndex: index,
        selectedId: null,
        dataUrl: null,
        boxes: [],
        history: [],
        future: [],
        currentLabelPath: image.label_path || labelPathFor(image.path, state.labelOutputDir),
      });
      try {
        const [img, label] = await Promise.all([
          api.annotationImage({ image_path: image.path, max_dim: 1600 }),
          api.annotationReadLabel({ label_path: image.label_path || labelPathFor(image.path, state.labelOutputDir) }),
        ]);
        if (token !== loadToken) return; // 已切到别的图，丢弃本次结果
        if (!img.success || !img.data_url) {
          set({ loading: false, error: img.message || "读取图片失败" });
          return;
        }
        const boxes = label.success ? ((label.boxes || []) as YoloBox[]) : [];
        // 只有当前图“没有标签文件”且上一张有标注、且是相邻下一张时才自动沿用
        let finalBoxes = boxes.map(toAnnotationBox);
        let copied = false;
        if (!label.exists && get().autoCopyPrev && !get().panMode && prevLoaded
            && prevLoaded.index === index - 1 && prevLoaded.boxes.length > 0) {
          finalBoxes = prevLoaded.boxes.map(toAnnotationBox);
          copied = true;
        }
        set({
          loading: false,
          dataUrl: img.data_url,
          imageWidth: img.width || 0,
          imageHeight: img.height || 0,
          boxes: finalBoxes,
          currentLabelPath: label.label_path || get().currentLabelPath,
        });
        if (copied) {
          set((s) => ({
            images: s.images.map((item, i) =>
              i === index ? { ...item, has_label: true, box_count: finalBoxes.length } : item
            ),
          }));
          scheduleSave();
        }
      } catch (e) {
        if (token !== loadToken) return;
        set({ loading: false, error: String(e) });
      }
    },

    nextImage: async () => {
      const { currentIndex, images } = get();
      if (currentIndex < images.length - 1) await get().loadImage(currentIndex + 1);
    },

    prevImage: async () => {
      const { currentIndex } = get();
      if (currentIndex > 0) await get().loadImage(currentIndex - 1);
    },

    addBox: (box) => {
      pushHistory();
      const created = toAnnotationBox(box);
      set((s) => ({ boxes: [...s.boxes, created], selectedId: created.id }));
      scheduleSave();
    },

    updateBox: (id, patch, recordHistory = false) => {
      if (recordHistory) pushHistory();
      set((s) => ({
        boxes: s.boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      }));
      scheduleSave();
    },

    deleteBox: (id) => {
      pushHistory();
      set((s) => ({
        boxes: s.boxes.filter((b) => b.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
      }));
      scheduleSave();
    },

    /** 复制选中框并立即粘贴一份（按钮/右键菜单用） */
    duplicateBox: (id) => {
      get().copyBox(id);
      get().pasteBox();
    },

    /** Ctrl+C：把选中框放入剪贴板（不改动画布） */
    copyBox: (id) => {
      const src = get().boxes.find((b) => b.id === id);
      if (!src) return;
      boxClipboard = { box: toProtocolBox(src), offset: 0 };
    },

    /** Ctrl+V：粘贴剪贴板内容，每次粘贴向右下递增偏移，避免完全重叠 */
    pasteBox: () => {
      if (!boxClipboard) return;
      const shiftStep = 0.01;
      boxClipboard.offset = Math.min(0.2, boxClipboard.offset + shiftStep);
      const clampUnit = (v: number) => Math.max(0, Math.min(1, v));
      const src = boxClipboard.box;
      const polygon = src.polygon && src.polygon.length >= 3
        ? src.polygon.map(([x, y]) => [x, y] as [number, number])
        : undefined;
      // 整体位移：取不超过画面边界的最小可用偏移，避免逐点 clamp 造成形状变形
      const maxX = polygon ? Math.max(...polygon.map((p) => p[0])) : src.cx + src.w / 2;
      const maxY = polygon ? Math.max(...polygon.map((p) => p[1])) : src.cy + src.h / 2;
      const dx = Math.max(0, Math.min(boxClipboard.offset, 1 - maxX));
      const dy = Math.max(0, Math.min(boxClipboard.offset, 1 - maxY));
      const moved = polygon
        ? polygon.map(([x, y]) => [clampUnit(x + dx), clampUnit(y + dy)] as [number, number])
        : undefined;
      let cx = clampUnit(src.cx + dx);
      let cy = clampUnit(src.cy + dy);
      let w = src.w;
      let h = src.h;
      if (moved) {
        const xs = moved.map((p) => p[0]);
        const ys = moved.map((p) => p[1]);
        cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        w = Math.max(...xs) - Math.min(...xs);
        h = Math.max(...ys) - Math.min(...ys);
      }
      const copy = toAnnotationBox({
        class_id: src.class_id,
        cx,
        cy,
        w,
        h,
        ...(moved ? { polygon: moved } : {}),
      });
      pushHistory();
      set((s) => ({ boxes: [...s.boxes, copy], selectedId: copy.id }));
      scheduleSave();
    },

    hasClipboard: () => boxClipboard !== null,

    setBoxClass: (id, classId) => {
      pushHistory();
      set((s) => ({
        boxes: s.boxes.map((b) => (b.id === id ? { ...b, class_id: classId } : b)),
      }));
      scheduleSave();
    },

    selectBox: (id) => set({ selectedId: id }),

    setAutoCopyPrev: (value) => set({ autoCopyPrev: value }),
    setPanMode: (value) => {
      if (get().panMode !== value) set({ panMode: value });
    },

    undo: () => {
      const { history, boxes, future } = get();
      if (history.length === 0) return;
      const previous = history[history.length - 1];
      set({
        boxes: previous,
        history: history.slice(0, -1),
        future: [...future, clone(boxes)].slice(-HISTORY_LIMIT),
        selectedId: null,
      });
      scheduleSave();
    },

    redo: () => {
      const { future, boxes, history } = get();
      if (future.length === 0) return;
      const next = future[future.length - 1];
      set({
        boxes: next,
        future: future.slice(0, -1),
        history: [...history, clone(boxes)].slice(-HISTORY_LIMIT),
        selectedId: null,
      });
      scheduleSave();
    },

    queueSave: scheduleSave,
    flushSave: flush,
    clearError: () => set({ error: null }),

    setClasses: (classes) => set({ classes }),
    setClassName: (id, name) =>
      set((s) => ({ classes: { ...s.classes, [String(id)]: name } })),
    setClassFileMsg: (msg) => set({ classFileMsg: msg }),
    setAutoClassFile: (path) => set({ autoClassFile: path }),

    startAutoLabel: async ({ modelPath, conf = 0.25, overwrite = false, outputDir = "" }) => {
      const { dir, autoLabeling, labelOutputDir, manualImageDir } = get();
      if (!dir || autoLabeling) return;
      await get().flushSave();
      set({
        autoLabeling: true,
        error: null,
        autoLabelProgress: {
          state: "running", total: 0, processed: 0, labeled: 0, skipped: 0, current: "", errors: [],
        },
      });
      try {
        const res = await api.annotationAutoLabel({
          dir_path: dir,
          model_path: modelPath,
          conf,
          output_dir: outputDir || labelOutputDir || get().manualLabelDir,
          overwrite,
          image_dir: manualImageDir,
        });
        if (!res.success || !res.task_id) {
          set({ autoLabeling: false, error: res.message || "启动自动标注失败" });
          return;
        }
        set({ autoLabelTaskId: res.task_id });
        void pollAutoLabel(res.task_id);
      } catch (e) {
        set({ autoLabeling: false, error: `自动标注失败: ${String(e)}` });
      }
    },

    stopAutoLabel: async () => {
      const taskId = get().autoLabelTaskId;
      if (!taskId) return;
      try {
        await api.annotationAutoLabelStop({ task_id: taskId });
      } catch {
        /* 忽略 */
      }
    },

    dismissAutoLabel: () => {
      stopPolling();
      set({ autoLabeling: false, autoLabelTaskId: null, autoLabelProgress: null });
    },

    reset: () => {
      stopPolling();
      loadToken += 1;
      prevLoaded = null;
      set({
        mode: "edit",
        dir: "",
        labelOutputDir: "",
        manualImageDir: "",
        manualLabelDir: "",
        imageRoot: "",
        layout: "flat",
        images: [],
        currentIndex: -1,
        labelType: "none",
        dataUrl: null,
        imageWidth: 0,
        imageHeight: 0,
        currentLabelPath: "",
        boxes: [],
        selectedId: null,
        classes: {},
        classFileMsg: null,
        autoClassFile: null,
        panMode: false,
        loading: false,
        saving: false,
        lastSavedAt: 0,
        error: null,
        history: [],
        future: [],
        autoLabeling: false,
        autoLabelTaskId: null,
        autoLabelProgress: null,
      });
    },
  };
});
