# Easy Dataset Station — 产品需求文档（PRD）

> 版本：v1.0.0 | 状态：草稿 | 作者：EasyOLO Team

---

## 一、产品概述

### 1.1 产品定位

**Easy Dataset Station** 是面向 YOLO 目标检测工程师与数据标注团队的**桌面端数据集管理工具**。它以零服务器配置、开箱即用为核心理念，帮助用户在本地快速完成数据集的质量评估、可视化预览、格式转换、标签编辑、文件整理和数据集划分等全流程操作。

### 1.2 目标用户

| 用户角色 | 核心诉求 |
|---|---|
| 算法工程师 | 快速了解数据集质量，分析类别分布不均衡问题 |
| 数据标注负责人 | 批量修复标签错误，整理文件命名，检查一致性 |
| 实习生 / 新人 | 零命令行门槛完成格式转换、数据集划分 |

### 1.3 产品目标

- 提供可视化操作界面，替代繁琐的 Python 脚本命令行调用
- 覆盖数据集预处理全链路，无需在多个工具之间切换
- 与 Easy Infer Station / Easy Trainer Station 形成工具链闭环

### 1.4 技术架构

```
┌─────────────────────────────────────────────────────┐
│           Easy Dataset Station Desktop App           │
│  ┌───────────────────┐   ┌─────────────────────────┐│
│  │  Tauri 2 (Rust)   │   │   React 19 + TypeScript ││
│  │  Native Shell     │◄──│   Tailwind CSS v4       ││
│  │  File Dialog      │   │   Zustand v5 (状态管理)  ││
│  └────────┬──────────┘   └─────────────────────────┘│
│           │ IPC / invoke                              │
│  ┌────────▼──────────────────────────────────────┐  │
│  │  Python Flask 3.0 + Flask-SocketIO  (port 8081)│  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────┐ │  │
│  │  │ Dataset  │ │ Convert  │ │ Label / File / │ │  │
│  │  │ Service  │ │ Service  │ │ Split Service  │ │  │
│  │  └──────────┘ └──────────┘ └────────────────┘ │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- **前端**：React 19 + TypeScript + Tailwind CSS v4 + Vite 7，运行在 Tauri WebView 中
- **后端**：Python Flask，由 Tauri Rust 层动态启动/停止，使用用户自选的 conda 环境
- **通信**：前端通过 `fetch` 调用 `http://127.0.0.1:8081/api/*` REST 接口
- **桌面集成**：Tauri 2 提供文件对话框、系统托盘、本地存储等原生能力

---

## 二、功能模块详细需求

### 2.1 数据集质量检测（Dataset Quality）

**功能目标**：全面评估 YOLO 格式数据集质量，输出统计报告，辅助用户发现潜在问题。

#### 2.1.1 输入方式

| 方式 | 说明 |
|---|---|
| 手动目录 | 分别选择图片目录和标签目录（支持深层嵌套） |
| YAML 文件 | 选择 data.yaml，自动解析 `path`、`train`、`val`、`names` 字段 |

#### 2.1.2 核心统计指标

| 指标 | 说明 | 展示形式 |
|---|---|---|
| 图片总数 | 目录下所有图片文件数量（jpg/png/bmp/webp） | 数字卡片 |
| 标签总数 | 目录下所有 TXT 文件数量 | 数字卡片 |
| 标注框总数 | 所有标签文件中标注行之和 | 数字卡片 |
| 类别数量 | 出现的不重复类别 ID 数量 | 数字卡片 |
| 配对成功 | 有对应标签文件的图片数量 | 数字卡片（绿） |
| 孤立图片 | 无对应 TXT 文件的图片 | 数字卡片（橙） |
| 空标签文件 | 内容为空（0 字节）的 TXT 文件 | 数字卡片（红） |
| 无效标签行 | 标签文件中不符合 YOLO 格式的行 | 数字卡片（红） |

#### 2.1.3 类别分布

- 每个类别的标注框数量及占比
- 横向条形图（内联 CSS 渐变），颜色随类别变化
- 若用户提供 `names` 映射则显示类别名称，否则显示 `class_N`

#### 2.1.4 图像尺寸统计

