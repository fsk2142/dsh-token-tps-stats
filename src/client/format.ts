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
 *
 * ## 为什么 99.995% 以上要保留小数（2026-11-13 用户反馈）
 *
 * 用户看到整张表的命中率都是 `100%`，问「为什么命中率都是 100%？按理说应该不会
 * 存在 100 吧」。他截图那一行是 `读取 394,880 / 输入 496` —— 真实比例
 * **99.87%**，四舍五入到整数就变成了 100。
 *
 * 这是显示精度问题，不是算法问题：真实满命中（未缓存输入与缓存写入都是 0）
 * 才应该读 100。所以这里照宿主的 `formatCacheHitPercent` 同样的思路处理 ——
 * 整数位会进位到 100 时**多留一位**，仍然不够就再留一位，最多三位；
 * 只有比例**恰好等于 1** 才显示 `100%`。
 * @param ratio - 比例（0~1）；缺省时返回 `"—"`。
 * @returns 例如 `"99.9%"` / `"97%"` / `"100%"`。
 */
export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  const clamped = Math.min(1, Math.max(0, ratio));
  const percent = clamped * 100;
  if (percent === 100) return "100%";
  if (Math.round(percent) < 100) return `${Math.round(percent)}%`;
  /*
   * 会进位到 100 但**并不是** 100：逐位加小数，直到读数不再等于 100。
   * 三位还不够接近（例如 99.9997）就停在 `99.999%` —— 再往里加位数没有任何
   * 读者能从 440px 宽的表格里分辨出来，而且那会暗示一个根本不存在的精度。
   */
  const tenth = Math.round(percent * 10) / 10;
  if (tenth < 100) return `${tenth.toFixed(1)}%`;
  const hundredth = Math.round(percent * 100) / 100;
  if (hundredth < 100) return `${hundredth.toFixed(2)}%`;
  return "99.999%";
}
