/**
 * obb.ts
 * 旋转框（Oriented Bounding Box）几何工具。
 *
 * YOLO OBB 的标注格式是 4 个角点 8 个坐标，但这 4 个点必须是「矩形旋转一个角度」的结果：
 * 对边等长、邻边垂直。本文件用 (cx, cy, w, h, angle) 作为唯一真值，
 * 角点由它推导，避免出现任意四边形。
 *
 * 所有坐标单位由调用方决定（本组件内统一用图片逻辑像素）。
 */

export interface RotRect {
  cx: number;
  cy: number;
  /** 未旋转时的宽（沿局部 u 轴） */
  w: number;
  /** 未旋转时的高（沿局部 v 轴） */
  h: number;
  /** 弧度，局部 u 轴相对图片 x 轴的角度 */
  angle: number;
}

type Point = [number, number];

/** 局部轴：u = 宽方向，v = 高方向（右手系，v 由 u 逆时针 90°） */
export function axesOf(angle: number): { u: Point; v: Point } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { u: [c, s], v: [-s, c] };
}

/** 4 个角点，顺序：左上(tl) → 右上(tr) → 右下(br) → 左下(bl)（相对局部坐标系） */
export function cornersOf(rect: RotRect): Point[] {
  const { u, v } = axesOf(rect.angle);
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const offsets: Point[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return offsets.map(([a, b]) => [
    rect.cx + u[0] * a + v[0] * b,
    rect.cy + u[1] * a + v[1] * b,
  ]);
}

/** 从 4 个角点还原矩形参数（角点顺序须为 tl → tr → br → bl） */
export function rotRectFromCorners(pts: Point[]): RotRect {
  const [p0, p1, , p3] = pts;
  const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const h = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  return {
    cx: (pts[0][0] + pts[2][0]) / 2,
    cy: (pts[0][1] + pts[2][1]) / 2,
    w,
    h,
    angle,
  };
}

/** 判断 4 个点是否近似为一个旋转矩形（允许少量误差） */
export function isRotatedRect(pts: Point[], tolerance = 0.02): boolean {
  if (pts.length !== 4) return false;
  const rect = rotRectFromCorners(pts);
  const ideal = cornersOf(rect);
  const scale = Math.max(rect.w, rect.h) || 1;
  return pts.every((p, i) => Math.hypot(p[0] - ideal[i][0], p[1] - ideal[i][1]) <= scale * tolerance);
}

/** 以矩形中心旋转到指定角度（弧度） */
export function rotateTo(rect: RotRect, angle: number): RotRect {
  return { ...rect, angle };
}

/**
 * 拖拽某个角点：对角点保持不动，角度不变，只改宽高。
 * index 为 cornersOf 的索引，target 为鼠标位置。
 */
export function resizeCorner(rect: RotRect, index: number, target: Point, minSize = 2): RotRect {
  const corners = cornersOf(rect);
  const fixed = corners[(index + 2) % 4];
  const { u, v } = axesOf(rect.angle);
  const dx = target[0] - fixed[0];
  const dy = target[1] - fixed[1];
  const along = dx * u[0] + dy * u[1];
  const across = dx * v[0] + dy * v[1];
  const w = Math.max(minSize, Math.abs(along));
  const h = Math.max(minSize, Math.abs(across));
  return {
    cx: fixed[0] + (u[0] * along) / 2 + (v[0] * across) / 2,
    cy: fixed[1] + (u[1] * along) / 2 + (v[1] * across) / 2,
    w,
    h,
    angle: rect.angle,
  };
}

/** 旋转手柄位置（顶边中点沿 -v 方向外移 offset） */
export function rotateHandlePos(rect: RotRect, offset: number): Point {
  const { v } = axesOf(rect.angle);
  const top: Point = [
    rect.cx - v[0] * (rect.h / 2),
    rect.cy - v[1] * (rect.h / 2),
  ];
  return [top[0] - v[0] * offset, top[1] - v[1] * offset];
}

/** 鼠标位置 → 旋转角（手柄朝上时 angle = 0） */
export function angleFromPointer(rect: RotRect, pointer: Point): number {
  const dx = pointer[0] - rect.cx;
  const dy = pointer[1] - rect.cy;
  return Math.atan2(dy, dx) + Math.PI / 2;
}

export function radToDeg(rad: number): number {
  let deg = (rad * 180) / Math.PI;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
