"""services/image_io.py
OpenCV 图片写入的 Unicode 安全封装。

cv2.imwrite 在 Windows 上使用 ANSI 窄字符串文件 API，遇到含中文等
非 ASCII 字符的路径会静默失败（返回 False），导致"显示成功但目录为空"。
这里改用 cv2.imencode 编码后用 numpy 的 tofile() 写盘，tofile 走
Python 层文件句柄，对 Unicode 路径完全兼容。
"""
import os
import cv2


def imwrite_unicode(path: str, img, params=None) -> bool:
    """将图像写入 path（兼容含中文/空格的 Windows 路径），返回是否成功。"""
    ext = os.path.splitext(path)[1]
    if not ext:
        ext = ".jpg"
    ok, buf = cv2.imencode(ext, img, params or [])
    if not ok:
        return False
    try:
        buf.tofile(path)
        return True
    except OSError:
        return False