- 采样最多 200 张图片获取实际像素尺寸（避免大数据集过慢）
- 显示：最小宽/高、最大宽/高、平均宽/高、最常见尺寸

#### 2.1.5 标注框统计

- 平均面积比（bbox 面积 / 图片面积）
- 小目标比例（面积比 < 0.5%）
- 大目标比例（面积比 > 10%）
- 平均宽高比

#### 2.1.6 问题文件列表

- 可折叠的孤立图片列表
- 可折叠的孤立标签列表
- 可折叠的空标签列表

**接口**：`POST /api/dataset/analyze`

---

### 2.2 数据集可视化（Dataset Viewer）

**功能目标**：快速预览数据集图片及其 YOLO 标注框，便于肉眼检查标注质量。

#### 2.2.1 操作流程

1. 选择图片目录（必选）和标签目录（可选）
2. 点击"加载列表"，后端返回图片路径列表
3. 左侧缩略图列表显示，支持按标签情况过滤
4. 点击缩略图，右侧大图区域展示 base64 预览图（带绘制的标注框）

#### 2.2.2 过滤选项

| 过滤值 | 说明 |
|---|---|
| 全部 | 显示所有图片 |
| 已标注 | 仅显示有对应非空 TXT 的图片 |
| 未标注 | 仅显示无 TXT 或 TXT 为空的图片 |

#### 2.2.3 预览渲染

- 后端使用 OpenCV 绘制 YOLO bbox（不同类别不同颜色）
- 图片宽度限制为 1280px（大图等比缩小），避免传输过慢
- 标注框角点显示类别 ID（若有 names 则显示类别名）
- 返回 base64 JPEG 字符串

#### 2.2.4 分页

- 每页显示 50 张缩略图列表
- 支持前进/后退翻页

**接口**：`POST /api/dataset/list-images`，`POST /api/dataset/preview`

---

### 2.3 格式转换（Format Converter）

**功能目标**：在主流标注格式之间互相转换，无需手写脚本。

#### 2.3.1 支持的转换方向

| 转换方向 | 说明 |
|---|---|
| LabelMe JSON → YOLO TXT | LabelMe 多边形标注转为 YOLO bbox |
| Pascal VOC XML → YOLO TXT | VOC 格式转 YOLO |
| YOLO TXT → Pascal VOC XML | YOLO 格式转 VOC XML |
| YOLO 类别 ID 重映射 | 批量修改 class_id 编号 |

#### 2.3.2 LabelMe → YOLO

- 输入：LabelMe JSON 文件所在目录
- 输出：YOLO TXT 文件目录
- 类别映射：用户手动填写 `类别名 → ID` 映射表
- 支持多边形 → bbox（取外接矩形）

#### 2.3.3 VOC → YOLO

- 输入：Pascal VOC XML 文件所在目录
- 输出：YOLO TXT 文件目录
- 类别映射：用户填写 `类别名 → ID` 映射表

#### 2.3.4 YOLO → VOC

- 输入：图片目录 + 标签目录
- 输出：XML 文件目录
- 需要读取原始图片获取宽高（由后端完成）

#### 2.3.5 类别 ID 重映射

- 输入：YOLO 标签目录
- 用户填写多条 `原 ID → 新 ID` 映射规则
- 批量修改所有 TXT 文件中的类别 ID

**接口**：`POST /api/convert/labelme2yolo`，`POST /api/convert/voc2yolo`，`POST /api/convert/yolo2voc`，`POST /api/convert/yolo-class-remap`

---

### 2.4 标签编辑（Label Editor）

**功能目标**：批量修改 YOLO 标签文件中的类别 ID，解决标注错误、类别合并等问题。

#### 2.4.1 编辑模式

| 模式 | 说明 |
|---|---|
| 替换类别 ID | 将旧 ID 替换为新 ID（如将 class 3 改为 class 0） |
| 删除类别 | 删除所有标签文件中指定 ID 的标注框 |
| 重排序类别 | 通过多条 `原ID → 新ID` 规则对整个数据集类别编号重排 |

#### 2.4.2 输出选项

| 选项 | 说明 |
|---|---|
| 原地修改 | 直接覆盖原 TXT 文件（显示警告提示，建议先备份） |
| 输出到目录 | 将修改后的 TXT 写入指定新目录 |

