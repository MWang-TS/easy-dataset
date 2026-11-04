"""
# services/convert_service.py

## 核心功能
数据集格式转换服务：LabelMe↔YOLO、VOC↔YOLO、YOLO 类别重映射。
"""
import os
import json
import shutil
from pathlib import Path
from typing import Dict, List, Optional
try:
    import xml.etree.ElementTree as ET
except ImportError:
    ET = None

from services.label_format import parse_row


class ConvertService:

    # ── LabelMe JSON → YOLO TXT ──

    @staticmethod
    def labelme2yolo(input_dir: str, output_dir: str, labels: Dict) -> Dict:
        """
        将 LabelMe 导出的 JSON 文件转换为 YOLO 格式 TXT 标签文件。
        labels: {class_name: class_id} 或 {class_id: class_name}
        """
        try:
            if not os.path.isdir(input_dir):
                return {'success': False, 'message': f'输入目录不存在: {input_dir}'}
            os.makedirs(output_dir, exist_ok=True)

            # 统一为 name→id 映射
            name2id: Dict[str, int] = {}
            if labels:
                for k, v in labels.items():
                    if isinstance(v, int):
                        name2id[str(k)] = v
                    else:
                        name2id[str(v)] = int(k)

            json_files = list(Path(input_dir).rglob('*.json'))
            if not json_files:
                return {'success': False, 'message': '未找到 JSON 文件'}

            converted, skipped, errors = 0, 0, []
            for jf in json_files:
                try:
                    with open(jf, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    W = data.get('imageWidth', 0)
                    H = data.get('imageHeight', 0)
                    if W == 0 or H == 0:
                        skipped += 1
                        continue
                    lines = []
                    for shape in data.get('shapes', []):
                        label = shape.get('label', '')
                        pts = shape.get('points', [])
                        shape_type = shape.get('shape_type', 'rectangle')
                        if label not in name2id:
                            continue
                        cid = name2id[label]
                        if shape_type == 'polygon' and len(pts) >= 3:
                            # 多边形保留为 YOLO 分割行
                            coords = ' '.join(
                                f'{p[0] / W:.6f} {p[1] / H:.6f}' for p in pts
                            )
                            lines.append(f'{cid} {coords}')
                            continue
                        if shape_type == 'rectangle' and len(pts) == 2:
                            x1, y1 = pts[0]
                            x2, y2 = pts[1]
                        elif len(pts) >= 2:
                            xs = [p[0] for p in pts]
                            ys = [p[1] for p in pts]
                            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                        else:
                            continue
                        cx = ((x1 + x2) / 2) / W
                        cy = ((y1 + y2) / 2) / H
                        bw = abs(x2 - x1) / W
                        bh = abs(y2 - y1) / H
                        lines.append(f'{cid} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}')
                    out_path = os.path.join(output_dir, jf.stem + '.txt')
                    with open(out_path, 'w', encoding='utf-8') as f:
                        f.write('\n'.join(lines))
                    converted += 1
                except Exception as e:
                    errors.append(f'{jf.name}: {e}')

            return {
                'success': True,
                'message': f'转换完成：{converted} 成功，{skipped} 跳过，{len(errors)} 失败',
                'converted': converted, 'skipped': skipped, 'errors': errors,
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}

    # ── Pascal VOC XML → YOLO TXT ──

    @staticmethod
    def voc2yolo(input_dir: str, output_dir: str, labels: Dict) -> Dict:
        try:
            if ET is None:
                return {'success': False, 'message': '缺少 xml.etree.ElementTree 模块'}
            if not os.path.isdir(input_dir):
                return {'success': False, 'message': f'输入目录不存在: {input_dir}'}
            os.makedirs(output_dir, exist_ok=True)

            name2id: Dict[str, int] = {}
            if labels:
                for k, v in labels.items():
                    if isinstance(v, int):
                        name2id[str(k)] = v
                    else:
                        name2id[str(v)] = int(k)

            xml_files = list(Path(input_dir).rglob('*.xml'))
            if not xml_files:
                return {'success': False, 'message': '未找到 XML 文件'}

            converted, skipped, errors = 0, 0, []
            for xf in xml_files:
                try:
                    tree = ET.parse(str(xf))
                    root = tree.getroot()
                    size = root.find('size')
                    W = int(size.find('width').text)
                    H = int(size.find('height').text)
                    if W == 0 or H == 0:
                        skipped += 1
                        continue
                    lines = []
                    for obj in root.findall('object'):
                        name = obj.find('name').text.strip()
                        if name not in name2id:
                            continue
                        cid = name2id[name]
                        bndbox = obj.find('bndbox')
                        x1 = float(bndbox.find('xmin').text)
                        y1 = float(bndbox.find('ymin').text)
                        x2 = float(bndbox.find('xmax').text)
                        y2 = float(bndbox.find('ymax').text)
                        cx = ((x1 + x2) / 2) / W
                        cy = ((y1 + y2) / 2) / H
                        bw = (x2 - x1) / W
                        bh = (y2 - y1) / H
                        lines.append(f'{cid} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}')
                    out_path = os.path.join(output_dir, xf.stem + '.txt')
                    with open(out_path, 'w', encoding='utf-8') as f:
                        f.write('\n'.join(lines))
                    converted += 1
                except Exception as e:
                    errors.append(f'{xf.name}: {e}')

            return {
                'success': True,
                'message': f'转换完成：{converted} 成功，{skipped} 跳过，{len(errors)} 失败',
                'converted': converted, 'skipped': skipped, 'errors': errors,
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}

    # ── YOLO TXT → Pascal VOC XML ──

    @staticmethod
    def yolo2voc(dataset_dir: str, output_dir: str, labels: Dict) -> Dict:
        try:
            if ET is None:
                return {'success': False, 'message': '缺少 xml.etree.ElementTree 模块'}
            if not os.path.isdir(dataset_dir):
                return {'success': False, 'message': f'数据集目录不存在: {dataset_dir}'}
            os.makedirs(output_dir, exist_ok=True)

            id2name: Dict[int, str] = {}
            if labels:
                for k, v in labels.items():
                    if isinstance(v, int):
                        id2name[v] = str(k)
                    else:
                        id2name[int(k)] = str(v)

            from PIL import Image as PILImage
            txt_files = list(Path(dataset_dir).glob('**/*.txt'))
            if not txt_files:
                return {'success': False, 'message': '未找到 TXT 标签文件'}

            converted, skipped, errors = 0, 0, []
            for tf in txt_files:
                try:
                    # 查找对应图片
                    img_path = None
                    for ext in ('.jpg', '.jpeg', '.png', '.bmp'):
                        candidate = tf.with_suffix(ext)
                        if candidate.exists():
                            img_path = candidate
                            break
                        # 兼容 images/ 与 images/<split>/ 同级目录
                        for sibling_dir in (
                            tf.parent.parent / 'images',
                            tf.parent.parent / 'images' / tf.parent.name,
                        ):
                            sibling = sibling_dir / (tf.stem + ext)
                            if sibling.exists():
                                img_path = sibling
                                break
                        if img_path is not None:
                            break
                    if img_path is None:
                        skipped += 1
                        continue

                    with PILImage.open(str(img_path)) as img:
                        W, H = img.size

                    root_elem = ET.Element('annotation')
                    ET.SubElement(root_elem, 'filename').text = img_path.name
                    size_elem = ET.SubElement(root_elem, 'size')
                    ET.SubElement(size_elem, 'width').text = str(W)
                    ET.SubElement(size_elem, 'height').text = str(H)
                    ET.SubElement(size_elem, 'depth').text = '3'

                    with open(str(tf), 'r') as f:
                        for line in f:
                            row = parse_row(line)
                            if row is None:
                                continue
                            cid = int(row['class_id'])
                            # 多边形/旋转框按外接框写 bndbox
                            x1 = int((row['cx'] - row['w'] / 2) * W)
                            y1 = int((row['cy'] - row['h'] / 2) * H)
                            x2 = int((row['cx'] + row['w'] / 2) * W)
                            y2 = int((row['cy'] + row['h'] / 2) * H)
                            name = id2name.get(cid, str(cid))
                            obj_elem = ET.SubElement(root_elem, 'object')
                            ET.SubElement(obj_elem, 'name').text = name
                            ET.SubElement(obj_elem, 'difficult').text = '0'
                            bb_elem = ET.SubElement(obj_elem, 'bndbox')
                            ET.SubElement(bb_elem, 'xmin').text = str(x1)
                            ET.SubElement(bb_elem, 'ymin').text = str(y1)
                            ET.SubElement(bb_elem, 'xmax').text = str(x2)
                            ET.SubElement(bb_elem, 'ymax').text = str(y2)

                    tree = ET.ElementTree(root_elem)
                    out_path = os.path.join(output_dir, tf.stem + '.xml')
                    tree.write(out_path, encoding='utf-8', xml_declaration=True)
                    converted += 1
                except Exception as e:
                    errors.append(f'{tf.name}: {e}')

            return {
                'success': True,
                'message': f'转换完成：{converted} 成功，{skipped} 跳过，{len(errors)} 失败',
                'converted': converted, 'skipped': skipped, 'errors': errors,
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}

    # ── YOLO 类别 ID 重映射 ──

    @staticmethod
    def yolo_class_remap(input_dir: str, output_dir: str, class_mapping: Dict) -> Dict:
        """class_mapping: {"0": 1, "1": 0, ...} 原ID→新ID"""
        try:
            if not os.path.isdir(input_dir):
                return {'success': False, 'message': f'输入目录不存在: {input_dir}'}
            os.makedirs(output_dir, exist_ok=True)

            mapping = {int(k): int(v) for k, v in class_mapping.items()}
            txt_files = list(Path(input_dir).rglob('*.txt'))
            if not txt_files:
                return {'success': False, 'message': '未找到 TXT 文件'}

            converted = 0
            for tf in txt_files:
                new_lines = []
                with open(str(tf), 'r') as f:
                    for line in f:
                        parts = line.strip().split()
                        if not parts:
                            continue
                        cid = int(parts[0])
                        new_cid = mapping.get(cid, cid)
                        new_lines.append(str(new_cid) + ' ' + ' '.join(parts[1:]))
                out_path = os.path.join(output_dir, tf.name)
                with open(out_path, 'w') as f:
                    f.write('\n'.join(new_lines))
                converted += 1

            return {
                'success': True,
                'message': f'重映射完成：{converted} 个文件',
                'converted': converted,
            }
        except Exception as e:
            return {'success': False, 'message': str(e)}
