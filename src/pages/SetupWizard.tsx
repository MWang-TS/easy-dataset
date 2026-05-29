import { useState, useEffect } from "react";
import {
  Search, CheckCircle, XCircle, AlertCircle, ChevronRight, Loader2, FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { listCondaEnvs, getAppDir, browseFile, type CondaEnv } from "@/lib/tauri-bridge";
import { DEFAULT_BACKEND_PORT, useAppStore, type AppConfig } from "@/lib/store";
import { useTranslation } from "react-i18next";

type Step = "mode" | "conda-select" | "manual-select" | "confirm";
type ConfirmMode = "conda" | "manual";

const ALL_STEPS: Step[] = ["mode", "conda-select", "confirm"];

export default function SetupWizard() {
  const { t } = useTranslation();
  const setConfig = useAppStore((s) => s.setConfig);
  const [step, setStep] = useState<Step>("mode");
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>("conda");
  const [scanning, setScanning] = useState(false);
  const [envs, setEnvs] = useState<CondaEnv[]>([]);
  const [selected, setSelected] = useState<CondaEnv | null>(null);
  const [manualExe, setManualExe] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [appDir, setAppDir] = useState("");
  const [appDirError, setAppDirError] = useState<string | null>(null);

  useEffect(() => {
    getAppDir()
      .then((dir) => { setAppDir(dir); setAppDirError(null); })
      .catch((e) => { setAppDirError(String(e)); console.error(e); });
  }, []);

  const handleScan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await listCondaEnvs();
      setEnvs(result);
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const handleBrowseManual = async () => {
    const file = await browseFile([{ name: "Python 可执行文件", extensions: ["exe", "*"] }]);
    if (file) setManualExe(file);
  };

  const handleConfirm = () => {
    if (appDirError || !appDir) {
      alert(`后端目录初始化失败，无法启动：\n${appDirError ?? "appDir 为空"}`);
      return;
    }
    let config: AppConfig;
    if (confirmMode === "conda" && selected) {
      const pythonExe = selected.path.includes("\\")
        ? `${selected.path}\\python.exe`
        : `${selected.path}/bin/python`;
      config = {
        mode: "conda",
        pythonExe,
        conda: { envPath: selected.path, envName: selected.name },
        port: DEFAULT_BACKEND_PORT,
        appDir,
      };
    } else {
      if (!manualExe.trim()) return;
      config = { mode: "manual", pythonExe: manualExe.trim(), port: DEFAULT_BACKEND_PORT, appDir };
    }
    setConfig(config);
  };

  const stepIdx = step === "mode" ? 0 : step === "confirm" ? 2 : 1;
  const hasMissingPkgs = selected !== null && selected.missing_packages.length > 0;

  return (
    <div
      className="h-screen flex flex-col items-center justify-center px-6 py-10"
      style={{ background: "hsl(var(--background))" }}
    >
      <div className="w-full max-w-3xl">
        <div className="flex flex-col items-center mb-12">
          <img src="/app-icon.svg" alt="Easy Dataset" className="w-20 h-20 mb-6" />
          <h1 className="text-[34px] font-bold leading-none mb-3" style={{ color: "hsl(var(--foreground))" }}>
            Easy Dataset
          </h1>
          <p className="text-sm leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>{t('setup.firstLaunch')}</p>
        </div>

        <div className="flex items-center justify-center gap-3 mb-10">
          {ALL_STEPS.map((s, idx) => (
            <div key={s} className="flex items-center gap-3">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all",
                  stepIdx === idx ? "text-white" : idx < stepIdx ? "opacity-60" : "opacity-30"
                )}
                style={{
                  background:
                    stepIdx === idx
                      ? "hsl(var(--primary))"
                      : idx < stepIdx
                      ? "hsl(var(--success))"
                      : "hsl(var(--border))",
                }}
              >
                {idx + 1}
              </div>
              {idx < ALL_STEPS.length - 1 && (
                <div className="w-16 h-px" style={{ background: "hsl(var(--border))" }} />
              )}
            </div>
          ))}
        </div>

        <div
          className="rounded-xl p-8 lg:p-10"
          style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
        >
          {step === "mode" && (
            <div className="space-y-7">
              <div>
                <h2 className="text-xl font-semibold mb-3" style={{ color: "hsl(var(--foreground))" }}>
                  {t('setup.selectMode')}
                </h2>
                <p className="text-sm leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {t('setup.selectModeDesc')}
                </p>
              </div>

              <div className="space-y-5">
                <button
                  className="w-full px-5 py-4 rounded-xl text-left transition-all hover:opacity-90"
                  style={{ background: "hsl(var(--accent))", border: "2px solid hsl(var(--primary))" }}
                  onClick={() => { setConfirmMode("conda"); setStep("conda-select"); handleScan(); }}
                  disabled={scanning}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: "hsl(var(--primary) / 0.2)" }}>
                      <Search className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-base leading-6" style={{ color: "hsl(var(--foreground))" }}>{t('setup.useConda')}</div>
                      <div className="text-sm mt-1 leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>{t('setup.useCondaDesc')}</div>
                    </div>
                    <ChevronRight className="ml-auto w-5 h-5 flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }} />
                  </div>
                </button>
                <button
                  className="w-full px-5 py-4 rounded-xl text-left transition-all hover:opacity-90"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  onClick={() => { setConfirmMode("manual"); setStep("manual-select"); }}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: "hsl(var(--muted-foreground) / 0.15)" }}>
                      <FolderOpen className="w-5 h-5" style={{ color: "hsl(var(--muted-foreground))" }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-base leading-6" style={{ color: "hsl(var(--foreground))" }}>{t('setup.useManual')}</div>
                      <div className="text-sm mt-1 leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>{t('setup.useManualDesc')}</div>
                    </div>
                    <ChevronRight className="ml-auto w-5 h-5 flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }} />
                  </div>
                </button>
              </div>
            </div>
          )}

          {step === "conda-select" && (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold mb-2" style={{ color: "hsl(var(--foreground))" }}>{t('setup.selectConda')}</h2>
                  <p className="text-sm leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>
                    {t('setup.selectCondaDesc')}
                  </p>
                </div>
                <button
                  onClick={handleScan}
                  className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-md transition-opacity hover:opacity-80"
                  style={{ color: "hsl(var(--primary))", background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  disabled={scanning}
                >
                  {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  {t('setup.rescan')}
                </button>
              </div>
              {scanning && (
                <div className="flex items-center gap-2 py-10 justify-center" style={{ color: "hsl(var(--muted-foreground))" }}>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>{t('setup.scanning')}</span>
                </div>
              )}
              {scanError && (
                <div className="flex items-start gap-3 p-4 rounded-lg"
                  style={{ background: "hsl(var(--destructive) / 0.15)", border: "1px solid hsl(var(--destructive) / 0.4)" }}>
                  <AlertCircle className="w-4 h-4 mt-1 flex-shrink-0" style={{ color: "hsl(var(--destructive))" }} />
                  <div className="text-sm leading-6" style={{ color: "hsl(var(--destructive))" }}>{scanError}</div>
                </div>
              )}
              {!scanning && !scanError && envs.length === 0 && (
                <div className="text-center py-10" style={{ color: "hsl(var(--muted-foreground))" }}>
                  <AlertCircle className="w-8 h-8 mx-auto mb-3 opacity-50" />
                  <div className="text-sm">{t('setup.noEnvFound')}</div>
                  <div className="text-xs mt-2 leading-6">{t('setup.noEnvFoundDesc')}</div>
                </div>
              )}
              {!scanning && envs.length > 0 && (
                <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                  {envs.map((env) => (
                    <button
                      key={env.path}
                      onClick={() => setSelected(env)}
                      className={cn("w-full px-4 py-3.5 rounded-lg text-left transition-all", selected?.path === env.path ? "" : "hover:opacity-80")}
                      style={{
                        background: selected?.path === env.path ? "hsl(var(--accent))" : "hsl(var(--muted))",
                        border: "1px solid hsl(var(--border))",
                        outline: selected?.path === env.path ? "2px solid hsl(var(--primary))" : "none",
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium leading-6" style={{ color: "hsl(var(--foreground))" }}>{env.name}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded"
                              style={{ background: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                              Python {env.python_version}
                            </span>
                          </div>
                          <div className="mt-1.5 text-xs leading-6">
                            {env.is_valid
                              ? <span style={{ color: "hsl(var(--success))" }}>{t('setup.allDepsReady')}</span>
                              : <span style={{ color: "hsl(var(--destructive))" }}>{t('setup.missingDeps', { packages: env.missing_packages.join(", ") })}</span>}
                          </div>
                        </div>
                        {env.is_valid
                          ? <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "hsl(var(--success))" }} />
                          : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "hsl(var(--destructive))" }} />}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button className="flex-1 h-11 rounded-lg text-sm transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  onClick={() => setStep("mode")}>{t('common.back')}</button>
                <button
                  className="flex-1 h-11 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ background: selected ? "hsl(var(--primary))" : "hsl(var(--muted))", color: selected ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))" }}
                  disabled={!selected}
                  onClick={() => setStep("confirm")}>{t('common.next')}</button>
              </div>
            </div>
          )}

          {step === "manual-select" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold mb-2" style={{ color: "hsl(var(--foreground))" }}>
                  {t('setup.specifyPython')}
                </h2>
                <p className="text-sm leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {t('setup.specifyPythonDesc')}
                </p>
              </div>
              <div className="flex gap-3">
                <input
                  className="flex-1 px-3 py-3 rounded-lg text-sm font-mono"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  value={manualExe}
                  onChange={(e) => setManualExe(e.target.value)}
                  placeholder="C:\path\to\python.exe"
                />
                <button className="px-3 py-3 rounded-lg transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  onClick={handleBrowseManual}>
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
              <div className="flex gap-3 pt-1">
                <button className="flex-1 h-11 rounded-lg text-sm transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  onClick={() => setStep("mode")}>{t('common.back')}</button>
                <button
                  className="flex-1 h-11 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                  disabled={!manualExe.trim()}
                  onClick={() => setStep("confirm")}>{t('common.next')}</button>
              </div>
            </div>
          )}

          {step === "confirm" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold mb-2" style={{ color: "hsl(var(--foreground))" }}>{t('setup.confirmConfig')}</h2>
                <p className="text-sm leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>{t('setup.confirmDesc')}</p>
              </div>
              <div className="space-y-0 rounded-xl overflow-hidden"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}>
                {(confirmMode === "conda" && selected
                  ? [
                      { label: t('setup.mode'), value: t('setup.modeConda') },
                      { label: t('setup.envName'), value: selected.name },
                      { label: t('setup.pythonVersion'), value: selected.python_version },
                      { label: t('setup.envPath'), value: selected.path },
                    ]
                  : [
                      { label: t('setup.mode'), value: t('setup.modeManual') },
                      { label: t('setup.pythonPath'), value: manualExe },
                    ]
                ).concat([
                  { label: t('setup.backendPort'), value: String(DEFAULT_BACKEND_PORT) },
                  { label: t('setup.appDir'), value: appDir },
                ]).map(({ label, value }, idx) => (
                  <div key={label} className="flex justify-between gap-6 px-5 py-3.5 text-sm"
                    style={{ borderTop: idx > 0 ? "1px solid hsl(var(--border))" : undefined }}>
                    <span style={{ color: "hsl(var(--muted-foreground))" }}>{label}</span>
                    <span className="font-mono text-xs leading-6 max-w-md truncate text-right" style={{ color: "hsl(var(--foreground))" }}>{value}</span>
                  </div>
                ))}
              </div>
              {hasMissingPkgs && (
                <div className="flex items-start gap-3 p-4 rounded-lg"
                  style={{ background: "hsl(var(--destructive) / 0.10)", border: "1px solid hsl(var(--destructive) / 0.4)" }}>
                  <AlertCircle className="w-4 h-4 mt-1 flex-shrink-0" style={{ color: "hsl(var(--destructive))" }} />
                  <div>
                    <div className="text-sm font-medium leading-6" style={{ color: "hsl(var(--destructive))" }}>{t('setup.missingDepsWarning')}</div>
                    <code className="text-xs mt-2 block leading-6" style={{ color: "hsl(var(--muted-foreground))" }}>
                      pip install {selected?.missing_packages.join(" ")}
                    </code>
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-1">
                <button className="flex-1 h-11 rounded-lg text-sm transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  onClick={() => setStep(confirmMode === "conda" ? "conda-select" : "manual-select")}>{t('common.back')}</button>
                <button
                  className="flex-1 h-11 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                  disabled={hasMissingPkgs}
                  onClick={handleConfirm}>{t('setup.startUsing')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
