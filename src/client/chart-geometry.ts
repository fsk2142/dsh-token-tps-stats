/**
 * **折线图的几何**（2026-11-12，第 3 步；2026-11-13 换「50 起步的阶梯量程」）。
 *
 * 纯函数：把「每秒一个 tok/s」的序列折算成 SVG path 与坐标轴刻度。
 * 单独成文件是为了能完整单测 —— 画错的坐标轴靠肉眼看不出规律，只能靠断言钉住。
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

/** 纵轴量程：上限、格宽、刻度。 */
export interface AxisScale {
  /** 纵轴上限（`step × 段数`，恒为整数）。 */
  readonly max: number;
  /** 相邻刻度之间的差（恒为整数）。 */
  readonly step: number;
  /** 从 0 到 `max` 的刻度值（升序，含两端）。 */
  readonly ticks: readonly number[];
}

/**
 * 阶梯：格宽只取 **50 的整数倍**。
 *
 * ## 为什么必须是 50 的倍数（2026-11-13 用户第二次纠正）
 *
 * 用户原话：「50 递增指的是纵轴是**每 50 一个可读**，你叫什么 1 2 5 10」。
 *
 * 我上一版把阶梯写成 1 / 2 / 5 / 10 / 25 / 50 / …，意思是「48 → 格宽 25」，
 * 于是小峰值会看到 `0 / 25 / 50` 这种刻度 —— 那不是用户要的东西。他要的是
 * **刻度线上永远读 0、50、100、150…**，108 的峰值就把上限顶到 150。
 *
 * 所以这里从 **50** 起步，往上全是 50 的倍数。峰值再大（几百、上千）时格宽必须
 * 跟着放大 —— 92px 高的绘图区里画 7 条线（每 15px 一条）刻度和标签会糊在一起。
 * 放大的台阶同样取 50 的倍数（100 / 250 / 500 …），所以「每格仍是 50 的整数倍」
 * 这条不变，只是每格可能装 2、5、10 个 50。
 */
const AXIS_STEPS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000] as const;

/**
 * 最多画几段（段数 = 刻度数 − 1）。
 *
 * 取 6：绘图区 92px 高，7 条刻度相邻约 15px，10px 的标签放得下。
 * 再放宽就会挤成一团；收紧则 300 这种峰值就要从「每 50」跳到「每 100」——
 * 而这正是用户明确不要的东西（他要的就是刻度线上永远读 50 的倍数）。
 *
 * 真实会话里 300 tok/s 已经是很高的峰值了，所以这一档基本够用；
 * 真到上千才放大格宽（那时刻度会变成 250/500 一格，仍然是 50 的倍数）。
 */
const MAX_SEGMENTS = 6;

/** 最小上限：速度再低也留 0/50 两条线，别把曲线压成贴着底边的一条直线。 */
const MIN_MAX = 50;

/**
 * 算纵轴量程：**上限是格宽的整数倍**，格宽是 50 的倍数，且尽量贴近峰值。
 *
 * 选格规则：在 {@link AXIS_STEPS} 里挑**能放下峰值的最小格宽**（要求
 * `ceil(峰值/格宽)` 不超过 {@link MAX_SEGMENTS} 段，段数太多刻度会挤）。于是：
 *
 * | 峰值 | 格宽 | 上限 | 刻度 |
 * | --- | --- | --- | --- |
 * | 108 | 50 | 150 | 0 / 50 / 100 / 150 |
 * | 29 | 50 | 50 | 0 / 50 |
 * | 3.4 | 50 | 50 | 0 / 50 |
 * | 300 | 100 | 300 | 0 / 100 / 200 / 300 |
 * | 2 000 | 1 000 | 2 000 | 0 / 1 000 / 2 000 |
 *
 * @param peak - 序列峰值（tok/s）。
 * @param maxSegments - 最多段数，缺省 {@link MAX_SEGMENTS}。
 * @returns 上限 / 格宽 / 刻度。
 */
export function axisScale(peak: number, maxSegments: number = MAX_SEGMENTS): AxisScale {
  const segments = Math.max(1, Math.floor(maxSegments));
  const value = Number.isFinite(peak) && peak > 0 ? peak : 0;
  /*
   * **完全没有数据**时也是 0/50 两条线：与有数据时的最小量程一致，
   * 空图表不会因为「峰值 0」突然换一套刻度。
   */
  if (value <= MIN_MAX) {
    const floorScale: AxisScale = { max: MIN_MAX, step: MIN_MAX, ticks: [0, MIN_MAX] };
    return floorScale;
  }
  for (const step of AXIS_STEPS) {
    if (Math.ceil(value / step) > segments) continue;
    const used = Math.max(1, Math.ceil(value / step));
    const max = step * used;
    const ticks: number[] = [];
    for (let index = 0; index <= used; index += 1) ticks.push(step * index);
    return { max, step, ticks };
  }
  // 峰值大到超出阶梯上限（理论上不会）：退回「整千倍」的粗格。
  const step = Math.ceil(value / segments);
  const max = step * segments;
  const ticks: number[] = [];
  for (let index = 0; index <= segments; index += 1) ticks.push(step * index);
  return { max, step, ticks };
}

/**
 * 纵轴上限（{@link axisScale} 的便捷取法）。
 * @param value - 峰值（tok/s）。
 * @returns 不小于 `value` 的整数上限，且上限/格宽是整数段。
 */
export function niceMax(value: number): number {
  return axisScale(value).max;
}

/**
 * 造纵轴刻度（从 0 到 `max`，均分 `count` 段，**只出整数**）。
 *
 * 注：图表本身用 {@link axisScale} 一起拿上限与刻度（保证刻度落在整格上）。
 * 这个函数保留给「只想要一组整数刻度」的调用方。
 * @param max - 纵轴最大值。
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
