"""
# routes/main_routes.py

## 核心功能
Easy Dataset Station 所有 REST API 路由及 SocketIO 事件注册。
"""
import os
import io as _io
import base64
import hmac
from flask import request, jsonify
from PIL import Image as _Image
from werkzeug.utils import secure_filename
from . import main_bp
from config import Config
from services.dataset_service import DatasetService
from services.convert_service import ConvertService
from services.label_service import LabelService
from services.file_service import FileService
from services.split_service import SplitService
from services.export_service import ExportService
from services.merge_service import MergeService
from services.augment_service import AugmentService
from services.video_service import VideoService
from services.ai_video_service import AIVideoService, DEFAULT_MODEL_PATH


# ────────────────── 可选鉴权 ──────────────────

def _get_request_token():
    token = request.headers.get('X-API-Token')
    if token:
        return token.strip() or None
    auth = request.headers.get('Authorization', '')
    parts = auth.strip().split(None, 1)
    if len(parts) == 2 and parts[0].lower() == 'bearer':
        return parts[1].strip() or None
    token = request.args.get('api_token', '').strip()
    return token or None


def _is_token_valid(token):
    if not Config.API_TOKEN:
        return True
    if not token:
        return False
    return hmac.compare_digest(token, Config.API_TOKEN)


@main_bp.before_request
def _enforce_auth():
    if not Config.API_TOKEN:
        return None
    if request.method == 'OPTIONS':
        return None
    if not request.path.startswith('/api/'):
        return None
    if _is_token_valid(_get_request_token()):
        return None
    return jsonify({'success': False, 'message': 'Unauthorized'}), 401


# ────────────────── 数据集质量检测 ──────────────────

@main_bp.route('/api/dataset/analyze', methods=['POST'])
def analyze_dataset():
    """分析数据集质量：加载数据集并返回统计信息"""
    data = request.get_json(force=True)
    image_dir = data.get('image_dir', '')
    label_dir = data.get('label_dir', '')
    yaml_path = data.get('yaml_path', '')
    result = DatasetService.analyze(image_dir=image_dir, label_dir=label_dir, yaml_path=yaml_path)
    return jsonify(result)


@main_bp.route('/api/dataset/preview', methods=['POST'])
def preview_image():
    """返回指定图片（带标注框）的 base64 预览"""
    data = request.get_json(force=True)
    image_path = data.get('image_path', '')
    label_path = data.get('label_path', '')
    class_names = data.get('class_names', [])
    result = DatasetService.preview_image(image_path, label_path, class_names)
    return jsonify(result)


@main_bp.route('/api/dataset/list-images', methods=['POST'])
def list_images():
    """列出数据集中所有图片路径（支持过滤、类别过滤和分页）"""
    data = request.get_json(force=True)
    image_dir = data.get('image_dir', '')
    label_dir = data.get('label_dir', '')
    filter_mode = data.get('filter', 'all')
    page = int(data.get('page', 0))
    page_size = int(data.get('page_size', 0))
    class_filter = data.get('class_filter', None)
    if class_filter is not None:
        class_filter = int(class_filter)
    result = DatasetService.list_images(image_dir, label_dir, filter=filter_mode,
                                        page=page, page_size=page_size, class_filter=class_filter)
    return jsonify(result)


@main_bp.route('/api/dataset/parse-yaml', methods=['POST'])
def parse_yaml():
    """快速解析 data.yaml，返回图片目录、标签目录和类别名列表"""
    data = request.get_json(force=True)
    yaml_path = data.get('yaml_path', '')
    result = DatasetService.parse_yaml(yaml_path)
    return jsonify(result)


# ────────────────── 缩略图批量获取 ──────────────────

