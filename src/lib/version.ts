/**
 * 应用版本号。
 *
 * 唯一真相源是根目录 `package.json` 的 `version`，
 * 由 `vite.config.ts` 在构建期用 `define` 注入为字面量 `__APP_VERSION__`。
 * UI 里不要再硬编码或另读一处版本号，否则发版时必然漏改。
 *
 * `Cargo.toml` / `tauri.conf.json` 的版本仍需手动与 package.json 保持一致
 * （Tauri 安装包版本取自那里）。
 */

declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
