"""
# services/annotation_service.py

## 核心功能
YOLO 图片标注服务。宿主层从 Tauri IPC 改为 Flask REST，算法与数据契约保持不变：

  1. 列出数据集目录图片（自动探测 `images/` + `labels/` 结构，兼容扁平结构）
  2. 读取 / 写入 YOLO 标注（矩形 5 列、多边形 seg 行，坐标全部归一化 0~1）
  3. 扫描已有 class_id、解析 classes.txt / data.yaml 的 names 字段
  4. AI 自动预标注（ultralytics，后台线程 + 轮询进度，可中途停止）
  5. 导出数据集（raw / detect / segment，含 classes.txt、data.yaml、train/val 划分）

## 标注路径推导规则（与前端 store 必须保持一致）
  - 指定 `label_output_dir`：`<output>/<图片同名>.txt`
  - 图片父目录名为 `images`：`<父目录>/../labels/<stem>.txt`
  - 其余（扁平结构）：与图片同目录 `<stem>.txt`
"""
import os
import io
import base64
import random
import threading
import time
import uuid
import json
import shutil
import datetime
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional

import yaml
from PIL import Image

from services.model_utils import check_model_file, unsupported_task_message
from services.label_format import is_rect_quad

_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL_PATH = os.path.join(_BASE_DIR, 'models', 'yolov8m.pt')

# 自动标注任务表，key = task_id
_tasks: Dict[str, dict] = {}
_tasks_lock = threading.Lock()
_TASK_TTL_SECONDS = 3600


# ────────────────── 通用工具 ──────────────────

def _norm(value: str) -> str:
    """去除首尾空白与可能被粘上的引号（用户手输路径常见）。"""
    if not value:
        return ''
    return str(value).strip().strip('"').strip("'")


def _is_image(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in _IMAGE_EXTS


def resolve_image_root(dir_path: str):
    """返回 (图片根目录, layout)，layout 为 'images' / 'split' / 'flat'。

    兼容三种常见布局：
      dataset/images/*.jpg            → images
      dataset/images/train/*.jpg      → split（多个子集，全部展开）
      dataset/*.jpg                   → flat
    """
    roots = resolve_image_roots(dir_path)
    if not roots:
        return _norm(dir_path), 'flat'
    root = roots[0]
    if len(roots) > 1:
        return root, 'split'
    if os.path.basename(os.path.normpath(root)).lower() == 'images' or \
            os.path.basename(os.path.dirname(os.path.normpath(root))).lower() == 'images':
        return root, 'images'
    return root, 'flat'


def resolve_image_roots(dir_path: str):
    """返回实际存放图片的目录列表。`images/` 下若只有 train/val 子目录，则展开全部子目录。"""
    root = _norm(dir_path)
    if not os.path.isdir(root):
        return []

    def _has_image(directory):
        try:
            return any(_is_image(n) and os.path.isfile(os.path.join(directory, n))
                       for n in os.listdir(directory))
        except OSError:
            return False

    sub = os.path.join(root, 'images')
    if os.path.isdir(sub):
        if _has_image(sub):
            return [sub]
        try:
            children = sorted(n for n in os.listdir(sub) if os.path.isdir(os.path.join(sub, n)))
        except OSError:
            children = []
        nested = [os.path.join(sub, child) for child in children
                  if _has_image(os.path.join(sub, child))]
        return nested or [sub]

    if _has_image(root):
        return [root]

    # 传入的就是上级目录（如 dataset/images 的父级）但图片在 train/val 里
    try:
        children = sorted(n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)))
    except OSError:
        children = []
    nested = [os.path.join(root, child) for child in children
              if _has_image(os.path.join(root, child))]
    return nested or [root]


def label_path_for(image_path: str, label_output_dir: str = '') -> str:
    """图片 → 标注文件路径（写入用，路径不存在也会返回）。

    规则：把路径中最后一个 `images` 目录段换成 `labels`，文件名换成 `.txt`。
    因此 `dataset/images/train/a.jpg` → `dataset/labels/train/a.txt`，
    `dataset/images/a.jpg` → `dataset/labels/a.txt`，扁平结构同目录。
    """
    image_path = _norm(image_path)
    out_dir = _norm(label_output_dir)
    stem = os.path.splitext(os.path.basename(image_path))[0]
    if out_dir:
        return os.path.join(out_dir, stem + '.txt')

    parts = os.path.normpath(image_path).split(os.sep)
    for index in range(len(parts) - 1, -1, -1):
        if parts[index].lower() == 'images':
            parts[index] = 'labels'
            parts[-1] = stem + '.txt'
            return os.sep.join(parts)
    parts[-1] = stem + '.txt'
    return os.sep.join(parts)


def resolve_label_path(image_path: str, label_output_dir: str = '', label_dir: str = '') -> str:
    """图片 → 标注文件路径（读取用）。

    优先级：label_output_dir（另存目录） > label_dir（手动指定的标注目录） > 路径推断。
    找不到时回退到图片同目录的同名 .txt。
    """
    out_dir = _norm(label_output_dir)
    manual_dir = _norm(label_dir)
    if out_dir or manual_dir:
        stem = os.path.splitext(os.path.basename(_norm(image_path)))[0]
        candidate = os.path.join(out_dir or manual_dir, stem + '.txt')
    else:
        candidate = label_path_for(image_path, '')
    if os.path.isfile(candidate):
        return candidate
    sibling = os.path.splitext(_norm(image_path))[0] + '.txt'
    if os.path.isfile(sibling):
        return sibling
    return candidate


def _list_image_paths(dir_path: str, image_dir: str = '') -> List[str]:
    """列出图片：指定 image_dir 时只扫该目录（不展开子目录），否则按目录结构自动推断。"""
    manual = _norm(image_dir)
    roots = [manual] if manual else resolve_image_roots(dir_path)
    paths: List[str] = []
    for img_root in roots:
        if not os.path.isdir(img_root):
            continue
        try:
            names = sorted(n for n in os.listdir(img_root)
                           if _is_image(n) and os.path.isfile(os.path.join(img_root, n)))
        except OSError:
            continue
        paths.extend(os.path.join(img_root, n) for n in names)
    return paths


