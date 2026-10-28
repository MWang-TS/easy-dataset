import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, Coffee, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { POLL_INTERVAL_MS, SETTLE_GRACE_MS } from "@/lib/payment/config";
import { getDeviceCode } from "@/lib/payment/device-code";
import {
  GatewayError,
  centsToYuan,
  createTipOrder,
  fetchClientConfig,
  fetchOrder,
  newClientOrderId,
  parseYuanToCents,
  type ClientConfig,
  type OrderView,
  type PaymentProvider,
} from "@/lib/payment/gateway";

/**
 * 打赏弹窗（payment-server `/client/*`）。
 *
 * 流程：
 *   GET  /client/config           拿 tips 上下限与可用渠道（价格不写死在前端）
 *   POST /client/orders           下单（orderType=tip，金额单位元）
 *   GET  /client/orders/{id}      每 2 秒轮询，直到 paid / closed / failed
 *
 * 三条硬规则：
 *   1. `pending` / `creating` **绝不提示失败**
 *   2. 订单过期后再等 60 秒（服务端兜底对账）才判「未确认」
 *   3. 关闭弹窗立即停止轮询；进入终态后换新的 clientOrderId
 *
 * 打赏不签发许可证、不改变任何功能开关。
 */

type Phase =
  | "idle"
  | "creating"
  | "pending"
  | "unconfirmed"
  | "paid"
  | "closed"
  | "failed"
  | "error";

/** 预设档位（分），最终由服务端 tips.minCents / maxCents 过滤。 */
const PRESET_CENTS = [500, 990, 1990, 3990];

/** 打赏目录（限额 / 渠道）的本地缓存时长。 */
const CONFIG_TTL_MS = 10 * 60_000;

const PROVIDER_META: Record<PaymentProvider, { badge: string; color: string }> = {
  alipay: { badge: "支", color: "#1677ff" },
  wechat: { badge: "微", color: "#07c160" },
};

/**
 * 渠道的展示元信息。服务端新增渠道而客户端还没发版时，
 * 不能因为查不到配色就崩掉，用一个中性占位即可。
 */
function providerMeta(provider: string): { badge: string; color: string } {
  return (
    PROVIDER_META[provider as PaymentProvider] ?? {
      badge: String(provider || "?").slice(0, 1).toUpperCase(),
      color: "#64748b",
    }
  );
}

