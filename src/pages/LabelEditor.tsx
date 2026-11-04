/**
 * LabelEditor.tsx
 * 标签编辑页面：类别 ID 替换、删除类别、重排序。
 */
import { useState } from "react";
import { FolderOpen, Layers, Plus, Trash2 } from "lucide-react";
import { browseDirectory, api } from "@/lib/tauri-bridge";
import { useAppStore } from "@/lib/store";
import { ResultBox } from "@/components/ResultBox";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

type EditMode = "change" | "delete" | "reorder";

export default function LabelEditor() {
  const { t } = useTranslation();
  const MODES: { id: EditMode; label: string; desc: string }[] = [
    { id: "change", label: t('labels.replaceId'), desc: t('labels.descReplace') },
    { id: "delete", label: t('labels.deleteClass'), desc: t('labels.descDelete') },
    { id: "reorder", label: t('labels.reorder'), desc: t('labels.descReorder') },
  ];
  const { currentLabelDir } = useAppStore();
  const [labelDir, setLabelDir] = useState(currentLabelDir);
  const [outputDir, setOutputDir] = useState("");
  const [inPlace, setInPlace] = useState(false);
  const [mode, setMode] = useState<EditMode>("change");

  // change
  const [oldId, setOldId] = useState("0");
  const [newId, setNewId] = useState("1");

  // delete
  const [deleteId, setDeleteId] = useState("0");

  // reorder
  const [orderRows, setOrderRows] = useState<{ from: string; to: string }[]>([{ from: "0", to: "1" }]);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const sidebarEl = useSidebarEl();

  const handleRun = async () => {
    setLoading(true);
    setResult(null);
    try {
      const baseParams = {
        label_dir: labelDir,
        in_place: inPlace,
        output_dir: inPlace ? "" : outputDir,
      };
      let res: { success: boolean; message: string };
      if (mode === "change") {
        res = await api.labelChangeClass({ ...baseParams, old_id: parseInt(oldId), new_id: parseInt(newId) }) as typeof res;
      } else if (mode === "delete") {
        res = await api.labelDeleteClass({ ...baseParams, class_id: parseInt(deleteId) }) as typeof res;
      } else {
        const orderMap: Record<string, number> = {};
        orderRows.forEach(({ from, to }) => { if (from !== "" && to !== "") orderMap[from] = parseInt(to); });
        res = await api.labelReorder({ ...baseParams, order_map: orderMap }) as typeof res;
      }
      setResult(res);
    } catch (e) {
      setResult({ success: false, message: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">

      {/* 模式选择 */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button key={m.id}
            className="p-3 rounded-md text-left transition-all"
            style={{
              background: mode === m.id ? "hsl(var(--primary) / 0.12)" : "hsl(var(--card))",
              border: `1px solid ${mode === m.id ? "hsl(var(--primary))" : "hsl(var(--border))"}`,
            }}
            onClick={() => setMode(m.id)}
          >
            <div className="text-[13px] font-semibold leading-snug" style={{ color: mode === m.id ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}>
              {m.label}
            </div>
            <div className="text-[11px] mt-1 leading-relaxed" style={{ color: "hsl(var(--muted-foreground))" }}>{m.desc}</div>
          </button>
        ))}
      </div>

      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        {/* 标签目录 */}
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{t('labels.labelDir')}</label>
          <div className="flex gap-1.5">
            <input value={labelDir} onChange={(e) => setLabelDir(e.target.value)}
              placeholder={t('labels.labelDirPlaceholder')}
              className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            />
            <button className="px-2.5 py-2 rounded-md flex-shrink-0"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
              onClick={async () => { const d = await browseDirectory(); if (d) setLabelDir(d); }}>
              <FolderOpen className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 原地修改 or 输出目录 */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={inPlace} onChange={(e) => setInPlace(e.target.checked)} className="accent-blue-500" />
            <span className="text-sm">{t('labels.inPlace')}</span>
          </label>
          {!inPlace && (
            <div className="flex gap-2 mt-2">
              <input value={outputDir} onChange={(e) => setOutputDir(e.target.value)}
                placeholder={t('common.outputDirPlaceholder')}
                className="flex-1 px-3 py-2 rounded-md text-sm"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
              />
              <button className="px-3 py-2 rounded-md"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                onClick={async () => { const d = await browseDirectory(); if (d) setOutputDir(d); }}>
                <FolderOpen className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* 模式特定参数 */}
        {mode === "change" && (
          <div className="flex items-center gap-3">
            <label className="text-sm w-20">{t('labels.oldId')}</label>
            <input type="number" value={oldId} onChange={(e) => setOldId(e.target.value)}
              className="w-20 px-2 py-1.5 rounded text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            />
            <span className="text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>→</span>
            <label className="text-sm w-20">{t('labels.newId')}</label>
            <input type="number" value={newId} onChange={(e) => setNewId(e.target.value)}
              className="w-20 px-2 py-1.5 rounded text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            />
          </div>
        )}

        {mode === "delete" && (
          <div className="flex items-center gap-3">
            <label className="text-sm">{t('labels.deleteIdLabel')}</label>
            <input type="number" value={deleteId} onChange={(e) => setDeleteId(e.target.value)}
              className="w-20 px-2 py-1.5 rounded text-sm"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
            />
          </div>
        )}

        {mode === "reorder" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">{t('labels.remapRules')}</label>
              <button className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                style={{ background: "hsl(var(--muted))" }}
                onClick={() => setOrderRows([...orderRows, { from: "", to: "" }])}>
                <Plus className="w-3 h-3" /> {t('common.add')}
              </button>
            </div>
            <div className="space-y-2">
              {orderRows.map((row, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="number" placeholder={t('convert.fromId')} value={row.from}
                    onChange={(e) => { const r = [...orderRows]; r[i].from = e.target.value; setOrderRows(r); }}
                    className="w-20 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <span className="text-xs">→</span>
                  <input type="number" placeholder={t('convert.toId')} value={row.to}
                    onChange={(e) => { const r = [...orderRows]; r[i].to = e.target.value; setOrderRows(r); }}
                    className="w-20 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <button onClick={() => setOrderRows(orderRows.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3.5 h-3.5" style={{ color: "hsl(var(--destructive))" }} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          className="w-full py-2.5 rounded-md text-sm font-semibold disabled:opacity-50"
          style={{ background: "hsl(var(--primary))", color: "#fff" }}
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? t('common.running') : t('common.run')}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      {result && <ResultBox success={result.success} message={result.message} />}
    </>
  );
}
