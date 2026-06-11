"""
# services/dataset_service.py

## 核心功能
数据集质量分析与图片预览服务。
"""
import os
import base64
import glob
import io
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import yaml
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 预设颜色池（RGB）
_COLORS = [
    (255, 56, 56), (255, 157, 151), (255, 112, 31), (255, 178, 29),
    (207, 210, 49), (72, 249, 10), (146, 204, 23), (61, 219, 134),
    (26, 147, 52), (0, 212, 187), (44, 153, 168), (0, 194, 255),
    (52, 69, 147), (100, 115, 255), (0, 24, 236), (132, 56, 255),
    (82, 0, 133), (203, 56, 255), (255, 149, 200), (255, 55, 199),
]


class DatasetService:

    @staticmethod
    def _parse_yaml(yaml_path: str) -> Tuple[str, str, List[str]]:
        """解析 data.yaml，返回 (image_dir, label_dir, class_names)"""
        with open(yaml_path, 'r', encoding='utf-8') as f:
            cfg = yaml.safe_load(f)
        base = os.path.dirname(os.path.abspath(yaml_path))

        # 解析 path: 字段（可能是绝对路径或相对于 yaml 目录的路径）
        path_key = cfg.get('path', base)
        if not os.path.isabs(path_key):
            path_key = os.path.normpath(os.path.join(base, path_key))
        else:
            path_key = os.path.normpath(path_key)

        train_val_raw = cfg.get('train') or cfg.get('val') or ''

        def _resolve_image_dir(raw: str) -> str:
            """
            按优先级查找真实存在的图片目录：
            1. 绝对路径 / path_key 拼接（YOLOv8 标准）
            2. 直接从 yaml 所在目录拼接（处理 ../train/images 这类 Roboflow 路径）
            3. 去掉所有 ../，只保留末尾文件夹部分，在 yaml 目录内查找
            4. 以上都不存在时返回 path_key 拼接后的结果（保持原有行为）
            """
            if os.path.isabs(raw):
                return os.path.normpath(raw)

            # 候选 1：path_key + raw（标准 YOLOv8）
            c1 = os.path.normpath(os.path.join(path_key, raw))
            if os.path.isdir(c1):
                return c1

            # 候选 2：base + raw（处理 ../xxx 的 Roboflow 风格）
            c2 = os.path.normpath(os.path.join(base, raw))
            if os.path.isdir(c2):
                return c2

            # 候选 3：去掉所有 .. 和 . 分量，在 base 下查找剩余路径
            parts = [p for p in raw.replace('\\', '/').split('/') if p not in ('..', '.', '')]
            if parts:
                c3 = os.path.normpath(os.path.join(base, *parts))
                if os.path.isdir(c3):
                    return c3
                # 候选 4：仅取最末尾一个文件夹（如 images）的父目录
                c4 = os.path.normpath(os.path.join(base, *parts[:-1])) if len(parts) > 1 else base
                if os.path.isdir(c4):
                    return c4

            # 回退：返回 dirname(c1)
            return os.path.dirname(c1)

        if train_val_raw:
            image_dir = _resolve_image_dir(train_val_raw)
        else:
            image_dir = path_key

        label_dir = image_dir.replace('images', 'labels').replace('imgs', 'labels')
        class_names = cfg.get('names', [])
        if isinstance(class_names, dict):
            class_names = [class_names[k] for k in sorted(class_names.keys())]
        return image_dir, label_dir, class_names

    @staticmethod
    def _collect_images(image_dir: str) -> List[str]:
        exts = ('*.jpg', '*.jpeg', '*.png', '*.bmp', '*.webp')
        files = []
        for ext in exts:
            files.extend(glob.glob(os.path.join(image_dir, ext)))
            files.extend(glob.glob(os.path.join(image_dir, ext.upper())))
        return sorted(set(files))

    @staticmethod
    def _collect_labels(label_dir: str) -> List[str]:
        return sorted(glob.glob(os.path.join(label_dir, '*.txt')))

    @staticmethod
    def analyze(image_dir: str = '', label_dir: str = '', yaml_path: str = '') -> Dict:
        try:
            class_names: List[str] = []
            if yaml_path and os.path.isfile(yaml_path):
                image_dir_from_yaml, label_dir_from_yaml, class_names = DatasetService._parse_yaml(yaml_path)
                if not image_dir:
                    image_dir = image_dir_from_yaml
                if not label_dir:
                    label_dir = label_dir_from_yaml

            if not image_dir or not os.path.isdir(image_dir):
                return {'success': False, 'message': f'图片目录不存在: {image_dir}'}

            images = DatasetService._collect_images(image_dir)
            image_stems = {Path(p).stem: p for p in images}

            labels: List[str] = []
            label_stems: Dict[str, str] = {}
            if label_dir and os.path.isdir(label_dir):
                labels = DatasetService._collect_labels(label_dir)
                label_stems = {Path(p).stem: p for p in labels}

            # ── 一致性检查 ──
            matched = [s for s in image_stems if s in label_stems]
            orphan_images = [image_stems[s] for s in image_stems if s not in label_stems]
            orphan_labels = [label_stems[s] for s in label_stems if s not in image_stems]
            empty_labels = []
            if label_dir and os.path.isdir(label_dir):
                empty_labels = [p for p in labels if os.path.getsize(p) == 0]

            # ── 类别统计 ──
            class_counts: Dict[int, int] = {}
            bbox_areas: List[float] = []
            bbox_aspects: List[float] = []
            total_boxes = 0
            invalid_rows = 0
            for lbl_path in labels:
                if os.path.getsize(lbl_path) == 0:
                    continue
                with open(lbl_path, 'r') as f:
                    for line in f:
                        parts = line.strip().split()
                        if len(parts) < 5:
                            if parts:  # 非空行才计为无效
                                invalid_rows += 1
                            continue
                        cid = int(parts[0])
                        w = float(parts[3])
                        h = float(parts[4])
                        class_counts[cid] = class_counts.get(cid, 0) + 1
                        bbox_areas.append(w * h)
                        bbox_aspects.append(w / h if h > 0 else 0)
                        total_boxes += 1

            # ── 图片尺寸统计 ──
            widths, heights = [], []
            sample_paths = images[:min(200, len(images))]
            for p in sample_paths:
                try:
                    with Image.open(p) as img:
                        widths.append(img.width)
                        heights.append(img.height)
                except Exception:
                    pass

            class_dist = []
            for cid, cnt in sorted(class_counts.items()):
                name = class_names[cid] if cid < len(class_names) else f'class_{cid}'
                ratio = round(cnt / total_boxes, 4) if total_boxes > 0 else 0
                class_dist.append({'id': cid, 'name': name, 'count': cnt, 'ratio': ratio})

            return {
                'success': True,
                'summary': {
                    'total_images': len(images),
                    'total_labels': len(labels),
                    'matched_pairs': len(matched),
                    'orphan_images': len(orphan_images),
                    'orphan_labels': len(orphan_labels),
                    'empty_labels': len(empty_labels),
                    'total_boxes': total_boxes,
                    'num_classes': len(class_counts),
                    'invalid_rows': invalid_rows,
                },
                'class_distribution': class_dist,
                'class_names': class_names,
                'image_dir': image_dir,
                'label_dir': label_dir,
                'orphan_image_paths': orphan_images[:50],
                'orphan_label_paths': orphan_labels[:50],
                'empty_label_paths': empty_labels[:50],
                'image_size_stats': {
                    'avg_width': int(np.mean(widths)) if widths else 0,
                    'avg_height': int(np.mean(heights)) if heights else 0,
                    'min_width': int(np.min(widths)) if widths else 0,
                    'max_width': int(np.max(widths)) if widths else 0,
                    'min_height': int(np.min(heights)) if heights else 0,
                    'max_height': int(np.max(heights)) if heights else 0,
                },
                'bbox_stats': {
                    'avg_area': float(np.mean(bbox_areas)) if bbox_areas else 0,
                    'avg_aspect': float(np.mean(bbox_aspects)) if bbox_aspects else 0,
                    'small_objects': sum(1 for a in bbox_areas if a < 0.005),
                    'large_objects': sum(1 for a in bbox_areas if a > 0.10),
                },
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}

    @staticmethod
    def list_images(image_dir: str, label_dir: str = '', filter: str = 'all',
                    page: int = 0, page_size: int = 0,
                    class_filter: Optional[int] = None) -> Dict:
        try:
            if not os.path.isdir(image_dir):
                return {'success': False, 'message': f'目录不存在: {image_dir}'}
            images = DatasetService._collect_images(image_dir)
            label_dir_valid = label_dir and os.path.isdir(label_dir)
            count_all = len(images)
            count_labeled = 0
            count_unlabeled = 0
            class_counts: Dict[int, int] = {}
            items = []
            for p in images:
                stem = Path(p).stem
                label_path = ''
                box_count = 0
                has_label = False
                class_ids: set = set()
                if label_dir_valid:
                    candidate = os.path.join(label_dir, stem + '.txt')
                    if os.path.isfile(candidate):
                        has_label = True
                        label_path = candidate
                        try:
                            with open(candidate, 'r') as f:
                                for line in f:
                                    parts = line.strip().split()
                                    if len(parts) >= 5:
                                        try:
                                            cls_idx = int(parts[0])
                                            class_ids.add(cls_idx)
                                            box_count += 1
                                        except ValueError:
                                            pass
                        except Exception:
                            pass
                if has_label:
                    count_labeled += 1
                    for cls_idx in class_ids:
                        class_counts[cls_idx] = class_counts.get(cls_idx, 0) + 1
                else:
                    count_unlabeled += 1
                # 根据 filter 参数过滤
                if filter == 'with_label' and not has_label:
                    continue
                if filter == 'no_label' and has_label:
                    continue
                # 按类别过滤：只保留含指定类别的图片
                if class_filter is not None and class_filter not in class_ids:
                    continue
                items.append({
                    'image_path': p,
                    'label_path': label_path,
                    'has_label': has_label,
                    'filename': os.path.basename(p),
                    'box_count': box_count,
                })
            total = len(items)
            if page_size > 0:
                start = page * page_size
                items = items[start:start + page_size]
            return {'success': True, 'images': items, 'total': total,
                    'page': page, 'page_size': page_size,
                    'counts': {'all': count_all, 'labeled': count_labeled,
                               'unlabeled': count_unlabeled, 'class_counts': class_counts}}
        except Exception as e:
            return {'success': False, 'message': str(e)}

    @staticmethod
    def parse_yaml(yaml_path: str) -> Dict:
        """快速解析 data.yaml，返回图片目录、标签目录和类别名列表（不扫描文件）"""
        try:
            if not os.path.isfile(yaml_path):
                return {'success': False, 'message': f'文件不存在: {yaml_path}'}
            image_dir, label_dir, class_names = DatasetService._parse_yaml(yaml_path)
            return {
                'success': True,
                'image_dir': image_dir,
                'label_dir': label_dir,
                'class_names': class_names,
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}

    @staticmethod
    def bbox_histogram(label_dir: str) -> Dict:
        """返回标注框面积分布直方图和宽高比分布直方图数据。"""
        try:
            if not os.path.isdir(label_dir):
                return {'success': False, 'message': f'目录不存在: {label_dir}'}

            areas: list = []
            aspects: list = []
            labels = glob.glob(os.path.join(label_dir, '*.txt'))

            for lbl_path in labels:
                if os.path.getsize(lbl_path) == 0:
                    continue
                with open(lbl_path, 'r') as f:
                    for line in f:
                        parts = line.strip().split()
                        if len(parts) >= 5:
                            w = float(parts[3])
                            h = float(parts[4])
                            areas.append(w * h)
                            aspects.append(w / h if h > 0 else 0)

            if not areas:
                return {'success': True, 'area_histogram': [], 'aspect_histogram': [], 'total_boxes': 0}

            # 面积分布（占图片面积的百分比区间）
            area_buckets = [
                (0,      0.001, '< 0.1%'),
                (0.001,  0.005, '0.1–0.5%'),
                (0.005,  0.01,  '0.5–1%'),
                (0.01,   0.05,  '1–5%'),
                (0.05,   0.10,  '5–10%'),
                (0.10,   0.25,  '10–25%'),
                (0.25,   1.0,   '> 25%'),
            ]
            total = len(areas)
            area_hist = []
            for lo, hi, label in area_buckets:
                count = sum(1 for a in areas if lo <= a < hi)
                area_hist.append({'range': label, 'count': count, 'ratio': round(count / total, 4)})

            # 宽高比分布
            aspect_buckets = [
                (0,    0.25, '< 0.25'),
                (0.25, 0.5,  '0.25–0.5'),
                (0.5,  1.0,  '0.5–1.0'),
                (1.0,  2.0,  '1.0–2.0'),
                (2.0,  4.0,  '2.0–4.0'),
                (4.0,  float('inf'), '> 4.0'),
            ]
            aspect_hist = []
            for lo, hi, label in aspect_buckets:
                count = sum(1 for a in aspects if lo <= a < hi)
                aspect_hist.append({'range': label, 'count': count, 'ratio': round(count / total, 4)})

            return {
                'success': True,
                'area_histogram': area_hist,
                'aspect_histogram': aspect_hist,
                'total_boxes': total,
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}

    @staticmethod
    def preview_image(image_path: str, label_path: str = '', class_names: List[str] = None) -> Dict:
        try:
            if not os.path.isfile(image_path):
                return {'success': False, 'message': f'图片不存在: {image_path}'}

            img = Image.open(image_path).convert('RGBA')
            W, H = img.size

            if label_path and os.path.isfile(label_path):
                # 分离绘制层，以便 mask 半透明叠加
                overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
                overlay_draw = ImageDraw.Draw(overlay)
                draw = ImageDraw.Draw(img)

                with open(label_path, 'r') as f:
                    for line in f:
                        parts = line.strip().split()
                        if len(parts) < 5:
                            continue
                        cid = int(parts[0])
                        color = _COLORS[cid % len(_COLORS)]
                        name = (class_names or [])[cid] if class_names and cid < len(class_names) else str(cid)

                        # YOLO seg 格式：class_id x1 y1 x2 y2 ... (至少 7 个值，点数为偶数)
                        coords = [float(v) for v in parts[1:]]
                        if len(coords) >= 6 and len(coords) % 2 == 0:
                            # 分割格式：绘制多边形 mask
                            poly = [(int(coords[i] * W), int(coords[i + 1] * H))
                                    for i in range(0, len(coords), 2)]
                            # 半透明填充
                            overlay_draw.polygon(poly, fill=(*color, 80))
                            # 多边形轮廓
                            overlay_draw.line(poly + [poly[0]], fill=(*color, 230), width=2)
                            # 从多边形计算包围盒用于标签
                            xs = [p[0] for p in poly]
                            ys = [p[1] for p in poly]
                            x1, y1 = min(xs), min(ys)
                        else:
                            # 检测格式：cx cy w h
                            cx, cy, w, h = coords[0], coords[1], coords[2], coords[3]
                            x1 = int((cx - w / 2) * W)
                            y1 = int((cy - h / 2) * H)
                            x2 = int((cx + w / 2) * W)
                            y2 = int((cy + h / 2) * H)
                            draw.rectangle([x1, y1, x2, y2], outline=color, width=2)

                        # 类别标签
                        draw.rectangle([x1, y1 - 16, x1 + len(name) * 7 + 4, y1], fill=color)
                        draw.text((x1 + 2, y1 - 15), name, fill=(255, 255, 255))

                # 将 overlay（mask层）合并到原图
                img = Image.alpha_composite(img, overlay)

            img = img.convert('RGB')

            # 限制预览尺寸
            max_dim = 1280
            if max(W, H) > max_dim:
                ratio = max_dim / max(W, H)
                img = img.resize((int(W * ratio), int(H * ratio)), Image.LANCZOS)

            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=85)
            b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            return {'success': True, 'image_b64': b64, 'width': img.width, 'height': img.height}
        except Exception as e:
            return {'success': False, 'message': str(e)}