@main_bp.route('/api/dataset/thumbnails', methods=['POST'])
def get_thumbnails():
    """批量返回图片缩略图（base64 JPEG），每次最多 100 张"""
    data = request.get_json(force=True) or {}
    paths = data.get('paths', [])
    size = int(data.get('size', 80))
    result: dict = {}
    for path in paths[:100]:
        try:
            with _Image.open(path) as img:
                img.thumbnail((size, size), _Image.LANCZOS)
                buf = _io.BytesIO()
                img.convert('RGB').save(buf, format='JPEG', quality=55)
                result[path] = base64.b64encode(buf.getvalue()).decode()
        except Exception:
            result[path] = ''
    return jsonify({'success': True, 'thumbnails': result})


# ────────────────── 格式转换 ──────────────────

@main_bp.route('/api/convert/labelme2yolo', methods=['POST'])
def convert_labelme2yolo():
    data = request.get_json(force=True)
    result = ConvertService.labelme2yolo(
        input_dir=data.get('input_dir', ''),
        output_dir=data.get('output_dir', ''),
        labels=data.get('labels', {}),
    )
    return jsonify(result)


@main_bp.route('/api/convert/voc2yolo', methods=['POST'])
def convert_voc2yolo():
    data = request.get_json(force=True)
    result = ConvertService.voc2yolo(
        input_dir=data.get('input_dir', ''),
        output_dir=data.get('output_dir', ''),
        labels=data.get('labels', {}),
    )
    return jsonify(result)


@main_bp.route('/api/convert/yolo2voc', methods=['POST'])
def convert_yolo2voc():
    data = request.get_json(force=True)
    result = ConvertService.yolo2voc(
        dataset_dir=data.get('dataset_dir', ''),
        output_dir=data.get('output_dir', ''),
        labels=data.get('labels', {}),
    )
    return jsonify(result)


@main_bp.route('/api/convert/yolo-class-remap', methods=['POST'])
def convert_yolo_class_remap():
    data = request.get_json(force=True)
    result = ConvertService.yolo_class_remap(
        input_dir=data.get('input_dir', ''),
        output_dir=data.get('output_dir', ''),
        class_mapping=data.get('class_mapping', {}),
    )
    return jsonify(result)


# ────────────────── 标签编辑 ──────────────────

@main_bp.route('/api/label/change-class', methods=['POST'])
def label_change_class():
    data = request.get_json(force=True)
    result = LabelService.change_class(
        label_dir=data.get('label_dir', ''),
        old_id=data.get('old_id'),
        new_id=data.get('new_id'),
        in_place=data.get('in_place', False),
        output_dir=data.get('output_dir', ''),
    )
    return jsonify(result)


@main_bp.route('/api/label/delete-class', methods=['POST'])
def label_delete_class():
    data = request.get_json(force=True)
    result = LabelService.delete_class(
        label_dir=data.get('label_dir', ''),
        class_id=data.get('class_id'),
        in_place=data.get('in_place', False),
        output_dir=data.get('output_dir', ''),
    )
    return jsonify(result)


@main_bp.route('/api/label/reorder', methods=['POST'])
def label_reorder():
    data = request.get_json(force=True)
    result = LabelService.reorder_classes(
        label_dir=data.get('label_dir', ''),
        order_map=data.get('order_map', {}),
        in_place=data.get('in_place', False),
        output_dir=data.get('output_dir', ''),
    )
    return jsonify(result)


# ────────────────── 文件管理 ──────────────────

@main_bp.route('/api/file/check-consistency', methods=['POST'])
def file_check_consistency():
    """检查图片与标签的一一对应关系"""
    data = request.get_json(force=True)
    result = FileService.check_consistency(
        image_dir=data.get('image_dir', ''),
        label_dir=data.get('label_dir', ''),
    )
    return jsonify(result)


@main_bp.route('/api/file/delete-empty-labels', methods=['POST'])
def file_delete_empty_labels():
    data = request.get_json(force=True)
    result = FileService.delete_empty_labels(
        label_dir=data.get('label_dir', ''),
        dry_run=data.get('dry_run', True),
    )
    return jsonify(result)


@main_bp.route('/api/file/create-empty-labels', methods=['POST'])
def file_create_empty_labels():
    """为没有标签的图片创建空 TXT 文件"""
    data = request.get_json(force=True)
    result = FileService.create_empty_labels(
        image_dir=data.get('image_dir', ''),
        label_dir=data.get('label_dir', ''),
    )
    return jsonify(result)


