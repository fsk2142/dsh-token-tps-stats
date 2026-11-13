/**
 * **数字格式化**（2026-11-12 从 `tps-pill.ts` 拆出来；2026-11-13 按用户要求改成整数）。
 *
 * 为什么单独一个文件：胶囊、折线图、每步列表都要显示数字，而它们**互相不 import**
 *（弹层挂在 `shell.overlay`、胶囊挂在 `conversation.composer.dock`）。共用一个
 * 格式化函数就不会出现「胶囊显示 4.2、弹层显示 4」这种各说各话的情况，
 * 也避免两个组件文件互相 import 形成环。
 *
 * ## 为什么一律取整（2026-11-13 用户反馈）
 *
 * 用户原话：「速度的加减速变化按照整数变化，不要有小数了，实际上也不可能存在小数
 * 的情况」。
 *
 * 这个读数本来就是**估算**（字符数 ÷ 4.2），小数位的精度是**假的** —— 它来自换算
 * 系数的不确定性，不是真实的测量精度。而且官方那个胶囊显示的是整数 tok/s，
 * 我们显示 `4.2` 反而比它「精确」得可疑。
 *
 * 所以这里统一 `Math.round`。代价是 0.5~1.5 之间的读数会显示成 `0`/`1`/`2`，
 * 对「空闲时显示 0」这条要求没有影响（低于 0.5 的读数原本就被速度计判为 0）。
 *
 * @module dsh-token-tps-stats/src/client/format
 */

/**
 * 把数值格式化成显示文本（**整数**）。
 * @param value - tok/s。
 * @returns 显示文本。
 */
export function formatRate(value: number): string {
  const clamped = Number.isFinite(value) ? Math.max(0, value) : 0;
  return String(Math.round(clamped));
}

/**
 * 把 token 数量格式化成显示文本（**千分位**）。
 *
 * 每步列表里的 input/output 是**真实 usage 数字**（不是估算），可能上万；
 * 逐位读「128493」很容易数错位数，加千分位读「128,493」就够了。
 * @param value - token 数。
 * @returns 显示文本；非法值显示 `—`。
 */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  return String(Math.round(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 把比例格式化成百分比（**整数**）。
 * @param numerator - 分子（例如命中的缓存 token）。
 * @param denominator - 分母（例如提示总量）；非正数时返回 `"—"`。
 * @returns 例如 `"97%"`。
 */
export function formatPercent(numerator: number | undefined, denominator: number | undefined): string {
  if (denominator === undefined || !Number.isFinite(denominator) || denominator <= 0) return "—";
  if (numerator === undefined || !Number.isFinite(numerator)) return "—";
  const percent = Math.round((numerator / denominator) * 100);
  return `${Math.min(100, Math.max(0, percent))}%`;
}

/**
 * 把**已经算好的比例**（0~1）格式化成百分比。
 *
 * 与 {@link formatPercent} 分开是因为调用方常常已经除过了（例如「读取 ÷ 提示总量」），
 * 再传一对分子分母只会让读代码的人怀疑自己看错。
 * @param ratio - 比例（0~1）；缺省时返回 `"—"`。
 * @returns 例如 `"97%"`。
 */
export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  const percent = Math.round(ratio * 100);
  return `${Math.min(100, Math.max(0, percent))}%`;
}
