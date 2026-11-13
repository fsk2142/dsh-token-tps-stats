/**
 * **胶囊上那行字怎么拼**（2026-11-13）。
 *
 * ## 为什么单独一个模块
 *
 * 那行字有两个容易写歪的地方，都值得钉在纯函数上：
 *
 * 1. **固定宽度**（用户要求「别把所有胶囊推来推去」）：数字那一段必须占固定的
 *    `4ch`、右对齐，速度在 47→48→49 之间跳时外框纹丝不动；
 * 2. **无障碍文案**：读屏读到的是句子，不是把几段 DOM 文本原样念一遍。
 *
 * ## 为什么**没有**「工具调用中」这个状态了（2026-11-13 用户改口）
 *
 * 中途加过一版：只调工具、没有可见文字时显示 `工具调用中`，理由是「明明在干活，
 * 仪表像停了」（本会话 725 条回复里 374 条属于这种）。用户实际看过之后决定
 * **不要状态词**，回到 `0 tok/s`：
 *
 * > 工具调用的时候还是不要显示文字，还是显示 0 tok/s 吧
 *
 * 这个取舍是对的 —— 那一格只有一个语义（输出文本的速度），插一句状态说明会让
 * 「这是速度吗」变得含糊。工具参数本来也不算进 tok/s（`argsRaw` 在流式中途
 * 始终是空串，拿不到增量），显示 0 与口径一致。
 *
 * @module dsh-token-tps-stats/src/client/label
 */

/** 胶囊文本的形状。 */
export interface PillLabel {
  /** 固定前缀。 */
  readonly prefix: string;
  /** 定宽数字（`4ch`、右对齐）。 */
  readonly number: string;
  /** 数字之后的单位。 */
  readonly suffix: string;
}

/** 固定前缀。 */
const PREFIX = "实时输出速度（TPS）：";

/** 速度单位。 */
const UNIT = " tok/s";

/**
 * 决定胶囊显示什么。
 * @param rate - 当前读数（tok/s）；非有限值或 ≤0 一律显示 `0`。
 * @param format - 数字格式化（注入 `formatRate`，单测不必依赖它）。
 * @returns 文本形状。
 */
export function pillLabelOf(rate: number, format: (value: number) => string): PillLabel {
  const shown = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return { prefix: PREFIX, number: format(shown), suffix: UNIT };
}

/**
 * 胶囊的无障碍文案（读屏用）。
 * @param rate - 读数（tok/s）。
 * @param format - 数字格式化。
 * @param expanded - 弹层是否已展开。
 * @returns 读屏文案。
 */
export function pillAriaOf(rate: number, format: (value: number) => string, expanded: boolean): string {
  const shown = Number.isFinite(rate) && rate > 0 ? rate : 0;
  const tail = expanded ? "点击收起变化曲线" : "点击查看变化曲线";
  return `实时输出速度（TPS）：${format(shown)} tok/s，${tail}`;
}
