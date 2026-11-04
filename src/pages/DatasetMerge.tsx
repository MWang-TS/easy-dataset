/**
 * DatasetMerge.tsx
 * 数据集合并页：将多个 YOLO 数据集合并为一个，支持类别 ID 偏移和重映射。
 */
import { useState } from "react";
import { GitMerge, Plus, Trash2, FolderOpen, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { browseDirectory, api } from "@/lib/tauri-bridge";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

interface Source {
  id: number;
  image_dir: string;
  label_dir: string;
  class_offset: string;
}

let _nextId = 1;

function SourceCard({
  src, onUpdate, onRemove,
}: {
  src: Source;
  onUpdate: (updated: Source) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg p-4 space-y-5" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: "hsl(var(--primary))" }}>{t('merge.sourceTitle', { id: src.id })}</span>
        <button
          className="p-1 rounded hover:opacity-80"
          style={{ color: "hsl(var(--destructive))" }}
          onClick={onRemove}
          title={t('merge.deleteSource')}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <MiniPathInput
        label={t('common.imageDir')}
        value={src.image_dir}
        onChange={(v) => onUpdate({ ...src, image_dir: v })}
        onBrowse={async () => { const d = await browseDirectory(); if (d) onUpdate({ ...src, image_dir: d }); }}
      />
      <MiniPathInput
        label={t('common.labelDir')}
        value={src.label_dir}
        onChange={(v) => onUpdate({ ...src, label_dir: v })}
        onBrowse={async () => { const d = await browseDirectory(); if (d) onUpdate({ ...src, label_dir: d }); }}
      />

      <div className="flex items-center gap-2">
        <label className="w-24 text-xs flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>
          {t('merge.classOffset')}
        </label>
        <input
          type="number"
          min="0"
          className="w-24 px-2 py-1 rounded text-sm"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          value={src.class_offset}
          onChange={(e) => onUpdate({ ...src, class_offset: e.target.value })}
          placeholder="0"
        />
        <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
          {t('merge.classOffsetHint')}
        </span>
      </div>
    </div>
  );
}

function MiniPathInput({
  label, value, onChange, onBrowse,
}: {
  label: string; value: string; onChange: (v: string) => void; onBrowse: () => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</label>
      <div className="flex gap-1.5">
        <input
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={label}
        />
        <button
          className="px-2.5 py-2 rounded-md flex-shrink-0 flex items-center"
          style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))" }}
          onClick={onBrowse}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function DatasetMerge() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<Source[]>([
    { id: _nextId++, image_dir: '', label_dir: '', class_offset: '0' },
    { id: _nextId++, image_dir: '', label_dir: '', class_offset: '0' },
  ]);
  const [outputImageDir, setOutputImageDir] = useState('');
  const [outputLabelDir, setOutputLabelDir] = useState('');
  const [prefixBySource, setPrefixBySource] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean; message: string;
    total_images?: number; total_labels?: number; conflicts?: number; errors?: string[];
  } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const sidebarEl = useSidebarEl();

  const addSource = () => {
    setSources((prev) => [...prev, { id: _nextId++, image_dir: '', label_dir: '', class_offset: '0' }]);
  };

  const updateSource = (id: number, updated: Source) => {
    setSources((prev) => prev.map((s) => (s.id === id ? updated : s)));
  };

  const removeSource = (id: number) => {
    setSources((prev) => prev.filter((s) => s.id !== id));
  };

  const handleMerge = async () => {
    const validSources = sources.filter((s) => s.image_dir.trim());
    if (validSources.length < 1) {
      setResult({ success: false, message: t('merge.noSource') });
      return;
    }
    if (!outputImageDir || !outputLabelDir) {
      setResult({ success: false, message: t('merge.noOutput') });
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const payload = {
        sources: validSources.map((s) => ({
          image_dir: s.image_dir,
          label_dir: s.label_dir,
          class_offset: parseInt(s.class_offset) || 0,
        })),
        output_image_dir: outputImageDir,
        output_label_dir: outputLabelDir,
        prefix_by_source: prefixBySource,
      };
      const res = await api.mergeDatasets(payload) as typeof result;
      setResult(res);
    } catch (e) {
      setResult({ success: false, message: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">

      {/* ── 来源列表 ── */}
      <div className="space-y-5">
        <h2 className="text-sm font-semibold">{t('merge.sources')}</h2>
        {sources.map((src) => (
          <SourceCard
            key={src.id}
            src={src}
            onUpdate={(updated) => updateSource(src.id, updated)}
            onRemove={() => removeSource(src.id)}
          />
        ))}
        <button
          className="flex items-center gap-2 px-4 py-2 rounded-md text-sm"
          style={{ background: "hsl(var(--muted))", border: "1px dashed hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
          onClick={addSource}
        >
          <Plus className="w-4 h-4" />
          {t('merge.addSource')}
        </button>
      </div>

      {/* ── 输出设置 ── */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        <h2 className="text-sm font-semibold">{t('merge.outputSettings')}</h2>
        <MiniPathInput label={t('merge.outputImageDir')} value={outputImageDir} onChange={setOutputImageDir}
          onBrowse={async () => { const d = await browseDirectory(); if (d) setOutputImageDir(d); }} />
        <MiniPathInput label={t('merge.outputLabelDir')} value={outputLabelDir} onChange={setOutputLabelDir}
          onBrowse={async () => { const d = await browseDirectory(); if (d) setOutputLabelDir(d); }} />

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="accent-blue-500"
            checked={prefixBySource}
            onChange={(e) => setPrefixBySource(e.target.checked)}
          />
          <span className="text-sm">{t('merge.prefixBySource')}</span>
        </label>
      </div>

      <button
        className="flex items-center gap-2 px-5 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
        style={{ background: "hsl(var(--primary))", color: "#fff" }}
        onClick={handleMerge}
        disabled={loading}
      >
        {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
        {loading ? t('merge.running') : t('merge.run')}
      </button>

    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      {/* ── 结果 ── */}
      {result && (
        <div
          className="rounded-lg p-4 space-y-2"
          style={{
            background: result.success ? "hsl(var(--success) / 0.08)" : "hsl(var(--destructive) / 0.08)",
            border: `1px solid ${result.success ? "hsl(var(--success) / 0.3)" : "hsl(var(--destructive) / 0.3)"}`,
          }}
        >
          <div className="text-sm font-medium" style={{ color: result.success ? "hsl(var(--success))" : "hsl(var(--destructive))" }}>
            {result.message}
          </div>
          {result.success && (
            <div className="flex gap-6 text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
              <span>{t('merge.images')}<strong style={{ color: "hsl(var(--foreground))" }}>{result.total_images}</strong></span>
              <span>{t('merge.labels')}<strong style={{ color: "hsl(var(--foreground))" }}>{result.total_labels}</strong></span>
              {(result.conflicts ?? 0) > 0 && (
                <span style={{ color: "hsl(var(--warning))" }}>{t('merge.conflicts', { count: result.conflicts })}</span>
              )}
            </div>
          )}
          {result.errors && result.errors.length > 0 && (
            <div className="rounded overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-xs"
                style={{ background: "hsl(var(--card))", color: "hsl(var(--warning))" }}
                onClick={() => setShowErrors(!showErrors)}
              >
                <span>{result.errors!.length} {t('merge.warnings')}</span>
                {showErrors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showErrors && (
                <div className="px-3 pb-2 space-y-1" style={{ background: "hsl(var(--card))" }}>
                  {result.errors!.map((e, i) => (
                    <div key={i} className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>{e}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
