/**
 * DatasetViewer.tsx
 * 数据集可视化：按标签类别浏览图片，支持预览 YOLO 标注框。
 */
import { useState, useCallback, useEffect, useRef } from "react";
import {
  FolderOpen, ChevronLeft, ChevronRight, Image as ImageIcon,
  Loader2, FileText,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import { browseDirectory, browseFile, api } from "@/lib/tauri-bridge";
import type { ImageItem } from "@/lib/store";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 50;

// 过滤模式：'all' | 'no_label' | number（类别索引）
type FilterMode = 'all' | 'no_label' | number;

interface Counts {
  all: number;
  labeled: number;
  unlabeled: number;
  class_counts: Record<number, number>;
}

export default function DatasetViewer() {
  const { t } = useTranslation();
  const { currentDatasetDir, currentLabelDir, currentYamlPath, currentClassNames, setDatasetContext } = useAppStore();

  const [imageDir, setImageDir] = useState(currentDatasetDir);
  const [labelDir, setLabelDir] = useState(currentLabelDir);
  const [yamlPath, setYamlPath] = useState(currentYamlPath);
  const [classNames, setClassNames] = useState<string[]>(currentClassNames);
  const [yamlLoading, setYamlLoading] = useState(false);

  const [images, setImages] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [previewB64, setPreviewB64] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [page, setPage] = useState(0);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Counts | null>(null);
  const sidebarEl = useSidebarEl();

  // ── 缩放 & 平移状态 ──
  const [viewScale, setViewScale] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const transformRef = useRef({ s: 1, x: 0, y: 0 });
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewImgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef({ mx: 0, my: 0, tx: 0, ty: 0 });
  const isDraggingRef = useRef(false);

  const applyTransform = useCallback((s: number, x: number, y: number) => {
    transformRef.current = { s, x, y };
    if (previewImgRef.current) {
      previewImgRef.current.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    }
  }, []);

  const resetView = useCallback(() => {
    applyTransform(1, 0, 0);
    setViewScale(1);
  }, [applyTransform]);

  // 新图片加载时重置视图
  useEffect(() => { resetView(); }, [previewB64]); // eslint-disable-line react-hooks/exhaustive-deps

  // 鼠标滚轮缩放（非被动，支持以鼠标为中心缩放）
  useEffect(() => {
    const el = previewContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const { s, x, y } = transformRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const ns = Math.max(0.05, Math.min(30, s * factor));
      const r = ns / s;
      applyTransform(ns, mx * (1 - r) + x * r, my * (1 - r) + y * r);
      setViewScale(ns);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyTransform]);

  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = { mx: e.clientX, my: e.clientY, tx: transformRef.current.x, ty: transformRef.current.y };
  }, []);

  const handlePreviewMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const { mx, my, tx, ty } = dragStartRef.current;
    const nx = tx + e.clientX - mx;
    const ny = ty + e.clientY - my;
    transformRef.current.x = nx;
    transformRef.current.y = ny;
    if (previewImgRef.current) {
      previewImgRef.current.style.transform = `translate(${nx}px, ${ny}px) scale(${transformRef.current.s})`;
    }
  }, []);

  const handlePreviewMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  // 解析 YAML：自动填充目录和类别名
  const handleParseYaml = useCallback(async () => {
    if (!yamlPath) return;
    setYamlLoading(true);
    setError(null);
    try {
      const res = await (api as any).parseYaml({ yaml_path: yamlPath }) as {
        success: boolean; message?: string;
        image_dir: string; label_dir: string; class_names: string[];
      };
      if (!res.success) { setError(res.message || t('viewer.parseFailed')); return; }
      setImageDir(res.image_dir);
      setLabelDir(res.label_dir);
      setClassNames(res.class_names);
      setDatasetContext({ imageDir: res.image_dir, labelDir: res.label_dir, yamlPath, classNames: res.class_names });
    } catch (e) {
      setError(String(e));
    } finally {
      setYamlLoading(false);
    }
  }, [yamlPath, setDatasetContext]);

  const loadImages = useCallback(async (overridePage?: number, overrideFilter?: FilterMode) => {
    if (!imageDir) return;
    const p = overridePage ?? 0;
    const fm = overrideFilter !== undefined ? overrideFilter : filterMode;
    setLoading(true);
    setError(null);
    setImages([]);
    setThumbnails({});
    try {
      const params: Record<string, unknown> = {
        image_dir: imageDir,
        label_dir: labelDir,
        page: p,
        page_size: PAGE_SIZE,
      };
      if (fm === 'all') {
        params.filter = 'all';
      } else if (fm === 'no_label') {
        params.filter = 'no_label';
      } else {
        // 按类别过滤
        params.filter = 'all';
        params.class_filter = fm;
      }
      const res = await api.listImages(params as Parameters<typeof api.listImages>[0]) as {
        success: boolean; message?: string;
        images: ImageItem[]; total: number;
        counts?: Counts;
      };
      if (!res.success) { setError(res.message || t('viewer.loadFailed')); return; }
      setImages(res.images);
      setTotal(res.total);
      if (res.counts) setCounts(res.counts);
      setPage(p);
      setSelectedIdx(null);
      setPreviewB64(null);
      if (res.images.length > 0) {
        const paths = res.images.map((i: ImageItem) => i.image_path);
        api.thumbnails({ paths }).then((r: unknown) => {
          const tr = r as { success: boolean; thumbnails: Record<string, string> };
          if (tr.success) setThumbnails(tr.thumbnails);
        }).catch(() => {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageDir, labelDir, filterMode]);

  const loadPreview = useCallback(async (item: ImageItem) => {
    setPreviewLoading(true);
    setPreviewB64(null);
    try {
      const res = await api.previewImage({
        image_path: item.image_path,
        label_path: item.label_path || "",
        class_names: classNames,
      }) as { success: boolean; image_b64?: string; message?: string };
      if (res.success && res.image_b64) {
        setPreviewB64(res.image_b64);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setPreviewLoading(false);
    }
  }, [classNames]);

  const pageCount = Math.ceil(total / PAGE_SIZE);

  // 构建过滤器按钮列表
  // 类别来源：class_counts 的索引 + classNames，两者合并去重，按索引排序
  const classCounts = counts?.class_counts ?? {};
  const classIdxs = Array.from(
    new Set([...Object.keys(classCounts).map(Number), ...classNames.map((_, i) => i)])
  ).sort((a, b) => a - b);
  const filterButtons: { key: FilterMode; label: string; count: number }[] = [
    { key: 'all', label: t('viewer.all'), count: counts?.all ?? 0 },
    ...classIdxs.map((idx) => ({
      key: idx as FilterMode,
      label: classNames[idx] ? `${classNames[idx]}` : `类别 ${idx}`,
      count: classCounts[idx] ?? 0,
    })),
    { key: 'no_label', label: t('viewer.noLabel'), count: counts?.unlabeled ?? 0 },
  ];
  const hasClassFilter = counts !== null && classIdxs.length > 0;

  const leftPanel = (
    <div className="py-4 flex flex-col gap-4">
      {/* 配置区 */}
      <div className="rounded-xl p-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* YAML 解析 */}
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: "hsl(var(--muted-foreground))", display: "block", marginBottom: 10 }}>{t('viewer.yamlConfig')}</label>
          <div className="flex gap-1.5">
            <input
              className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
              value={yamlPath} onChange={(e) => setYamlPath(e.target.value)}
              placeholder={t('viewer.yamlPlaceholder')}
            />
            <button className="px-2.5 py-2 rounded-md flex-shrink-0"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
              onClick={async () => {
                const f = await browseFile([{ name: 'YAML', extensions: ['yaml', 'yml'] }]);
                if (f) setYamlPath(f);
              }}>
              <FolderOpen className="w-4 h-4" />
            </button>
            <button
              className="px-2.5 py-2 rounded-md flex-shrink-0 disabled:opacity-50"
              style={{ background: "hsl(var(--primary))", color: "#fff" }}
              title="解析 YAML，自动填充目录和类别名"
              onClick={handleParseYaml}
              disabled={!yamlPath || yamlLoading}
            >
              {yamlLoading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <FileText className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <MiniPathInput label={t('common.imageDir')} value={imageDir} onChange={setImageDir}
          onBrowse={async () => { const d = await browseDirectory(); if (d) { setImageDir(d); setDatasetContext({ imageDir: d }); } }} />
        <MiniPathInput label={t('common.labelDir')} value={labelDir} onChange={setLabelDir}
          onBrowse={async () => { const d = await browseDirectory(); if (d) { setLabelDir(d); setDatasetContext({ labelDir: d }); } }} />
        <button
          className="w-full py-2 rounded-md text-sm font-semibold disabled:opacity-50"
          style={{ background: "hsl(var(--primary))", color: "#fff" }}
          onClick={() => loadImages(0)}
          disabled={loading || !imageDir}
        >
          {loading ? t('common.loading') : t('viewer.loadImages')}
        </button>
      </div>

      {error && <div className="text-xs px-1" style={{ color: "hsl(var(--destructive))" }}>{error}</div>}

      {/* 图片列表卡片：顶部内嵌类别筛选 chips */}
      <div className="rounded-xl overflow-hidden flex flex-col" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>

        {/* 类别筛选 chips（加载数据后显示） */}
        {hasClassFilter && (
          <div className="p-2 flex flex-wrap gap-1 border-b" style={{ borderColor: "hsl(var(--border))" }}>
            {filterButtons.map(({ key, label, count }) => {
              const isActive = filterMode === key;
              const isClass = typeof key === 'number';
              return (
                <button
                  key={String(key)}
                  className="px-3 py-0.5 rounded-md text-[11px] font-medium whitespace-nowrap"
                  style={{
                    background: isActive ? "hsl(var(--primary))" : "hsl(var(--muted))",
                    color: isActive ? "#fff" : "hsl(var(--muted-foreground))",
                    border: isActive ? "1px solid transparent" : "1px solid hsl(var(--border))",
                  }}
                  onClick={() => { setFilterMode(key); loadImages(0, key); }}
                >
                  {isClass && <span className="opacity-60 mr-1">[{key as number}]</span>}
                  {label}
                  <span className="ml-2 opacity-50">({count})</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 无类别时的简易全部/有标签/无标签 */}
        {counts !== null && !hasClassFilter && (
          <div className="p-2 flex gap-1 border-b" style={{ borderColor: "hsl(var(--border))" }}>
            {(['all', 'no_label'] as FilterMode[]).map((k) => {
              const isActive = filterMode === k;
              const label = k === 'all' ? `${t('viewer.all')} (${counts.all})` : `${t('viewer.noLabel')} (${counts.unlabeled})`;
              return (
                <button key={String(k)}
                  className="flex-1 py-1 rounded-md text-xs"
                  style={{
                    background: isActive ? "hsl(var(--primary))" : "hsl(var(--muted))",
                    color: isActive ? "#fff" : "hsl(var(--muted-foreground))",
                  }}
                  onClick={() => { setFilterMode(k); loadImages(0, k); }}
                >{label}</button>
              );
            })}
          </div>
        )}

        {/* 缩略图列表 */}
        <div className="overflow-y-auto" style={{ maxHeight: "380px" }}>
          {loading && (
            <div className="flex items-center justify-center p-6">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: "hsl(var(--muted-foreground))" }} />
            </div>
          )}
          {!loading && images.map((item, i) => (
            <button
              key={item.image_path}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left transition-all"
              style={{
                background: selectedIdx === i ? "hsl(var(--primary) / 0.12)" : "transparent",
                borderBottom: "1px solid hsl(var(--border))",
              }}
              onClick={() => { setSelectedIdx(i); loadPreview(item); }}
            >
              {thumbnails[item.image_path] ? (
                <img
                  src={`data:image/jpeg;base64,${thumbnails[item.image_path]}`}
                  className="w-10 h-10 rounded object-cover flex-shrink-0"
                  alt=""
                />
              ) : (
                <div className="w-10 h-10 rounded flex-shrink-0 flex items-center justify-center"
                  style={{ background: "hsl(var(--muted))" }}>
                  <div className="w-2 h-2 rounded-full"
                    style={{ background: item.has_label ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">{item.filename}</div>
                {item.box_count > 0 && (
                  <div className="text-xs opacity-50">{t('viewer.boxCount', { count: item.box_count })}</div>
                )}
              </div>
            </button>
          ))}
          {!loading && images.length === 0 && (
            <div className="p-4 text-sm text-center" style={{ color: "hsl(var(--muted-foreground))" }}>
              {counts === null ? t('viewer.loadFirst') : t('viewer.emptyFilter')}
            </div>
          )}
        </div>
      </div>

      {/* 分页 */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between">
          <button disabled={page === 0} onClick={() => loadImages(page - 1)}
            className="p-1 rounded disabled:opacity-30" style={{ background: "hsl(var(--muted))" }}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
            {page + 1} / {pageCount}
          </span>
          <button disabled={page >= pageCount - 1} onClick={() => loadImages(page + 1)}
            className="p-1 rounded disabled:opacity-30" style={{ background: "hsl(var(--muted))" }}>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(leftPanel, sidebarEl)}
      <div
        ref={previewContainerRef}
        className="rounded-md overflow-hidden relative select-none"
        style={{
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--border))",
          minHeight: "calc(100vh - 130px)",
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
        onMouseDown={handlePreviewMouseDown}
        onMouseMove={handlePreviewMouseMove}
        onMouseUp={handlePreviewMouseUp}
        onMouseLeave={handlePreviewMouseUp}
      >
        {previewLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "hsl(var(--muted-foreground))" }} />
          </div>
        ) : previewB64 ? (
          <>
            <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
              <img
                ref={previewImgRef}
                src={`data:image/jpeg;base64,${previewB64}`}
                alt="preview"
                className="max-w-full max-h-full object-contain"
                style={{
                  transform: 'translate(0px, 0px) scale(1)',
                  transformOrigin: 'center center',
                  willChange: 'transform',
                  pointerEvents: 'none',
                }}
                draggable={false}
              />
            </div>
            {/* 缩放提示 & 重置 */}
            <div
              className="absolute bottom-3 right-3 flex items-center gap-2"
              onMouseDown={e => e.stopPropagation()}
              style={{ pointerEvents: 'auto' }}
            >
              <span style={{ fontSize: 11, color: '#aaa', background: 'rgba(0,0,0,0.55)', padding: '2px 7px', borderRadius: 4 }}>
                {Math.round(viewScale * 100)}%
              </span>
              <button
                onClick={e => { e.stopPropagation(); resetView(); }}
                style={{ fontSize: 11, color: '#ccc', background: 'rgba(0,0,0,0.55)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.12)', cursor: 'pointer' }}
              >
                重置
              </button>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center" style={{ color: "hsl(var(--muted-foreground))" }}>
              <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">点击左侧图片查看预览</p>
              <p className="text-xs mt-1">支持 YOLO 格式标注框叠加显示</p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function MiniPathInput({ label, value, onChange, onBrowse }: {
  label: string; value: string; onChange: (v: string) => void; onBrowse: () => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "hsl(var(--muted-foreground))", display: "block", marginBottom: 10 }}>{label}</label>
      <div className="flex gap-1.5">
        <input
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={`${label}路径`}
        />
        <button className="px-2.5 py-2 rounded-md flex-shrink-0" style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
          onClick={onBrowse}>
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
