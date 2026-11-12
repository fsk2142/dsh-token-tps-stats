/**
 * **把一批流式 chunk 按宿主时间铺回时间轴**（2026-11-13，修「峰值偶尔冲到 1000 多」）。
 *
 * ## 为什么会冲高
 *
 * 速度计的输入是「字到达我这台机器的时刻」（`Date.now()`）。这个时刻**不一定均匀**：
 * 浏览器主线程被长文本渲染占住、标签页切到后台、宿主把一批 `live-chunk` 攒起来一次
 * 性 flush —— 这些情况下，几分钟的模型产出会在**几毫秒内**全部到达。
 * 按到达时刻直接累计，那几毫秒就被算成「几分钟的字挤在 1 秒里」，
 * 读数可以冲到 1000 tok/s，而真实速度只有 60~80。
 *
 * 用会话日志里的 `assistant/attempt.stream` 核对过（宿主冻结的时间线）：
 * 同一段流 **334 字符/秒 ≈ 66 tok/s**，批间隔中位数 2ms、p90 684ms、最长 1527ms；
 * 而 `assistant/message` 那侧按步统计是 **250~290 字符/秒**。两处一致 ——
 * 也就是说「一批字」本来就跨越一段时间，把它压到一瞬才是失真。
 *
 * ## 为什么按**批尾**对齐，而不是按第一帧对齐
 *
 * 一批 chunk 到达时，我们只知道自己等的这一批**现在**才处理完。把最新一帧放在
 * `now`、其它帧按它们与最新帧的宿主时间差往前推，整批就落回它真正发生的那段时间里。
 * 反过来按第一帧对齐会让后到的帧跑到未来（那会一直追不上）。
 *
 * ## 为什么用宿主时间戳的**差值**，而不是它本身
 *
 * 事件上的 `time` 是**宿主**侧的时刻，与浏览器的绝对时钟可能差好几秒
 *（`install.ts` 的 drift 诊断就是为它写的）。但**差值**不受基准影响：
 * 宿主那边两帧隔 30ms，映射出来的本地间隔也就是 30ms。
 *
 * @module dsh-token-tps-stats/src/client/pacing
 */

/** 一帧的原始时间信息。 */
export interface TimedChunk {
  /** 事件上的宿主时间戳（毫秒）；宿主没给时是 `undefined`。 */
  readonly host: number | undefined;
  /** 这一帧在本地的到达时刻（毫秒）。 */
  readonly arrival: number;
}

/** 最多往回调多久（毫秒）：比折线图最长的 3 分钟略短，再久的历史也画不出来。 */
export const MAX_BACKDATE_MS = 180_000;

/**
 * 给一批 chunk 算各自的本地时刻。
 *
 * - 批里**没有**任何有效宿主时间戳 → 全部用到达时刻（旧宿主也能用）；
 * - 有 → 以「最新的一帧落在 `endLocal`」为基准，其余按宿主时间差往前推；
 * - 推到 `endLocal - maxBackdate` 更早的那些**丢掉**（返回 `null`）。
 *
 * @param items - 这一批 chunk 的时间信息（顺序无关）。
 * @param endLocal - 这一批应当结束于哪个本地时刻（通常是这次排空时的 `Date.now()`）。
 * @param maxBackdateMs - 最多往回调多久（毫秒）。
 * @returns 每个 chunk 的本地时刻（`null` = 太旧、丢弃），与 `items` 一一对应。
 */
export function retimeBatch(
  items: readonly TimedChunk[],
  endLocal: number,
  maxBackdateMs: number = MAX_BACKDATE_MS,
): (number | null)[] {
  if (items.length === 0) return [];
  /** 批里最新的宿主时刻（时间轴的对齐点）。 */
  let endHost: number | undefined;
  for (const item of items) {
    if (typeof item.host !== "number" || !Number.isFinite(item.host)) continue;
    if (endHost === undefined || item.host > endHost) endHost = item.host;
  }
  const floor = endLocal - Math.max(0, maxBackdateMs);
  return items.map((item) => {
    if (endHost === undefined || typeof item.host !== "number" || !Number.isFinite(item.host)) {
      return item.arrival;
    }
    const at = endLocal - (endHost - item.host);
    // 未来时刻压到 `endLocal`：我们不可能知道还没到的字。
    if (at > endLocal) return endLocal;
    /*
     * **太旧的直接丢弃，不要夹到下限**（2026-11-13 重放测试暴露的问题）。
     *
     * 夹到 `floor` 会把「比 3 分钟更早的所有帧」全部堆在同一个时刻上 ——
     * 那正好是一段人为制造的巨型 burst：重放里 296 秒的积压被夹成 180 秒后，
     * 读数反而冲到了 992 tok/s，和我们要修的 bug 一模一样。
     * 丢掉这些帧的代价只是「3 分钟以前的数据不画」，本来就画不出来。
     */
    if (at < floor) return null;
    return at;
  });
}
