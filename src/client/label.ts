/**
 * **胶囊上那行字怎么拼**（2026-11-13）。
 *
 * ## 为什么需要它
 *
 * 用户问「现在这个速度是纯输出的速度吗？」，并要求：**口径保持不变（正文 + 思考），
 * 但模型只在调工具、没有可见文字时不要再显示 0**。
 *
 * 本会话实测：725 条助手回复里 **374 条（52%）** 只有工具调用、没有可见文字。
 * 那段时间模型确实在流式吐 token（工具参数），读数却一直是 0 ——「明明在干活，
 * 仪表像停了」最容易让人以为插件坏了。
 *
 * ## 为什么不把工具参数算进读数
 *
 * 算不进去：客户端快照里 `tool-call` 块的 `argsRaw` 在**流式中途始终是空串**，
 * 宿主只在 `block-end` 才把完整参数填进去（见 `dsh-client-ui-chat` 的 `updateChunk`）。
 * 拿不到增量就没有速率可言。
 *
 * 而且把工具参数混进 tok/s 会让数字**不再是「输出文本的速度」**：一次读大文件能把
 * 读数顶到几百，那不是用户想看的模型吐字快慢。
 *
 * ## 三种状态与宽度
 *
 * | 状态 | 文本 | 宽度 |
 * | --- | --- | --- |
 * | 有速度 | `实时输出速度（TPS）：42 tok/s` | 宽 |
 * | 只调工具 | `实时输出速度（TPS）：工具调用中` | 与上面**基本相等** |
 * | 空闲 | `实时输出速度（TPS）：0 tok/s` | 宽 |
 *
 * 数字那一段占**固定 `4ch`**（用户要求「固定宽度，别把所有胶囊推来推去」），
 * 所以速度状态内部的宽度恒等；工具状态去掉了数字位与单位、直接接一个 5 字的状态词，
 * 与「4ch 数字 + ` tok/s`」几乎同宽 —— 阶段切换时胶囊不会明显伸缩。
 *
 * @module dsh-token-tps-stats/src/client/label
 */

/** 胶囊当前该显示哪一类文本。 */
export type PillMode = "rate" | "tool" | "idle";

/** 胶囊文本的形状。 */
export interface PillLabel {
  /** 模式（决定颜色的深浅与无障碍文案）。 */
  readonly mode: PillMode;
  /** 固定前缀。 */
  readonly prefix: string;
  /** 定宽数字（只有 `rate` / `idle` 有）；`tool` 状态没有数字位。 */
  readonly number: string | undefined;
  /** 定宽数字之后的文字（单位，或状态词）。 */
  readonly suffix: string;
}

/** 固定前缀。 */
const PREFIX = "实时输出速度（TPS）：";

/** 速度单位。 */
const UNIT = " tok/s";

/** 「只调工具」时接在前缀后面的状态词（用它取代数字位与单位，宽度才不变）。 */
const TOOL_TEXT = "工具调用中";

/**
 * 决定胶囊显示什么。
 * @param mode - 这一拍的状态。
 * @param rate - 当前读数（tok/s）。
 * @param format - 数字格式化（注入 `formatRate`，单测不必依赖它）。
 * @returns 文本形状。
 */
export function pillLabelOf(mode: PillMode, rate: number, format: (value: number) => string): PillLabel {
  if (mode === "tool") return { mode, prefix: PREFIX, number: undefined, suffix: TOOL_TEXT };
  const shown = mode === "idle" ? 0 : rate;
  if (shown <= 0) return { mode: "idle", prefix: PREFIX, number: format(0), suffix: UNIT };
  return { mode: "rate", prefix: PREFIX, number: format(shown), suffix: UNIT };
}

/**
 * 胶囊的无障碍文案（读屏用）。
 *
 * 不复用 {@link pillLabelOf} 的拼接：把「工具调用中」读成一句话，别读成
 * 「实时输出速度（TPS）：工具调用中」那种半截子。
 * @param mode - 模式。
 * @param rate - 读数（tok/s）。
 * @param format - 数字格式化。
 * @param expanded - 弹层是否已展开。
 * @returns 读屏文案。
 */
export function pillAriaOf(
  mode: PillMode,
  rate: number,
  format: (value: number) => string,
  expanded: boolean,
): string {
  const tail = expanded ? "点击收起变化曲线" : "点击查看变化曲线";
  if (mode === "tool") return `模型正在调用工具（当前没有可见文字输出），${tail}`;
  const shown = mode === "idle" ? 0 : Math.max(0, Number.isFinite(rate) ? rate : 0);
  return `实时输出速度（TPS）：${format(shown)} tok/s，${tail}`;
}
