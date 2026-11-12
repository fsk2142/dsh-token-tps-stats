/**
 * **折线图的几何**（2026-11-12，第 3 步）。
 *
 * 纯函数：把「每秒一个 tok/s」的序列折算成 SVG path 与坐标轴刻度。
 * 单独成文件是为了能完整单测 —— 画错的坐标轴（比如最大值取整成 47 这种数）
 * 靠肉眼看不出规律，只能靠断言钉住。
 *
 * @module dsh-token-tps-stats/src/client/chart-geometry
 */

/** 序列 → SVG 的映射参数（都是绘图区**内部**的坐标，不含外边距）。 */
export interface ChartGeometryOptions {
  /** 绘图区宽度（像素）。 */
  readonly width: number;
  /** 绘图区高度（像素）。 */
  readonly height: number;
  /** 纵轴最大值（tok/s）；`0` 会被兜成一个正数，避免除零。 */
  readonly max: number;
}

/** 折线的几何结果。 */
export interface ChartGeometry {
  /** 折线 path 的 `d`。 */
  readonly line: string;
  /** 折线下方的填充 path 的 `d`（闭合到基线）。 */
  readonly area: string;
  /** 每个点的像素坐标（最旧 → 最新），画节点/标记用。 */
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /** 纵轴实际使用的最大值。 */
  readonly max: number;
}

/**
 * 把最大值「向上取整」到一眼能读的数（1 / 2 / 2.5 / 5 / 10 × 10^n）。
 *
 * 为什么不能直接用峰值当最大值：峰值 47 时纵轴顶端会标成 47，刻度只能标 0/12/23/35
 * 这种读不顺的数。取整到 50 之后，刻度就是 0/25/50。
 * @param value - 峰值（tok/s）。
 * @returns 不小于 `value` 的「整齐」数；`value <= 0` 时给一个最小量程。
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = Math.pow(10, exponent);
  const normalized = value / magnitude;
  const steps = [1, 2, 2.5, 5, 10];
  for (const step of steps) {
    if (normalized <= step) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * 造纵轴刻度（从 0 到 `max`，含两端）。
 * @param max - 纵轴最大值（建议先过 {@link niceMax}）。
 * @param count - 段数（刻度数 = count + 1）。
 * @returns 从 0 到 `max` 的刻度值。
 */
export function axisTicks(max: number, count = 2): number[] {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 10;
  const safeCount = Math.max(1, Math.floor(count));
  const ticks: number[] = [];
  for (let index = 0; index <= safeCount; index += 1) {
    ticks.push((safeMax / safeCount) * index);
  }
  return ticks;
}

/**
 * 把序列映射成绘图区内的坐标。
 *
 * - 横轴按**点序**等分（每秒一个点，间距天然相等）；
 * - 只有 1 个点时放在正中（否则会画在 x=0 的左边缘上，像被截断）；
 * - 纵轴按 `max` 归一，越界值被夹到 0..max（浮点误差不该画出格）。
 * @param values - 序列值（最旧 → 最新）。
 * @param options - 绘图区尺寸与纵轴最大值。
 * @returns 折线 / 填充 / 点的几何。
 */
export function buildGeometry(values: readonly number[], options: ChartGeometryOptions): ChartGeometry {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : 10;
  const count = values.length;
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = count === 1 ? width / 2 : (index / (count - 1)) * width;
    const raw = Number.isFinite(values[index]) ? values[index]! : 0;
    const clamped = Math.min(max, Math.max(0, raw));
    const y = height - (clamped / max) * height;
    points.push({ x: round(x), y: round(y) });
  }
  if (points.length === 0) {
    // 没有点也要返回可用的空串，调用方可以据此跳过绘制。
    return { line: "", area: "", points: [], max };
  }
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const area = `${line} L${last.x} ${round(height)} L${first.x} ${round(height)} Z`;
  return { line, area, points, max };
}

/**
 * 保留两位小数。
 *
 * SVG path 里带一长串浮点尾数会让产物变丑、也让断言难以书写；
 * 两位小数对像素坐标已经远超够用精度。
 * @param value - 原始值。
 * @returns 两位小数的值。
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
