/**
 * 版本检查与安装包选择。
 *
 * 数据来源优先级：
 *   1. 发布清单 `https://dl.tsagent.cc/easy-dataset/latest.json`
 *      （官网下载按钮用的就是它，含 version + 各平台安装包直链 + sha256）
 *   2. 兜底：抓官网 HTML 里的 `releases/tag/vX.Y.Z`
 *      （新版官网是 Astro + JS 渲染，HTML 里已不含版本号，仅作旧环境兜底）
 *
 * 网络请求统一走 Rust 的 `fetch_text`，绕开 WebView 的 CORS 与证书限制。
 * 任何一步失败都只影响「显示更新提示」，不能阻断软件使用。
 */

import { invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "./version";
import {
  DOWNLOAD_PAGE_URL,
  PRODUCT_HOME_URL,
  RELEASES_URL,
  RELEASE_MANIFEST_URL,
  REPO_URL,
} from "./links";

export interface ReleaseFile {
  os: string;
  arch: string;
  kind: string;
  name: string;
  url: string;
  size?: number;
  sha256?: string;
}

export interface UpdateInfo {
  has_update: boolean;
  latest_version: string;
  current_version: string;
  /** 发布时间（ISO 字符串），拿不到时为 null。 */
  released_at: string | null;
  /** 更新说明（Markdown 原文），拿不到时为空串。 */
  release_notes: string;
  /** 本平台安装包直链；拿不到时为 null，调用方应回退到官网。 */
  download_url: string | null;
  /** 安装包文件名，用于展示。 */
  download_name: string | null;
  /** 清单里的全部安装包，可用于展示其它平台。 */
  files: ReleaseFile[];
  product_url: string;
  releases_url: string;
}

interface PlatformInfo {
  os: string;
  arch: string;
}

/** 各平台安装包优先级（越靠前越推荐）。 */
const KIND_PRIORITY: Record<string, string[]> = {
  windows: ["exe", "msi"],
  macos: ["dmg", "app", "app.tar.gz"],
  linux: ["appimage", "deb", "rpm"],
};

/** 数字版本比较，`1.2.0-beta.1` 视作 `1.2.0`（本地版本不含预发布号）。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    String(value || "")
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let cachedPlatform: PlatformInfo | null = null;

/** 当前平台（编译目标），用于从清单里挑安装包。 */
export async function getPlatform(): Promise<PlatformInfo> {
  if (cachedPlatform) return cachedPlatform;
  try {
    const info = await invoke<PlatformInfo>("platform_info");
    if (info?.os) {
      // 只缓存真正读到的值：UA 猜测的架构不可靠（macOS Rosetta 无法分辨）
      cachedPlatform = info;
      return info;
    }
  } catch {
    // 非 Tauri 环境（如浏览器调试）走下面的兜底
  }
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua)
    ? "windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macos"
      : /Linux/i.test(ua)
        ? "linux"
        : "unknown";
  return { os, arch: "x64" };
}

/** 从清单里挑出本平台最合适的安装包：先按架构精确匹配，再按包类型优先级。 */
export function pickInstaller(
  files: ReleaseFile[],
  platform: PlatformInfo
): ReleaseFile | null {
  const sameOs = files.filter((file) => file.os === platform.os);
  if (sameOs.length === 0) return null;

  const sameArch = sameOs.filter((file) => file.arch === platform.arch);
  const pool = sameArch.length > 0 ? sameArch : sameOs;
  const priority = KIND_PRIORITY[platform.os] ?? [];

  const rank = (file: ReleaseFile) => {
    const index = priority.indexOf(String(file.kind || "").toLowerCase());
    return index === -1 ? priority.length : index;
  };
  return [...pool].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** 公开发布接口不需要 token，但受 60 次/小时/IP 限流；失败一律忽略。 */
async function fetchReleaseNotes(version: string): Promise<string> {
  try {
    const text = await invoke<string>("fetch_text", {
      url: `https://api.github.com/repos/MWang-TS/easy-dataset/releases/tags/v${version}`,
    });
    const json = JSON.parse(text) as { body?: unknown };
    return typeof json.body === "string" ? json.body.trim() : "";
  } catch {
    return "";
  }
}

async function fetchManifest(): Promise<{
  version: string;
  released_at: string | null;
  files: ReleaseFile[];
}> {
  const text = await invoke<string>("fetch_text", {
    url: `${RELEASE_MANIFEST_URL}?_=${Date.now()}`,
  });
  const json = JSON.parse(text) as {
    version?: unknown;
    released_at?: unknown;
    files?: unknown;
  };
  const version = typeof json.version === "string" ? json.version.trim() : "";
  if (!version) throw new Error("发布清单缺少 version 字段");

  const files: ReleaseFile[] = Array.isArray(json.files)
    ? (json.files as ReleaseFile[]).filter(
        (file) => file && typeof file.url === "string" && typeof file.os === "string"
      )
    : [];

  return {
    version,
    released_at: typeof json.released_at === "string" ? json.released_at : null,
    files,
  };
}

/** 兜底：老官网 HTML 里仍带 `releases/tag/vX.Y.Z` 时可用。 */
async function fetchVersionFromPage(): Promise<string> {
  const html = await invoke<string>("fetch_text", {
    url: `${DOWNLOAD_PAGE_URL}?_=${Date.now()}`,
  });
  const match = html.match(/releases\/tag\/v(\d+\.\d+\.\d+)/);
  if (!match) throw new Error("无法从产品页解析版本信息，请稍后再试");
  return match[1];
}

/**
 * 检查更新。
 *
 * @param currentVersion 当前版本，默认取构建期注入的 `APP_VERSION`。
 */
export async function checkForUpdates(currentVersion: string = APP_VERSION): Promise<UpdateInfo> {
  const platform = await getPlatform();

  let latestVersion = "";
  let releasedAt: string | null = null;
  let files: ReleaseFile[] = [];

  try {
    const manifest = await fetchManifest();
    latestVersion = manifest.version;
    releasedAt = manifest.released_at;
    files = manifest.files;
  } catch (manifestError) {
    // 清单不可用时退回解析官网 HTML；两条路都失败才把错误抛给 UI
    try {
      latestVersion = await fetchVersionFromPage();
    } catch {
      throw manifestError instanceof Error
        ? manifestError
        : new Error("无法获取最新版本信息，请检查网络后重试");
    }
  }

  const installer = pickInstaller(files, platform);
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
  // 只在真的有更新时去取说明：GitHub 开放接口限 60 次/小时/IP，
  // 每次启动的静默检查都打一次是没必要的浪费
  const releaseNotes = hasUpdate ? await fetchReleaseNotes(latestVersion) : "";

  return {
    has_update: hasUpdate,
    latest_version: latestVersion,
    current_version: currentVersion,
    released_at: releasedAt,
    release_notes: releaseNotes,
    download_url: installer?.url ?? null,
    download_name: installer?.name ?? null,
    files,
    product_url: PRODUCT_HOME_URL,
    releases_url: RELEASES_URL || `${REPO_URL}/releases`,
  };
}
