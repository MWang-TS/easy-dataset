import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEFAULT_BACKEND_PORT = 18081;

export interface AppConfig {
  mode: "conda" | "manual";
  pythonExe: string;           // 始终存在，无论哪种模式
  conda?: {                    // 仅 mode === "conda" 时有值
    envPath: string;
    envName: string;
  };
  port: number;
  appDir: string;
}

// ── 数据集分析结果类型 ──

export interface ClassDist {
  id: number;
  name: string;
  count: number;
  ratio: number;
}

export interface DatasetSummary {
  total_images: number;
  total_labels: number;
  matched_pairs: number;
  orphan_images: number;
  orphan_labels: number;
  empty_labels: number;
  total_boxes: number;
  num_classes: number;
  invalid_rows: number;
}

export interface DatasetAnalysis {
  summary: DatasetSummary;
  class_distribution: ClassDist[];
  class_names: string[];
  image_dir: string;
  label_dir: string;
  orphan_image_paths: string[];
  orphan_label_paths: string[];
  empty_label_paths: string[];
  image_size_stats: {
    avg_width: number;
    avg_height: number;
    min_width: number;
    max_width: number;
    min_height: number;
    max_height: number;
  };
  bbox_stats: {
    avg_area: number;
    avg_aspect: number;
    small_objects: number;
    large_objects: number;
  };
}

export interface AnalysisRecord {
  id: string;
  timestamp: number;
  label: string;      // 数据集显示名（文件名/目录名）
  source: string;     // yaml 路径或图片目录
  mode: "manual" | "yaml";
  result: DatasetAnalysis;
}

export interface ImageItem {
  image_path: string;
  label_path: string;
  has_label: boolean;
  filename: string;
  box_count: number;
}

function normalizeConfig(config: AppConfig | null): AppConfig | null {
  if (!config) return null;
  if (config.port && config.port !== 8081) return config;
  return { ...config, port: DEFAULT_BACKEND_PORT };
}

// ── 全局状态 ──

interface AppState {
  config: AppConfig | null;
  isConfigured: boolean;

  backendStatus: "stopped" | "starting" | "running" | "error";
  backendMessage: string;

  // 当前激活页面
  activePage: "quality" | "viewer" | "convert" | "labels" | "files" | "split" | "export" | "merge" | "augment" | "video";

  // 当前数据集上下文（跨页面共享）
  currentDatasetDir: string;
  currentLabelDir: string;
  currentYamlPath: string;
  currentClassNames: string[];

  // 分析历史记录（最多保留 10 条）
  analysisHistory: AnalysisRecord[];

  // Actions
  setConfig: (config: AppConfig) => void;
  clearConfig: () => void;
  setBackendStatus: (
    status: "stopped" | "starting" | "running" | "error",
    message?: string
  ) => void;
  setActivePage: (page: AppState["activePage"]) => void;
  setDatasetContext: (params: {
    imageDir?: string;
    labelDir?: string;
    yamlPath?: string;
    classNames?: string[];
  }) => void;
  addAnalysisRecord: (record: AnalysisRecord) => void;
  removeAnalysisRecord: (id: string) => void;
  reset: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      config: null,
      isConfigured: false,
      backendStatus: "stopped",
      backendMessage: "",
      activePage: "quality",
      currentDatasetDir: "",
      currentLabelDir: "",
      currentYamlPath: "",
      currentClassNames: [],
      analysisHistory: [],

      setConfig: (config) => set({ config: normalizeConfig(config), isConfigured: true }),
      clearConfig: () => set({ config: null, isConfigured: false }),
      setBackendStatus: (status, message = "") =>
        set({ backendStatus: status, backendMessage: message }),
      setActivePage: (activePage) => set({ activePage }),
      setDatasetContext: (params) =>
        set((s) => ({
          currentDatasetDir: params.imageDir ?? s.currentDatasetDir,
          currentLabelDir: params.labelDir ?? s.currentLabelDir,
          currentYamlPath: params.yamlPath ?? s.currentYamlPath,
          currentClassNames: params.classNames ?? s.currentClassNames,
        })),
      addAnalysisRecord: (record) =>
        set((s) => {
          // 同路径覆盖旧记录，总数限制 10 条
          const filtered = s.analysisHistory.filter((r) => r.source !== record.source);
          return { analysisHistory: [record, ...filtered].slice(0, 10) };
        }),
      removeAnalysisRecord: (id) =>
        set((s) => ({ analysisHistory: s.analysisHistory.filter((r) => r.id !== id) })),
      reset: () =>
        set({
          config: null,
          isConfigured: false,
          backendStatus: "stopped",
          backendMessage: "",
        }),
    }),
    {
      name: "easy-dataset-store",
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as Partial<AppState> | undefined) ?? {};
        const config = normalizeConfig(persisted.config ?? currentState.config);
        return {
          ...currentState,
          ...persisted,
          config,
          isConfigured: config ? true : Boolean(persisted.isConfigured ?? currentState.isConfigured),
        };
      },
      partialize: (s) => ({
        config: s.config,
        isConfigured: s.isConfigured,
        currentDatasetDir: s.currentDatasetDir,
        currentLabelDir: s.currentLabelDir,
        currentYamlPath: s.currentYamlPath,
        currentClassNames: s.currentClassNames,
        analysisHistory: s.analysisHistory,
      }),
    }
  )
);
