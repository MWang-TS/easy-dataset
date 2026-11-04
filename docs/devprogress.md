# Easy Dataset Station — 开发进度记录

> 更新时间：2026-11-04

---

## Phase 1 — 后端 Bug 修复与功能补全

### P1.1 修复 `analyze()` 四处 Bug（`services/dataset_service.py`）

| # | 问题 | 修复方式 |
|---|---|---|
| 1 | `invalid_rows` 未统计 | 新增计数器，对 `len(parts) < 5` 的非空行累加 |
| 2 | 小目标阈值错误（1% → 0.5%） | `a < 0.01` 改为 `a < 0.005` |
| 3 | 大目标阈值错误（25% → 10%） | `a > 0.25` 改为 `a > 0.10` |
| 4 | `image_size_stats` 缺少高度范围 | 补充 `min_height`、`max_height` 字段 |

### P1.2 实现 `list_images()` 服务端过滤（`services/dataset_service.py`）

- 新增参数 `filter: str = 'all'`，支持 `with_label` / `no_label` 两种过滤模式
- 路由 `POST /api/dataset/list-images` 同步透传 `filter` 参数（`routes/main_routes.py`）

### P1.3 添加 `box_count` 字段（`services/dataset_service.py`）

- `list_images()` 每条图片记录新增 `box_count`，通过读取对应 TXT 文件行数统计

### P1.4 添加 `class_distribution` 的 `ratio` 字段（`services/dataset_service.py`）

- 每个类别分布项补充 `ratio = count / total_boxes`，保留 4 位小数

### 前端类型同步（`src/lib/store.ts`、`src/lib/tauri-bridge.ts`）

| 文件 | 变更内容 |
|---|---|
| `store.ts` | `ClassDist` 加 `ratio: number` |
| `store.ts` | `DatasetSummary` 加 `invalid_rows: number` |
| `store.ts` | `DatasetAnalysis.image_size_stats` 加 `min_height`、`max_height` |
| `store.ts` | `ImageItem` 加 `box_count: number` |
| `tauri-bridge.ts` | `api.listImages` 参数签名加 `filter?` 可选参数 |

---

## Phase 2 — 前端 UI 完善

### P2.2 DatasetQuality.tsx — 孤立标签路径列表

- 问题文件折叠面板已包含三个 `FileList` 区块：孤立图片、**孤立标签**、空标签
- 渲染条件：`result.orphan_label_paths.length > 0`，路径以等宽字体滚动列表展示

### P2.3 FileManager.tsx — 一致性检查孤立路径渲染

- 一致性检查结果中，使用 `PathList` 组件渲染 `orphan_image_paths` 和 `orphan_label_paths`
- 标题带数量显示（如"孤立图片路径（共 N 个）"），最大高度 `max-h-36` 可滚动

### P2.4 FileManager.tsx — 批量重命名预览表格

- 执行/预览后，`result.preview`（最多 20 条 `RenameItem`）以两列表格展示
- 每行显示：旧文件名 `→` 新文件名，最大高度 `max-h-48` 可滚动

### P2.5 DatasetViewer.tsx — filter 参数传至后端

- 新增 `filterMap: { all: 'all', yes: 'with_label', no: 'no_label' }`
- `loadImages()` 调用 `api.listImages` 时传入 `filter: filterMap[activeFilter]`
- 过滤在服务端完成，返回结果直接渲染，不再做客户端二次过滤

---

## Phase 3 — v0.2.0 新功能开发

### P3.1 COCO JSON 导出

**后端**：新建 `services/export_service.py`

- `ExportService.yolo2coco(image_dir, label_dir, output_path, class_names?)` 
- YOLO 归一化坐标 → COCO 绝对像素坐标转换：`x_min = (cx - w/2) * W`
- COCO `category_id` 从 1 开始（YOLO `class_id` 从 0 开始）
- 未提供 `class_names` 时自动预扫描所有 TXT，生成 `class_N` 命名
- 返回：`total_images`、`total_annotations`、`skipped`

**路由**：`POST /api/export/coco`（`routes/main_routes.py`）