function errorText(error: unknown): string {
  if (error instanceof GatewayError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function TipDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const [provider, setProvider] = useState<PaymentProvider>("alipay");
  const [amountInput, setAmountInput] = useState("9.90");
  /** 用户动过金额输入后才提示格式/区间错误，避免弹窗一打开就是红字。 */
  const [amountTouched, setAmountTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /**
   * 幂等键。
   * 同一次「金额 + 渠道」的重试复用同一个 id（防网络重试产生两笔单），
   * 一旦订单进入 closed / failed 终态就作废，下次必须换新值 —— 否则永远拿回死单。
   */
  const idempotencyRef = useRef<{ signature: string; id: string; dead: boolean }>({
    signature: "",
    id: "",
    dead: true,
  });

  /** 目录缓存的拉取时间，用于判断是否需要重新拉。 */
  const fetchedAtRef = useRef(0);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const next = await fetchClientConfig();
      fetchedAtRef.current = Date.now();
      setConfig(next);
      const first = next.providers[0];
      if (first) setProvider(first);
    } catch (error) {
      setConfigError(errorText(error));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // 每次打开：清掉上一次的订单与提示；目录 10 分钟内复用，
  // 超时重新拉取（服务端可能改了限额/渠道）
  useEffect(() => {
    if (!open) return;
    setOrder(null);
    setMessage(null);
    setPhase("idle");
    if (!config || Date.now() - fetchedAtRef.current > CONFIG_TTL_MS) loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 秒级刷新倒计时（只在有订单时跑）
  useEffect(() => {
    if (!open || !order) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, order]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // 轮询支付结果
  useEffect(() => {
    if (!open || phase !== "pending" || !order) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parsedExpiry = Date.parse(order.expiresAt);
    const deadline = Number.isFinite(parsedExpiry)
      ? parsedExpiry + SETTLE_GRACE_MS
      : Number.POSITIVE_INFINITY;

    const tick = async () => {
      if (stopped) return;

      if (Date.now() > deadline) {
        // 已超时仍未确认：可能用户已付款但回调/对账尚未完成。
        // 这里**不能**引导用户重新支付，只能提示核对。
        setPhase("unconfirmed");
        setMessage(t("coffee.unconfirmedMsg"));
        return;
      }

      try {
        const latest = await fetchOrder(order.orderId, getDeviceCode());
        if (stopped) return;
        if (latest.status === "paid") {
          setOrder(latest);
          setPhase("paid");
          return;
        }
        if (latest.status === "closed" || latest.status === "failed") {
          setOrder(latest);
          setPhase(latest.status);
          setMessage(latest.status === "closed" ? t("coffee.closedMsg") : t("coffee.failedMsg"));
          idempotencyRef.current.dead = true;
          return;
        }
      } catch (error) {
        // 网络抖动 / 限流：静默重试；只有确定性错误才中止
        if (error instanceof GatewayError && !error.retryable) {
          if (!stopped) {
            setPhase("error");
            setMessage(error.message);
          }
          return;
        }
      }

      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, 1200);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, phase, order, t]);

  const bounds = config?.tips;
  const providers = config?.providers ?? [];

  const presetCents = useMemo(() => {
    if (!bounds) return [];
    const { minCents, maxCents } = bounds;
    const list = PRESET_CENTS.filter((cents) => cents >= minCents && cents <= maxCents);
    return list.length > 0 ? list : [Math.min(Math.max(minCents, 100), maxCents)];
  }, [bounds]);

  const amountCents = parseYuanToCents(amountInput);
  const amountValid =
    amountCents !== null &&
    !!bounds &&
    amountCents >= bounds.minCents &&
    amountCents <= bounds.maxCents;

  const handleCreate = async () => {
    if (!config || !bounds) return;
    // 金额问题由输入框下方的实时提示负责，这里静默返回，避免重复报错
    setAmountTouched(true);
    if (amountCents === null) return;
    if (amountCents < bounds.minCents) return;
    if (amountCents > bounds.maxCents) return;
    if (!providers.includes(provider)) {
      setMessage(t("coffee.providerDisabled"));
      return;
    }

    setMessage(null);
    setPhase("creating");

    const signature = `${provider}:${amountCents}`;
    const cached = idempotencyRef.current;
    if (cached.dead || cached.signature !== signature) {
      idempotencyRef.current = { signature, id: newClientOrderId(), dead: false };
    }

    try {
      const created = await createTipOrder({
        deviceCode: getDeviceCode(),
        provider,
        amount: centsToYuan(amountCents),
        clientOrderId: idempotencyRef.current.id,
      });
      setOrder(created);
      setNow(Date.now());
      if (created.status === "paid") {
        setPhase("paid");
        idempotencyRef.current.dead = true;
      } else if (created.status === "closed" || created.status === "failed") {
        setPhase(created.status);
        setMessage(t("coffee.closedMsg"));
        idempotencyRef.current.dead = true;
      } else {
        setPhase("pending");
      }
    } catch (error) {
      setPhase("error");
      setMessage(errorText(error));
      // 网络失败时订单可能已创建：保留幂等键，用户重试不会产生第二笔单
      if (error instanceof GatewayError && !error.retryable) {
        idempotencyRef.current.dead = true;
      }
    }
  };

  const handleCheckNow = async () => {
    if (!order) return;
    try {
      const latest = await fetchOrder(order.orderId, getDeviceCode());
      setOrder(latest);
      if (latest.status === "paid") setPhase("paid");
      else if (latest.status === "closed" || latest.status === "failed") {
        setPhase(latest.status);
        setMessage(t("coffee.closedMsg"));
        idempotencyRef.current.dead = true;
      } else {
        setMessage(t("coffee.notArrived"));
      }
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const handleReset = () => {
    idempotencyRef.current.dead = true;
    setOrder(null);
    setMessage(null);
    setPhase("idle");
  };

  const expiresAt = order ? Date.parse(order.expiresAt) : Number.NaN;
  const remainingMs = order && Number.isFinite(expiresAt) ? expiresAt - now : Number.NaN;
  const remainingText = (() => {
    if (!order) return "";
    if (!Number.isFinite(remainingMs)) return "";
    if (remainingMs <= 0) return t("coffee.expired");
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return t("coffee.expiresIn", {
      time: `${minutes}:${String(seconds).padStart(2, "0")}`,
    });
  })();

  if (!open) return null;

  const showForm = phase === "idle" || phase === "creating" || phase === "error";
  const showQr =
    (phase === "pending" || phase === "unconfirmed" || phase === "closed" || phase === "failed") &&
    !!order;

  // 通过 Portal 挂到 body：避免被父级 flex / overflow / 层叠上下文干扰，
  // 保证遮罩真正覆盖整个窗口、层级可靠（Tauri WebView2 下尤其明显）。
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.65)" }}
      // 点击遮罩**不关闭**：打赏涉及扫码与资金，误触失焦会打断支付流程。
      role="presentation"
    >
      <div
        className="relative rounded-2xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={t("coffee.title")}
        style={{
          width: 480,
          maxWidth: "92vw",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "linear-gradient(160deg, #0f1b2d 0%, #0a1220 100%)",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
        }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full hover:opacity-70 transition-opacity"
          style={{ background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.6)" }}
          title={t("common.close")}
        >
          <X className="w-4 h-4" />
        </button>

        {/* 标题 */}
        <div className="flex flex-col items-center pt-8 pb-5 px-8">
          <span style={{ fontSize: 40, lineHeight: 1 }}>☕</span>
          <h2 className="mt-3 text-xl font-bold" style={{ color: "#fff" }}>
            {t("coffee.title")}
          </h2>
          <p className="mt-1.5 text-sm text-center" style={{ color: "rgba(255,255,255,0.5)" }}>
            {config?.productName
              ? t("coffee.subtitleProduct", { product: config.productName })
              : t("coffee.subtitle")}
          </p>
        </div>

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)" }} />

        {/* 目录加载失败：不阻断软件使用 */}
        {configError && (
          <div className="px-6 pt-5">
            <div
              className="flex items-start gap-2 rounded-lg p-3 text-xs"
              style={{
                background: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.35)",
                color: "#fca5a5",
              }}
            >
              <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold mb-1">{t("coffee.configErrorTitle")}</div>
                <div style={{ color: "rgba(252,165,165,0.85)" }}>{configError}</div>
              </div>
            </div>
            <button
              onClick={loadConfig}
              disabled={configLoading}
              className="mt-3 w-full py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
            >
              {configLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {t("coffee.retry")}
            </button>
          </div>
        )}

        {/* 表单 */}
        {showForm && !configError && (
          <div className="px-6 pt-5 pb-6">
            {!config ? (
              <div
                className="flex flex-col items-center gap-3 py-10"
                style={{ color: "rgba(255,255,255,0.5)" }}
              >
                <Loader2 className="w-6 h-6 animate-spin" />
                <span className="text-sm">{t("coffee.loading")}</span>
              </div>
            ) : !bounds?.enabled ? (
              <div
                className="text-center text-sm py-10"
                style={{ color: "rgba(255,255,255,0.5)" }}
              >
                {t("coffee.notEnabled")}
              </div>
            ) : (
              <>
                {/* 金额档位 */}
                <div className="text-xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
                  {t("coffee.amountLabel")}
                </div>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {presetCents.map((cents) => {
                    const active = amountCents === cents;
                    return (
                      <button
                        key={cents}
                        onClick={() => {
                          setAmountTouched(true);
                          setAmountInput(centsToYuan(cents));
                          setMessage(null);
                        }}
                        className={cn(
                          "py-2 rounded-lg text-sm font-semibold transition-all",
                          active ? "text-white" : "text-white/70 hover:text-white"
                        )}
                        style={{
                          background: active ? "rgba(246,169,74,0.18)" : "rgba(255,255,255,0.06)",
                          border: active
                            ? "1.5px solid #f6a94a"
                            : "1.5px solid rgba(255,255,255,0.1)",
                        }}
                      >
                        ¥{cents % 100 === 0 ? cents / 100 : centsToYuan(cents)}
                      </button>
                    );
                  })}
                </div>

                {/* 自定义金额 */}
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-lg mb-4"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1.5px solid rgba(255,255,255,0.1)",
                  }}
                >
                  <span className="text-sm" style={{ color: "rgba(255,255,255,0.45)" }}>
                    ¥
                  </span>
                  <input
                    value={amountInput}
                    onChange={(e) => {
                      setAmountTouched(true);
                      setAmountInput(e.target.value);
                      setMessage(null);
                    }}
                    onBlur={() => {
                      // 失焦时把 9.9 规范成 9.90，避免与按钮上的展示格式不一致
                      const cents = parseYuanToCents(amountInput);
                      if (cents !== null) setAmountInput(centsToYuan(cents));
                    }}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={t("coffee.customAmount")}
                    className="flex-1 bg-transparent outline-none text-sm"
                    style={{ color: "#fff" }}
                  />
                  <span className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                    ¥{centsToYuan(bounds.minCents)} ~ ¥{centsToYuan(bounds.maxCents)}
                  </span>
                </div>

                {!amountValid && amountTouched && (
                  <div className="mb-3 -mt-2 text-[11px]" style={{ color: "rgba(252,165,165,0.9)" }}>
                    {amountCents === null
                      ? amountInput.trim() === ""
                        ? t("coffee.amountRange", {
                            min: centsToYuan(bounds.minCents),
                            max: centsToYuan(bounds.maxCents),
                          })
                        : t("coffee.amountInvalid")
                      : amountCents < bounds.minCents
                        ? t("coffee.tooLow", { min: centsToYuan(bounds.minCents) })
                        : t("coffee.tooHigh", { max: centsToYuan(bounds.maxCents) })}
                  </div>
                )}

                {/* 支付渠道（只渲染服务端声明的渠道） */}
                <div className="text-xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
                  {t("coffee.providerLabel")}
                </div>
                <div className="flex gap-2 mb-4">
                  {providers.map((item) => {
                    const meta = providerMeta(item);
                    const active = provider === item;
                    return (
                      <button
                        key={item}
                        onClick={() => setProvider(item)}
                        className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm transition-all"
                        style={{
                          background: active ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                          border: active
                            ? `1.5px solid ${meta.color}`
                            : "1.5px solid rgba(255,255,255,0.1)",
                          color: active ? "#fff" : "rgba(255,255,255,0.6)",
                        }}
                      >
                        <span
                          className="w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold"
                          style={{ background: meta.color, color: "#fff" }}
                        >
                          {meta.badge}
                        </span>
                        {t(`coffee.provider_${item}`, { defaultValue: item })}
                      </button>
                    );
                  })}
                </div>

                {message && (
                  <div className="mb-3 text-xs" style={{ color: "#fca5a5" }}>
                    {message}
                  </div>
                )}

                <button
                  onClick={handleCreate}
                  disabled={phase === "creating"}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-opacity hover:opacity-90 disabled:opacity-40"
                  style={{ background: "#f6a94a", color: "#1a1206" }}
                >
                  {phase === "creating" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("coffee.generating")}
                    </>
                  ) : (
                    <>{t("coffee.generate")}</>
                  )}
                </button>
                <p
                  className="mt-3 text-[11px] text-center leading-relaxed"
                  style={{ color: "rgba(255,255,255,0.3)" }}
                >
                  {t("coffee.disclaimer")}
                </p>
              </>
            )}
          </div>
        )}

        {/* 二维码 / 结果 */}
        {showQr && order && (
          <div className="px-6 pt-5 pb-6 flex flex-col items-center">
            {phase === "pending" && order.qrCode ? (
              <>
                <div className="rounded-2xl p-4" style={{ background: "#fff" }}>
                  <QRCodeSVG
                    value={order.qrCode}
                    size={208}
                    level="M"
                    marginSize={0}
                    title={t("coffee.qrTitle")}
                    className="w-[208px] h-[208px] block"
                  />
                </div>
                <div className="mt-4 text-2xl font-bold" style={{ color: "#f6a94a" }}>
                  ¥{centsToYuan(order.amountCents)}
                </div>
                <div className="mt-1 text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
                  {t(`coffee.provider_${order.provider}`, { defaultValue: order.provider })} · {t("coffee.scanTip")}
                </div>
                <div className="mt-2 text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                  {remainingText}
                </div>

                <div className="mt-5 w-full flex gap-2">
                  <button
                    onClick={handleCheckNow}
                    className="flex-1 py-2 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    {t("coffee.checkNow")}
                  </button>
                  <button
                    onClick={handleReset}
                    className="py-2 px-4 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.65)" }}
                    title={t("coffee.resampleTitle")}
                  >
                    {t("coffee.resample")}
                  </button>
                </div>

                <p
                  className="mt-3 text-[11px] text-center leading-relaxed"
                  style={{ color: "rgba(255,255,255,0.3)" }}
                >
                  {t("coffee.autoConfirm")}
                </p>
              </>
            ) : phase === "pending" ? (
              /* 订单已创建但服务端未下发二维码内容：极少数渠道/时序情况，别直接判失败 */
              <>
                <div
                  className="w-full rounded-lg p-3 text-xs flex items-start gap-2"
                  style={{
                    background: "rgba(246,169,74,0.12)",
                    border: "1px solid rgba(246,169,74,0.35)",
                    color: "#fcd34d",
                  }}
                >
                  <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
                  <span>{t("coffee.qrPending")}</span>
                </div>
                <div className="mt-4 w-full flex gap-2">
                  <button
                    onClick={handleCheckNow}
                    className="flex-1 py-2 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    {t("coffee.checkAgain")}
                  </button>
                  <button
                    onClick={handleReset}
                    className="py-2 px-4 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.65)" }}
                  >
                    {t("coffee.resample")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div
                  className="w-full rounded-lg p-3 text-xs flex items-start gap-2"
                  style={{
                    background:
                      phase === "unconfirmed" ? "rgba(246,169,74,0.12)" : "rgba(239,68,68,0.12)",
                    border:
                      phase === "unconfirmed"
                        ? "1px solid rgba(246,169,74,0.35)"
                        : "1px solid rgba(239,68,68,0.35)",
                    color: phase === "unconfirmed" ? "#fcd34d" : "#fca5a5",
                  }}
                >
                  <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {message ??
                      (phase === "unconfirmed"
                        ? t("coffee.unconfirmedShort")
                        : t("coffee.closedMsg"))}
                  </span>
                </div>

                {phase === "unconfirmed" ? (
                  <div className="mt-4 w-full flex gap-2">
                    <button
                      onClick={handleCheckNow}
                      className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                      style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                    >
                      {t("coffee.checkAgain")}
                    </button>
                    <button
                      onClick={handleReset}
                      className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                      style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)" }}
                    >
                      {t("coffee.regenerate")}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleReset}
                    className="mt-4 w-full py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-opacity hover:opacity-90"
                    style={{ background: "#f6a94a", color: "#1a1206" }}
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t("coffee.regenerate")}
                  </button>
                )}
              </>
            )}

            {message && phase === "pending" && (
              <div className="mt-3 text-xs text-center" style={{ color: "rgba(255,255,255,0.5)" }}>
                {message}
              </div>
            )}
          </div>
        )}

        {/* 支付成功 */}
        {phase === "paid" && order && (
          <div className="px-6 pb-6 flex flex-col items-center">
            <div
              className="w-full rounded-lg p-4 flex items-center gap-3"
              style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)" }}
            >
              <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: "#22c55e" }} />
              <div>
                <div className="text-sm font-semibold" style={{ color: "#86efac" }}>
                  {t("coffee.paidTitle", { amount: centsToYuan(order.amountCents) })}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "rgba(134,239,172,0.75)" }}>
                  {t("coffee.paidDesc")}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="mt-4 w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
            >
              {t("common.close")}
            </button>
          </div>
        )}

        <div
          className="py-3.5 text-center text-xs"
          style={{
            color: "rgba(255,255,255,0.35)",
            background: "rgba(255,255,255,0.04)",
            borderTop: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <span className="inline-flex items-center gap-1">
            <Coffee className="w-3 h-3" />
            {t("coffee.footer")}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
