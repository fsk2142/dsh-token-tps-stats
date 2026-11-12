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
  /**
   * 折线 path 的 `d`：**平滑曲线**（单调三次 Hermite 转三次贝塞尔）。
   *
   * 为什么不是 `L` 折线：用户 2026-11-13 明确要求「尽可能平滑一些，不要折线，
   * 突然上升突然下降」。逐点连直线时，相邻两点的斜率会在每个点上突变，
   * 看起来就是一串直角台阶。
   */
  readonly line: string;
  /**
   * 折线下方的填充 path（闭合到基线）。
   *
   * **当前不再使用**（2026-11-12：本主题的 `brand-primary` 是近黑色，12% 叠在白卡片
   * 上就是一片灰，用户明确要求「折线图里不要灰色的底」）。仍然算出来是因为它是纯几何、
   * 不额外读状态：将来若换成浅色强调色（或换主题令牌），上层可以直接拿来用，不必
   * 回头改这一层。
   */
  readonly area: string;
  /** 每个点的像素坐标（最旧 → 最新），画节点/标记用。 */
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /** 纵轴实际使用的最大值。 */
  readonly max: number;
}

/**
 * 把最大值「向上取整」到一眼能读的数（1 / 2 / 2.5 / 5 / 10 × 10^n），再**取整**。
 *
 * 为什么不能直接用峰值当最大值：峰值 47 时纵轴顶端会标成 47，刻度只能标 0/12/23/35
 * 这种读不顺的数。取整到 50 之后，刻度就是 0/25/50。
 *
 * 为什么最后还要 `Math.round`（2026-11-13）：用户要求「按照整数变化，不要有小数」。
 * 刻度是给人看的数字，`2.5` 这种只是数学上漂亮、读起来不整齐；取整后 2.5 → 3，
 * 刻度就是 0/2/3（`axisTicks` 会去重）。
 * @param value - 峰值（tok/s）。
 * @returns 不小于 `value` 的「整齐」整数；`value <= 0` 时给一个最小量程。
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = Math.pow(10, exponent);
  const normalized = value / magnitude;
  const steps = [1, 2, 2.5, 5, 10];
  let picked = 10 * magnitude;
  for (const step of steps) {
    if (normalized <= step) {
      picked = step * magnitude;
      break;
    }
  }
  // 小于 1 的量程没有意义（峰值都 >0 了，轴底至少给到 1），其余取整。
  return Math.max(1, Math.round(picked));
}

/**
 * 造纵轴刻度（从 0 到 `max`，含两端），**只出整数**。
 *
 * `max / count` 不能整除时（例如 max=50、count=3）中间刻度会取整，重复值去掉 ——
 * 宁可少一条刻度线，也不要出现 `16.67` 这种读数。
 * @param max - 纵轴最大值（建议先过 {@link niceMax}）。
 * @param count - 段数（刻度数最多 count + 1）。
 * @returns 从 0 到 `max` 的整数刻度（升序、无重复）。
 */
export function axisTicks(max: number, count = 2): number[] {
  const safeMax = Math.max(1, Math.round(Number.isFinite(max) && max > 0 ? max : 10));
  const safeCount = Math.max(1, Math.floor(count));
  const ticks: number[] = [];
  for (let index = 0; index <= safeCount; index += 1) {
    const value = Math.round((safeMax / safeCount) * index);
    if (index === safeCount) ticks.push(safeMax);
    else if (value !== ticks[ticks.length - 1]) ticks.push(value);
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
  const line = smoothPath(points);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const area = `${line} L${last.x} ${round(height)} L${first.x} ${round(height)} Z`;
  return { line, area, points, max };
}

/**
 * 把点列连成**平滑曲线**（单调三次 Hermite → 三次贝塞尔）。
 *
 * ## 为什么不直接用地三次样条（Catmull-Rom）
 *
 * 普通样条会在「急升之后立刻急降」的地方**过冲**：曲线先冲过峰值再掉回来，
 * 画出的尖角比原来的折线还夸张。而速度序列的特点恰恰是「长时间在 0、突然一段
 * 很高」—— 用户看到的假尖峰会被样条再放大一次。
 *
 * 这里用的是 Fritsch–Carlson 式的**单调保形**处理：先把每段斜率夹到
 * `[0, 3×该段割线斜率]`（相邻割线异号时直接取 0），再把每段的两端斜率换成控制点。
 * 效果是：数据里的极值点会变成曲线的**极值点**（不过冲），转折处也不再是直角。
 *
 * 每段控制点取 `dx/3`（而不是 `/6`），因为这里的 y 轴是**像素**、x 轴也是像素，
 * 两者量纲一致，用 `1/3` 的切线长度正好让曲线在两端与切线相切。
 * @param points - 像素坐标（x 单调递增，最旧 → 最新）。
 * @returns SVG path（`M` + 若干 `C`）。
 */
function smoothPath(points: readonly { x: number; y: number }[]): string {
  if (points.length <= 2) {
    // 两点（或一点）没有「平滑」可言：点少时贝塞尔退化成直线，直接连。
    return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  }
  /** 每段的割线斜率。 */
  const secants: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const dx = points[index + 1]!.x - points[index]!.x;
    secants.push(dx === 0 ? 0 : (points[index + 1]!.y - points[index]!.y) / dx);
  }
  /** 每个点上的切线斜率（保形处理后的结果）。 */
  const tangents: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (index === 0) {
      tangents.push(secants[0]!);
    } else if (index === points.length - 1) {
      tangents.push(secants[secants.length - 1]!);
    } else {
      const previous = secants[index - 1]!;
      const next = secants[index]!;
      // 两侧异号（或有一侧是平的）→ 这里是真极值/平台，切线取 0，绝不过冲。
      if (previous * next <= 0) tangents.push(0);
      else tangents.push((previous + next) / 2);
    }
  }
  /*
   * 保形夹逼：任一点的切线不能超过相邻两段割线斜率的 3 倍（Fritsch–Carlson 条件）。
   * 不夹的话「前一段很平、后一段很陡」的拐点上，曲线会冲出去再折回来。
   */
  for (let index = 0; index < points.length - 1; index += 1) {
    const secant = secants[index]!;
    if (secant === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const limit = 3 * secant;
    if (limit > 0) {
      tangents[index] = Math.min(tangents[index]!, limit);
      tangents[index + 1] = Math.min(tangents[index + 1]!, limit);
    } else {
      tangents[index] = Math.max(tangents[index]!, limit);
      tangents[index + 1] = Math.max(tangents[index + 1]!, limit);
    }
  }

  const parts = [`M${points[0]!.x} ${points[0]!.y}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const third = (to.x - from.x) / 3;
    const c1x = round(from.x + third);
    const c1y = round(from.y + tangents[index]! * third);
    const c2x = round(to.x - third);
    const c2y = round(to.y - tangents[index + 1]! * third);
    parts.push(`C${c1x} ${c1y} ${c2x} ${c2y} ${to.x} ${to.y}`);
  }
  return parts.join(" ");
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
