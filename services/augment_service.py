"""
# services/augment_service.py
数据增强预览服务：对单张图片应用多种增强变换，返回带标注框的 base64 预览图。

支持的增强类型：
  flip_h    水平翻转      flip_v     垂直翻转
  rotate90  旋转 90° CW   rotate180  旋转 180°   rotate270  旋转 270° CW
  brightness 提高亮度     contrast   提高对比度   grayscale  灰度化

bbox 坐标变换规则（YOLO 归一化 cx, cy, w, h）：
  flip_h:    cx → 1-cx
  flip_v:    cy → 1-cy
  rotate90:  (cx,cy,w,h) → (1-cy, cx, h, w)
  rotate180: (cx,cy)     → (1-cx, 1-cy)
  rotate270: (cx,cy,w,h) → (cy, 1-cx, h, w)
  color ops: bbox 不变
"""
import os
import io
import base64
from typing import Dict, List, Optional

from PIL import Image, ImageEnhance, ImageDraw

from services.label_format import is_rotated, parse_file, polygon_bbox

_COLORS = [
    (255, 56, 56), (255, 157, 151), (255, 112, 31), (255, 178, 29),
    (207, 210, 49), (72, 249, 10), (146, 204, 23), (61, 219, 134),
    (26, 147, 52), (0, 212, 187), (44, 153, 168), (0, 194, 255),
    (52, 69, 147), (100, 115, 255), (0, 24, 236), (132, 56, 255),
    (82, 0, 133), (203, 56, 255), (255, 149, 200), (255, 55, 199),
]

AUGMENT_DEFS: Dict[str, str] = {
    'flip_h': '水平翻转',
    'flip_v': '垂直翻转',
    'rotate90': '旋转 90°',
    'rotate180': '旋转 180°',
    'rotate270': '旋转 270°',
    'brightness': '提高亮度',
    'contrast': '提高对比度',
    'grayscale': '灰度化',
}


def _parse_labels(label_path: str) -> List[Dict]:
    """解析 YOLO 标签（矩形 / 多边形 / 旋转框统一解析）。"""
    if not label_path:
        return []
    return parse_file(label_path)


