/**
 * AnnotationCanvas.tsx
 * 纯 Canvas 2D 标注器：矩形框 / 多边形，支持选中、移动、拖角缩放、平移、缩放。
 *
 * 坐标系三层：
 *   1. 图片逻辑像素（底图 canvas 的 width/height，也是标注运算单位）
 *   2. CSS 显示像素（受 scale 影响）
 *   3. 叠加层设备像素（CSS 像素 × devicePixelRatio；框线/多边形画在此层，缩放不失真）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationBox, YoloBox } from "@/lib/annotation-store";
import {
  angleFromPointer,
  cornersOf,
  isRotatedRect,
  resizeCorner,
  rotateHandlePos,
  rotRectFromCorners,
  type RotRect,
} from "@/lib/obb";

export type CanvasMode = "pan" | "hbb" | "obb" | "polygon";

const HANDLE_SIZE = 8;
const POLYGON_POINT_RADIUS = 4;
const POLYGON_START_RADIUS = 6;
const POLYGON_HIT_RADIUS = 14;
/** 旋转手柄直径（CSS 像素）及其到框顶边的距离 */
const ROTATE_HANDLE_RADIUS = 5;
const ROTATE_HANDLE_OFFSET = 20;
const MIN_BOX_PX = 10;
const COLORS = [
  "#ff5c5c", "#4ade80", "#60a5fa", "#facc15",
  "#e879f9", "#22d3ee", "#fb923c", "#a3e635",
];

interface CanvasPoint {
  x: number;
  y: number;
}

interface Props {
  dataUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  boxes: AnnotationBox[];
  selectedId: string | null;
  classes: Record<string, string>;
  newBoxClass: number;
  mode: CanvasMode;
  scale: number;
  /** 标签半透明：避免标签遮挡目标 */
  labelsFaded?: boolean;

