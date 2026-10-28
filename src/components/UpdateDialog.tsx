import { ArrowDownToLine, CheckCircle2, Loader2, X as XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UpdateInfo } from "@/lib/update";
import { PRODUCT_HOME_URL } from "@/lib/links";
import { openExternal } from "@/lib/open-external";

/**
 * 检查更新弹窗。
 *
 * 三种状态互斥：错误 / 有新版本 / 已是最新。
 *
 * 「有新版本」时主按钮优先直下**本平台安装包**（来自发布清单 latest.json，
 * 含各平台直链与 sha256），清单里没有对应平台才回退到官网下载页。
 * 次级入口指向 GitHub Releases，用于查看完整更新说明与历史版本。
 */
export default function UpdateDialog({
  open,
  info,
  error,
  checking = false,
  currentVersion,
  onClose,
  onRetry,
}: {
  open: boolean;
  info: UpdateInfo | null;
  error: string | null;
  checking?: boolean;
  currentVersion: string;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const releasedDate = info?.released_at
    ? new Date(info.released_at).toLocaleDateString()
    : "";

  // 更新说明是 Markdown 原文：这里只去掉 `#` 标题标记（标题与弹窗标题重复），
  // 其余按纯文本渲染，不引入 Markdown 渲染器和它的 XSS 面。
  const releaseNotes = (info?.release_notes ?? "")
    .replace(/^#{1,6}\s*/gm, "")
    .trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        className="relative w-[480px] max-w-[90vw] rounded-xl shadow-2xl p-6"
        style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 rounded-md hover:opacity-70 transition-opacity"
          style={{ color: "hsl(var(--muted-foreground))" }}
          title={t("common.close")}
        >
          <XIcon className="w-4 h-4" />
        </button>

        {checking ? (
          // 重试期间的中间态：否则 info=null 会被当成「已是最新」而误导用户
          <div
            className="flex flex-col items-center gap-3 py-8"
            style={{ color: "hsl(var(--muted-foreground))" }}
          >
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">{t("update.checking")}</span>
          </div>
        ) : error ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="font-semibold text-sm" style={{ color: "hsl(var(--foreground))" }}>
                {t("update.checkFailed")}
              </span>
            </div>
            <p
              className="text-xs rounded-md p-3"
              style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}
            >
              {error}
            </p>
            <div className="flex justify-end gap-2 mt-4">
              {onRetry && (
                <button
                  onClick={onRetry}
                  disabled={checking}
                  className="px-4 py-1.5 rounded-md text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                >
                  {t("update.retry")}
                </button>
              )}
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-md text-sm transition-opacity hover:opacity-80"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
              >
                {t("common.close")}
              </button>
            </div>
          </>
        ) : info?.has_update ? (
          <>
            <div className="flex items-center gap-2 mb-1">
              <ArrowDownToLine className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
              <span className="font-semibold text-base" style={{ color: "hsl(var(--foreground))" }}>
                {t("update.newVersion", { version: `v${info.latest_version}` })}
              </span>
            </div>
            <p className="text-xs mb-3" style={{ color: "hsl(var(--muted-foreground))" }}>
              {t("update.currentVersion", { version: `v${info.current_version}` })}
              {releasedDate && ` · ${t("update.releasedAt", { date: releasedDate })}`}
            </p>
            {releaseNotes && (
              <div
                className="rounded-md p-3 mb-4 text-xs max-h-40 overflow-y-auto whitespace-pre-wrap"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}
              >
                {releaseNotes}
              </div>
            )}
            {info.download_name && (
              <p
                className="text-[11px] mb-2 truncate"
                style={{ color: "hsl(var(--muted-foreground))", opacity: 0.8 }}
                title={info.download_name}
              >
                {t("update.installerFile", { name: info.download_name })}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => { openExternal(info.releases_url); }}
                className="text-xs underline-offset-2 hover:underline"
                style={{ color: "hsl(var(--muted-foreground))" }}
              >
                {t("update.openReleases")}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-md text-sm transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                >
                  {t("update.later")}
                </button>
                <button
                  onClick={() => {
                    // 优先直接下本平台安装包；清单里没有对应平台时回退官网
                    openExternal(info.download_url ?? PRODUCT_HOME_URL);
                  }}
                  className="px-4 py-1.5 rounded-md text-sm font-medium transition-opacity hover:opacity-80 flex items-center gap-1.5"
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                  title={info.download_name ?? undefined}
                >
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  {info.download_url ? t("update.downloadInstaller") : t("update.download")}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-5 h-5" style={{ color: "hsl(var(--success))" }} />
              <span className="font-semibold text-base" style={{ color: "hsl(var(--foreground))" }}>
                {t("update.upToDate")}
              </span>
            </div>
            <p className="text-sm mb-4" style={{ color: "hsl(var(--muted-foreground))" }}>
              {t("update.upToDateDesc", {
                version: `v${info?.current_version ?? currentVersion}`,
              })}
            </p>
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => { openExternal(PRODUCT_HOME_URL); }}
                className="text-xs underline-offset-2 hover:underline"
                style={{ color: "hsl(var(--muted-foreground))" }}
              >
                {t("update.visitSite")}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-md text-sm transition-opacity hover:opacity-80"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
              >
                {t("common.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
