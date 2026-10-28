/**
 * payment-server 客户端网关（`/client/*`）构建期常量。
 *
 * 这里只允许出现**公开**信息：
 *   - `appId` 是产品标识，任何人都能从 `GET /client/config` 读到
 *   - `baseUrl` 是公网地址
 *
 * ⚠️ 绝不要把 `apiSecret`（`sk_...`）放进前端代码：
 * 一旦进包，攻击者就能退款、撤销许可证、把金额改成 0.01。
 * 客户端只走 `/client/*`，这条链路本身不暴露任何危险操作。
 */

/** 构建期可用 `VITE_PAY_APP_ID` 覆盖。 */
export const PAY_APP_ID: string =
  (import.meta.env.VITE_PAY_APP_ID as string | undefined)?.trim() ||
  "app_fc1fd90e43214f566ebe8398";

/** 网关基地址，剥掉末尾 `/` 与末尾 `/client`，避免拼成 `/client/client/*`（全 404）。 */
export function normalizeBaseUrl(raw: string): string {
  let url = String(raw || "").trim();
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  if (url.toLowerCase().endsWith("/client")) {
    url = url.slice(0, -"/client".length).replace(/\/+$/, "");
  }
  return url;
}

/** 默认服务地址（构建期可被 `VITE_PAY_BASE_URL` 覆盖，**不要**带 `/client` 后缀）。 */
const DEFAULT_PAY_BASE_URL = "https://pay.tensorsight.cn";

export const PAY_BASE_URL: string =
  normalizeBaseUrl((import.meta.env.VITE_PAY_BASE_URL as string | undefined) ?? "") ||
  DEFAULT_PAY_BASE_URL;

/** 网关根地址（含 `/client`）。 */
export function gatewayBase(): string {
  return `${PAY_BASE_URL}/client`;
}

/** 单次 HTTP 请求超时。打赏是交互式操作，超过这个时长就该让用户重试。 */
export const PAY_TIMEOUT_MS = 15_000;

/** 轮询间隔：查单有独立限流（60 次/分/设备码），2 秒 = 30 次/分，留一倍余量。 */
export const POLL_INTERVAL_MS = 2_000;

/** 订单过期后额外等待的对账窗口（服务端约 60 秒兜底对账）。 */
export const SETTLE_GRACE_MS = 60_000;
