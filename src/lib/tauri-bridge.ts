import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DEFAULT_BACKEND_PORT, useAppStore } from "@/lib/store";

export interface CondaEnv {
  name: string;
  path: string;
  python_version: string;
  missing_packages: string[];
  is_valid: boolean;
}

export interface BackendStatus {
  running: boolean;
  healthy: boolean;
  message: string;
}

// ── 文件/目录对话框 ──

export async function browseDirectory(defaultPath?: string): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, defaultPath });
  return typeof result === "string" ? result : null;
}

export async function browseFile(
  filters: { name: string; extensions: string[] }[],
  defaultPath?: string
): Promise<string | null> {
  const result = await open({ multiple: false, filters, defaultPath });
  return typeof result === "string" ? result : null;
}

export async function browseSaveFile(
  filters: { name: string; extensions: string[] }[],
  defaultPath?: string
): Promise<string | null> {
  const result = await save({ filters, defaultPath });
  return typeof result === "string" ? result : null;
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke("write_text_file", { path, content });
}

// ── Conda / Backend ──

export async function listCondaEnvs(): Promise<CondaEnv[]> {
  return invoke<CondaEnv[]>("list_conda_envs");
}

export async function startBackend(
  pythonExe: string,
  appDir: string,
  port: number
): Promise<void> {
  return invoke("start_backend", { pythonExe, appDir, port });
}

export async function stopBackend(): Promise<void> {
  return invoke("stop_backend");
}

export async function backendHealth(port: number): Promise<BackendStatus> {
  return invoke<BackendStatus>("backend_health", { port });
}

export async function checkBackendAlive(port: number): Promise<boolean> {
  return invoke<boolean>("check_backend_alive", { port });
}

export async function getBackendLog(): Promise<string> {
  return invoke<string>("get_backend_log");
}

export async function getAppDir(): Promise<string> {
  return invoke<string>("get_app_dir");
}

/** 通用 HTTP GET，绕过 CORS，返回响应文本（用于版本检查等） */
export async function fetchText(url: string): Promise<string> {
  return invoke<string>("fetch_text", { url });
}

const DOWNLOAD_PAGE = "https://eds.tsagent.cc/index.html";

