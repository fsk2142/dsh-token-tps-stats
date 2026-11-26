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

/** 速度单位（**每个读数都带**，2026-11-13 用户反馈）。 */
export const RATE_UNIT = " tok/s";

/**
 * 带单位的速度读数（`"75 tok/s"`）。
 *
 * ## 为什么单位要写死在格式化里（2026-11-13 用户第二次反馈）
 *
 * 用户看着副标题那行说：
 *
 * > 这里当前 75 tok/s，但是后边的平均和峰值就没有单位了，至少统一一下吧
 *
 * 原来那一行是 `当前 75 tok/s · 平均 65 · 峰值 86` —— 只有第一个读数带单位，
 * 后两个是光秃秃的数字。人多半会把它们读成「65 和 86 个什么」。
 *
 * 修法有两种：给三个都补单位（`平均 65 tok/s · 峰值 86 tok/s`），或者
 * **只在最后补一次**（`当前 75 · 平均 65 · 峰值 86 tok/s`）。选了前者：
 *
 * - 后者更短，但 `当前 75` 后面紧跟的是「· 平均」，读者仍要往后跳三个数才知道
 *   单位是什么 —— 那正是用户抱怨的地方；
 * - 前者每一段自足，复制任意一段到别处也说得通；
 * - 五个 ` tok/s` 才 30px，190px 高的面板不缺这点宽度。
 *
 * **单位跟着数字走**（而不是在调用方拼字符串），这样任何新加的读数只要用
 * {@link formatRateWithUnit}，就不会再漏。
 * @param value - tok/s。
 * @returns 例如 `"75 tok/s"`。
 */
export function formatRateWithUnit(value: number): string {
  return `${formatRate(value)}${RATE_UNIT}`;
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
 * 把**已经算好的比例**（0~1）格式化成百分比。
 *
 * 调用方已经除好了（例如「读取 ÷ 提示总量」），这里只负责显示成两位小数。
 *
 * ## 统一保留两位小数（2026-11-13 用户第二次反馈）
 *
 * 先是用户看到整张表的命中率都是 `100%`，问「为什么命中率都是 100%？按理说应该
 * 不会存在 100 吧」。他截图那一行是 `读取 394,880 / 输入 496` —— 真实比例
 * **99.87%**，四舍五入到整数就变成了 100。这是显示精度问题，不是算法问题：
 * 真实满命中（未缓存输入与缓存写入都是 0）才该读 100。
 *
 * 第一版改成「会进位到 100 时才多留一位小数」，但那样同一张表里 `62%` 与
 * `99.9%` 混排、小数点位置对不齐；用户随后说「可以用两位小数」。所以**统一两位**：
 *
 * | 真实比例 | 显示 |
 * | --- | --- |
 * | 恰好 1（真满命中） | `100%` |
 * | 99.8745% | `99.87%` |
 * | 62% | `62.00%` |
 *
 * 不足两位的补零（`62.00%` 而不是 `62%`）：数值列本来就右对齐 + 等宽，
 * 位数一致时上下更容易比较 —— 这正是用户要「两位小数」的动机。
 * @param ratio - 比例（0~1）；缺省时返回 `"—"`。
 * @returns 例如 `"99.87%"` / `"62.00%"` / `"100%"`。
 */
export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  const clamped = Math.min(1, Math.max(0, ratio));
  const percent = clamped * 100;
  // 真满命中：不加小数点，读者一眼就知道是「一点没漏」。
  if (percent === 100) return "100%";
  const rounded = Math.round(percent * 100) / 100;
  // 四舍五入后可能因为浮点误差凑到 100（例如 99.9999），这时仍然显示 99.99+ 的读数。
  if (rounded >= 100) return "99.99%";
  return `${rounded.toFixed(2)}%`;
}
