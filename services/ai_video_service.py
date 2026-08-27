"""
services/ai_video_service.py
AI 视频智能抽帧：YOLOv8 推理，仅保留含目标类别的帧。

支持两种模式：
  pipeline 模式（默认）：单路顺序读帧 -> 有界队列 -> 批量 GPU 推理
  segment 模式（大文件推荐）：先把视频物理切成若干段临时文件（无 seek 竞争），
                               然后每段独立线程顺序读取 + 自有模型实例推理，
                               多段真正并行，适合超长视频。
"""
import os
import uuid
import shutil
import subprocess
import tempfile
import threading
import cv2

from services.image_io import imwrite_unicode

_tasks: dict = {}
_tasks_lock = threading.Lock()

# 串行化模型加载：防止多线程并发 CUDA 初始化竞争导致加载变慢或卡死
_model_load_lock = threading.Lock()

DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "models", "yolov8m.pt"
)


def _load_model_fresh(model_path: str):
    """每次返回一个新的模型实例（避免多线程共享同一个实例）。
    模型加载使用全局锁串行化，防止多线程并发 CUDA 初始化竞争。"""
    from ultralytics import YOLO  # noqa: PLC0415
    with _model_load_lock:
        return YOLO(model_path)


def _ffmpeg_split(video_path: str, temp_dir: str, segment_seconds: int,
                  stop_event: threading.Event,
                  task: dict = None, total_seconds: float = 0) -> list:
    """用 ffmpeg 把视频切成等长段（-c copy 快速无损）。返回段文件路径列表。"""
    seg_pattern = os.path.join(temp_dir, "seg_%04d.mp4")
    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-c", "copy",
        "-f", "segment",
        "-segment_time", str(segment_seconds),
        "-reset_timestamps", "1",
        "-progress", "pipe:2",   # 把 progress 输出到 stderr
        seg_pattern,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True)

    import re
    time_pat = re.compile(r"out_time_ms=(\d+)")

    def _read_stderr():
        for line in proc.stderr:
            if stop_event.is_set():
                break
            m = time_pat.search(line)
            if m and task is not None and total_seconds > 0:
                elapsed_s = int(m.group(1)) / 1_000_000
                task["split_progress"] = round(
                    min(99.0, elapsed_s / total_seconds * 100), 1
                )

    stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
    stderr_thread.start()

    while proc.poll() is None:
        if stop_event.is_set():
            proc.terminate()
            stderr_thread.join(timeout=2)
            return []
    stderr_thread.join(timeout=2)

    if proc.returncode != 0:
        raise RuntimeError("ffmpeg 分段失败")
    if task is not None:
        task["split_progress"] = 100.0
    files = sorted(
        os.path.join(temp_dir, f)
        for f in os.listdir(temp_dir)
        if f.startswith("seg_") and f.endswith(".mp4")
    )
    return files


def _opencv_split(video_path: str, temp_dir: str, seg_frames: int,
                  task: dict, stop_event: threading.Event) -> list:
    """用 OpenCV 把视频切成等长段（无外部依赖，但比 ffmpeg 慢）。"""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")

    task["state"] = "splitting"
    seg_files = []
    writer = None
    seg_path = None
    fi = 0

    while True:
        if stop_event.is_set():
            break
        ret, frame = cap.read()
        if not ret:
            break
        if fi % seg_frames == 0:
            if writer:
                writer.release()
                seg_files.append(seg_path)
            seg_path = os.path.join(temp_dir, f"seg_{len(seg_files):04d}.mp4")
            writer = cv2.VideoWriter(seg_path, fourcc, fps, (w, h))
        if writer:
            writer.write(frame)
        fi += 1
        if fi % 500 == 0:
            task["split_progress"] = round(fi / max(1, total) * 100, 1)

    if writer:
        writer.release()
        if seg_path and os.path.exists(seg_path):
            seg_files.append(seg_path)
    cap.release()
    return seg_files


