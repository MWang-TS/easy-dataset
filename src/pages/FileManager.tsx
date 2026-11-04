/**
 * FileManager.tsx
 * 文件管理页面：一致性检查、空标签清理、创建空标签、批量重命名、图片修复。
 */
import { useState } from "react";
import { FolderOpen, FolderCog } from "lucide-react";
import { browseDirectory, api } from "@/lib/tauri-bridge";
import { useAppStore } from "@/lib/store";
import { ResultBox } from "@/components/ResultBox";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

type ToolId = "consistency" | "delete-empty" | "create-empty" | "rename" | "repair";

export default function FileManager() {
  const { t } = useTranslation();
  const TOOLS: { id: ToolId; label: string; desc: string }[] = [
    { id: "consistency", label: t('files.consistency'), desc: t('files.descConsistency') },
    { id: "delete-empty", label: t('files.deleteEmpty'), desc: t('files.descDeleteEmpty') },
    { id: "create-empty", label: t('files.createEmpty'), desc: t('files.descCreateEmpty') },
    { id: "rename", label: t('files.rename'), desc: t('files.descRename') },
    { id: "repair", label: t('files.repair'), desc: t('files.descRepair') },
  ];
  const { currentDatasetDir, currentLabelDir } = useAppStore();
  const [tool, setTool] = useState<ToolId>("consistency");
  const [imageDir, setImageDir] = useState(currentDatasetDir);
  const [labelDir, setLabelDir] = useState(currentLabelDir);
  const [prefix, setPrefix] = useState("img");
  const [quality, setQuality] = useState(95);
  const [dryRun, setDryRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; [k: string]: unknown } | null>(null);
  const sidebarEl = useSidebarEl();

  const handleRun = async () => {
    setLoading(true);
    setResult(null);
    try {
      let res: { success: boolean; message: string };
      switch (tool) {
        case "consistency":
          res = await api.fileCheckConsistency({ image_dir: imageDir, label_dir: labelDir }) as typeof res;
          break;
        case "delete-empty":
          res = await api.fileDeleteEmptyLabels({ label_dir: labelDir, dry_run: dryRun }) as typeof res;
          break;
        case "create-empty":
          res = await api.fileCreateEmptyLabels({ image_dir: imageDir, label_dir: labelDir }) as typeof res;
          break;
        case "rename":
          res = await api.fileBatchRename({ image_dir: imageDir, label_dir: labelDir, prefix, dry_run: dryRun }) as typeof res;
          break;
        case "repair":
          res = await api.fileRepairImages({ image_dir: imageDir, quality, dry_run: dryRun }) as typeof res;
          break;
      }
      setResult(res!);
    } catch (e) {
      setResult({ success: false, message: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const needsImageDir = ["consistency", "create-empty", "rename", "repair"].includes(tool);
  const needsLabelDir = ["consistency", "delete-empty", "create-empty", "rename"].includes(tool);
  const hasDryRun = ["delete-empty", "rename", "repair"].includes(tool);

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">

      {/* 工具选择 */}
      <div className="grid grid-cols-1 gap-2">
        {TOOLS.map((t) => (
          <button key={t.id}
            className="p-3 rounded-md text-left flex items-center gap-3 transition-all"
            style={{
              background: tool === t.id ? "hsl(var(--primary) / 0.12)" : "hsl(var(--card))",
              border: `1px solid ${tool === t.id ? "hsl(var(--primary))" : "hsl(var(--border))"}`,
            }}
            onClick={() => setTool(t.id)}
          >
            <div className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: tool === t.id ? "hsl(var(--primary))" : "hsl(var(--border))" }} />
            <div>
              <div className="text-[13px] font-semibold leading-snug"
                style={{ color: tool === t.id ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}>
                {t.label}
              </div>
              <div className="text-[11px] mt-1 leading-relaxed" style={{ color: "hsl(var(--muted-foreground))" }}>{t.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* 参数 */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        {needsImageDir && <DirInput label={t('common.imageDir')} value={imageDir} onChange={setImageDir} />}
        {needsLabelDir && <DirInput label={t('common.labelDir')} value={labelDir} onChange={setLabelDir} />}

        {tool === "rename" && (
          <div className="flex items-center gap-3">
            <label className="text-sm w-20">{t('files.filePrefix')}</label>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)}
              className="w-32 px-2 py-1.5 rounded text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            />
            <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>例：{prefix}_000001.jpg</span>
          </div>
        )}

        {tool === "repair" && (
          <div className="flex items-center gap-3">
            <label className="text-sm w-20">{t('files.jpegQuality')}</label>
            <input type="range" min={60} max={100} value={quality} onChange={(e) => setQuality(parseInt(e.target.value))}
              className="w-32" />
            <span className="text-sm">{quality}</span>
          </div>
        )}

        {hasDryRun && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="accent-blue-500" />
            <span className="text-sm">{t('files.dryRun')}</span>
          </label>
        )}

        <button
          className="w-full py-2.5 rounded-md text-sm font-semibold disabled:opacity-50"
          style={{ background: "hsl(var(--primary))", color: "#fff" }}
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? t('common.running') : dryRun && hasDryRun ? t('files.preview') : t('common.run')}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      {result && (
        <div className="space-y-3">
          <ResultBox success={result.success} message={result.message} />
          {/* 一致性详情 */}
          {tool === "consistency" && result.success && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {[
                  [t('files.totalImages'), result.total_images],
                  [t('files.totalLabels'), result.total_labels],
                  [t('files.matchedPairs'), result.matched],
                  [t('files.orphanImages'), result.orphan_images],
                  [t('files.orphanLabels'), result.orphan_labels],
                ].map(([k, v]) => (
                  <div key={String(k)} className="rounded-lg p-3 flex justify-between text-sm"
                    style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
                    <span style={{ color: "hsl(var(--muted-foreground))" }}>{String(k)}</span>
                    <span className="font-bold">{String(v)}</span>
                  </div>
                ))}
              </div>
              {(result.orphan_image_paths as string[])?.length > 0 && (
                <PathList title={t('files.orphanImagePaths', { count: (result.orphan_image_paths as string[]).length })}
                  paths={result.orphan_image_paths as string[]} />
              )}
              {(result.orphan_label_paths as string[])?.length > 0 && (
                <PathList title={t('files.orphanLabelPaths', { count: (result.orphan_label_paths as string[]).length })}
                  paths={result.orphan_label_paths as string[]} />
              )}
            </>
          )}
          {/* 批量重命名预览表格 */}
          {tool === "rename" && result.success && (result.preview as RenameItem[])?.length > 0 && (
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
              <div className="px-3 py-2 text-xs font-semibold"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
                {t('files.renamePreview', { count: (result.preview as RenameItem[]).length })}
              </div>
              <div className="max-h-48 overflow-y-auto">
                {(result.preview as RenameItem[]).map((item, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    style={{ borderTop: i > 0 ? "1px solid hsl(var(--border))" : undefined }}>
                    <span className="flex-1 font-mono truncate" style={{ color: "hsl(var(--muted-foreground))" }}
                      title={item.old_image}>{item.old_image.split(/[\\/]/).pop()}</span>
                    <span className="flex-shrink-0 px-1" style={{ color: "hsl(var(--muted-foreground))" }}>→</span>
                    <span className="flex-1 font-mono truncate" title={item.new_image}>{item.new_image.split(/[\\/]/).pop()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function DirInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</label>
      <div className="flex gap-1.5">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={label}
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
        />
        <button className="px-2.5 py-2 rounded-md flex-shrink-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
          onClick={async () => { const d = await browseDirectory(); if (d) onChange(d); }}>
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

interface RenameItem { old_image: string; new_image: string; old_stem: string; new_stem: string }

function PathList({ title, paths }: { title: string; paths: string[] }) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid hsl(var(--border))" }}>
      <div className="px-3 py-2 text-xs font-semibold"
        style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>{title}</div>
      <div className="max-h-36 overflow-y-auto">
        {paths.map((p, i) => (
          <div key={i} className="px-3 py-1 text-xs font-mono"
            style={{ borderTop: i > 0 ? "1px solid hsl(var(--border))" : undefined, color: "hsl(var(--muted-foreground))" }}>{p}</div>
        ))}
      </div>
    </div>
  );
}
