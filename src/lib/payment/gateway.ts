/**
 * payment-server 客户端网关（`/client/*`）HTTP 封装。
 *
 * 统一做三件事，业务组件不要各自判断 status：
 *   1. 每个请求带 `X-Client-App-Id`（多产品共用实例时用于选择价目表与渠道）
 *   2. 错误归一化成 `GatewayError`（`error` / `reason` / `code` 三个字段都兜）
 *   3. 网络层失败归为 `offline`，并 `console.warn` 出具体 URL
 *      （CORS 拒绝、DNS 失败、证书错误都会被浏览器归一成 `Failed to fetch`，
 *      不打地址几乎无法排查）
 *
 * 这里**只**实现打赏链路需要的三个接口：config / 下单 / 查单。
 * 领证、换绑、账号、退款等接口一律不放进客户端。
 */

import { PAY_APP_ID, PAY_TIMEOUT_MS, gatewayBase } from "./config";

export type GatewayErrorKind =
  | "offline"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "server"
  | "client";

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status: number;
  /** 服务端机器可读原因（`reason` / `code`），没有时为 `""`。 */
  readonly code: string;

  constructor(kind: GatewayErrorKind, status: number, code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  /** 可重试：网络抖动、限流、服务端临时故障。 */
  get retryable(): boolean {
    return this.kind === "offline" || this.kind === "rate-limited" || this.kind === "server";
  }

  get isOffline(): boolean {
    return this.kind === "offline";
  }
}

function kindFromStatus(status: number): GatewayErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "client";
}

function pickMessage(body: unknown, fallback: string): { code: string; message: string } {
  if (!body || typeof body !== "object") return { code: "", message: fallback };
  const record = body as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
  const code = text(record.reason) || text(record.code);
  const message = text(record.error) || text(record.message) || text(record.reason) || fallback;
  return { code, message };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${gatewayBase()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Client-App-Id": PAY_APP_ID,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof DOMException && error.name === "AbortError";
    // 浏览器把 CORS / DNS / TLS 全部归一成 "Failed to fetch"，必须打出 URL 才能排查
    console.warn(`[payment] 请求失败 ${init?.method ?? "GET"} ${url}`, error);
    throw new GatewayError(
      "offline",
      0,
      aborted ? "timeout" : "network",
      aborted ? "请求超时，请检查网络后重试" : "无法连接支付服务器，请检查网络"
    );
  }
  clearTimeout(timer);

  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const { code, message } = pickMessage(body, `请求失败（HTTP ${response.status}）`);
    throw new GatewayError(kindFromStatus(response.status), response.status, code, message);
  }
  if (!body || typeof body !== "object") {
    throw new GatewayError("server", response.status, "bad-payload", "支付服务器返回了无法解析的内容");
  }
  return body as T;
}

// ─── 类型 ─────────────────────────────────────────────────────

export type PaymentProvider = "alipay" | "wechat";

export type OrderStatus = "creating" | "pending" | "paid" | "closed" | "failed";

/** `GET /client/config` 的响应（只声明打赏用到的字段）。 */
export interface ClientConfig {
  appId: string;
  productName: string;
  providers: PaymentProvider[];
  /** true = 本产品只开放打赏，客户端应隐藏订阅/试用入口。 */
  tipOnly?: boolean;
  tips: { enabled: boolean; minCents: number; maxCents: number };
}

export interface OrderView {
  orderId: string;
  status: OrderStatus;
  amountCents: number;
  provider: PaymentProvider;
  orderType: "purchase" | "tip";
  expiresAt: string;
  paidAt: string | null;
  qrCode: string | null;
}

// ─── 接口 ─────────────────────────────────────────────────────

/** 商品目录（打赏场景只用到 `providers` / `tips`）。 */
export function fetchClientConfig(): Promise<ClientConfig> {
  return request<ClientConfig>("/config");
}

/**
 * 创建打赏订单。
 *
 * @param amount 单位**元**，两位小数字符串（如 `"9.90"`）。打赏金额由用户输入，必须传。
 * @param clientOrderId 幂等键。重复点击应复用同一个值；
 *                     一旦拿到 `closed` / `failed` 终态就必须换新值，否则永远拿回死单。
 */
export function createTipOrder(params: {
  deviceCode: string;
  provider: PaymentProvider;
  amount: string;
  clientOrderId: string;
}): Promise<OrderView> {
  return request<OrderView>("/orders", {
    method: "POST",
    body: JSON.stringify({
      deviceCode: params.deviceCode,
      provider: params.provider,
      orderType: "tip",
      amount: params.amount,
      clientOrderId: params.clientOrderId,
    }),
  });
}

/** 查单（轮询用）。`deviceCode` 不匹配会 403。 */
export function fetchOrder(orderId: string, deviceCode: string): Promise<OrderView> {
  const query = new URLSearchParams({ deviceCode }).toString();
  return request<OrderView>(`/orders/${encodeURIComponent(orderId)}?${query}`);
}

// ─── 金额工具 ─────────────────────────────────────────────────

/** 分 → 元字符串（`990` → `"9.90"`）。 */
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * 用户输入（元）→ 分。非法返回 `null`。
 *
 * 只接受最多两位小数：服务端对三位小数会直接 400，本地先拦一次避免必然失败的请求。
 */
export function parseYuanToCents(input: string): number | null {
  const text = String(input || "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/** 生成幂等键（本地 UUID，不需要是密码学安全的随机值）。 */
export function newClientOrderId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `tip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
