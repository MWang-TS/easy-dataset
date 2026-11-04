"""
services/model_utils.py
模型文件相关的通用校验。

本项目不限定 YOLOv8：AI 自动标注 / AI 智能抽帧都通过 `ultralytics.YOLO(...)` 加载，
因此凡 ultralytics 支持的权重与导出格式都可以用：
  YOLOv5 / v8 / v9 / v10 / v11 / v12、RT-DETR 等
  以及 .pt / .onnx / .engine(TensorRT) / .torchscript / .tflite / .mlpackage / OpenVINO 目录 等
"""
import os

# ultralytics 支持的模型文件后缀（.dir 形式表示导出目录，用 os.path.isdir 判断）
MODEL_FILE_EXTS = (
    '.pt', '.pth', '.onnx', '.engine', '.torchscript',
    '.tflite', '.mlmodel', '.mlpackage', '.pdmodel', '.pdparams', '.param',
    '.rknn', '.h5', '.saved_model', '.xml',
)

# 可产生「目标框」的任务：检测 / 分割 / 旋转框 / 姿态
SUPPORTED_TASKS = ('detect', 'segment', 'obb', 'pose')


def check_model_file(path: str) -> str:
    """校验模型路径，返回错误信息（空字符串表示 OK）。"""
    if not path:
        return '未指定模型文件'
    if not os.path.exists(path):
        return f'模型文件不存在: {path}'
    if os.path.isdir(path):
        # OpenVINO / SavedModel 等导出目录
        return ''
    ext = os.path.splitext(path)[1].lower()
    if ext not in MODEL_FILE_EXTS:
        return (f'不支持的模型格式 “{ext or "无后缀"}”。'
                '支持 ultralytics 权重与导出格式：.pt / .onnx / .engine / .torchscript / '
                '.tflite / .mlpackage / OpenVINO 目录 等（可覆盖 YOLOv5~v12、RT-DETR）')
    return ''


def unsupported_task_message(task: str) -> str:
    """任务类型不受支持时返回提示（空字符串表示支持）。"""
    name = (task or '').lower()
    if name and name not in SUPPORTED_TASKS:
        return (f'当前模型任务为 “{task}”，只能用于分类/其他非框任务，'
                f'请换用检测(detect)/分割(segment)/旋转框(obb)/姿态(pose)模型')
    return ''