**接口**：`POST /api/label/change-class`，`POST /api/label/delete-class`，`POST /api/label/reorder`

---

### 2.5 文件管理（File Manager）

**功能目标**：解决数据集常见的文件层面问题，保持文件整洁一致。

#### 2.5.1 图片-标签一致性检查

- 扫描图片目录和标签目录，找出：
  - 孤立图片（有图无标签）
  - 孤立标签（有标签无图）
- 返回汇总统计 + 文件列表

#### 2.5.2 删除空标签文件

- 扫描标签目录，找出所有 0 字节的 TXT 文件
- 支持**预览模式**（仅列出，不实际删除）
- 支持**执行模式**（实际删除，显示删除数量）

#### 2.5.3 为未标注图片创建空标签

- 对比图片目录和标签目录
- 为没有对应 TXT 的图片创建同名空 TXT
- 适用于"负样本"场景

#### 2.5.4 批量重命名

- 将图片和标签文件按序号统一重命名（如 `img_000001.jpg` + `img_000001.txt`）
- 用户可自定义前缀
- 支持**预览模式**（显示前 20 条重命名预览）
- 支持**执行模式**（原子操作，避免命名冲突）

#### 2.5.5 修复损坏图片

- 使用 PIL/Pillow 重新保存截断的 JPEG 文件
- 可调节输出 JPEG 质量（60-100）
- 支持预览模式（仅检测，不修复）

**接口**：`POST /api/file/check-consistency`，`POST /api/file/delete-empty-labels`，`POST /api/file/create-empty-labels`，`POST /api/file/batch-rename`，`POST /api/file/repair-images`

---

### 2.6 数据集划分（Dataset Split）

**功能目标**：将原始数据集按比例随机划分为 train/val/test 三个子集。

#### 2.6.1 输入参数

| 参数 | 说明 | 默认值 |
|---|---|---|
| 图片目录 | 原始图片所在目录 | — |
| 标签目录 | YOLO TXT 所在目录 | — |
| 输出目录 | 划分结果写入目录 | — |
| train 比例 | 训练集占比 | 0.8 |
| val 比例 | 验证集占比 | 0.1 |
| test 比例 | 测试集占比 | 0.1 |
| 随机种子 | 保证可复现 | 42 |
| 生成 data.yaml | 自动写入 YOLO 训练配置 | 开启 |
| 类别名称 | data.yaml 中的 names 列表 | — |

#### 2.6.2 输出结构

```
output_dir/
├── train/
│   ├── images/
│   └── labels/
├── val/
│   ├── images/
│   └── labels/
├── test/        # 若 test_ratio > 0
│   ├── images/
│   └── labels/
└── data.yaml    # 若生成 YAML
```

#### 2.6.3 约束

- train + val + test 比例之和必须等于 1.0（前端实时校验并显示进度条）
- test 比例为 0 时不生成 test 目录
- 若文件已存在则覆盖

**接口**：`POST /api/split/run`

---

### 2.7 图片标注（Annotation）

**功能目标**：在桌面端直接完成 YOLO 数据集的图片标注，支持手工画框、多边形与 AI 自动预标注，结果实时写回数据集目录。

#### 2.7.1 标注文件夹

- 支持标准布局（`images/` + `labels/`）与扁平布局（图片与同名 `.txt` 同目录）
- 只扫描一层目录，按文件名排序；左侧显示已标注 / 未标注数量
- 可选「标注输出目录」：指定后所有 `.txt` 写入该目录，否则写回数据集

#### 2.7.2 手工标注

| 能力 | 说明 |
|---|---|
| 矩形框 | 拖拽绘制，选中后可拖动移动、拖四角缩放 |
| 多边形 | 逐点点击，点首点或双击闭合，选中后可拖顶点 |
| 类别切换 | 右侧面板下拉选择，或右键菜单切换 |
| 删除 | `Delete` 键、右侧列表删除按钮、右键菜单 |
| 视图 | 平移（拖拽/中键）、滚轮锤点缩放、10%~400% |
| 撤销 | `Ctrl+Z` / `Ctrl+Shift+Z`，内存快照最多 50 步 |