**前端**：`src/pages/DatasetExport.tsx`（COCO 导出区域）
- 图片目录、标签目录、输出文件（另存为对话框）、类别名称输入
- 导出结果带数量统计

---

### P3.2 数据集合并

**后端**：新建 `services/merge_service.py`

- `MergeService.merge(sources, output_image_dir, output_label_dir, prefix_by_source?)`
- `sources` 列表每项支持：`image_dir`、`label_dir`、`class_offset`（整数偏移）、`class_remap`（字典映射）
- 文件名冲突自动追加来源编号后缀（如 `img001_s2.jpg`）
- 返回：`total_images`、`total_labels`、`conflicts`、`errors`

**路由**：`POST /api/merge/run`（`routes/main_routes.py`）

**前端**：`src/pages/DatasetMerge.tsx`
- 动态来源列表（可增删），每项配置图片目录、标签目录、类别偏移量
- 输出目录配置 + 文件名前缀开关
- 合并结果面板：数量统计 + 可折叠警告列表

---

### P3.3 数据增强预览

**后端**：新建 `services/augment_service.py`

支持 8 种增强类型，**bbox 坐标同步变换**：

| 增强类型 | PIL 操作 | bbox 变换规则 |
|---|---|---|
| `flip_h` 水平翻转 | `FLIP_LEFT_RIGHT` | `cx → 1 - cx` |
| `flip_v` 垂直翻转 | `FLIP_TOP_BOTTOM` | `cy → 1 - cy` |
| `rotate90` 旋转 90° CW | `ROTATE_270` | `(cx,cy,w,h) → (1-cy, cx, h, w)` |
| `rotate180` 旋转 180° | `ROTATE_180` | `(cx,cy) → (1-cx, 1-cy)` |
| `rotate270` 旋转 270° CW | `ROTATE_90` | `(cx,cy,w,h) → (cy, 1-cx, h, w)` |
| `brightness` 提高亮度 | `ImageEnhance.Brightness × 1.6` | bbox 不变 |
| `contrast` 提高对比度 | `ImageEnhance.Contrast × 1.6` | bbox 不变 |
| `grayscale` 灰度化 | `L → RGB` | bbox 不变 |

- `AugmentService.preview()` 返回原图 + 各增强结果的 base64 JPEG 列表
- 预览尺寸限制 480px（避免传输过慢）

**路由**：`POST /api/augment/preview`、`GET /api/augment/list`（`routes/main_routes.py`）

**前端**：`src/pages/AugmentPreview.tsx`
- 增强类型多选标签（全选 / 清空）
- 响应式网格展示增强结果（含 bbox 绘制）

---

### P3.4 BBox 统计图表

**后端**：`DatasetService.bbox_histogram(label_dir)` 新方法（`services/dataset_service.py`）

面积分布分档：

| 区间 | 说明 |
|---|---|
| < 0.1% | 极小目标 |
| 0.1–0.5% | 小目标 |
| 0.5–1% | 较小目标 |
| 1–5% | 中小目标 |
| 5–10% | 中目标 |
| 10–25% | 较大目标 |
| > 25% | 大目标 |

宽高比分布分档：`< 0.25`、`0.25–0.5`、`0.5–1.0`、`1.0–2.0`、`2.0–4.0`、`> 4.0`

**路由**：`POST /api/dataset/bbox-histogram`（`routes/main_routes.py`）

**前端**：`src/pages/DatasetExport.tsx`（统计图表区域）
- 输入标签目录，生成面积分布 + 宽高比分布 CSS 条形图
- 两个图表独立可折叠

---

### 前端集成（`src/pages/MainPage.tsx`、`src/lib/tauri-bridge.ts`、`src/lib/store.ts`）

**导航栏新增 3 项：**

| 页面 ID | 菜单文字 | 图标 |
|---|---|---|
| `export` | 导出 & 图表 | `Download` |
| `merge` | 数据集合并 | `GitMerge` |
| `augment` | 增强预览 | `Wand2` |