def _row_corners(row: Dict) -> List[List[float]]:
    """取 row 的顶点列表：多边形原样返回，矩形返回 4 个角点。"""
    if row.get('polygon'):
        return [list(p) for p in row['polygon']]
    cx, cy, w, h = row['cx'], row['cy'], row['w'], row['h']
    return [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
            [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]


def _draw_boxes(img: Image.Image, rows: List[Dict], class_names: Optional[List[str]]) -> None:
    W, H = img.size
    draw = ImageDraw.Draw(img)
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    for row in rows:
        cid = int(row['class_id'])
        color = _COLORS[cid % len(_COLORS)]
        name = (class_names[cid] if class_names and cid < len(class_names) else str(cid))
        polygon = row.get('polygon')
        if polygon:
            poly = [(int(x * W), int(y * H)) for x, y in polygon]
            if is_rotated(polygon):
                # 旋转框：轮廓 + 顶点
                overlay_draw.line(poly + [poly[0]], fill=(*color, 255), width=2)
                for px, py in poly:
                    overlay_draw.ellipse([px - 3, py - 3, px + 3, py + 3], fill=(*color, 255))
            else:
                overlay_draw.polygon(poly, fill=(*color, 80))
                overlay_draw.line(poly + [poly[0]], fill=(*color, 230), width=2)
            x1 = min(p[0] for p in poly)
            y1 = min(p[1] for p in poly)
        else:
            x1 = int((row['cx'] - row['w'] / 2) * W)
            y1 = int((row['cy'] - row['h'] / 2) * H)
            x2 = int((row['cx'] + row['w'] / 2) * W)
            y2 = int((row['cy'] + row['h'] / 2) * H)
            draw.rectangle([x1, y1, x2, y2], outline=color, width=2)

        draw.rectangle([x1, y1 - 16, x1 + len(name) * 7 + 4, y1], fill=color)
        draw.text((x1 + 2, y1 - 15), name, fill=(255, 255, 255))

    img.paste(Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB'), (0, 0))


def _img_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=82)
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def _transform_point(x: float, y: float, aug: str):
    """归一化点坐标变换（与图片几何变换同步）。"""
    if aug == 'flip_h':
        return 1 - x, y
    if aug == 'flip_v':
        return x, 1 - y
    if aug == 'rotate90':
        return 1 - y, x
    if aug == 'rotate180':
        return 1 - x, 1 - y
    if aug == 'rotate270':
        return y, 1 - x
    return x, y


def _transform_row(row: Dict, aug: str) -> Dict:
    """把一条标注按几何变换重算（矩形统一走 4 角点 → 外接矩形）。"""
    corners = _row_corners(row)
    moved = [_transform_point(x, y, aug) for x, y in corners]
    polygon = row.get('polygon')
    if polygon:
        cx, cy, w, h = polygon_bbox(moved)
        return {'class_id': row['class_id'], 'polygon': moved,
                'cx': cx, 'cy': cy, 'w': w, 'h': h}
    cx, cy, w, h = polygon_bbox(moved)
    return {'class_id': row['class_id'], 'polygon': None,
            'cx': cx, 'cy': cy, 'w': w, 'h': h}


def _apply(img: Image.Image, rows: List[Dict], aug: str):
    """对图片和标注同步应用一种增强，返回 (new_img, new_rows)"""
    geometric = aug in ('flip_h', 'flip_v', 'rotate90', 'rotate180', 'rotate270')

    if aug == 'flip_h':
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    elif aug == 'flip_v':
        img = img.transpose(Image.FLIP_TOP_BOTTOM)
    elif aug == 'rotate90':
        # PIL ROTATE_270 = 逆时针 270° = 视觉上顺时针 90°
        img = img.transpose(Image.ROTATE_270)
    elif aug == 'rotate180':
        img = img.transpose(Image.ROTATE_180)
    elif aug == 'rotate270':
        # PIL ROTATE_90 = 逆时针 90° = 视觉上顺时针 270°
        img = img.transpose(Image.ROTATE_90)
    elif aug == 'brightness':
        img = ImageEnhance.Brightness(img).enhance(1.6)
    elif aug == 'contrast':
        img = ImageEnhance.Contrast(img).enhance(1.6)
    elif aug == 'grayscale':
        img = img.convert('L').convert('RGB')

    if geometric:
        new_rows = [_transform_row(row, aug) for row in rows]
    else:
        new_rows = [{**row, 'polygon': [list(p) for p in row['polygon']] if row.get('polygon') else None}
                    for row in rows]

    return img, new_rows


class AugmentService:

    @staticmethod
    def preview(
        image_path: str,
        label_path: str = '',
        augments: Optional[List[str]] = None,
        class_names: Optional[List[str]] = None,
    ) -> Dict:
        """对图片应用多种增强并返回 base64 预览图列表（含原图）"""
        try:
            if not os.path.isfile(image_path):
                return {'success': False, 'message': f'图片不存在: {image_path}'}

            if augments is None:
                augments = list(AUGMENT_DEFS.keys())

            base_img = Image.open(image_path).convert('RGB')
            W, H = base_img.size
            max_dim = 480
            if max(W, H) > max_dim:
                ratio = max_dim / max(W, H)
                base_img = base_img.resize((int(W * ratio), int(H * ratio)), Image.LANCZOS)

            boxes = _parse_labels(label_path)

            results = []
            # 原图
            orig = base_img.copy()
            _draw_boxes(orig, boxes, class_names)
            results.append({'aug': 'original', 'label': '原图', 'image_b64': _img_to_b64(orig)})

            for aug in augments:
                if aug not in AUGMENT_DEFS:
                    continue
                aug_img, aug_boxes = _apply(base_img.copy(), boxes, aug)
                _draw_boxes(aug_img, aug_boxes, class_names)
                results.append({
                    'aug': aug,
                    'label': AUGMENT_DEFS[aug],
                    'image_b64': _img_to_b64(aug_img),
                })

            return {'success': True, 'results': results}

        except Exception as e:
            return {'success': False, 'message': str(e)}

    @staticmethod
    def list_augments() -> Dict:
        return {
            'success': True,
            'augments': [{'id': k, 'label': v} for k, v in AUGMENT_DEFS.items()],
        }
