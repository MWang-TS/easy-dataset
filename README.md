# Easy Dataset Station

<p align="center">
  <b>YOLO 数据集全流程管理桌面工具</b><br>
  基于 Tauri 2 + React + Flask 构建，支持 Windows / macOS / Linux
</p>

<p align="center">
  <a href="https://github.com/MWang-TS/easy-dataset/releases"><img src="https://img.shields.io/github/v/release/MWang-TS/easy-dataset" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/i18n-中文%20%7C%20English%20%7C%20日本語-green" alt="i18n">
</p>

---

## 功能模块

| 模块 | 说明 |
|---|---|
| 🔍 数据集质量检测 | 统计图片 / 标签 / 标注框数量，检测孤立文件、空标签、类别分布失衡 |
| 👁 数据集可视化 | 带标注框图片预览，支持按"已标注 / 未标注"过滤 |
| 🔄 格式转换 | LabelMe → YOLO、VOC → YOLO、YOLO → VOC、类别 ID 重映射 |
| ✏️ 标签编辑 | 批量替换 / 删除类别 ID，多 ID 重排序 |
| 📁 文件管理 | 一致性检查、删除空标签、创建空标签、批量重命名、修复损坏图片 |
| ✂️ 数据集划分 | 按比例 train / val / test 随机划分，自动生成 data.yaml |
| 🗂 数据集合并 | 多路径数据集合并，支持类别 ID 重映射 |
| 📦 数据集导出 | 一键打包导出为 ZIP，可选择导出子集 |
| 🎬 视频帧提取 | 从视频中均匀 / 关键帧提取图片，直接进入标注流程 |
| 🔁 数据增强 | 翻转、旋转、亮度 / 对比度、噪声等多种增强策略，实时预览 |

## 技术栈

| 层次 | 技术 |
|---|---|
| 桌面壳 | Tauri 2（Rust）|
| 前端 | React 19 + TypeScript + Tailwind CSS v4 + Vite 7 |
| 状态管理 | Zustand 5 |
| 国际化 | i18next（中文 / English / 日本語）|
| 后端 | Python Flask（运行在用户指定的 conda 环境中）|
| 通信 | Tauri IPC（命令）+ REST API（localhost）|

## 快速开始

### 直接下载（推荐）

前往 [Releases](https://github.com/MWang-TS/easy-dataset/releases) 下载对应平台的安装包。

首次运行会引导你选择包含所需 Python 包的 conda 环境，或手动指定 Python 可执行文件路径。

### 从源码构建

**前提条件**

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) 1.77+
- [Conda](https://docs.conda.io/)（可选，用于管理 Python 环境）

**安装依赖**

```bash
# 前端依赖
npm install

# Python 依赖（在你的 conda 环境中）
pip install -r requirements.txt
```

**开发模式**

```bash
npm run tauri dev
```

**生产构建**

```bash
npm run tauri build
```

## Conda 环境配置

应用后端运行在用户指定的 conda 环境中。根据需要使用的功能，选择对应的环境配置。

### 基础环境（所有功能通用）

适用于格式转换、数据集管理、视频普通抽帧等功能。

```bash
conda create -n easy-dataset python=3.10
conda activate easy-dataset
pip install -r requirements.txt
```

`requirements.txt` 包含以下核心库：

| 库 | 版本 | 用途 |
|---|---|---|
| Flask | 3.0.0 | Web 后端框架 |
| Flask-SocketIO | 5.3.6 | WebSocket 支持 |
| Flask-Cors | ≥4.0.0 | 跨域请求 |
| Pillow | 10.4.0 | 图片读写 |
| opencv-python | 4.10.0.84 | 视频/图片处理 |
| numpy | ≥1.24.0 | 数值计算 |
| PyYAML | 6.0.1 | YAML 配置解析 |
| matplotlib | ≥3.7.0 | 数据可视化 |
| lxml | ≥4.9.0 | VOC XML 解析 |
| python-dotenv | 1.0.0 | 环境变量加载 |
| gevent | ≥23.9.0 | 异步 Worker |

### AI 智能抽帧环境（可选）

AI 视频抽帧功能需要额外安装 YOLOv8 推理库和 ffmpeg。

```bash
conda create -n yolov8-gpu python=3.10
conda activate yolov8-gpu

# 安装基础依赖
pip install -r requirements.txt

# 安装 PyTorch（GPU 版本，以 CUDA 12.1 为例）
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# 安装 YOLOv8
pip install ultralytics

# 通过 conda 安装 ffmpeg（包含编解码器）
conda install -c conda-forge ffmpeg
```

| 库 | 用途 |
|---|---|
| torch + torchvision | GPU 推理加速 |
| ultralytics | YOLOv8 模型推理 |
| ffmpeg | 视频快速无损分段切割 |

> **注意**：
> - PyTorch 版本需与本机 CUDA 版本匹配，请参考 [PyTorch 官网](https://pytorch.org/get-started/locally/) 选择正确的安装命令
> - 纯 CPU 环境可将 `cu121` 替换为 `cpu`，但推理速度会显著降低
> - 首次使用 AI 抽帧前，应用会自动检测环境是否包含 `ultralytics` 和 `ffmpeg`，缺失时会在界面上给出提示


## 目录结构

```
easy_dataset/
├── app.py                    # Flask 入口
├── config.py                 # 配置（端口、目录）
├── requirements.txt          # Python 依赖
├── routes/                   # Flask Blueprint 路由
├── services/                 # 业务逻辑层
│   ├── dataset_service.py    # 质量检测
│   ├── convert_service.py    # 格式转换
│   ├── label_service.py      # 标签编辑
│   ├── file_service.py       # 文件管理
│   ├── split_service.py      # 数据集划分
│   ├── merge_service.py      # 数据集合并
│   ├── export_service.py     # 数据集导出
│   ├── augment_service.py    # 数据增强
│   ├── video_service.py      # 视频帧提取（普通）
│   └── ai_video_service.py   # AI 智能抽帧（YOLOv8）
├── src/                      # React 前端
│   ├── pages/                # 页面组件
│   ├── components/           # 公共组件
│   ├── i18n/                 # 国际化（zh-CN / en / ja）
│   └── lib/
│       ├── store.ts          # Zustand 全局状态
│       └── tauri-bridge.ts   # Tauri IPC + API 封装
├── src-tauri/                # Tauri Rust 壳
│   └── src/commands/
│       └── backend.rs        # 后端进程管理命令
└── docs/
    └── PRD.md                # 产品需求文档
```

## 产品文档

详见 [docs/PRD.md](docs/PRD.md)

## License

本项目以 [GNU General Public License v3.0](LICENSE) 发布。
