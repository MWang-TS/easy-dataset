import { useState, useEffect, useCallback, useRef } from "react";
import {
  BarChart2, Eye, RefreshCw, Layers, FolderCog, Scissors,
  Settings, Play, Square, Cpu, CircleHelp,
  GitMerge, Film, Minus, Maximize2, X as XIcon,
  Coffee, Sun, Moon, Globe, Check, ArrowDownToLine,
  Github, Mail, ExternalLink, Copyright, PenTool, Server,
  ChevronsLeft, ChevronsRight, Package, Download,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { DEFAULT_BACKEND_PORT, useAppStore } from "@/lib/store";
import { useTranslation } from "react-i18next";
import { setLocale, LOCALE_LABELS, type Locale } from "@/i18n/index";
import { startBackend, stopBackend, checkBackendAlive, listCondaEnvs, getAppDir, type CondaEnv, api, browseSaveFile, writeTextFile } from "@/lib/tauri-bridge";
import { checkForUpdates, type UpdateInfo } from "@/lib/update";
import { APP_VERSION } from "@/lib/version";
import { CONTACT_EMAIL, EASY_CONDA_URL, PRODUCT_HOME_URL, REPO_URL, STUDIO_URL } from "@/lib/links";
import { openExternal } from "@/lib/open-external";
import { SidebarPortalCtx } from "@/lib/sidebar-context";
import TipDialog from "@/components/TipDialog";
import UpdateDialog from "@/components/UpdateDialog";
import StatusTipMarquee from "@/components/StatusTipMarquee";

// ── 页面组件（懒加载占位，正式实现在各自文件中）──
import DatasetQuality from "./DatasetQuality";
import DatasetViewer from "./DatasetViewer";
import Annotation from "./Annotation";
import Converter from "./Converter";
import LabelEditor from "./LabelEditor";
import FileManager from "./FileManager";
import DatasetSplit from "./DatasetSplit";
import DatasetMerge from "./DatasetMerge";
import VideoFrameExtractor from "./VideoFrameExtractor";

type PageId = "quality" | "viewer" | "annotation" | "convert" | "labels" | "files" | "split" | "merge" | "video";

const NAV_ICONS: Record<PageId, React.FC<{ className?: string }>> = {
  quality: BarChart2, viewer: Eye, annotation: PenTool, convert: RefreshCw, labels: Layers,
  files: FolderCog, split: Scissors, merge: GitMerge, video: Film,
};

const PAGE_IDS: PageId[] = ["quality", "viewer", "annotation", "convert", "labels", "files", "split", "merge", "video"];

function ActivityRail({
  activePage,
  onNavigate,
  collapsed,
  onToggleSidebar,
}: {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  collapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const { t } = useTranslation();
  const [railHovered, setRailHovered] = useState(false);
  const hintExpand = collapsed && railHovered;
  return (
    <aside
      className="w-12 flex-shrink-0 flex flex-col items-center py-2"
      onMouseEnter={() => setRailHovered(true)}
      onMouseLeave={() => setRailHovered(false)}
      style={{
        background: "hsl(var(--sidebar))",
        borderRight: "1px solid hsl(var(--border))",
      }}
    >
      {/* 顶部：折叠 / 展开配置侧边栏（与侧边栏标题行齐平） */}
      <div className="pb-1.5">
        <button
          onClick={onToggleSidebar}
          className={cn(
            "w-9 h-9 rounded-md flex items-center justify-center transition-colors"
          )}
          style={{
            color: hintExpand ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
            background: hintExpand ? "hsl(var(--primary) / 0.15)" : "transparent",
          }}
          title={`${collapsed ? t('common.expandSidebar') : t('common.collapseSidebar')} (Ctrl+B)`}
        >
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>
      <div className="flex flex-col w-full items-center">
        {PAGE_IDS.map((id) => {
          const Icon = NAV_ICONS[id];
          const isActive = activePage === id;
          return (
            <div key={id} className="relative w-full flex justify-center h-11">
              {isActive && (
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 rounded-r"
                  style={{ background: "hsl(var(--primary))" }}
                />
              )}
              <button
                onClick={() => onNavigate(id)}
                title={t(`nav.${id}`)}
                className="w-9 h-11 rounded-md flex items-center justify-center"
                style={{
                  background: isActive ? "hsl(var(--accent))" : "transparent",
                  color: isActive ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
                }}
              >
                <Icon className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── 主页面 ──

export default function MainPage() {
  const { t, i18n } = useTranslation();
  const { config, activePage, backendStatus, backendMessage, setActivePage, setBackendStatus, setConfig, reset } = useAppStore();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarEl, setSidebarEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setSidebarEl(sidebarRef.current); }, []);

  // ── 打赏（Buy Me a Coffee）弹窗：走 payment-server /client/* ──
  const [coffeeOpen, setCoffeeOpen] = useState(false);

  // ── 语言切换下拉 ──
  const [langOpen, setLangOpen] = useState(false);
  const handleSetLocale = (locale: Locale) => { setLocale(locale); setLangOpen(false); };

  // ── 标题栏后端状态弹出层 ──
  const [backendOpen, setBackendOpen] = useState(false);

  // ── 检查更新弹窗 ──
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  // ── 系统设置弹窗 ──
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'env' | 'deps' | 'about'>('env');

  // ── 环境依赖（系统管理弹窗·环境依赖页签）──
  type EnvDeps = Awaited<ReturnType<typeof api.envDependencies>>;
  const [deps, setDeps] = useState<EnvDeps | null>(null);
  const [depsLoading, setDepsLoading] = useState(false);
  const [depsError, setDepsError] = useState<string | null>(null);
  const [depsIncludeAI, setDepsIncludeAI] = useState(true);
  const [depsExported, setDepsExported] = useState<string | null>(null);

  const loadDeps = useCallback(async (includeAI: boolean) => {
    setDepsLoading(true);
    setDepsError(null);
    setDepsExported(null);
    try {
      const res = await api.envDependencies({ include_ai: includeAI });
      if (!res.success) {
        setDeps(null);
        setDepsError(res.message || t('settings.depsLoadFailed'));
        return;
      }
      setDeps(res);
    } catch (e) {
      setDeps(null);
      setDepsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDepsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'deps') return;
    void loadDeps(depsIncludeAI);
  }, [settingsOpen, settingsTab, depsIncludeAI, loadDeps]);

  const handleExportEnvYaml = useCallback(async () => {
    if (!deps?.yaml) return;
    setDepsError(null);
    try {
      const target = await browseSaveFile(
        [{ name: 'Conda Environment', extensions: ['yml', 'yaml'] }],
        'environment.yml',
      );
      if (!target) return;
      await writeTextFile(target, deps.yaml);
      setDepsExported(target);
    } catch (e) {
      setDepsError(e instanceof Error ? e.message : String(e));
    }
  }, [deps]);

  // 版本号唯一真相源：package.json（构建期注入），不再异步向 Tauri 讨要
  const appVersion = APP_VERSION;

  // 启动 5 秒后静默检测新版本（失败不提示，不阻断使用）
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const info = await checkForUpdates(appVersion);
        if (info.has_update) setUpdateInfo(info);
      } catch { /* 静默忽略 */ }
    }, 5000);
    return () => clearTimeout(timer);
  }, [appVersion]);

  // 窗口失焦 / 页面隐藏时暂停所有 CSS 动画，避免 WebView2 后台空转重绘（GPU 占用高）
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      root.classList.toggle("app-inactive", document.hidden || !document.hasFocus());
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("blur", sync);
    window.addEventListener("focus", sync);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("blur", sync);
      window.removeEventListener("focus", sync);
      root.classList.remove("app-inactive");
    };
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true);
    setUpdateError(null);
    setUpdateInfo(null);
    try {
      const info = await checkForUpdates(appVersion);
      setUpdateInfo(info);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
      setUpdateOpen(true);
    }
  }, [appVersion]);
  const [envList, setEnvList] = useState<CondaEnv[]>([]);
  const [envScanning, setEnvScanning] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const scanEnvs = useCallback(async () => {
    setEnvScanning(true);
    try { setEnvList(await listCondaEnvs()); }
    catch { setEnvList([]); }
    finally { setEnvScanning(false); }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('light', next === 'light');
      return next;
    });
  }, []);

  // ── 侧边栏宽度拖拽 ──
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('easy-dataset:sidebar-collapsed') === '1'
  );
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  // 折叠状态持久化 + Ctrl/Cmd+B 快捷键
  useEffect(() => {
    localStorage.setItem('easy-dataset:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartW.current = sidebarWidth;
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = e.clientX - resizeStartX.current;
      setSidebarWidth(Math.max(200, Math.min(560, resizeStartW.current + delta)));
    };
    const onUp = () => { isResizing.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 启动后端
  const handleStartBackend = useCallback(async () => {
    if (!config) {
      setBackendStatus("error", "配置缺失，请重新运行设置向导。");
      return;
    }
    setBackendStatus("starting", "正在启动...");
    try {
      // 若持久化的 appDir 为空（旧配置 bug），实时获取并更新
      let resolvedAppDir = config.appDir;
      if (!resolvedAppDir) {
        resolvedAppDir = await getAppDir();
        setConfig({ ...config, appDir: resolvedAppDir });
      }
      // 如果 BackendState 里存有已退出的旧子进程，先清理再启动
      try { await startBackend(config.pythonExe, resolvedAppDir, config.port); }
      catch (e) {
        if (String(e).includes("后端已在运行")) {
          // 旧子进程可能已死，停掉后重试
          try { await stopBackend(); } catch (_) {}
          await startBackend(config.pythonExe, resolvedAppDir, config.port);
        } else {
          throw e;
        }
      }
      // 轮询健康检查
      let retries = 20;
      while (retries-- > 0) {
        await new Promise((r) => setTimeout(r, 800));
        const alive = await checkBackendAlive(config.port);
        if (alive) {
          setBackendStatus("running", "");
          return;
        }
      }
      setBackendStatus("error", "启动超时");
    } catch (e) {
      setBackendStatus("error", String(e));
    }
  }, [config, setBackendStatus]);

  const handleStopBackend = useCallback(async () => {
    try {
      await stopBackend();
    } catch (_) {}
    setBackendStatus("stopped", "");
  }, [setBackendStatus]);

  // 自动启动
  useEffect(() => {
    if (backendStatus === "stopped" && config) {
      handleStartBackend();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 后端健康保活：运行中每 15 秒探测一次，崩溃时更新状态
  useEffect(() => {
    if (backendStatus !== "running" || !config) return;
    const id = setInterval(async () => {
      const alive = await checkBackendAlive(config.port).catch(() => false);
      if (!alive) setBackendStatus("error", "后端已停止响应");
    }, 15000);
    return () => clearInterval(id);
  }, [backendStatus, config, setBackendStatus]);

  const handleReconfigure = async () => {
    if (await confirm("重新配置将停止当前后端并返回设置向导，确认继续？", {
      title: "重新配置",
      kind: "warning",
    })) {
      handleStopBackend();
      reset();
    }
  };

  const pages: Record<PageId, React.ReactNode> = {
    quality: <DatasetQuality />,
    viewer: <DatasetViewer />,
    annotation: <Annotation />,
    convert: <Converter />,
    labels: <LabelEditor />,
    files: <FileManager />,
    split: <DatasetSplit />,
    merge: <DatasetMerge />,
    video: <VideoFrameExtractor />,
  };

  const currentPageId = (activePage as PageId) in NAV_ICONS ? (activePage as PageId) : "quality";
  const ActiveIcon = NAV_ICONS[currentPageId];
  const activePageLabel = t(`nav.${currentPageId}`);
  const pageDescription = t(`pageDesc.${currentPageId}`);

  const statusColor = ({
    stopped: "hsl(var(--muted-foreground))",
    starting: "hsl(var(--warning))",
    running: "hsl(var(--success))",
    error: "hsl(var(--destructive))",
  } as Record<string, string>)[backendStatus] ?? "hsl(var(--muted-foreground))";

  const statusText = t(`backend.${backendStatus === "stopped" ? "disconnected" : backendStatus === "starting" ? "connecting" : backendStatus === "running" ? "connected" : "disconnected"}`);

  return (
    <div className="h-screen overflow-hidden flex flex-col" style={{ background: "hsl(var(--background))" }}>
      {/* ── 全宽标题栏 ── */}
      <header
        className="h-11 flex items-center gap-2.5 flex-shrink-0"
        data-tauri-drag-region
        style={{ background: "transparent", paddingLeft: 19, paddingRight: 0 }}
      >
        <img src="/app-icon.svg" alt="Easy Dataset" className="w-7 h-7 rounded flex-shrink-0" />
        <span className="text-xs font-semibold" style={{ color: "hsl(var(--foreground))" }}>Easy Dataset</span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
          style={{
            color: 'hsl(var(--muted-foreground))',
            background: 'hsl(var(--muted))',
            border: '1px solid hsl(var(--border))',
          }}
          title={t('update.currentVersion', { version: `v${appVersion}` })}
        >
          v{appVersion}
        </span>
        {updateInfo?.has_update && (
          <button
            onClick={() => setUpdateOpen(true)}
            className="text-xs px-1.5 py-0.5 rounded font-medium"
            style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}
            title={t('update.newVersion', { version: `v${updateInfo.latest_version}` })}
          >
            ↑ v{updateInfo.latest_version}
          </button>
        )}
        <div className="flex-1" />
        <div className="flex items-center ml-2 gap-0.5">
          {/* 后端状态：小图标 + 状态点，点击弹出启停控制 */}
          <div className="relative">
            <button
              onClick={() => setBackendOpen(v => !v)}
              className="relative w-8 h-7 flex items-center justify-center rounded"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              title={statusText}
            >
              <Server className="w-3.5 h-3.5" />
              <span
                className="absolute right-1 bottom-0.5 w-1.5 h-1.5 rounded-full"
                style={{ background: statusColor, boxShadow: '0 0 0 2px hsl(var(--card))' }}
              />
            </button>
            {backendOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBackendOpen(false)} />
                <div
                  className="absolute right-0 top-full mt-1 rounded-lg z-50 shadow-lg p-3"
                  style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', minWidth: 220 }}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor }} />
                    <span className="text-xs font-medium">{statusText}</span>
                  </div>
                  <div className="mt-1.5 text-[11px] leading-5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {backendStatus === 'error' ? backendMessage || t('backend.errorHint') : t('backend.hint')}
                  </div>
                  {backendStatus === 'running' ? (
                    <button
                      onClick={() => { setBackendOpen(false); handleStopBackend(); }}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 h-7 rounded-md text-xs"
                      style={{ background: 'rgba(197, 15, 31, 0.12)', color: 'hsl(var(--destructive))', border: '1px solid rgba(197, 15, 31, 0.24)' }}
                    >
                      <Square className="w-3 h-3" />
                      {t('backend.stop')}
                    </button>
                  ) : (
                    <button
                      onClick={() => { setBackendOpen(false); handleStartBackend(); }}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 h-7 rounded-md text-xs"
                      style={{ background: 'hsl(var(--primary))', color: 'white' }}
                    >
                      <Play className="w-3 h-3" />
                      {t('backend.start')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <button
            onClick={toggleTheme}
            className="w-8 h-7 flex items-center justify-center rounded"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={theme === 'dark' ? t('common.lightMode') : t('common.darkMode')}
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <div className="relative">
            <button
              onClick={() => setLangOpen(v => !v)}
              className="w-8 h-7 flex items-center justify-center rounded"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              title={t('common.language')}
            >
              <Globe className="w-3.5 h-3.5" />
            </button>
            {langOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setLangOpen(false)} />
                <div
                  className="absolute right-0 top-full mt-1 rounded-lg overflow-hidden z-50 shadow-lg"
                  style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', minWidth: 120 }}
                >
                  {(Object.entries(LOCALE_LABELS) as [Locale, string][]).map(([code, label]) => (
                    <button
                      key={code}
                      onClick={() => handleSetLocale(code)}
                      className="w-full px-3 py-2 text-left text-xs flex items-center gap-2"
                      style={{
                        background: i18n.language === code ? 'hsl(var(--accent))' : 'transparent',
                        color: i18n.language === code ? 'hsl(var(--primary))' : 'hsl(var(--foreground))'
                      }}
                    >
                      {i18n.language === code && <Check className="w-3 h-3" />}
                      {i18n.language !== code && <span className="w-3" />}
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setCoffeeOpen(true)}
            className="w-8 h-7 flex items-center justify-center rounded"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={t('coffee.title')}
          >
            <Coffee className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCheckUpdate}
            disabled={checking}
            className="w-8 h-7 flex items-center justify-center rounded"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={t('common.checkUpdate')}
          >
            <ArrowDownToLine className={cn("w-3.5 h-3.5", checking && "animate-bounce")} />
          </button>
          <button
            onClick={() => { setSettingsOpen(true); scanEnvs(); }}
            className="ml-1 h-7 px-2.5 rounded-md text-xs flex items-center gap-1.5 flex-shrink-0"
            style={{ color: "hsl(var(--muted-foreground))", background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
            title={t('settings.title')}
          >
            <Settings className="w-3.5 h-3.5" />
            {t('settings.title')}
          </button>
        </div>
        {/* 窗口控制按钮 */}
        <div className="flex items-center flex-shrink-0 h-full ml-3">
          <button
            onClick={() => getCurrentWindow().minimize()}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            className="w-11 h-full flex items-center justify-center"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={t('common.minimize')}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => getCurrentWindow().toggleMaximize()}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            className="w-11 h-full flex items-center justify-center"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={t('common.maximize')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => getCurrentWindow().close()}
            onMouseEnter={e => { e.currentTarget.style.background = '#c42b1c'; (e.currentTarget.style as CSSStyleDeclaration).color = 'white'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'hsl(var(--muted-foreground))'; }}
            className="w-11 h-full flex items-center justify-center"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={t('common.close')}
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>
      {/* ── 标题栏以下：侧边栏 + 内容区（内嵌圆角面板） ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden" style={{ padding: 8, gap: 6 }}>
        <div
          className="flex flex-shrink-0 min-h-0 overflow-hidden rounded-xl"
          style={{ border: "1px solid hsl(var(--border))" }}
        >
          <ActivityRail
            activePage={activePage as PageId}
            onNavigate={(page) => setActivePage(page)}
            collapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed(v => !v)}
          />
          {/* ── Config sidebar ── */}
          <aside
            className="flex-shrink-0 flex-col"
            style={{
              width: sidebarWidth,
              background: "hsl(var(--sidebar))",
              display: sidebarCollapsed ? "none" : "flex",
            }}
          >
            {/* Page title */}
            <div
              className="flex items-center gap-2 flex-shrink-0"
              style={{ padding: "12px 16px 10px 16px", borderBottom: "1px solid hsl(var(--border))" }}
            >
              <span style={{ color: "hsl(var(--muted-foreground))" }}>
                <ActiveIcon className="w-4 h-4" />
              </span>
              <span className="text-sm font-semibold">{activePageLabel}</span>
              <span title={pageDescription} style={{ color: "hsl(var(--muted-foreground))", cursor: "help" }}>
                <CircleHelp className="w-3.5 h-3.5" />
              </span>
            </div>
            {/* Page config portal renders here */}
            <div ref={sidebarRef} className="flex-1 min-h-0 overflow-y-auto" style={{ paddingLeft: 16, paddingRight: 16 }} />
          </aside>
        </div>
        {/* ── 拖拽调宽把手 ── */}
        <div
          className="w-1 flex-shrink-0 rounded-full cursor-col-resize transition-colors"
          style={{ background: "hsl(var(--border))", display: sidebarCollapsed ? "none" : undefined }}
          onMouseDown={handleResizeMouseDown}
          onMouseEnter={(e) => (e.currentTarget.style.background = "hsl(var(--primary))")}
          onMouseLeave={(e) => { if (!isResizing.current) e.currentTarget.style.background = "hsl(var(--border))"; }}
        />
        <SidebarPortalCtx.Provider value={sidebarEl}>
          <div
            className="flex-1 min-w-0 overflow-hidden rounded-xl"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
          >
            <div className="h-full overflow-auto" style={{ padding: "12px 18px 18px" }}>
              {pages[activePage as PageId]}
            </div>
          </div>
        </SidebarPortalCtx.Provider>
      </div>
      {/* ── 全宽 Status Bar ── */}
      <div
        className="flex-shrink-0 flex items-center gap-3 px-4 text-xs"
        style={{ height: 24, background: "hsl(var(--card))", borderTop: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
      >
        <div className="flex-1" />
        {/* 滚动提示：占状态栏 1/3 宽并居中 */}
        <div className="min-w-0" style={{ width: "33%" }}>
          <StatusTipMarquee />
        </div>
        <div className="flex-1 min-w-0 flex items-center justify-end gap-3">
          {backendStatus === "error" && backendMessage && (
            <span className="truncate" style={{ color: "hsl(var(--destructive))" }}>{backendMessage}</span>
          )}
          <span
            className="truncate flex-shrink-0"
            style={{ color: "hsl(var(--muted-foreground))" }}
            title={config?.conda?.envPath ?? config?.pythonExe ?? ""}
          >
            {config?.conda?.envName ?? config?.pythonExe ?? ""}
          </span>
        </div>
      </div>
      {/* ── 检查更新弹窗 ── */}
      <UpdateDialog
        open={updateOpen}
        info={updateInfo}
        error={updateError}
        checking={checking}
        currentVersion={appVersion}
        onClose={() => setUpdateOpen(false)}
        onRetry={handleCheckUpdate}
      />

      {/* ── 打赏弹窗（payment-server 动态下单 + 二维码 + 轮询确认）── */}
      <TipDialog open={coffeeOpen} onClose={() => setCoffeeOpen(false)} />

      {/* ── 系统管理弹窗 ── */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}
        >
          <div
            className="w-96 rounded-xl flex flex-col overflow-hidden"
            style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', maxHeight: '80vh' }}
          >
            {/* 弹窗标题 */}
            <div className="flex items-center justify-between px-5 py-3.5 flex-shrink-0" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
              <span className="text-sm font-semibold">{t('settings.title')}</span>
              <button onClick={() => setSettingsOpen(false)} className="w-7 h-7 flex items-center justify-center rounded-md" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            {/* Tabs */}
            <div className="flex flex-shrink-0" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
              {(['env', 'deps', 'about'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setSettingsTab(tab)}
                  className="flex-1 py-2.5 text-sm"
                  style={{
                    color: settingsTab === tab ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                    borderBottom: settingsTab === tab ? '2px solid hsl(var(--primary))' : '2px solid transparent',
                    background: 'transparent',
                  }}
                >
                  {tab === 'env'
                    ? t('settings.tabEnv')
                    : tab === 'deps'
                      ? t('settings.tabDeps')
                      : t('settings.tabAbout')}
                </button>
              ))}
            </div>
            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto p-4">
              {settingsTab === 'env' && (
                <div className="flex flex-col gap-4">
                  {/* 当前环境 */}
                  <div className="p-3 rounded-lg" style={{ background: 'hsl(var(--accent))', border: '1px solid hsl(var(--border))' }}>
                    <div className="text-xs mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('settings.currentEnv')}</div>
                    <div className="text-sm font-bold">{config?.conda?.envName ?? config?.pythonExe}</div>
                    <div className="text-xs mt-0.5 break-all" style={{ color: 'hsl(var(--muted-foreground))' }}>{config?.conda?.envPath ?? config?.pythonExe}</div>
                  </div>
                  {/* 可用环境列表 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('settings.availableEnvs')}</span>
                      <button onClick={scanEnvs} disabled={envScanning} className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: 'hsl(var(--primary))' }}>
                        <RefreshCw className={cn("w-3 h-3", envScanning ? "animate-spin" : "")} />
                        {t('common.refresh')}
                      </button>
                    </div>
                    {envScanning ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        {t('settings.scanning')}
                      </div>
                    ) : envList.length === 0 ? (
                      <div className="text-sm text-center py-6" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('settings.noEnvs')}</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {envList.map(env => (
                          <div
                            key={env.path}
                            className="p-2.5 rounded-lg"
                            style={{
                              background: env.is_valid
                                ? 'rgba(34,197,94,0.08)'
                                : 'rgba(239,68,68,0.07)',
                              border: `1px solid ${env.is_valid ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <div
                                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                style={{ background: env.is_valid ? 'hsl(var(--success))' : 'hsl(var(--destructive))' }}
                              />
                              <span className="text-sm font-medium">{env.name}</span>
                              {env.python_version && (
                                <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                  Python {env.python_version}
                                </span>
                              )}
                            </div>
                            <div className="text-xs mt-1 break-all" style={{ color: 'hsl(var(--muted-foreground))' }}>{env.path}</div>
                            {!env.is_valid && env.missing_packages.length > 0 && (
                              <div className="mt-1.5">
                                <span className="text-xs" style={{ color: 'hsl(var(--destructive))' }}>{t('settings.missingDeps')}</span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {env.missing_packages.map(pkg => (
                                    <span
                                      key={pkg}
                                      className="text-xs px-1.5 py-0.5 rounded"
                                      style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(var(--destructive))', border: '1px solid rgba(239,68,68,0.25)' }}
                                    >
                                      {pkg}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 重新配置 */}
                  <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: 12 }}>
                    <button
                      onClick={() => { setSettingsOpen(false); handleReconfigure(); }}
                      className="w-full h-8 rounded-md text-sm flex items-center justify-center gap-2"
                      style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
                    >
                      <Settings className="w-3.5 h-3.5" />
                      {t('settings.reconfigure')}
                    </button>
                  </div>
                </div>
              )}
              {settingsTab === 'deps' && (
                <div className="flex flex-col gap-3">
                  {/* 概览 + AI 开关 */}
                  <div className="p-3 rounded-lg" style={{ background: 'hsl(var(--accent))', border: '1px solid hsl(var(--border))' }}>
                    <div className="flex items-center gap-2">
                      <Package className="w-3.5 h-3.5" style={{ color: 'hsl(var(--primary))' }} />
                      <span className="text-sm font-semibold">{t('settings.depsTitle')}</span>
                      {deps?.platform && (
                        <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          {deps.platform}
                        </span>
                      )}
                    </div>
                    <div className="text-xs mt-1 break-all" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {t('settings.depsPython', {
                        required: deps?.python_spec ?? '3.10',
                        current: deps?.python_version ?? '-',
                      })}
                    </div>
                    <label className="flex items-center gap-2 mt-2 text-xs cursor-pointer" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <input
                        type="checkbox"
                        checked={depsIncludeAI}
                        onChange={(e) => setDepsIncludeAI(e.target.checked)}
                        className="accent-blue-500"
                      />
                      {t('settings.depsIncludeAI')}
                    </label>
                  </div>

                  {depsLoading && (
                    <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      {t('common.loading')}
                    </div>
                  )}

                  {!depsLoading && depsError && (
                    <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-md" style={{ background: 'hsl(var(--destructive) / 0.12)', color: 'hsl(var(--destructive))' }}>
                      <span className="flex-1 break-all">{depsError}</span>
                      <button
                        onClick={() => void loadDeps(depsIncludeAI)}
                        className="flex-shrink-0 px-2 py-0.5 rounded"
                        style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}
                      >
                        {t('common.retry')}
                      </button>
                    </div>
                  )}

                  {!depsLoading && deps?.groups?.map((group) => (
                    <div key={group.id}>
                      <div className="text-[10px] uppercase tracking-[0.12em] mb-1.5 flex items-center gap-2"
                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {group.title}
                        {group.enabled === false && (
                          <span className="normal-case tracking-normal" style={{ color: 'hsl(var(--warning))' }}>
                            {t('settings.depsDisabled')}
                          </span>
                        )}
                      </div>
                      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid hsl(var(--border))' }}>
                        {group.items.map((item, idx) => {
                          const installed = Boolean(item.installed);
                          return (
                            <div
                              key={item.name}
                              className="px-2.5 py-1.5"
                              style={{ borderTop: idx > 0 ? '1px solid hsl(var(--border))' : undefined }}
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono truncate">{item.name}</span>
                                {item.spec && (
                                  <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {item.spec}
                                  </span>
                                )}
                                <span
                                  className="text-[10px] ml-auto flex-shrink-0"
                                  style={{ color: installed ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
                                  title={item.installed || undefined}
                                >
                                  {installed ? `✓ ${item.installed}` : t('settings.depsNotInstalled')}
                                </span>
                              </div>
                              {item.note && (
                                <div className="text-[10px] mt-0.5 leading-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                  {item.note}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {!depsLoading && deps && (
                    <>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => void handleExportEnvYaml()}
                          className="flex-1 h-9 rounded-md text-sm flex items-center justify-center gap-2"
                          style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                        >
                          <Download className="w-3.5 h-3.5" />
                          {t('settings.depsExport')}
                        </button>
                        <button
                          onClick={() => void openExternal(EASY_CONDA_URL)}
                          className="h-9 px-3 rounded-md text-xs flex items-center gap-1.5 flex-shrink-0"
                          style={{ background: 'hsl(var(--muted))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
                          title={t('settings.depsEasyCondaHint')}
                        >
                          Easy Conda
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>
                      {depsExported && (
                        <div className="text-[10px] break-all" style={{ color: 'hsl(var(--success))' }}>
                          {t('settings.depsExported')}: {depsExported}
                        </div>
                      )}
                      <div className="text-[10px] leading-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {t('settings.depsEasyCondaHint')}
                      </div>
                    </>
                  )}
                </div>
              )}
              {settingsTab === 'about' && (
                <div className="flex flex-col gap-5 py-1">
                  {/* 应用信息 */}
                  <div className="flex items-center gap-3">
                    <img src="/app-icon.svg" alt="Easy Dataset" className="w-11 h-11 rounded-xl flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-base font-semibold">Easy Dataset</div>
                      <div className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {t('settings.version', { version: `v${appVersion}` })} · {t('settings.aboutTagline')}
                      </div>
                    </div>
                  </div>

                  <div className="h-px flex-shrink-0" style={{ background: 'hsl(var(--border))' }} />

                  {/* 产品主页 */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('about.productHome')}</p>
                    <button
                      onClick={() => openExternal(PRODUCT_HOME_URL)}
                      title="eds.tsagent.cc"
                      className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                      style={{ color: 'hsl(var(--foreground))' }}
                    >
                      <Globe className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 text-left">{t('about.productTitle')}</span>
                      <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
                    </button>
                  </div>

                  {/* 出品方 */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('about.studio')}</p>
                    <button
                      onClick={() => openExternal(STUDIO_URL)}
                      title="tsagent.cc"
                      className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                      style={{ color: 'hsl(var(--foreground))' }}
                    >
                      <span
                        className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                        style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                      >
                        火
                      </span>
                      <span className="flex-1 text-left">{t('about.studioName')}</span>
                      <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
                    </button>
                  </div>

                  {/* 代码仓库 */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('about.repo')}</p>
                    <button
                      onClick={() => openExternal(REPO_URL)}
                      title="github.com/MWang-TS/easy-dataset"
                      className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                      style={{ color: 'hsl(var(--foreground))' }}
                    >
                      <Github className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 text-left">{t('about.repoName')}</span>
                      <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
                    </button>
                  </div>

                  {/* 联系作者 */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('about.contact')}</p>
                    <button
                      onClick={() => openExternal(`mailto:${CONTACT_EMAIL}`)}
                      className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                      style={{ color: 'hsl(var(--foreground))' }}
                    >
                      <Mail className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 text-left">{CONTACT_EMAIL}</span>
                    </button>
                  </div>

                  {/* 检查更新 */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('about.update')}</p>
                    <button
                      onClick={() => { setSettingsOpen(false); handleCheckUpdate(); }}
                      disabled={checking}
                      className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity disabled:opacity-50"
                      style={{ color: 'hsl(var(--foreground))' }}
                    >
                      <ArrowDownToLine className={cn('w-4 h-4 flex-shrink-0', checking && 'animate-bounce')} />
                      <span className="flex-1 text-left">{t('settings.checkUpdate')}</span>
                    </button>
                  </div>

                  {/* 版权 */}
                  <div className="pt-1 flex flex-col gap-1">
                    <div className="h-px flex-shrink-0 mb-2" style={{ background: 'hsl(var(--border))' }} />
                    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <Copyright className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>{t('about.copyright', { year: new Date().getFullYear() })}</span>
                    </p>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {t('about.license')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
