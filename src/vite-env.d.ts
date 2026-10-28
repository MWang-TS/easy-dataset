/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** payment-server 产品标识（构建期注入，运行期不可改）。 */
  readonly VITE_PAY_APP_ID?: string;
  /** payment-server 服务地址，**不要**带 `/client` 后缀。 */
  readonly VITE_PAY_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