**`tauri-bridge.ts` 新增方法：**
- `browseSaveFile()` — 文件另存为对话框
- `api.bboxHistogram()` — BBox 直方图
- `api.exportCoco()` — COCO 导出
- `api.mergeDatasets()` — 数据集合并
- `api.augmentPreview()` — 增强预览

**`store.ts` 类型扩展：**
- `activePage` 联合类型增加 `"export" | "merge" | "augment"`

---

## Phase 4 — 图片标注模块（v0.3.0）

> 实现参考 `easy-finetune` 的 `wiki/Annotation-Implementation-Guide.md`，
> 宿主层由 Tauri IPC 改为 Flask REST（算法与数据契约保持一致）。

### P4.1 后端标注服务（`services/annotation_service.py`）

| 能力 | 说明 |
|---|---|
| `list_images(dir_path, label_output_dir)` | 支持 `images/*`、`images/train|val/*`（split 布局，自动展开子目录）与扁平结构；返回 `box_count` |
| `detect_class_file(dir_path)` | 打开文件夹时自动解析：`data.yaml`/`dataset.yaml`/`classes.txt`/`obj.names`（含 `labels/` 子目录），向上找 3 层 |
| `read_label(label_path)` | 矩形行（5 列）与多边形 seg 行（`class + ≥6 坐标`）分别解析；文件缺失返回空数组 |
| `write_label(label_path, boxes)` | 空列表写空文件（= 确认无目标）；`tmp + os.replace` 原子替换 |
| `read_image(image_path, max_dim)` | 返回 base64 data URL，长边超过 2560 自动缩小；不做 EXIF 旋转（与训练侧一致） |
| `scan_class_ids()` | 无类别定义时，从已有标注推断 id 列表 |
| `parse_class_file()` | 服务端解析 `classes.txt` / `data.yaml` 的 `names`（避免 Tauri fs scope 限制） |
| `start_auto_label()` | 后台线程跑 ultralytics，轮询进度；`overwrite=false` 时跳过已有 `.txt` |
| `export_dataset()` | `raw` / `detect` / `segment` 三种模式；随机划分 train/val；自动补 `classes.txt`、`data.yaml` |

路径推导规则（前后端一致）：

| 场景 | 目标路径 |
|---|---|
| 指定 `label_output_dir` | `<output>/<stem>.txt` |
| 路径中有 `images` 目录段 | 该段替换为 `labels`（`images/train/a.jpg` → `labels/train/a.txt`） |
| 扁平结构 | 与图片同目录 `<stem>.txt` |

> 修复记录：早期实现只判断「父目录是否叫 images」，导致 `images/train/a.jpg` 的标签被推导到
> `images/train/a.txt`（不存在）→ 标注页显示「0 张已标注」、类别为空。现改为替换任意层级的
> `images` 目录段。

### P4.2 REST 路由（`routes/main_routes.py`）

```
POST /api/annotation/list-images
POST /api/annotation/image
POST /api/annotation/read-label
POST /api/annotation/write-label
POST /api/annotation/scan-class-ids
POST /api/annotation/parse-classes
POST /api/annotation/auto-label-check
POST /api/annotation/auto-label
POST /api/annotation/auto-label-status
POST /api/annotation/auto-label-stop
POST /api/annotation/export
```

### P4.3 前端状态与 IO（`src/lib/annotation-store.ts`）

- `openFolder` / `loadImage`（带请求序号，避免快速切图错位）
- 每次编辑自动落盘：250ms 防抖 + 串行保存队列，切图前强制 `flushSave()`
- 撤销 / 重做（内存快照，最多 50 步）
- 自动标注：启动 → 600ms 轮询进度 → 完成后刷新列表并重载当前图

### P4.4 Canvas 标注器（`src/components/annotate/AnnotationCanvas.tsx`）

- 三层坐标换算：图片逻辑像素 / CSS 显示像素 / 鼠标事件坐标
- 命中顺序：多边形顶点 → 多边形内部 → 矩形角手柄 → 矩形内部 → 空白（画新框）
- 支持：拖动移动、拖角缩放、多边形顶点拖动、滚轮锚点缩放、右键菜单改类别/删除
- 快捷键：`A/D` 切换图片、`H` 矩形、`P` 多边形、`Z` 平移、`Delete` 删除、`Ctrl+Z` 撤销
  —— **所有快捷键均先判断 `isTyping`**（输入框内不触发），修复了参考实现的已知缺陷