@main_bp.route('/api/file/batch-rename', methods=['POST'])
def file_batch_rename():
    data = request.get_json(force=True)
    result = FileService.batch_rename(
        image_dir=data.get('image_dir', ''),
        label_dir=data.get('label_dir', ''),
        prefix=data.get('prefix', 'img'),
        dry_run=data.get('dry_run', True),
    )
    return jsonify(result)


@main_bp.route('/api/file/repair-images', methods=['POST'])
def file_repair_images():
    data = request.get_json(force=True)
    result = FileService.repair_images(
        image_dir=data.get('image_dir', ''),
        quality=data.get('quality', 95),
        dry_run=data.get('dry_run', True),
    )
    return jsonify(result)


# ────────────────── 数据集划分 ──────────────────

@main_bp.route('/api/split/run', methods=['POST'])
def split_run():
    data = request.get_json(force=True)
    result = SplitService.split(
        image_dir=data.get('image_dir', ''),
        label_dir=data.get('label_dir', ''),
        output_dir=data.get('output_dir', ''),
        train_ratio=float(data.get('train_ratio', 0.8)),
        val_ratio=float(data.get('val_ratio', 0.1)),
        test_ratio=float(data.get('test_ratio', 0.1)),
        seed=int(data.get('seed', 42)),
        generate_yaml=data.get('generate_yaml', True),
        class_names=data.get('class_names', []),
    )
    return jsonify(result)


# ────────────────── BBox 直方图 ──────────────────

@main_bp.route('/api/dataset/bbox-histogram', methods=['POST'])
def dataset_bbox_histogram():
    """\u8fd4\u56de\u6807\u6ce8\u6846\u9762\u79ef\u5206\u5e03\u548c\u5bbd\u9ad8\u6bd4\u5206\u5e03\u76f4\u65b9\u56fe\u6570\u636e"""
    data = request.get_json(force=True)
    result = DatasetService.bbox_histogram(label_dir=data.get('label_dir', ''))
    return jsonify(result)


# ────────────────── COCO 导出 ──────────────────

@main_bp.route('/api/export/coco', methods=['POST'])
def export_coco():
    """\u5c06 YOLO \u683c\u5f0f\u6570\u636e\u96c6\u5bfc\u51fa\u4e3a COCO JSON"""
    data = request.get_json(force=True)
    result = ExportService.yolo2coco(
        image_dir=data.get('image_dir', ''),
        label_dir=data.get('label_dir', ''),
        output_path=data.get('output_path', ''),
        class_names=data.get('class_names') or [],
    )
    return jsonify(result)


# ────────────────── 数据集合并 ──────────────────

@main_bp.route('/api/merge/run', methods=['POST'])
def merge_run():
    """\u5408\u5e76\u591a\u4e2a YOLO \u6570\u636e\u96c6"""
    data = request.get_json(force=True)
    result = MergeService.merge(
        sources=data.get('sources', []),
        output_image_dir=data.get('output_image_dir', ''),
        output_label_dir=data.get('output_label_dir', ''),
        prefix_by_source=data.get('prefix_by_source', False),
    )
    return jsonify(result)


# ────────────────── 增强预览 ──────────────────

@main_bp.route('/api/augment/preview', methods=['POST'])
def augment_preview():
    """\u5bf9\u5355\u5f20\u56fe\u7247\u5e94\u7528\u591a\u79cd\u589e\u5f3a\u53d8\u6362\u5e76\u8fd4\u56de base64 \u9884\u89c8\u56fe"""
    data = request.get_json(force=True)
    result = AugmentService.preview(
        image_path=data.get('image_path', ''),
        label_path=data.get('label_path', ''),
        augments=data.get('augments') or None,
        class_names=data.get('class_names') or None,
    )
    return jsonify(result)


