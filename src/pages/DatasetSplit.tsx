/**
 * DatasetSplit.tsx
 * 数据集划分页面：按比例将数据集划分为 train/val/test，并生成 data.yaml。
 */
import { useState } from "react";
import { FolderOpen, Scissors, Plus, Trash2 } from "lucide-react";
import { browseDirectory, api } from "@/lib/tauri-bridge";
import { useAppStore } from "@/lib/store";
import { ResultBox } from "@/components/ResultBox";
import { createPortal } from "react-dom";
import { useSidebarEl } from "@/lib/sidebar-context";
import { useTranslation } from "react-i18next";

export default function DatasetSplit() {
  const { t } = useTranslation();
  const { currentDatasetDir, currentLabelDir, currentClassNames } = useAppStore();

  const [imageDir, setImageDir] = useState(currentDatasetDir);
  const [labelDir, setLabelDir] = useState(currentLabelDir);
  const [outputDir, setOutputDir] = useState("");
  const [trainRatio, setTrainRatio] = useState(0.8);
  const [valRatio, setValRatio] = useState(0.1);
  const [testRatio, setTestRatio] = useState(0.1);
  const [seed, setSeed] = useState(42);
  const [generateYaml, setGenerateYaml] = useState(true);
  const [classNames, setClassNames] = useState<string[]>(
    currentClassNames.length > 0 ? currentClassNames : [""]
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean; message: string; counts?: Record<string, number>; yaml_path?: string;
  } | null>(null);
  const sidebarEl = useSidebarEl();

  const total = trainRatio + valRatio + testRatio;
  const isValid = Math.abs(total - 1.0) < 0.001;

  const handleRun = async () => {
    if (!isValid) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await api.splitRun({
        image_dir: imageDir,
        label_dir: labelDir,
        output_dir: outputDir,
        train_ratio: trainRatio,
        val_ratio: valRatio,
        test_ratio: testRatio,
        seed,
        generate_yaml: generateYaml,
        class_names: classNames.filter(Boolean),
      }) as typeof result;
      setResult(res!);
    } catch (e) {
      setResult({ success: false, message: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const configPortal = (
    <div className="py-4 flex flex-col gap-4">

      <div className="rounded-xl p-4 space-y-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        <DirInput label={t('common.imageDir')} value={imageDir} onChange={setImageDir} />
        <DirInput label={t('common.labelDir')} value={labelDir} onChange={setLabelDir} />
        <DirInput label={t('common.outputDir')} value={outputDir} onChange={setOutputDir} />

        {/* 比例设置 */}
        <div>
          <label className="block text-sm font-medium mb-3">{t('split.splitRatio')}</label>
          <div className="space-y-4">
            {[
              { label: t('split.trainSet'), value: trainRatio, onChange: setTrainRatio },
              { label: t('split.valSet'), value: valRatio, onChange: setValRatio },
              { label: t('split.testSet'), value: testRatio, onChange: setTestRatio },
            ].map(({ label, value, onChange }) => (
              <div key={label} className="flex items-center gap-3">
                <span className="w-32 text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>{label}</span>
                <input type="range" min={0} max={1} step={0.05} value={value}
                  onChange={(e) => onChange(parseFloat(e.target.value))}
                  className="flex-1" />
                <input type="number" min={0} max={1} step={0.05} value={value}
                  onChange={(e) => onChange(parseFloat(e.target.value))}
                  className="w-16 px-2 py-1 rounded text-sm text-center"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-3 rounded-full overflow-hidden flex" style={{ background: "hsl(var(--muted))" }}>
              {[
                { ratio: trainRatio, color: "hsl(217 91% 60%)" },
                { ratio: valRatio, color: "hsl(142 71% 45%)" },
                { ratio: testRatio, color: "hsl(38 92% 50%)" },
              ].map(({ ratio, color }, i) => (
                <div key={i} style={{ width: `${ratio * 100}%`, background: color, minWidth: ratio > 0 ? 2 : 0 }} />
              ))}
            </div>
            <span className={`text-xs font-mono ${isValid ? "text-green-400" : "text-red-400"}`}>
              {total.toFixed(2)}
            </span>
          </div>
          {!isValid && <p className="text-xs mt-1" style={{ color: "hsl(var(--destructive))" }}>{t('split.ratioSum')}</p>}
        </div>

        {/* 随机种子 */}
        <div className="flex items-center gap-3">
          <label className="text-sm w-20">{t('split.seed')}</label>
          <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value))}
            className="w-24 px-2 py-1.5 rounded text-sm"
            style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
          />
        </div>

        {/* 生成 YAML */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={generateYaml} onChange={(e) => setGenerateYaml(e.target.checked)} className="accent-blue-500" />
          <span className="text-sm">{t('split.generateYaml')}</span>
        </label>

        {/* 类别名称 */}
        {generateYaml && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">{t('split.classNames')}</label>
              <button className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                style={{ background: "hsl(var(--muted))" }}
                onClick={() => setClassNames([...classNames, ""])}>
                <Plus className="w-3 h-3" /> {t('common.add')}
              </button>
            </div>
            <div className="space-y-2">
              {classNames.map((name, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <span className="text-xs w-6 text-right" style={{ color: "hsl(var(--muted-foreground))" }}>{i}</span>
                  <input value={name} onChange={(e) => { const r = [...classNames]; r[i] = e.target.value; setClassNames(r); }}
                    placeholder={t('split.className', { index: i })}
                    className="flex-1 px-2 py-1.5 rounded text-sm"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  />
                  <button onClick={() => setClassNames(classNames.filter((_, j) => j !== i))}>
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
          disabled={loading || !isValid}
        >
          {loading ? t('split.running') : t('split.run')}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {sidebarEl && createPortal(configPortal, sidebarEl)}
      {result && (
        <div>
          <ResultBox success={result.success} message={result.message} />
          {result.success && result.counts && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              {Object.entries(result.counts).map(([split, count]) => (
                <div key={split} className="rounded-lg p-3 text-center"
                  style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
                  <div className="text-lg font-bold">{String(count)}</div>
                  <div className="text-xs mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>{split}</div>
                </div>
              ))}
            </div>
          )}
          {result.yaml_path && (
            <div className="mt-2 text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
              YAML 已保存至：{result.yaml_path}
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
          placeholder={`请输入${label}路径`}
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
