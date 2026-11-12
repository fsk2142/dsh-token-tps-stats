/**
 * **折线图用的历史记录**（2026-11-12，第 3 步）。
 *
 * ## 为什么单独一个模块
 *
 * `tps-meter.ts` 只保留最近 9 秒（那是胶囊读数需要的跨度）；折线图要的是
 * 「一段时间内的变化」，需要更长的历史。两件事放进同一个累加器会让那个已经
 * 稳定的计算核心变复杂，所以这里是**另一个**累加器：纯函数 + 一个模块级单例，
 * 不碰 React、不碰宿主，可以完整单测。
 *
 * ## 为什么是「每秒一个桶」而不是定时采样
 *
 * 定时采样（每 500ms 读一次胶囊）需要在**空闲时也继续跑定时器**，而且采到的是
 * 已经平滑过的读数 —— 折线图等于把 9 秒平滑又叠加一次，看不出真实起伏。
 *
 * 这里改成**按秒聚合原始字符**：只有帧到达时才写桶，**空闲时零开销**（没有定时器）。
 * 画图时再对每个秒点做一次「最近 9 秒」的滑动平均 —— 与胶囊读数**同一口径**
 *（`TPS_WINDOWS × TPS_WINDOW_MS`），所以折线图和胶囊不会各说各话。
 *
 * ## 为什么最后一点落在「整秒边界」
 *
 * 当前这一秒只过了 300ms 时，桶里只有 300ms 的字；直接按整秒画，最后一点会
 * 塌下去一个坑（每次都塌），看起来像抖动。所以时间轴只画**已走完的秒**：
 * 最后一点是「上一个整秒边界」，最多晚 1 秒，但形状是诚实的。
 *
 * ## 复用哪个换算
 *
 * 直接复用 `tps-meter.ts` 的 `countChars` 与 `tokensOf` —— 折线图和胶囊必须用
 * 同一套系数，任何一处改动都自动同步，不给自己留「两个模块各算一套」的机会。
 *
 * @module dsh-token-tps-stats/src/client/tps-history
 */

import { countChars, TPS_WINDOWS, tokensOf } from "./tps-meter";

/** 桶宽（毫秒）：1 秒一个桶，与胶囊的窗口同宽。 */
const BIN_MS = 1_000;

/** 平滑窗口数：与胶囊一致（9 × 1 秒）。 */
const SMOOTH_WINDOWS = TPS_WINDOWS;

/**
 * 保留多久的历史（秒）。
 *
 * 180 秒 = 3 分钟：足够看出「这一轮输出前快后慢」的形状，内存也恒定
 *（180 个小数对，不到 10KB）。
 */
export const TPS_HISTORY_SECONDS = 180;

/** 折线图默认展示的时长（秒）。 */
export const TPS_CHART_DEFAULT_SECONDS = 60;

/** 折线图可选的时长（秒）：上限受 {@link TPS_HISTORY_SECONDS} 限制。 */
export const TPS_CHART_RANGES = [60, 180] as const;

/** 可选时长的类型。 */
export type TpsChartRange = (typeof TPS_CHART_RANGES)[number];

/** 折线图上的一个点。 */
export interface TpsSeriesPoint {
  /** 距今多少秒（0 = 最后一个已走完的整秒）。 */
  readonly secondsAgo: number;
  /** 该点处的估算速度（tok/s，9 秒滑动平均）。 */
  readonly value: number;
}

/** 序列的统计值。 */
export interface TpsSeriesSummary {
  /** 区间平均值。 */
  readonly average: number;
  /** 区间峰值。 */
  readonly peak: number;
  /** 最新一点（最后一个已走完的整秒）。 */
  readonly latest: number;
}

/** 历史记录的对外面（测试可注入替身）。 */
export interface TpsHistory {
  /** 记一帧文本（空串忽略）。 */
  push(text: string, at: number): void;
  /** 记**已经数好**的一批字符（调用方自己做过差分与摊开，见 `session-store.ts`）。 */
  pushCounts(counts: { cjk: number; other: number }, at: number): void;
  /** 画图用的序列：**最旧 → 最新**，长度恒为请求的秒数。 */
  series(at: number, seconds: number): TpsSeriesPoint[];
  /** 序列的统计值。 */
  summary(at: number, seconds: number): TpsSeriesSummary;
}

/**
 * 造一个历史记录器。
 * @param options - `seconds` / `binMs` / `smoothWindows` 可注入（测试用）。
 * @returns 历史记录器。
 */
