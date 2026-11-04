"""
services/proc.py
子进程启动工具：Windows 下禁止弹出黑色控制台窗口。

背景：Tauri 客户端以 GUI 方式启动 Python 后端（CREATE_NO_WINDOW），
但该标志**不会继承**给 Python 再派生的子进程（如 ffmpeg）。
若不显式指定，用户在 GUI 里点「AI 智能抽帧」时会弹出 ffmpeg 的终端窗口。
"""
import os
import subprocess

CREATE_NO_WINDOW = 0x08000000


def no_window_kwargs() -> dict:
    """返回 Windows 下隐藏控制台所需的 Popen 参数（其他平台为空）。"""
    if os.name == 'nt':
        return {'creationflags': CREATE_NO_WINDOW, 'stdin': subprocess.DEVNULL}
    return {}


def patch_popen_no_window() -> bool:
    """把 CREATE_NO_WINDOW 设为所有 subprocess 的默认值（仅 Windows）。

    第三方库（ultralytics / pip / torch 等）内部可能调用 subprocess，
    统一打补丁可避免它们在 GUI 场景下弹出控制台。返回是否生效。
    """
    if os.name != 'nt':
        return False
    original_init = subprocess.Popen.__init__
    if getattr(original_init, '_eds_no_window', False):
        return True

    def patched(self, *args, **kwargs):
        # 调用方显式指定了 creationflags / startupinfo / shell 时不干预
        if not kwargs.get('creationflags') and not kwargs.get('startupinfo') and not kwargs.get('shell'):
            kwargs['creationflags'] = CREATE_NO_WINDOW
        return original_init(self, *args, **kwargs)

    patched._eds_no_window = True  # type: ignore[attr-defined]
    subprocess.Popen.__init__ = patched  # type: ignore[assignment]
    return True
