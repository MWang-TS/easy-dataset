/**
 * Converter.tsx
 * 格式转换页面：LabelMe→YOLO、VOC→YOLO、YOLO→VOC、YOLO类别重映射。
 */
import { useState } from "react";
import { FolderOpen, RefreshCw, Plus, Trash2, FileJson } from "lucide-react";
import { browseDirectory, browseSaveFile, api } from "@/lib/tauri-bridge";
import { ResultBox } from "@/components/ResultBox";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

type ConvertMode = "labelme2yolo" | "voc2yolo" | "yolo2voc" | "class-remap" | "yolo2coco";

const MODES: { id: ConvertMode; label: string; descKey: string }[] = [
  { id: "labelme2yolo", label: "LabelMe → YOLO", descKey: "convert.descLabelme2yolo" },
  { id: "voc2yolo", label: "Pascal VOC → YOLO", descKey: "convert.descVoc2yolo" },
  { id: "yolo2voc", label: "YOLO → Pascal VOC", descKey: "convert.descYolo2voc" },
  { id: "class-remap", label: "YOLO Class Remap", descKey: "convert.descClassRemap" },
  { id: "yolo2coco", label: "YOLO → COCO JSON", descKey: "convert.descYolo2coco" },
];

export default function Converter() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ConvertMode>("labelme2yolo");
  const [inputDir, setInputDir] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [datasetDir, setDatasetDir] = useState(""); // for yolo2voc
  const [cocoImageDir, setCocoImageDir] = useState(""); // for yolo2coco
  const [cocoOutput, setCocoOutput] = useState("");    // for yolo2coco
  const [cocoClassNames, setCocoClassNames] = useState(""); // for yolo2coco
  const [labelRows, setLabelRows] = useState<{ name: string; id: string }[]>([{ name: "", id: "0" }]);
  const [remapRows, setRemapRows] = useState<{ from: string; to: string }[]>([{ from: "0", to: "1" }]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const sidebarEl = useSidebarEl();

  const buildLabels = () => {
    const labels: Record<string, number> = {};
    labelRows.forEach(({ name, id }) => {
      if (name && id !== "") labels[name] = parseInt(id);
    });
    return labels;
  };

  const handleRun = async () => {
    setLoading(true);
    setResult(null);
    try {
      let res: { success: boolean; message: string };
      if (mode === "labelme2yolo") {
        res = await api.convertLabelme2yolo({ input_dir: inputDir, output_dir: outputDir, labels: buildLabels() }) as typeof res;
      } else if (mode === "voc2yolo") {
        res = await api.convertVoc2yolo({ input_dir: inputDir, output_dir: outputDir, labels: buildLabels() }) as typeof res;
      } else if (mode === "yolo2voc") {
        res = await api.convertYolo2voc({ dataset_dir: datasetDir, output_dir: outputDir, labels: buildLabels() }) as typeof res;
      } else if (mode === "yolo2coco") {
        const names = cocoClassNames.trim()
          ? cocoClassNames.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
        const r = await api.exportCoco({ image_dir: cocoImageDir, label_dir: inputDir, output_path: cocoOutput, class_names: names }) as { success: boolean; message: string; total_images?: number; total_annotations?: number };
        res = { success: r.success, message: r.message + (r.success && r.total_images !== undefined ? ` (${r.total_images} 张图片，${r.total_annotations} 个标注)` : '') };
      } else {
        const classMapping: Record<string, number> = {};
        remapRows.forEach(({ from, to }) => { if (from !== "" && to !== "") classMapping[from] = parseInt(to); });
        res = await api.convertYoloClassRemap({ input_dir: inputDir, output_dir: outputDir, class_mapping: classMapping }) as typeof res;
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
      <div className="grid grid-cols-2 gap-2">
        {MODES.map((m) => (
          <button
            key={m.id}
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
            <div className="text-[11px] mt-1 leading-relaxed" style={{ color: "hsl(var(--muted-foreground))" }}>{t(m.descKey)}</div>
          </button>
        ))}
      </div>

      {/* 参数表单 */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        {mode === "yolo2voc" ? (
          <DirInput label={t('convert.yoloDirLabel')} value={datasetDir} onChange={setDatasetDir} />
        ) : mode === "yolo2coco" ? (
          <>
            <DirInput label={t('common.imageDir')} value={cocoImageDir} onChange={setCocoImageDir} />
            <DirInput label={t('convert.yoloLabelDir')} value={inputDir} onChange={setInputDir} />
            {/* 输出文件（另存为 JSON）*/}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{t('convert.outputFile')}</label>
              <div className="flex gap-1.5">
                <input value={cocoOutput} onChange={(e) => setCocoOutput(e.target.value)}
                  placeholder="e.g. D:\dataset\annotations.json"
                  className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                />
                <button className="px-2.5 py-2 rounded-md flex items-center gap-1 text-sm flex-shrink-0"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  onClick={async () => { const f = await browseSaveFile([{ name: "JSON", extensions: ["json"] }]); if (f) setCocoOutput(f); }}>
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* 类别名称 */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{t('convert.classNames')}</label>
              <input value={cocoClassNames} onChange={(e) => setCocoClassNames(e.target.value)}
                placeholder={t('convert.classNamesPlaceholder')}
                className="w-full px-3 py-2 rounded-md text-sm"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
              />
            </div>
          </>
        ) : (
          <DirInput label={t('common.inputDir')} value={inputDir} onChange={setInputDir} />
        )}
        {mode !== "yolo2coco" && (
          <DirInput label={t('common.outputDir')} value={outputDir} onChange={setOutputDir} />
        )}

        {/* 标签映射（非 class-remap、非 yolo2coco 时显示）*/}
        {mode !== "class-remap" && mode !== "yolo2coco" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">{t('convert.labelMapping')}</label>
              <button
                className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                onClick={() => setLabelRows([...labelRows, { name: "", id: String(labelRows.length) }])}
              >
                <Plus className="w-3 h-3" /> {t('common.add')}
              </button>
            </div>
            <div className="space-y-2">
              {labelRows.map((row, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input placeholder={t('convert.className')} value={row.name}
                    onChange={(e) => { const r = [...labelRows]; r[i].name = e.target.value; setLabelRows(r); }}
                    className="flex-1 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>→ ID</span>
                  <input type="number" value={row.id}
                    onChange={(e) => { const r = [...labelRows]; r[i].id = e.target.value; setLabelRows(r); }}
                    className="w-16 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <button onClick={() => setLabelRows(labelRows.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3.5 h-3.5" style={{ color: "hsl(var(--destructive))" }} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 类别 ID 重映射 */}
        {mode === "class-remap" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">{t('convert.idRemapRules')}</label>
              <button
                className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                onClick={() => setRemapRows([...remapRows, { from: "", to: "" }])}
              >
                <Plus className="w-3 h-3" /> {t('common.add')}
              </button>
            </div>
            <div className="space-y-2">
              {remapRows.map((row, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="number" placeholder={t('convert.fromId')} value={row.from}
                    onChange={(e) => { const r = [...remapRows]; r[i].from = e.target.value; setRemapRows(r); }}
                    className="w-24 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>→</span>
                  <input type="number" placeholder={t('convert.toId')} value={row.to}
                    onChange={(e) => { const r = [...remapRows]; r[i].to = e.target.value; setRemapRows(r); }}
                    className="w-24 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <button onClick={() => setRemapRows(remapRows.filter((_, j) => j !== i))}>
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
          {loading ? t('common.running') : mode === "yolo2coco" ? t('convert.export') : t('convert.run')}
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

function DirInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] mb-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</label>
      <div className="flex gap-1.5">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={`请输入${label}路径`}
          className="flex-1 px-3 py-2 rounded-md text-sm min-w-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
        />
        <button className="px-2.5 py-2 rounded-md flex items-center gap-1 text-sm flex-shrink-0"
          style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
          onClick={async () => { const d = await browseDirectory(); if (d) onChange(d); }}>
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