### P4.5 标注页面（`src/pages/Annotation.tsx`）

- 左侧配置栏（portal）分两种模式：
  - **已有数据集修改**：数据集路径 / 图像文件夹（可选）/ 标注文件夹（可选）/ 类别定义文件路径 / 标注输出路径（可选，留空原地修改）
    - 图像、标注目录用于子文件夹命名不规整的数据集（如 `temp/img` + `temp/labels`），留空仍按 `images`/`labels` 推断
    - 两个目录同时作用于列表、类别扫描、自动标注与导出
  - **全新标注**：数据集路径（纯图片）/ 标注输出路径（必填）/ 类别名称（逗号分隔，按序生成 class 0/1/2…）
- 其余：AI 自动预标注（模型、置信度、覆盖开关、进度） / 数据集导出
- 主区域：工具栏（切图、模式、缩放、撤销重做、删除、保存状态）+ Canvas + 右侧面板（新框类别、框列表、类别管理）
- 导航栏新增「图片标注」入口（`PenTool`）
- 打开文件夹后显示图片数量 / 已标注数 / **标注类型**（目标检测 / 分割 / 混合 / 无标注，抽样前 500 个非空标签统计）
  - 检测类型 → 禁用「多边形」按钮；分割类型 → 禁用「矩形」按钮；混合/无标注 → 两者都可用

---

## 文件变更清单

### 新建文件

| 文件 | 用途 |
|---|---|
| `services/export_service.py` | COCO JSON 导出服务 |
| `services/merge_service.py` | 数据集合并服务 |
| `services/augment_service.py` | 数据增强预览服务 |
| `services/annotation_service.py` | 图片标注服务（标注读写 + AI 预标注 + 导出） |
| `src/pages/DatasetExport.tsx` | 导出 & 统计图表页面 |
| `src/pages/DatasetMerge.tsx` | 数据集合并页面 |
| `src/pages/AugmentPreview.tsx` | 增强预览页面 |
| `src/pages/Annotation.tsx` | 图片标注页面 |
| `src/lib/annotation-store.ts` | 标注状态与保存队列 |
| `src/components/annotate/AnnotationCanvas.tsx` | Canvas 2D 标注器 |

### 修改文件

| 文件 | 变更摘要 |
|---|---|
| `services/dataset_service.py` | 修复 4 个 Bug；`list_images()` 加 filter/box_count；新增 `bbox_histogram()` |
| `routes/main_routes.py` | 导入 3 个新 service；新增 5 条路由；list-images 透传 filter 参数 |
| `src/lib/store.ts` | 类型补全：`ClassDist.ratio`、`DatasetSummary.invalid_rows`、`image_size_stats` height 字段、`ImageItem.box_count`；`activePage` 扩展 3 个新值 |
| `src/lib/tauri-bridge.ts` | 导入 `save`；新增 `browseSaveFile`；`api` 扩展 4 个新方法；`listImages` 加 filter 参数 |
| `src/pages/MainPage.tsx` | 导入 3 个新页面组件；NAV_ITEMS 增加 3 项；pages 映射注册 3 个新页面 |

---

## 2026-11-03 标注模块增强（检测 / 旋转框 / 分割）

### 新增能力