export function createTpsHistory(
  options: { seconds?: number; binMs?: number; smoothWindows?: number } = {},
): TpsHistory {
  const keepSeconds = options.seconds ?? TPS_HISTORY_SECONDS;
  const binMs = options.binMs ?? BIN_MS;
  const smoothWindows = options.smoothWindows ?? SMOOTH_WINDOWS;
  /** key = 桶序号 `floor(at / binMs)`；只有收到过字的桶才存在（空桶即 0）。 */
  const bins = new Map<number, { cjk: number; other: number }>();

  /** 当前时刻所属的桶序号。 */
  const binIndexOf = (at: number): number => Math.floor(at / binMs);

  /** 把一批字符计数记到某个秒桶里（两个 `push` 路径共用）。 */
  const accumulate = (counts: { cjk: number; other: number }, at: number): void => {
    const index = binIndexOf(at);
    const bin = bins.get(index);
    if (bin === undefined) bins.set(index, { cjk: counts.cjk, other: counts.other });
    else {
      bin.cjk += counts.cjk;
      bin.other += counts.other;
    }
    prune(index);
  };

  /** 丢掉落出保留期的桶（保留期 = 历史长度 + 平滑窗口）。 */
  const prune = (binIndex: number): void => {
    const floor = binIndex - keepSeconds - smoothWindows;
    for (const key of bins.keys()) {
      if (key < floor) bins.delete(key);
    }
  };

  /**
   * 某一整秒边界上的滑动平均速度（最近 `smoothWindows × binMs` 内的平均）。
   *
   * **分母固定**为窗口长度：空桶按 0 计入。这与 `tps-meter.ts` 的第三版口径一致 ——
   * 折线图和胶囊用同一套「最近 N 秒的平均」，否则两处会各说各话
   *（旧实现只在有过数据的桶进分母，停顿后突然一段会把点顶到天上去）。
   * @param boundary - 桶序号。
   * @returns tok/s。
   */
  const rateAt = (boundary: number): number => {
    let tokens = 0;
    for (let step = 0; step < smoothWindows; step += 1) {
      const bin = bins.get(boundary - step);
      if (bin !== undefined) tokens += tokensOf(bin);
    }
    const windowMs = smoothWindows * binMs;
    return windowMs > 0 ? (tokens / windowMs) * 1_000 : 0;
  };

  /** 造「最旧 → 最新」的点列（结尾落在最后一个已走完的整秒）。 */
  const pointsAt = (at: number, seconds: number): TpsSeriesPoint[] => {
    const end = binIndexOf(at);
    prune(end);
    const requested = Math.max(1, Math.floor(seconds));
    const points: TpsSeriesPoint[] = [];
    for (let ago = requested - 1; ago >= 0; ago -= 1) {
      points.push({ secondsAgo: ago, value: rateAt(end - ago) });
    }
    return points;
  };

  return {
    push: (text, at) => {
      if (typeof text !== "string" || text === "") return;
      accumulate(countChars(text), at);
    },
    pushCounts: (counts, at) => {
      if (counts.cjk <= 0 && counts.other <= 0) return;
      accumulate(counts, at);
    },
    series: (at, seconds) => pointsAt(at, seconds),
    summary: (at, seconds) => {
      const points = pointsAt(at, seconds);
      let sum = 0;
      let peak = 0;
      for (const point of points) {
        sum += point.value;
        if (point.value > peak) peak = point.value;
      }
      const latest = points.length > 0 ? points[points.length - 1]!.value : 0;
      return { average: points.length > 0 ? sum / points.length : 0, peak, latest };
    },
  };
}

/**
 * 模块级单例（**全会话一个**；与速度计同一个生命周期理由：事件定义只注册一次，
 * 而组件可能因槽位重注册反复挂载，历史不能跟着丢）。
 */
let history: TpsHistory | undefined;

/**
 * 注入/替换历史记录器（测试用）。
 * @param next - 要使用的实例。
 */
export function useTpsHistory(next: TpsHistory): void {
  history = next;
}

/** 确保历史记录器存在（幂等）。 */
function ensureHistory(): TpsHistory {
  if (history === undefined) history = createTpsHistory();
  return history;
}

/**
 * 推进一帧历史（由显示层与速度计吃同一批文本）。
 * @param text - 增量文本。
 * @param at - 帧到达时刻（本地墙钟毫秒）。
 */
export function pushHistory(text: string, at: number): void {
  ensureHistory().push(text, at);
}

/**
 * 读折线序列。
 * @param at - 现在（毫秒）。
 * @param seconds - 时长（秒），缺省取 {@link TPS_CHART_DEFAULT_SECONDS}。
 * @returns 最旧 → 最新的点。
 */
export function historySeries(at: number, seconds: number = TPS_CHART_DEFAULT_SECONDS): TpsSeriesPoint[] {
  return ensureHistory().series(at, seconds);
}

/**
 * 读序列统计值。
 * @param at - 现在（毫秒）。
 * @param seconds - 时长（秒），缺省取 {@link TPS_CHART_DEFAULT_SECONDS}。
 * @returns 平均值 / 峰值 / 最新一点。
 */
export function historySummary(at: number, seconds: number = TPS_CHART_DEFAULT_SECONDS): TpsSeriesSummary {
  return ensureHistory().summary(at, seconds);
}

/**
 * **仅供测试**：重置模块级单例，避免用例之间互相污染。
 */
export function resetHistoryForTests(): void {
  history = createTpsHistory();
}
