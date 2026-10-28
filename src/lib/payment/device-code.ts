/**
 * 设备码（deviceCode）。
 *
 * payment-server 的 `/client/*` 用它把订单绑定到本机：下单时服务端只存
 * `sha256(deviceCode)[0..32]`，查单时比对哈希，不匹配返回 403。
 *
 * 约定：
 *   - 长度 4~256，这里用 32 位十六进制（UUIDv4 去掉横线）
 *   - **必须持久化**，每次启动读到同一个值
 *   - 不是密钥：泄露的后果仅限「别人能查这台设备的打赏订单」，不涉及资金
 */

const DEVICE_CODE_KEY = "easy-dataset:device-code";

/** localStorage 不可用（存储被禁用）时的会话内兜底。 */
let memoryDeviceCode = "";

function randomFallback(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateDeviceCode(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID().replace(/-/g, "");
  }
  return randomFallback();
}

/** 读取本机设备码；首次调用时生成并持久化。 */
export function getDeviceCode(): string {
  try {
    const existing = localStorage.getItem(DEVICE_CODE_KEY);
    if (existing && existing.length >= 4) return existing;

    const created = generateDeviceCode();
    localStorage.setItem(DEVICE_CODE_KEY, created);
    return created;
  } catch {
    if (!memoryDeviceCode) memoryDeviceCode = generateDeviceCode();
    return memoryDeviceCode;
  }
}
