"""
services/env_service.py
客户端运行环境依赖清单 + Easy Conda（conda environment.yml）导出。

依赖来源：
  - requirements.txt（必装 Python 依赖，运行时读取，保持单一真相源）
  - 系统工具：ffmpeg（conda-forge）
  - AI 可选依赖：ultralytics（AI 自动标注 / 智能抽帧）

生成的 environment.yml 为标准 conda 格式，可直接在 Easy Conda
（https://easyconda.tsagent.cc/）里「导入 environment.yml」创建环境。
"""
import os
import platform
import shutil
import sys
from typing import Dict, List, Optional

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REQUIREMENTS_PATH = os.path.join(_BASE_DIR, 'requirements.txt')

ENV_NAME = 'easy-dataset'
PYTHON_SPEC = '3.10'
CHANNELS = ['conda-forge', 'defaults']

# requirements.txt 缺失时的兜底（与仓库内容保持一致）
_FALLBACK_REQUIREMENTS = [
    'Flask==3.0.0',
    'Flask-SocketIO==5.3.6',
    'Flask-Cors>=4.0.0',
    'werkzeug>=3.0.0',
    'simple-websocket>=1.0.0',
    'gevent>=23.9.0',
    'gevent-websocket>=0.10.1',
    'Pillow==10.4.0',
    'PyYAML==6.0.1',
    'python-dotenv==1.0.0',
    'opencv-python==4.10.0.84',
    'numpy>=1.24.0',
    'matplotlib>=3.7.0',
    'lxml>=4.9.0',
]

# 系统工具（conda 安装）
SYSTEM_DEPS = [
    {
        'name': 'ffmpeg',
        'spec': '',
        'channel': 'conda-forge',
        'note': 'AI 智能抽帧的快速分段；缺少时自动回退到 OpenCV 逐帧切分',
    },
]

# AI 可选依赖（pip 安装）
AI_DEPS = [
    {
        'name': 'ultralytics',
        'spec': '>=8.0.0',
        'note': 'AI 自动标注 / 智能抽帧的模型推理；会自动带上 torch、torchvision（CPU 版）',
    },
]


def _split_requirement(line: str) -> Optional[Dict]:
    """把 `Flask-Cors>=4.0.0` 拆成 {name, spec}。"""
    text = line.split('#', 1)[0].strip()
    if not text or text.startswith('-'):
        return None
    for op in ('===', '==', '>=', '<=', '~=', '!=', '>', '<'):
        if op in text:
            name, _, version = text.partition(op)
            return {'name': name.strip(), 'spec': f'{op}{version.strip()}'}
    return {'name': text, 'spec': ''}


