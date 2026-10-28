/**
 * 打开外部链接（系统默认浏览器 / 邮件客户端）。
 *
 * 两个坑：
 *   1. 必须由 Rust 侧 `opener` 插件执行，WebView 里的 `window.open` 会被拦；
 *      插件除了命令权限（`opener:allow-open-url`）还需要**作用域**
 *      （`opener:allow-default-urls`），否则 http/https 链接会在运行时被拒，
 *      表现就是「点了没反应」—— 见 `src-tauri/capabilities/default.json`。
 *   2. 失败时不要静默吞掉：不打印日志的话，权限/系统关联问题永远查不出来。
 */
import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternal(url: string): void {
  openUrl(url).catch((error) => {
    console.warn(`[open] 打开外部链接失败：${url}`, error);
  });
}