@main_bp.route('/api/augment/list', methods=['GET'])
def augment_list():
    """\u8fd4\u56de\u5df2\u652f\u6301\u7684\u589e\u5f3a\u7c7b\u578b\u5217\u8868"""
    return jsonify(AugmentService.list_augments())


# ────────────────── SocketIO 事件 ──────────────────


# ────────────────── 视频处理 ──────────────────

@main_bp.route('/api/video/info', methods=['POST'])
def video_info():
    """读取视频基本元信息（分辨率、帧率、总帧数、时长）"""
    data = request.get_json(force=True)
    result = VideoService.get_info(video_path=data.get('video_path', ''))
    return jsonify(result)


@main_bp.route('/api/video/extract-frames', methods=['POST'])
def video_extract_frames():
    """启动后台抽帧任务，立即返回 task_id"""
    data = request.get_json(force=True)
    result = VideoService.start_extract_frames(
        video_path=data.get('video_path', ''),
        output_dir=data.get('output_dir', ''),
        interval_frames=data.get('interval_frames', 30),
        fmt=data.get('format', 'jpg'),
        quality=data.get('quality', 95),
        prefix=data.get('prefix', 'frame'),
        num_workers=int(data.get('num_workers', 1)),
    )
    return jsonify(result)


@main_bp.route('/api/video/extract-status', methods=['POST'])
def video_extract_status():
    """查询抽帧任务状态"""
    data = request.get_json(force=True)
    result = VideoService.get_status(task_id=data.get('task_id', ''))
    return jsonify(result)


@main_bp.route('/api/video/stop-extract', methods=['POST'])
def video_stop_extract():
    """中止指定抽帧任务"""
    data = request.get_json(force=True)
    result = VideoService.stop_extraction(task_id=data.get('task_id', ''))
    return jsonify(result)


# ────────────────── AI 视频智能抽帧 ──────────────────

@main_bp.route('/api/video/ai-check', methods=['POST', 'GET'])
def video_ai_check():
    """检查当前环境是否支持 AI 抽帧"""
    result = AIVideoService.check_available()
    result['default_model'] = DEFAULT_MODEL_PATH
    return jsonify(result)


@main_bp.route('/api/video/ai-extract-frames', methods=['POST'])
def video_ai_extract_frames():
    """启动 AI 智能抽帧后台任务，立即返回 task_id"""
    data = request.get_json(force=True)
    target_raw = data.get('target_classes', '')
    if isinstance(target_raw, str):
        target_classes = [c.strip() for c in target_raw.replace('，', ',').split(',') if c.strip()]
    else:
        target_classes = list(target_raw)
    result = AIVideoService.start_extract_frames(
        video_path=data.get('video_path', ''),
        output_dir=data.get('output_dir', ''),
        model_path=data.get('model_path', ''),
        target_classes=target_classes,
        conf_threshold=float(data.get('conf_threshold', 0.25)),
        interval_frames=int(data.get('interval_frames', 1)),
        fmt=data.get('format', 'jpg'),
        quality=int(data.get('quality', 95)),
        prefix=data.get('prefix', 'ai_frame'),
        max_parallel=int(data.get('max_parallel', 2)),
        batch_size=int(data.get('batch_size', 8)),
        segment_minutes=int(data.get('segment_minutes', 0)),
    )
    return jsonify(result)


@main_bp.route('/api/video/ai-extract-status', methods=['POST'])
def video_ai_extract_status():
    """查询 AI 抽帧任务进度"""
    data = request.get_json(force=True)
    result = AIVideoService.get_status(task_id=data.get('task_id', ''))
    return jsonify(result)


@main_bp.route('/api/video/ai-stop-extract', methods=['POST'])
def video_ai_stop_extract():
    """中止 AI 抽帧任务"""
    data = request.get_json(force=True)
    result = AIVideoService.stop_extraction(task_id=data.get('task_id', ''))
    return jsonify(result)


def register_socketio_events(socketio):
    @socketio.on('connect')
    def on_connect():
        pass

    @socketio.on('disconnect')
    def on_disconnect():
        pass