def _count_label_lines(label_path: str) -> int:
    try:
        with open(label_path, 'r', encoding='utf-8', errors='replace') as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return 0


def _scan_label_file(label_path: str):
    """返回 (框数, 矩形式行数, 多边形行数, 真正的旋转矩形行数)。

    只有「4 个点且构成矩形」的行才算 OBB，避免把恰好 4 个点的分割多边形误判为旋转框。
    """
    boxes = rect = polygon = quad = 0
    try:
        with open(label_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                parts = line.split()
                if len(parts) < 5:
                    continue
                boxes += 1
                if len(parts) >= 7 and (len(parts) - 1) % 2 == 0:
                    try:
                        coords = [float(p) for p in parts[1:]]
                    except ValueError:
                        rect += 1
                        continue
                    polygon += 1
                    if len(coords) == 8:
                        points = [[coords[i], coords[i + 1]] for i in range(0, 8, 2)]
                        if is_rect_quad(points):
                            quad += 1
                    continue
                rect += 1
    except OSError:
        return 0, 0, 0, 0
    return boxes, rect, polygon, quad


def _label_type_name(rect_lines: int, polygon_lines: int, quad_lines: int = 0) -> str:
    """detect / obb / segment / mixed / none。

    全部多边形都是 4 点 → 视为旋转框（OBB）；否则算分割。
    """
    if rect_lines > 0 and polygon_lines > 0:
        return 'mixed'
    if polygon_lines > 0:
        return 'obb' if quad_lines == polygon_lines else 'segment'
    if rect_lines > 0:
        return 'detect'
    return 'none'


# ────────────────── 标注读写 ──────────────────

def _fmt(value: float) -> str:
    return f'{max(0.0, min(1.0, float(value))):.6f}'


def parse_label_content(content: str) -> List[Dict]:
    """解析 YOLO 文本内容为 box 列表。矩形 5 段；多边形 `(n-1)` 为偶数且 >= 6。"""
    boxes: List[Dict] = []
    for line in content.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            class_id = int(float(parts[0]))
        except (TypeError, ValueError):
            continue

        # 多边形行：class + 至少 6 个坐标（3 个顶点）
        if len(parts) >= 7 and (len(parts) - 1) % 2 == 0:
            try:
                coords = [float(p) for p in parts[1:]]
            except ValueError:
                coords = []
            if len(coords) == len(parts) - 1 and all(-0.01 <= c <= 1.01 for c in coords):
                polygon = [[coords[i], coords[i + 1]] for i in range(0, len(coords), 2)]
                xs = [p[0] for p in polygon]
                ys = [p[1] for p in polygon]
                boxes.append({
                    'class_id': class_id,
                    'cx': (min(xs) + max(xs)) / 2,
                    'cy': (min(ys) + max(ys)) / 2,
                    'w': max(xs) - min(xs),
                    'h': max(ys) - min(ys),
                    'polygon': polygon,
                })
                continue

        try:
            cx, cy, w, h = (float(parts[1]), float(parts[2]),
                            float(parts[3]), float(parts[4]))
        except ValueError:
            continue
        if not all(-0.05 <= v <= 1.05 for v in (cx, cy, w, h)):
            continue
        boxes.append({
            'class_id': class_id,
            'cx': cx, 'cy': cy, 'w': w, 'h': h,
            'polygon': None,
        })
    return boxes


def format_label_boxes(boxes: List[Dict], export_mode: str = 'raw') -> str:
    """box 列表 → 标注文本。export_mode: raw / detect / segment。"""
    lines: List[str] = []
    for box in boxes:
        class_id = int(box.get('class_id', 0))
        polygon = box.get('polygon')
        if export_mode == 'detect':
            lines.append(
                f"{class_id} {_fmt(box.get('cx', 0))} {_fmt(box.get('cy', 0))} "
                f"{_fmt(box.get('w', 0))} {_fmt(box.get('h', 0))}"
            )
            continue
        if export_mode == 'segment' and (not polygon or len(polygon) < 3):
            # 矩形框退化成 4 角点，保证 segment 数据集不丢样本
            cx, cy = float(box.get('cx', 0)), float(box.get('cy', 0))
            w, h = float(box.get('w', 0)), float(box.get('h', 0))
            polygon = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
                       [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]
        if polygon and len(polygon) >= 3:
            coords: List[str] = []
            for point in polygon:
                coords.append(_fmt(point[0]))
                coords.append(_fmt(point[1]))
            lines.append(f"{class_id} " + ' '.join(coords))
            continue
        lines.append(
            f"{class_id} {_fmt(box.get('cx', 0))} {_fmt(box.get('cy', 0))} "
            f"{_fmt(box.get('w', 0))} {_fmt(box.get('h', 0))}"
        )
    return '\n'.join(lines) + ('\n' if lines else '')


class AnnotationService:

    # ── 目录与标注文件 ──

    @staticmethod
    def list_images(dir_path: str, label_output_dir: str = '',
                    image_dir: str = '', label_dir: str = '') -> Dict:
        """列出目录内图片，附带对应标注文件状态（存在 / 空 / 框数）。

        image_dir / label_dir 用于结构不规整的数据集（如 `temp/img` + `temp/annotations`），
        指定后不再按 `images` / `labels` 命名推断。
        """
        root = _norm(dir_path)
        manual_image_dir = _norm(image_dir)
        if manual_image_dir:
            if not os.path.isdir(manual_image_dir):
                return {'success': False, 'message': f'图像目录不存在: {manual_image_dir}'}
        elif not root:
            return {'success': False, 'message': '请先选择标注文件夹'}
        elif not os.path.isdir(root):
            return {'success': False, 'message': f'目录不存在: {root}'}
        if _norm(label_dir) and not os.path.isdir(_norm(label_dir)):
            return {'success': False, 'message': f'标注目录不存在: {_norm(label_dir)}'}

        img_root, layout = (manual_image_dir, 'manual') if manual_image_dir else resolve_image_root(root)
        images: List[Dict] = []
        rect_lines = polygon_lines = quad_lines = sampled = 0
        sample_limit = 500
        for image_path in _list_image_paths(root, manual_image_dir):
            label_path = resolve_label_path(image_path, label_output_dir, label_dir)
            exists = os.path.isfile(label_path)
            size = os.path.getsize(label_path) if exists else 0
            box_count = 0
            if size > 0:
                box_count, rect, polygon, quad = _scan_label_file(label_path)
                if sampled < sample_limit:
                    rect_lines += rect
                    polygon_lines += polygon
                    quad_lines += quad
                    sampled += 1
            images.append({
                'path': image_path.replace('\\', '/'),
                'name': os.path.basename(image_path),
                'label_path': label_path.replace('\\', '/'),
                'has_label': exists,
                'empty_label': exists and size == 0,
                'box_count': box_count,
            })

        return {
            'success': True,
            'images': images,
            'total': len(images),
            'image_root': img_root.replace('\\', '/'),
            'layout': layout,
            'labeled': sum(1 for i in images if i['box_count'] > 0),
            'unlabeled': sum(1 for i in images if i['box_count'] == 0),
            'label_type': _label_type_name(rect_lines, polygon_lines, quad_lines),
            'rect_lines': rect_lines,
            'polygon_lines': polygon_lines,
            'quad_lines': quad_lines,
        }

    @staticmethod
    def read_label(label_path: str) -> Dict:
        """读取标注文件。文件不存在返回空数组（与空文件同义）。"""
        path = _norm(label_path)
        if not path:
            return {'success': False, 'message': '缺少标注文件路径'}
        if not os.path.isfile(path):
            return {'success': True, 'exists': False, 'label_path': path, 'boxes': []}
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except OSError as e:
            return {'success': False, 'message': f'读取标注文件失败: {e}'}
        return {
            'success': True,
            'exists': True,
            'label_path': path,
            'empty': not content.strip(),
            'boxes': parse_label_content(content),
        }

    @staticmethod
    def read_image(image_path: str, max_dim: int = 2560) -> Dict:
        """读取图片并返回 base64 data URL（不做 EXIF 旋转，与训练侧 cv2 读取保持一致）。"""
        path = _norm(image_path)
        if not os.path.isfile(path):
            return {'success': False, 'message': f'图片不存在: {path}'}
        try:
            with Image.open(path) as img:
                orig_w, orig_h = img.size
                rgb = img.convert('RGB')
                width, height = rgb.size
                if max_dim and max(width, height) > max_dim:
                    ratio = max_dim / max(width, height)
                    width, height = max(1, int(width * ratio)), max(1, int(height * ratio))
                    rgb = rgb.resize((width, height), Image.LANCZOS)
                buf = io.BytesIO()
                rgb.save(buf, format='JPEG', quality=92)
        except Exception as e:  # noqa: BLE001 - 任何解码失败都转成业务错误
            return {'success': False, 'message': f'读取图片失败: {e}'}

        b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        return {
            'success': True,
            'data_url': f'data:image/jpeg;base64,{b64}',
            'width': width,
            'height': height,
            'orig_width': orig_w,
            'orig_height': orig_h,
            'scaled': (width, height) != (orig_w, orig_h),
        }

    @staticmethod
    def write_label(label_path: str, boxes: List[Dict]) -> Dict:
        """覆盖写入标注文件（原子替换）。空列表 → 空文件（表示该图确认无目标）。"""
        path = _norm(label_path)
        if not path:
            return {'success': False, 'message': '缺少标注文件路径'}
        try:
            os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
            content = format_label_boxes(boxes or [], 'raw')
            tmp_path = path + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8', newline='\n') as f:
                f.write(content)
            os.replace(tmp_path, path)
        except OSError as e:
            return {'success': False, 'message': f'写入标注文件失败: {e}'}
        return {'success': True, 'label_path': path, 'count': len(boxes or [])}

    # ── 类别 ──

    @staticmethod
    def scan_class_ids(dir_path: str, label_output_dir: str = '',
                       image_dir: str = '', label_dir: str = '') -> Dict:
        """扫描目录内已有标注出现过的 class_id（无类别定义时的兜底显示）。"""
        ids = set()
        for image_path in _list_image_paths(dir_path, image_dir):
            label_path = resolve_label_path(image_path, label_output_dir, label_dir)
            try:
                with open(label_path, 'r', encoding='utf-8', errors='replace') as f:
                    for line in f:
                        parts = line.split()
                        if not parts:
                            continue
                        try:
                            ids.add(int(float(parts[0])))
                        except ValueError:
                            continue
            except OSError:
                continue
        return {'success': True, 'class_ids': sorted(ids)}

    @staticmethod
    def parse_class_file(class_file: str) -> Dict:
        """解析 classes.txt 或 data.yaml 的 names，返回 {'id': '名称'}。"""
        path = _norm(class_file)
        if not path or not os.path.isfile(path):
            return {'success': False, 'message': f'文件不存在: {path}'}
        try:
            with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
                content = f.read()
        except OSError as e:
            return {'success': False, 'message': f'读取文件失败: {e}'}

        if path.lower().endswith('.txt'):
            names = [line.strip() for line in content.splitlines() if line.strip()]
            classes = {str(i): name for i, name in enumerate(names)}
        else:
            try:
                data = yaml.safe_load(content) or {}
            except yaml.YAMLError as e:
                return {'success': False, 'message': f'YAML 解析失败: {e}'}
            names = data.get('names') if isinstance(data, dict) else None
            if isinstance(names, list):
                classes = {str(i): str(n) for i, n in enumerate(names)}
            elif isinstance(names, dict):
                classes = {str(k): str(v) for k, v in names.items()}
            else:
                return {'success': False, 'message': '未在 YAML 中找到 names 字段'}

        ordered = {k: classes[k] for k in sorted(classes, key=lambda x: int(x) if str(x).isdigit() else 0)}
        return {'success': True, 'classes': ordered, 'count': len(ordered)}

    @staticmethod
    def write_classes(target_dir: str, class_names: Dict) -> Dict:
        """把类别名按 id 升序写入 target_dir/classes.txt（关闭工作 / 导出前落盘）。"""
        root = _norm(target_dir)
        if not root or not os.path.isdir(root):
            return {'success': False, 'message': f'目录不存在: {root}'}
        if not class_names:
            return {'success': False, 'message': '没有可写入的类别'}
        path = _write_classes_txt(root, class_names)
        if not path:
            return {'success': False, 'message': '写入 classes.txt 失败'}
        return {'success': True, 'class_file': path.replace('\\', '/'), 'count': len(class_names)}

    @staticmethod
    def detect_class_file(dir_path: str) -> Dict:
        """在目录及其上级目录里自动寻找类别定义文件并解析。

        用途：打开标注文件夹时若已存在 yaml / classes 文件，直接生效，无需手工选择。

        搜索优先级（每层目录内）：
          1. `classes.txt` / `class.txt` / `obj.names` / `classes.names`（含同级 `labels/` 子目录）
             —— 用户改名后的落盘位置，优先级高于 yaml，否则改名会被旧 yaml 覆盖
          2. `data.yaml` / `data.yml` / `dataset.yaml` / `dataset.yml`
          3. 其它 `*.yaml` / `*.yml`
        搜索层级：本目录 → 上级 → 上上级（覆盖 `images/train` 这类深层路径）。
        """
        root = _norm(dir_path)
        if not root or not os.path.isdir(root):
            return {'success': False, 'message': f'目录不存在: {root}'}

        yaml_names = ('data.yaml', 'data.yml', 'dataset.yaml', 'dataset.yml')
        txt_names = ('classes.txt', 'class.txt', 'obj.names', 'classes.names')

        candidates: List[str] = []
        current = os.path.abspath(root)
        for _ in range(3):
            # 1) classes.txt / names 文件（本目录 + labels 子目录）——用户改名落盘处，优先
            for base in (current, os.path.join(current, 'labels')):
                for name in txt_names:
                    path = os.path.join(base, name)
                    if os.path.isfile(path) and path not in candidates:
                        candidates.append(path)
            # 2) 标准 YAML
            for name in yaml_names:
                path = os.path.join(current, name)
                if os.path.isfile(path) and path not in candidates:
                    candidates.append(path)
            # 3) 其它 yaml
            try:
                for name in sorted(os.listdir(current)):
                    if name.lower().endswith(('.yaml', '.yml')):
                        path = os.path.join(current, name)
                        if os.path.isfile(path) and path not in candidates:
                            candidates.append(path)
            except OSError:
                pass
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent

        for path in candidates:
            result = AnnotationService.parse_class_file(path)
            if result.get('success') and result.get('classes'):
                return {
                    'success': True,
                    'class_file': path,
                    'classes': result['classes'],
                    'count': result.get('count', len(result['classes'])),
                }
        return {'success': False, 'message': '未找到 data.yaml / dataset.yaml / classes.txt'}

    # ── AI 自动预标注 ──

    @staticmethod
    def check_auto_label() -> Dict:
        """检查当前 Python 环境是否可做自动标注。"""
        info: Dict = {'available': False, 'default_model': DEFAULT_MODEL_PATH}
        try:
            import ultralytics  # noqa: PLC0415
            info['available'] = True
            info['version'] = getattr(ultralytics, '__version__', '')
        except Exception as e:  # noqa: BLE001
            info['message'] = f'当前环境缺少 ultralytics: {e}'
        info['model_exists'] = os.path.isfile(DEFAULT_MODEL_PATH)
        return info

    @staticmethod
    def start_auto_label(dir_path: str, model_path: str = '', conf: float = 0.25,
                         output_dir: str = '', overwrite: bool = False,
                         image_dir: str = '') -> Dict:
        """启动后台自动标注任务，立即返回 task_id。"""
        root = _norm(dir_path)
        manual_image_dir = _norm(image_dir)
        if manual_image_dir:
            if not os.path.isdir(manual_image_dir):
                return {'success': False, 'message': f'图像目录不存在: {manual_image_dir}'}
        elif not os.path.isdir(root):
            return {'success': False, 'message': f'目录不存在: {root}'}
        model = _norm(model_path) or DEFAULT_MODEL_PATH
        model_error = check_model_file(model)
        if model_error:
            return {'success': False, 'message': model_error}
        if not _list_image_paths(root, manual_image_dir):
            return {'success': False, 'message': '该目录下没有找到图片文件'}

        AnnotationService._gc_tasks()
        task_id = uuid.uuid4().hex
        task = {
            'state': 'running',
            'total': 0,
            'processed': 0,
            'labeled': 0,
            'skipped': 0,
            'current': '',
            'message': '正在加载模型…',
            'errors': [],
            'started': time.time(),
            'stop_event': threading.Event(),
        }
        with _tasks_lock:
            _tasks[task_id] = task

        threading.Thread(
            target=_auto_label_worker,
            args=(task, root, model, float(conf), _norm(output_dir), bool(overwrite), manual_image_dir),
            daemon=True,
        ).start()
        return {'success': True, 'task_id': task_id}

    @staticmethod
    def auto_label_status(task_id: str) -> Dict:
        with _tasks_lock:
            task = _tasks.get(task_id)
        if not task:
            return {'success': False, 'message': '任务不存在'}
        return {
            'success': True,
            'state': task['state'],
            'total': task['total'],
            'processed': task['processed'],
            'labeled': task['labeled'],
            'skipped': task['skipped'],
            'current': task['current'],
            'message': task['message'],
            'errors': task['errors'][-20:],
        }

    @staticmethod
    def stop_auto_label(task_id: str) -> Dict:
        with _tasks_lock:
            task = _tasks.get(task_id)
        if not task:
            return {'success': False, 'message': '任务不存在'}
        task['stop_event'].set()
        task['state'] = 'stopping'
        return {'success': True, 'message': '已发送停止信号'}

    @staticmethod
    def _gc_tasks():
        now = time.time()
        with _tasks_lock:
            stale = [k for k, v in _tasks.items()
                     if v['state'] in ('done', 'error', 'stopped')
                     and now - v['started'] > _TASK_TTL_SECONDS]
            for key in stale:
                _tasks.pop(key, None)

    # ── 导出 ──

    @staticmethod
    def export_dataset(source_dir: str, target_parent: str, export_mode: str = 'detect',
                       include_images: bool = True,
                       class_names: Optional[Dict] = None,
                       train_ratio: float = 0.8,
                       seed: int = 42,
                       label_output_dir: str = '',
                       image_dir: str = '',
                       label_dir: str = '',
                       export_format: str = 'yolo') -> Dict:
        """导出数据集。

        export_format:
          yolo    YOLO TXT（按 train/val 划分，附 classes.txt / data.yaml）
          coco    COCO JSON（annotations.json + images/）
          voc     Pascal VOC（Annotations/*.xml + JPEGImages/）
          labelme LabelMe（与图片同名的 *.json）

        export_mode（决定框的形状）：
          raw     原样导出（矩形/多边形保留）
          detect  全部转矩形
          segment 矩形转 4 点多边形
        """
        if export_mode not in ('raw', 'detect', 'segment'):
            return {'success': False, 'message': f'不支持的导出模式: {export_mode}'}
        if export_format not in ('yolo', 'coco', 'voc', 'labelme'):
            return {'success': False, 'message': f'不支持的导出格式: {export_format}'}
        source = _norm(source_dir)
        parent = _norm(target_parent)
        manual_image_dir = _norm(image_dir)
        if manual_image_dir:
            if not os.path.isdir(manual_image_dir):
                return {'success': False, 'message': f'图像目录不存在: {manual_image_dir}'}
        elif not os.path.isdir(source):
            return {'success': False, 'message': f'源目录不存在: {source}'}
        if not parent or not os.path.isdir(parent):
            return {'success': False, 'message': f'导出目录不存在: {parent}'}

        # 导出前：把改过的类别名写回数据集根目录（标注输出路径的上一级）下的 classes.txt，
        # 便于下次打开时直接复用，不依赖导出产物。
        classes_file = ''
        if class_names:
            class_root = ''
            if label_output_dir:
                class_root = os.path.dirname(_norm(label_output_dir))
            elif label_dir:
                class_root = os.path.dirname(_norm(label_dir))
            elif source:
                class_root = source
            if class_root and os.path.isdir(class_root):
                classes_file = _write_classes_txt(class_root, class_names) or ''

        images = _list_image_paths(source, manual_image_dir)
        if not images:
            return {'success': False, 'message': '源目录下没有图片，无法导出'}

        # 非 YOLO 格式：单目录导出（不做 train/val 划分）
        if export_format != 'yolo':
            return _export_by_format(
                export_format=export_format,
                images=images,
                label_output_dir=label_output_dir,
                label_dir=label_dir,
                parent=parent,
                base_source=manual_image_dir or source,
                class_names=class_names or {},
                export_mode=export_mode,
                include_images=include_images,
                classes_file=classes_file,
            )

        suffix = {'detect': 'yolo_detect_dataset',
                  'segment': 'yolo_segment_dataset'}.get(export_mode, 'yolo_labels')
        base_source = manual_image_dir or source
        base_name = os.path.basename(base_source.rstrip('\\/')) or 'annotations'
        output = _unique_export_dir(parent, f'{base_name}_{suffix}')
        try:
            os.makedirs(output, exist_ok=True)
            is_dataset = export_mode != 'raw'
            if is_dataset:
                for rel in ('images/train', 'images/val', 'labels/train', 'labels/val'):
                    os.makedirs(os.path.join(output, rel), exist_ok=True)
            else:
                os.makedirs(os.path.join(output, 'labels'), exist_ok=True)
        except OSError as e:
            return {'success': False, 'message': f'创建导出目录失败: {e}'}

        order = list(images)
        warnings: List[str] = []
        split_of: Dict[str, str] = {}
        if export_mode == 'raw':
            split_of = {path: '' for path in order}
        else:
            random.Random(seed).shuffle(order)
            ratio = max(0.0, min(1.0, float(train_ratio)))
            if len(order) <= 1:
                train_count = len(order)
                warnings.append('图片数量不足 2 张，val 集将为空')
            else:
                train_count = int(round(len(order) * ratio))
                train_count = max(1, min(len(order) - 1, train_count))
            for index, path in enumerate(order):
                split_of[path] = 'train' if index < train_count else 'val'

        discovered = set()
        image_count = 0
        label_count = 0
        for image_path in images:
            stem = os.path.splitext(os.path.basename(image_path))[0]
            label_path = resolve_label_path(image_path, label_output_dir, label_dir)
            boxes: List[Dict] = []
            if os.path.isfile(label_path):
                try:
                    with open(label_path, 'r', encoding='utf-8', errors='replace') as f:
                        boxes = parse_label_content(f.read())
                except OSError:
                    boxes = []
            discovered.update(int(b['class_id']) for b in boxes)
            if boxes:
                label_count += 1

            split = split_of.get(image_path, '')
            out_labels_dir = os.path.join(output, 'labels', split) if split else os.path.join(output, 'labels')
            try:
                os.makedirs(out_labels_dir, exist_ok=True)
                with open(os.path.join(out_labels_dir, f'{stem}.txt'), 'w',
                          encoding='utf-8', newline='\n') as f:
                    f.write(format_label_boxes(boxes, export_mode))
            except OSError as e:
                warnings.append(f'{stem}: 写入标签失败 - {e}')
                continue

            if include_images:
                out_images_dir = os.path.join(output, 'images', split) if split else os.path.join(output, 'images')
                try:
                    os.makedirs(out_images_dir, exist_ok=True)
                    import shutil  # noqa: PLC0415
                    shutil.copy2(image_path, os.path.join(out_images_dir, os.path.basename(image_path)))
                    image_count += 1
                except OSError as e:
                    warnings.append(f'{stem}: 复制图片失败 - {e}')

        classes = _merge_class_names(class_names or {}, discovered)
        try:
            with open(os.path.join(output, 'classes.txt'), 'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(name for _, name in classes))
            if export_mode != 'raw':
                names_block = '\n'.join(
                    f'  {cid}: {yaml.safe_dump(name, allow_unicode=True).strip()}'
                    for cid, name in classes
                )
                yaml_text = ('path: .\ntrain: images/train\nval: images/val\n'
                             f'names:\n{names_block}\n')
                with open(os.path.join(output, 'data.yaml'), 'w',
                          encoding='utf-8', newline='\n') as f:
                    f.write(yaml_text)
        except OSError as e:
            return {'success': False, 'message': f'写入类别文件失败: {e}'}

        return {
            'success': True,
            'message': '导出完成',
            'output_dir': output.replace('\\', '/'),
            'classes_file': classes_file.replace('\\', '/') if classes_file else '',
            'image_count': image_count,
            'label_count': label_count,
            'total_images': len(images),
            'class_count': len(classes),
            'warnings': warnings,
        }


# ────────────────── 内部实现 ──────────────────

def _unique_export_dir(parent: str, base_name: str) -> str:
    initial = os.path.join(parent, base_name)
    if not os.path.exists(initial):
        return initial
    index = 2
    while True:
        candidate = os.path.join(parent, f'{base_name}_{index}')
        if not os.path.exists(candidate):
            return candidate
        index += 1


def _as_name_map(class_names) -> Dict:
    """把类别参数统一成 {id: name}：兼容 {0: 'a'} / ['a', 'b'] / {'0': 'a'}。"""
    if not class_names:
        return {}
    if isinstance(class_names, dict):
        return dict(class_names)
    if isinstance(class_names, (list, tuple)):
        return {index: name for index, name in enumerate(class_names)}
    return {}


def _merge_class_names(class_names: Dict, discovered) -> List:
    """把用户定义的类别与标注里出现的 id 合并，缺失 id 用数字占位。"""
    merged: Dict[int, str] = {}
    for key, name in _as_name_map(class_names).items():
        try:
            merged[int(key)] = str(name)
        except (TypeError, ValueError):
            continue
    for cid in discovered:
        merged.setdefault(int(cid), str(cid))
    return sorted(merged.items(), key=lambda item: item[0])


def _write_classes_txt(dir_path: str, class_names: Dict):
    """把类别名按 id 升序写入 <dir_path>/classes.txt，失败返回 None。"""
    items = []
    for key, name in _as_name_map(class_names).items():
        try:
            items.append((int(key), str(name)))
        except (TypeError, ValueError):
            continue
    if not items:
        return None
    items.sort(key=lambda item: item[0])
    path = os.path.join(_norm(dir_path), 'classes.txt')
    try:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(name for _, name in items))
    except OSError:
        return None
    return path


# ────────────────── 非 YOLO 格式导出（COCO / VOC / LabelMe）──────────────────

_EXPORT_SUFFIX = {
    'coco': 'coco_dataset',
    'voc': 'voc_dataset',
    'labelme': 'labelme_dataset',
}


def _boxes_for_mode(boxes: List[Dict], export_mode: str) -> List[Dict]:
    """按导出模式调整框形状：detect 只留矩形，segment 矩形补成 4 点多边形。"""
    result: List[Dict] = []
    for box in boxes:
        polygon = box.get('polygon')
        if export_mode == 'detect':
            result.append({**box, 'polygon': None})
            continue
        if export_mode == 'segment' and (not polygon or len(polygon) < 3):
            cx, cy = float(box.get('cx', 0)), float(box.get('cy', 0))
            w, h = float(box.get('w', 0)), float(box.get('h', 0))
            polygon = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
                       [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]
            result.append({**box, 'polygon': polygon})
            continue
        result.append(box)
    return result


def _polygon_area(points: List[List[float]]) -> float:
    """归一化多边形的面积（鞋带公式，返回绝对值）。"""
    area = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def _export_by_format(export_format: str, images: List[str], label_output_dir: str,
                      label_dir: str, parent: str, base_source: str,
                      class_names: Dict, export_mode: str, include_images: bool,
                      classes_file: str = '') -> Dict:
    """COCO / Pascal VOC / LabelMe 导出（单目录，不做 train/val 划分）。"""
    base_name = os.path.basename(base_source.rstrip('\\/')) or 'annotations'
    output = _unique_export_dir(parent, f"{base_name}_{_EXPORT_SUFFIX[export_format]}")
    try:
        os.makedirs(output, exist_ok=True)
    except OSError as e:
        return {'success': False, 'message': f'创建导出目录失败: {e}'}

    id2name: Dict[int, str] = {}
    for key, name in _as_name_map(class_names).items():
        try:
            id2name[int(key)] = str(name)
        except (TypeError, ValueError):
            continue

    entries: List[Dict] = []
    warnings: List[str] = []
    discovered = set()
    for image_path in images:
        label_path = resolve_label_path(image_path, label_output_dir, label_dir)
        boxes: List[Dict] = []
        if os.path.isfile(label_path):
            try:
                with open(label_path, 'r', encoding='utf-8', errors='replace') as f:
                    boxes = parse_label_content(f.read())
            except OSError:
                boxes = []
        try:
            with Image.open(image_path) as im:
                width, height = im.size
        except Exception:
            warnings.append(f'{os.path.basename(image_path)}: 无法读取图片尺寸，已跳过')
            continue
        for box in boxes:
            discovered.add(int(box['class_id']))
        entries.append({
            'path': image_path,
            'name': os.path.basename(image_path),
            'width': width,
            'height': height,
            'boxes': _boxes_for_mode(boxes, export_mode),
        })

    if not entries:
        return {'success': False, 'message': '没有可导出的图片'}

    for cid in discovered:
        id2name.setdefault(cid, f'class {cid}')

    try:
        if export_format == 'coco':
            label_count = _write_coco_dataset(output, entries, id2name, include_images)
        elif export_format == 'voc':
            label_count = _write_voc_dataset(output, entries, id2name, include_images)
        else:
            label_count = _write_labelme_dataset(output, entries, id2name, include_images)
        with open(os.path.join(output, 'classes.txt'), 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(id2name[cid] for cid in sorted(id2name)))
    except OSError as e:
        return {'success': False, 'message': f'写入文件失败: {e}'}

    return {
        'success': True,
        'message': f'导出完成（{export_format.upper()}）：{len(entries)} 张图片，{label_count} 个标注',
        'output_dir': output.replace('\\', '/'),
        'classes_file': classes_file.replace('\\', '/') if classes_file else '',
        'image_count': len(entries) if include_images else 0,
        'label_count': label_count,
        'total_images': len(entries),
        'class_count': len(id2name),
        'export_format': export_format,
        'warnings': warnings,
    }


def _write_coco_dataset(output: str, entries: List[Dict], id2name: Dict[int, str],
                        include_images: bool) -> int:
    if include_images:
        os.makedirs(os.path.join(output, 'images'), exist_ok=True)
    coco: Dict = {
        'info': {
            'description': 'Exported by Easy Dataset Station',
            'version': '1.0',
            'date_created': datetime.date.today().isoformat(),
        },
        'licenses': [],
        'categories': [
            {'id': cid + 1, 'name': id2name.get(cid, f'class {cid}'), 'supercategory': ''}
            for cid in sorted(id2name)
        ],
        'images': [],
        'annotations': [],
    }
    ann_id = 1
    for img_id, entry in enumerate(entries, start=1):
        W, H = entry['width'], entry['height']
        coco['images'].append({'id': img_id, 'file_name': entry['name'], 'width': W, 'height': H})
        if include_images:
            shutil.copy2(entry['path'], os.path.join(output, 'images', entry['name']))
        for box in entry['boxes']:
            polygon = box.get('polygon')
            if polygon and len(polygon) >= 3:
                seg = [round(v, 2) for p in polygon for v in (p[0] * W, p[1] * H)]
                xs = [p[0] * W for p in polygon]
                ys = [p[1] * H for p in polygon]
                ann = {
                    'id': ann_id, 'image_id': img_id,
                    'category_id': int(box['class_id']) + 1,
                    'bbox': [round(min(xs), 2), round(min(ys), 2),
                             round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2)],
                    'area': round(_polygon_area(polygon) * W * H, 2),
                    'iscrowd': 0,
                    'segmentation': [seg],
                }
            else:
                bw = float(box.get('w', 0)) * W
                bh = float(box.get('h', 0)) * H
                x0 = (float(box.get('cx', 0)) - float(box.get('w', 0)) / 2) * W
                y0 = (float(box.get('cy', 0)) - float(box.get('h', 0)) / 2) * H
                ann = {
                    'id': ann_id, 'image_id': img_id,
                    'category_id': int(box['class_id']) + 1,
                    'bbox': [round(x0, 2), round(y0, 2), round(bw, 2), round(bh, 2)],
                    'area': round(bw * bh, 2), 'iscrowd': 0,
                }
            coco['annotations'].append(ann)
            ann_id += 1
    with open(os.path.join(output, 'annotations.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(coco, f, ensure_ascii=False, indent=2)
    return len(coco['annotations'])


def _write_voc_dataset(output: str, entries: List[Dict], id2name: Dict[int, str],
                       include_images: bool) -> int:
    ann_dir = os.path.join(output, 'Annotations')
    os.makedirs(ann_dir, exist_ok=True)
    if include_images:
        os.makedirs(os.path.join(output, 'JPEGImages'), exist_ok=True)
    count = 0
    for entry in entries:
        W, H = entry['width'], entry['height']
        root = ET.Element('annotation')
        ET.SubElement(root, 'folder').text = 'JPEGImages'
        ET.SubElement(root, 'filename').text = entry['name']
        ET.SubElement(root, 'path').text = entry['path'].replace('\\', '/')
        size = ET.SubElement(root, 'size')
        ET.SubElement(size, 'width').text = str(W)
        ET.SubElement(size, 'height').text = str(H)
        ET.SubElement(size, 'depth').text = '3'
        ET.SubElement(root, 'segmented').text = '0'
        for box in entry['boxes']:
            cid = int(box['class_id'])
            x1 = int(round((float(box.get('cx', 0)) - float(box.get('w', 0)) / 2) * W))
            y1 = int(round((float(box.get('cy', 0)) - float(box.get('h', 0)) / 2) * H))
            x2 = int(round((float(box.get('cx', 0)) + float(box.get('w', 0)) / 2) * W))
            y2 = int(round((float(box.get('cy', 0)) + float(box.get('h', 0)) / 2) * H))
            obj = ET.SubElement(root, 'object')
            ET.SubElement(obj, 'name').text = id2name.get(cid, f'class {cid}')
            ET.SubElement(obj, 'difficult').text = '0'
            bndbox = ET.SubElement(obj, 'bndbox')
            ET.SubElement(bndbox, 'xmin').text = str(max(0, x1))
            ET.SubElement(bndbox, 'ymin').text = str(max(0, y1))
            ET.SubElement(bndbox, 'xmax').text = str(min(W, x2))
            ET.SubElement(bndbox, 'ymax').text = str(min(H, y2))
            count += 1
        stem = os.path.splitext(entry['name'])[0]
        ET.ElementTree(root).write(os.path.join(ann_dir, f'{stem}.xml'),
                                   encoding='utf-8', xml_declaration=True)
        if include_images:
            shutil.copy2(entry['path'], os.path.join(output, 'JPEGImages', entry['name']))
    return count


def _write_labelme_dataset(output: str, entries: List[Dict], id2name: Dict[int, str],
                           include_images: bool) -> int:
    if include_images:
        os.makedirs(os.path.join(output, 'images'), exist_ok=True)
    count = 0
    for entry in entries:
        W, H = entry['width'], entry['height']
        shapes: List[Dict] = []
        for box in entry['boxes']:
            cid = int(box['class_id'])
            polygon = box.get('polygon')
            if polygon and len(polygon) >= 3:
                points = [[round(p[0] * W, 2), round(p[1] * H, 2)] for p in polygon]
                shape_type = 'polygon'
            else:
                points = [
                    [round((float(box.get('cx', 0)) - float(box.get('w', 0)) / 2) * W, 2),
                     round((float(box.get('cy', 0)) - float(box.get('h', 0)) / 2) * H, 2)],
                    [round((float(box.get('cx', 0)) + float(box.get('w', 0)) / 2) * W, 2),
                     round((float(box.get('cy', 0)) + float(box.get('h', 0)) / 2) * H, 2)],
                ]
                shape_type = 'rectangle'
            shapes.append({
                'label': id2name.get(cid, f'class {cid}'),
                'points': points,
                'group_id': None,
                'description': '',
                'shape_type': shape_type,
                'flags': {},
            })
            count += 1
        data = {
            'version': '5.0.1',
            'flags': {},
            'shapes': shapes,
            'imagePath': entry['name'],
            'imageData': None,
            'imageHeight': H,
            'imageWidth': W,
        }
        stem = os.path.splitext(entry['name'])[0]
        with open(os.path.join(output, f'{stem}.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if include_images:
            shutil.copy2(entry['path'], os.path.join(output, 'images', entry['name']))
    return count


def _result_to_boxes(result, width: int, height: int) -> List[Dict]:
    """ultralytics Results → YOLO box 列表（OBB 优先输 4 点多边形，其次分割掩膜，最后矩形）。"""
    boxes: List[Dict] = []
    if width <= 0 or height <= 0:
        return boxes

    # OBB 模型：result.obb.xyxyxyxy 给出 4 个角点
    obb = getattr(result, 'obb', None)
    if obb is not None and getattr(obb, 'xyxyxyxy', None) is not None:
        try:
            quads = obb.xyxyxyxy.tolist()
        except (AttributeError, ValueError):
            quads = []
        classes = []
        if getattr(obb, 'cls', None) is not None:
            classes = [int(c.item()) for c in obb.cls]
        for index, quad in enumerate(quads):
            polygon = [[float(p[0]) / width, float(p[1]) / height] for p in quad]
            if len(polygon) < 3:
                continue
            xs = [p[0] for p in polygon]
            ys = [p[1] for p in polygon]
            boxes.append({
                'class_id': classes[index] if index < len(classes) else 0,
                'cx': (min(xs) + max(xs)) / 2,
                'cy': (min(ys) + max(ys)) / 2,
                'w': max(xs) - min(xs),
                'h': max(ys) - min(ys),
                'polygon': polygon,
            })
        # 只要是 OBB 模型就只用 OBB 结果，不退回矩形
        return boxes

    masks = getattr(result, 'masks', None)
    raw_boxes = getattr(result, 'boxes', None)
    if masks is not None and getattr(masks, 'xy', None) is not None and len(masks.xy) > 0:
        classes = []
        if raw_boxes is not None and getattr(raw_boxes, 'cls', None) is not None:
            classes = [int(c.item()) for c in raw_boxes.cls]
        for index, xy in enumerate(masks.xy):
            polygon = [[float(x) / width, float(y) / height] for x, y in xy.tolist()]
            if len(polygon) < 3:
                continue
            xs = [p[0] for p in polygon]
            ys = [p[1] for p in polygon]
            boxes.append({
                'class_id': classes[index] if index < len(classes) else 0,
                'cx': (min(xs) + max(xs)) / 2,
                'cy': (min(ys) + max(ys)) / 2,
                'w': max(xs) - min(xs),
                'h': max(ys) - min(ys),
                'polygon': polygon,
            })
        if boxes:
            return boxes

    if raw_boxes is None:
        return boxes
    for box in raw_boxes:
        try:
            class_id = int(box.cls.item())
            x1, y1, x2, y2 = box.xyxy[0].tolist()
        except (AttributeError, ValueError):
            continue
        boxes.append({
            'class_id': class_id,
            'cx': (x1 + x2) / 2 / width,
            'cy': (y1 + y2) / 2 / height,
            'w': (x2 - x1) / width,
            'h': (y2 - y1) / height,
            'polygon': None,
        })
    return boxes


def _auto_label_worker(task: dict, dir_path: str, model_path: str, conf: float,
                       output_dir: str, overwrite: bool, image_dir: str = ''):
    try:
        from ultralytics import YOLO  # noqa: PLC0415

        model = YOLO(model_path)
        task_error = unsupported_task_message(getattr(model, 'task', ''))
        if task_error:
            task['state'] = 'error'
            task['message'] = task_error
            return
        images = _list_image_paths(dir_path, image_dir)
        task['total'] = len(images)
        task['message'] = ''

        for index, image_path in enumerate(images, start=1):
            if task['stop_event'].is_set():
                task['state'] = 'stopped'
                task['current'] = ''
                return

            name = os.path.basename(image_path)
            label_path = label_path_for(image_path, output_dir)
            task['current'] = name

            if os.path.isfile(label_path) and not overwrite:
                task['skipped'] += 1
                task['processed'] = index
                continue

            try:
                results = model(image_path, conf=conf, verbose=False)
                result = results[0]
                height, width = result.orig_shape[:2]
                boxes = _result_to_boxes(result, int(width), int(height))
                os.makedirs(os.path.dirname(label_path) or '.', exist_ok=True)
                with open(label_path, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(format_label_boxes(boxes, 'raw'))
                task['labeled'] += 1
            except Exception as e:  # noqa: BLE001 - 单张失败不影响整批
                task['errors'].append(f'{name}: {e}')

            task['processed'] = index

        task['state'] = 'done'
        task['current'] = ''
        task['message'] = f'完成：标注 {task["labeled"]}，跳过 {task["skipped"]}'
    except Exception as e:  # noqa: BLE001
        task['state'] = 'error'
        task['message'] = str(e)
        task['current'] = ''
