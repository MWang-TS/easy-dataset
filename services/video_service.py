"""
services/video_service.py
视频处理：读取视频信息 + 按帧间隔抽帧（后台线程，支持随时停止）
"""
import os
import uuid
import threading
import cv2

from services.image_io import imwrite_unicode

# 任务状态字典，key=task_id
# state: "running" | "stopped" | "done" | "error"
_tasks: dict = {}
_tasks_lock = threading.Lock()


class VideoService:

    @staticmethod
    def get_info(video_path: str) -> dict:
        """读取视频基本元信息（分辨率、帧率、总帧数、时长）"""
        if not os.path.isfile(video_path):
            return {"success": False, "message": f"文件不存在: {video_path}"}
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"success": False, "message": "无法打开视频文件，请确认格式受支持（mp4/avi/mov/mkv 等）"}
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
        duration = round(total_frames / fps, 2) if fps > 0 else 0
        return {
            "success": True,
            "fps": round(fps, 3),
            "total_frames": total_frames,
            "width": width,
            "height": height,
            "duration": duration,
        }

    @staticmethod
    def stop_extraction(task_id: str) -> dict:
        """发出停止信号，中止指定抽帧任务"""
        with _tasks_lock:
            task = _tasks.get(task_id)
        if not task:
            return {"success": False, "message": "任务不存在"}
        task["stop_event"].set()
        return {"success": True, "message": "已发送停止信号"}

    @staticmethod
    def get_status(task_id: str) -> dict:
        """查询任务状态"""
        with _tasks_lock:
            task = _tasks.get(task_id)
        if not task:
            return {"success": False, "message": "任务不存在"}
        return {
            "success": True,
            "state": task["state"],
            "saved": task["saved"],
            "total_frames": task["total_frames"],
            "result": task.get("result"),
        }

    @staticmethod
    def start_extract_frames(
        video_path: str,
        output_dir: str,
        interval_frames: int = 30,
        fmt: str = "jpg",
        quality: int = 95,
        prefix: str = "frame",
        num_workers: int = 1,
    ) -> dict:
        """在后台线程启动抽帧任务，立即返回 task_id"""
        if not os.path.isfile(video_path):
            return {"success": False, "message": f"文件不存在: {video_path}"}
        if not output_dir:
            return {"success": False, "message": "请指定输出目录"}

        task_id = str(uuid.uuid4())
        stop_event = threading.Event()
        task = {
            "task_id": task_id,
            "stop_event": stop_event,
            "state": "running",
            "saved": 0,
            "total_frames": 0,
            "result": None,
        }
        with _tasks_lock:
            _tasks[task_id] = task

        def _run():
            VideoService._extract_frames_worker(
                task, video_path, output_dir, interval_frames, fmt, quality, prefix,
                num_workers=num_workers,
            )

        threading.Thread(target=_run, daemon=True).start()
        return {"success": True, "task_id": task_id}

    @staticmethod
    def _extract_frames_worker(
        task: dict,
        video_path: str,
        output_dir: str,
        interval_frames: int,
        fmt: str,
        quality: int,
        prefix: str,
        num_workers: int = 1,
    ) -> None:
        """后台线程：多线程分段抽帧"""
        from concurrent.futures import ThreadPoolExecutor

        stop_event: threading.Event = task["stop_event"]
        interval_frames = max(1, int(interval_frames))
        num_workers = max(1, min(int(num_workers), 16))
        ext = fmt.lower().lstrip(".")
        if ext not in ("jpg", "jpeg", "png", "bmp"):
            ext = "jpg"
        write_params = (
            [cv2.IMWRITE_JPEG_QUALITY, max(1, min(100, int(quality)))]
            if ext in ("jpg", "jpeg") else []
        )

        # 先探一次获取总帧数
        probe = cv2.VideoCapture(video_path)
        if not probe.isOpened():
            task["state"] = "error"
            task["result"] = {"success": False, "message": "无法打开视频文件"}
            return
        fps = probe.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(probe.get(cv2.CAP_PROP_FRAME_COUNT))
        probe.release()
        task["total_frames"] = total_frames

        try:
            os.makedirs(output_dir, exist_ok=True)

            saved_count = [0]
            count_lock = threading.Lock()

            # 把视频切成 num_workers 段
            seg_size = max(interval_frames, (total_frames + num_workers - 1) // num_workers)
            segments = []
            s = 0
            while s < total_frames:
                segments.append((s, min(s + seg_size, total_frames)))
                s += seg_size

            def process_segment(seg_start: int, seg_end: int) -> None:
                cap = cv2.VideoCapture(video_path)
                if not cap.isOpened():
                    return
                cap.set(cv2.CAP_PROP_POS_FRAMES, seg_start)
                fi = seg_start
                try:
                    while fi < seg_end:
                        if stop_event.is_set():
                            return
                        ret, frame = cap.read()
                        if not ret:
                            break
                        if fi % interval_frames == 0:
                            # 用全局帧号命名，文件天然有序
                            fname = f"{prefix}_{fi:08d}.{ext}"
                            ok = imwrite_unicode(os.path.join(output_dir, fname), frame, write_params)
                            if not ok:
                                print(f"[video] imwrite failed: {os.path.join(output_dir, fname)}")
                            with count_lock:
                                saved_count[0] += 1
                                task["saved"] = saved_count[0]
                        fi += 1
                finally:
                    cap.release()

            with ThreadPoolExecutor(max_workers=min(num_workers, len(segments))) as pool:
                futures = [pool.submit(process_segment, s, e) for s, e in segments]
                for fut in futures:
                    fut.result()  # 传播异常

            duration = round(total_frames / fps, 2)
            stopped = stop_event.is_set()
            saved = saved_count[0]
            task["state"] = "stopped" if stopped else "done"
            task["result"] = {
                "success": True,
                "stopped": stopped,
                "message": (
                    f"抽帧已中止：已抽取 {saved} 张图片，已保存至 {output_dir}"
                    if stopped else
                    f"抽帧完成：从 {total_frames} 帧（{duration}s）中"
                    f"按每 {interval_frames} 帧间隔共抽取了 {saved} 张图片，已保存至 {output_dir}"
                ),
                "saved_count": saved,
                "total_frames": total_frames,
                "fps": round(fps, 3),
                "duration": duration,
                "output_dir": output_dir,
            }
        except Exception as e:
            task["state"] = "error"
            task["result"] = {"success": False, "message": str(e)}

    # 保留旧方法名兼容，内部改为同步调用（仅供迁移过渡）
    @staticmethod
    def extract_frames(
        video_path: str,
        output_dir: str,
        interval_frames: int = 30,
        fmt: str = "jpg",
        quality: int = 95,
        prefix: str = "frame",
    ) -> dict:
        """已废弃：请使用 start_extract_frames + get_status 异步接口"""
        import warnings
        warnings.warn("extract_frames is deprecated, use start_extract_frames", DeprecationWarning)
        return {"success": False, "message": "请使用异步接口"}
