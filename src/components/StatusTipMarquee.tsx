/**
 * StatusTipMarquee.tsx
 * 状态栏滚动提示（走马灯）：循环播放全局快捷键 / 使用技巧。
 * 悬停暂停；点击 × 关闭；关闭后在状态栏留一个灯泡图标可重新开启。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lightbulb, X } from "lucide-react";

/** 每条提示滚动的时长（毫秒），与 CSS 动画时长保持一致 */
const TIP_DURATION_MS = 12000;
const HIDDEN_KEY = "eds.tips.hidden";

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export default function StatusTipMarquee() {
  const { t, i18n } = useTranslation();

  const tips = useMemo(() => {
    const raw = t("tips.items", { returnObjects: true });
    return Array.isArray(raw) ? (raw as string[]) : [];
  }, [t, i18n.language]);

  const [open, setOpen] = useState(() => !readHidden());
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(0);
  const [runId, setRunId] = useState(0);

  // 切语言时回到第一条，避免索引越界
  useEffect(() => {
    setIndex(0);
    setRunId((v) => v + 1);
  }, [i18n.language]);

  useEffect(() => {
    if (!open || paused || tips.length === 0) return;
    const timer = window.setTimeout(() => {
      setIndex((i) => (i + 1) % tips.length);
      setRunId((v) => v + 1);
    }, TIP_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [open, paused, tips.length, index]);

  if (tips.length === 0) return null;

  if (!open) {
    return (
      <button
        onClick={() => {
          try {
            window.localStorage.removeItem(HIDDEN_KEY);
          } catch { /* 忽略 */ }
          setOpen(true);
        }}
        title={t("tips.show")}
        className="flex items-center justify-center rounded px-1"
        style={{ color: "hsl(var(--muted-foreground))" }}
      >
        <Lightbulb className="w-3.5 h-3.5" />
      </button>
    );
  }

  return (
    <div
      className="w-full flex items-center gap-1.5 min-w-0"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Lightbulb className="w-3 h-3 flex-shrink-0" style={{ color: "hsl(var(--warning))" }} />
      <div className="relative flex-1 min-w-0 overflow-hidden" style={{ height: 16 }}>
        <div
          key={runId}
          className="flex whitespace-nowrap"
          style={{
            width: "max-content",
            animation: `eds-ticker ${TIP_DURATION_MS}ms linear infinite`,
            animationPlayState: paused ? "paused" : "running",
            willChange: "transform",
          }}
        >
          <span style={{ lineHeight: "16px", paddingRight: 48 }}>{tips[index]}</span>
          <span style={{ lineHeight: "16px", paddingRight: 48 }} aria-hidden>
            {tips[index]}
          </span>
        </div>
      </div>
      <button
        onClick={() => {
          try {
            window.localStorage.setItem(HIDDEN_KEY, "1");
          } catch { /* 忽略 */ }
          setOpen(false);
        }}
        title={t("tips.close")}
        className="flex items-center justify-center rounded px-1 flex-shrink-0"
        style={{ color: "hsl(var(--muted-foreground))" }}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