- 每次编辑**自动保存**（250ms 防抖 + 串行队列），无保存按钮
- 空 `.txt` = 该图确认无目标；`.txt` 不存在 = 未标注
- 快捷键：`A/D` 切图、`H` 矩形、`P` 多边形、`Z` 平移；输入框内不触发

#### 2.7.3 AI 自动预标注

- 使用用户指定的 `.pt` 模型（留空则用内置 `models/yolov8m.pt`）
- 置信度阈值可调（0.05~0.9），默认 0.25
- 默认**跳过已有标注**（保护手工修正），可勾选「覆盖已有标注」重标
- 零检出图片也写空 `.txt`，以覆盖旧标注
- 后台任务 + 轮询进度（已处理/总数/当前文件/失败列表），可中途停止
- 分割模型输出多边形（复用同一 `read_label` 格式）

#### 2.7.4 数据集导出

| 模式 | 产物 |
|---|---|
| `raw` | `labels/` + `images/`（可选）+ `classes.txt`，不划分 |
| `detect` | `images|labels/{train,val}` + `classes.txt` + `data.yaml`，全部转矩形 |
| `segment` | 同上，矩形自动转 4 点多边形 |

- 默认 8:2 随机划分（seed 固定可复现），图片数 < 2 时给出 warning
- 输出目录重名时自动追加 `_2`、`_3`，不覆盖

**接口**：`POST /api/annotation/*`（list-images / image / read-label / write-label / scan-class-ids / parse-classes / auto-label / auto-label-status / auto-label-stop / export）

---

## 三、UI/UX 设计规范

### 3.1 整体视觉

- **主题**：深色模式（Dark Mode），背景色 `hsl(222, 47%, 8%)`
- **主色调**：蓝色 `hsl(217, 91%, 60%)`
- **卡片背景**：`hsl(222, 47%, 11%)`
- **字体**：系统默认无衬线字体（Inter / -apple-system）
- **圆角**：统一 `rounded-xl`（0.75rem）

### 3.2 布局结构

```
┌─────────────────────────────────────────┐
│  TopBar: 产品名 + 后端状态 + 重新配置   │
├──────────┬──────────────────────────────┤
│ Sidebar  │                              │
│          │      主内容区（页面组件）     │
│ 导航菜单 │                              │
│ 后端控制 │                              │
└──────────┴──────────────────────────────┘
```

### 3.3 启动流程（Setup Wizard）

1. **欢迎页面**：产品介绍，选择"使用 conda 环境"或"手动指定 Python"
2. **环境选择**：列出所有检测到的 conda 环境，标注缺失依赖
3. **确认启动**：显示配置摘要，点击完成后进入主界面

### 3.4 错误状态

- 所有 API 操作统一通过 `ResultBox` 组件展示结果（绿色成功 / 红色失败）
- 后端不可用时在 TopBar 显示红色状态点，侧边栏显示启动按钮

---

## 四、REST API 接口文档

### 公共约定

- Base URL：`http://127.0.0.1:8081`
- 所有接口返回 JSON，格式：`{ "success": bool, "message": str, ...其他字段 }`
- 可选 API Token 鉴权：请求头 `Authorization: Bearer <token>`
- Content-Type：`application/json`

### 4.1 健康检查

```
GET /health
响应: { "status": "ok", "version": "1.0.0" }
```

### 4.2 数据集分析

```
POST /api/dataset/analyze
请求体:
  yaml_path: str (与 image_dir/label_dir 二选一)
  image_dir: str
  label_dir: str
  class_names: { [id: str]: str }  // 可选

响应:
  success: bool
  message: str
  summary: {
    total_images: int, total_labels: int, total_boxes: int,
    num_classes: int, matched_pairs: int, orphan_images: int,
    empty_labels: int, invalid_rows: int
  }
  class_dist: [{ class_id: int, name: str, count: int, ratio: float }]
  image_stats: { min_w, max_w, avg_w, min_h, max_h, avg_h, common_size }
  bbox_stats: { avg_area_ratio, small_ratio, large_ratio, avg_aspect }
  orphan_image_list: str[]
  orphan_label_list: str[]
  empty_label_list: str[]
```

### 4.3 图片预览

