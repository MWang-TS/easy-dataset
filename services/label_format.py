"""统一解析/格式化 YOLO 标签行。

支持三种常见写法（全部为归一化 0–1 坐标）：
  detect   cls cx cy w h
  obb      cls x1 y1 x2 y2 x3 y3 x4 y4        （4 个角点，8 坐标）
  segment  cls x1 y1 x2 y2 ... xn yn          （>= 3 个点）

本模块仅依赖标准库，供 dataset_service / augment_service /
convert_service / export_service 等复用，避免各处重复写解析逻辑。
"""
from typing import Dict, Iterable, List, Optional

# 多边形行的最少坐标个数（3 个点 = 6 个坐标）+ 类别 = 7 段
_MIN_POLYGON_PARTS = 7


def parse_row(line: str) -> Optional[Dict]:
    """把一行 YOLO 标签解析成 dict。

    返回 {'class_id': int, 'polygon': [[x, y], ...] | None, 'cx', 'cy', 'w', 'h'}
    无法解析时返回 None。矩形行的 polygon 为 None，cx/cy/w/h 即 YOLO 中心点格式；
    多边形行的 cx/cy/w/h 是多边形的外接矩形（中心点 + 宽高）。
    """
    parts = line.split()
    if len(parts) < 5:
        return None
    try:
        class_id = int(float(parts[0]))
    except (TypeError, ValueError):
        return None

    # 多边形：坐标个数为偶数且不少于 6（3 个点）
    coords_count = len(parts) - 1
    if len(parts) >= _MIN_POLYGON_PARTS and coords_count % 2 == 0:
        try:
            coords = [float(v) for v in parts[1:]]
        except ValueError:
            return None
        polygon = [[coords[i], coords[i + 1]] for i in range(0, len(coords), 2)]
        cx, cy, w, h = polygon_bbox(polygon)
        return {'class_id': class_id, 'polygon': polygon,
                'cx': cx, 'cy': cy, 'w': w, 'h': h}

    try:
        cx, cy, w, h = (float(parts[1]), float(parts[2]),
                        float(parts[3]), float(parts[4]))
    except ValueError:
        return None
    return {'class_id': class_id, 'polygon': None,
            'cx': cx, 'cy': cy, 'w': w, 'h': h}


def iter_rows(content: str) -> Iterable[Dict]:
    """逐行解析标签内容，跳过无法解析的行。"""
    for line in content.splitlines():
        row = parse_row(line)
        if row is not None:
            yield row


def parse_file(label_path: str) -> List[Dict]:
    """解析整个标签文件；文件不存在或无内容时返回空列表。"""
    try:
        with open(label_path, 'r', encoding='utf-8', errors='replace') as f:
            return list(iter_rows(f.read()))
    except OSError:
        return []


def polygon_bbox(polygon: List[List[float]]):
    """多边形 → 外接矩形 (cx, cy, w, h)，全部归一化。"""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2,
            max(xs) - min(xs), max(ys) - min(ys))


def polygon_area(polygon: List[List[float]]) -> float:
    """鞋带公式计算多边形面积（归一化单位）。"""
    if len(polygon) < 3:
        return 0.0
    total = 0.0
    for i in range(len(polygon)):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % len(polygon)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def is_rotated(polygon: Optional[List[List[float]]]) -> bool:
    """4 点多边形视为旋转框（OBB）。"""
    return bool(polygon) and len(polygon) == 4


def is_rect_quad(polygon: List[List[float]], tolerance: float = 0.02) -> bool:
    """判断 4 点多边形是否真的构成矩形（对边等长、邻边垂直）。

    用于区分「YOLO OBB 的旋转矩形」与「恰好 4 个点的分割多边形」。
    """
    if not polygon or len(polygon) != 4:
        return False
    p0, p1, p2, p3 = polygon
    v1 = (p1[0] - p0[0], p1[1] - p0[1])
    v2 = (p2[0] - p1[0], p2[1] - p1[1])
    v3 = (p3[0] - p2[0], p3[1] - p2[1])
    v4 = (p0[0] - p3[0], p0[1] - p3[1])
    len1 = (v1[0] ** 2 + v1[1] ** 2) ** 0.5
    len2 = (v2[0] ** 2 + v2[1] ** 2) ** 0.5
    len3 = (v3[0] ** 2 + v3[1] ** 2) ** 0.5
    len4 = (v4[0] ** 2 + v4[1] ** 2) ** 0.5
    if min(len1, len2, len3, len4) <= 1e-9:
        return False
    scale = max(len1, len2, len3, len4)
    # 对边等长
    if abs(len1 - len3) > scale * tolerance or abs(len2 - len4) > scale * tolerance:
        return False
    # 邻边垂直（点积 ≈ 0）
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    return abs(dot) <= scale * scale * tolerance



def label_type_name(rect_rows: int, polygon_rows: int, quad_rows: int = 0) -> str:
    """detect / obb / segment / mixed / none。"""
    if rect_rows > 0 and polygon_rows > 0:
        return 'mixed'
    if polygon_rows > 0:
        return 'obb' if quad_rows == polygon_rows else 'segment'
    if rect_rows > 0:
        return 'detect'
    return 'none'


def format_row(row: Dict, mode: str = 'raw') -> str:
    """把解析后的 row 重新格式化为一行文本。

    mode:
      raw     原样（有多边形就写多边形）
      detect  一律写矩形 cx cy w h
      segment 多边形保留；矩形补成 4 个角点
    """
    class_id = int(row.get('class_id', 0))
    polygon = row.get('polygon')
    if mode == 'detect':
        return (f'{class_id} {row["cx"]:.6f} {row["cy"]:.6f} '
                f'{row["w"]:.6f} {row["h"]:.6f}')
    if not polygon or len(polygon) < 3:
        if mode == 'segment':
            cx, cy, w, h = row['cx'], row['cy'], row['w'], row['h']
            polygon = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
                       [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]
        else:
            return (f'{class_id} {row["cx"]:.6f} {row["cy"]:.6f} '
                    f'{row["w"]:.6f} {row["h"]:.6f}')
    coords = ' '.join(f'{x:.6f} {y:.6f}' for x, y in polygon)
    return f'{class_id} {coords}'