| # | 功能 | 说明 |
|---|---|---|
| 1 | 三种标注类型 | 全新标注可选「目标检测 / 旋转框 / 分割」，选定后同一工作内锁定不可改（记录持久化） |
| 2 | 旋转框（OBB） | 按「矩形 + 角度」建模：拖拽出矩形 → 拖框顶圆点旋转 → 拖角点缩放；右侧面板可输入角度；导出 8 坐标 |
| 3 | 类型互斥 | 检测仅矩形；分割仅多边形；旋转框仅旋转框工具（工具栏 + 平移/编辑开关 + 快捷键均受约束） |
| 4 | 复制粘贴 | `Ctrl+C` / `Ctrl+V` 复制粘贴标注框（跨图片），右键菜单与工具栏按钮同步；粘贴带偏移、可撤销 |
| 5 | 清晰矢量层 | 画布拆为「底图 + 叠加层」，叠加层按设备像素重绘，放大时框线/多边形不失真 |
| 6 | 画布性能与安全 | 叠加层后备缓冲限制 4096px / 16M 像素，底图超 4096px 自动降采样，避免超大图崩溃 |
| 7 | 质量检测增强 | 统计矩形 / 多边形 / 旋转框行数，标注类型卡片；面积与宽高比按真实几何计算 |
| 8 | 全链路支持三种格式 | 数据质量、可视化预览、数据增强、COCO 导出、VOC 转换、LabelMe 转换均按矩形/多边形/旋转框分别处理 |
| 9 | 模型不限 YOLOv8 | 自动标注与智能抽帧统一走 ultralytics；抽帧兼容 OBB 模型（读 `result.obb`）；新增模型格式与任务校验 |

### 修复

- 数据集导出循环内 `label_dir` / `image_dir` 变量覆盖参数，导致第 2 张图起读不到标注（丢标签）。
- 质量检测把多边形行第 3/4 个数字当作 w/h，面积、宽高比、大小目标统计全错。
- 智能抽帧只读 `result.boxes`，OBB 模型抽不到任何帧。
- 「平移 → 编辑」切回时恢复成矩形工具，旋转框类型下只能画垂直框。
- 旧工作记录的标注类型会静默覆盖用户本次选择。

### 新增文件

| 文件 | 用途 |
|---|---|
| `services/label_format.py` | 统一 YOLO 标签行解析/格式化（矩形 / 多边形 / 旋转矩形判定） |
| `services/model_utils.py` | 模型文件格式与任务类型校验 |
| `src/lib/obb.ts` | 旋转框几何：角点、反解、角点缩放、旋转手柄 |

---

## 2026-11-03 客户端运行时不弹后端终端窗口

| 位置 | 处理 |
|---|---|
| `src-tauri/src/main.rs` | release 构建使用 `windows_subsystem = "windows"`（已核实产物 PE Subsystem = 2/GUI） |
| `src-tauri/src/lib.rs` | 运行时兜底：release 下调用 `GetConsoleWindow` + `ShowWindow(SW_HIDE)` 隐藏任何意外控制台 |
| `src-tauri/src/commands/backend.rs` | 启动 Python 后端已带 `CREATE_NO_WINDOW`；新增 `terminate_child()`，Windows 下用 `taskkill /T /F` 连带子进程结束，避免 ffmpeg 残留窗口 |
| `services/proc.py`（新增） | `no_window_kwargs()` 供显式调用；`patch_popen_no_window()` 在嵌入式模式下把所有 `subprocess` 默认设为 `CREATE_NO_WINDOW` |
| `services/ai_video_service.py` | ffmpeg 分段子进程加 `no_window_kwargs()` 与 `-nostdin`，不再弹出黑色窗口 |
| `app.py` | 启动时（仅 `EASY_DATASET_EMBEDDED=1`）打 `subprocess` 补丁，覆盖 ultralytics / pip 等第三方派生的子进程 |

验证：`cargo build --release` 通过；PE 子系统 = 2（GUI）；`patch_popen_no_window()` 生效且子进程可正常执行；Python/TS 全量语法与类型检查通过。

---

## 2026-11-04 版本号统一升级到 v1.0.0

| 文件 | 变更 |
|---|---|
| package.json / package-lock.json | version 升级为 1.0.0（构建期通过 __APP_VERSION__ 注入前端） |
| src-tauri/tauri.conf.json | 安装包版本 1.0.0 |
| src-tauri/Cargo.toml / Cargo.lock | crate 版本 1.0.0（CARGO_PKG_VERSION 用于后端资源同步判定，升级后首次启动会全量同步一次） |
| docs/PRD.md | 文档版本、/health 示例、版本规划标题改为 v1.0.0 |