```
POST /api/dataset/preview
请求体:
  image_path: str
  label_path: str (可选)
  class_names: { [id: str]: str }  // 可选

响应:
  success: bool
  image_b64: str  // base64 JPEG
  boxes: int      // 标注框数量
```

### 4.4 列出图片

```
POST /api/dataset/list-images
请求体:
  image_dir: str
  label_dir: str  // 可选
  filter: "all" | "labeled" | "unlabeled"

响应:
  success: bool
  images: [{ name: str, image_path: str, label_path: str | null, has_label: bool, box_count: int }]
  total: int
```

### 4.5 格式转换

```
POST /api/convert/labelme2yolo
POST /api/convert/voc2yolo
  请求体: { input_dir, output_dir, label_map: { name: id } }

POST /api/convert/yolo2voc
  请求体: { image_dir, label_dir, output_dir }

POST /api/convert/yolo-class-remap
  请求体: { label_dir, output_dir, remap: { old_id: new_id } }

响应: { success, message, converted: int, failed: int }
```

### 4.6 标签编辑

```
POST /api/label/change-class
  请求体: { label_dir, old_id, new_id, in_place, output_dir }

POST /api/label/delete-class
  请求体: { label_dir, class_id, in_place, output_dir }

POST /api/label/reorder
  请求体: { label_dir, order_map: { old_id: new_id }, in_place, output_dir }

响应: { success, message, processed: int }
```

### 4.7 文件管理

```
POST /api/file/check-consistency
  请求体: { image_dir, label_dir }
  响应: { success, message, total_images, total_labels, matched, orphan_images, orphan_labels, orphan_image_list, orphan_label_list }

POST /api/file/delete-empty-labels
  请求体: { label_dir, dry_run }
  响应: { success, message, count, files }

POST /api/file/create-empty-labels
  请求体: { image_dir, label_dir }
  响应: { success, message, count }

POST /api/file/batch-rename
  请求体: { image_dir, label_dir, prefix, dry_run }
  响应: { success, message, count, preview }

POST /api/file/repair-images
  请求体: { image_dir, quality, dry_run }
  响应: { success, message, count, failed }
```

### 4.8 数据集划分

```
POST /api/split/run
  请求体: { image_dir, label_dir, output_dir, train_ratio, val_ratio, test_ratio, seed, generate_yaml, class_names }
  响应: { success, message, counts: { train, val, test }, yaml_path }
```

---

## 五、非功能性需求

### 5.1 性能

- 数据集分析（10000 张以内）应在 30 秒内完成
- 图片预览加载时间 < 2 秒
- 大批量重命名（10000 文件）< 10 秒

### 5.2 兼容性

- 操作系统：Windows 10/11（优先），macOS 12+（次要）
- Python：3.9+，通过 conda 环境隔离

### 5.3 安全

- 后端仅监听 127.0.0.1，不对外暴露
- 可选 API Token 鉴权防止局域网误访问
- 不收集、不上传用户数据

### 5.4 错误处理

- 所有后端异常均返回 `{ success: false, message: "..." }`
- 前端统一通过 ResultBox 展示，不弹出系统对话框

---

## 六、版本规划

### v1.0.0（当前）

- [x] 项目框架搭建（Tauri + React + Flask）
- [x] SetupWizard conda 环境选择
- [x] 数据集质量检测
- [x] 数据集可视化
- [x] 格式转换（LabelMe/VOC/YOLO）
- [x] 标签编辑（替换/删除/重排序）
- [x] 文件管理（5 项工具）
- [x] 数据集划分

### v0.2.0（规划中）

- [ ] 数据集增强预览（旋转、翻转、色彩抖动可视化）
- [ ] 数据集合并（多个数据集合并、类别对齐）
- [ ] 标注框统计图表（面积分布直方图、宽高比散点图）
- [ ] 导出为 COCO JSON 格式

### v0.3.0（当前）

- [x] 图片标注（Canvas 手工画框 / 多边形 + AI 自动预标注 + 数据集导出）
- [ ] 图片去重（感知哈希）
- [ ] 自动数据清洗（删除无效标注框）
- [ ] 多数据集版本对比

---

*文档最后更新：2025 年*
