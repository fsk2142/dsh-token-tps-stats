/**
 * **把一段字符按时间摊开**（2026-11-13，替代原来基于宿主时间戳的 `pacing.ts`）。
 *
 * ## 为什么需要它
 *
 * 现在的数据源是「每拍取一次会话快照再做差分」。这一拍的增量可能覆盖两种时间跨度：
 *
 * - **正常流式**：一拍 ≈ 16~100ms（快照按动画帧发布），摊不摊开都一样；
 * - **主线程被占住**：标签页在后台、渲染大表格、弹窗下载 → 几秒钟里一帧都没读到，
 *   回前台时那几秒的字**一次性**出现在增量里。
 *
 * 后一种如果不摊开，那几秒的字会被记在**同一个毫秒**上，最近 1 秒的窗口就把它全部
 * 吃进去 —— 读数冲到几百甚至上千 tok/s。这正是用户 2026-11-13 报的「峰值都是 1000
 * 多了，肯定是有问题的」。
 *
 * 摊开的做法与原来的 `retimeBatch` 同一个思想（「按字符真实产生的时间段摊开」），
 * 但不再需要宿主时间戳：**时间跨度就是两次采样之间的本地时间差**，那是这一拍
 * 增量真实覆盖的区间。
 *
 * @module dsh-token-tps-stats/src/client/spread
 */

/** CJK 与其它字符的计数。 */
export interface CharCounts {
  /** CJK 字符数。 */
  readonly cjk: number;
  /** 其它字符数。 */
  readonly other: number;
}

/** 摊开后的一个切片。 */
export interface CountSlice extends CharCounts {
  /** 这一片记在哪个时刻（毫秒）。 */
  readonly at: number;
}

/** 摊开的最大粒度（毫秒）：一秒一片，与速度计的窗口同宽。 */
const SLICE_MS = 1_000;

/**
 * 把一批字符计数摊到 `(from, to]` 这段区间里。
 *
 * 切片的时刻落在**右端**：某一片代表「这 1 秒里到了这么多字」，记在该秒末尾才符合
 * 速度计「右闭左开」的窗口口径（`from < key <= to`）。
 *
 * 计数按片均分，除不尽的零头进**最后一片** —— 这样总量严格守恒，
 * 不会因为四舍五入让读数慢慢漂移。
 * @param counts - 这一拍的字符计数。
 * @param from - 上一次采样的时刻（毫秒）。
 * @param to - 这一次采样的时刻（毫秒）。
 * @param sliceMs - 切片粒度（毫秒），缺省 1 秒。
 * @returns 切片（升序）；没有字符或时间跨度为 0 时只返回一片。
 */
export function spreadCounts(counts: CharCounts, from: number, to: number, sliceMs: number = SLICE_MS): CountSlice[] {
  const cjk = Math.max(0, counts.cjk);
  const other = Math.max(0, counts.other);
  if (cjk + other <= 0) return [];
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0 || sliceMs <= 0) return [{ at: to, cjk, other }];
  const slices = Math.min(Math.max(1, Math.ceil(span / sliceMs)), 3600);
  const width = span / slices;
  const out: CountSlice[] = [];
  let cjkLeft = cjk;
  let otherLeft = other;
  for (let index = 1; index <= slices; index += 1) {
    const at = index === slices ? to : from + width * index;
    const cjkShare = index === slices ? cjkLeft : Math.floor(cjk / slices);
    const otherShare = index === slices ? otherLeft : Math.floor(other / slices);
    cjkLeft -= cjkShare;
    otherLeft -= otherShare;
    out.push({ at, cjk: cjkShare, other: otherShare });
  }
  return out;
}
