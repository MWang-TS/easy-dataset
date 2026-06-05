"""
# app.py

## 核心功能
Easy Dataset Station 主应用入口，负责初始化 Flask 应用、SocketIO 服务和注册 API 蓝图。
"""
import os
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'

import sys
import threading

def _start_parent_watchdog():
    """监控父进程（Tauri）是否存活，若父进程退出则自动退出后端。"""
    parent_pid = int(os.environ.get('PARENT_PID', '0'))
    if parent_pid <= 0:
        return
    import time
    try:
        import psutil
        def _watch():
            while True:
                time.sleep(3)
                try:
                    if not psutil.pid_exists(parent_pid):
                        os._exit(0)
                except Exception:
                    pass
    except ImportError:
        # psutil 不可用时用系统调用兜底（Windows/Linux 通用）
        import ctypes, platform
        if platform.system() == 'Windows':
            def _watch():
                while True:
                    time.sleep(3)
                    try:
                        kernel32 = ctypes.windll.kernel32
                        handle = kernel32.OpenProcess(0x100000, False, parent_pid)  # SYNCHRONIZE
                        if handle:
                            ret = kernel32.WaitForSingleObject(handle, 0)  # WAIT_OBJECT_0=0 means signaled=dead
                            kernel32.CloseHandle(handle)
                            if ret == 0:
                                os._exit(0)
                        else:
                            os._exit(0)  # 无法打开句柄说明进程不存在
                    except Exception:
                        pass
        else:
            def _watch():
                while True:
                    time.sleep(3)
                    try:
                        os.kill(parent_pid, 0)  # 发 0 信号探测进程是否存在
                    except OSError:
                        os._exit(0)
    t = threading.Thread(target=_watch, daemon=True)
    t.start()

_start_parent_watchdog()

from flask import Flask, send_from_directory
from flask_socketio import SocketIO
from flask_cors import CORS
from config import Config
from routes import main_bp

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
app.config.from_object(Config)
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

Config.init_folders()

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

app.register_blueprint(main_bp)

from routes.main_routes import register_socketio_events
register_socketio_events(socketio)


def is_embedded_runtime():
    return os.environ.get('EASY_DATASET_EMBEDDED', '').lower() in {'1', 'true', 'yes'}


@app.route('/health')
def health_check():
    return {
        'status': 'ok',
        'message': 'Easy Dataset Station is running',
    }


@app.route('/previews/<path:filename>')
def serve_preview(filename):
    return send_from_directory(Config.get_previews_dir(), filename)


if __name__ == '__main__':
    debug_enabled = Config.DEBUG and not is_embedded_runtime()
    print("=" * 50)
    print("Easy Dataset Station - 启动信息")
    print("=" * 50)
    print(f"服务地址: http://{Config.HOST}:{Config.PORT}")
    print("=" * 50)
    socketio.run(
        app,
        host=Config.HOST,
        port=Config.PORT,
        debug=debug_enabled,
        use_reloader=debug_enabled,
    )
