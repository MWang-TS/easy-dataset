import { useState, useEffect, useCallback, useRef } from "react";
import {
  BarChart2, Eye, RefreshCw, Layers, FolderCog, Scissors,
  Settings, Play, Square, Cpu, CircleHelp,
  GitMerge, Film, Minus, Maximize2, X as XIcon,
  Coffee, Sun, Moon, Globe, Check,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { DEFAULT_BACKEND_PORT, useAppStore } from "@/lib/store";
import { useTranslation } from "react-i18next";
import { setLocale, LOCALE_LABELS, type Locale } from "@/i18n/index";
import { startBackend, stopBackend, checkBackendAlive, listCondaEnvs, type CondaEnv } from "@/lib/tauri-bridge";
import { SidebarPortalCtx } from "@/lib/sidebar-context";

// ── 页面组件（懒加载占位，正式实现在各自文件中）──
import DatasetQuality from "./DatasetQuality";
import DatasetViewer from "./DatasetViewer";
import Converter from "./Converter";
import LabelEditor from "./LabelEditor";
import FileManager from "./FileManager";
import DatasetSplit from "./DatasetSplit";
import DatasetMerge from "./DatasetMerge";
import VideoFrameExtractor from "./VideoFrameExtractor";

type PageId = "quality" | "viewer" | "convert" | "labels" | "files" | "split" | "merge" | "video";

const NAV_ICONS: Record<PageId, React.FC<{ className?: string }>> = {
  quality: BarChart2, viewer: Eye, convert: RefreshCw, labels: Layers,
  files: FolderCog, split: Scissors, merge: GitMerge, video: Film,
};

const PAGE_IDS: PageId[] = ["quality", "viewer", "convert", "labels", "files", "split", "merge", "video"];

function ActivityRail({
  activePage,
  onNavigate,
}: {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className="w-12 flex-shrink-0 flex flex-col items-center py-2"
      style={{
        background: "hsl(var(--sidebar))",
        borderRight: "1px solid hsl(var(--border))",
      }}
    >
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
  const { config, activePage, backendStatus, backendMessage, setActivePage, setBackendStatus, reset } = useAppStore();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarEl, setSidebarEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setSidebarEl(sidebarRef.current); }, []);

  // ── Buy Me a Coffee 弹窗 ──
  const [coffeeOpen, setCoffeeOpen] = useState(false);

  // ── 语言切换下拉 ──
  const [langOpen, setLangOpen] = useState(false);
  const handleSetLocale = (locale: Locale) => { setLocale(locale); setLangOpen(false); };

  // ── 系统设置弹窗 ──
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'env' | 'about'>('env');
  const [appVersion, setAppVersion] = useState("0.0.1");
  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
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
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

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
      // 如果 BackendState 里存有已退出的旧子进程，先清理再启动
      try { await startBackend(config.pythonExe, config.appDir, config.port); }
      catch (e) {
        if (String(e).includes("后端已在运行")) {
          // 旧子进程可能已死，停掉后重试
          try { await stopBackend(); } catch (_) {}
          await startBackend(config.pythonExe, config.appDir, config.port);
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
    <div className="h-screen overflow-hidden flex flex-col" style={{ background: "hsl(var(--editor))" }}>
      {/* ── 全宽标题栏 ── */}
      <header
        className="h-11 flex items-center gap-2.5 flex-shrink-0"
        data-tauri-drag-region
        style={{ background: "hsl(var(--card))", borderBottom: "1px solid hsl(var(--border))", paddingLeft: 32, paddingRight: 0 }}
      >
        <div
          className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
          style={{ background: "hsl(var(--primary))" }}
        >
          <Cpu className="w-3 h-3" style={{ color: "white" }} />
        </div>
        <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>Easy Dataset</span>
        <div className="flex-1" />
        <div className="flex items-center ml-2 gap-0.5">
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
            title="Buy me a coffee ☕"
          >
            <Coffee className="w-3.5 h-3.5" />
          </button>
          <button
            className="w-8 h-7 flex items-center justify-center rounded"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={t('common.checkUpdate')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
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
      {/* ── 标题栏以下：侧边栏 + 内容区 ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-shrink-0 min-h-0 overflow-hidden">
          <ActivityRail activePage={activePage as PageId} onNavigate={(page) => setActivePage(page)} />
          {/* ── Config sidebar ── */}
          <aside
            className="flex-shrink-0 flex flex-col"
            style={{ width: sidebarWidth, background: "hsl(var(--sidebar))" }}
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
            {/* Backend status at bottom */}
            <div className="flex-shrink-0 p-4 rounded-md" style={{ margin: "16px 16px 16px 24px", border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>{t('backend.service')}</div>
                  <div className="mt-1 text-sm font-medium">
                    {backendStatus === "running" ? t('backend.connected') : backendStatus === "starting" ? t('backend.connecting') : t('backend.disconnected')}
                  </div>
                </div>
                <div
                  className={cn("w-2.5 h-2.5 rounded-full", backendStatus === "running" ? "animate-pulse" : "")}
                  style={{
                    background: backendStatus === "running" ? "hsl(var(--success))"
                      : backendStatus === "error" ? "hsl(var(--destructive))"
                      : backendStatus === "starting" ? "hsl(var(--warning))"
                      : "hsl(var(--muted-foreground))",
                  }}
                />
              </div>
              <div className="mt-2 text-xs leading-5" style={{ color: "hsl(var(--muted-foreground))" }}>
                {backendStatus === "error" ? backendMessage || t('backend.errorHint') : t('backend.hint')}
              </div>
              {backendStatus === "running" ? (
                <button
                  onClick={handleStopBackend}
                  className="mt-2 w-full flex items-center justify-center gap-2 h-8 rounded-md text-sm"
                  style={{ background: "rgba(197, 15, 31, 0.12)", color: "hsl(var(--destructive))", border: "1px solid rgba(197, 15, 31, 0.24)" }}
                >
                  <Square className="w-3.5 h-3.5" />
                  {t('backend.stop')}
                </button>
              ) : (
                <button
                  onClick={handleStartBackend}
                  className="mt-2 w-full flex items-center justify-center gap-2 h-8 rounded-md text-sm"
                  style={{ background: "hsl(var(--primary))", color: "white" }}
                >
                  <Play className="w-3.5 h-3.5" />
                  {t('backend.start')}
                </button>
              )}
            </div>
          </aside>
        </div>
        {/* ── 拖拽调宽把手 ── */}
        <div
          className="w-1 flex-shrink-0 cursor-col-resize transition-colors"
          style={{ background: "hsl(var(--border))" }}
          onMouseDown={handleResizeMouseDown}
          onMouseEnter={(e) => (e.currentTarget.style.background = "hsl(var(--primary))")}
          onMouseLeave={(e) => { if (!isResizing.current) e.currentTarget.style.background = "hsl(var(--border))"; }}
        />
        <SidebarPortalCtx.Provider value={sidebarEl}>
          <div className="flex-1 min-w-0 overflow-hidden" style={{ background: "hsl(var(--editor))" }}>
            <div className="h-full overflow-auto" style={{ padding: "10px 16px" }}>
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
        <div className="flex items-center gap-1.5">
          <div
            className={cn("w-1.5 h-1.5 rounded-full", backendStatus === "running" ? "animate-pulse" : "")}
            style={{ background: statusColor }}
          />
          <span>{statusText}</span>
        </div>
        <span style={{ color: "hsl(var(--border))" }}>·</span>
        <span>{config?.mode === "conda" ? "Conda" : "Manual"}</span>
        <span style={{ color: "hsl(var(--border))" }}>·</span>
        <span>:{config?.port ?? DEFAULT_BACKEND_PORT}</span>
        {backendStatus === "error" && backendMessage && (
          <>
            <span style={{ color: "hsl(var(--border))" }}>·</span>
            <span style={{ color: "hsl(var(--destructive))" }}>{backendMessage}</span>
          </>
        )}
        <div className="flex-1" />
        <span style={{ color: "hsl(var(--border))" }}>v{appVersion}</span>
      </div>
      {/* ── Buy Me a Coffee 弹窗 ── */}
      {coffeeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.65)' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setCoffeeOpen(false); }}
        >
          <div
            className="rounded-2xl flex flex-col overflow-hidden"
            style={{
              width: 680,
              background: 'linear-gradient(160deg, #0f1b2d 0%, #0a1220 100%)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
            }}
          >
            {/* 头部：关闭按钮 + 标题 */}
            <div className="relative flex flex-col items-center pt-8 pb-6 px-8">
              <button
                onClick={() => setCoffeeOpen(false)}
                className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full"
                style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }}
              >
                <XIcon className="w-4 h-4" />
              </button>
              <span style={{ fontSize: 44, lineHeight: 1 }}>☕</span>
              <h2 className="mt-3 text-xl font-bold" style={{ color: '#fff' }}>Buy Me a Coffee</h2>
              <p className="mt-1.5 text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {t('coffee.subtitle')}
              </p>
            </div>

            {/* 分隔线 */}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '0 0 20px' }} />

            {/* 三列二维码 */}
            <div className="grid grid-cols-3 gap-5 px-8 pb-6">
              {([
                { value: 'https://qr.alipay.com/fkx13794uv9tdzovji5js38',                                              badge: '支', label: '支付宝',   color: '#1677ff', bg: 'rgba(22,119,255,0.10)' },
                { value: 'wxp://f2f1zWKP3fltcLCdS-146WJHNFD5pqCDWKWSsFTNIwiDh_iPStg8Lsb3WNJ7Fd--wWla',              badge: '微', label: '微信支付', color: '#07c160', bg: 'rgba(7,193,96,0.10)'  },
                { value: 'https://www.paypal.com/ncp/payment/EH53EYWSBNF6Y',                                          badge: 'P',  label: 'PayPal',   color: '#009cde', bg: 'rgba(0,156,222,0.10)' },
              ] as const).map(({ value, badge, label, color, bg }) => (
                <div key={label} className="flex flex-col items-center gap-3">
                  {/* 品牌标识行 */}
                  <div className="flex items-center gap-2 self-start">
                    <span
                      className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold flex-shrink-0"
                      style={{ background: color, color: '#fff' }}
                    >
                      {badge}
                    </span>
                    <span className="text-sm font-semibold" style={{ color: '#fff' }}>{label}</span>
                  </div>
                  {/* 品牌色二维码 */}
                  <div
                    className="w-full rounded-2xl flex items-center justify-center"
                    style={{ background: bg, border: `1.5px solid ${color}44`, padding: 14 }}
                  >
                    <QRCodeSVG
                      value={value}
                      size={160}
                      fgColor={color}
                      bgColor="transparent"
                      level="M"
                      style={{ width: '100%', height: 'auto' }}
                    />
                  </div>
                  {/* 扫码提示 */}
                  <span className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>{t('coffee.scanToPay')}</span>
                </div>
              ))}
            </div>

            {/* 底部 */}
            <div
              className="py-3.5 text-center text-xs"
              style={{ color: 'rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.04)', borderTop: '1px solid rgba(255,255,255,0.07)' }}
            >
              {t('coffee.footer')}
            </div>
          </div>
        </div>
      )}

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
              {(['env', 'about'] as const).map(tab => (
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
                  {tab === 'env' ? t('settings.tabEnv') : t('settings.tabAbout')}
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
              {settingsTab === 'about' && (
                <div className="flex flex-col items-center gap-5 py-4">
                  <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'hsl(var(--primary))' }}>
                    <Cpu className="w-7 h-7" style={{ color: 'white' }} />
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold">Easy Dataset</div>
                    <div className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('settings.aboutDesc')}</div>
                  </div>
                  <div className="text-xs px-4 py-2 rounded-full font-medium" style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}>
                    {t('settings.version', { version: `v${appVersion}` })}
                  </div>
                  <div className="text-xs text-center leading-6" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {t('settings.aboutFeatures')}
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