def read_requirements() -> List[Dict]:
    """读取 requirements.txt；读不到时用内置兜底列表。"""
    lines: List[str] = []
    try:
        with open(_REQUIREMENTS_PATH, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except OSError:
        lines = _FALLBACK_REQUIREMENTS

    parsed: List[Dict] = []
    seen = set()
    for line in lines:
        item = _split_requirement(line)
        if not item:
            continue
        key = item['name'].lower()
        if key in seen:
            continue
        seen.add(key)
        parsed.append(item)
    return parsed


def _installed_version(dist_name: str) -> str:
    """取当前后端环境里已安装的版本（取不到返回空串）。"""
    try:
        from importlib.metadata import PackageNotFoundError, version  # noqa: PLC0415
    except ImportError:  # pragma: no cover - Python < 3.8
        return ''
    try:
        return version(dist_name)
    except PackageNotFoundError:
        return ''
    except Exception:  # noqa: BLE001 - 元数据损坏不影响清单展示
        return ''


def _ffmpeg_version() -> str:
    exe = shutil.which('ffmpeg')
    if not exe:
        return ''
    return exe


def dependencies(include_ai: bool = True) -> Dict:
    """返回依赖清单（分组）与对应的 Easy Conda environment.yml。"""
    try:
        reqs = read_requirements()
        pip_items = [
            {
                'name': item['name'],
                'spec': item['spec'],
                'installed': _installed_version(item['name']),
                'required': True,
            }
            for item in reqs
        ]
        system_items = [
            {
                'name': dep['name'],
                'spec': dep.get('channel', ''),
                'installed': _ffmpeg_version() if dep['name'] == 'ffmpeg' else '',
                'required': False,
                'note': dep.get('note', ''),
            }
            for dep in SYSTEM_DEPS
        ]
        ai_items = [
            {
                'name': dep['name'],
                'spec': dep['spec'],
                'installed': _installed_version(dep['name']),
                'required': False,
                'note': dep.get('note', ''),
            }
            for dep in AI_DEPS
        ]

        groups = [
            {
                'id': 'python',
                'title': 'Python 运行时',
                'items': [{
                    'name': 'Python',
                    'spec': f'>={PYTHON_SPEC}',
                    'installed': sys.version.split()[0],
                    'required': True,
                    'note': '推荐 3.10（与打包测试环境一致）',
                }],
            },
            {'id': 'system', 'title': '系统工具', 'items': system_items},
            {'id': 'pip', 'title': 'Python 依赖（必装）', 'items': pip_items},
            {
                'id': 'ai',
                'title': 'AI 推理依赖（可选）',
                'items': ai_items,
                'enabled': bool(include_ai),
            },
        ]

        missing_required = sum(
            1 for group in groups if group['id'] in ('python', 'pip')
            for item in group['items'] if not item['installed']
        )

        return {
            'success': True,
            'env_name': ENV_NAME,
            'python_spec': PYTHON_SPEC,
            'python_version': sys.version.split()[0],
            'platform': f'{platform.system()} {platform.machine()}',
            'groups': groups,
            'counts': {
                'required': len(pip_items) + 1,
                'optional': len(ai_items),
                'missing_required': missing_required,
            },
            'include_ai': bool(include_ai),
            'yaml': build_easyconda_yaml(include_ai=include_ai),
        }
    except Exception as e:  # noqa: BLE001 - 统一转成 JSON 错误
        return {'success': False, 'message': str(e)}


def build_easyconda_yaml(include_ai: bool = True) -> str:
    """生成标准 conda environment.yml（Easy Conda 可直接导入）。"""
    lines: List[str] = [
        '# Easy Dataset 运行环境',
        '# 可在 Easy Conda（https://easyconda.tsagent.cc/）中「导入 environment.yml」直接创建',
        '# 手动创建：conda env create -f environment.yml',
        f'name: {ENV_NAME}',
        'channels:',
    ]
    lines += [f'  - {channel}' for channel in CHANNELS]
    lines += [
        'dependencies:',
        f'  - python={PYTHON_SPEC}',
        '  - pip',
    ]
    lines += [f'  - {dep["name"]}' for dep in SYSTEM_DEPS]
    lines.append('  - pip:')
    for item in read_requirements():
        lines.append(f'      - {item["name"]}{item["spec"]}')

    if include_ai:
        lines.append('      # AI 自动标注 / 智能抽帧（可选，配套 torch 会被一并安装为 CPU 版）')
        for dep in AI_DEPS:
            lines.append(f'      - {dep["name"]}{dep["spec"]}')
        lines.append('      # GPU 加速请按 CUDA 版本单独安装 torch，例如：')
        lines.append('      # pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121')
    else:
        lines.append('      # 如需 AI 自动标注 / 智能抽帧，取消下面一行注释')
        for dep in AI_DEPS:
            lines.append(f'      # - {dep["name"]}{dep["spec"]}')

    lines.append('')
    return '\n'.join(lines)


class EnvService:
    """对外统一入口（与其它 service 保持相同调用风格）。"""

    @staticmethod
    def dependencies(include_ai: bool = True) -> Dict:
        return dependencies(include_ai=include_ai)

    @staticmethod
    def build_yaml(include_ai: bool = True) -> str:
        return build_easyconda_yaml(include_ai=include_ai)

    @staticmethod
    def requirements() -> List[Dict]:
        return read_requirements()