def _infer_segment_simple(
    seg_path: str,
    model_path: str,
    target_set: set,
    conf_threshold: float,
    interval_frames: int,
    batch_size: int,
    fmt: str,
    quality: int,
    prefix: str,
    output_dir: str,
    global_frame_offset: int,
    task_counters: dict,
    stop_event: threading.Event,
) -> None:
    """单段推理（ThreadPoolExecutor worker）：加载模型→读帧→批量推理→写盘。"""
    ext = fmt.lower().lstrip(".")
    if ext not in ("jpg", "jpeg", "png", "bmp"):
        ext = "jpg"
    write_params = (
        [cv2.IMWRITE_JPEG_QUALITY, max(1, min(100, int(quality)))]
        if ext in ("jpg", "jpeg") else []
    )

    try:
        model = _load_model_fresh(model_path)
    except Exception as e:
        print(f"[ai_video] model load failed for {os.path.basename(seg_path)}: {e}")
        return

    cap = cv2.VideoCapture(seg_path)
    if not cap.isOpened():
        return

    fi = 0
    saved_local = 0
    batch_frames: list = []
    batch_gfis: list = []

    def flush():
        nonlocal saved_local, batch_size
        if not batch_frames or stop_event.is_set():
            batch_frames.clear(); batch_gfis.clear()
            return
        n = len(batch_frames)
        while True:
            try:
                results = model(batch_frames, verbose=False, conf=conf_threshold)
                break
            except Exception as e:
                if "out of memory" in str(e).lower() and batch_size > 1:
                    try:
                        import torch; torch.cuda.empty_cache()
                    except Exception:
                        pass
                    batch_size = max(1, batch_size // 2)
                    print(f"[ai_video] OOM -> batch_size={batch_size}")
                else:
                    batch_frames.clear(); batch_gfis.clear()
                    return
        newly = 0
        for i, r in enumerate(results):
            if stop_event.is_set():
                break
            if r.boxes is not None and len(r.boxes):
                for cls_id in r.boxes.cls.tolist():
                    if model.names.get(int(cls_id), "").lower() in target_set:
                        fname = f"{prefix}_{batch_gfis[i]:08d}.{ext}"
                        imwrite_unicode(os.path.join(output_dir, fname), batch_frames[i], write_params)
                        newly += 1
                        break
        saved_local += newly
        batch_frames.clear(); batch_gfis.clear()
        with task_counters["lock"]:
            task_counters["saved"][0] += newly
            task_counters["processed"][0] += n

    try:
        while True:
            if stop_event.is_set():
                break
            if fi % interval_frames == 0:
                ret, frame = cap.read()
                if not ret:
                    break
                batch_frames.append(frame)
                batch_gfis.append(global_frame_offset + fi)
                if len(batch_frames) >= batch_size:
                    flush()
            else:
                if not cap.grab():
                    break
            fi += 1
        if not stop_event.is_set():
            flush()
    except Exception as e:
        print(f"[ai_video] infer error {os.path.basename(seg_path)}: {e}")
        try:
            import torch; torch.cuda.empty_cache()
        except Exception:
            pass
    finally:
        cap.release()


def _infer_segment(
    seg_path: str,
    model_path: str,
    target_set: set,
    conf_threshold: float,
    interval_frames: int,
    batch_size: int,
    fmt: str,
    quality: int,
    prefix: str,
    output_dir: str,
    global_frame_offset: int,
    task_counters: dict,
    stop_event: threading.Event,
    semaphore: threading.Semaphore,
) -> None:
    """单段推理线程：顺序读取 seg_path，批量 GPU 推理，命中则写盘。"""
    ext = fmt.lower().lstrip(".")
    if ext not in ("jpg", "jpeg", "png", "bmp"):
        ext = "jpg"
    write_params = (
        [cv2.IMWRITE_JPEG_QUALITY, max(1, min(100, int(quality)))]
        if ext in ("jpg", "jpeg") else []
    )

    try:
        model = _load_model_fresh(model_path)
    except Exception:
        semaphore.release()
        return
    semaphore.release()  # 模型加载完即释放，允许下一段开始加载

    cap = cv2.VideoCapture(seg_path)
    if not cap.isOpened():
        return

    fi = 0
    saved_local = 0
    processed_local = 0
    batch_frames: list = []
    batch_gfis: list = []

    def flush() -> None:
        nonlocal saved_local, processed_local, batch_size
        if not batch_frames:
            return
        if stop_event.is_set():
            batch_frames.clear()
            batch_gfis.clear()
            return
        batch_size_actual = len(batch_frames)
        # OOM 自动降级：batch_size 减半重试，最低降到 1
        while True:
            try:
                results = model(batch_frames, verbose=False, conf=conf_threshold)
                break
            except Exception as e:
                err = str(e).lower()
                if "out of memory" in err and batch_size > 1:
                    import torch
                    torch.cuda.empty_cache()
                    batch_size = max(1, batch_size // 2)
                    print(f"[ai_video] OOM, batch_size -> {batch_size}")
                    # 按新 batch_size 拆分重试
                    sub_results = []
                    for i in range(0, len(batch_frames), batch_size):
                        try:
                            sub = model(batch_frames[i:i+batch_size], verbose=False, conf=conf_threshold)
                            sub_results.extend(sub)
                        except Exception:
                            torch.cuda.empty_cache()
                            # 逐帧 fallback
                            for f in batch_frames[i:i+batch_size]:
                                try:
                                    sub_results.extend(model([f], verbose=False, conf=conf_threshold))
                                except Exception:
                                    torch.cuda.empty_cache()
                    results = sub_results
                    break
                else:
                    raise
        newly_saved = 0
        for i, r in enumerate(results):
            if stop_event.is_set():
                break
            hit = False
            if r.boxes is not None and len(r.boxes):
                for cls_id in r.boxes.cls.tolist():
                    if model.names.get(int(cls_id), "").lower() in target_set:
                        hit = True
                        break
            if hit:
                fname = f"{prefix}_{batch_gfis[i]:08d}.{ext}"
                imwrite_unicode(os.path.join(output_dir, fname), batch_frames[i], write_params)
                newly_saved += 1
        saved_local += newly_saved
        batch_frames.clear()
        batch_gfis.clear()
        # 每次 flush 后立即增量更新全局计数器，让监控线程能即时上报
        with task_counters["lock"]:
            task_counters["saved"][0] += newly_saved
            task_counters["processed"][0] += batch_size_actual

    try:
        while True:
            if stop_event.is_set():
                batch_frames.clear()     # 停止时不再 flush，直接丢弃
                batch_gfis.clear()
                break
            if fi % interval_frames == 0:
                ret, frame = cap.read()
                if not ret:
                    break
                batch_frames.append(frame)
                batch_gfis.append(global_frame_offset + fi)
                processed_local += 1
                if len(batch_frames) >= batch_size:
                    flush()
            else:
                if not cap.grab():
                    break
            fi += 1
        flush()
    except Exception as exc:
        # OOM 或其他推理错误：尝试缩小 batch_size 到 1 重试剩余帧
        batch_frames.clear()
        batch_gfis.clear()
        import traceback as _tb
        print(f"[ai_video] segment error ({os.path.basename(seg_path)}): {exc}\n{_tb.format_exc()[:500]}")
        # 如果是 CUDA OOM，清空缓存后继续（但本段已读到 fi 处，重新打开从头读不现实，直接放弃本段）
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass
    finally:
        cap.release()
    # 段结束后不需要再写 counters（flush 内已增量写入）


class AIVideoService:

    @staticmethod
    def check_available() -> dict:
        """检查当前环境是否安装了 ultralytics 且 ffmpeg 可用"""
        import shutil
        missing = []
        version = None
        try:
            import ultralytics  # noqa: F401
            version = ultralytics.__version__
        except ImportError:
            missing.append("ultralytics")
        if not shutil.which("ffmpeg"):
            missing.append("ffmpeg")
        if missing:
            return {
                "available": False,
                "message": (
                    f"缺少依赖：{', '.join(missing)}。"
                    "请切换到 yolov8-gpu conda 环境后重启后端再使用 AI 抽帧"
                ),
            }
        return {"available": True, "version": version}

    @staticmethod
    def get_status(task_id: str) -> dict:
        with _tasks_lock:
            task = _tasks.get(task_id)
        if not task:
            return {"success": False, "message": "任务不存在"}
        return {
            "success": True,
            "state": task["state"],
            "processed": task.get("processed", 0),
            "saved": task.get("saved", 0),
            "total_frames": task.get("total_frames", 0),
            "split_progress": task.get("split_progress"),
            "result": task.get("result"),
        }

    @staticmethod
    def stop_extraction(task_id: str) -> dict:
        with _tasks_lock:
            task = _tasks.get(task_id)
        if not task:
            return {"success": False, "message": "任务不存在"}
        task["stop_event"].set()
        return {"success": True, "message": "已发送停止信号"}

    @staticmethod
    def start_extract_frames(
        video_path: str,
        output_dir: str,
        model_path: str = "",
        target_classes: list = None,
        conf_threshold: float = 0.25,
        interval_frames: int = 1,
        fmt: str = "jpg",
        quality: int = 95,
        prefix: str = "ai_frame",
        max_parallel: int = 2,
        batch_size: int = 8,
        segment_minutes: int = 0,
    ) -> dict:
        """启动 AI 抽帧后台任务，立即返回 task_id"""
        check = AIVideoService.check_available()
        if not check["available"]:
            return {"success": False, "message": check["message"]}

        model_path = model_path or DEFAULT_MODEL_PATH
        target_classes = target_classes or []

        if not os.path.isfile(video_path):
            return {"success": False, "message": f"视频文件不存在: {video_path}"}
        if not os.path.isfile(model_path):
            return {"success": False, "message": f"模型文件不存在: {model_path}"}
        if not output_dir:
            return {"success": False, "message": "请指定输出目录"}
        if not target_classes:
            return {"success": False, "message": "请至少指定一个目标类别（如 person）"}

        task_id = str(uuid.uuid4())
        stop_event = threading.Event()
        task = {
            "task_id": task_id,
            "stop_event": stop_event,
            "state": "loading",
            "processed": 0,
            "saved": 0,
            "total_frames": 0,
            "split_progress": None,
            "result": None,
        }
        with _tasks_lock:
            _tasks[task_id] = task

        def _run():
            if segment_minutes > 0:
                AIVideoService._worker_segment(
                    task, video_path, output_dir, model_path,
                    target_classes, conf_threshold, interval_frames,
                    fmt, quality, prefix,
                    max_parallel=max_parallel, batch_size=batch_size,
                    segment_minutes=segment_minutes,
                )
            else:
                AIVideoService._worker_pipeline(
                    task, video_path, output_dir, model_path,
                    target_classes, conf_threshold, interval_frames,
                    fmt, quality, prefix,
                    batch_size=batch_size,
                )

        threading.Thread(target=_run, daemon=True).start()
        return {"success": True, "task_id": task_id}

    @staticmethod
    def _worker_segment(
        task: dict,
        video_path: str,
        output_dir: str,
        model_path: str,
        target_classes: list,
        conf_threshold: float,
        interval_frames: int,
        fmt: str,
        quality: int,
        prefix: str,
        max_parallel: int,
        batch_size: int,
        segment_minutes: int,
    ) -> None:
        stop_event: threading.Event = task["stop_event"]

        probe = cv2.VideoCapture(video_path)
        if not probe.isOpened():
            task["state"] = "error"
            task["result"] = {"success": False, "message": "无法打开视频文件"}
            return
        fps = probe.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(probe.get(cv2.CAP_PROP_FRAME_COUNT))
        probe.release()
        task["total_frames"] = total_frames

        segment_seconds = segment_minutes * 60
        segment_frames = int(round(fps * segment_seconds))
        target_classes_list = target_classes
        target_set = {c.strip().lower() for c in target_classes_list if c.strip()}
        total_seconds = total_frames / fps if fps > 0 else 0

        temp_dir = tempfile.mkdtemp(prefix="easy_ai_split_")
        try:
            os.makedirs(output_dir, exist_ok=True)

            task["state"] = "splitting"
            seg_files = []
            use_ffmpeg = shutil.which("ffmpeg") is not None
            if use_ffmpeg:
                try:
                    seg_files = _ffmpeg_split(video_path, temp_dir, segment_seconds,
                                              stop_event, task=task,
                                              total_seconds=total_seconds)
                except Exception:
                    use_ffmpeg = False
            if not use_ffmpeg:
                seg_files = _opencv_split(video_path, temp_dir, segment_frames, task, stop_event)

            if stop_event.is_set() or not seg_files:
                task["state"] = "stopped"
                task["result"] = {"success": True, "stopped": True,
                                  "message": "已中止", "saved_count": 0}
                return

            task["state"] = "running"
            task["split_progress"] = None

            counters = {"processed": [0], "saved": [0], "lock": threading.Lock()}
            seg_offsets = [i * segment_frames for i in range(len(seg_files))]

            # 监控线程：实时把 counters 同步到 task，让前端轮询能看到进度
            monitor_stop = threading.Event()
            def _monitor():
                import time
                while not monitor_stop.is_set():
                    with counters["lock"]:
                        task["saved"] = counters["saved"][0]
                        task["processed"] = counters["processed"][0]
                    time.sleep(0.5)
            monitor_thread = threading.Thread(target=_monitor, daemon=True)
            monitor_thread.start()

            # 用 ThreadPoolExecutor 控制并发：max_parallel 个 worker，
            # 每个 worker 独立加载模型+推理，线程池自动排队，不阻塞主线程
            from concurrent.futures import ThreadPoolExecutor, as_completed
            futures = []
            with ThreadPoolExecutor(max_workers=max_parallel) as pool:
                for idx, seg_path in enumerate(seg_files):
                    if stop_event.is_set():
                        break
                    fut = pool.submit(
                        _infer_segment_simple,
                        seg_path, model_path, target_set, conf_threshold,
                        interval_frames, batch_size, fmt, quality, prefix,
                        output_dir, seg_offsets[idx],
                        counters, stop_event,
                    )
                    futures.append(fut)
                # 等待全部完成（或 stop）
                for fut in as_completed(futures):
                    try:
                        fut.result()
                    except Exception as e:
                        print(f"[ai_video] segment future error: {e}")

            monitor_stop.set()
            monitor_thread.join(timeout=2)

            with counters["lock"]:
                task["saved"] = counters["saved"][0]
                task["processed"] = counters["processed"][0]

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        duration = round(total_frames / fps, 2)
        stopped = stop_event.is_set()
        saved = task["saved"]
        processed = task["processed"]
        task["state"] = "stopped" if stopped else "done"
        task["result"] = {
            "success": True,
            "stopped": stopped,
            "message": (
                f"AI 抽帧已中止：已扫描 {processed} 帧，共保留 {saved} 张含目标的图片"
                if stopped else
                f"AI 抽帧完成（分段模式）：扫描 {processed} 帧（{duration}s），"
                f"检测到含 {'/'.join(target_classes_list)} 的帧共 {saved} 张，已保存至 {output_dir}"
            ),
            "saved_count": saved,
            "processed": processed,
            "total_frames": total_frames,
            "fps": round(fps, 3),
            "duration": duration,
            "output_dir": output_dir,
        }

    @staticmethod
    def _worker_pipeline(
        task: dict,
        video_path: str,
        output_dir: str,
        model_path: str,
        target_classes: list,
        conf_threshold: float,
        interval_frames: int,
        fmt: str,
        quality: int,
        prefix: str,
        batch_size: int = 8,
    ) -> None:
        """单路顺序读帧 -> 有界队列 -> 单 GPU 批量推理。"""
        import queue as _queue

        stop_event: threading.Event = task["stop_event"]
        interval_frames = max(1, int(interval_frames))
        batch_size = max(1, min(int(batch_size), 32))
        target_set = {c.strip().lower() for c in target_classes if c.strip()}
        ext = fmt.lower().lstrip(".")
        if ext not in ("jpg", "jpeg", "png", "bmp"):
            ext = "jpg"
        write_params = (
            [cv2.IMWRITE_JPEG_QUALITY, max(1, min(100, int(quality)))]
            if ext in ("jpg", "jpeg") else []
        )

        try:
            model = _load_model_fresh(model_path)
        except Exception as e:
            task["state"] = "error"
            task["result"] = {"success": False, "message": f"模型加载失败: {e}"}
            return

        probe = cv2.VideoCapture(video_path)
        if not probe.isOpened():
            task["state"] = "error"
            task["result"] = {"success": False, "message": "无法打开视频文件"}
            return
        fps = probe.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(probe.get(cv2.CAP_PROP_FRAME_COUNT))
        probe.release()
        task["total_frames"] = total_frames
        task["state"] = "running"

        try:
            os.makedirs(output_dir, exist_ok=True)

            SENTINEL = object()
            frame_queue: _queue.Queue = _queue.Queue(maxsize=batch_size * 4)

            def reader() -> None:
                cap = cv2.VideoCapture(video_path)
                fi = 0
                try:
                    while True:
                        if stop_event.is_set():
                            break
                        if fi % interval_frames == 0:
                            ret, frame = cap.read()
                            if not ret:
                                break
                            frame_queue.put((fi, frame))
                        else:
                            if not cap.grab():
                                break
                        fi += 1
                finally:
                    cap.release()
                    frame_queue.put(SENTINEL)

            reader_thread = threading.Thread(target=reader, daemon=True)
            reader_thread.start()

            saved = 0
            processed = 0
            batch_frames: list = []
            batch_fis: list = []

            def flush_batch() -> None:
                nonlocal saved
                if not batch_frames:
                    return
                results = model(batch_frames, verbose=False, conf=conf_threshold)
                for i, r in enumerate(results):
                    hit = False
                    if r.boxes is not None and len(r.boxes):
                        for cls_id in r.boxes.cls.tolist():
                            if model.names.get(int(cls_id), "").lower() in target_set:
                                hit = True
                                break
                    if hit:
                        fname = f"{prefix}_{batch_fis[i]:08d}.{ext}"
                        imwrite_unicode(os.path.join(output_dir, fname), batch_frames[i], write_params)
                        saved += 1
                        task["saved"] = saved
                batch_frames.clear()
                batch_fis.clear()

            while True:
                if stop_event.is_set():
                    flush_batch()
                    break
                try:
                    item = frame_queue.get(timeout=2.0)
                except _queue.Empty:
                    continue
                if item is SENTINEL:
                    flush_batch()
                    break
                fi, frame = item
                batch_frames.append(frame)
                batch_fis.append(fi)
                processed += 1
                task["processed"] = processed
                if len(batch_frames) >= batch_size:
                    flush_batch()

            reader_thread.join()

            duration = round(total_frames / fps, 2)
            stopped = stop_event.is_set()
            task["state"] = "stopped" if stopped else "done"
            task["result"] = {
                "success": True,
                "stopped": stopped,
                "message": (
                    f"AI 抽帧已中止：已扫描 {processed} 帧，共保留 {saved} 张含目标的图片，已保存至 {output_dir}"
                    if stopped else
                    f"AI 抽帧完成：扫描 {processed} 帧（{duration}s），"
                    f"检测到含 {'/'.join(target_classes)} 的帧共 {saved} 张，已保存至 {output_dir}"
                ),
                "saved_count": saved,
                "processed": processed,
                "total_frames": total_frames,
                "fps": round(fps, 3),
                "duration": duration,
                "output_dir": output_dir,
            }
        except Exception as e:
            task["state"] = "error"
            task["result"] = {"success": False, "message": str(e)}