export interface UpdateInfo {
  has_update: boolean;
  latest_version: string;
  current_version: string;
  release_url: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 从产品下载页 HTML 解析最新版本，不依赖 GitHub API。
 * 页面需包含 `releases/tag/vX.X.X` 格式的链接（由 sync-r2.yml 生成的 index.html 满足此条件）。
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo> {
  const html = await fetchText(`${DOWNLOAD_PAGE}?_=${Date.now()}`);
  const match = html.match(/releases\/tag\/v(\d+\.\d+\.\d+)/);
  if (!match) throw new Error("无法从产品页解析版本信息，请稍后再试");
  const latest_version = match[1];
  return {
    has_update: compareVersions(latest_version, currentVersion) > 0,
    latest_version,
    current_version: currentVersion,
    release_url: DOWNLOAD_PAGE,
  };
}

// ── API 调用（直接 fetch，Tauri 和 Web 均可用）──

function getBackendBase(): string {
  const port = useAppStore.getState().config?.port ?? DEFAULT_BACKEND_PORT;
  return `http://127.0.0.1:${port}`;
}

// API Token 缓存：从 Tauri 后端读取一次，后续请求复用
// undefined = 尚未读取；null = 无 token（未配置或 Web 模式）
let _apiToken: string | null | undefined = undefined;

async function resolveApiToken(): Promise<string | null> {
  if (_apiToken !== undefined) return _apiToken;
  try {
    const appDir = await getAppDir();
    const cfg = await invoke<{ api_token: string | null }>(
      "get_backend_client_config",
      { appDir }
    );
    _apiToken = cfg.api_token || null;
  } catch {
    // Web 模式或 Tauri 命令不可用时降级为无 token
    _apiToken = null;
  }
  return _apiToken;
}

async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const token = await resolveApiToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["X-API-Token"] = token;
  const res = await fetch(`${getBackendBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  analyzeDataset: (params: { image_dir?: string; label_dir?: string; yaml_path?: string }) =>
    apiPost("/api/dataset/analyze", params),
  parseYaml: (params: { yaml_path: string }) =>
    apiPost("/api/dataset/parse-yaml", params),
  listImages: (params: {
      image_dir: string;
      label_dir?: string;
      filter?: 'all' | 'with_label' | 'no_label';
      class_filter?: number;
      page?: number;
      page_size?: number;
    }) =>
    apiPost("/api/dataset/list-images", params),
  previewImage: (params: { image_path: string; label_path?: string; class_names?: string[] }) =>
    apiPost("/api/dataset/preview", params),

  convertLabelme2yolo: (params: object) => apiPost("/api/convert/labelme2yolo", params),
  convertVoc2yolo: (params: object) => apiPost("/api/convert/voc2yolo", params),
  convertYolo2voc: (params: object) => apiPost("/api/convert/yolo2voc", params),
  convertYoloClassRemap: (params: object) => apiPost("/api/convert/yolo-class-remap", params),

  labelChangeClass: (params: object) => apiPost("/api/label/change-class", params),
  labelDeleteClass: (params: object) => apiPost("/api/label/delete-class", params),
  labelReorder: (params: object) => apiPost("/api/label/reorder", params),

  fileCheckConsistency: (params: object) => apiPost("/api/file/check-consistency", params),
  fileDeleteEmptyLabels: (params: object) => apiPost("/api/file/delete-empty-labels", params),
  fileCreateEmptyLabels: (params: object) => apiPost("/api/file/create-empty-labels", params),
  fileBatchRename: (params: object) => apiPost("/api/file/batch-rename", params),
  fileRepairImages: (params: object) => apiPost("/api/file/repair-images", params),

  splitRun: (params: object) => apiPost("/api/split/run", params),

  // Phase 3: v0.2.0 功能
  bboxHistogram: (params: { label_dir: string }) =>
    apiPost("/api/dataset/bbox-histogram", params),
  exportCoco: (params: { image_dir: string; label_dir: string; output_path: string; class_names?: string[] }) =>
    apiPost("/api/export/coco", params),
  mergeDatasets: (params: object) => apiPost("/api/merge/run", params),
  augmentPreview: (params: { image_path: string; label_path?: string; augments?: string[]; class_names?: string[] }) =>
    apiPost("/api/augment/preview", params),
  thumbnails: (params: { paths: string[]; size?: number }) =>
    apiPost("/api/dataset/thumbnails", params),

  // 视频抽帧
  videoInfo: (params: { video_path: string }) =>
    apiPost("/api/video/info", params),
  videoExtractFrames: (params: { video_path: string; output_dir: string; interval_frames?: number; format?: string; quality?: number; prefix?: string; num_workers?: number }) =>
    apiPost<{ success: boolean; task_id?: string; message?: string }>("/api/video/extract-frames", params),
  videoExtractStatus: (params: { task_id: string }) =>
    apiPost<{ success: boolean; state?: string; saved?: number; total_frames?: number; result?: Record<string, unknown> }>("/api/video/extract-status", params),
  videoStopExtract: (params: { task_id: string }) =>
    apiPost("/api/video/stop-extract", params),

  // AI 视频智能抽帧
  videoAiCheck: () =>
    apiPost<{ available: boolean; version?: string; message?: string; default_model?: string }>("/api/video/ai-check", {}),
  videoAiExtractFrames: (params: { video_path: string; output_dir: string; target_classes: string; model_path?: string; conf_threshold?: number; interval_frames?: number; format?: string; quality?: number; prefix?: string; max_parallel?: number; batch_size?: number; segment_minutes?: number }) =>
    apiPost<{ success: boolean; task_id?: string; message?: string }>("/api/video/ai-extract-frames", params),
  videoAiExtractStatus: (params: { task_id: string }) =>
    apiPost<{ success: boolean; state?: string; processed?: number; saved?: number; total_frames?: number; result?: Record<string, unknown> }>("/api/video/ai-extract-status", params),
  videoAiStopExtract: (params: { task_id: string }) =>
    apiPost("/api/video/ai-stop-extract", params),
};