  onSelect: (id: string | null) => void;
  onAdd: (box: YoloBox) => void;
  onUpdate: (id: string, patch: Partial<YoloBox>, recordHistory?: boolean) => void;
  onDelete: (id: string) => void;
  onCopy: (id: string) => void;
  onPaste: () => void;
  onScaleChange: (scale: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onModeChange: (mode: CanvasMode) => void;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distance(a: CanvasPoint, b: CanvasPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isPointInPolygon(point: CanvasPoint, polygon: CanvasPoint[]): boolean {
  let inside = false;
  for (let i = 0, prev = polygon.length - 1; i < polygon.length; prev = i++) {
    const cur = polygon[i];
    const pre = polygon[prev];
    const intersects =
      cur.y > point.y !== pre.y > point.y &&
      point.x < ((pre.x - cur.x) * (point.y - cur.y)) / (pre.y - cur.y) + cur.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonBounds(polygon: [number, number][]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: maxX - minX,
    h: maxY - minY,
  };
}

type DragState =
  | { kind: "move"; id: string; start: CanvasPoint; startBox: AnnotationBox; recorded?: boolean }
  | { kind: "resize"; id: string; start: CanvasPoint; startBox: AnnotationBox; handle: string; recorded?: boolean }
  | { kind: "vertex"; id: string; start: CanvasPoint; startBox: AnnotationBox; index: number; recorded?: boolean }
  | { kind: "rotate"; id: string; rect: RotRect; recorded?: boolean }
  | { kind: "obbCorner"; id: string; rect: RotRect; index: number; recorded?: boolean };

export default function AnnotationCanvas(props: Props) {
  const {
    dataUrl, imageWidth, imageHeight, boxes, selectedId, classes, newBoxClass,
    mode, scale, onSelect, onAdd, onUpdate, onDelete, onScaleChange, labelsFaded,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [imageLoaded, setImageLoaded] = useState(false);
  const [draftRect, setDraftRect] = useState<{ start: CanvasPoint; end: CanvasPoint } | null>(null);
  const [polyPoints, setPolyPoints] = useState<CanvasPoint[]>([]);
  const [polyHover, setPolyHover] = useState<CanvasPoint | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; boxId: string } | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const rightDownRef = useRef<CanvasPoint | null>(null);
  const draftRef = useRef<{ start: CanvasPoint; end: CanvasPoint } | null>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;

  /** 草稿矩形同时写 state（触发重绘）与 ref（供 mouseup 同步读取，避免重复提交） */
  const setDraft = useCallback((value: { start: CanvasPoint; end: CanvasPoint } | null) => {
    draftRef.current = value;
    setDraftRect(value);
  }, []);

  // ── 图片加载 ──
  useEffect(() => {
    setDraft(null);
    setPolyPoints([]);
    setPolyHover(null);
    setContextMenu(null);
    dragRef.current = null;
    if (!dataUrl) {
      imageRef.current = null;
      setImageLoaded(false);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imageRef.current = img;
      setImageLoaded(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      imageRef.current = null;
      setImageLoaded(false);
    };
    img.src = dataUrl;
    return () => {
      cancelled = true;
    };
  }, [dataUrl]);

  const getCanvasPoint = useCallback((e: { clientX: number; clientY: number }): CanvasPoint => {
    const overlay = overlayRef.current;
    if (!overlay || imageWidth <= 0 || imageHeight <= 0) return { x: 0, y: 0 };
    const rect = overlay.getBoundingClientRect();
    const scaleX = imageWidth / (rect.width || 1);
    const scaleY = imageHeight / (rect.height || 1);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, [imageWidth, imageHeight]);

  const toCanvas = useCallback(
    (box: YoloBox) => ({
      x: (box.cx - box.w / 2) * imageWidth,
      y: (box.cy - box.h / 2) * imageHeight,
      width: box.w * imageWidth,
      height: box.h * imageHeight,
      classId: box.class_id,
    }),
    [imageWidth, imageHeight]
  );

  const toYolo = useCallback(
    (rect: { x: number; y: number; width: number; height: number }, classId: number): YoloBox => ({
      class_id: classId,
      cx: clamp01((rect.x + rect.width / 2) / imageWidth),
      cy: clamp01((rect.y + rect.height / 2) / imageHeight),
      w: clamp01(rect.width / imageWidth),
      h: clamp01(rect.height / imageHeight),
    }),
    [imageWidth, imageHeight]
  );

  // ── 渲染 ──
  const draw = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || !imageLoaded) return;
    if (imageWidth <= 0 || imageHeight <= 0) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    // 叠加层按设备像素清屏，再把坐标系设回「图片逻辑像素」：
    // 框线/多边形按设备像素绘制，图片放大时依然锐利（图片自身的马赛克与之无关）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const rect = overlay.getBoundingClientRect();
    const cssWidth = rect.width || overlay.width / (window.devicePixelRatio || 1);
    if (cssWidth <= 0) return;
    const pxPerUnit = overlay.width / imageWidth;
    ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);

    /** CSS 像素 → 图片逻辑像素（保持线宽/圆点屏幕尺寸恒定） */
    const toUnits = (cssPx: number) => (cssPx * imageWidth) / cssWidth;
    const pointRadius = toUnits(POLYGON_POINT_RADIUS);
    const startRadius = toUnits(POLYGON_START_RADIUS);
    const lineWidth = toUnits(2);
    const fontSize = toUnits(13);
    const handleSize = toUnits(HANDLE_SIZE);

    boxes.forEach((box) => {
      const rect = toCanvas(box);
      const isSelected = box.id === selectedId;
      const color = COLORS[Math.abs(box.class_id) % COLORS.length];
      const name = classes[String(box.class_id)] ?? `类别 ${box.class_id}`;

      if (box.polygon && box.polygon.length >= 3) {
        const poly = box.polygon.map(([x, y]) => ({ x: x * imageWidth, y: y * imageHeight }));
        // 只有「4 个点且真构成矩形」的标注才按旋转框给手柄（避免 4 点分割多边形被误认）
        const isObb = poly.length === 4
          && (mode === "obb" || isRotatedRect(poly.map((p): [number, number] => [p.x, p.y])));
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        poly.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = color + (isSelected ? "55" : "33");
        ctx.fill();
        ctx.strokeStyle = isSelected ? "#ffffff" : color;
        ctx.lineWidth = isSelected ? lineWidth + 1 : lineWidth;
        ctx.stroke();

        if (isSelected && isObb) {
          // 旋转框：4 个角点手柄 + 顶部旋转手柄
          poly.forEach((p) => {
            ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
            ctx.fillRect(p.x - handleSize / 2, p.y - handleSize / 2, handleSize, handleSize);
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.strokeRect(p.x - handleSize / 2, p.y - handleSize / 2, handleSize, handleSize);
          });
          const rotRect = rotRectFromCorners(poly.map((p): [number, number] => [p.x, p.y]));
          const [hx, hy] = rotateHandlePos(rotRect, toUnits(ROTATE_HANDLE_OFFSET));
          const topMid = {
            x: (poly[0].x + poly[1].x) / 2,
            y: (poly[0].y + poly[1].y) / 2,
          };
          ctx.beginPath();
          ctx.moveTo(topMid.x, topMid.y);
          ctx.lineTo(hx, hy);
          ctx.strokeStyle = color;
          ctx.lineWidth = lineWidth;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(hx, hy, toUnits(ROTATE_HANDLE_RADIUS), 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.stroke();
        } else if (isSelected) {
          poly.forEach((p) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, pointRadius, 0, Math.PI * 2);
            // 半透明白色，避免遮住底图
            ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.stroke();
          });
        }
      } else {
        ctx.strokeStyle = isSelected ? "#ffffff" : color;
        ctx.lineWidth = isSelected ? lineWidth + 1 : lineWidth;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        if (isSelected) {
          [
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.width, y: rect.y },
            { x: rect.x, y: rect.y + rect.height },
            { x: rect.x + rect.width, y: rect.y + rect.height },
          ].forEach((corner) => {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize);
          });
        }
      }

      // 类别标签：贴顶时画到框内，避免被裁掉
      ctx.font = `${fontSize}px sans-serif`;
      const textWidth = ctx.measureText(name).width;
      const labelHeight = fontSize + 6;
      const labelY = rect.y - labelHeight >= 0 ? rect.y - labelHeight : rect.y;
      // 半透明模式：90% 透明（alpha 0.1），看清被标签挡住的区域
      ctx.save();
      if (labelsFaded) ctx.globalAlpha = 0.1;
      ctx.fillStyle = color + "dd";
      ctx.fillRect(rect.x, labelY, textWidth + 8, labelHeight);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(name, rect.x + 4, labelY + fontSize);
      ctx.restore();
    });

    if ((mode === "hbb" || mode === "obb") && draftRect) {
      ctx.strokeStyle = COLORS[Math.abs(newBoxClass) % COLORS.length];
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([toUnits(5), toUnits(5)]);
      ctx.strokeRect(
        draftRect.start.x,
        draftRect.start.y,
        draftRect.end.x - draftRect.start.x,
        draftRect.end.y - draftRect.start.y
      );
      ctx.setLineDash([]);
    }

    if (mode === "polygon" && polyPoints.length > 0) {
      const color = COLORS[Math.abs(newBoxClass) % COLORS.length];
      ctx.beginPath();
      ctx.moveTo(polyPoints[0].x, polyPoints[0].y);
      polyPoints.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      if (polyHover) ctx.lineTo(polyHover.x, polyHover.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([toUnits(5), toUnits(5)]);
      ctx.stroke();
      ctx.setLineDash([]);
      polyPoints.forEach((p, index) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, index === 0 ? startRadius : pointRadius, 0, Math.PI * 2);
        // 起点用半透明白，其余用半透明类别色
        ctx.fillStyle = index === 0 ? "rgba(255, 255, 255, 0.55)" : color + "66";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      });
    }
  }, [boxes, selectedId, classes, mode, draftRect, polyPoints, polyHover, newBoxClass, imageLoaded, toCanvas, labelsFaded]);

  useEffect(() => {
    draw();
  }, [draw, imageWidth, imageHeight, scale]);

  // 供 ResizeObserver 使用的最新 draw，避免依赖变化时反复重建 observer
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // ── 底图：按图片逻辑像素绘制，仅随图片变化重绘 ──
  useEffect(() => {
    const base = canvasRef.current;
    const img = imageRef.current;
    if (!base || !img || !imageLoaded) return;
    const width = imageWidth || img.naturalWidth || 1;
    const height = imageHeight || img.naturalHeight || 1;
    // 超大图限制底图分辨率，避免 canvas 占用过大（矢量层不受影响）
    const maxSide = 4096;
    let bw = width;
    let bh = height;
    if (Math.max(width, height) > maxSide) {
      const k = maxSide / Math.max(width, height);
      bw = Math.max(1, Math.round(width * k));
      bh = Math.max(1, Math.round(height * k));
    }
    if (base.width !== bw) base.width = bw;
    if (base.height !== bh) base.height = bh;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.drawImage(img, 0, 0, base.width, base.height);
  }, [imageLoaded, imageWidth, imageHeight, dataUrl]);

  // ── 叠加层：后备缓冲按设备像素，尺寸随显示尺寸同步 ──
  useEffect(() => {
    const base = canvasRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay) return;
    const sync = () => {
      const rect = base.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      // 后备缓冲按设备像素，但限制总量：超大图 + 高倍缩放时不至于把显存/内存吃爆
      const maxSide = 4096;
      const maxArea = 16_000_000;
      let ratio = window.devicePixelRatio || 1;
      const longest = Math.max(rect.width, rect.height);
      if (longest * ratio > maxSide) ratio = maxSide / longest;
      const area = rect.width * rect.height * ratio * ratio;
      if (area > maxArea) ratio = Math.sqrt(maxArea / (rect.width * rect.height));
      ratio = Math.max(1, ratio);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
      drawRef.current();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(base);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [imageLoaded, dataUrl]);

  // ── 多边形闭合 ──
  const finishPolygon = useCallback(
    (points: CanvasPoint[]) => {
      if (imageWidth <= 0 || imageHeight <= 0) return;
      const cleaned = points.filter((p, i) => {
        if (i === 0) return true;
        return distance(p, points[i - 1]) > 2;
      });
      if (cleaned.length >= 2 && distance(cleaned[cleaned.length - 1], cleaned[0]) <= 10) {
        cleaned.pop();
      }
      setPolyPoints([]);
      setPolyHover(null);
      if (cleaned.length < 3) return;

      const polygon: [number, number][] = cleaned.map((p) => [
        clamp01(p.x / imageWidth),
        clamp01(p.y / imageHeight),
      ]);
      onAdd({ class_id: newBoxClass, ...polygonBounds(polygon), polygon });
    },
    [imageWidth, imageHeight, newBoxClass, onAdd]
  );

  /** 把旋转矩形写回标注（角点 + 外接矩形信息） */
  const commitRotRect = useCallback(
    (id: string, rect: RotRect, record: boolean) => {
      if (imageWidth <= 0 || imageHeight <= 0) return;
      const polygon: [number, number][] = cornersOf(rect).map(([x, y]) => [
        clamp01(x / imageWidth),
        clamp01(y / imageHeight),
      ]);
      onUpdate(id, { polygon, ...polygonBounds(polygon) }, record);
    },
    [imageWidth, imageHeight, onUpdate]
  );

  // ── 鼠标按下 ──
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!imageLoaded) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const point = getCanvasPoint(e);
    setContextMenu(null);

    // 平移：中键，或平移模式
    if (e.button === 1 || (e.button === 0 && mode === "pan")) {
      const container = containerRef.current;
      if (!container) return;
      panRef.current = {
        x: e.clientX, y: e.clientY,
        left: container.scrollLeft, top: container.scrollTop,
      };
      setIsPanning(true);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const rect = overlay.getBoundingClientRect();
    const unitPerCss = imageWidth / (rect.width || 1);
    const hitRadius = POLYGON_HIT_RADIUS * unitPerCss;
    const handleHalf = (HANDLE_SIZE / 2 + 2) * unitPerCss;

    // 1) 正在画多边形
    if (mode === "polygon" && polyPoints.length > 0) {
      if (
        polyPoints.length >= 3 &&
        distance(point, polyPoints[0]) <= (POLYGON_START_RADIUS + 4) * unitPerCss
      ) {
        finishPolygon(polyPoints);
        return;
      }
      setPolyPoints([...polyPoints, point]);
      return;
    }

    // 1.5) 旋转框模式：旋转手柄 → 角点 → 框内移动 → 新建
    if (mode === "obb") {
      for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        if (!box.polygon || box.polygon.length !== 4) continue;
        const corners = box.polygon.map(([x, y]): [number, number] => [x * imageWidth, y * imageHeight]);
        const rotRect = rotRectFromCorners(corners);
        const handlePos = rotateHandlePos(rotRect, ROTATE_HANDLE_OFFSET * unitPerCss);
        if (Math.hypot(point.x - handlePos[0], point.y - handlePos[1]) <= hitRadius) {
          onSelect(box.id);
          dragRef.current = { kind: "rotate", id: box.id, rect: rotRect };
          return;
        }
        const cornerIndex = corners.findIndex(
          ([cx, cy]) => Math.abs(point.x - cx) <= handleHalf && Math.abs(point.y - cy) <= handleHalf
        );
        if (cornerIndex >= 0) {
          onSelect(box.id);
          dragRef.current = { kind: "obbCorner", id: box.id, rect: rotRect, index: cornerIndex };
          return;
        }
        if (isPointInPolygon(point, corners.map(([x, y]) => ({ x, y })))) {
          onSelect(box.id);
          dragRef.current = { kind: "move", id: box.id, start: point, startBox: box };
          return;
        }
      }
      onSelect(null);
      setDraft({ start: point, end: point });
      return;
    }

    // 2) 已有多边形（倒序：后画的在上）
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i];
      if (!box.polygon || box.polygon.length < 3) continue;
      const poly = box.polygon.map(([x, y]) => ({ x: x * imageWidth, y: y * imageHeight }));
      for (let index = 0; index < poly.length; index++) {
        if (distance(point, poly[index]) <= hitRadius) {
          onSelect(box.id);
          dragRef.current = { kind: "vertex", id: box.id, start: point, startBox: box, index };
          return;
        }
      }
      if (isPointInPolygon(point, poly)) {
        onSelect(box.id);
        dragRef.current = { kind: "move", id: box.id, start: point, startBox: box };
        return;
      }
    }

    // 3) 多边形模式空白处：起新多边形
    if (mode === "polygon") {
      setPolyPoints([point]);
      return;
    }

    // 4) 矩形：先判角手柄，再判框内
    if (mode === "hbb") {
      for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        if (box.polygon && box.polygon.length >= 3) continue;
        const rect = toCanvas(box);
        const handles: { key: string; x: number; y: number }[] = [
          { key: "tl", x: rect.x, y: rect.y },
          { key: "tr", x: rect.x + rect.width, y: rect.y },
          { key: "bl", x: rect.x, y: rect.y + rect.height },
          { key: "br", x: rect.x + rect.width, y: rect.y + rect.height },
        ];
        const hitHandle = handles.find(
          (h) => Math.abs(point.x - h.x) <= handleHalf && Math.abs(point.y - h.y) <= handleHalf
        );
        if (hitHandle) {
          onSelect(box.id);
          dragRef.current = { kind: "resize", id: box.id, start: point, startBox: box, handle: hitHandle.key };
          return;
        }
        if (
          point.x >= rect.x && point.x <= rect.x + rect.width &&
          point.y >= rect.y && point.y <= rect.y + rect.height
        ) {
          onSelect(box.id);
          dragRef.current = { kind: "move", id: box.id, start: point, startBox: box };
          return;
        }
      }
      onSelect(null);
      setDraft({ start: point, end: point });
    }
  };

  // ── 鼠标移动 ──
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!imageLoaded) return;
    if (!overlayRef.current) return;
    const point = getCanvasPoint(e);

    if (mode === "polygon" && polyPoints.length > 0) {
      setPolyHover(point);
    }

    const drag = dragRef.current;
    if (!drag) {
      const draft = draftRef.current;
      if (draft) setDraft({ start: draft.start, end: point });
      return;
    }

    // 旋转：按鼠标相对中心的方向重算角度
    if (drag.kind === "rotate") {
      const record = !drag.recorded;
      drag.recorded = true;
      const next = { ...drag.rect, angle: angleFromPointer(drag.rect, [point.x, point.y]) };
      commitRotRect(drag.id, next, record);
      return;
    }

    // 角点缩放：对角固定、角度不变
    if (drag.kind === "obbCorner") {
      const record = !drag.recorded;
      drag.recorded = true;
      const next = resizeCorner(drag.rect, drag.index, [point.x, point.y], MIN_BOX_PX);
      commitRotRect(drag.id, next, record);
      return;
    }

    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    const startBox = drag.startBox;
    // 一次拖拽只记一次撤销快照
    const record = !drag.recorded;
    drag.recorded = true;

    if (drag.kind === "move") {
      if (startBox.polygon && startBox.polygon.length >= 3) {
        const polygon: [number, number][] = startBox.polygon.map(([x, y]) => [
          clamp01(x + dx / imageWidth),
          clamp01(y + dy / imageHeight),
        ]);
        onUpdate(drag.id, { polygon, ...polygonBounds(polygon) }, record);
      } else {
        const rect = {
          x: (startBox.cx - startBox.w / 2) * imageWidth + dx,
          y: (startBox.cy - startBox.h / 2) * imageHeight + dy,
          width: startBox.w * imageWidth,
          height: startBox.h * imageHeight,
        };
        onUpdate(drag.id, toYolo(rect, startBox.class_id), record);
      }
      return;
    }

    if (drag.kind === "vertex" && startBox.polygon) {
      const polygon: [number, number][] = startBox.polygon.map((p, index) =>
        index === drag.index
          ? [clamp01(p[0] + dx / imageWidth), clamp01(p[1] + dy / imageHeight)]
          : [p[0], p[1]]
      );
      onUpdate(drag.id, { polygon, ...polygonBounds(polygon) }, record);
      return;
    }

    if (drag.kind === "resize") {
      const base = {
        x: (startBox.cx - startBox.w / 2) * imageWidth,
        y: (startBox.cy - startBox.h / 2) * imageHeight,
        width: startBox.w * imageWidth,
        height: startBox.h * imageHeight,
      };
      const next = { ...base };
      if (drag.handle === "tl") {
        next.x += dx; next.y += dy; next.width -= dx; next.height -= dy;
      } else if (drag.handle === "tr") {
        next.y += dy; next.width += dx; next.height -= dy;
      } else if (drag.handle === "bl") {
        next.x += dx; next.width -= dx; next.height += dy;
      } else {
        next.width += dx; next.height += dy;
      }
      next.width = Math.max(MIN_BOX_PX, next.width);
      next.height = Math.max(MIN_BOX_PX, next.height);
      onUpdate(drag.id, toYolo(next, startBox.class_id), record);
    }
  };

  const handleMouseUp = useCallback(() => {
    const draft = draftRef.current;
    if (draft) {
      const width = Math.abs(draft.end.x - draft.start.x);
      const height = Math.abs(draft.end.y - draft.start.y);
      if (width > MIN_BOX_PX && height > MIN_BOX_PX && imageWidth > 0 && imageHeight > 0) {
        const rect = {
          x: Math.min(draft.start.x, draft.end.x),
          y: Math.min(draft.start.y, draft.end.y),
          width,
          height,
        };
        if (mode === "obb") {
          // 旋转框：拖出矩形（角度 0），再用旋转手柄转
          const polygon: [number, number][] = [
            [rect.x / imageWidth, rect.y / imageHeight],
            [(rect.x + rect.width) / imageWidth, rect.y / imageHeight],
            [(rect.x + rect.width) / imageWidth, (rect.y + rect.height) / imageHeight],
            [rect.x / imageWidth, (rect.y + rect.height) / imageHeight],
          ];
          onAdd({ class_id: newBoxClass, ...polygonBounds(polygon), polygon });
        } else {
          onAdd(toYolo(rect, newBoxClass));
        }
      }
      setDraft(null);
    }
    dragRef.current = null;
  }, [imageWidth, imageHeight, newBoxClass, onAdd, toYolo, setDraft, mode]);

  // 拖拽可能在画布外结束：window 级兜底提交（handleMouseUp 内部有 draftRef 幂等保护）
  useEffect(() => {
    const onUp = () => handleMouseUp();
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [handleMouseUp]);

  // ── 平移：window 级监听，允许鼠标移出画布 ──
  useEffect(() => {
    if (!isPanning) return;
    const handleMove = (e: MouseEvent) => {
      const start = panRef.current;
      const container = containerRef.current;
      if (!start || !container) return;
      container.scrollLeft = start.left - (e.clientX - start.x);
      container.scrollTop = start.top - (e.clientY - start.y);
    };
    const handleUp = () => {
      panRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isPanning]);

  // ── 滚轮缩放：非被动监听，以鼠标位置为锚点 ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      e.preventDefault();
      const rect = overlay.getBoundingClientRect();
      if (rect.width === 0) return;
      const fracX = (e.clientX - rect.left) / rect.width;
      const fracY = (e.clientY - rect.top) / rect.height;
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const current = handlersRef.current.scale;
      const next = Math.max(0.1, Math.min(4, Math.round((current + delta) * 10) / 10));
      if (next === current) return;
      const ratio = next / current;
      handlersRef.current.onScaleChange(next);
      requestAnimationFrame(() => {
        container.scrollLeft += fracX * rect.width * (ratio - 1);
        container.scrollTop += fracY * rect.height * (ratio - 1);
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // ── 右键菜单（仅编辑模式；平移模式下不弹，避免误改标签）──
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!imageLoaded) return;
    if (mode === "pan") {
      setContextMenu(null);
      return;
    }
    if (!overlayRef.current) return;
    const rightStart = rightDownRef.current;
    rightDownRef.current = null;
    if (rightStart && Math.hypot(e.clientX - rightStart.x, e.clientY - rightStart.y) > 5) {
      setContextMenu(null);
      return;
    }
    const point = getCanvasPoint(e);
    const hit = [...boxes].reverse().find((box) => {
      const rect = toCanvas(box);
      return point.x >= rect.x && point.x <= rect.x + rect.width
        && point.y >= rect.y && point.y <= rect.y + rect.height;
    });
    if (!hit) {
      setContextMenu(null);
      return;
    }
    onSelect(hit.id);
    setContextMenu({ x: e.clientX, y: e.clientY, boxId: hit.id });
  };

  // ── 快捷键（任意输入框内不触发，Esc 除外）──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const h = handlersRef.current;

      if (e.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (polyPoints.length > 0) {
          setPolyPoints([]);
          setPolyHover(null);
          return;
        }
        if (draftRef.current) setDraft(null);
        return;
      }
      if (isTyping) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) h.onRedo();
        else h.onUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        h.onRedo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && h.selectedId) {
        e.preventDefault();
        h.onDelete(h.selectedId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (h.selectedId) h.onCopy(h.selectedId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        h.onPaste();
        return;
      }
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") {
        h.onPrev();
        return;
      }
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") {
        h.onNext();
        return;
      }
      if (e.key.toLowerCase() === "h") {
        setPolyPoints([]);
        setPolyHover(null);
        h.onModeChange("hbb");
        return;
      }
      if (e.key.toLowerCase() === "p") {
        setDraft(null);
        h.onModeChange("polygon");
        return;
      }
      if (e.key.toLowerCase() === "r") {
        setDraft(null);
        setPolyPoints([]);
        setPolyHover(null);
        h.onModeChange("obb");
        return;
      }
      if (e.key.toLowerCase() === "z") {
        setDraft(null);
        setPolyPoints([]);
        setPolyHover(null);
        h.onModeChange("pan");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, polyPoints, setDraft]);

  const menuBox = useMemo(
    () => (contextMenu ? boxes.find((b) => b.id === contextMenu.boxId) ?? null : null),
    [contextMenu, boxes]
  );

  const cursor =
    isPanning ? "grabbing" : mode === "pan" ? "grab" : mode === "polygon" ? "crosshair" : "crosshair";

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-auto"
      style={{ background: "#13161b", padding: 16 }}
    >
      {!dataUrl ? (
        <div
          className="h-full flex items-center justify-center text-sm"
          style={{ color: "hsl(var(--muted-foreground))" }}
        >
          图片加载中…
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            margin: "0 auto",
            width: `${scale * 100}%`,
            maxWidth: scale <= 1 ? "100%" : "none",
            flexShrink: 0,
            lineHeight: 0,
          }}
        >
          {/* 底图：位图，放大时会有马赛克（正常现象） */}
          <canvas
            ref={canvasRef}
            width={imageWidth || 1}
            height={imageHeight || 1}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              background: "#000",
            }}
          />
          {/* 叠加层：矢量框线/多边形，按设备像素重绘，缩放不会糊 */}
          <canvas
            ref={overlayRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => setPolyHover(null)}
            onDoubleClick={() => {
              if (mode === "polygon" && polyPoints.length >= 3) finishPolygon(polyPoints);
            }}
            onContextMenu={handleContextMenu}
            onMouseDownCapture={(e) => {
              if (e.button === 2) rightDownRef.current = { x: e.clientX, y: e.clientY };
            }}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              cursor,
              boxShadow: "inset 0 0 0 1px hsl(var(--border))",
            }}
          />
        </div>
      )}

      {contextMenu && menuBox && (
        <div
          className="rounded-md text-xs overflow-hidden"
          style={{
            position: "fixed",
            left: Math.min(contextMenu.x, window.innerWidth - 190),
            top: Math.min(contextMenu.y, window.innerHeight - 240),
            zIndex: 1000,
            minWidth: 180,
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <div
            className="px-3 py-2 text-[10px] uppercase tracking-[0.1em]"
            style={{ color: "hsl(var(--muted-foreground))", borderBottom: "1px solid hsl(var(--border))" }}
          >
            切换类别
          </div>
          <div className="max-h-48 overflow-y-auto">
            {Object.entries(classes).map(([id, name]) => (
              <button
                key={id}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2"
                style={{ color: "hsl(var(--foreground))" }}
                onClick={() => {
                  onUpdate(menuBox.id, { class_id: Number(id) }, true);
                  setContextMenu(null);
                }}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: COLORS[Math.abs(Number(id)) % COLORS.length] }}
                />
                <span className="truncate">{name}</span>
              </button>
            ))}
          </div>
          <button
            className="w-full text-left px-3 py-2"
            style={{ color: "hsl(var(--foreground))", borderTop: "1px solid hsl(var(--border))" }}
            onClick={() => {
              props.onCopy(menuBox.id);
              setContextMenu(null);
            }}
          >
            复制该框 (Ctrl+C)
          </button>
          <button
            className="w-full text-left px-3 py-2"
            style={{ color: "hsl(var(--foreground))", borderTop: "1px solid hsl(var(--border))" }}
            onClick={() => {
              props.onPaste();
              setContextMenu(null);
            }}
          >
            粘贴 (Ctrl+V)
          </button>
          <button
            className="w-full text-left px-3 py-2"
            style={{ color: "hsl(var(--destructive))", borderTop: "1px solid hsl(var(--border))" }}
            onClick={() => {
              onDelete(menuBox.id);
              setContextMenu(null);
            }}
          >
            删除该框
          </button>
        </div>
      )}
    </div>
  );
}