验证：
pm run build 产物中 APP_VERSION = 1.0.0；cargo check --release 编译 easy-dataset v1.0.0 通过；全仓扫描（排除依赖与构建产物）无旧版本号残留。

---

## 2026-11-04 系统管理新增「环境依赖」页签（支持 Easy Conda 导出）

| 文件 | 变更 |
|---|---|
| `services/env_service.py`（新增） | 读取 `requirements.txt` 生成分组依赖清单（Python 运行时 / 系统工具 / 必装 pip / AI 可选），并生成标准 conda `environment.yml`；探测当前环境已安装版本 |
| `routes/main_routes.py` | 新增 `GET/POST /api/env/dependencies`（参数 `include_ai`） |
| `src/lib/tauri-bridge.ts` | 新增 `api.envDependencies()` 类型定义 |
| `src/pages/MainPage.tsx` | 系统管理弹窗新增「环境依赖」页签：依赖分组列表、已安装版本标记、AI 依赖开关、导出 environment.yml（另存为对话框）、Easy Conda 入口 |
| `src/lib/links.ts` | 新增 `EASY_CONDA_URL` |
| 三语 i18n | `settings.tabDeps` 等 10 个文案 + `common.retry` |
| `README.md` | 功能表补充 |

导出的 `environment.yml` 可直接在 Easy Conda（https://easyconda.tsagent.cc/）「导入 environment.yml」创建同款环境；手动等价命令 `conda env create -f environment.yml`。

验证：接口 `include_ai=true/false` 均 200，YAML 可被 PyYAML 解析（name/channels/dependencies + pip 子列表）；`npx tsc --noEmit` 与 `npm run build` 通过。

---

## 2026-11-04 v1.0.1 修复：升级安装后后端仍跑旧代码（接口 404 / Failed to fetch）

### 现象

安装 1.0.0 后，标注页、系统管理·环境依赖等新功能全部失败：
控制台 `TypeError: Failed to fetch`，后端日志里 `/api/annotation/*` 与 `/api/env/*` 全为 404，
而 `/api/dataset/*` 等旧接口正常。

### 根因

1. 旧版（0.1.0）把后端运行目录记在 localStorage 的 `config.appDir`（`backend_runtime`，**不区分版本**），
   该目录里是 **0.1.0 的后端代码**；
2. 前端只有在 `config.appDir` 为空时才调用 `getAppDir()`，而"资源同步"恰恰只写在 `get_app_dir` 里——
   于是**升级后正常启动路径根本不会同步**，后端继续用旧代码起服务，新接口自然 404；
3. 同步逻辑本身还会 `remove_dir_all` 整个不区分版本的目录，可能清掉正在被运行中进程使用的文件；
4. NSIS 会把 `../app.py` 这类资源放进 `_up_` 子目录，`resource_dir/app.py` 并不存在，只能靠 BFS 兜底，
   布局与代码假设不一致，升级场景更容易踩空。

### 修复

| 位置 | 改动 |
|---|---|
| `src-tauri/src/commands/backend.rs` | 新增 `ensure_backend_runtime()`：运行目录改为 `backend_runtime/<版本>`，按版本隔离；同版本重复启动时尽力清空（失败不致命，直接覆盖）；同步后清理旧版本目录（尽力而为）；`get_app_dir` 复用该函数 |
| `src-tauri/src/lib.rs` | `setup()` 中**无条件**同步一次后端资源，不再依赖前端 invoke |
| `src/pages/MainPage.tsx` | 每次启动后端前都向 Rust 取当前版本运行目录，与持久化配置不一致时回写，避免沿用旧路径 |
| `.github/workflows/release.yml` | 1.0.x 以 pre-release 发布；补充 1.0.1 修复说明 |
| 版本 | package / tauri.conf / Cargo.toml / Cargo.lock / PRD → 1.0.1 |

### 验证

- `cargo check --release`、`cargo build --release` 通过；`npx tsc --noEmit` 通过
- 旧安装可直接覆盖安装 1.0.1：启动时后端运行目录变为 `backend_runtime/1.0.1`，新接口可用
- 预发布构建仍不进 `latest.json` 自动更新通道
